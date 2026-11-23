import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { LiveHub, HUB_VERSION, hubArgs } from '../defaults/mods/devices/live.mjs';

function fixture(version = HUB_VERSION, timeoutMs = 1000) {
  const children: any[] = [], spawns: any[] = [];
  const hub = new LiveHub({ toolsRoot: '/tools with spaces', platform: 'ios', device: 'test-udid', timeoutMs,
    read: async () => JSON.stringify({ version }),
    spawnProcess: (command: string, args: string[], options: any) => {
      const child: any = new EventEmitter();
      Object.assign(child, { pid: 1000 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, signals: [],
        kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit('exit', null, signal)); return true; } });
      children.push(child); spawns.push({ command, args, options }); return child;
    },
  });
  return { hub, children, spawns };
}

test('live server pins one device, binds only loopback, and requests continuous H.264', () => {
  const args = hubArgs({ platform: 'android', device: 'emulator-5584' });
  expect(args).toEqual(['--host','127.0.0.1','--port','0','--platform','android','--single-device','emulator-5584','--transport','h264','--hide-sidebar','--video-fps','60','--max-dimension','1280']);
  expect(() => hubArgs({ platform: 'other', device: 'id' })).toThrow();
  expect(() => hubArgs({ platform: 'ios', device: '--other-device' })).toThrow();
  expect(() => hubArgs({ platform: 'ios', device: '../device' })).toThrow();
});

test('ready URL survives split output, repeated starts reuse the owned server, and stop only signals that child', async () => {
  const f = fixture();
  const starting = f.hub.start();
  await Promise.resolve(); await Promise.resolve();
  f.children[0].stdout.emit('data', Buffer.from('Expo Device Hub ready\n  Lo'));
  f.children[0].stdout.emit('data', Buffer.from('cal: http://localhost:45'));
  expect(f.hub.status().running).toBe(false);
  f.children[0].stdout.emit('data', Buffer.from('678\n'));
  expect(await starting).toBe('http://127.0.0.1:45678/');
  expect(await f.hub.start()).toBe('http://127.0.0.1:45678/');
  expect(f.spawns).toHaveLength(1);
  expect(f.spawns[0].args[0]).toBe('/tools with spaces/node_modules/expo-device-hub/dist/server/cli.mjs');
  await f.hub.stop();
  expect(f.children[0].signals).toEqual(['SIGTERM']);
  expect(f.hub.status().running).toBe(false);
  await f.hub.stop();
  expect(f.children[0].signals).toEqual(['SIGTERM']);
});

test('a wrong package version cannot launch a process', async () => {
  const f = fixture('0.0.1');
  await expect(f.hub.start()).rejects.toThrow(HUB_VERSION);
  expect(f.spawns).toHaveLength(0);
});

test('startup failure and decoder-host exit cannot retain a ready URL', async () => {
  const f = fixture(); const starting = f.hub.start();
  await Promise.resolve(); await Promise.resolve();
  f.children[0].stderr.emit('data', Buffer.from('native helper unavailable'));
  f.children[0].emit('exit', 1, null);
  await expect(starting).rejects.toThrow('native helper unavailable');
  expect(f.hub.status().running).toBe(false);
  expect(f.hub.status().url).toBeNull();
});

test('startup timeout terminates its own server instead of leaving a hidden stream', async () => {
  const f = fixture(HUB_VERSION, 10);
  await expect(f.hub.start()).rejects.toThrow('did not become ready');
  expect(f.children[0].signals).toEqual(['SIGTERM']);
  expect(f.hub.status().running).toBe(false);
});

test('spawn failure without a PID rejects without trying to signal a process', async () => {
  const f = fixture(); const starting = f.hub.start();
  await Promise.resolve(); await Promise.resolve();
  f.children[0].pid = undefined;
  f.children[0].emit('error', new Error('node executable is missing'));
  await expect(starting).rejects.toThrow('node executable is missing');
  expect(f.children[0].signals).toEqual([]);
});

test('closing during package lookup cancels startup before any process can launch', async () => {
  const f = fixture();
  let release!: (value: string) => void;
  f.hub.read = () => new Promise(resolve => { release = resolve; });
  const starting = f.hub.start();
  await f.hub.stop();
  release(JSON.stringify({ version: HUB_VERSION }));
  await expect(starting).rejects.toThrow('canceled');
  expect(f.spawns).toHaveLength(0);
  expect(f.hub.status().running).toBe(false);
});

test('late readiness cannot revive a stream after a pane requests shutdown', async () => {
  const f = fixture(); const starting = f.hub.start();
  await Promise.resolve(); await Promise.resolve();
  const stopping = f.hub.stop();
  f.children[0].stdout.emit('data', Buffer.from('Local: http://localhost:45678\n'));
  await expect(starting).rejects.toThrow('stopped during startup');
  await stopping;
  expect(f.hub.status().url).toBeNull();
  expect(f.spawns).toHaveLength(1);
});

test('an owned capture server restarts behind the same browser origin, and shutdown cancels retries', async () => {
  const {serveLive} = await import('../defaults/mods/devices/live.mjs');
  const f = fixture();
  let closed = 0, target;
  const starting = serveLive(f.hub, {retryMs: 1, proxy: async get => {target = get; return {url:'http://127.0.0.1:49999/',close:async()=>{closed++;}};}});
  await Promise.resolve();await Promise.resolve();
  f.children[0].stdout.emit('data',Buffer.from('Local: http://localhost:45678\n'));
  const service = await starting; expect(service.url).toBe('http://127.0.0.1:49999/');expect(target()).toBe('http://127.0.0.1:45678/');
  f.children[0].emit('exit',1,null);expect(target()).toBeNull();
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(f.children).toHaveLength(2);
  f.children[1].stdout.emit('data',Buffer.from('Local: http://localhost:45679\n'));
  await new Promise(resolve=>setTimeout(resolve,1));
  expect(target()).toBe('http://127.0.0.1:45679/');expect(service.url).toBe('http://127.0.0.1:49999/');
  await service.stop();await new Promise(resolve=>setTimeout(resolve,10));
  expect(closed).toBe(1);expect(f.children).toHaveLength(2);expect(f.children[1].signals).toEqual(['SIGTERM']);
});

test('stream proxy injects frame monitoring, forwards requests only to its owned host, and reports restart availability', async () => {
  const {createServer}=await import('node:http'), {streamProxy}=await import('../defaults/mods/devices/stream-proxy.mjs');
  const paths=[];
  const upstream=createServer((req,res)=>{paths.push(req.url);if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><head></head><body>live</body>');}else{res.end('forwarded');}});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  let address=`http://127.0.0.1:${upstream.address().port}/`;
  const proxy=await streamProxy(()=>address);
  try {
    const page=await (await fetch(proxy.url)).text();expect(page).toContain('<head><script src="/_herdr/stream-client.js"></script>');
    const script=await (await fetch(new URL('/_herdr/stream-client.js',proxy.url))).text();expect(script).toContain('CanvasRenderingContext2D');
    expect(await (await fetch(new URL('/_herdr/stream-health',proxy.url))).json()).toMatchObject({available:true});
    expect(await (await fetch(proxy.url+'//outside.invalid/same-host')).text()).toBe('forwarded');expect(paths.at(-1)).toEndWith('/same-host');
    const health = new URL('/_herdr/stream-health',proxy.url);
    await fetch(health,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page:1,frames:17,status:'live',paintAgeMs:25})});
    expect((await (await fetch(health)).json()).client).toMatchObject({page:1,frames:17,status:'live',paintAgeMs:25});
    expect((await fetch(health,{method:'POST',body:JSON.stringify({frames:-1,status:'live'})})).status).toBe(400);
    await new Promise(resolve=>upstream.close(resolve));
    const failed=await fetch(proxy.url);expect(failed.status).toBe(503);expect(await failed.text()).toContain('data-herdr-reconnecting');
    address=null;
    expect(await (await fetch(new URL('/_herdr/stream-health',proxy.url))).json()).toMatchObject({available:false});
    const unavailable=await fetch(proxy.url);expect(unavailable.status).toBe(503);expect(await unavailable.text()).toContain('/_herdr/stream-client.js');
  }finally{await proxy.close();await new Promise(resolve=>upstream.close(resolve));}
});


test('visible stalled video recycles only its owned host, with a cooldown and cross-origin write rejection', async () => {
  const {streamProxy}=await import('../defaults/mods/devices/stream-proxy.mjs');
  let now=100000,restarts=0;
  const proxy=await streamProxy(()=>null,{clock:()=>now,onStall:()=>{restarts++;}}),health=new URL('/_herdr/stream-health',proxy.url);
  const report=async status=>{const response=await fetch(health,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page:1,frames:10,paintAgeMs:0,visible:true,...status})});await response.json();};
  try {
    await report({status:'live'});now+=11000;
    await report({status:'reconnecting',visible:false});expect(restarts).toBe(0);
    await report({status:'reconnecting',paintAgeMs:11000});expect(restarts).toBe(1);
    now+=1000;await report({status:'reconnecting'});expect(restarts).toBe(1);
    now+=16000;await report({status:'reconnecting'});expect(restarts).toBe(2);
    const foreign=await fetch(health,{method:'POST',headers:{origin:'https://outside.invalid'},body:'{}'});expect(foreign.status).toBe(403);
  }finally{await proxy.close();}
});

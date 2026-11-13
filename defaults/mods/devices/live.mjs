// One continuous device stream per panel. Device lifecycle remains with the agent's session.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HUB_VERSION = '0.23.1';

export function hubArgs({ platform, device }) {
  if (!['ios', 'android'].includes(platform)) throw new Error('Choose an iOS simulator or Android device.');
  if (typeof device !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(device)) throw new Error('An exact device ID is required.');
  return ['--host', '127.0.0.1', '--port', '0', '--platform', platform, '--single-device', device,
    '--transport', 'h264', '--hide-sidebar', '--video-fps', '60', '--max-dimension', '1280'];
}

export class LiveHub {
  constructor({ toolsRoot, platform, device, node = process.execPath, spawnProcess = spawn, read = readFile, timeoutMs = 30000 }) {
    Object.assign(this, { toolsRoot, platform, device, node, spawnProcess, read, timeoutMs });
    this.args = hubArgs({ platform, device });
    this.child = null;
    this.url = null;
    this.error = null;
    this.closing = false;
    this.starting = null;
    this.generation = 0;
    this.diagnostics = '';
  }

  async start() {
    if (this.closing && this.child) throw new Error('Wait for the previous live stream to stop.');
    if (this.url && this.child) return this.url;
    if (this.starting) return this.starting;
    this.starting = this.launch(++this.generation);
    try { return await this.starting; } finally { this.starting = null; }
  }

  async launch(generation) {
    const packageDir = join(this.toolsRoot, 'node_modules', 'expo-device-hub');
    const metadata = JSON.parse(await this.read(join(packageDir, 'package.json'), 'utf8'));
    if (generation !== this.generation) throw new Error('Live stream startup was canceled.');
    if (metadata.version !== HUB_VERSION) throw new Error(`Live viewing requires expo-device-hub ${HUB_VERSION}.`);
    this.closing = false;
    this.error = null;
    const child = this.spawnProcess(this.node, [join(packageDir, 'dist/server/cli.mjs'), ...this.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dirname(this.node)}${delimiter}${process.env.PATH ?? ''}` },
    });
    this.child = child;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        let ready = false, output = '';
        const remember = data => { this.diagnostics = (this.diagnostics + data.toString()).slice(-65536); };
        child.stderr.on('data', remember);
        child.stdout.on('data', data => {
          remember(data);
          output = (output + data.toString()).slice(-65536);
          const match = output.match(/Local:\s+(http:\/\/localhost:\d+)[\r\n]/);
          if (!ready && match && generation === this.generation && !this.closing) {
            ready = true;
            clearTimeout(timer);
            this.url = match[1].replace('localhost', '127.0.0.1') + '/';
            resolve(this.url);
          }
        });
        child.once('error', error => {
          this.error = error.message;
          reject(error);
        });
        child.once('exit', (code, signal) => {
          if (this.child === child) { this.child = null; this.url = null; }
          if (!this.closing) this.error = `Live stream exited (${signal || code}). ${this.diagnostics}`;
          if (!ready) reject(new Error(this.error || 'Live stream stopped during startup.'));
        });
        timer = setTimeout(() => reject(new Error('Live streaming server did not become ready.')), this.timeoutMs);
      });
    } catch (error) {
      await this.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async stop() {
    this.generation++;
    this.closing = true;
    this.url = null;
    const child = this.child;
    if (!child) return;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { this.child = null; return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    if (this.child === child) this.child = null;
  }

  status() {
    return { url: this.url, running: Boolean(this.url && this.child), platform: this.platform, device: this.device, error: this.error };
  }
}

// The native leaf owns stdin. Losing that pipe (including an app crash) releases
// this server without closing the simulator or the agent's app session.
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const [toolsRoot, platform, device] = process.argv.slice(2);
  const hub = new LiveHub({ toolsRoot, platform, device });
  const close = () => hub.stop().finally(() => process.exit(0));
  process.stdin.resume();
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  hub.start().then(url => {
    console.log(JSON.stringify({ url }));
    hub.child?.once('exit', () => {
      if (hub.closing) return;
      console.log(JSON.stringify({ error: hub.error || 'Live stream server exited.' }));
      process.exitCode = 1;
      process.stdin.destroy();
    });
  }).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
    process.stdin.destroy();
  });
}


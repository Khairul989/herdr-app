import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {connectGlobal} from '../defaults/mods/devices/global.js';
import {openGlobal} from '../defaults/mods/devices/agent.mjs';
const device={id:'sim-1',platform:'ios',kind:'simulator'};
test('a global connection is reused by any caller without relaunching or changing target',async()=>{
 const calls=[];const tools={opened:true,device,capture:async()=>calls.push('capture'),open:async()=>{throw Error('relaunch')},select:()=>{throw Error('switch')}};
 await connectGlobal(tools,[device],{device:'sim-1',app:'app'},'app');await connectGlobal(tools,[device],{device:'sim-1',app:'app'},'app');expect(calls).toEqual(['capture','capture']);
 await expect(connectGlobal(tools,[device,{...device,id:'other'}],{device:'other'},'app')).rejects.toThrow('Disconnect');
 await expect(connectGlobal(tools,[device],{device:'sim-1',app:'different'},'app')).rejects.toThrow('Disconnect');
});
test('manual connection can adopt a device without an app ID',async()=>{
 const calls=[];const tools={opened:false,connect:async(_devices,id,platform,app)=>calls.push([id,platform,app])};
 await connectGlobal(tools,[device],{device:'sim-1'},'');expect(calls).toEqual([['sim-1','ios','']]);
});
test('global agent opening selects shared chrome, returns shared session, and never splits or reads agent ownership',async()=>{
 const commands=[];let request,unlocked=false;
 const io={mkdir:async()=>{},open:async()=>({close:async()=>{}}),writeFile:async(path,text)=>{if(path.endsWith('request-next.json'))request=JSON.parse(text)},rename:async()=>{},readFile:async()=>JSON.stringify(request?{requestId:request.id,status:'ready',opened:true,session:'herdr-global',device}:{}),unlink:async()=>{unlocked=true}};
 const result=await openGlobal(device,'app',{io,command:async(name,args)=>commands.push({name,args}),timeout:1000});
 expect(result.session).toBe('herdr-global');expect(result.global).toBe(true);expect(commands.map(c=>c.name)).toEqual(['layout.select','layout.show']);expect(request.device).toBe('sim-1');expect(unlocked).toBe(true);
});
test('global connection errors release their lock without replacing an existing session',async()=>{
 let request,unlocked=false;
 const io={mkdir:async()=>{},open:async()=>({close:async()=>{}}),writeFile:async(_path,text)=>{request=JSON.parse(text)},rename:async()=>{},readFile:async()=>JSON.stringify(request?{requestId:request.id,status:'error',error:'Disconnect first'}:{}),unlink:async()=>{unlocked=true}};
 await expect(openGlobal(device,'app',{io,command:async()=>{},timeout:1000})).rejects.toThrow('Disconnect first');expect(unlocked).toBe(true);
});
test('global reconnection cannot race an agent input or disconnect already holding the session lock',async()=>{
 const removed=[],commands=[];let writes=0;
 const io={mkdir:async()=>{},open:async path=>{if(path.endsWith('agent.lock'))throw Object.assign(new Error('busy'),{code:'EEXIST'});return{close:async()=>{}}},readFile:async()=>JSON.stringify({session:'herdr-existing',opened:true}),writeFile:async()=>{writes++},unlink:async path=>removed.push(path)};
 await expect(openGlobal(device,'app',{io,command:async name=>commands.push(name),timeout:1000})).rejects.toThrow('holds the shared device');
 expect(writes).toBe(0);expect(commands).toEqual([]);expect(removed).toHaveLength(1);expect(removed[0]).toEndWith('open.lock');
});
test('Devices toolbar stays selected across workspace switches without per-workspace ownership',async()=>{
 const source=(await readFile(new URL('../defaults/mods/tabs/main.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default class Tabs','class Tabs');
 const commands=[];const Tabs=new Function('View','run',source+';return Tabs;')(class{},(...args)=>commands.push(args));
 const tabs=new Tabs();tabs.panels={s2:'files'};tabs.space='s1';
 tabs.syncPanel({id:'s2'},{hidden:false},{active:'devices'},['files','devices']);expect(commands).toEqual([]);expect(tabs.panels).toEqual({s2:'files'});
 const root=JSON.parse(await readFile(new URL('../defaults/layouts/main.json',import.meta.url),'utf8'));
 const find=n=>n.id==='devices'?n:n.children?.map(find).find(Boolean);
 expect(find(root).content).toEqual({mod:'devices',props:{global:true}});expect(source).toContain('panelButton("devices", "Devices"');
});

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { actionArgs, drive, main, ACTIONS, FLAGS, commandLock } from "../defaults/mods/devices/agent.mjs";
import { keyName, runOptions, sendKey, annotateSnapshot, compactSnapshot, shareSheet, simulatorInput, simulatorInspect } from "../defaults/mods/devices/interaction.mjs";
import { keyboardPatch, ensureKeyboardPatch } from "../defaults/mods/devices/backend.mjs";

const rect = (x = 0, y = 0, width = 402, height = 874) => ({ x, y, width, height });
const frame = { refsGeneration: 3, viewport: rect(), nodes: [{index:0,ref:"e1",type:"Application",rect:rect()}, {index:1,parentIndex:0,ref:"e2",type:"Button",label:"Continue\n now",rect:rect(10,10,50,50)}] };
const ok = data => ({code:0,stdout:JSON.stringify({success:true,data}),stderr:""});

function harness() {
  const calls:any[] = [], files:any[] = [];
  const connection = {node:"node",cli:"/tools/node_modules/agent-device/bin/agent-device.mjs",state:"/private-state",session:"herdr-test",opened:true,status:"ready",device:{platform:"ios",kind:"simulator",id:"EXACT-UDID"}};
  let locked = false, respond = args => ok(args[1] === "snapshot" ? frame : args[1] === "appstate" ? {appBundleId:"app.test",state:"runningForeground"} : {acted:true});
  const io = {
    async open(_path, mode) { expect(mode).toBe("wx");if(locked)throw Object.assign(new Error("busy"),{code:"EEXIST"});locked=true;return{async close(){}}; },
    async readFile(){return JSON.stringify(connection);}, async writeFile(...args){files.push(args);},async rename(...args){files.push(args);},async unlink(){locked=false;},
  };
  const deps = {simInspect:async()=>undefined,simInput:async(_connection,command,{invoke,onInput})=>{onInput();return invoke(command);},io,prepare:async()=>{},run:async(bin,args)=>{calls.push({bin,args});return respond(args);},keyInput:async(_connection,key)=>{calls.push({key});return {key};}};
  return {calls,files,deps,connection,respond:fn=>{respond=fn;},locked:()=>locked};
}

test("key aliases normalize before input validation without treating normal press targets as keys", () => {
  for(const value of ["Enter","return","BACKSPACE","delete","tab"]) {
    const parsed=runOptions(["press",value,"--snapshot"]);
    expect(parsed.command).toEqual(["key",keyName(value)]);expect(parsed.snapshot).toBe(true);expect(actionArgs(parsed.command)).toEqual(parsed.command);
  }
  expect(runOptions(["press","@e1"]).command).toEqual(["press","@e1"]);
  expect(runOptions(["keyboard","backspace"]).command).toEqual(["key","backspace"]);
  expect(()=>runOptions(["key","escape"])).toThrow("key requires");
  expect(keyName("constructor")).toBeNull();expect(keyName("__proto__")).toBeNull();
  expect(()=>runOptions(["click","@e1","--compact"])).toThrow("--compact requires");
  expect(()=>actionArgs(runOptions(["key","tab","--serial","other"]).command)).toThrow();
});

test("iOS simulator keys send real HID usages to only the bound device and always release the key", async () => {
  const events:any[]=[];
  class SimHID {constructor(id){events.push(id);}async setScreen(screen){events.push(screen);return true;}async key(...args){events.push(args);}}
  const connection={device:{platform:"ios",kind:"simulator",id:"EXACT"}};
  for(const [key,usage] of [["enter",40],["backspace",42],["tab",43]]) {
    events.length=0;
    await sendKey(connection,key,{toolsRoot:"/tools",platform:"darwin",loadNative:path=>{expect(path).toContain("expo-device-hub");return {SimHID};}});
    expect(events).toEqual(["EXACT",0,["down",usage],["up",usage]]);
  }
  class Broken extends SimHID {async key(action,usage){events.push([action,usage]);if(action==="down")throw new Error("input lost");}}
  events.length=0;
  await expect(sendKey(connection,"tab",{toolsRoot:"/tools",platform:"darwin",loadNative:()=>({SimHID:Broken})})).rejects.toThrow("input lost");
  expect(events.at(-1)).toEqual(["up",43]);
  await expect(sendKey({device:{platform:"ios",kind:"device",id:"PHONE"}},"tab")).rejects.toThrow("physical iPhone");
});

test("Android keys use exact bound serial and native keyevents, never text injection", async () => {
  for(const [key,code] of [["enter","66"],["backspace","67"],["tab","61"]]) {
    let args;
    await sendKey({device:{platform:"android",id:"emulator-1234"}},key,{execute:async(_bin,a)=>{args=a;return{code:0};}});
    expect(args).toEqual(["-s","emulator-1234","shell","input","keyevent",code]);
  }
  await expect(sendKey({device:{platform:"android",id:"serial"}},"tab",{execute:async()=>({code:1,stderr:"offline"})})).rejects.toThrow("offline");
});

test("snapshot visibility clips horizontal offscreen children and scroll ancestors without confusing hittable with visible", () => {
  const data={viewport:rect(),nodes:[{index:0,type:"Application",rect:rect()},
    {index:1,parentIndex:0,type:"ScrollView",rect:rect(20,100,200,100)},
    {index:2,parentIndex:1,type:"Button",rect:rect(250,110,50,50)},
    {index:3,parentIndex:1,type:"StaticText",rect:rect(30,110,50,50),hittable:false},
    {index:4,parentIndex:0,type:"Button",rect:rect(500,10,30,30)},
    {index:5,parentIndex:0,type:"Button",rect:rect(10,10,30,30),hidden:true},
    {index:6,type:"Button"}]};
  const before=structuredClone(data), result=annotateSnapshot(data);
  expect(result.nodes[2]).toMatchObject({visible:false,offscreen:true,visibility:"offscreen"});
  expect(result.nodes[3]).toMatchObject({visible:true,offscreen:false,hittable:false});
  expect(result.nodes[4].offscreen).toBe(true);expect(result.nodes[5].visibility).toBe("hidden");expect(result.nodes[6].visibility).toBe("unknown");
  expect(data).toEqual(before);
  expect(compactSnapshot(annotateSnapshot(frame))).toContain("@e2 Button Continue now [visible]");
  expect(compactSnapshot(annotateSnapshot(frame)).split("\n")).toHaveLength(2);
});

test("explicit zero-area clipped rows are offscreen, while genuinely missing geometry stays unknown", () => {
  const data={viewport:{width:402,height:874},nodes:[{index:0,type:"Application",rect:rect()},
    {index:1,parentIndex:0,type:"Other",label:"Inherited full viewport",rect:rect()},
    ...[2,3,4].map(index=>({index,parentIndex:1,type:"Image",label:`Level ${index}`,rect:rect(0,0,0,0)})),
    {index:5,parentIndex:0,type:"Image",label:"No geometry"}]};
  const result=annotateSnapshot(data);
  for(const row of result.nodes.slice(2,5)) expect(row).toMatchObject({visibility:"offscreen",visible:false,offscreen:true,visibleFraction:0});
  expect(result.nodes[1]).toMatchObject({visibility:"unknown",geometry:"viewport-container",visibleFraction:null});
  expect(result.nodes[5].visibility).toBe("unknown");
});

test("merchant fractions use observed full bounds and never guess from sibling dimensions", () => {
  const history={};
  const tile=(label,x,width)=>({index:label==="Shopee"?1:2,parentIndex:0,type:"Image",label,rect:rect(x,688,width,50)});
  const make=nodes=>({appBundleId:"app",viewport:{width:402,height:874},nodes:[{index:0,type:"Application",rect:rect()},...nodes]});
  const before=annotateSnapshot(make([tile("Shopee",16.36,118.66),tile("Trip",384.61,17.39)]),history);
  expect(before.nodes[2].visibleFraction).toBeNull();
  const after=annotateSnapshot(make([tile("Shopee",0,17.39),tile("Trip",266.98,118.66)]),history);
  expect(after.nodes[1].visibility).toBe("partial");expect(after.nodes[1].visibleFraction).toBeCloseTo(17.39/118.66,5);
  expect(after.nodes[2]).toMatchObject({visibility:"visible",visibleFraction:1});
  expect(compactSnapshot(after)).toContain("[partial 14.7%]");
  const clipped=annotateSnapshot({viewport:rect(),nodes:[{index:0,type:"Application",rect:rect()},{index:1,parentIndex:0,type:"Image",label:"Crosses edge",rect:rect(390,20,40,40)}]});
  expect(clipped.nodes[1].visibility).toBe("partial");expect(clipped.nodes[1].visibleFraction).toBeCloseTo(0.3);expect(clipped.nodes[1].visibleRect.width).toBe(12);
});

test("--snapshot returns refs measured after the action and capture, under the same lock", async () => {
  const h=harness(), result=await drive("herdr-test",["click","@e1","--snapshot"],false,h.deps);
  expect(h.calls.map(c=>c.args[1])).toEqual(["click","snapshot","screenshot"]);
  for(const call of h.calls) {expect(call.args).toContain("EXACT-UDID");expect(call.args).toContain("herdr-test");expect(call.args).toContain("/private-state");}
  expect(result.snapshot.refsGeneration).toBe(3);expect(result.snapshot.nodes[1].visible).toBe(true);expect(h.locked()).toBe(false);
});

test("keys invalidate old ref frames even without opt-in output, and snapshot failures never pretend to undo input", async () => {
  const h=harness(), result=await drive("herdr-test",["key","Tab"],false,h.deps);
  expect(h.calls[0]).toEqual({key:"tab"});expect(h.calls.at(-1).args[1]).toBe("snapshot");expect(result.snapshot).toBeUndefined();
  h.respond(args=>args[1]==="snapshot"?{code:1,stderr:"snapshot unavailable"}:ok({acted:true}));
  const failed=await drive("herdr-test",["click","@e1","--snapshot"],false,h.deps);
  expect(failed.result.acted).toBe(true);expect(failed.snapshotError).toBe("snapshot unavailable");expect(h.locked()).toBe(false);
});

test("compact snapshot exposes one text line per ref; default results retain the JSON shape", async () => {
  const h=harness(), compact=await drive("herdr-test",["snapshot","-i","--compact"],false,h.deps);
  expect(compact.compact.split("\n")).toHaveLength(2);expect(compact.result.nodes).toHaveLength(2);
  expect(h.calls.filter(c=>c.args[1]==="snapshot")).toHaveLength(1);
  const normal=await drive("herdr-test",["snapshot","-i"],false,h.deps);expect(normal.compact).toBeUndefined();
});

test("actions support --snapshot --compact without returning a second full tree", async () => {
  const h=harness(), output=await drive("herdr-test",["click","@e1","--snapshot","--compact"],false,h.deps);
  expect(output.snapshotText).toContain("@e2 Button Continue now [visible]");
  expect(output.snapshotRefsGeneration).toBe(3);expect(output.snapshot).toBeUndefined();expect(output.compact).toBeUndefined();
  expect(h.calls.map(c=>c.args[1])).toEqual(["click","snapshot","screenshot"]);
});

test("find lookup is explicitly read-only and only an explicit action can tap", async () => {
  expect(runOptions(["find","Share Code Link"]).command).toEqual(["find","Share Code Link","get","attrs"]);
  expect(runOptions(["find","label","Share Code Link","--first"]).command).toEqual(["find","label","Share Code Link","get","attrs","--first"]);
  expect(runOptions(["find","Share Code Link","click"]).command).toEqual(["find","Share Code Link","click"]);
  const h=harness();await drive("herdr-test",["find","Share Code Link"],false,h.deps);
  expect(h.calls[0].args.slice(1,5)).toEqual(["find","Share Code Link","get","attrs"]);
  expect(h.calls.some(c=>c.args[1]==="click")).toBe(false);
});

test("share sheets are reported as activity surfaces and never accepted as alerts", async () => {
  const tree={nodes:[{index:0,type:"Other",role:"UIActivityViewController",label:"App text behind sheet"},{index:1,type:"Button",label:"Copy"},{index:2,type:"Button",label:"Save to Files"}]};
  expect(shareSheet(tree)).toMatchObject({kind:"share-sheet",present:false,source:"activity-view"});
  expect(shareSheet({nodes:[]},{items:["Reminders","More","Copy","Save to Files"],message:"Background app text"})).toMatchObject({kind:"share-sheet",confidence:"heuristic"});
  expect(shareSheet({nodes:[{type:"Alert",label:"Notification Permission"},{type:"Button",label:"Allow"}]})).toBeNull();
  const h=harness();h.respond(args=>ok(args[1]==="snapshot"?tree:{}));
  const output=await drive("herdr-test",["alert"],false,h.deps);
  expect(output.result.kind).toBe("share-sheet");expect(output.result.message).toBeUndefined();
  await expect(drive("herdr-test",["alert","accept"],false,h.deps)).rejects.toThrow("not an alert");
  expect(h.calls.some(c=>c.args[1]==="alert")).toBe(false);expect(h.locked()).toBe(false);
});

test("alert fallback discards share-sheet background messages while preserving genuine permission alerts", async () => {
  const h=harness();
  h.respond(args=>ok(args[1]==="snapshot"?{nodes:[]}:args[1]==="alert"?{items:["Copy","Save to Files","More"],message:"Background referral text"}:{}));
  const share=await drive("herdr-test",["alert","get"],false,h.deps);
  expect(share.result.kind).toBe("share-sheet");expect(share.result.message).toBeUndefined();
  await expect(drive("herdr-test",["alert","dismiss"],false,h.deps)).rejects.toThrow("not an alert");
  expect(h.calls.filter(c=>c.args[1]==="alert").every(c=>c.args[2]==="get")).toBe(true);
  const permission={items:["Allow","Don't Allow"],title:"Notifications",message:"Allow notifications?"};
  h.respond(args=>ok(args[1]==="snapshot"?{nodes:[{type:"Alert",label:"Notifications"}]}:args[1]==="alert"?permission:{}));
  expect((await drive("herdr-test",["alert"],false,h.deps)).result).toEqual(permission);
});

test("keyboard dismiss records foreground state around the backend command and detects a switch without activating an app", async () => {
  for(const switched of [false,true]) {
    const h=harness();let states=0;
    h.respond(args=>ok(args[1]==="appstate"?{appBundleId:"app.test",state:++states===2&&switched?"runningBackground":"runningForeground"}:{}));
    const output=await drive("herdr-test",["keyboard","dismiss"],false,h.deps);
    expect(output.dismissCheck.foregroundChanged).toBe(switched);
    expect(h.calls.map(c=>c.args[1])).toEqual(["appstate","keyboard","appstate","screenshot"]);
    expect(h.calls.some(c=>["open","back","home"].includes(c.args[1]))).toBe(false);
  }
});

test("help lists every helper command and permitted flag without requiring an active session", async () => {
  const help=await main(["--help"]);
  for(const word of [...ACTIONS,...FLAGS,"--compact","--snapshot","key tab","key enter"])expect(help.help).toContain(word);
  expect((await main(["-h"])).help).toBe(help.help);
});

test("closing a session does not depend on installing a keyboard patch", async () => {
  const h=harness();h.deps.prepare=async()=>{throw new Error("bad installation");};
  expect((await drive("herdr-test",[],true,h.deps)).closed).toBe(true);
  expect(h.calls.map(c=>c.args[1])).toEqual(["close"]);expect(h.locked()).toBe(false);
});

test("keyboard patch is checked, idempotent, and retains the ordinary occlusion guard", async () => {
  const source='function _(e,t){if(h(e)||o(e,a)||o(e,l)||g(e))return!0;let n=new Set,r=e.parentIndex;for(;typeof r==`number`&&!n.has(r);){n.add(r);let e=t.get(r);if(!e)return!1;if(o(e,l)||g(e))return!0;r=e.parentIndex}return!1}';
  const hash=createHash("sha256").update(source).digest("hex");
  const patched=keyboardPatch(source,hash);
  expect(patched).toContain("UIInputSet");expect(patched).toContain("h(e)");expect(patched).toContain("g(e)");
  expect(keyboardPatch(patched,hash)).toBe(patched);
  expect(()=>keyboardPatch(patched+'altered',hash)).toThrow("pinned");
  expect(()=>keyboardPatch("different backend")).toThrow("pinned");
  const writes:any[]=[];
  await expect(ensureKeyboardPatch("/tools/bin/agent-device.mjs",{readFile:async()=>"unexpected backend",writeFile:async(...args)=>writes.push(args),rename:async()=>{}})).rejects.toThrow("pinned");
  expect(writes).toEqual([]);
});


test("simulator taps validate backend refs before normalized HID input, and always release", async () => {
  const events = [], lookups = [];
  class SimHID { constructor(id) { events.push(id); } async setScreen(id) { events.push(id); return true; } async touch(...args) { events.push(args); } }
  const native = { SimHID, axDescribe: async () => JSON.stringify([{frame:{x:0,y:0,width:402,height:874}}]) };
  const connection = { device:{id:"EXACT",platform:"ios",kind:"simulator"} };
  const deps = {toolsRoot:"/tools",loadNative:()=>native,pause:async()=>{},invoke:async args=>{lookups.push(args);return {node:{hittable:true,rect:{x:100,y:800,width:40,height:40}}};}};
  const result = await simulatorInput(connection,["click","@e24"],deps);
  expect(lookups).toEqual([["get","attrs","@e24"]]);expect(result.transport).toBe("simulator-hid");
  expect(events.slice(2)).toEqual([["begin",120/402,820/874,402,874,0],["end",120/402,820/874,402,874,0]]);
  events.length=0;
  await expect(simulatorInput(connection,["click","@expired"],{...deps,invoke:async()=>{throw Error("expired ref frame");}})).rejects.toThrow("expired");
  expect(events).toEqual(["EXACT",0]);
  events.length=0;
  const withKeyboard={...native,axDescribe:async()=>JSON.stringify([{frame:{x:0,y:0,width:402,height:874},children:[{type:"Keyboard",frame:{x:0,y:600,width:402,height:274}}]}])};
  await expect(simulatorInput(connection,["click","@e24"],{...deps,loadNative:()=>withKeyboard})).rejects.toThrow("behind the keyboard");expect(events).toEqual(["EXACT",0]);
  events.length=0;
  await expect(simulatorInput(connection,["click","900","900"],deps)).rejects.toThrow("outside");expect(events).toEqual(["EXACT",0]);
  events.length=0;
  await expect(simulatorInput(connection,["click","@e24"],{...deps,pause:async()=>{throw Error("interrupted");}})).rejects.toThrow("interrupted");
  expect(events.at(-1)[0]).toBe("end");
});

test("simulator typing uses native accessibility text input, stopping on rejection", async () => {
  const characters=[];
  const native={SimHID:class {async setScreen(){return true;}},axTypeKeyboardCharacter:async(id,text)=>{characters.push([id,text]);return text!=="!";}};
  const deps={toolsRoot:"/tools",loadNative:()=>native,pause:async()=>{}};
  await simulatorInput({device:{id:"EXACT"}},["type","A🐈"],deps);
  expect(characters).toEqual([["EXACT","A"],["EXACT","🐈"]]);
  await expect(simulatorInput({device:{id:"EXACT"}},["type","!stop"],deps)).rejects.toThrow("did not accept");
  expect(characters.at(-1)).toEqual(["EXACT","!"]);
});

test("session locks retain live owners and reclaim a dead owner", async () => {
  const fs=await import("node:fs/promises"), {tmpdir}=await import("node:os"), {join}=await import("node:path"), {spawnSync}=await import("node:child_process");
  const directory=await fs.mkdtemp(join(tmpdir(),"herdr-lock-test-")), path=join(directory,"agent.lock");
  try {
    const lock=await commandLock(path,"busy");
    expect(JSON.parse(await fs.readFile(path,"utf8")).pid).toBe(process.pid);
    await expect(commandLock(path,"busy")).rejects.toThrow("busy");
    await lock.close();await fs.unlink(path);
    const dead=Number(spawnSync(process.execPath,["-e","console.log(process.pid)"],{encoding:"utf8"}).stdout.trim());
    await fs.writeFile(path,JSON.stringify({pid:dead}));
    const recovered=await commandLock(path,"busy");expect(JSON.parse(await fs.readFile(path,"utf8")).pid).toBe(process.pid);await recovered.close();
    await fs.writeFile(path,JSON.stringify({pid:dead}));
    const contenders=await Promise.allSettled([commandLock(path,"busy"),commandLock(path,"busy")]);
    expect(contenders.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    for(const result of contenders)if(result.status==="fulfilled")await result.value.close();
    expect(JSON.parse(await fs.readFile(path,"utf8")).pid).toBe(process.pid);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});


test("native simulator input never invokes a backend click, and invalidates refs before capture", async () => {
  const h=harness();
  h.deps.simInput=async(_connection,_command,{onInput})=>{onInput();return {transport:"simulator-hid"};};
  const output=await drive("herdr-test",["click","@e1"],false,h.deps);
  expect(output.result.transport).toBe("simulator-hid");
  expect(h.calls.map(c=>c.args[1])).toEqual(["snapshot","screenshot"]);
  h.calls.length=0;
  h.deps.simInput=async(_connection,_command,{onInput})=>{onInput();throw Error("partial input failed");};
  await expect(drive("herdr-test",["click","@e1"],false,h.deps)).rejects.toThrow("partial input failed");
  expect(h.calls.map(c=>c.args[1])).toEqual(["snapshot"]);expect(h.locked()).toBe(false);
});

test("backend command deadline stops even a child that ignores SIGTERM", async () => {
  const {execute}=await import("../defaults/mods/devices/agent.mjs");
  const start=Date.now();
  await expect(execute(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{timeout:300})).rejects.toThrow("timed out");
  expect(Date.now()-start).toBeLessThan(5000);
});

test("a dead caller cancels the helper's child and releases its session lock", async () => {
  const fs=await import("node:fs/promises"), {tmpdir}=await import("node:os"), {join}=await import("node:path"), {spawn}=await import("node:child_process");
  const directory=await fs.mkdtemp(join(tmpdir(),"herdr-orphan-test-"));
  const session="herdr-orphan-test", dir=join(directory,"device-panels",session), helper=join(directory,"helper.mjs"), parentScript=join(directory,"parent.mjs");
  const module=new URL("../defaults/mods/devices/agent.mjs",import.meta.url).href;
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(join(dir,"status.json"),JSON.stringify({opened:true,status:"ready",device:{platform:"android",kind:"device",id:"test"},node:process.execPath,cli:"unused",state:"unused"}));
  await fs.writeFile(helper,`import {watchCaller,drive,execute} from ${JSON.stringify(module)}; import {writeFile} from 'node:fs/promises'; const stop=watchCaller(); try {await drive('${session}',['snapshot'],false,{prepare:async()=>{},run:async()=>execute(process.execPath,['-e',"setInterval(()=>{},1000)"])});} catch(error) {await writeFile(${JSON.stringify(join(directory,"result"))},error.message);} finally {stop();}`);
  await fs.writeFile(parentScript,`import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(helper)}],{env:process.env,stdio:'ignore'}); console.log(child.pid);setInterval(()=>{},1000);`);
  const parent=spawn(Bun.which("node"),[parentScript],{env:{...process.env,HERDR_APP_HOME:directory},stdio:["ignore","pipe","pipe"]});
  let childPid;
  const until=async test=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await test())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error("fixture timeout");};
  try {
    parent.stdout.on("data",data=>{childPid=Number(String(data).trim());});
    await until(async()=>Boolean(childPid)&&await fs.stat(join(dir,"agent.lock")).then(()=>true,()=>false));
    // Positive control: this live helper really holds the lock before killing its caller.
    expect(JSON.parse(await fs.readFile(join(dir,"agent.lock"),"utf8")).pid).toBe(childPid);
    parent.kill("SIGKILL");
    await until(async()=>await fs.readFile(join(directory,"result"),"utf8").then(text=>text.includes("disconnected"),()=>false));
    expect(await fs.stat(join(dir,"agent.lock")).then(()=>true,()=>false)).toBe(false);
    const lock=await commandLock(join(dir,"agent.lock"),"busy");await lock.close();
  } finally {
    parent.kill("SIGKILL");if(childPid)try{process.kill(childPid,"SIGKILL");}catch{}
    await fs.rm(directory,{recursive:true,force:true});
  }
},15000);


test("simulator inspection creates expiring refs from native AX and captures through the native display", async () => {
  const files=new Map(), events=[];
  const io={readFile:async path=>{if(!files.has(path))throw Error("missing");return files.get(path);},writeFile:async(path,data)=>files.set(path,data),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);}};
  const native={axDescribe:async()=>JSON.stringify([{type:"Application",frame:rect(),children:[{type:"Button",AXLabel:"Earnings",enabled:true,frame:rect(100,800,40,40)}]}]),
    SimCapture:class {constructor(id){events.push(id);}async start(){events.push("start");}async activeScreenId(){return 1;}async screenshot(id,width){events.push([id,width]);return new Uint8Array([137,80,78,71]);}async stop(){events.push("stop");}}};
  const connection={device:{id:"EXACT"},app:"app.test"}, deps={toolsRoot:"/tools",dir:"/session",io,loadNative:()=>native};
  const first=await simulatorInspect(connection,["snapshot","-i"],deps);
  expect(first.source).toBe("simulator-ax");expect(first.nodes[1].label).toBe("Earnings");
  const ref=`@${first.nodes[1].ref}`;
  expect((await simulatorInspect(connection,["get","attrs",ref],deps)).node.rect).toEqual(rect(100,800,40,40));
  expect((await simulatorInspect(connection,["get","attrs",'label="Earnings"'],deps)).node.label).toBe("Earnings");
  await simulatorInspect(connection,["snapshot","-i"],deps);
  await expect(simulatorInspect(connection,["get","attrs",ref],deps)).rejects.toThrow("expired");
  await simulatorInspect(connection,["screenshot","/screen.png"],deps);
  expect(events).toEqual(["EXACT","start",[1,0],"stop"]);expect(files.get("/screen.png")).toEqual(new Uint8Array([137,80,78,71]));
});

test("agent screenshots reuse the exact live capture owner without stopping another native capture", async () => {
  const calls=[],writes=[],bytes=new Uint8Array([137,80,78,71,13,10,26,10,1]);
  const owner={pid:process.pid,device:"EXACT",platform:"ios",url:"http://127.0.0.1:43123/"};
  const io={readdir:async()=>['owner.json'],readFile:async()=>JSON.stringify(owner),writeFile:async(...args)=>writes.push(args)};
  const request=async(url,options)=>{calls.push([url,options]);return url.endsWith('stream-health')?{json:async()=>({available:true,device:'EXACT',platform:'ios'})}:{ok:true,arrayBuffer:async()=>bytes.buffer};};
  const result=await simulatorInspect({device:{id:'EXACT'}},['screenshot','/proof.png'],{toolsRoot:'/tools',dir:'/session',io,request,loadNative:()=>({SimCapture:class{constructor(){throw Error('must not create a second capture');}}})});
  expect(result.transport).toBe('shared-simulator-capture');expect(writes).toEqual([['/proof.png',bytes]]);expect(calls[1][1].method).toBe('POST');expect(calls[1][0]).toContain('device=EXACT');
  await expect(simulatorInspect({device:{id:'EXACT'}},['screenshot','/proof.png'],{toolsRoot:'/tools',dir:'/session',io,request:async url=>url.endsWith('stream-health')?{json:async()=>({available:false,device:'EXACT',platform:'ios'})}:{ok:false,arrayBuffer:async()=>new Uint8Array().buffer},loadNative:()=>({SimCapture:class{constructor(){throw Error('must not create a second capture');}}})})).rejects.toThrow('reconnecting');
});

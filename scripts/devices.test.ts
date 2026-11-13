import { test, expect } from "bun:test";
import { DeviceSession, VERSION, result, mobileDevices, pngSize, target, chooseDevice } from "../defaults/mods/devices/device.js";
import { actionArgs, ownerPane, sessionDir, splitPanel, appCommand } from "../defaults/mods/devices/agent.mjs";
import { connectGlobal } from "../defaults/mods/devices/global.js";

const ios = { id: "phone with spaces", name: "iPhone", platform: "ios", target: "mobile", kind: "device" };
const android = { ...ios, id: "emulator-5554", name: "Pixel", platform: "android", kind: "emulator" };
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,146,0,0,3,106]);
const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" });

test("global device-only connection works inside the real session's exclusive operation", async () => {
  const h = harness();
  await h.tools.exclusive(() => connectGlobal(h.tools, [android], { device: android.id }, ""));
  expect(h.tools.opened).toBe(true);
  expect(h.calls[0].args.slice(1,4)).toEqual(["open", "--timeout", "540000"]);
  expect(h.calls[0].args).toContain(android.id);
  expect(h.tools.pending).toBe(false);
});

function harness() {
  const calls: any[] = [], removed: string[] = [], written: any[] = [];
  let respond: (args: string[]) => any = args => args.includes("--version") ? { code: 0, stdout: VERSION, stderr: "" } : ok(args.includes("devices") ? { devices: [ios, android] } : {});
  const tools = new DeviceSession({ root: "/app home", session: "panel-a", exec: async (bin: string, args: string[], options: any) => { calls.push({ bin, args, options }); return respond(args); }, fs: { mkdir: async () => {}, readFile: async () => png, writeFile: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); }, unlink: async (path: string) => { removed.push(path); } } });
  return { tools, calls, removed, written, respond: (fn: typeof respond) => { respond = fn; } };
}

test("mobile list excludes desktops, TV and malformed entries, retaining explicit identities", () => {
  expect(mobileDevices({ devices: [ios, android, { ...ios, target: "tv" }, { ...ios, platform: "macos" }, { ...ios, id: null }] })).toEqual([ios, android]);
  expect(() => mobileDevices({})).toThrow("no device list");
  expect(target(ios, "a")).toEqual(["--platform", "ios", "--udid", ios.id, "--session", "a"]);
  expect(target(android, "b")).toEqual(["--platform", "android", "--serial", android.id, "--session", "b"]);
  expect(() => target(null, "a")).toThrow("Choose");
});

test("CLI failures retain the error and actionable signing hint even with exit zero", () => {
  expect(() => result({ code: 0, stdout: JSON.stringify({ success: false, error: { message: "Signing failed", details: { hint: "Set team ID" } } }) })).toThrow("Signing failed\nSet team ID");
  expect(() => result({ code: 1, stdout: "", stderr: "node missing" })).toThrow("node missing");
  expect(() => result({ code: 0, stdout: "not JSON" })).toThrow("not JSON");
});

test("a discovery gap retains only an already-bound active session", async () => {
  const h = harness();
  h.tools.select(android);
  await h.tools.open("com.example.flutter");
  h.respond(args => ok(args.includes("session") ? { sessions: [{ name: "panel-a", id: android.id, platform: android.platform }] } : {}));
  await h.tools.restore([]);
  expect(h.tools.opened).toBe(true);
  expect(h.tools.device.id).toBe(android.id);
  await h.tools.capture();
  expect(h.calls.at(-1).args).toContain(android.id);
  h.tools.device = null;
  await expect(h.tools.restore([])).rejects.toThrow("device is unavailable");
});

test("discovery checks the pinned version before running any device operation", async () => {
  const h = harness();
  expect(await h.tools.list()).toEqual([ios, android]);
  expect(h.calls[1].args).not.toContain("--udid");
  h.respond(() => ({ code: 0, stdout: "0.0.1" }));
  await expect(h.tools.list()).rejects.toThrow(VERSION);
  expect(h.calls).toHaveLength(3);
});

test("every input and capture targets the selected physical phone and named session without a shell", async () => {
  const h = harness();
  h.tools.select(ios);
  await h.tools.open("com.example.flutter");
  const previous = h.tools.frame.path;
  await h.tools.act("type", 'hello "world"; $(secret)');
  for (const call of h.calls) {
    expect(call.bin).toBe("node");
    expect(call.args).toContain(ios.id);
    expect(call.args).toContain("panel-a");
    expect(call.args).toContain("/app home/device-tools/state");
    expect(call.args).not.toContain("--serial");
  }
  expect(h.calls[2].args).toContain('hello "world"; $(secret)');
  expect(h.tools.frame).toMatchObject({ width: 402, height: 874 });
  expect(h.removed).toContain(`/app home/${previous}`);
  expect(h.tools.frame.path).not.toBe(previous);
  expect(() => h.tools.select(android)).toThrow("Close the app");
});

test("a capture failure after open retains the session for explicit release", async () => {
  const h = harness();
  h.tools.select(ios);
  h.respond(args => args.includes("screenshot") ? { code: 1, stdout: "", stderr: "capture failed" } : ok({}));
  await expect(h.tools.open("com.example.flutter")).rejects.toThrow("capture failed");
  expect(h.tools.opened).toBe(true);
  await h.tools.release();
  expect(h.tools.opened).toBe(false);
  h.tools.select(android);
});

test("failed close retains ownership and cannot switch to another device", async () => {
  const h = harness();
  h.tools.select(ios);
  await h.tools.open("com.example.flutter");
  h.respond(() => ({ code: 1, stdout: "", stderr: "runner unavailable" }));
  await expect(h.tools.release()).rejects.toThrow("runner unavailable");
  expect(h.tools.opened).toBe(true);
  expect(() => h.tools.select(android)).toThrow();
});

test("commands serialize, prevent device changes while opening, and clear the guard after failure", async () => {
  const h = harness();
  h.tools.select(ios);
  let finish!: () => void;
  const wait = h.tools.exclusive(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(() => h.tools.select(android)).toThrow();
  await expect(h.tools.exclusive(async () => {})).rejects.toThrow("Wait");
  finish(); await wait;
  await expect(h.tools.exclusive(async () => { throw new Error("probe"); })).rejects.toThrow("probe");
  expect(h.tools.pending).toBe(false);
});

test("invalid images and inputs fail before unsafe or untargeted commands", async () => {
  expect(() => pngSize(new Uint8Array(24))).toThrow("PNG");
  const invalid = png.slice(); invalid.fill(0, 16, 20);
  expect(() => pngSize(invalid)).toThrow("dimensions");
  const h = harness();
  await expect(h.tools.act("type", "hello")).rejects.toThrow("Open");
  h.tools.select(ios);
  await expect(h.tools.open("--platform")).rejects.toThrow("bundle ID");
  expect(h.calls).toHaveLength(0);
  await h.tools.open("com.example.flutter");
  const count = h.calls.length;
  await expect(h.tools.act("click", "--serial")).rejects.toThrow("selector");
  await expect(h.tools.act("type", "--json")).rejects.toThrow("dash");
  expect(h.calls).toHaveLength(count);
});

test("agent instructions share the panel session, quote paths, and avoid reopening an active app", async () => {
  const h = harness();
  h.tools.select(ios);
  expect(h.tools.instructions("com.example.flutter")).toContain("'--session' 'panel-a'");
  expect(h.tools.instructions("com.example.flutter")).toContain("'/app home/device-tools/state'");
  await h.tools.open("com.example.flutter");
  const instructions = h.tools.instructions("com.example.flutter");
  expect(instructions).toContain("already open");
  expect(instructions).not.toContain("open 'com.example.flutter'");
  expect(instructions).toContain("do not operate this session concurrently");
});

test("a stopped Android AVD is opened by name, then input targets its returned serial", async () => {
  const h = harness();
  h.tools.select({ ...android, id: "Pixel_8_API_36", booted: false });
  h.respond(args => ok(args.includes("open") ? { id: "emulator-5554" } : {}));
  await h.tools.open("com.example.flutter");
  expect(h.calls[0].args).toContain("--device");
  expect(h.calls[0].args).toContain("Pixel_8_API_36");
  expect(h.calls[1].args).toContain("--serial");
  expect(h.calls[1].args).toContain("emulator-5554");
});

test("reload restores only this panel's live session without launching or closing any app", async () => {
  const h = harness();
  h.respond(() => ok({ sessions: [{ name: "someone-else", id: android.id, platform: "android" }, { name: "panel-a", id: ios.id, platform: "ios" }] }));
  await h.tools.restore([ios, android]);
  expect(h.tools.device).toEqual(ios);
  expect(h.tools.opened).toBe(true);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].args.slice(1, 3)).toEqual(["session", "list"]);
  expect(h.calls[0].args).not.toContain("--udid");
  await h.tools.restore([]);
  expect(h.tools.device).toEqual(ios);
  h.respond(() => ok({ sessions: [] }));
  await h.tools.restore([ios]);
  expect(h.tools.opened).toBe(false);
  expect(h.tools.frame).toBeNull();
});

test("coordinate fallback sends two numeric positional arguments, preserving selectors as one", async () => {
  const h = harness();
  h.tools.select(ios);
  await h.tools.open("com.example.flutter");
  await h.tools.act("click", "201 319.5");
  expect(h.calls[2].args.slice(1, 4)).toEqual(["click", "201", "319.5"]);
  await h.tools.act("click", 'label="Sign In"');
  expect(h.calls[4].args.slice(1, 3)).toEqual(["click", 'label="Sign In"']);
  await h.tools.act("back");
  expect(h.calls[6].args.slice(1, 3)).toEqual(["back", "--system"]);
});

test("an agent opens an exact device during a serialized task without manual selection", async () => {
  const h = harness();
  await h.tools.exclusive(() => h.tools.connect([ios, android], ios.id, "ios", "com.example.flutter"));
  expect(h.tools.opened).toBe(true);
  expect(h.calls[0].args).toContain(ios.id);
  expect(h.calls[0].args).toContain("com.example.flutter");
  expect(h.calls[0].args).toContain("540000");
  await expect(h.tools.connect([ios, android], android.id, "android", "other.app")).rejects.toThrow("Close");
  expect(() => chooseDevice([ios, ios], ios.id)).toThrow("exactly one");
  expect(() => chooseDevice([ios], "unknown")).toThrow("exactly one");
});

test("external agent captures update the preview without issuing another device command", async () => {
  const h = harness();
  h.tools.select(ios);
  await h.tools.open("com.example.flutter");
  const previous = h.tools.frame.path, count = h.calls.length;
  await h.tools.importPreview("/agent/screen.png");
  expect(h.calls).toHaveLength(count);
  expect(h.tools.frame.path).not.toBe(previous);
  expect(h.tools.frame).toMatchObject({ width: 402, height: 874 });
  expect(h.written[0].bytes).toEqual(png);
  expect(h.removed).toContain(`/app home/${previous}`);
});

test("agent helper locates its own local terminal and refuses another machine", () => {
  const list = { spaces: [{ machine: null, tabs: [{ terminals: [{ terminal: "t1", pane: "p1" }, { terminal: "t2", pane: "p2" }] }] }, { machine: "remote", tabs: [{ terminals: [{ terminal: "remote/t3", pane: "remote/p3" }] }] }] };
  expect(ownerPane(list, "t2")).toBe("p2");
  expect(() => ownerPane(list, "remote/t3")).toThrow("local Herdr pane");
  expect(() => ownerPane(list, undefined)).toThrow("local Herdr pane");
  expect(() => sessionDir("../../other-session")).toThrow("Invalid");
});

test("agent actions cannot override the panel's device, session or daemon", () => {
  expect(actionArgs(["snapshot", "-i"])).toEqual(["snapshot", "-i"]);
  expect(actionArgs(["click", "@e1", "--settle"])).toEqual(["click", "@e1", "--settle"]);
  for (const flag of ["--session", "--udid", "--serial=other", "--state-dir", "--daemon-base-url"]) {
    expect(() => actionArgs(["click", "@e1", flag, "other"])).toThrow("bound");
  }
  expect(() => actionArgs(["daemon", "stop"])).toThrow("inspection");
});

for (const [app,provider] of [['claude-code','claude'],['codex','codex']]) test(`device opening splits beside the visible ${provider} wrapper`, async () => {
  const list = {spaces:[{machine:null,tabs:[{terminals:[{terminal:'t1',pane:'p1',app}]}]}]};
  const calls:any[] = [], props = {session:'test',device:'exact-device'};
  const opened = await splitPanel(list,'p1',props,async (name,args)=>{calls.push({name,args});return {pane:'device-pane'};});
  expect(calls).toEqual([{name:'pane.split',args:{pane:`${provider}-view-p1`,direction:'right',mod:'devices',props}}]);
  expect(opened).toEqual({pane:'device-pane',owner:`${provider}-view-p1-chat`});
});
test('only a missing presentation wrapper falls back to the raw terminal', async () => {
  const list = {spaces:[{tabs:[{terminals:[{pane:'p1',app:'claude-code'}]}]}]};
  const targets:string[] = [];
  const opened = await splitPanel(list,'p1',{},async (_name,args)=>{targets.push(args.pane);if(targets.length===1)throw new Error('no pane "claude-view-p1"');return {pane:'device-pane'};});
  expect(targets).toEqual(['claude-view-p1','p1']);expect(opened.owner).toBe('p1');
  let count=0;
  await expect(splitPanel(list,'p1',{},async ()=>{count++;throw new Error('layout unavailable');})).rejects.toThrow('layout unavailable');
  expect(count).toBe(1);
});
test('plain terminals and explicit wrapper IDs split exactly the requested pane', async () => {
  for(const pane of ['p1','claude-view-p1']) {
    const calls:any[]=[];
    await splitPanel({spaces:[{tabs:[{terminals:[{pane:'p1',app:'zsh'}]}]}]},pane,{},async (_name,args)=>{calls.push(args.pane);return {pane:'new'};});
    expect(calls).toEqual([pane]);
  }
});

test('the real CLI nonzero JSON error shape permits only the missing-wrapper fallback', async () => {
  const list = {spaces:[{tabs:[{terminals:[{pane:'p1',app:'claude-code'}]}]}]};
  const targets:string[] = [];
  const invoke = async (_bin:string,args:string[]) => {
    const pane = JSON.parse(args[2]).pane;
    targets.push(pane);
    return pane === 'claude-view-p1'
      ? {code:1,stdout:JSON.stringify({error:'no pane "claude-view-p1"'},null,2)+'\n',stderr:''}
      : {code:0,stdout:JSON.stringify({pane:'device-pane'}),stderr:''};
  };
  const opened = await splitPanel(list,'p1',{},(name,args)=>appCommand(name,args,invoke));
  expect(targets).toEqual(['claude-view-p1','p1']);
  expect(opened).toEqual({pane:'device-pane',owner:'p1'});
  for(const error of ['layout unavailable','no pane "another-pane"','no mod "devices" in mods/']) {
    let count=0;
    await expect(splitPanel(list,'p1',{},(name,args)=>appCommand(name,args,async ()=>{
      count++;return {code:1,stdout:JSON.stringify({error},null,2)+'\n',stderr:''};
    }))).rejects.toThrow(error);
    expect(count).toBe(1);
  }
  await expect(appCommand('pane.split',{},async ()=>({code:1,stdout:'',stderr:'executable failed'}))).rejects.toThrow('executable failed');
});

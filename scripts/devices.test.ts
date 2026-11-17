import { test, expect } from "bun:test";
import { DeviceSession, VERSION, result, mobileDevices, pngSize, target, chooseDevice, signingVars, withSigning } from "../defaults/mods/devices/device.js";
import { actionArgs, ownerPane, sessionDir, splitPanel, appCommand, staleSigningDaemon, refreshSigningDaemon, registerIphone, openGlobal } from "../defaults/mods/devices/agent.mjs";
import { mkdtemp, writeFile as writeText, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function harness(signing?: string) {
  const calls: any[] = [], removed: string[] = [], written: any[] = [];
  // No saved iPhone signing unless a test supplies the file's text.
  const readFile = async (path: string) => {
    if (!path.endsWith("ios-signing.json")) return png;
    if (signing === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return signing;
  };
  let respond: (args: string[]) => any = args => args.includes("--version") ? { code: 0, stdout: VERSION, stderr: "" } : ok(args.includes("devices") ? { devices: [ios, android] } : {});
  const tools = new DeviceSession({ root: "/app home", session: "panel-a", exec: async (bin: string, args: string[], options: any) => { calls.push({ bin, args, options }); return respond(args); }, fs: { mkdir: async () => {}, readFile, writeFile: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); }, unlink: async (path: string) => { removed.push(path); } } });
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
  h.respond(args => ok(args.includes("boot") || args.includes("open") ? { id: "emulator-5554" } : {}));
  await h.tools.open("com.example.flutter");
  expect(h.calls[0].args.slice(1, 3)).toEqual(["boot", "--headless"]);
  expect(h.calls[0].args).toContain("--device");
  expect(h.calls[0].args).toContain("Pixel_8_API_36");
  expect(h.calls[1].args).toContain("open");
  expect(h.calls[1].args).toContain("--serial");
  expect(h.calls[1].args).toContain("emulator-5554");
});

test("manual Android connection boots in the background and stops on boot failure", async () => {
  const h = harness();
  h.tools.select({ ...android, id: "Pixel_8_API_36", booted: false });
  h.respond(args => args.includes("boot") ? ok({ id: "emulator-5556" }) : ok({}));
  await h.tools.openDevice();
  expect(h.calls[0].args).toContain("--headless");
  expect(h.calls[1].args).toContain("emulator-5556");
  expect(h.calls[2].args).toContain("emulator-5556");
  const failed = harness();
  failed.tools.select({ ...android, booted: false });
  failed.respond(() => ({ code: 1, stderr: "Boot failed", stdout: "" }));
  await expect(failed.tools.openDevice()).rejects.toThrow("Boot failed");
  expect(failed.tools.opened).toBe(false);
  expect(failed.calls).toHaveLength(1);
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

const signing = JSON.stringify({ teamId: "ABCDE12345", bundleId: "com.example.agentdevice.runner" });

test("without saved iPhone signing every backend call keeps today's exact argv", async () => {
  const h = harness();
  await h.tools.list();
  expect(h.calls.map(c => c.bin)).toEqual(["node", "node"]);
  expect(h.calls[1].args).toEqual(["/app home/device-tools/node_modules/agent-device/bin/agent-device.mjs", "devices", "--state-dir", "/app home/device-tools/state", "--json"]);
});

test("saved signing reaches the backend daemon through env, without a shell", async () => {
  const h = harness(signing);
  await h.tools.list();
  const call = h.calls[1];
  expect(call.bin).toBe("/usr/bin/env");
  expect(call.args.slice(0, 4)).toEqual(["AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345", "AGENT_DEVICE_IOS_BUNDLE_ID=com.example.agentdevice.runner", "node", "/app home/device-tools/node_modules/agent-device/bin/agent-device.mjs"]);
  expect(call.args).toContain("devices");
});

test("invalid signing settings fail loudly instead of signing with the wrong team", async () => {
  await expect(harness("{not json").tools.list()).rejects.toThrow("not valid JSON");
  expect(() => signingVars({ teamId: "abc" })).toThrow("10-character");
  expect(() => signingVars({ bundleId: "runner" })).toThrow("reverse-DNS");
  expect(() => signingVars({ teamId: "ABCDE12345\nX" })).toThrow("single-line");
  expect(signingVars({ teamId: "ABCDE12345", signingIdentity: "Apple Development: A (B)" })).toEqual({ AGENT_DEVICE_IOS_TEAM_ID: "ABCDE12345", AGENT_DEVICE_IOS_SIGNING_IDENTITY: "Apple Development: A (B)" });
});

test("the helper's own spawns carry the saved signing, which wins over exported variables", async () => {
  const home = await mkdtemp(join(tmpdir(), "herdr-signing-"));
  try {
    await Bun.write(join(home, "device-tools/ios-signing.json"), JSON.stringify({ teamId: "ABCDE12345", bundleId: "com.example.agentdevice.runner" }));
    const script = `const { execute } = await import(${JSON.stringify(new URL("../defaults/mods/devices/agent.mjs", import.meta.url).href)}); console.log((await execute("/usr/bin/env", [])).stdout);`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, HERDR_APP_HOME: home, AGENT_DEVICE_IOS_TEAM_ID: "ZZZZZ99999" } });
    const env = child.stdout.toString().split("\n");
    expect(env).toContain("AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345");
    expect(env).toContain("AGENT_DEVICE_IOS_BUNDLE_ID=com.example.agentdevice.runner");
  } finally { await rm(home, { recursive: true, force: true }); }
  expect(withSigning("node", ["x"], { AGENT_DEVICE_IOS_TEAM_ID: "ABCDE12345" })).toEqual(["/usr/bin/env", ["AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345", "node", "x"]]);
});

test("backend signing failures carry the registration hint", () => {
  for (const message of ['error: No Account for Team "ABCDE12345"', "Failed to install embedded profile: 0xe8008012", "its provisioning profile does not cover it"])
    expect(() => result({ code: 1, stdout: JSON.stringify({ success: false, error: { message } }), stderr: "" })).toThrow("ios-register --device UDID, then close and open the device again");
  expect(() => result({ code: 1, stdout: JSON.stringify({ success: false, error: { message: "boom" } }), stderr: "" })).toThrow(/^boom$/);
});

const daemonIo = (pid: unknown) => ({ readFile: async (path: string) => {
  if (path.endsWith("ios-signing.json")) return signing;
  if (path.endsWith("daemon.json")) return JSON.stringify({ pid });
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
} });
const vars = { AGENT_DEVICE_IOS_TEAM_ID: "ABCDE12345", AGENT_DEVICE_IOS_BUNDLE_ID: "com.example.agentdevice.runner" };

test("a daemon is stale only when it lacks a saved signing variable", async () => {
  const ps = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: "" });
  const good = "node daemon.js HOME=/u AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345 AGENT_DEVICE_IOS_BUNDLE_ID=com.example.agentdevice.runner PATH=/bin\n";
  expect(await staleSigningDaemon(vars, { io: daemonIo(42), run: ps(good) })).toBeNull();
  expect(await staleSigningDaemon(vars, { io: daemonIo(42), run: ps("node daemon.js HOME=/u PATH=/bin\n") })).toBe(42);
  // A prefix of a longer team ID is not a match.
  expect(await staleSigningDaemon(vars, { io: daemonIo(42), run: ps(good.replace("ABCDE12345", "ABCDE123456")) })).toBe(42);
  expect(await staleSigningDaemon(vars, { io: daemonIo(42), run: ps("", 1) })).toBeNull();
  expect(await staleSigningDaemon({}, { io: daemonIo(42), run: ps("") })).toBeNull();
});

test("a stale daemon is stopped through the backend's verified stop, only when no session is live", async () => {
  const stops: string[][] = [];
  const run = (sessions: string[]) => async (bin: string, args: string[]) => {
    if (bin === "ps") return { code: 0, stdout: "node daemon.js HOME=/u\n", stderr: "" };
    if (args.includes("daemon")) { stops.push(args.slice(1)); return ok({ stopped: true }); }
    return ok({ sessions: sessions.map(name => ({ name })) });
  };
  await expect(refreshSigningDaemon({ io: daemonIo(42), run: run(["herdr-other"]) })).rejects.toThrow("herdr-other");
  expect(stops).toEqual([]);
  expect(await refreshSigningDaemon({ io: daemonIo(42), run: run([]) })).toEqual({ restarted: true, pid: 42 });
  expect(stops).toEqual([["daemon", "stop", "--state-dir", expect.stringContaining("device-tools/state"), "--json"]]);
});

test("a shared physical-iPhone open checks the daemon under the open lock; simulators never do", async () => {
  const order: string[] = [];
  let request: any;
  const io = { mkdir: async () => {}, open: async (path: string) => { order.push(`lock ${path.split("/").pop()}`); return { close: async () => {} }; },
    writeFile: async (_path: string, text: string) => { request = JSON.parse(text); order.push("request"); }, rename: async () => {}, unlink: async () => {},
    readFile: async () => JSON.stringify(request ? { requestId: request.id, status: "ready", opened: true, session: "s" } : {}) };
  const refresh = async () => { order.push("refresh"); return { restarted: false }; };
  await openGlobal({ id: "u", platform: "ios", kind: "device" }, "app", { io, command: async () => {}, refresh, timeout: 1000 });
  expect(order).toEqual(["lock open.lock", "refresh", "request"]);
  order.length = 0; request = undefined;
  await openGlobal({ id: "s", platform: "ios", kind: "simulator" }, "app", { io, command: async () => {}, refresh, timeout: 1000 });
  expect(order).not.toContain("refresh");
});

test("ios-register builds against the phone with device registration, then drops cached runners", async () => {
  const calls: any[] = [], removed: string[] = [];
  const io = { readFile: daemonIo(0).readFile, readdir: async () => ["cache-a", "other", "cache-b"], rm: async (path: string) => { removed.push(path); }, mkdir: async () => {}, writeFile: async () => {}, rename: async () => {} };
  const run = async (bin: string, args: string[]) => {
    calls.push({ bin, args });
    if (bin === "xcrun") return { code: 0, stdout: "Phone  UDID-1 (UDID)  available (paired)", stderr: "" };
    return { code: 0, stdout: "** TEST BUILD SUCCEEDED **", stderr: "" };
  };
  const out = await registerIphone(["--device", "UDID-1"], { io, run, home: "/u", scratch: "/tmp" });
  const build = calls.find(c => c.bin === "xcodebuild").args;
  expect(build).toContain("-allowProvisioningDeviceRegistration");
  expect(build[build.indexOf("-destination") + 1]).toBe("id=UDID-1");
  expect(build).toContain("DEVELOPMENT_TEAM=ABCDE12345");
  expect(build).toContain("AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.example.agentdevice.runner.uitests");
  expect(removed.filter(p => p.startsWith("/u/"))).toEqual(["/u/.agent-device/apple-runner/derived/ios-device/cache-a", "/u/.agent-device/apple-runner/derived/ios-device/cache-b"]);
  expect(out.clearedCaches).toBe(2);
  expect(out.next).toContain("Close and open the device again");
});

test("ios-register saves both signing values atomically, and refuses half a pair before writing", async () => {
  const writes: any[] = [];
  const io = { readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, mkdir: async () => {}, writeFile: async (path: string, text: string) => { writes.push(["write", path, text]); }, rename: async (from: string, to: string) => { writes.push(["rename", from, to]); }, readdir: async () => [], rm: async () => {} };
  await expect(registerIphone(["--device", "U", "--team", "ABCDE12345"], { io, run: async () => ({ code: 0, stdout: "", stderr: "" }), home: "/u", scratch: "/tmp" })).rejects.toThrow("both --team and --bundle");
  expect(writes).toEqual([]);
  await registerIphone(["--device", "U", "--team", "ABCDE12345", "--bundle", "com.example.agentdevice.runner"], { io, run: async () => ({ code: 1, stdout: "", stderr: "" }), home: "/u", scratch: "/tmp" }).catch(() => {});
  expect(JSON.parse(writes[0][2])).toEqual({ teamId: "ABCDE12345", bundleId: "com.example.agentdevice.runner" });
  expect(writes[1][0]).toBe("rename");
  expect(writes[1][2]).toEndWith("device-tools/ios-signing.json");
});

test("ios-register refuses an unlisted phone or a failed build without touching caches", async () => {
  const removed: string[] = [];
  const io = { readFile: daemonIo(0).readFile, readdir: async () => ["cache-a"], rm: async (path: string) => { removed.push(path); } };
  await expect(registerIphone(["--device", "UDID-9"], { io, run: async () => ({ code: 0, stdout: "other phones", stderr: "" }), home: "/u", scratch: "/tmp" })).rejects.toThrow("does not list UDID-9");
  const failing = async (bin: string) => bin === "xcrun" ? { code: 0, stdout: "UDID-1", stderr: "" } : { code: 65, stdout: "x\nerror: No profiles for 'a' were found\n", stderr: "" };
  await expect(registerIphone(["--device", "UDID-1"], { io, run: failing, home: "/u", scratch: "/tmp" })).rejects.toThrow("No profiles");
  expect(removed.filter(p => p.startsWith("/u/"))).toEqual([]);
});

import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PhysicalPreview, startPhysicalServer, validTouches } from "../defaults/mods/devices/physical.mjs";
import { PhysicalPlayer } from "../defaults/mods/devices/physical-viewer.js";
import { physicalDevice, physicalRoot, PHYSICAL_VERSION, SOURCE_REVISION, SOURCE_SHA256, PATCH_SHA256 } from "../defaults/mods/devices/physical-spec.js";
import { installedPhysicalTools, buildLock } from "../defaults/mods/devices/physical-build.mjs";

const device = "00008140-0000000000000001", origin = "http://127.0.0.1:34567";
const config = { revision: 1, width: 1216, height: 2656, displayWidth: 1206, displayHeight: 2622, codec: "hvc1.1.6.L153.B0", description: Buffer.from([1, 2]) };
const batch = (generation = 1, key = true) => ({ generation, configuration: config, frames: [{ data: Buffer.from([3, 4]), timestamp: 1000, key }], dropped: 0 });
const sample = { phase: 0, x: 0.5, y: 0.25, width: 1206, height: 2622 };
const deferred = () => { let resolve: (value?: any) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve: value => resolve(value) }; };

function fixture() {
  const events: any[] = [];
  let clock = 0, generation = 1;
  const capture = { read: async () => batch(generation), touch: async (...args) => { events.push(["touch", ...args]); }, requestKeyframe: () => { generation++; events.push(["reset"]); }, close: async () => { events.push(["close"]); } };
  const preview = new PhysicalPreview({ device, token: "owner-token", now: () => clock, openDevice: async id => { events.push(["open", id]); return capture; } });
  const call = (operation, data = {}, headers = {}, url = origin) => preview.handle(new Request(`${url}/${operation}`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-device-token": "owner-token", ...headers }, body: JSON.stringify(data) }), origin);
  return { preview, capture, events, call, advance: () => { clock += 31000; } };
}

test("physical target validation accepts actual UDIDs and rejects simulator/flag/path targets", () => {
  expect(physicalDevice(device)).toBe(device);
  expect(physicalDevice("1234567890123456789012345678901234567890")).toHaveLength(40);
  for (const id of ["--other", "../phone", "phone", "93A6A933-6313-435F-800F-6AAC4A138358"]) expect(() => physicalDevice(id)).toThrow("UDID");
});

test("a preview binds one exact phone, serializes binary frames and scales touch coordinates", async () => {
  const f = fixture(), opened = await f.call("open"), { session } = await opened.json();
  expect(opened.status).toBe(200); expect(f.events).toEqual([["open", device]]);
  const read = await (await f.call("read", { session })).json();
  expect(read.configuration).toMatchObject({ description: "AQI=", displayWidth: 1206, displayHeight: 2622 });
  expect(read.frames[0]).toMatchObject({ data: "AwQ=", key: true });
  expect((await f.call("input", { session, generation: 1, samples: [sample] })).status).toBe(200);
  expect(f.events[1]).toEqual(["touch", [{ ...sample, x: 603, y: 655.5 }], 1]);
  await f.preview.dispose(); expect(f.events.at(-1)).toEqual(["close"]);
});

test("preview requests reject cross-site origins, forged hosts, wrong tokens and target overrides", async () => {
  const f = fixture();
  expect((await f.call("open", {}, { origin: "https://attacker.example" })).status).toBe(403);
  expect((await f.call("open", {}, { host: "localhost.attacker.example:34567" })).status).toBe(403);
  expect((await f.call("open", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await f.call("open", {}, { "x-herdr-device-token": "wrong" })).status).toBe(403);
  expect((await f.call("open", {}, {}, "http://attacker.example:34567")).status).toBe(403);
  expect((await f.call("open", { device: "other" })).status).toBe(400);
  expect((await f.call("open", { udid: device })).status).toBe(400);
  expect((await f.call("open", {}, { "content-type": "text/plain" })).status).toBe(415);
  expect((await f.call("open", { oversized: "x".repeat(33000) })).status).toBe(413);
  expect(f.events).toEqual([]);
  expect((await f.call("open", {}, { origin, host: new URL(origin).host })).status).toBe(200);
  await f.preview.dispose();
});

test("touch cannot use stale generations, invalid coordinates or an unscoped session", async () => {
  const f = fixture(), { session } = await (await f.call("open")).json();
  expect((await f.call("input", { session, generation: 1, samples: [sample] })).status).toBe(409);
  await f.call("read", { session });
  expect((await f.call("input", { session: "other", generation: 1, samples: [sample] })).status).toBe(410);
  expect((await f.call("input", { session, generation: 2, samples: [sample] })).status).toBe(409);
  expect((await f.call("input", { session, generation: 1, samples: [{ ...sample, x: 2 }] })).status).toBe(400);
  for (const samples of [[], [null], [{ ...sample, width: 0 }], [{ ...sample, phase: 3 }], Array(65).fill(sample)]) expect(validTouches(samples)).toBe(false);
  await f.call("reset", { session });
  expect((await f.call("input", { session, generation: 1, samples: [sample] })).status).toBe(409);
  await f.call("read", { session });
  expect((await f.call("input", { session, generation: 2, samples: [sample] })).status).toBe(200);
  await f.preview.dispose();
});

test("native stale-input recovery requests a keyframe without closing a healthy preview", async () => {
  const f = fixture(), { session } = await (await f.call("open")).json();
  await f.call("read", { session });
  f.capture.touch = async () => { throw new Error("Wait for a fresh physical iOS screen before sending input."); };
  expect((await f.call("input", { session, generation: 1, samples: [sample] })).status).toBe(409);
  expect(f.events).toEqual([["open", device], ["reset"]]);
  expect(f.preview.session.id).toBe(session); await f.preview.dispose();
});

test("closing during native startup releases its late capture and cannot revive the view", async () => {
  const f = fixture(), opening = deferred(); f.preview.openDevice = () => opening.promise;
  const pending = f.call("open"); await Bun.sleep(0);
  expect((await f.call("open")).status).toBe(409);
  await f.preview.dispose(); opening.resolve(f.capture);
  expect((await pending).status).toBe(410); expect(f.events).toEqual([["close"]]); expect(f.preview.session).toBeNull();
});

test("pending reads are exclusive, expiry closes only the owned capture and close is idempotent", async () => {
  const f = fixture(), { session } = await (await f.call("open")).json(), read = deferred();
  f.capture.read = () => read.promise;
  const pending = f.call("read", { session }); await Bun.sleep(0);
  expect((await f.call("read", { session })).status).toBe(409);
  await f.preview.close(); read.resolve(batch());
  expect((await pending).status).toBe(410); await f.preview.dispose(); expect(f.events.filter(x => x[0] === "close")).toHaveLength(1);
  const e = fixture(), second = await (await e.call("open")).json(); e.advance();
  expect((await e.call("read", second)).status).toBe(410); expect(e.events.at(-1)).toEqual(["close"]);
});

test("native tools accept only the pinned source, patch and actual addon hash", async () => {
  const temp = await mkdtemp(join(tmpdir(), "herdr-physical-install-test-"));
  try {
    const root = physicalRoot(temp); await mkdir(root, { recursive: true });
    const addon = Buffer.from("native-fixture"), addonSha256 = createHash("sha256").update(addon).digest("hex");
    await writeFile(join(root, "ios-device.node"), addon);
    const metadata = { version: PHYSICAL_VERSION, source: SOURCE_REVISION, sourceSha256: SOURCE_SHA256, patchSha256: PATCH_SHA256, addonSha256 };
    await writeFile(join(root, "manifest.json"), JSON.stringify(metadata)); expect(await installedPhysicalTools(temp)).toBe(root);
    await writeFile(join(root, "ios-device.node"), "modified"); expect(await installedPhysicalTools(temp)).toBeNull();
    await writeFile(join(root, "ios-device.node"), addon); await writeFile(join(root, "manifest.json"), JSON.stringify({ ...metadata, source: "other" })); expect(await installedPhysicalTools(temp)).toBeNull();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("an abandoned native build lock recovers without interrupting a live builder", async () => {
  const temp = await mkdtemp(join(tmpdir(), "herdr-physical-lock-test-")), path = join(temp, "build.lock");
  try {
    await writeFile(path, JSON.stringify({ pid: 2000000000 }));
    const lock = await buildLock(path);
    await expect(buildLock(path)).rejects.toThrow("being built");
    await lock.close();
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("the real local HTTP bridge serves a viewer and requires its token for native operations", async () => {
  const f = fixture(), server = await startPhysicalServer({ device, openDevice: f.preview.openDevice });
  try {
    const html = await (await fetch(server.url)).text(); expect(html).toContain("Experimental live iPhone");
    expect(new URL(server.url).hash.slice(1)).toBe(server.preview.token);
    expect(html).not.toContain(server.preview.token);
    expect(await (await fetch(new URL("/", server.url))).text()).not.toContain(server.preview.token);
    expect((await fetch(new URL("open", server.url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
    const opened = await fetch(new URL("open", server.url), { method: "POST", headers: { "content-type": "application/json", "x-herdr-device-token": server.preview.token }, body: "{}" });
    expect(opened.status).toBe(200); expect(f.events).toEqual([["open", device]]);
  } finally { await server.close(); }
  expect(f.events.at(-1)).toEqual(["close"]);
});

async function playerFixture() {
  const pending = deferred(), calls: any[] = [], drawn: any[] = [], statuses: any[] = [];
  class Decoder {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured"; decodeQueueSize = 0; decoded: any[] = [];
    constructor(public handlers: any) {}
    reset() { this.state = "unconfigured"; }
    configure(config) { this.state = "configured"; }
    decode(frame) { this.decoded.push(frame); }
    close() { this.state = "closed"; }
  }
  class Chunk { constructor(public data: any) {} }
  const request = async (operation, data) => { calls.push([operation, data]); if (operation === "open") return { session: "owned" }; if (operation === "read") return pending.promise; return {}; };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => drawn.push(args) }) };
  const player = new PhysicalPlayer({ request, canvas, decoder: Decoder, chunk: Chunk, status: (...args) => statuses.push(args) });
  const running = player.start(); await Bun.sleep(0);
  return { player, calls, drawn, statuses, running, releaseRead: pending.resolve, finish: async () => { await player.stop(); pending.resolve(batch()); await running; } };
}

test("HEVC waits for a keyframe and decoded output before allowing touch, and crops padding", async () => {
  const f = await playerFixture();
  const wire = data => ({ ...data, configuration: { ...data.configuration, description: "AQI=" }, frames: data.frames.map(f => ({ ...f, data: f.data.toString("base64") })) });
  await f.player.accept(wire(batch(1, false))); expect(f.player.decoder.decoded).toHaveLength(0);
  await f.player.accept(wire(batch())); expect(f.player.decoder.decoded[0].data.type).toBe("key");
  f.player.touch(0, 0.5, 0.5); expect(f.calls.filter(x => x[0] === "input")).toHaveLength(0);
  let released = false; const frame = { close: () => { released = true; } }; f.player.decoder.handlers.output(frame);
  expect(released).toBe(true); expect(f.drawn[0]).toEqual([frame, 0, 0, 1206, 2622, 0, 0, 1206, 2622]);
  f.player.touch(0, 0.5, 0.5); await Bun.sleep(0); expect(f.calls.find(x => x[0] === "input")[1]).toMatchObject({ generation: 1, samples: [{ phase: 0, x: 0.5, y: 0.5, width: 1206, height: 2622 }] });
  await f.finish();
});

test("decoder backlog and generation changes drop stale gestures until fresh decoded output", async () => {
  const f = await playerFixture(), wire = data => ({ ...data, configuration: { ...data.configuration, description: "AQI=" }, frames: data.frames.map(f => ({ ...f, data: f.data.toString("base64") })) });
  await f.player.accept(wire(batch())); f.player.decoder.handlers.output({ close() {} });
  f.player.decoder.decodeQueueSize = 9; await f.player.accept({ ...wire(batch()), configuration: undefined });
  expect(f.calls.some(x => x[0] === "reset")).toBe(true);
  f.player.touch(2, 0.2, 0.3); expect(f.player.pending).toHaveLength(0);
  f.player.decoder.decodeQueueSize = 0; await f.player.accept(wire(batch(2))); f.player.decoder.handlers.output({ close() {} });
  f.player.touch(0, 0.2, 0.3); await Bun.sleep(0);
  await f.player.accept(wire(batch(3))); f.player.decoder.handlers.output({ close() {} });
  const count = f.calls.filter(x => x[0] === "input").length; f.player.touch(2, 0.2, 0.3); await Bun.sleep(0); expect(f.calls.filter(x => x[0] === "input")).toHaveLength(count);
  await f.finish(); expect(f.calls.filter(x => x[0] === "close")).toHaveLength(1);
});


test("optional physical video failure leaves the shared agent session ready", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("../defaults/mods/devices/main.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "").replace("export default class Devices", "class Devices");
  const published: any[] = [];
  const Devices = new Function("View", "localStorage", "fs", "writeTextFile", "readTextFile", source + ";return Devices;")(
    class {}, { setItem() {} }, { mkdir: async () => {} }, async (_path, text) => published.push(JSON.parse(text)), async () => null);
  const view = new Devices(); let builds = 0, running;
  Object.assign(view, { managed: true, global: false, controlDir: "fixture", app: { value: () => "dev.app" }, tools: {
    opened: true, device: { platform: "ios", kind: "device" }, exclusive: async work => work(),
    ensureLiveTools: async () => { builds++; throw new Error("Unsupported native video"); }, connection: () => ({ opened: true }),
  } });
  const cx = { notify() {}, spawn: fn => { running = fn(cx); } };
  view.task(cx, "Capture", async () => {}); await running;
  expect(builds).toBe(0); expect(published.at(-1).status).toBe("ready");
  view.startPhysicalVideo(cx); expect(view.busy).toBe(false); await running;
  expect(builds).toBe(1); expect(view.liveError).toContain("Unsupported native video");
  await view.publish(); expect(published.at(-1).status).toBe("ready"); expect(view.liveReady).toBeFalsy();
  view.task(cx, "Input", async () => {}); await running;
  expect(builds).toBe(1); expect(published.at(-1).status).toBe("ready");
  view.tools.ensureLiveTools = async () => { view.tools.device = { ...view.tools.device }; };
  view.startPhysicalVideo(cx); await running;
  expect(view.liveReady).toBe(true); expect(view.liveDevice).toBe("ios:device:undefined");
});


test.skipIf(!Bun.which("node"))("an HTTP viewer disconnect during startup releases the late native capture in Node (requires Node)", () => {
  const module = new URL("../defaults/mods/devices/physical.mjs", import.meta.url).href;
  const script = `
    import {startPhysicalServer} from ${JSON.stringify(module)};
    import {request} from 'node:http';
    let resolve, started, closed = 0;
    const opening = new Promise(r => resolve = r), began = new Promise(r => started = r);
    const server = await startPhysicalServer({device:'00008140-0000000000000001',openDevice:()=>{started();return opening;}});
    const client = request(new URL('open',server.url),{method:'POST',headers:{'content-type':'application/json','x-herdr-device-token':new URL(server.url).hash.slice(1)}});
    client.on('error',()=>{});client.end('{}');await began;client.destroy();
    await new Promise(r=>setTimeout(r,30));resolve({close:async()=>closed++});
    await new Promise(r=>setTimeout(r,30));
    const passed = closed === 1 && server.preview.session === null;
    await server.close();if (!passed) throw new Error('Disconnected viewer retained its capture');
    console.log('NODE_ABORT_PASSED');`;
  const result = Bun.spawnSync(["node", "--input-type=module", "-e", script], { timeout: 5000 });
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("NODE_ABORT_PASSED");
});


test("decoder backlog during a touch closes its capture to release the held contact", async () => {
  const f = await playerFixture();
  await f.player.accept({ ...batch(), configuration: { ...config, description: "AQI=" }, frames: [{ data: "AwQ=", timestamp: 1000, key: true }] });
  f.player.decoder.handlers.output({ close() {} });
  f.player.touch(0, 0.2, 0.3); await Bun.sleep(0);
  f.player.decoder.decodeQueueSize = 9;
  f.releaseRead({ generation: 1, frames: [] }); await f.running;
  expect(f.player.stopped).toBe(true);
  expect(f.calls.filter(x => x[0] === "close")).toHaveLength(1);
  expect(f.statuses.at(-1)[1]).toContain("during a touch");
});

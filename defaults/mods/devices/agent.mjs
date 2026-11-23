// Agent entry point: connect through Herdr's global Devices panel, then use its shared session.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chooseDevice, mobileDevices, readSigning, result, signingPath, signingVars, target, VERSION } from "./device.js";
import { runOptions, annotateSnapshot, compactSnapshot, sendKey, shareSheet, simulatorInput, simulatorInspect } from "./interaction.mjs";
import { ensureKeyboardPatch } from "./backend.mjs";

export const root = resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"));
const cli = join(root, "device-tools/node_modules/agent-device/bin/agent-device.mjs");
const state = join(root, "device-tools/state");
const app = process.env.HERDR_APP_BIN || "herdr-app";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function sessionDir(session) {
  if (!/^herdr-[a-zA-Z0-9-]+$/.test(session)) throw new Error("Invalid Herdr device session.");
  return join(root, "device-panels", session);
}

const cancellation = new AbortController();

export function watchCaller() {
  const parent = process.ppid;
  const abort = () => cancellation.abort(new Error("Device caller disconnected or command was interrupted."));
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  const watch = setInterval(() => { if (process.ppid !== parent) abort(); }, 250);
  watch.unref();
  return () => { clearInterval(watch); process.off("SIGTERM", abort); process.off("SIGINT", abort); };
}

export async function execute(command, args, { timeout = 45000 } = {}) {
  // Saved iPhone signing reaches any backend daemon this call starts; it wins, as in the panel.
  const env = { ...process.env, ...await readSigning(fs, root), PATH: `${resolve(process.execPath, "..")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` };
  cancellation.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "", stderr = "", failure, force;
    const kill = signal => {
      try { if (process.platform === "win32") child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = error => {
      if (failure) return;
      failure = error; kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const abort = () => stop(cancellation.signal.reason);
    const timer = setTimeout(() => stop(new Error(`Device command timed out after ${timeout}ms.`)), timeout);
    cancellation.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); cancellation.signal.removeEventListener("abort", abort); };
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => { cleanup(); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}

export function ownerPane(list, terminal) {
  for (const space of list.spaces ?? []) for (const tab of space.tabs ?? []) {
    const found = (tab.terminals ?? []).find(t => t.terminal === terminal);
    if (found && !space.machine) return found.pane;
  }
  throw new Error("The calling terminal has no local Herdr pane. Pass --pane explicitly.");
}

export async function splitPanel(list, pane, props, command = appCommand) {
  const terminal = (list.spaces ?? []).filter(space => !space.machine).flatMap(space => space.tabs ?? []).flatMap(tab => tab.terminals ?? []).find(t => t.pane === pane);
  const provider = terminal?.app === "claude-code" ? "claude" : terminal?.app === "codex" ? "codex" : null;
  const wrapper = provider && `${provider}-view-${pane}`;
  const split = target => command("pane.split", { pane: target, direction: "right", mod: "devices", props });
  if (wrapper) {
    try { return { ...await split(wrapper), owner: `${wrapper}-chat` }; }
    catch (error) {
      // A CLI agent can run without Chat UI. Only a missing wrapper permits
      // falling back; other failures must never create a second split.
      if (error.message !== `no pane "${wrapper}"`) throw error;
    }
  }
  return { ...await split(pane), owner: pane };
}

export const ACTIONS = ["snapshot", "click", "press", "key", "fill", "type", "scroll", "swipe", "back", "screenshot", "get", "find", "wait", "is", "appstate", "alert", "keyboard"];
export const FLAGS = ["-i", "--interactive", "--raw", "-d", "--depth", "-s", "--scope", "--settle", "--verify", "--timeout", "--system", "--in-app", "--double-tap", "--delay-ms", "--pixels", "--count", "--out", "--first", "--last"];
export const HELP = `Herdr device testing (agent.mjs)
  devices
  show
  open --device EXACT_ID [--app APP_ID] [--platform ios|android]
  open --device EXACT_ID --app APP_ID --pane PANE_ID (legacy sibling pane)
  run SESSION COMMAND [ARGS] [FLAGS]
  status SESSION
  status (global connection); use current in place of SESSION for shared input
  close SESSION
  ios-register --device UDID [--team TEAM_ID --bundle RUNNER_BUNDLE_ID]
  --help | -h | help

Commands: ${ACTIONS.join(", ")}
Backend flags: ${FLAGS.join(" ")}
Helper flags: --compact (snapshot: plain text; action with --snapshot: snapshotText)
              --snapshot (return a fresh interactive snapshot after an action)
Keys: key enter|return|backspace|delete|tab; press Enter/Backspace/Tab are aliases.
  run SESSION key enter --snapshot
  run SESSION key backspace
  run SESSION key tab
  run SESSION snapshot -i --compact
  run SESSION click @e1 --snapshot
  run SESSION click @e1 --snapshot --compact
Lookup: find TEXT is read-only (get attrs); use find TEXT click to tap explicitly.
Selectors: @ref or key=value expressions; quote values containing spaces.
  label="Share Code Link"   id="login"   role=button   visible=true
Multiple key=value terms in one quoted selector narrow the same target.
  run SESSION is visible 'label="Share Code Link"'
  run SESSION get attrs 'label="Share Code Link"'
  run SESSION wait 'label="Loaded"' 3000
  run SESSION find "Share Code Link"          (lookup only)
  run SESSION find "Share Code Link" click    (explicit tap)
Use keyboard enter on physical iPhones. Hardware keys use simulator HID or Android
keyevents, never text control characters. Session/device overrides are forbidden.
Refs expire after input. Copy new refs from snapshot or the returned snapshot field.
Visibility is accessibility/rectangle clipping, not a proof of visible pixels;
hittable is separate. --compact prints ref type label [visibility], flattening whitespace.
partial (<50% visible) includes visibleFraction and visibleRect; fractions use
unclipped or previously observed full bounds, never sibling-size guesses. A fraction
can be unknown when the backend pre-clips bounds on first observation.
Keyboard dismiss uses the keyboard's own dismiss key, never Settings/background taps.
Commands are serialized; coordinate manual input. Closing a pane leaves its session
running; close SESSION releases it. See the Devices section of Herdr AGENTS.md.`;

export function actionArgs(args) {
  if (!ACTIONS.includes(args[0])) throw new Error("Use a device inspection or input command; use close to release the session. Run --help for syntax.");
  for (const arg of args.slice(1)) if (arg.startsWith("-") && !FLAGS.includes(arg)) throw new Error(`Unsupported flag ${arg}; device and session targets are bound by the panel.`);
  return args;
}

async function readStatus(session) {
  return JSON.parse(await fs.readFile(join(sessionDir(session), "status.json"), "utf8"));
}

export async function appCommand(name, args, invoke = execute) {
  const r = await invoke(app, ["do", name, JSON.stringify(args)]);
  let data;
  try { data = JSON.parse(r.stdout); }
  catch (error) {
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    throw error;
  }
  if (data.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  return data;
}

async function devices() {
  const version = await execute(process.execPath, [cli, "--version"]);
  if (version.code || version.stdout.trim() !== VERSION) throw new Error(`Install the panel's device tools ${VERSION} first.`);
  await ensureKeyboardPatch(cli);
  const data = result(await execute(process.execPath, [cli, "devices", "--state-dir", state, "--json"]));
  return mobileDevices(data);
}

async function openPanel(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--device", "--app", "--platform", "--pane"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("open --device <exact-id> --app <installed-app-id> [--platform ios|android] [--pane <pane>]");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.device) throw new Error("open requires --device. Run devices to list exact IDs.");
  if (options.pane && !options.app) throw new Error("Legacy --pane opening requires --app.");
  const device = chooseDevice(await devices(), options.device, options.platform);
  if (!options.pane) return openGlobal(device, options.app || "");
  if (device.platform === "ios" && device.kind === "device") await refreshSigningDaemon();
  const listed = await execute(app, ["ls"]);
  if (listed.code) throw new Error(listed.stderr || listed.stdout);
  const list = JSON.parse(listed.stdout);
  const pane = options.pane || ownerPane(list, process.env.HC_TERMINAL_ID);
  if (!pane || pane.includes("/")) throw new Error("Choose a local terminal pane.");
  const session = `herdr-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await fs.mkdir(sessionDir(session), { recursive: true });
  const opened = await splitPanel(list, pane, { node: process.execPath, session, device: device.id, platform: device.platform, app: options.app, agent: true });
  // Keep typing in the agent terminal while its sibling shows the device.
  await appCommand("pane.focus", { pane: opened.owner });
  const deadline = Date.now() + 600000;
  let refreshAfter = 0;
  while (Date.now() < deadline) {
    let status;
    try { status = await readStatus(session); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (status?.status === "error") throw new Error(`${status.error}\nPanel session: ${session}`);
    if (status?.status === "ready" && status.opened) return { ...status, pane: opened.pane };
    // A source reload can finish before a previously started CLI open does.
    // Reconcile its existing session; never repeat the app-launch command.
    if (status?.status === "ready" && !status.opened && Date.now() >= refreshAfter) {
      await appCommand("devices.refresh", {});
      refreshAfter = Date.now() + 2000;
    }
    await delay(250);
  }
  throw new Error(`Panel startup timed out. Inspect the Devices pane. Session: ${session}`);
}

export async function openGlobal(device, appId, { io = fs, command = appCommand, pause = delay, timeout = 600000, refresh = refreshSigningDaemon } = {}) {
  const directory = join(root, "device-global");
  await io.mkdir(directory, { recursive: true });
  const lock = await commandLock(join(directory, "open.lock"), "Another shared-device connection is in progress.", io);
  let sessionLock, sessionLockPath;
  try {
    let existing;
    try { existing = JSON.parse(await io.readFile(join(directory, "status.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing?.session) {
      sessionLockPath = join(sessionDir(existing.session), "agent.lock");
      sessionLock = await commandLock(sessionLockPath, "Another agent command holds the shared device. Wait for it to finish.", io);
    }
    // Under the open lock, so no other shared open can race the restart.
    if (device.platform === "ios" && device.kind === "device") await refresh();
    const id = randomUUID();
    await io.writeFile(join(directory, "request-next.json"), JSON.stringify({ id, node: process.execPath, device: device.id, platform: device.platform, app: appId }));
    await io.rename(join(directory, "request-next.json"), join(directory, "request.json"));
    await command("layout.select", { stack: "panel-body", child: "devices" });
    await command("layout.show", { id: "panel" });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      cancellation.signal.throwIfAborted();
      let status;
      try { status = JSON.parse(await io.readFile(join(directory, "status.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (status?.requestId === id && status.status === "error") throw new Error(status.error);
      if (status?.requestId === id && status.status === "ready" && status.opened) return { ...status, global: true };
      await pause(250);
    }
    throw new Error("Shared device connection timed out. Check the global Devices panel; it must exist in this layout.");
  } finally {
    if (sessionLock) { await sessionLock.close(); await io.unlink(sessionLockPath); }
    await lock.close(); await io.unlink(join(directory, "open.lock"));
  }
}

// The PID of a running backend daemon that lacks the saved signing settings, else null.
export async function staleSigningDaemon(vars, { io = fs, run = execute } = {}) {
  if (!Object.keys(vars).length) return null;
  let pid;
  try { pid = JSON.parse(await io.readFile(join(state, "daemon.json"), "utf8")).pid; } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = await run("ps", ["eww", "-o", "command=", "-p", String(pid)]);
  if (ps.code !== 0 || !ps.stdout.trim()) return null;
  const text = ` ${ps.stdout.trim()} `;
  return Object.entries(vars).every(([name, value]) => text.includes(` ${name}=${value} `)) ? null : pid;
}

// Restart a daemon started without the saved signing (e.g. by the panel before the
// settings existed). Never while any session is live: that would end another agent's run.
// The backend's own stop verifies the daemon's PID and start time before stopping it.
export async function refreshSigningDaemon({ io = fs, run = execute } = {}) {
  const pid = await staleSigningDaemon(await readSigning(io, root), { io, run });
  if (!pid) return { restarted: false };
  const listed = result(await run(process.execPath, [cli, "session", "list", "--state-dir", state, "--json"]));
  const live = (listed.sessions ?? []).map(s => s.name);
  if (live.length) throw new Error(`The device backend (pid ${pid}) started without the saved iOS signing, and session(s) ${live.join(", ")} are still running. Close them, then retry.`);
  result(await run(process.execPath, [cli, "daemon", "stop", "--state-dir", state, "--json"]));
  return { restarted: true, pid };
}

// agent-device builds its runner for a generic iOS destination, which never adds a
// new phone to the signing team. One build aimed at the phone registers it; the
// backend's cached runner builds are then dropped so it re-signs with that profile.
export async function registerIphone(args, { io = fs, run = execute, home = homedir(), scratch = tmpdir() } = {}) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--device", "--team", "--bundle"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("ios-register --device <udid> [--team <team-id> --bundle <runner-bundle-id>]");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.device) throw new Error("ios-register requires --device. Run devices to list exact IDs.");
  if (options.team || options.bundle) {
    let saved = {};
    try { saved = JSON.parse(await io.readFile(signingPath(root), "utf8")); } catch {}
    const config = { ...saved, ...(options.team && { teamId: options.team }), ...(options.bundle && { bundleId: options.bundle }) };
    const checked = signingVars(config);
    if (!checked.AGENT_DEVICE_IOS_TEAM_ID || !checked.AGENT_DEVICE_IOS_BUNDLE_ID) throw new Error("Pass both --team and --bundle the first time.");
    await io.mkdir(join(root, "device-tools"), { recursive: true });
    await io.writeFile(`${signingPath(root)}.next`, JSON.stringify(config, null, 2) + "\n");
    await io.rename(`${signingPath(root)}.next`, signingPath(root));
  }
  const vars = await readSigning(io, root);
  const team = vars.AGENT_DEVICE_IOS_TEAM_ID, bundle = vars.AGENT_DEVICE_IOS_BUNDLE_ID;
  if (!team || !bundle) throw new Error(`Save teamId and bundleId first: ios-register --device ${options.device} --team <team-id> --bundle <runner-bundle-id> (writes ${signingPath(root)}).`);
  const listed = await run("xcrun", ["devicectl", "list", "devices"]);
  if (listed.code !== 0 || !listed.stdout.includes(options.device)) throw new Error(`Xcode does not list ${options.device}. Connect it over USB, trust this Mac, and enable Developer Mode.`);
  const project = join(root, "device-tools/node_modules/agent-device/dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj");
  const derived = join(scratch, `herdr-ios-register-${randomUUID()}`);
  const build = await run("xcodebuild", ["build-for-testing", "-project", project, "-scheme", "AgentDeviceRunner", "-destination", `id=${options.device}`, "-derivedDataPath", derived,
    "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration", "CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${team}`,
    `AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=${bundle}`, `AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=${bundle}.uitests`], { timeout: 600000 });
  await io.rm(derived, { recursive: true, force: true });
  if (build.code !== 0 || !build.stdout.includes("TEST BUILD SUCCEEDED")) {
    const errors = [...new Set(`${build.stdout}\n${build.stderr}`.split("\n").filter(line => line.includes("error:")).map(line => line.trim()))].slice(0, 8);
    throw new Error(["Runner build for the phone failed.", ...errors].join("\n"));
  }
  const caches = join(home, ".agent-device/apple-runner/derived/ios-device");
  let cleared = 0;
  for (const name of await io.readdir(caches).catch(() => [])) if (name.startsWith("cache-")) { await io.rm(join(caches, name), { recursive: true, force: true }); cleared++; }
  return { registered: true, device: options.device, team, bundleId: bundle, clearedCaches: cleared, next: "Close and open the device again so the backend picks up the new runner. If the phone reports an untrusted developer, trust it in Settings > General > VPN & Device Management." };
}

export async function commandLock(path, message, io = fs) {
  const create = async () => {
    // Publish a complete owner record atomically; SIGKILL cannot leave an empty lock.
    const candidate = io.link ? `${path}.owner-${process.pid}-${randomUUID()}` : path;
    const handle = await io.open(candidate, "wx");
    try {
      if (handle.writeFile) await handle.writeFile(JSON.stringify({ pid: process.pid }));
      if (io.link) await io.link(candidate, path);
      return handle;
    } catch (error) { await handle.close(); throw error; }
    finally { if (io.link) await io.unlink(candidate).catch(() => {}); }
  };
  const dead = async () => {
    let owner;
    try { owner = JSON.parse(await io.readFile(path, "utf8")); } catch { return false; }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 1) return false;
    try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  };
  try { return await create(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!await dead()) throw new Error(message);
  // Serialize stale recovery, then recheck: a second caller must never unlink
  // the first caller's newly acquired live lock.
  const recoveryPath = `${path}.recovery`;
  const recovery = await commandLock(recoveryPath, message, io);
  try {
    if (!await dead()) throw new Error(message);
    await io.unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    return await create();
  } finally { await recovery.close(); await io.unlink(recoveryPath); }
}

export async function drive(session, args, close = false, { io = fs, run = execute, prepare = ensureKeyboardPatch, keyInput = sendKey, simInput = simulatorInput, simInspect = simulatorInspect } = {}) {
  const dir = sessionDir(session);
  const options = close ? { command: [] } : runOptions(args);
  if (!close) actionArgs(options.command);
  // Agents sharing a panel must not interleave their input and screenshots.
  const lock = await commandLock(join(dir, "agent.lock"), "Another agent command holds this session. Wait for it to finish.", io);
  try {
    const connection = JSON.parse(await io.readFile(join(dir, "status.json"), "utf8"));
    if (close && !connection.opened && connection.status === "detached" && connection.device) {
      // A pane can close while its already-started CLI open is finishing.
      const active = result(await run(connection.node, [connection.cli, "session", "list", "--state-dir", connection.state, "--json"]));
      const found = active.sessions?.find(s => s.name === session && s.id === connection.device.id && s.platform === connection.device.platform);
      if (!found) {
        await io.writeFile(join(dir, "closed.json"), JSON.stringify({ session }));
        return { session, closed: true, alreadyClosed: true };
      }
      connection.opened = true;
    }
    if (!connection.opened || (close ? connection.status === "busy" : connection.status !== "ready")) throw new Error(connection.error || "The panel has no ready app session.");
    if (!close) await prepare(connection.cli);
    const flags = [...target(connection.device, session), "--state-dir", connection.state, "--json"];
    const localSimulator = connection.device.platform === "ios" && connection.device.kind === "simulator";
    const invoke = async argv => {
      if (localSimulator && !close) {
        const inspected = await simInspect(connection, argv, {toolsRoot: join(root, "device-tools"), dir, io});
        if (inspected !== undefined) return inspected;
      }
      if (localSimulator && !close) {
        // Backend-only operations still accept simulator refs, resolved to the
        // same explicit identity rather than a meaningless backend ref number.
        const resolved = [];
        for (const arg of argv) {
          if (!arg.startsWith("@")) { resolved.push(arg); continue; }
          const inspected = await simInspect(connection, ["get", "attrs", arg], {toolsRoot: join(root, "device-tools"), dir, io});
          if (!inspected) { resolved.push(arg); continue; }
          const {node} = inspected;
          if (!node.identifier && !node.label) throw new Error("This target has no backend selector; use native click/type.");
          resolved.push(node.identifier ? `id=${JSON.stringify(node.identifier)}` : `label=${JSON.stringify(node.label)} role=${node.type}`);
        }
        argv = resolved;
        if (!["get", "is", "wait", "appstate", "find"].includes(argv[0])) await io.unlink(join(dir, "simulator-frame.json")).catch(() => {});
      }
      return run(connection.node, [connection.cli, ...argv, ...flags]).then(result);
    };
    let history = {};
    try { history = JSON.parse(await io.readFile(join(dir, "visibility-history.json"), "utf8")); } catch {}
    if (!history || typeof history !== "object" || Array.isArray(history)) history = {};
    const annotate = data => annotateSnapshot(data, history);
    const dismiss = options.command[0] === "keyboard" && options.command[1] === "dismiss";
    const beforeDismiss = dismiss ? await invoke(["appstate"]) : null;
    let data, inputSnapshot, inputSnapshotError, attemptedInput = false;
    if (localSimulator && options.command[0] === "find") {
      const field = ["text", "label", "value", "role", "id"].includes(options.command[1]) ? options.command[1] : "label";
      const index = ["text", "label", "value", "role", "id"].includes(options.command[1]) ? 3 : 2;
      if (options.command[index] === "click") options.command = ["click", `${field === "text" ? "label" : field}=${JSON.stringify(options.command[index - 1])}`, ...options.command.slice(index + 1)];
    }
    const nativeInput = !close && connection.device.platform === "ios" && connection.device.kind === "simulator" && ["click", "press", "type"].includes(options.command[0]);
    if (nativeInput) {
      try { data = await simInput(connection, options.command, { toolsRoot: join(root, "device-tools"), invoke, signal: cancellation.signal, onInput: () => { attemptedInput = true; } }); }
      finally {
        if (attemptedInput) {
          try { inputSnapshot = await invoke(["snapshot", "-i"]); }
          catch (error) { inputSnapshotError = error.message; }
        }
      }
    }
    else if (options.command[0] === "alert") {
      const tree = await invoke(["snapshot", "-i", "--raw"]);
      const surface = shareSheet(tree);
      const action = options.command[1] || "get";
      if (surface && !["get", "status", "wait"].includes(action)) throw new Error("This is a share sheet/activity view, not an alert. Inspect snapshot and click its explicit @ref instead.");
      if (surface) data = surface;
      else {
        const measured = ["get", "status", "wait"].includes(action) ? await invoke(options.command) : await invoke(["alert", "get"]);
        const activity = shareSheet(tree, measured);
        if (activity && !["get", "status", "wait"].includes(action)) throw new Error("This is a share sheet/activity view, not an alert. Use its explicit @ref.");
        data = activity || (["get", "status", "wait"].includes(action) ? measured : await invoke(options.command));
      }
    } else data = options.command[0] === "key" ? await keyInput(connection, options.command[1], { toolsRoot: join(root, "device-tools"), execute: run }) : await invoke(close ? ["close"] : options.command);
    let dismissCheck;
    if (dismiss) {
      const after = await invoke(["appstate"]);
      dismissCheck = { before: beforeDismiss, after, foregroundChanged: beforeDismiss.appBundleId !== after.appBundleId || beforeDismiss.state === "runningForeground" && after.state !== "runningForeground" };
    }
    if (close) {
      await io.writeFile(join(dir, "closed.json"), JSON.stringify({ session }));
      return { session, closed: true, result: data };
    }
    await invoke(["screenshot", join(dir, "screen-next.png")]);
    await io.rename(join(dir, "screen-next.png"), join(dir, "screen.png"));
    const revision = randomUUID();
    await io.writeFile(join(dir, "preview-next.json"), JSON.stringify({ revision }));
    await io.rename(join(dir, "preview-next.json"), join(dir, "preview.json"));
    let snapshot, snapshotError;
    // HID/ADB input bypasses the backend's mutation journal. Always advance its
    // ref generation after these keys so old refs cannot silently remain valid.
    if (options.snapshot && options.command[0] !== "snapshot" || options.command[0] === "key" || nativeInput) {
      try {
        if (nativeInput && inputSnapshotError) throw new Error(inputSnapshotError);
        snapshot = annotate(nativeInput ? inputSnapshot : await invoke(["snapshot", "-i"]));
      } catch (error) { snapshotError = error.message; }
    }
    const output = { session, result: options.command[0] === "snapshot" ? annotate(data) : data, preview: join(dir, "screen.png"), previewRevision: revision };
    if (options.snapshot && snapshot) {
      if (options.compact) { output.snapshotText = compactSnapshot(snapshot); output.snapshotRefsGeneration = snapshot.refsGeneration; }
      else output.snapshot = snapshot;
    }
    if (snapshotError) output.snapshotError = snapshotError;
    if (dismissCheck) output.dismissCheck = dismissCheck;
    if (options.compact && options.command[0] === "snapshot") output.compact = compactSnapshot(output.result);
    if (options.command[0] === "snapshot" || snapshot) {
      await io.writeFile(join(dir, "visibility-history-next.json"), JSON.stringify(Object.fromEntries(Object.entries(history).slice(-512))));
      await io.rename(join(dir, "visibility-history-next.json"), join(dir, "visibility-history.json"));
    }
    return output;
  } finally {
    await lock.close();
    await io.unlink(join(dir, "agent.lock"));
  }
}

export async function main(args) {
  if (["--help", "-h", "help"].includes(args[0])) return { help: HELP };
  if (args[0] === "show") {
    await appCommand("layout.select", { stack: "panel-body", child: "devices" });
    await appCommand("layout.show", { id: "panel" });
    return { global: true };
  }
  if (args[1] === "current" || args[0] === "status" && !args[1]) {
    let current;
    try { current = JSON.parse(await fs.readFile(join(root, "device-global/status.json"), "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      current = { global: true, opened: false, status: "disconnected" };
    }
    if (args[0] === "status") return current;
    if (!current.opened) throw new Error("No shared device is connected. Open the global Devices panel first.");
    args = [args[0], current.session, ...args.slice(2)];
  }
  if (args[0] === "devices") return { devices: await devices() };
  if (args[0] === "ios-register") return registerIphone(args.slice(1));
  if (args[0] === "open") return openPanel(args.slice(1));
  if (args[0] === "run" && args[1]) return drive(args[1], args.slice(2));
  if (args[0] === "close" && args[1]) return drive(args[1], [], true);
  if (args[0] === "status" && args[1]) return readStatus(args[1]);
  throw new Error("Usage: agent.mjs show | devices | ios-register --device UDID | open --device ID [--app APP] | run current|SESSION <command> [args] | status [SESSION] | close current|SESSION. Run --help for details.");
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const stopWatching = watchCaller();
  main(process.argv.slice(2)).finally(stopWatching).then(data => console.log(data.help ?? data.compact ?? JSON.stringify({ success: true, data }, null, 2))).catch(error => {
    console.error(JSON.stringify({ success: false, error: { message: error.message } }));
    process.exitCode = 1;
  });
}

// Agent entry point: connect through Herdr's global Devices panel, then use its shared session.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chooseDevice, mobileDevices, result, target, VERSION } from "./device.js";
import { runOptions, annotateSnapshot, compactSnapshot, sendKey, shareSheet } from "./interaction.mjs";
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

export async function execute(command, args) {
  const env = { ...process.env, PATH: `${resolve(process.execPath, "..")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
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

export async function openGlobal(device, appId, { io = fs, command = appCommand, pause = delay, timeout = 600000 } = {}) {
  const directory = join(root, "device-global");
  await io.mkdir(directory, { recursive: true });
  const lock = await io.open(join(directory, "open.lock"), "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error("Another shared-device connection is in progress.");
    throw error;
  });
  let sessionLock, sessionLockPath;
  try {
    let existing;
    try { existing = JSON.parse(await io.readFile(join(directory, "status.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing?.session) {
      sessionLockPath = join(sessionDir(existing.session), "agent.lock");
      sessionLock = await io.open(sessionLockPath, "wx").catch(error => {
        if (error.code === "EEXIST") throw new Error("Another agent command holds the shared device. Wait for it to finish.");
        throw error;
      });
    }
    const id = randomUUID();
    await io.writeFile(join(directory, "request-next.json"), JSON.stringify({ id, node: process.execPath, device: device.id, platform: device.platform, app: appId }));
    await io.rename(join(directory, "request-next.json"), join(directory, "request.json"));
    await command("layout.select", { stack: "panel-body", child: "devices" });
    await command("layout.show", { id: "panel" });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
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

export async function drive(session, args, close = false, { io = fs, run = execute, prepare = ensureKeyboardPatch, keyInput = sendKey } = {}) {
  const dir = sessionDir(session);
  const options = close ? { command: [] } : runOptions(args);
  if (!close) actionArgs(options.command);
  // Agents sharing a panel must not interleave their input and screenshots.
  const lock = await io.open(join(dir, "agent.lock"), "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error("Another agent command holds this session. Wait for it to finish.");
    throw error;
  });
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
    const invoke = argv => run(connection.node, [connection.cli, ...argv, ...flags]).then(result);
    let history = {};
    try { history = JSON.parse(await io.readFile(join(dir, "visibility-history.json"), "utf8")); } catch {}
    if (!history || typeof history !== "object" || Array.isArray(history)) history = {};
    const annotate = data => annotateSnapshot(data, history);
    const dismiss = options.command[0] === "keyboard" && options.command[1] === "dismiss";
    const beforeDismiss = dismiss ? await invoke(["appstate"]) : null;
    let data;
    if (options.command[0] === "alert") {
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
    if (options.snapshot && options.command[0] !== "snapshot" || options.command[0] === "key") {
      try { snapshot = annotate(await invoke(["snapshot", "-i"])); }
      catch (error) { snapshotError = error.message; }
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
  if (args[0] === "open") return openPanel(args.slice(1));
  if (args[0] === "run" && args[1]) return drive(args[1], args.slice(2));
  if (args[0] === "close" && args[1]) return drive(args[1], [], true);
  if (args[0] === "status" && args[1]) return readStatus(args[1]);
  throw new Error("Usage: agent.mjs show | devices | open --device ID [--app APP] | run current|SESSION <command> [args] | status [SESSION] | close current|SESSION. Run --help for details.");
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(data => console.log(data.help ?? data.compact ?? JSON.stringify({ success: true, data }, null, 2))).catch(error => {
    console.error(JSON.stringify({ success: false, error: { message: error.message } }));
    process.exitCode = 1;
  });
}

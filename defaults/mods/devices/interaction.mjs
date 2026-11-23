// Input and snapshot presentation stay independent of the pane and CLI transport.
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

export function keyName(value) {
  const key = String(value).toLowerCase();
  const keys = { enter: "enter", return: "enter", backspace: "backspace", delete: "backspace", tab: "tab" };
  return Object.hasOwn(keys, key) ? keys[key] : null;
}

export function runOptions(args) {
  const compact = args.includes("--compact"), snapshot = args.includes("--snapshot");
  const command = args.filter(arg => !["--compact", "--snapshot"].includes(arg));
  if (compact && command[0] !== "snapshot" && !snapshot) throw new Error("--compact requires snapshot or an action with --snapshot.");
  if (command[0] === "find") {
    const action = ["text", "label", "value", "role", "id"].includes(command[1]) ? 3 : 2;
    // The backend defaults find to click. A lookup must never silently tap.
    if (!command[action] || command[action].startsWith("-")) command.splice(action, 0, "get", "attrs");
  }
  if (command[0] === "key" || command[0] === "press" && command.length === 2 && keyName(command[1]) || command[0] === "keyboard" && ["backspace", "tab"].includes(command[1])) {
    const key = keyName(command[1]);
    if (!key || command.length !== 2) throw new Error("key requires enter/return, backspace/delete, or tab.");
    return { command: ["key", key], compact, snapshot };
  }
  return { command, compact, snapshot };
}

const validRect = r => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 0 && r.height >= 0;
function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

export function annotateSnapshot(data, history = {}) {
  if (!Array.isArray(data?.nodes)) return data;
  const nodes = new Map(data.nodes.map(n => [n.index, n]));
  const measuredViewport = data.viewport && { x: 0, y: 0, ...data.viewport };
  const viewport = validRect(measuredViewport) ? measuredViewport : data.nodes.find(n => /^(application|window)$/i.test(n.type || "") && validRect(n.rect))?.rect;
  const key = n => JSON.stringify([data.appBundleId || data.appName, viewport?.width, viewport?.height, n.type, n.role, n.identifier || n.label || ""]);
  const counts = new Map();
  for (const n of data.nodes) counts.set(key(n), (counts.get(key(n)) || 0) + 1);
  const explicitHidden = n => n.hidden === true || n.visible === false && n.visibilitySource !== "accessibility-and-geometry";
  return { ...data, nodes: data.nodes.map(node => {
    let frame = validRect(node.rect) ? node.rect : null;
    if (frame && viewport) frame = intersection(frame, viewport);
    const visited = new Set([node.index]);
    let parent = nodes.get(node.parentIndex), hidden = explicitHidden(node);
    while (parent && !visited.has(parent.index)) {
      visited.add(parent.index);
      hidden ||= explicitHidden(parent);
      if (frame && validRect(parent.rect) && /scroll|collection|table|window|application/i.test(parent.type || "")) frame = intersection(frame, parent.rect);
      parent = nodes.get(parent.parentIndex);
    }
    const offscreen = frame && viewport ? frame.width <= 0 || frame.height <= 0 : null;
    const viewportContainer = node.type === "Other" && viewport && node.rect && ["x", "y", "width", "height"].every(k => Math.abs(node.rect[k] - viewport[k]) < 0.5);
    const unique = counts.get(key(node)) === 1 && Boolean(node.identifier || node.label);
    const touchesEdge = viewport && frame && (Math.abs(frame.x - viewport.x) < 0.5 || Math.abs(frame.y - viewport.y) < 0.5 || Math.abs(frame.x + frame.width - viewport.x - viewport.width) < 0.5 || Math.abs(frame.y + frame.height - viewport.y - viewport.height) < 0.5);
    let reference = validRect(node.unclippedRect) ? node.unclippedRect : unique ? history[key(node)] : null;
    if (unique && !viewportContainer && !hidden && frame && !touchesEdge && Math.abs(frame.width - node.rect.width) < 0.5 && Math.abs(frame.height - node.rect.height) < 0.5 && (!reference || frame.width * frame.height > reference.width * reference.height)) {
      reference = { width: frame.width, height: frame.height };
      history[key(node)] = reference;
    }
    // Backends can already clip AX rectangles. A previously observed full size
    // is evidence; a sibling's size is not. Never invent the missing fraction.
    const clippedHere = frame && node.rect && (frame.width < node.rect.width - 0.5 || frame.height < node.rect.height - 0.5);
    const area = reference ? reference.width * reference.height : node.rect && (!touchesEdge || clippedHere) ? node.rect.width * node.rect.height : null;
    const fraction = offscreen === true ? 0 : frame && area > 0 && !viewportContainer ? Math.min(1, frame.width * frame.height / area) : null;
    const visible = viewportContainer ? null : hidden ? false : offscreen === null ? null : !offscreen;
    return { ...node, visible, offscreen, visibleRect: frame, visibleFraction: fraction,
      visibility: hidden ? "hidden" : offscreen ? "offscreen" : viewportContainer || offscreen === null ? "unknown" : fraction !== null && fraction < 0.5 ? "partial" : "visible",
      ...(viewportContainer ? { geometry: "viewport-container" } : {}), visibilitySource: "accessibility-and-geometry" };
  }) };
}

export function compactSnapshot(data) {
  return (data.nodes || []).map(n => {
    const ref = n.ref ? `@${n.ref.replace(/^@/, "")}` : "-";
    const label = String(n.label || n.value || n.identifier || "").replace(/\s+/g, " ").trim();
    const fraction = n.visibleFraction !== null && n.visibleFraction !== undefined && n.visibility === "partial" ? ` ${(n.visibleFraction * 100).toFixed(1)}%` : "";
    return `${ref} ${n.type || n.kind || "unknown"} ${label} [${n.visibility || "unknown"}${fraction}]`;
  }).join("\n");
}

export function shareSheet(snapshot, alert = {}) {
  const nodes = snapshot?.nodes || [];
  const explicit = nodes.some(n => /UIActivity(?:View|Content|Group|List|Action)|_UIActivity/.test(`${n.role || ""} ${n.identifier || ""}`));
  const items = alert?.items || alert?.buttons || [];
  const labels = new Set([...nodes.filter(n => /button|cell/i.test(n.type || "")).map(n => n.label), ...(Array.isArray(items) ? items : []).map(n => typeof n === "string" ? n : n.label)]);
  const possible = labels.has("Save to Files") && (labels.has("Copy") || labels.has("More"));
  return explicit || possible ? { kind: "share-sheet", present: false, items: [...labels].filter(Boolean), source: explicit ? "activity-view" : "activity-controls", confidence: explicit ? "class" : "heuristic" } : null;
}

export async function sendKey(connection, key, { toolsRoot, execute, loadNative = path => createRequire(import.meta.url)(path), platform = process.platform } = {}) {
  key = keyName(key);
  if (!key) throw new Error("Unsupported key. Use enter/return, backspace/delete, or tab.");
  const device = connection.device;
  if (device.platform === "ios" && device.kind === "simulator" && platform === "darwin") {
    const native = loadNative(join(toolsRoot, "node_modules/expo-device-hub/vendor/serve-sim/dist/native/serve-sim-native.node"));
    const hid = new native.SimHID(device.id);
    if (await hid.setScreen(0) === false) throw new Error("Simulator keyboard input is unavailable.");
    const usage = { enter: 40, backspace: 42, tab: 43 }[key];
    try { await hid.key("down", usage); } finally { await hid.key("up", usage); }
    return { key, transport: "simulator-hid" };
  }
  if (device.platform === "android") {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), "Library/Android/sdk");
    const result = await execute(join(sdk, "platform-tools", platform === "win32" ? "adb.exe" : "adb"), ["-s", device.id, "shell", "input", "keyevent", String({ enter: 66, backspace: 67, tab: 61 }[key])]);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Android key input failed.");
    return { key, transport: "android-keyevent" };
  }
  throw new Error("These hardware keys require a local iOS simulator on macOS or Android device. On a physical iPhone use keyboard enter, or tap its own delete/Next key from a fresh snapshot.");
}

// The same normalized CoreSimulator HID path used by expo-device-hub's viewer.
// Resolve refs through the backend first: stale refs must fail before any input.
export async function simulatorInput(connection, command, { toolsRoot, invoke, loadNative = path => createRequire(import.meta.url)(path), pause = ms => new Promise(resolve => setTimeout(resolve, ms)), signal, onInput = () => {} } = {}) {
  signal?.throwIfAborted();
  const native = loadNative(join(toolsRoot, "node_modules/expo-device-hub/vendor/serve-sim/dist/native/serve-sim-native.node"));
  const hid = new native.SimHID(connection.device.id);
  if (await hid.setScreen(0) === false) throw new Error("Simulator input is unavailable.");
  const [action, ...args] = command;
  if (action === "type") {
    if (args.length !== 1) throw new Error("Simulator type requires one text argument.");
    for (const character of args[0]) {
      signal?.throwIfAborted();
      onInput();
      if (!await native.axTypeKeyboardCharacter(connection.device.id, character)) throw new Error("Simulator keyboard did not accept text; focus an editable field first.");
    }
  } else {
    if (args.some(arg => arg.startsWith("--"))) throw new Error("Simulator taps accept a ref, selector or x y without backend flags.");
    const tree = JSON.parse(await native.axDescribe(connection.device.id));
    const viewport = tree[0]?.frame;
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) throw new Error("Simulator screen bounds are unavailable.");
    let x, y, targetNode;
    if (args.length === 2 && args.every(arg => /^\d+(?:\.\d+)?$/.test(arg))) [x, y] = args.map(Number);
    else {
      if (args.length !== 1) throw new Error("Simulator tap requires one ref/selector or x y.");
      const found = await invoke(["get", "attrs", args[0]]);
      const node = found.node;
      targetNode = node;
      if (!node?.rect || node.enabled === false || node.visible === false || node.hittable === false || node.rect.width <= 0 || node.rect.height <= 0) throw new Error("Target is not hittable. Inspect a fresh snapshot.");
      const rect = node.visibleRect || node.rect;
      x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
    }
    const keyboards = [];
    const inspectKeyboard = entry => {
      if (/^keyboard$/i.test(entry.type || "") || /^keyboard$/i.test(entry.role_description || "")) keyboards.push(entry.frame);
      for (const child of entry.children || []) inspectKeyboard(child);
    };
    tree.forEach(inspectKeyboard);
    if (targetNode && !targetNode.keyboardOwned && keyboards.some(rect => rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)) throw new Error("Target is behind the keyboard. Use the keyboard's own controls first.");
    x = (x - viewport.x) / viewport.width; y = (y - viewport.y) / viewport.height;
    if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Target is outside the simulator screen.");
    signal?.throwIfAborted();
    onInput();
    try { await hid.touch("begin", x, y, viewport.width, viewport.height, 0); await pause(50); }
    finally { await hid.touch("end", x, y, viewport.width, viewport.height, 0); }
  }
  await pause(150);
  return { transport: "simulator-hid", action };
}


// One owner per live capture. Starting/stopping a second native capture for
// every agent screenshot can interrupt that owner's encoder/framebuffer.
async function sharedScreenshot(connection, path, { toolsRoot, io, request }) {
  const directory = join(toolsRoot, "live");
  const files = io.readdir ? await io.readdir(directory).catch(() => []) : [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let owner;
    try {
      owner = JSON.parse(await io.readFile(join(directory, file), "utf8"));
      if (owner.device !== connection.device.id || owner.platform !== "ios" || !Number.isInteger(owner.pid) || owner.pid <= 1 || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(owner.url)) continue;
      process.kill(owner.pid, 0);
    } catch { continue; }
    let health;
    try { health = await request(`${owner.url}_herdr/stream-health`, { signal: AbortSignal.timeout(1500) }).then(response => response.json()); }
    catch (error) {
      if (error.cause?.code === "ECONNREFUSED") continue;
      throw new Error("The live capture owner is not responding. Inspect state before repeating input.");
    }
    if (health.device !== owner.device || health.platform !== owner.platform) continue;
    const response = await request(`${owner.url}vendor/serve-sim/api/screenshot?device=${encodeURIComponent(owner.device)}&format=png`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(8000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || bytes.length < 8 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)) throw new Error("Live capture is reconnecting. Inspect fresh state before repeating input.");
    await io.writeFile(path, bytes);
    return { path, transport: "shared-simulator-capture" };
  }
  return null;
}

// Keep simulator inspection on the viewer's native provider as well: agent-device
// can fall back to XCTest even for a read, which otherwise stalls --snapshot taps.
export async function simulatorInspect(connection, command, { toolsRoot, dir, io, request = fetch, loadNative = path => createRequire(import.meta.url)(path) } = {}) {
  const [action, field, selector] = command;
  if (action === "find") {
    const explicitField = ["text", "label", "value", "role", "id"].includes(field);
    const key = explicitField ? field === "text" ? "label" : field : "label";
    const value = explicitField ? selector : field;
    const tail = command.slice(explicitField ? 3 : 2);
    if (tail[0] !== "get") return undefined;
    return simulatorInspect(connection, ["get", tail[1] || "attrs", `${key}=${JSON.stringify(value)}`], {toolsRoot, dir, io, loadNative});
  }
  if (!["snapshot", "get", "screenshot"].includes(action)) return undefined;
  const native = loadNative(join(toolsRoot, "node_modules/expo-device-hub/vendor/serve-sim/dist/native/serve-sim-native.node"));
  const path = join(dir, "simulator-frame.json");
  if (action === "screenshot") {
    const shared = await sharedScreenshot(connection, field, {toolsRoot, io, request});
    if (shared) return shared;
    const capture = new native.SimCapture(connection.device.id, 10, 0.8, 0, 30, 8000000, 0);
    try {
      await capture.start();
      const bytes = await capture.screenshot(await capture.activeScreenId(), 0);
      await io.writeFile(field, bytes);
    } finally { await capture.stop(); }
    return { path: field, transport: "simulator-capture" };
  }
  if (action === "get") {
    if (!["attrs", "text", "value"].includes(field)) return undefined;
    const frame = JSON.parse(await io.readFile(path, "utf8").catch(() => "null"));
    if (!frame) throw new Error("Inspect a fresh simulator snapshot before resolving a target.");
    let nodes;
    if (selector?.startsWith("@")) nodes = frame.nodes.filter(node => node.ref === selector.slice(1));
    else {
      const terms = [...(selector || "").matchAll(/(label|id|role|value|visible)=(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+))/g)];
      if (!terms.length) throw new Error("Use a ref or label/id/role/value selector from a fresh snapshot.");
      nodes = frame.nodes.filter(node => terms.every(([, key, quoted, single, plain]) => {
        const value = quoted !== undefined ? JSON.parse(`"${quoted}"`) : single ?? plain;
        return String(key === "id" ? node.identifier : key === "role" ? node.type : node[key]).toLowerCase() === value.toLowerCase();
      }));
    }
    if (nodes.length !== 1) throw new Error(nodes.length ? "Selector is ambiguous; use a fresh @ref." : "Ref belongs to an expired ref frame or target is absent; inspect a fresh snapshot.");
    const node = nodes[0];
    return field === "attrs" ? { ref: node.ref, node } : { [field]: field === "text" ? node.label ?? node.value ?? "" : node.value ?? "" };
  }
  const tree = JSON.parse(await native.axDescribe(connection.device.id));
  const generation = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
  const nodes = [];
  const visit = (entry, parentIndex, depth, keyboardOwned = false) => {
    keyboardOwned ||= /keyboard|UIKB|UIInputSet|TUI/i.test(`${entry.type || ""} ${entry.role_description || ""}`);
    const index = nodes.length;
    const type = { GenericElement: "Other", ScrollArea: "ScrollView" }[entry.type] || entry.type || "Other";
    nodes.push({ index, ...(parentIndex === null ? {} : { parentIndex }), depth, type, role: entry.role_description,
      label: entry.AXLabel ?? "", value: entry.AXValue, identifier: entry.AXUniqueId,
      enabled: entry.enabled, keyboardOwned, rect: entry.frame, ref: `e${generation}_${index + 1}` });
    for (const child of entry.children || []) visit(child, index, depth + 1, keyboardOwned);
  };
  for (const entry of tree) visit(entry, null, 0);
  const frame = { nodes, viewport: tree[0]?.frame, refsGeneration: generation, source: "simulator-ax", appBundleId: connection.app };
  const presented = annotateSnapshot(frame);
  await io.writeFile(`${path}.next`, JSON.stringify(presented)); await io.rename(`${path}.next`, path);
  const depthIndex = command.findIndex(arg => arg === "-d" || arg === "--depth");
  if (depthIndex >= 0) frame.nodes = nodes.filter(node => node.depth <= Number(command[depthIndex + 1]));
  const scopeIndex = command.findIndex(arg => arg === "-s" || arg === "--scope");
  if (scopeIndex >= 0) {
    const {node} = await simulatorInspect(connection, ["get", "attrs", command[scopeIndex + 1]], {toolsRoot, dir, io, loadNative});
    const included = new Set([node.index]);
    frame.nodes = frame.nodes.filter(entry => { if (included.has(entry.parentIndex)) included.add(entry.index); return included.has(entry.index); });
  }
  return frame;
}

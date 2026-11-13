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

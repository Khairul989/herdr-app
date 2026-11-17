// Keep the CLI contract separate from rendering so target and failure handling can be checked.
export const VERSION = "0.21.36";
export const LIVE_VERSION = "0.23.1";

export function chooseDevice(devices, id, platform) {
  const matches = devices.filter(d => d.id === id && (!platform || d.platform === platform));
  if (matches.length !== 1) throw new Error("Device ID must match exactly one local mobile device. List devices first.");
  return matches[0];
}

// Physical iPhones run agent-device's XCTest runner, signed by the person's own team.
// The backend daemon reads these variables from its own environment, fixed by
// whichever process starts it, so every launch path passes the saved settings.
export const SIGNING_ENV = { teamId: "AGENT_DEVICE_IOS_TEAM_ID", bundleId: "AGENT_DEVICE_IOS_BUNDLE_ID", signingIdentity: "AGENT_DEVICE_IOS_SIGNING_IDENTITY", provisioningProfile: "AGENT_DEVICE_IOS_PROVISIONING_PROFILE" };
export const signingPath = root => `${root}/device-tools/ios-signing.json`;
const SIGNING_HINT = "Physical iPhone signing: save teamId and bundleId in device-tools/ios-signing.json in the Herdr app folder, then run agent.mjs ios-register --device UDID, then close and open the device again. See the Devices section of AGENTS.md.";

export function signingVars(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("ios-signing.json must hold a JSON object.");
  const vars = {};
  for (const [key, name] of Object.entries(SIGNING_ENV)) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || /[\0-\x1f]/.test(value)) throw new Error(`ios-signing.json: ${key} must be a single-line string.`);
    vars[name] = value;
  }
  if (vars.AGENT_DEVICE_IOS_TEAM_ID && !/^[A-Z0-9]{10}$/.test(vars.AGENT_DEVICE_IOS_TEAM_ID)) throw new Error("ios-signing.json: teamId must be a 10-character Apple team ID.");
  if (vars.AGENT_DEVICE_IOS_BUNDLE_ID && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(vars.AGENT_DEVICE_IOS_BUNDLE_ID)) throw new Error("ios-signing.json: bundleId must be reverse-DNS, e.g. com.yourname.agentdevice.runner.");
  return vars;
}

// A missing or unreadable file means no saved signing: commands run exactly as before.
export async function readSigning(fs, root) {
  let text;
  try { text = await fs.readFile(signingPath(root), "utf8"); } catch { return {}; }
  let config;
  try { config = JSON.parse(text); } catch { throw new Error(`${signingPath(root)} is not valid JSON.`); }
  return signingVars(config);
}

// The saved file wins over inherited variables on every launch path, so the panel and
// the helper always start the daemon alike. Without saved settings the command and
// argv are returned unchanged; never through a shell.
export function withSigning(command, args, vars) {
  const entries = Object.entries(vars);
  return entries.length ? ["/usr/bin/env", [...entries.map(([name, value]) => `${name}=${value}`), command, ...args]] : [command, args];
}

export function result(r) {
  let reply;
  try { reply = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || reply?.success !== true) {
    const error = reply?.error;
    const message = [error?.message || r.stderr?.trim() || r.stdout?.trim() || "Device command failed.", error?.details?.hint || error?.hint].filter(Boolean).join("\n");
    const signing = /No Account for Team|valid iOS provisioning profile|0xe8008012|profile does not cover/i.test(message);
    throw new Error(signing ? `${message}\n${SIGNING_HINT}` : message);
  }
  return reply.data;
}

export function mobileDevices(data) {
  if (!Array.isArray(data?.devices)) throw new Error("Device tools returned no device list.");
  return data.devices.filter(d => ["ios", "android"].includes(d.platform) && d.target === "mobile" && typeof d.id === "string" && d.id && typeof d.name === "string");
}

export function target(device, session) {
  if (!device || !["ios", "android"].includes(device.platform) || !device.id) throw new Error("Choose a mobile device first.");
  const selector = device.platform === "ios" ? "--udid" : device.kind === "emulator" && device.booted === false ? "--device" : "--serial";
  return ["--platform", device.platform, selector, device.id, "--session", session];
}

export function pngSize(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((n, i) => bytes[i] !== n)) throw new Error("The device did not return a PNG screenshot.");
  const uint = at => bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
  const width = uint(16), height = uint(20);
  if (!width || !height || width > 32768 || height > 32768) throw new Error("Invalid screenshot dimensions.");
  return { width, height };
}

export const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";

export class DeviceSession {
  constructor({ exec, fs, root, session, node = "node", npm = "npm", cli }) {
    Object.assign(this, { exec, fs, root, session, node, npm });
    this.cli = cli || `${root}/device-tools/node_modules/agent-device/bin/agent-device.mjs`;
    this.customCli = Boolean(cli);
    this.state = `${root}/device-tools/state`;
    this.device = null;
    this.opened = false;
    this.pending = false;
    this.frame = null;
    this.captureKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sequence = 0;
  }

  async exclusive(work) {
    if (this.pending) throw new Error("Wait for the current device command to finish.");
    this.pending = true;
    try { return await work(); } finally { this.pending = false; }
  }

  async call(args, scoped = true) {
    const flags = scoped ? target(this.device, this.session) : [];
    // The panel's exec has no env option, and Herdr's own environment rarely holds these.
    const [command, argv] = withSigning(this.node, [this.cli, ...args, ...flags, "--state-dir", this.state, "--json"], await readSigning(this.fs, this.root));
    return result(await this.exec(command, argv, { timeout: 600000 }));
  }

  async install() {
    await this.fs.mkdir(`${this.root}/device-tools`, { recursive: true });
    const r = await this.exec(this.npm, ["install", "--prefix", `${this.root}/device-tools`, "--no-audit", "--no-fund", "--save-exact", `agent-device@${VERSION}`, `expo-device-hub@${LIVE_VERSION}`], { timeout: 600000 });
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Could not install device tools.");
    return this.list();
  }

  async list() {
    const r = await this.exec(this.node, [this.cli, "--version"], { timeout: 30000 });
    if (r.code !== 0 || r.stdout.trim() !== VERSION) throw new Error(`Device tools ${VERSION} are required. Install tools below, or check the node and cli paths in this tab's props.`);
    return mobileDevices(await this.call(["devices"], false));
  }

  async ensureLiveTools() {
    try {
      const metadata = JSON.parse(await this.fs.readFile(`${this.root}/device-tools/node_modules/expo-device-hub/package.json`, "utf8"));
      if (metadata.version === LIVE_VERSION) return;
    } catch {}
    const r = await this.exec(this.npm, ["install", "--prefix", `${this.root}/device-tools`, "--no-audit", "--no-fund", "--save-exact", `expo-device-hub@${LIVE_VERSION}`], { timeout: 600000 });
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Could not install live device viewer.");
  }

  select(device) {
    if (this.pending || this.opened) throw new Error("Close the app session before changing devices.");
    target(device, this.session);
    this.device = device;
    this.frame = null;
  }

  async open(app) {
    if (this.opened) throw new Error("Close the current app session first.");
    if (!app.trim() || app.trim().startsWith("-")) throw new Error("Enter the installed app's bundle ID or package name.");
    await this.bootInBackground();
    // Cold simulator boots can exceed the CLI's default request budget.
    const opened = await this.call(["open", app.trim(), "--timeout", "540000"]);
    // An Android AVD name becomes a serial after boot. Subsequent input targets that serial.
    if (typeof opened?.id === "string" && opened.id) this.device = { ...this.device, id: opened.id, booted: true };
    // Keep the claim visible even if the following screenshot fails.
    this.opened = true;
    return this.capture();
  }

  async openDevice() {
    if (this.opened) throw new Error("Disconnect the current device first.");
    await this.bootInBackground();
    const opened = await this.call(["open", "--timeout", "540000"]);
    if (typeof opened?.id === "string" && opened.id) this.device = { ...this.device, id: opened.id, booted: true };
    this.opened = true;
    return this.capture();
  }

  async bootInBackground() {
    if (this.device?.platform !== "android" || this.device.kind !== "emulator" || this.device.booted !== false) return;
    // Boot owns the headless option; open would otherwise start a GUI emulator.
    const booted = await this.call(["boot", "--headless", "--timeout", "540000"]);
    if (typeof booted?.id !== "string" || !booted.id) throw new Error("Android boot returned no device serial. Find devices again before connecting.");
    this.device = { ...this.device, id: booted.id, booted: true };
  }

  async connect(devices, id, platform, app) {
    const device = chooseDevice(devices, id, platform);
    if (this.opened) {
      if (this.device.id !== device.id || this.device.platform !== device.platform) throw new Error("Close the current app session before opening another device.");
      return this.capture();
    }
    this.device = device;
    return app?.trim() ? this.open(app) : this.openDevice();
  }

  async capture() {
    this.requireOpen();
    const relative = `device-previews/${this.session}/frame-${this.captureKey}-${++this.sequence}.png`;
    await this.fs.mkdir(`${this.root}/device-previews/${this.session}`, { recursive: true });
    try {
      await this.call(["screenshot", `${this.root}/${relative}`]);
      const size = pngSize(await this.fs.readFile(`${this.root}/${relative}`));
      const previous = this.frame;
      this.frame = { path: relative, ...size, capturedAt: new Date().toLocaleTimeString() };
      // New paths avoid cached images, including after a reload. Remove the preceding capture.
      if (previous) await this.fs.unlink(`${this.root}/${previous.path}`).catch(() => {});
      return this.frame;
    } catch (error) {
      await this.fs.unlink(`${this.root}/${relative}`).catch(() => {});
      throw error;
    }
  }

  requireOpen() {
    if (!this.opened) throw new Error("Open an app session first.");
  }

  async act(command, value) {
    this.requireOpen();
    if (command === "click") {
      if (!value.trim() || value.trim().startsWith("-")) throw new Error("Enter a ref or selector from a fresh UI snapshot.");
      const coordinates = value.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
      await this.call(coordinates ? ["click", coordinates[1], coordinates[2]] : ["click", value.trim()]);
    } else if (command === "type") {
      if (!value || value.startsWith("-")) throw new Error("Enter text that does not start with a dash.");
      await this.call(["type", value]);
    } else if (command === "up" || command === "down") {
      await this.call(["scroll", command, "0.5"]);
    } else if (command === "back") await this.call(["back", "--system"]);
    else throw new Error("Unknown device action.");
    return this.capture();
  }

  async snapshot() {
    this.requireOpen();
    return this.call(["snapshot", "-i"]);
  }

  async restore(devices) {
    const data = await this.call(["session", "list"], false);
    if (!Array.isArray(data?.sessions)) throw new Error("Device tools returned no session list.");
    const saved = data.sessions.find(s => s.name === this.session);
    if (!saved) { this.opened = false; this.frame = null; return; }
    // Discovery can briefly omit a busy emulator. Retain only this already-bound
    // target; the next scoped capture checks whether it is actually reachable.
    const device = devices.find(d => d.id === saved.id && d.platform === saved.platform)
      ?? (this.device?.id === saved.id && this.device?.platform === saved.platform ? this.device : null);
    if (!device) throw new Error("This panel's app session is still running, but its device is unavailable. Reconnect the device and find devices again.");
    if (this.device?.id !== device.id || this.device?.platform !== device.platform) this.frame = null;
    this.device = device;
    this.opened = true;
  }

  connection() {
    return { node: this.node, cli: this.cli, state: this.state, session: this.session, device: this.device, opened: this.opened };
  }

  async importPreview(path) {
    this.requireOpen();
    const bytes = await this.fs.readFile(path), size = pngSize(bytes);
    const relative = `device-previews/${this.session}/frame-${this.captureKey}-${++this.sequence}.png`;
    await this.fs.mkdir(`${this.root}/device-previews/${this.session}`, { recursive: true });
    await this.fs.writeFile(`${this.root}/${relative}`, bytes);
    const previous = this.frame;
    this.frame = { path: relative, ...size, capturedAt: new Date().toLocaleTimeString() };
    if (previous) await this.fs.unlink(`${this.root}/${previous.path}`).catch(() => {});
  }

  async release() {
    this.requireOpen();
    await this.call(["close"]);
    this.opened = false;
    const previous = this.frame;
    this.frame = null;
    if (previous) await this.fs.unlink(`${this.root}/${previous.path}`).catch(() => {});
  }

  instructions(app) {
    if (!this.device) return "Choose a device to see agent commands.";
    const base = [this.node, this.cli].map(quote).join(" ");
    const flags = [...target(this.device, this.session), "--state-dir", this.state, "--json"].map(quote).join(" ");
    const command = args => `${base} ${args} ${flags}`;
    return [
      `Device: ${this.device.name} (${this.device.id})`, `Session: ${this.session}`,
      "Coordinate manual and agent actions; do not operate this session concurrently.",
      "Build and install the Flutter app separately with flutter run -d <device-id>.",
      this.opened ? "The app session is already open. Continue from its current state." : command(`open ${quote(app || "YOUR_APP_ID")}`),
      command("snapshot -i"), command("click @e1"), command(`type ${quote("example text")}`),
      command(`screenshot ${quote(`${this.root}/device-previews/${this.session}/agent.png`)}`),
      "Read a fresh snapshot after navigation. Refs above are examples, not discovered targets.",
      "Refresh the panel screenshot after agent actions. A screenshot alone does not prove an assertion.",
      "Close the app session in the panel when finished; this quits its app and releases the device.",
    ].join("\n\n");
  }
}

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { DeviceView, exec, appHome, props, theme, watchFolder, readTextFile, writeTextFile, nextCommand } from "herdr";
import * as fs from "fs/promises";
import { DeviceSession, VERSION } from "./device.js";
import { connectGlobal } from "./global.js";

export default class Devices extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const saved = p.session ?? localStorage.getItem("device-session");
    if (p.session && !/^herdr-[0-9]+-[a-z0-9]+$/.test(p.session)) throw new Error("Invalid device panel session.");
    const session = /^herdr-[0-9]+-[a-z0-9]+$/.test(saved ?? "") ? saved : `herdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("device-session", session);
    this.tools = new DeviceSession({ exec, fs, root: appHome(), session, node: p.node, npm: p.npm, cli: p.cli });
    this.devices = [];
    this.busy = false;
    this.error = "";
    this.status = "";
    this.details = "";
    this.showInstructions = false;
    this.showControls = Boolean(p.global);
    this.global = Boolean(p.global);
    this.requestId = this.global ? localStorage.getItem("global-request") : null;
    this.managed = Boolean(p.agent || p.global);
    this.controlDir = `${appHome()}/device-panels/${session}`;
    this.globalDir = `${appHome()}/device-global`;
    this.width = 360;
    this.liveReady = false;
    this.liveRevision = 0;
    this.app = InputState.new({ value: p.app ?? localStorage.getItem("device-app") ?? "", placeholder: this.global ? "App bundle ID or package (optional)" : "App bundle ID or Android package" });
    this.target = InputState.new({ placeholder: '@ref, label="Button", or x y' });
    this.text = InputState.new({ placeholder: "Text to type into focused field" });
    this.task(cx, p.device ? "Opening device…" : "Looking for devices…", async () => {
      await this.discover();
      if (p.device && localStorage.getItem("device-autostart") !== session) {
        localStorage.setItem("device-autostart", session);
        await this.tools.connect(this.devices, p.device, p.platform, this.app.value());
      } else if (this.tools.opened) await this.tools.capture();
    });
    if (this.managed) cx.spawn(async (cx) => {
      try {
        await fs.mkdir(this.controlDir, { recursive: true });
        const marker = await readTextFile(`${this.controlDir}/preview.json`);
        this.previewRevision = marker ? JSON.parse(marker).revision : null;
        for (;;) {
          await watchFolder(this.controlDir);
          if (this.busy) continue;
          const closed = await readTextFile(`${this.controlDir}/closed.json`);
          if (closed && this.tools.opened) {
            this.tools.opened = false; this.tools.frame = null; this.details = ""; this.error = ""; this.requestRejected = false;
            if (this.global) this.showControls = true;
            await this.publish(); cx.notify();
          }
          const text = await readTextFile(`${this.controlDir}/preview.json`);
          const revision = text ? JSON.parse(text).revision : null;
          if (revision && revision !== this.previewRevision && this.tools.opened) {
            await this.tools.importPreview(`${this.controlDir}/screen.png`);
            this.previewRevision = revision; await this.publish(); cx.notify();
          }
        }
      } catch (error) { this.error = `Session updates stopped: ${error}`; cx.notify(); }
    });
    if (this.global) cx.spawn(async (cx) => {
      await fs.mkdir(this.globalDir, { recursive: true });
      for (;;) {
        const text = await readTextFile(`${this.globalDir}/request.json`);
        const request = text ? JSON.parse(text) : null;
        if (request && request.id !== this.requestId && !this.busy) {
          this.requestId = request.id;
          localStorage.setItem("global-request", request.id);
          this.task(cx, "Connecting shared device…", async () => {
            this.tools.node = request.node || this.tools.node;
            await this.discover();
            await connectGlobal(this.tools, this.devices, request, this.app.value());
            if (request.app) this.app.set_value(request.app);
            await fs.unlink(`${this.controlDir}/closed.json`).catch(() => {});
            this.showControls = false;
          });
        }
        await watchFolder(this.globalDir);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.task(cx, "Restoring device session…", async () => {
          await this.discover();
          if (this.tools.opened) await this.tools.capture();
          this.liveRevision++;
        });
        if (command === "open" && p.device) this.task(cx, "Opening device…", async () => {
          await this.discover();
          await this.tools.connect(this.devices, p.device, p.platform, this.app.value());
        });
      }
    });
  }

  async publish() {
    if (!this.managed) return;
    await fs.mkdir(this.controlDir, { recursive: true });
    const path = `${this.controlDir}/status.json`;
    const value = { ...this.tools.connection(), status: this.detached ? "detached" : this.error && !this.requestRejected ? "error" : this.busy ? "busy" : "ready", error: this.error, app: this.app.value(), preview: this.tools.frame?.path ?? null, previewRevision: this.previewRevision ?? null };
    await writeTextFile(path, JSON.stringify(value), await readTextFile(path));
    if (this.global) {
      const globalPath = `${this.globalDir}/status.json`;
      await fs.mkdir(this.globalDir, { recursive: true });
      await writeTextFile(globalPath, JSON.stringify({ ...value, status: this.requestRejected ? "error" : value.status, requestId: this.requestId ?? null }), await readTextFile(globalPath));
    }
  }

  async discover() {
    this.devices = await this.tools.list();
    await this.tools.restore(this.devices);
  }

  async close() {
    this.detached = true;
    await this.publish();
  }

  task(cx, label, work) {
    if (this.busy) return;
    this.busy = true;
    this.status = label;
    this.error = "";
    this.requestRejected = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.publish(); await this.tools.exclusive(work);
        if (this.tools.opened && !(this.tools.device.platform === "ios" && this.tools.device.kind === "device")) {
          await this.tools.ensureLiveTools(); this.liveReady = true;
        }
      }
      catch (error) { this.error = String(error); this.requestRejected = error.code === "GLOBAL_CONNECTED"; }
      this.busy = false;
      this.status = "";
      localStorage.setItem("device-app", this.app.value());
      try { await this.publish(); } catch (error) { this.error = String(error); }
      cx.notify();
    });
  }

  button(id, label, enabled, action) {
    const t = theme();
    return div().id(id).px(8).py(6).rounded(4).bg(t.raised).text_color(enabled && !this.busy ? t.foreground : t.dim)
      .on_click((_e, cx) => { if (enabled && !this.busy) action(cx); }).child(label);
  }

  input(state) {
    const t = theme();
    return Input.new(state).h(32).px(8).rounded(4).border(1).border_color(t.input).bg(t.background).text_color(t.foreground);
  }

  controls() {
    const t = theme(), tools = this.tools, active = tools.opened;
    return v_flex().gap(8)
      .child(h_flex().gap(6)
        .child(this.button("devices-refresh", "Find devices", true, cx => this.task(cx, "Looking for devices…", () => this.discover())))
        .child(this.button("devices-install", `Install tools ${VERSION}`, !active && !tools.customCli, cx => this.task(cx, "Installing device tools…", async () => { await tools.install(); await this.discover(); }))))
      .child(v_flex().id("device-list").h(140).flex_none().gap(4).overflow_y_scrollbar().children(this.devices.map((d, i) =>
        this.button(`device-${i}`, `${d.name} · ${d.platform} ${d.osVersion ?? ""} · ${d.kind === "device" ? "physical" : d.kind} · ${d.id.slice(-8)}`, !active, cx => {
          tools.select(d); this.details = ""; cx.notify();
        }))))
      .child(this.input(this.app))
      .child(this.button("device-open", this.global ? "Connect" : "Open app", Boolean(tools.device) && !active, cx => this.task(cx, "Connecting…", async () => {
        if (this.app.value().trim()) await tools.open(this.app.value()); else await tools.openDevice();
        await fs.unlink(`${this.controlDir}/closed.json`).catch(() => {});
        if (this.global) this.showControls = false;
      })))
      .when(tools.device?.kind === "device" && tools.device?.platform === "ios", el => el.child(div().text_color(t.muted).child("iPhone: trust this Mac, enable Developer Mode, and configure XCTest runner signing.")))
      .child(this.button("device-snapshot", "Read UI", active, cx => this.task(cx, "Reading UI…", async () => { this.details = JSON.stringify(await tools.snapshot(), null, 2); })))
      .child(this.input(this.target))
      .child(h_flex().gap(6)
        .child(this.button("device-click", "Tap target", active, cx => this.task(cx, "Tapping…", async () => { this.details = ""; await tools.act("click", this.target.value()); })))
        .children(["up", "down", "back"].map(command => this.button(`device-${command}`, command === "back" ? "Back" : `Scroll ${command}`, active, cx => this.task(cx, "Sending input…", async () => { this.details = ""; await tools.act(command); })))))
      .child(this.input(this.text))
      .child(this.button("device-type", "Type text", active, cx => this.task(cx, "Typing…", async () => { this.details = ""; await tools.act("type", this.text.value()); })))
      .when(Boolean(this.details), el => el.child(div().child(this.details)));
  }

  render() {
    const t = theme(), tools = this.tools, active = tools.opened, frame = tools.frame;
    const width = frame ? Math.min(Math.max(80, this.width - 24), 360, Math.max(200, (this.height ?? 850) - 160) * frame.width / frame.height) : 0;
    return v_flex().id("devices").size_full().bg(t.surface).text_color(t.foreground).text_size(12)
      .on_size_change((s, cx) => { if (this.width !== s.width || this.height !== s.height) { this.width = s.width; this.height = s.height; cx.notify(); } })
      .p(12).gap(8)
      .child(div().text_size(15).font_semibold().child(tools.device?.name ?? "Devices"))
      .child(h_flex().gap(6)
        .child(this.button("device-controls", this.showControls ? "Hide controls" : "Controls", true, cx => { this.showControls = !this.showControls; cx.notify(); }))
        .child(this.button("device-capture", "Reconnect", active, cx => { this.liveRevision++; cx.notify(); }))
        .child(this.button("device-close", this.global ? "Disconnect" : "Close app / release", active, cx => this.task(cx, "Closing app session…", async () => { await tools.release(); this.details = ""; if (this.global) this.showControls = true; }))))
      .when(Boolean(this.status), el => el.child(div().text_color(t.muted).child(this.status)))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .when(Boolean(tools.device) && !(tools.device.platform === "ios" && tools.device.kind === "device"), el => el.child(
        DeviceView.new(`live-${tools.device.id}-${this.liveRevision}`, { session: tools.session, active: active && this.liveReady, node: tools.node, script: `${appHome()}/mods/devices/live.mjs`, toolsRoot: `${appHome()}/device-tools`, platform: tools.device.platform, device: tools.device.id })
          .when(active && this.liveReady, el => el.size_full().flex_1().min_h(180))
          .when(!active || !this.liveReady, el => el.h(0).min_h(0).flex_none())))
      .when(Boolean(frame) && tools.device?.platform === "ios" && tools.device?.kind === "device", el => el.child(v_flex().items_center().gap(6)
        .child(image(frame.path).w(width).h(width * frame.height / frame.width).flex_none())
        .child(div().text_color(t.dim).child(`Physical iPhone capture at ${frame.capturedAt} · live mirroring unavailable`))))
      .when(!frame && !this.busy, el => el.child(v_flex().py(32).gap(8)
        .child(div().child(this.global ? "Connect a device here. Its connection is shared across all workspaces." : "Your agent opens a device here and tests the app beside its terminal."))
        .child(div().text_color(t.muted).child("Use Controls for manual setup. The live view and your agent share the same device."))))
      .when(this.showControls, el => el.child(v_flex().max_h(300).overflow_y_scrollbar().child(this.controls())))
      .child(this.button("device-instructions", this.showInstructions ? "Hide agent commands" : "Agent commands", true, cx => { this.showInstructions = !this.showInstructions; cx.notify(); }))
      .when(this.showInstructions, el => el.child(TextView.markdown("device-agent-commands", this.agentInstructions()).selectable(true)))
      .child(div().text_color(t.dim).child(this.global ? "Shared across all workspaces · hiding this panel keeps the device connected." : "Click the live screen to control it · closing this pane stops its stream and leaves the app session running."));
  }

  agentInstructions() {
    const helper = `${appHome()}/mods/devices/agent.mjs`;
    if (this.global) return `Agent helper: ${this.tools.node} ${helper}\n\nUse show to reveal this panel, devices to list targets, or open --device EXACT_ID --app APP_ID to connect it. Any workspace can reuse this connection with status and run current snapshot -i.\n\nSend input with run current click @e1 or run current key enter --snapshot --compact. Disconnect explicitly with close current.\n\nBuild/install Flutter separately. Coordinate input with other agents and the person using the live screen.`;
    if (!this.managed) return `Use ${this.tools.node} ${helper} devices to list devices. Then open --device EXACT_ID --app APP_ID to open the live device beside your agent terminal. The helper returns its session for subsequent run commands.`;
    return `Agent helper: ${this.tools.node} ${helper}\n\nList devices with: devices\n\nOpen beside your terminal with: open --device EXACT_ID --app APP_ID\n\nDrive this panel with: run ${this.tools.session} snapshot -i\n\nThen: run ${this.tools.session} click @e1\n\nFinish with: close ${this.tools.session}\n\nBuild and install the Flutter app first. Coordinate manual and agent input. The live view updates continuously; each run also returns capture evidence. Refs are examples; inspect the UI first.`;
  }
}

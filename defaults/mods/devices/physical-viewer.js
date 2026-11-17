// HEVC preview and touch forwarding adapted from Expo PR #507; text stays with XCTest.
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export class PhysicalPlayer {
  constructor({ request, canvas, decoder = globalThis.VideoDecoder, chunk = globalThis.EncodedVideoChunk, status = () => {} }) {
    Object.assign(this, { request, canvas, Decoder: decoder, Chunk: chunk, status });
    this.session = null;
    this.decoder = null;
    this.stopped = false;
    this.configuration = null;
    this.generation = undefined;
    this.touchGeneration = undefined;
    this.awaitingKey = true;
    this.configuredGeneration = undefined;
    this.paintedGeneration = undefined;
    this.pending = [];
    this.inputting = false;
    this.width = this.height = 0;
  }

  async call(operation, data = {}, cleanup = false) { return this.request(operation, { session: this.session, ...data }, cleanup); }

  async start() {
    this.status("Connecting real iPhone video…");
    try {
      if (!this.Decoder || !this.Chunk) throw new Error("This viewer cannot decode live iPhone video. Screenshots remain available in Herdr.");
      // Learn the capture ID even if the view closes while native startup is pending.
      this.session = (await this.call("open", {}, true)).session;
      if (this.stopped) return;
      this.decoder = new this.Decoder({
        output: frame => {
          try {
            if (this.stopped || this.awaitingKey || this.configuredGeneration !== this.generation) return;
            const canvas = this.canvas;
            if (canvas.width !== this.width || canvas.height !== this.height) { canvas.width = this.width; canvas.height = this.height; }
            canvas.getContext("2d").drawImage(frame, 0, 0, this.width, this.height, 0, 0, this.width, this.height);
            this.paintedGeneration = this.configuredGeneration;
            this.status("Live iPhone");
          } finally { frame.close(); }
        },
        error: error => { if (!this.stopped) { this.status("Video paused", error.message); void this.stop(); } },
      });
      while (!this.stopped) {
        const batch = await this.call("read");
        if (this.stopped) break;
        await this.accept(batch);
      }
    } catch (error) {
      if (!this.stopped) this.status("Video unavailable", error.message || String(error));
    } finally { await this.stop(); }
  }

  async accept(batch) {
    if (batch.configuration) {
      this.decoder.reset(); this.configuredGeneration = undefined; this.paintedGeneration = undefined;
      const config = batch.configuration;
      this.width = config.displayWidth ?? config.width;
      this.height = config.displayHeight ?? config.height;
      this.configuration = { codec: config.codec, codedWidth: config.width, codedHeight: config.height, description: bytes(config.description), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
      if (!(await this.Decoder.isConfigSupported(this.configuration)).supported) throw new Error("HEVC decoding is unavailable in this viewer. Screenshots remain available in Herdr.");
      this.awaitingKey = true;
      this.touchGeneration = undefined;
      this.pending = [];
    }
    if (this.generation !== batch.generation) {
      this.decoder.reset(); this.configuredGeneration = undefined; this.paintedGeneration = undefined;
      this.generation = batch.generation; this.touchGeneration = undefined; this.awaitingKey = true; this.pending = [];
    }
    if (!this.configuration) return;
    if (this.decoder.decodeQueueSize > 8) {
      // Closing the owned capture releases a contact that could otherwise lose its pointer-up.
      if (this.touchGeneration !== undefined || this.inputting || this.pending.length) throw new Error("Video was interrupted during a touch. Reconnect video to resume.");
      this.decoder.reset(); this.awaitingKey = true; this.configuredGeneration = undefined; this.paintedGeneration = undefined; this.touchGeneration = undefined; this.pending = [];
      await this.call("reset"); return;
    }
    for (const frame of batch.frames) {
      if (this.awaitingKey) {
        if (!frame.key) continue;
        this.decoder.reset(); this.decoder.configure(this.configuration); this.configuredGeneration = this.generation; this.awaitingKey = false;
      }
      this.decoder.decode(new this.Chunk({ type: frame.key ? "key" : "delta", timestamp: frame.timestamp, data: bytes(frame.data) }));
    }
  }

  touch(phase, x, y) {
    if (this.stopped || this.awaitingKey || this.generation === undefined || this.paintedGeneration !== this.generation || !this.width || !this.height) return;
    if (phase === 0) this.touchGeneration = this.generation;
    else if (this.touchGeneration !== this.generation) return;
    if (phase === 2) this.touchGeneration = undefined;
    const sample = { phase, x, y, width: this.width, height: this.height };
    if (phase === 1 && this.pending.at(-1)?.phase === 1) this.pending[this.pending.length - 1] = sample;
    else if (this.pending.length < 64) this.pending.push(sample);
    else { this.status("Video paused", "Touch queue full. Reconnect video."); void this.stop(); return; }
    void this.flushInput();
  }

  async flushInput() {
    if (this.inputting || this.stopped) return;
    this.inputting = true;
    try {
      while (!this.stopped && this.pending.length) await this.call("input", { samples: this.pending.splice(0, 64), generation: this.generation });
    } catch (error) {
      this.pending = []; this.touchGeneration = undefined;
      if (!this.stopped) this.status("Live iPhone", error.message);
    } finally { this.inputting = false; }
  }

  async stop() {
    this.stopped = true; this.pending = []; this.touchGeneration = undefined;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    const session = this.session; this.session = null;
    if (session) await this.request("close", { session }, true).catch(() => {});
  }
}

export function startViewer(token) {
  const canvas = document.getElementById("screen"), label = document.getElementById("status"), error = document.getElementById("error");
  let player, controller, pointer = null;
  const restart = async () => {
    if (player) await player.stop();
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const request = async (operation, data, cleanup) => {
      const response = await fetch(`/${operation}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Herdr-Device-Token": token }, body: JSON.stringify(data), signal: cleanup ? AbortSignal.timeout(35000) : signal, keepalive: cleanup && operation !== "open" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Device request failed (${response.status}).`);
      return value;
    };
    player = new PhysicalPlayer({ canvas, request, status: (text, message = "") => { label.textContent = text; error.textContent = message; document.getElementById("retry").disabled = text.startsWith("Connecting"); } });
    void player.start();
  };
  const send = (event, phase) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    player?.touch(phase, Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
  };
  canvas.addEventListener("pointerdown", event => { if (pointer !== null || event.button !== 0) return; pointer = event.pointerId; canvas.setPointerCapture(pointer); canvas.focus(); send(event, 0); event.preventDefault(); });
  canvas.addEventListener("pointermove", event => { if (event.pointerId === pointer) { send(event, 1); event.preventDefault(); } });
  const release = event => { if (event.pointerId === pointer) { send(event, 2); pointer = null; event.preventDefault(); } };
  canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release); canvas.addEventListener("lostpointercapture", release);
  document.getElementById("retry").addEventListener("click", () => { pointer = null; void restart(); });
  window.addEventListener("pagehide", () => { void player?.stop(); controller?.abort(); });
  void restart();
}

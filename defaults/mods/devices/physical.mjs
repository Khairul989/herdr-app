// One physical-phone preview per native view; XCTest retains the agent app session.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ensurePhysicalTools } from "./physical-build.mjs";
import { physicalDevice } from "./physical-spec.js";

const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function body(request) {
  const reader = request.body?.getReader(), chunks = [];
  let length = 0;
  if (reader) for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 32768) { await reader.cancel(); throw new Error("Request too large."); }
    chunks.push(value);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object.");
  return data;
}

export function validTouches(samples) {
  return Array.isArray(samples) && samples.length > 0 && samples.length <= 64 && samples.every(s => s &&
    [0, 1, 2].includes(s.phase) && [s.x, s.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    [s.width, s.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384));
}

export class PhysicalPreview {
  constructor({ device, openDevice, token = randomUUID().replace(/-/g, ""), now = Date.now }) {
    this.device = physicalDevice(device);
    Object.assign(this, { openDevice, token, now });
    this.session = null;
    this.opening = false;
    this.disposed = false;
  }

  async close(session = this.session) {
    if (!session || session.closed) return;
    if (this.session === session) this.session = null;
    session.closed = true;
    await session.capture.close();
  }

  async dispose() { this.disposed = true; await this.close(); }

  async handle(request, origin) {
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.get("host") && request.headers.get("host") !== new URL(origin).host ||
      request.headers.get("origin") && request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("x-herdr-device-token") !== this.token) return json({ error: "This preview only accepts its own local viewer." }, 403);
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "Expected application/json." }, 415);
    let data;
    try { data = await body(request); } catch (error) { return json({ error: error.message }, error.message === "Request too large." ? 413 : 400); }
    // The target is supplied by the owning native view, never by an HTTP caller.
    if ("device" in data || "udid" in data) return json({ error: "The device is bound to this preview." }, 400);
    if (this.disposed) return json({ error: "Preview is stopping." }, 503);
    let session;
    try {
      if (url.pathname === "/open") {
        if (this.opening) return json({ error: "A preview is already opening." }, 409);
        this.opening = true;
        try {
          await this.close();
          const capture = await this.openDevice(this.device);
          if (this.disposed || request.signal.aborted) { await capture.close(); return json({ error: "Preview closed during startup." }, 410); }
          this.session = { id: randomUUID(), capture, expires: this.now() + 30000, reading: false, inputting: false, generation: undefined, closed: false };
          return json({ session: this.session.id });
        } finally { this.opening = false; }
      }
      session = this.session;
      if (!session || data.session !== session.id || session.closed) return json({ error: "Preview expired. Reconnect video." }, 410);
      if (session.expires < this.now()) { await this.close(session); return json({ error: "Preview expired. Reconnect video." }, 410); }
      session.expires = this.now() + 30000;
      if (url.pathname === "/close") { await this.close(session); return json({ ok: true }); }
      if (url.pathname === "/read") {
        if (session.reading) return json({ error: "A video read is already pending." }, 409);
        session.reading = true;
        try {
          const batch = await session.capture.read();
          if (session.closed) return json({ error: "Preview closed." }, 410);
          if (batch.generation !== session.generation) session.generation = undefined;
          if (batch.frames.some(f => f.key)) session.generation = batch.generation;
          return json({ ...batch,
            configuration: batch.configuration && { ...batch.configuration, description: batch.configuration.description.toString("base64") },
            frames: batch.frames.map(f => ({ ...f, data: f.data.toString("base64") })),
          });
        } finally { session.reading = false; }
      }
      if (url.pathname === "/reset") { session.generation = undefined; session.capture.requestKeyframe(); return json({ ok: true }); }
      if (url.pathname === "/input") {
        if (!Number.isInteger(data.generation) || data.generation !== session.generation) return json({ error: "Wait for a fresh device frame." }, 409);
        if (!validTouches(data.samples)) return json({ error: "Invalid touch samples." }, 400);
        if (session.inputting) return json({ error: "Input is already pending." }, 409);
        session.inputting = true;
        try {
          await session.capture.touch(data.samples.map(s => ({ ...s, x: s.x * s.width, y: s.y * s.height })), data.generation);
        } catch (error) {
          if (error.message === "Wait for a fresh physical iOS screen before sending input.") {
            session.generation = undefined; session.capture.requestKeyframe();
            return json({ error: error.message }, 409);
          }
          throw error;
        } finally { session.inputting = false; }
        return json({ ok: true });
      }
      return json({ error: "Unknown preview operation." }, 404);
    } catch (error) {
      if (session) await this.close(session).catch(() => {});
      return json({ error: error.message || String(error) }, 503);
    }
  }
}

const page = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#101112;color:#eee;font:12px -apple-system,sans-serif}body{display:flex;flex-direction:column}header{padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{background:#292b2e;color:#eee;border:0;border-radius:4px;padding:6px}#status{flex:1}main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}canvas{max-width:100%;max-height:100%;object-fit:contain;touch-action:none;outline:none}footer{padding:6px;color:#999}#error{color:#ff6e85;white-space:pre-wrap;padding:0 8px}</style>
<header><span id="status">Connecting real iPhone video…</span><button id="retry">Reconnect video</button></header><div id="error"></div><main><canvas id="screen" tabindex="0"></canvas></main><footer>Experimental live iPhone · tap or drag the screen · use Setup &amp; input for text.</footer>
<script type="module">import {startViewer} from '/viewer.js';startViewer(location.hash.slice(1));</script>`;

export async function startPhysicalServer({ device, openDevice }) {
  const preview = new PhysicalPreview({ device, openDevice });
  const viewer = await readFile(new URL("./physical-viewer.js", import.meta.url));
  let origin;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
      if (req.method === "GET" && ["/", "/viewer.js"].includes(req.url)) {
        res.writeHead(200, { "Content-Type": req.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(req.url === "/" ? page() : viewer); return;
      }
      const abort = new AbortController();
      res.once("close", () => { if (!res.writableEnded) abort.abort(); });
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, signal: abort.signal, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: req, duplex: "half" }) });
      const response = await preview.handle(request, origin);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiry = setInterval(() => { if (preview.session?.expires < Date.now()) void preview.close().catch(() => {}); }, 5000);
  expiry.unref();
  return { url: `${origin}/#${preview.token}`, preview, async close() { clearInterval(expiry); await preview.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  let closing = false, owned;
  const close = () => { closing = true; if (owned) void owned.close().finally(() => process.exit(0)); };
  process.stdin.resume(); process.stdin.on("end", close); process.on("SIGTERM", close); process.on("SIGINT", close);
  try {
    const [toolsRoot, platform, device] = process.argv.slice(2);
    if (platform !== "ios") throw new Error("Physical iOS preview only accepts iPhones and iPads.");
    physicalDevice(device);
    const root = await ensurePhysicalTools(toolsRoot);
    const addon = createRequire(import.meta.url)(`${root}/ios-device.node`);
    if (!closing) { owned = await startPhysicalServer({ device, openDevice: id => addon.openDevice(id) }); if (closing) await owned.close(); else console.log(JSON.stringify({ url: owned.url })); }
    if (closing) process.exit(0);
  } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; process.stdin.destroy(); }
}

// Keep one browser origin while the owned capture server restarts. The client
// watches decoded frames, not the presence of an HTTP server or socket.
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function streamProxy(target, { client = new URL('./stream-client.js', import.meta.url), read = readFile, onStall = () => {}, clock = Date.now, device, platform } = {}) {
  const script = await read(client, 'utf8');
  const sockets = new Set();
  let clientState = null, healthyAt = clock(), recoveryAt = 0;
  const destination = (address, path) => {
    const url = new URL(address), relative = new URL(path, 'http://device.invalid');
    url.pathname = relative.pathname; url.search = relative.search;
    return url;
  };
  const recoveryPage = outgoing => {
    outgoing.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    outgoing.end('<!doctype html><head><script src="/_herdr/stream-client.js"></script></head><body data-herdr-reconnecting="true"></body>');
  };
  const server = createServer((incoming, outgoing) => {
    if (incoming.url === '/_herdr/stream-client.js') {
      outgoing.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); outgoing.end(script); return;
    }
    if (incoming.url === '/_herdr/stream-health') {
      const reply = () => { outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify({ available: Boolean(target()), device, platform, client: clientState })); };
      if (incoming.method !== 'POST') { reply(); return; }
      if (incoming.headers.origin && incoming.headers.origin !== `http://${incoming.headers.host}`) { outgoing.writeHead(403); outgoing.end(); return; }
      let body = '';
      incoming.on('data', chunk => { body += chunk; if (body.length > 4096) incoming.destroy(); });
      incoming.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (!Number.isSafeInteger(value.frames) || value.frames < 0 || !['live', 'connecting', 'reconnecting'].includes(value.status)) throw new Error('Invalid video status');
          const now = clock();
          if (value.status === 'live' && value.paintAgeMs < 2000 && (value.page !== clientState?.page || value.frames > clientState.frames)) healthyAt = now;
          clientState = { page: value.page, frames: value.frames, status: value.status, visible: value.visible, paintAgeMs: value.paintAgeMs, receivedAt: now, userAgent: incoming.headers['user-agent'] || '' };
          reply();
          // A decoder reconnect cannot repair an unresponsive capture host.
          // Only recycle our host after visible video has remained stalled.
          if (value.visible === true && value.status === 'reconnecting' && now - healthyAt > 10000 && now - recoveryAt > 15000) {
            recoveryAt = now; healthyAt = now; Promise.resolve().then(onStall).catch(() => {});
          }
        } catch { outgoing.writeHead(400); outgoing.end('Invalid video status'); }
      });
      return;
    }
    const address = target();
    if (!address) {
      recoveryPage(outgoing); return;
    }
    const url = destination(address, incoming.url);
    const upstream = request(url, { method: incoming.method, headers: { ...incoming.headers, host: url.host, 'accept-encoding': 'identity' } }, response => {
      const headers = { ...response.headers };
      if ((headers['content-type'] || '').includes('text/html')) {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8').replace(/<head(?:\s[^>]*)?>/i, '$&<script src="/_herdr/stream-client.js"></script>');
          delete headers['content-length']; delete headers['transfer-encoding'];
          outgoing.writeHead(response.statusCode, headers); outgoing.end(html);
        });
      } else { outgoing.writeHead(response.statusCode, headers); response.pipe(outgoing); }
      response.on('error', () => { if (outgoing.destroyed) return; if (!outgoing.headersSent && (headers['content-type'] || '').includes('text/html')) recoveryPage(outgoing); else outgoing.destroy(); });
    });
    upstream.on('error', () => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      if (incoming.url === '/' || (incoming.headers.accept || '').includes('text/html')) recoveryPage(outgoing);
      else { outgoing.writeHead(502); outgoing.end('Device video is reconnecting.'); }
    });
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (incoming, socket, head) => {
    const address = target();
    if (!address) { socket.destroy(); return; }
    const url = destination(address, incoming.url);
    const upstream = request(url, { headers: { ...incoming.headers, host: url.host } });
    socket.on('error', () => upstream.destroy());
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote); remote.on('close', () => sockets.delete(remote));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, index, values) => index % 2 ? lines : lines + value + ': ' + values[index + 1] + '\r\n', '')}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}

// A connected socket can stop delivering video forever. Keep the last decoded
// frame visibly marked as stale while replacing that connection, without input
// retries or any change to the simulator/app session.
(() => {
  if (window.__herdrVideo) return;
  const state = window.__herdrVideo = { frames: 0, lastFrame: 0, status: 'connecting', page: Date.now() };
  const started = performance.now(), controllers = new Set();
  let retained, retainedAt = 0, overlay, label, image, retrying = false;
  const drawFrame = CanvasRenderingContext2D.prototype.drawImage;
  const savedFrame = 'herdr-device-last-frame';
  const show = text => {
    if (!document.body) return;
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'herdr-video-status'; overlay.setAttribute('role', 'status');
      Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#151719', color: '#fff', font: '14px system-ui' });
      label = document.createElement('span'); Object.assign(label.style, { position: 'relative', padding: '12px 18px', borderRadius: '8px', background: '#202428' }); overlay.append(label); document.body.append(overlay);
    }
    try {
      const previous = sessionStorage.getItem(savedFrame);
      if (previous) {
        if (!image) { image = document.createElement('img'); Object.assign(image.style, { position: 'absolute', width: '100%', height: '100%', objectFit: 'contain', opacity: '0.45' }); overlay.prepend(image); }
        if (image.src !== previous) image.src = previous;
      }
    } catch {}
    label.textContent = text; overlay.style.display = 'flex';
  };
  const painted = target => {
    if (target.width < 100 || target.height < 100 || !target.isConnected) return;
    // A decoder can clear its canvas before a stall is detected. Keep a GPU
    // copy of a painted frame; encode it only when recovery actually starts.
    try {
      if (!retained || performance.now() - retainedAt > 200) {
        retained ||= document.createElement('canvas');
        if (retained.width !== target.width) retained.width = target.width;
        if (retained.height !== target.height) retained.height = target.height;
        drawFrame.call(retained.getContext('2d'), target, 0, 0); retainedAt = performance.now();
      }
    } catch {}
    state.frames++; state.lastFrame = performance.now(); state.status = 'live'; retrying = false;
    if (overlay) overlay.style.display = 'none';
  };
  for (const method of ['drawImage', 'putImageData']) {
    const original = CanvasRenderingContext2D.prototype[method];
    CanvasRenderingContext2D.prototype[method] = function (...args) { const result = original.apply(this, args); painted(this.canvas); return result; };
  }
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/\/stream\.(?:avcc|mjpeg)(?:\?|$)/.test(url)) return fetchOriginal(input, options);
    const controller = new AbortController(); controllers.add(controller);
    const signal = options.signal || (input instanceof Request ? input.signal : null);
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const release = () => { controllers.delete(controller); signal?.removeEventListener('abort', abort); };
    try {
      const response = await fetchOriginal(input, { ...options, signal: controller.signal });
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      return new Response(new ReadableStream({
        async pull(output) { try { const { done, value } = await reader.read(); if (done) { release(); output.close(); } else output.enqueue(value); } catch (error) { release(); output.error(error); } },
        cancel(reason) { release(); controller.abort(); return reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { release(); throw error; }
  };
  const recover = async () => {
    if (retrying) return;
    retrying = true; state.status = 'reconnecting';
    try { if (retained) sessionStorage.setItem(savedFrame, retained.toDataURL('image/jpeg', 0.7)); } catch {}
    show('Reconnecting device video…');
    for (const controller of controllers) controller.abort();
    // Let a client-side reconnect recover first. Restart the viewer only if it
    // still has no frames; health waits for an owned server restart, if needed.
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!retrying) return;
    try {
      const response = await fetchOriginal('/_herdr/stream-health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (!(await response.json()).available) { retrying = false; return; }
    } catch { retrying = false; return; }
    location.reload();
  };
  const timer = setInterval(() => {
    if (document.hidden) return;
    if (document.body?.dataset.herdrReconnecting === 'true') { recover(); return; }
    if (state.lastFrame ? performance.now() - state.lastFrame > 3500 : performance.now() - started > 12000) recover();
    else if (!state.lastFrame) show('Connecting device video…');
  }, 500);
  // The host can verify painted-frame progress in its actual native WebView,
  // independently of capture-server liveness or a separate browser probe.
  const reporting = setInterval(() => {
    fetchOriginal('/_herdr/stream-health', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: state.page, frames: state.frames, status: state.status, visible: !document.hidden, paintAgeMs: state.lastFrame ? performance.now() - state.lastFrame : null }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  }, 2000);
  addEventListener('pagehide', () => { clearInterval(reporting); clearInterval(timer); for (const controller of controllers) controller.abort(); }, { once: true });
})();

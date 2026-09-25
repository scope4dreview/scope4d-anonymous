/* SCOPE-4D project page: diagnostics for real browsers.  Loaded only when the URL has ?diag=1.
 *
 * Shows a small panel and records a timeline that can be downloaded as JSON:
 *   page frames (requestAnimationFrame gaps), long tasks, layout shifts (with the moved elements), WebGL context
 *   lost/restored, per-video presented-frame stalls (requestVideoFrameCallback, visible videos only), video
 *   waiting/stalled/error events, visibility / online / offline, page errors, loader events (window.__scopeLog),
 *   memory and DOM size every 5 s, plus the browser / GPU description.
 * "Mark flash" (or the F key) stores a time stamp: press it right when the page flickers, then "Download log".
 */
(function () {
  'use strict';
  const T0 = Date.now(), now = () => Math.round(performance.now());
  const D = window.__scopeDiag = { started: new Date().toISOString(), env: {}, events: [], marks: [], samples: [], counters: { longTasks: 0, longTaskMax: 0, shifts: 0, cls: 0, rafGaps100: 0, rafGaps250: 0, videoStalls: 0, glLost: 0, errors: 0 } };
  const C = D.counters;
  const ev = (type, detail) => { D.events.push([now(), type, detail == null ? '' : detail]); if (D.events.length > 5000) D.events.splice(0, 1000); };

  // environment
  try {
    const cv = document.createElement('canvas'); const gl = cv.getContext('webgl'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    D.env.gpu = gl ? { vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) } : 'no webgl';
    const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  } catch (e) { D.env.gpu = 'error: ' + e.message; }
  Object.assign(D.env, { ua: navigator.userAgent, platform: navigator.platform, dpr: window.devicePixelRatio, viewport: [innerWidth, innerHeight],
    cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory, url: location.href.replace(/[?#].*$/, '') });

  // observers
  try { new PerformanceObserver(l => l.getEntries().forEach(e => { C.longTasks++; C.longTaskMax = Math.max(C.longTaskMax, Math.round(e.duration)); ev('longtask', Math.round(e.duration)); })).observe({ type: 'longtask', buffered: true }); } catch (e) { }
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => {
      if (e.hadRecentInput) return; C.shifts++; C.cls += e.value;
      ev('layout-shift', { value: +e.value.toFixed(4), sources: (e.sources || []).slice(0, 4).map(s => { const n = s.node; return (n && n.nodeName ? n.nodeName + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : '') : '?') + ` y ${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)} h ${Math.round(s.previousRect.height)}->${Math.round(s.currentRect.height)}`; }) });
    })).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { }
  let last = 0; const raf = t => { if (last) { const g = t - last; if (g > 100) { C.rafGaps100++; ev('frame-gap', Math.round(g)); } if (g > 250) C.rafGaps250++; } last = document.hidden ? 0 : t; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
  document.addEventListener('webglcontextlost', e => { C.glLost++; ev('webgl-lost', e.target && e.target.className); }, true);
  document.addEventListener('webglcontextrestored', e => ev('webgl-restored'), true);
  document.addEventListener('visibilitychange', () => ev('visibility', document.visibilityState));
  addEventListener('online', () => ev('online')); addEventListener('offline', () => ev('offline'));
  addEventListener('error', e => { C.errors++; ev('error', (e.message || (e.target && (e.target.src || e.target.nodeName)) || '') + ''); }, true);
  addEventListener('unhandledrejection', e => { C.errors++; ev('rejection', String(e.reason)); });
  addEventListener('pagehide', () => ev('pagehide')); addEventListener('pageshow', e => ev('pageshow', e.persisted ? 'from cache' : ''));

  // videos: presented-frame stalls while playing and on screen, and media events
  const watched = new WeakSet();
  function watch() {
    document.querySelectorAll('video').forEach(v => {
      if (watched.has(v)) return; watched.add(v);
      const name = (v.dataset.src || '').split('/').pop();
      ['waiting', 'stalled', 'error', 'emptied'].forEach(t => v.addEventListener(t, () => ev('video-' + t, name + ' @' + v.currentTime.toFixed(2))));
      if (!('requestVideoFrameCallback' in v)) return;
      let lastT = 0, lastM = -1;
      const cb = (t, md) => {
        const fps = +v.dataset.fps || 10, gap = t - lastT;
        const wrapped = md.mediaTime < lastM - 0.05;                 // loop boundary
        if (lastT && !wrapped && !v.paused && gap > Math.max(400, 4000 / fps)) { C.videoStalls++; ev('video-stall', `${name} ${Math.round(gap)} ms @${md.mediaTime.toFixed(2)}`); }
        lastT = t; lastM = md.mediaTime; v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      // a video that goes off screen stops presenting; reset so the return is not counted as a stall
      new IntersectionObserver(es => es.forEach(e => { if (!e.isIntersecting) lastT = 0; })).observe(v);
    });
  }
  setInterval(watch, 2000); watch();

  // samples every 5 s
  setInterval(() => {
    const m = performance.memory; const vids = [...document.querySelectorAll('video')];
    D.samples.push({ t: now(), heapMB: m ? +(m.usedJSHeapSize / 2 ** 20).toFixed(1) : null, nodes: document.getElementsByTagName('*').length,
      playing: vids.filter(v => !v.paused).length, videos: vids.length, groups: (window.__scopeGroups || []).map(g => g.state[0]).join('') });
    if (D.samples.length > 2000) D.samples.shift();
  }, 5000);

  // panel
  const css = `#sdiag{position:fixed;left:10px;bottom:10px;z-index:30;font:12px/1.35 ui-monospace,Menlo,monospace;background:rgba(255,255,255,.96);border:1px solid #bbb;border-radius:8px;padding:8px 10px;max-width:330px;color:#222;box-shadow:0 1px 4px rgba(0,0,0,.15)}
#sdiag button{font:inherit;margin:4px 4px 0 0;padding:2px 8px;border:1px solid #999;border-radius:5px;background:#f6f6f6;cursor:pointer}#sdiag .k{color:#666}`;
  function panel() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const p = document.createElement('div'); p.id = 'sdiag'; p.setAttribute('role', 'region'); p.setAttribute('aria-label', 'Diagnostics');
    const out = document.createElement('div'); p.appendChild(out);
    const mark = document.createElement('button'); mark.textContent = 'Mark flash (F)'; mark.onclick = doMark;
    const dl = document.createElement('button'); dl.textContent = 'Download log'; dl.onclick = download;
    const hide = document.createElement('button'); hide.textContent = 'Hide'; hide.onclick = () => { out.hidden = !out.hidden; hide.textContent = out.hidden ? 'Show' : 'Hide'; };
    p.append(mark, dl, hide); document.body.appendChild(p);
    setInterval(() => {
      if (out.hidden) return;
      const gs = window.__scopeGroups || [], lg = window.__scopeLog || [];
      const cnt = s => gs.filter(g => g.state === s).length;
      const lines = [`groups ${gs.length}: playing ${cnt('playing')} · loading ${cnt('loading') + cnt('queued')} · retrying ${cnt('retrying')} · error ${cnt('error')}`,
        `long tasks ${C.longTasks} (max ${C.longTaskMax} ms) · frame gaps >100 ms ${C.rafGaps100}`,
        `layout shifts ${C.shifts} (CLS ${C.cls.toFixed(3)}) · video stalls ${C.videoStalls}`,
        `WebGL lost ${C.glLost} · errors ${C.errors} · marks ${D.marks.length}`,
        `GPU ${typeof D.env.gpu === 'object' ? String(D.env.gpu.renderer).slice(0, 60) : D.env.gpu}`];
      const t = lines.join('\n'); if (out.textContent !== t) { out.textContent = t; out.style.whiteSpace = 'pre-wrap'; }
    }, 500);
  }
  function doMark() { const m = { t: now(), scrollY: Math.round(scrollY), recent: D.events.filter(e => e[0] > now() - 3000) }; D.marks.push(m); ev('MARK', m.scrollY); }
  addEventListener('keydown', e => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA/.test(document.activeElement.nodeName)) doMark(); });
  function download() {
    const data = JSON.stringify(Object.assign({}, D, { loader: window.__scopeLog || [], exported: new Date().toISOString(), msSinceOpen: Date.now() - T0 }), null, 1);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = 'scope4d_page_diagnostics.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', panel); else panel();
})();

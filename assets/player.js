/* SCOPE-4D project page: grouped video player.
 *
 * Loading: blocks (one comparison group = one block) are loaded in page order.  Every video of a block is
 * downloaded COMPLETELY (fetch -> Blob -> object URL, kept for the life of the page) and must show its first frame;
 * only then does the block start playing.  Normally the next block starts when the current one is complete.
 * After that a block never touches the network again: scrolling does not pause, seek, reset, unload or re-request.
 *
 * Failures are handled per FILE, never per block (files that arrived are kept; only failed files are fetched again):
 *   temporary  network error, no response headers for HEADERS_TIMEOUT, no bytes for STALL_TIMEOUT once the body
 *              flows, incomplete body, HTTP 408/425/429/5xx  -> automatic retry with growing delay (2 s ... 60 s,
 *              Retry-After honoured); the 'online' event or any successful response wakes waiting retries early.
 *              An interrupted file is downloaded again from the start (CFG.RESUME is off; the Range + If-Range
 *              resume path is kept but unused, so nothing depends on how a host or CDN answers byte ranges).
 *   permanent  HTTP 404/410/401/403/other 4xx, a codec this browser cannot play (checked before downloading),
 *              a file that still cannot be decoded after one fresh re-download  -> reason + Retry, no auto retry.
 * A block whose files are all either finished or waiting for a retry no longer holds up the next block (page order
 * is kept, a failure does not block).  While the network looks down (a network-level error and no bytes from
 * anywhere since), only one probe request runs at a time, spaced by the same growing delay.
 * (file:// pages cannot fetch; there the local file is used directly and "complete" = whole file buffered.)
 *
 * Playback: loaded blocks loop forever.
 *   sync   : videos that render the same source frames (declared by the builder in window.SCOPE_GROUPS and
 *            re-checked here against data-frames / data-fps): one timeline, loop together, drift kept ~1 frame.
 *   single : one video: native loop; play/pause, restart, timeline.
 *   free   : videos that are not frame-aligned (dataset tiles, different lengths): each loops natively on its own.
 * Pauses: a group's own pause is never undone automatically ("Pause all" / resume, retries and tab switches keep it).
 * "Pause all" pauses everything; pressing one group's play while it is on plays that group only.  A hidden tab
 * pauses the running groups and restores exactly those on return.  Every playback command bumps `gen`, so stale
 * timers/promises are ignored; the loader has its own timers and is never cancelled by playback commands.
 * UI writes (timeline, frame counter, buttons) happen only when the shown value changes, and the per-frame
 * timeline/counter only for control bars on screen, so a playing page does not re-layout on every frame.
 * window.__scopeLog keeps the last 600 loader events (read by assets/diag.js and the tests).
 */
(function () {
  'use strict';
  const CFG = {
    RESUME: false,              // resume interrupted downloads with Range + If-Range (off: re-download the file)
    MAX_PARALLEL: 4,            // video downloads at once (HTTP/1.1 allows ~6 connections per host; leave room for the page)
    HEADERS_TIMEOUT: 30000,     // ms from sending a request to its response headers
    STALL_TIMEOUT: 20000,       // ms without a byte once the body is flowing (slow but moving downloads never time out)
    SLOW_MS: 8000,              // a file without a byte for this long stops holding up the next block (it keeps its own timeouts)
    FIRST_FRAME_TIMEOUT: 30000, // ms for a completely downloaded (local) file to show its first frame
    BACKOFF: [2000, 4000, 8000, 16000, 30000, 60000],
    RETRY_AFTER_MAX: 120000,
    HOLD_END: 900,              // ms a sync group holds its last frame before looping
    NUDGE_MAX: 0.06,            // max playbackRate deviation used to remove small drift (sync groups)
    RESYNC_FRAMES: 3,           // drift beyond this many frames -> pause, align, resume together
    ALIGN_TIMEOUT: 4000,        // ms for all videos of a group to finish a seek (local blobs: normally < 100 ms)
  };
  const GROUPS = window.SCOPE_GROUPS || {};
  const FILE = location.protocol === 'file:';
  const hasRVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const all = [];
  const LOG = window.__scopeLog = [];
  const log = (ev, g, f, detail) => { LOG.push([Math.round(performance.now()), ev, g ? g.id : '', f ? f.name : '', detail == null ? '' : String(detail)]); if (LOG.length > 600) LOG.shift(); };

  const box = v => v.closest('.tile,.trk-tile,.frame') || v.parentElement;
  function labelOf(v) {
    if (v.dataset.label) return v.dataset.label;
    const col = v.closest('.dcol'); const name = col && col.querySelector('.dname') ? col.querySelector('.dname').firstChild.textContent.trim() : '';
    let lab = ''; let n = v.nextElementSibling; while (n && !lab) { if (n.classList && n.classList.contains('lab')) lab = n.textContent.trim(); n = n.nextElementSibling; }
    if (!lab) lab = ((box(v).querySelector('.lab') || {}).textContent || '').trim();
    return name ? `${name} ${lab || 'video'}` : (lab || 'video');
  }
  function fmtFrame(t, fps, n) { return `${Math.min(n, Math.floor(t * fps + 1e-3) + 1)} / ${n}`; }
  // write only when the value changes (every write invalidates style/layout)
  const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
  const setAttr = (el, k, s) => { if (el.getAttribute(k) !== s) el.setAttribute(k, s); };
  const fullyBuffered = v => v.duration > 0 && v.buffered.length === 1 && v.buffered.start(0) <= 0.05 && v.buffered.end(0) >= v.duration - 0.05;
  const jitter = ms => Math.round(ms * (0.8 + 0.4 * Math.random()));
  const fail = (kind, msg, extra) => Object.assign(new Error(msg), { kind }, extra || {});
  function retryAfterMs(r) {
    const h = r.headers.get('Retry-After'); if (!h) return 0;
    const s = +h; const ms = isFinite(s) ? s * 1000 : (Date.parse(h) - Date.now());
    return Math.max(0, Math.min(CFG.RETRY_AFTER_MAX, ms || 0));
  }
  const decodeReason = e => !e ? 'cannot decode' : ({ 1: 'aborted', 2: 'network error while decoding', 3: 'file damaged (decode error)', 4: 'cannot read file (damaged or unsupported)' }[e.code] || 'cannot decode');

  // ---------- one video file ----------
  class MFile {
    constructor(g, v) {
      this.g = g; this.v = v; this.url = v.dataset.src; this.name = (this.url || '').split('/').pop();
      this.state = 'pending';    // pending | active | wait | done | failed
      this.attempts = 0; this.notBefore = 0; this.lastTry = 0; this.parts = []; this.got = 0; this.total = 0;
      this.etag = null; this.lastMod = null; this.ranges = false; this.type = 'video/mp4';
      this.objUrl = null; this.err = null; this.kind = null; this.fresh = false; this.redownloaded = false;
      this.requests = 0; this.resumes = 0; this.ctl = null;
    }
    resetBody() { this.parts = []; this.got = 0; }
    // codec check before any download: a browser that cannot play the file will never succeed
    unsupported() {
      const c = this.v.dataset.codec; if (!c || FILE) return false;
      try { return this.v.canPlayType(`video/mp4; codecs="${c}"`) === ''; } catch (e) { return false; }
    }
    async attempt() {
      const f = this; f.state = 'active'; f.attempts++; f.lastTry = performance.now(); net.active++; f.g.update();
      const ctl = new AbortController(); f.ctl = ctl; let phase = 'headers', last = performance.now(); f.slow = false;
      const touch = p => { phase = p; last = performance.now(); if (f.slow) { f.slow = false; } };
      const wd = setInterval(() => {
        const dt = performance.now() - last;
        if (!f.slow && phase !== 'decode' && dt > CFG.SLOW_MS) { f.slow = true; log('slow', f.g, f, phase); net.pump(); }
        if (phase === 'headers' && dt > CFG.HEADERS_TIMEOUT) ctl.abort('no response');
        else if (phase === 'body' && dt > CFG.STALL_TIMEOUT) ctl.abort('stalled');
        else if (phase === 'decode' && dt > CFG.FIRST_FRAME_TIMEOUT) ctl.abort('first frame timeout');
      }, 1000);
      log('try', f.g, f, `#${f.attempts}${f.got ? ' resume@' + f.got : ''}`);
      try {
        if (FILE) await f.localFile(ctl, touch);
        else { await f.fetchBody(ctl, touch); touch('decode'); await f.attach(ctl); }
        f.state = 'done'; f.err = null; f.kind = null; log('done', f.g, f, `${f.got} B, ${f.requests} req, ${f.resumes} resumed`);
        f.resetBody();
      } catch (e) {
        f.onFail(e);
      } finally {
        clearInterval(wd); f.ctl = null; net.active--;
        // a probe that ended without proving the network works must not leave the probe gate closed
        if (net.down && !isFinite(net.gate)) net.gate = performance.now() + jitter(CFG.BACKOFF[Math.min(net.downStreak, CFG.BACKOFF.length - 1)]);
        f.g.update(); net.pump();
      }
    }
    async fetchBody(ctl, touch) {
      if (!CFG.RESUME) this.resetBody();
      const f = this, resume = CFG.RESUME && f.got > 0 && f.ranges && !!(f.etag || f.lastMod) && f.total > f.got;
      const headers = resume ? { Range: `bytes=${f.got}-`, 'If-Range': f.etag || f.lastMod } : {};
      let r; f.requests++; net.requests++;
      try { r = await fetch(f.url, { signal: ctl.signal, headers, cache: resume || f.fresh ? 'no-store' : 'default' }); }
      catch (e) { throw fail('network', ctl.signal.aborted ? String(ctl.signal.reason) : 'network error'); }
      touch('body'); net.alive();
      if (resume && r.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('Content-Range') || ''); const et = r.headers.get('ETag');
        if (!m || +m[1] !== f.got || +m[3] !== f.total || (f.etag && et && et !== f.etag)) { f.resetBody(); throw fail('incomplete', 'resume refused (different range or file version)'); }
        f.resumes++;
      } else if (r.status === 200) {
        if (resume) { log('resume-full', f.g, f, 'server sent the whole file'); f.resetBody(); }
        const enc = (r.headers.get('Content-Encoding') || 'identity').toLowerCase();
        f.total = enc === 'identity' ? (+r.headers.get('Content-Length') || 0) : 0;
        f.etag = r.headers.get('ETag'); f.lastMod = r.headers.get('Last-Modified');
        f.ranges = /bytes/i.test(r.headers.get('Accept-Ranges') || '') && enc === 'identity';
        const t = r.headers.get('Content-Type') || ''; f.type = t.startsWith('video/') ? t : 'video/mp4';
      } else if (r.status === 416) { f.resetBody(); throw fail('incomplete', 'range not satisfiable'); }
      else {
        const s = r.status, temporary = s === 408 || s === 425 || s === 429 || s >= 500;
        throw fail(temporary ? 'http-temp' : 'http-perm', `HTTP ${s}`, { retryAfter: retryAfterMs(r) });
      }
      const rd = r.body.getReader();
      for (;;) {
        let c; try { c = await rd.read(); } catch (e) { throw fail('network', ctl.signal.aborted ? String(ctl.signal.reason) : 'connection lost'); }
        if (c.done) break;
        f.parts.push(c.value); f.got += c.value.byteLength; touch('body'); net.lastByte = performance.now(); f.g.progress();
      }
      const want = +f.v.dataset.bytes || f.total;
      if (want && f.got !== want) {
        const msg = `incomplete download (${f.got} of ${want} bytes)`; if (f.got > want) f.resetBody();
        throw fail('incomplete', msg);
      }
    }
    attach(ctl) {
      const f = this, v = f.v, blob = new Blob(f.parts, { type: f.type }); f.parts = [];
      if (f.objUrl) { URL.revokeObjectURL(f.objUrl); net.urls--; }
      f.objUrl = URL.createObjectURL(blob); net.urls++;
      v.preload = 'auto'; v.src = f.objUrl;
      return new Promise((res, rej) => {
        if (v.readyState >= 2) return res();
        const done = fn => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); ctl.signal.removeEventListener('abort', ab); fn(); };
        const ok = () => done(res), bad = () => done(() => rej(fail('decode', decodeReason(v.error)))), ab = () => done(() => rej(fail('decode', String(ctl.signal.reason))));
        v.addEventListener('loadeddata', ok); v.addEventListener('error', bad); ctl.signal.addEventListener('abort', ab);
      });
    }
    localFile(ctl, touch) {                          // file:// : no fetch; wait until the whole local file is buffered
      const v = this.v; touch('decode');
      const onp = () => touch('decode'); v.addEventListener('progress', onp);
      v.preload = 'auto'; if (!v.getAttribute('src')) v.src = v.dataset.src;
      return new Promise((res, rej) => {
        const chk = () => {
          if (ctl.signal.aborted) { v.removeEventListener('progress', onp); return rej(fail('decode', String(ctl.signal.reason))); }
          if (v.error) { v.removeEventListener('progress', onp); return rej(fail('local', decodeReason(v.error))); }
          if (fullyBuffered(v) && v.readyState >= 2) { v.removeEventListener('progress', onp); return res(); }
          setTimeout(chk, 100);
        };
        chk();
      });
    }
    dropMedia() {                                   // forget a decoded-but-bad file completely before fetching it again
      const v = this.v; v.removeAttribute('src'); try { v.load(); } catch (e) { }
      if (this.objUrl) { URL.revokeObjectURL(this.objUrl); this.objUrl = null; net.urls--; }
    }
    onFail(e) {
      const f = this, now = performance.now(); f.err = e.message; f.kind = e.kind;
      if (e.kind === 'decode') {
        f.dropMedia(); f.resetBody();
        if (!f.redownloaded) { f.redownloaded = true; f.fresh = true; f.state = 'wait'; f.notBefore = now + 1000; log('decode-fail', f.g, f, e.message + ' -> fresh re-download'); return; }
        f.state = 'failed'; log('failed', f.g, f, e.message); return;
      }
      if (e.kind === 'http-perm' || e.kind === 'local') { f.state = 'failed'; log('failed', f.g, f, e.message); return; }
      // temporary: wait and try again
      const n = Math.min(f.attempts, CFG.BACKOFF.length) - 1;
      let delay = e.kind === 'incomplete' && f.attempts <= 2 ? 1000 : jitter(CFG.BACKOFF[Math.max(0, n)]);
      if (e.retryAfter) delay = Math.max(delay, e.retryAfter);
      f.state = 'wait'; f.notBefore = now + delay;
      if (e.kind === 'network' && now - net.lastByte > 5000) net.markDown(delay);
      log('retry-wait', f.g, f, `${e.message}; next in ${Math.round(delay / 1000)} s`);
    }
  }

  // ---------- loader: page order, parallel downloads, retries ----------
  const net = {
    files: [], cursor: 0, active: 0, down: false, gate: 0, downStreak: 0, lastByte: -Infinity, timer: 0, wakeAt: 0,
    requests: 0, urls: 0,
    markDown(delay) {
      if (!this.down) { this.down = true; this.downStreak = 0; log('net-down'); }
      this.downStreak++; this.gate = performance.now() + (this.downStreak > 1 ? jitter(CFG.BACKOFF[Math.min(this.downStreak - 1, CFG.BACKOFF.length - 1)]) : delay);
    },
    alive() {                                       // a response arrived: the network works
      if (!this.down) return;
      this.down = false; this.downStreak = 0; this.gate = 0; log('net-up');
      const now = performance.now(); let i = 0;
      this.files.forEach(f => { if (f.state === 'wait' && f.kind === 'network') f.notBefore = Math.min(f.notBefore, now + 300 * (i++)); });
      setTimeout(() => this.pump(), 0);
    },
    wake(ms) {                                      // bring every waiting retry forward (e.g. the 'online' event)
      const now = performance.now(); let i = 0;
      this.files.forEach(f => { if (f.state === 'wait') f.notBefore = Math.min(f.notBefore, now + ms + 300 * (i++)); });
      if (this.down) this.gate = Math.min(this.gate, now + ms); this.pump();
    },
    started(g) { return g.started; },
    pump() {
      const now = performance.now();
      // start groups in page order: the next group starts once the current one has nothing pending or downloading
      for (;;) {
        const g = all[this.cursor]; if (!g) break;
        if (!g.started) { g.begin(); }
        if (g.files.some(f => f.state === 'pending' || (f.state === 'active' && !f.slow))) break;
        this.cursor++;
      }
      const limit = this.down ? 1 : CFG.MAX_PARALLEL;
      if (!(this.down && now < this.gate)) {
        const elig = this.files.filter(f => f.g.started && (f.state === 'pending' || (f.state === 'wait' && now >= f.notBefore)));
        // normal: user-requested groups first, then page order; network down: probe the least recently tried file
        elig.sort(this.down ? (a, b) => a.lastTry - b.lastTry : (a, b) => (b.g.prio - a.g.prio) || (a.idx - b.idx));
        while (this.active < limit && elig.length) {
          const f = elig.shift();
          if (f.state === 'pending' && f.unsupported()) { f.state = 'failed'; f.err = 'format not supported by this browser'; f.kind = 'codec'; log('failed', f.g, f, f.err); f.g.update(); continue; }
          f.attempt();
          if (this.down) { this.gate = Infinity; break; }        // one probe; its result decides what happens next
        }
      }
      // wake up for the earliest waiting retry
      let next = Infinity;
      this.files.forEach(f => { if (f.state === 'wait') next = Math.min(next, f.notBefore); });
      if (this.down && isFinite(this.gate)) next = Math.max(next, this.gate);
      if (this.timer && this.wakeAt <= next) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = 0;
      if (isFinite(next)) { this.wakeAt = next; this.timer = setTimeout(() => { this.timer = 0; this.pump(); }, Math.max(50, next - now)); }
    },
    prioritise(g) { g.prio = 1; if (!g.started) g.begin(); this.pump(); },
  };

  class Group {
    constructor(id, vids) {
      this.id = id; this.v = vids;
      this.fps = +vids[0].dataset.fps || 10;
      const decl = GROUPS[id] || {};
      const same = vids.every(x => x.dataset.frames === vids[0].dataset.frames && x.dataset.fps === vids[0].dataset.fps);
      this.kind = vids.length === 1 ? 'single' : (decl.sync && same ? 'sync' : 'free');
      this.state = 'queued';     // queued -> loading (| retrying | error) -> ready -> playing <-> paused ; ended (sync hold)
      this.gen = 0; this.userPaused = false; this.override = false; this.hiddenWasPlaying = false; this.seekResume = false;
      this.timers = new Set(); this.aborts = new Set(); this.scrub = null; this.holding = false;
      this.started = false; this.prio = 0; this.onScreen = true; this.shown = '';
      this.files = vids.map(x => new MFile(this, x));
      vids.forEach(x => {
        x.muted = true; x.playsInline = true; x.preload = 'none';
        x.loop = this.kind !== 'sync'; if (!x.loop) x.removeAttribute('loop');   // sync groups loop under group control
        x.addEventListener('click', () => this.toggle());
      });
      this.makeUI(); this.setStatus('Waiting to load', false); this.mark('queued');
    }

    // ---------- helpers ----------
    later(fn, ms) { const g = this.gen; const h = setTimeout(() => { this.timers.delete(h); if (g === this.gen) fn(); }, ms); this.timers.add(h); return h; }
    clearTimers() { this.timers.forEach(h => clearTimeout(h)); this.timers.clear(); this.holding = false; }   // a cancelled end hold leaves no flag behind
    bump() { this.gen++; this.clearTimers(); const a = [...this.aborts]; this.aborts.clear(); a.forEach(f => f()); return this.gen; }
    wantsPlay() { return this.loaded() && !this.userPaused && (!mgr.globalPaused || this.override) && !document.hidden && !this.scrub; }
    userPlay() { this.userPaused = false; if (mgr.globalPaused) this.override = true; }
    loaded() { return !['queued', 'loading', 'retrying', 'error'].includes(this.state); }
    // running = playing, about to play, holding the last frame before a loop, or settling a seek that will resume
    active() { return this.state === 'playing' || this.state === 'starting' || (this.state === 'ended' && this.holding) || this.seekResume; }
    // what the play button shows: running, or (not loaded yet) going to autoplay once loaded
    intendsPlay() { return !this.userPaused && (this.active() || (!this.loaded() && (!mgr.globalPaused || this.override))); }
    lead() { return this.v[0]; }
    nFrames() { return +this.lead().dataset.frames || Math.round((this.lead().duration || 0) * this.fps); }
    mark(cls) {
      [...new Set(this.v.map(box))].forEach(b => { b.classList.toggle('v-loading', cls === 'loading'); b.classList.toggle('v-queued', cls === 'queued'); });
      if (this.chip) this.btn.hidden = cls === 'queued' || cls === 'loading';   // dataset tiles: no play button before the videos exist
    }
    resume() { if (this.kind === 'sync' && this.state === 'ended') this.restart(); else this.start(); }

    // ---------- UI ----------
    makeUI() {
      const mk = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
      if (this.kind === 'free') {                     // dataset tiles: status chip + play/pause button
        const b0 = box(this.v[0]);
        this.chip = mk('div', 'vchip'); this.chip.hidden = true; b0.appendChild(this.chip);
        this.btn = mk('button', 'vplay', '▶'); this.btn.type = 'button'; this.btn.setAttribute('aria-label', 'Play');
        this.btn.addEventListener('click', e => { e.stopPropagation(); this.toggle(); }); b0.appendChild(this.btn);
        this.retryBtn = mk('button', 'vretry', 'Retry'); this.retryBtn.type = 'button'; this.retryBtn.hidden = true;
        this.retryBtn.addEventListener('click', e => { e.stopPropagation(); this.retry(); }); b0.appendChild(this.retryBtn);
        return;
      }
      let bar = document.querySelector(`.gbar[data-for="${CSS.escape(this.id)}"]`);
      if (!bar) { bar = mk('div', 'gbar'); box(this.v[0]).appendChild(bar); }
      bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Video controls');
      this.btn = mk('button', 'gb-play', '▶'); this.btn.type = 'button'; this.btn.setAttribute('aria-label', 'Play');
      this.rst = mk('button', 'gb-rst', '↺'); this.rst.type = 'button'; this.rst.setAttribute('aria-label', 'Restart'); this.rst.title = 'Restart';
      this.tl = mk('input', 'gb-tl'); this.tl.type = 'range'; this.tl.min = '0'; this.tl.step = 'any'; this.tl.value = '0'; this.tl.setAttribute('aria-label', 'Timeline');
      this.pos = mk('span', 'gb-pos', '');
      this.stat = mk('span', 'gb-stat', ''); this.stat.setAttribute('aria-live', 'polite');
      this.retryBtn = mk('button', 'gb-retry', 'Retry'); this.retryBtn.type = 'button'; this.retryBtn.hidden = true;
      bar.append(this.btn, this.rst, this.tl, this.pos, this.stat, this.retryBtn);
      this.btn.addEventListener('click', () => this.toggle());
      this.rst.addEventListener('click', () => { this.userPlay(); if (this.loaded()) this.restart(); else net.prioritise(this); });
      this.retryBtn.addEventListener('click', () => this.retry());
      this.tl.addEventListener('input', () => this.scrubTo(+this.tl.value));
      this.tl.addEventListener('change', () => this.scrubEnd());
      this.bar = bar; this.paintControls();
    }
    setStatus(text, busy) {
      const el = this.chip || this.stat;
      setText(el, text || ''); if (el.classList.contains('busy') !== !!busy) el.classList.toggle('busy', !!busy);
      if (this.chip && this.chip.hidden !== !text) this.chip.hidden = !text;
    }
    paintControls() {
      const on = this.intendsPlay();
      setText(this.btn, on ? '❚❚' : '▶'); setAttr(this.btn, 'aria-label', on ? 'Pause' : 'Play');
      if (!this.tl) return;
      const L = this.lead(), d = L.duration || 0;
      if (d > 0 && this.loaded()) { const ds = String(d); if (this.tl.max !== ds) this.tl.max = ds; this.showTime(L.currentTime, true); }
      const dis = !this.loaded(); if (this.tl.disabled !== dis) { this.tl.disabled = dis; this.rst.disabled = dis; }
    }
    // timeline + frame counter: rewritten only when the shown frame changes, and per frame only while on screen
    showTime(t, force) {
      if (!this.tl || this.scrub || (!force && !this.onScreen)) return;
      const s = fmtFrame(t, this.fps, this.nFrames()); if (s === this.shown && !force) return;
      this.shown = s; setText(this.pos, s); this.tl.value = String(t);
    }

    // ---------- loading ----------
    begin() { this.started = true; this.state = 'loading'; this.mark('loading'); this.update(); }
    progress() { }                                  // byte progress is not shown (only files done / total)
    update() {                                      // recompute the block state from its files (called on every file change)
      if (!this.started || this.loaded() && this.state !== 'error') return;
      const n = this.files.length, c = { done: 0, failed: 0, wait: 0, busy: 0 };
      this.files.forEach(f => { c[f.state === 'done' ? 'done' : f.state === 'failed' ? 'failed' : f.state === 'wait' ? 'wait' : 'busy']++; });
      if (c.done === n) return this.ready();
      const short = !!this.chip, k = `${c.done}/${n}`;
      if (c.failed && !c.wait && !c.busy) {
        const f = this.files.find(x => x.state === 'failed');
        this.state = 'error'; this.mark(''); this.retryBtn.hidden = false;
        this.setStatus(short ? `Failed: ${f.err}` : `Could not load ${labelOf(f.v)} (${f.name}): ${f.err}`, false);
      } else if (c.wait && !c.busy) {
        this.state = 'retrying'; this.mark('loading'); this.retryBtn.hidden = false;
        const off = typeof navigator.onLine === 'boolean' && !navigator.onLine;
        this.setStatus(off ? (short ? `Offline ${k}` : `Offline — waiting for the network (${k} ready)`) : (short ? `Reconnecting ${k}` : `Reconnecting… (${k} ready)`), true);
      } else {
        this.state = 'loading'; this.mark('loading'); this.retryBtn.hidden = !c.failed;
        this.setStatus(n > 1 ? (short ? `Loading ${k}` : `Loading videos ${k}`) : 'Loading video', true);
      }
      this.paintControls();
    }
    ready() {
      this.state = 'ready'; this.mark(''); this.retryBtn.hidden = true; log('ready', this);
      this.setStatus(this.userPaused ? 'Paused' : ''); this.paintControls();
      if (this.wantsPlay()) this.start();
    }
    retry() {                                       // manual: permanent failures get one more chance, waits are cut short
      if (this.playError) { this.playError = false; this.state = 'ready'; this.retryBtn.hidden = true; this.setStatus(''); if (this.wantsPlay()) this.start(); return; }
      this.files.forEach(f => { if (f.state === 'failed') { f.state = 'pending'; f.redownloaded = false; f.fresh = true; f.attempts = 0; } else if (f.state === 'wait') f.notBefore = 0; });
      if (net.down) net.gate = 0;
      log('manual-retry', this); this.state = 'loading'; this.prio = 1; this.update(); net.pump();
    }
    failPlayback(x, why) {                          // a seek that never completed on local data: stop and offer Retry
      this.bump(); this.v.forEach(y => { try { y.pause(); } catch (e) { } });
      this.state = 'error'; this.playError = true; this.retryBtn.hidden = false; log('play-error', this, null, why);
      this.setStatus(`Playback problem (${why})`, false); this.paintControls();
    }

    // ---------- playback ----------
    toggle() {
      if (this.intendsPlay()) {
        this.userPaused = true; this.override = false;
        if (this.loaded()) this.pause('user'); else this.paintControls();   // before loading ends: keep the choice for later
        return;
      }
      this.userPlay();
      if (this.state === 'error') { this.retry(); return; }
      if (!this.loaded()) { net.prioritise(this); this.paintControls(); return; }   // plays as soon as it has loaded
      this.resume();
    }
    pause(reason) {
      this.bump();
      this.v.forEach(x => { try { x.pause(); } catch (e) { } x.playbackRate = 1; });
      if (reason !== 'scrub') this.seekResume = false;
      if (this.loaded() && this.state !== 'ended') this.state = 'paused';
      if (reason === 'user') this.setStatus('Paused'); else if (this.loaded() && !this.userPaused) this.setStatus('');
      this.paintControls();
    }
    // Bring every video to one time while paused.  A video counts as there only when it is not seeking, has the
    // frame decoded (readyState >= 2) and is within half a frame -- currentTime alone updates before a seek finishes.
    // Resolves {ok:true}, {stale:true} (a newer command took over) or {ok:false, who} (timeout).
    align(t) {
      const g = this.gen, half = 0.5 / this.fps, tgt = x => Math.min(t, Math.max(0, (x.duration || t) - 0.001));
      const near = x => Math.abs(x.currentTime - tgt(x)) <= half;
      const settled = x => !x.seeking && x.readyState >= 2 && near(x) && x._shown !== false;
      this.v.forEach(x => { try { x.pause(); } catch (e) { } });
      this.v.forEach(x => {
        if (near(x)) { if (!x.seeking) x._shown = true; return; }
        x._shown = !hasRVFC;                         // with rVFC, also wait until the seeked frame was presented
        if (hasRVFC) x.requestVideoFrameCallback(() => { x._shown = true; });
        x.currentTime = tgt(x);
      });
      if (this.v.every(settled)) return Promise.resolve({ ok: true });
      return new Promise(res => {
        const t0 = performance.now(); let done = false, h = 0;
        const stop = () => { if (h) { clearTimeout(h); this.timers.delete(h); h = 0; } };
        const end = r => { if (done) return; done = true; stop(); this.aborts.delete(abort); this.v.forEach(x => x.removeEventListener('seeked', chk)); res(r); };
        const abort = () => end({ stale: true }); this.aborts.add(abort);
        const chk = () => {
          if (done) return;
          if (g !== this.gen) return end({ stale: true });
          const wait = this.v.filter(x => !settled(x));
          if (!wait.length) return end({ ok: true });
          // rVFC does not fire for a frame that is not composited (e.g. off screen): accept after 250 ms
          wait.forEach(x => { if (x._shown === false && !x.seeking && x.readyState >= 2 && near(x) && performance.now() - t0 > 250) x._shown = true; });
          if (performance.now() - t0 > CFG.ALIGN_TIMEOUT) return end({ ok: false, who: wait[0] });
          stop(); h = setTimeout(() => { this.timers.delete(h); h = 0; chk(); }, 30); this.timers.add(h);
        };
        this.v.forEach(x => x.addEventListener('seeked', chk));
        chk();
      }).then(r => (g !== this.gen ? { stale: true } : r));
    }
    start() {
      const g = this.bump(); this.state = 'starting'; this.seekResume = false; this.paintControls();
      const go = () => {
        if (g !== this.gen) return;
        this.v.forEach(x => { x.playbackRate = 1; });
        Promise.all(this.v.map(x => x.play())).then(() => {
          if (g !== this.gen) return;
          this.state = 'playing'; if (!this.userPaused) this.setStatus(''); this.paintControls();
        }).catch(err => {
          if (g !== this.gen) return;
          this.v.forEach(x => { try { x.pause(); } catch (e) { } });
          this.state = 'paused';
          this.setStatus(err && err.name === 'NotAllowedError' ? 'Press ▶ to play' : ''); this.paintControls();
        });
      };
      if (this.kind !== 'sync') return go();
      this.align(this.lead().currentTime).then(r => { if (r.ok) go(); else if (!r.stale) this.failPlayback(r.who, 'seek did not complete'); });
    }
    restart() {
      const g = this.bump(); this.state = 'starting'; this.paintControls();
      this.align(0).then(r => {
        if (r.stale || g !== this.gen) return;
        if (!r.ok) return this.failPlayback(r.who, 'seek did not complete');
        this.state = 'paused'; if (this.wantsPlay()) this.start(); else this.paintControls();
      });
    }
    // called on every animation frame by the manager: sync loop point + drift; timeline for bars on screen
    tick() {
      if (this.state !== 'playing') return;
      const L = this.lead();
      if (this.kind === 'sync') {
        if (this.v.every(x => x.ended || x.currentTime >= x.duration - 0.02)) {
          this.state = 'ended'; this.holding = true; this.paintControls();
          this.later(() => { this.holding = false; if (this.wantsPlay()) this.restart(); }, CFG.HOLD_END);
          return;
        }
        const t = L.currentTime;
        for (let i = 1; i < this.v.length; i++) {
          const x = this.v[i]; if (x.ended) continue;
          const d = x.currentTime - t, f = d * this.fps;
          if (Math.abs(f) > CFG.RESYNC_FRAMES) { mgr.stats.resyncs++; this.start(); return; }
          const r = Math.abs(f) > 0.5 ? 1 - Math.max(-CFG.NUDGE_MAX, Math.min(CFG.NUDGE_MAX, d * 0.5)) : 1;
          if (Math.abs(x.playbackRate - r) > 1e-3) x.playbackRate = r;
        }
      }
      this.showTime(L.currentTime, false);
    }
    scrubTo(t) {
      if (!this.loaded()) return;
      if (!this.scrub) { this.scrub = { wasPlaying: this.active() && !this.userPaused }; this.pause('scrub'); }
      this.bump(); if (this.state === 'ended') this.state = 'paused';
      this.v.forEach(x => { if (Math.abs(x.currentTime - t) > 0.5 / this.fps) x.currentTime = Math.min(t, (x.duration || t) - 0.001); });
      this.shown = ''; setText(this.pos, fmtFrame(t, this.fps, this.nFrames()));
    }
    scrubEnd() {
      const s = this.scrub; this.scrub = null; if (!s) return;
      const t = +this.tl.value; this.seekResume = s.wasPlaying;       // rapid steps (keyboard) keep the resume intent
      this.align(t).then(r => {
        if (r.stale) return;
        this.seekResume = false; this.state = 'paused'; this.paintControls();
        if (!r.ok) return this.failPlayback(r.who, 'seek did not complete');
        if (s.wasPlaying && this.wantsPlay()) this.start();
      });
    }
  }

  // ---------- manager: animation-frame ticker, page visibility, pause all ----------
  const mgr = { globalPaused: false, stats: { resyncs: 0 }, net };
  function frame() { all.forEach(g => g.tick()); requestAnimationFrame(frame); }

  function init() {
    const vids = [...document.querySelectorAll('video.gv')];
    const byId = new Map(); let solo = 0;
    vids.forEach(v => { const el = v.closest('[data-group]'); const id = el ? el.dataset.group : ('solo-' + (solo++)); if (!byId.has(id)) byId.set(id, []); byId.get(id).push(v); });
    byId.forEach((vs, id) => all.push(new Group(id, vs)));
    all.forEach(g => g.files.forEach(f => { f.idx = net.files.length; net.files.push(f); }));
    window.__scopeGroups = all; window.__scopeMgr = mgr;           // exposed for testing / debugging only
    // control bars on screen (only decides whether the per-frame timeline text is refreshed; playback is unaffected)
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => es.forEach(e => { const g = e.target.__g; if (g) { g.onScreen = e.isIntersecting; if (g.onScreen) g.showTime(g.lead().currentTime, true); } }));
      all.forEach(g => { if (g.bar) { g.bar.__g = g; io.observe(g.bar); } });
    }
    window.addEventListener('online', () => { log('online'); net.wake(500); all.forEach(g => g.update()); });
    window.addEventListener('offline', () => { log('offline'); all.forEach(g => g.update()); });
    net.pump();
    requestAnimationFrame(frame);

    // a hidden tab pauses the running groups and restores exactly those (plus blocks that finished loading meanwhile)
    document.addEventListener('visibilitychange', () => {
      log(document.hidden ? 'hidden' : 'visible');
      if (document.hidden) all.forEach(g => { g.hiddenWasPlaying = g.active() && !g.userPaused; if (g.hiddenWasPlaying) g.pause('hidden'); });
      else all.forEach(g => { if ((g.hiddenWasPlaying || g.state === 'ready') && g.wantsPlay()) g.resume(); g.hiddenWasPlaying = false; });
    });

    const pa = document.getElementById('pauseAll');
    if (pa) pa.addEventListener('click', () => {
      mgr.globalPaused = !mgr.globalPaused;
      pa.setAttribute('aria-pressed', String(mgr.globalPaused)); pa.textContent = mgr.globalPaused ? '▶ Resume videos' : '❚❚ Pause all videos';
      all.forEach(g => { g.override = false; });
      // resume never clears a group's own pause: groups the reader paused individually stay paused
      if (mgr.globalPaused) all.forEach(g => { if (g.loaded() && g.active()) g.pause('global'); else if (!g.loaded()) g.paintControls(); });
      else all.forEach(g => { if (g.wantsPlay() && !g.active()) g.resume(); else if (!g.loaded()) g.paintControls(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

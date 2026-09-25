/* Interactive long-reconstruction viewer (three.js r147 UMD, vendored; no network).
   Data: window.LONG_DATA[seq][key] written by scripts/website/export_long_viewer.py. */
(function () {
  const METHODS = [
    ["crm", "SCOPE-4D (Ours)"], ["omega_sft", "SCOPE-4D (SFT)"], ["pre_omega", "VGGT-Omega"],
    ["pre_vggt", "VGGT"], ["sm4rt", "SM4RT"], ["endo3r", "Endo3R"]];
  const PRED_RGB = 0x1f5fbf, GT_RGB = 0xd0342c;

  function b64ToBytes(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function decode(rec) {
    const q = new Uint16Array(b64ToBytes(rec.xyz_u16).buffer); const n = rec.n;
    const lo = rec.bbox_lo, hi = rec.bbox_hi; const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) { const a = i % 3; pos[i] = lo[a] + (q[i] / 65535) * (hi[a] - lo[a]); }
    const col = b64ToBytes(rec.rgb_u8);
    const cams = rec.cams ? new Float32Array(b64ToBytes(rec.cams).buffer) : null;
    const gtc = new Float32Array(b64ToBytes(rec.gt_cams).buffer);
    return { pos, col, cams, gtc, offsets: rec.chunk_offsets, n };
  }

  function build(el) {
    const seq = el.dataset.seq; const D = window.LONG_DATA && window.LONG_DATA[seq];
    if (!D || !window.THREE) { el.textContent = "viewer data missing"; return; }
    const W = el.clientWidth, H = parseInt(el.dataset.height || "520");
    const wrap = document.createElement("div"); wrap.className = "lv-wrap"; el.appendChild(wrap);
    const bar = document.createElement("div"); bar.className = "lv-bar"; wrap.appendChild(bar);
    const canvasBox = document.createElement("div"); canvasBox.className = "lv-canvas"; canvasBox.style.height = H + "px"; wrap.appendChild(canvasBox);
    const foot = document.createElement("div"); foot.className = "lv-foot"; wrap.appendChild(foot);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setClearColor(0xffffff, 1); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(W, H); canvasBox.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xffffff);
    const cam = new THREE.PerspectiveCamera(40, W / H, 1, 100000);
    // TrackballControls: free rotation in every direction (OrbitControls stops at the poles).  No inertia, so a frame
    // is drawn only on a real change and the on-demand render loop stays simple.
    const controls = new THREE.TrackballControls(cam, renderer.domElement); controls.staticMoving = true; controls.rotateSpeed = 2.5; controls.zoomSpeed = 1.2; controls.panSpeed = 0.6;
    // zoom limits: the home view sits at 0.9 x the scene diagonal; allow 3x closer and 2x farther, no further

    const decoded = {}; function get(k) { if (!decoded[k]) decoded[k] = decode(D[k]); return decoded[k]; }
    const gt = get("gt"); const lo = D.gt.bbox_lo, hi = D.gt.bbox_hi;
    const centre = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    // initial view: the paper's fixed direction is data-derived; here a diagonal view that shows the whole colon
    // the data's y axis points down (image convention).  Instead of flipping the camera's up vector -- which makes
    // OrbitControls drag in the opposite direction -- the whole scene is turned 180 deg about x and the camera keeps +y up
    const root = new THREE.Group(); root.rotation.x = Math.PI; scene.add(root);
    const centreR = new THREE.Vector3(centre.x, -centre.y, -centre.z);
    const home = () => { controls.reset(); cam.position.copy(centreR).add(new THREE.Vector3(0.35, 0.9, 0.5).normalize().multiplyScalar(diag * 0.9)); cam.up.set(0, 1, 0); cam.lookAt(centreR); controls.target.copy(centreR); controls.update(); };
    controls.minDistance = diag * 0.3; controls.maxDistance = diag * 1.8;
    home();

    function pointsObj(d, size, opacity) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(d.pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(d.col, 3, true));
      const m = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
      return new THREE.Points(g, m);
    }
    function lineObj(arr, color, n) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(arr, 3)); g.setDrawRange(0, n);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
    }
    const gtPts = pointsObj(gt, diag * 0.0025, 0.35); gtPts.visible = false; root.add(gtPts);
    const gtLine = lineObj(gt.gtc, GT_RGB, gt.gtc.length / 3); root.add(gtLine);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.008, 16, 16), new THREE.MeshBasicMaterial({ color: PRED_RGB })); root.add(marker);

    let cur = null, curKey = null, progress = 1, playing = false;
    const state = { showGT: false, showGTpath: true };
    function setMethod(k) {
      if (cur) { root.remove(cur.pts); root.remove(cur.line); cur.pts.geometry.dispose(); cur.line.geometry.dispose(); }
      const d = get(k); const pts = pointsObj(d, diag * 0.0025, 1); const line = lineObj(d.cams, PRED_RGB, d.cams.length / 3);
      root.add(pts); root.add(line); cur = { d, pts, line }; curKey = k;
      bar.querySelectorAll("button[data-m]").forEach(b => b.setAttribute("aria-selected", b.dataset.m === k ? "true" : "false"));
      applyProgress();
      const al = D[k].align; foot.textContent = `${labelOf(k)}` + (al ? ` · ATE ${al.ate_mm.toFixed(1)} mm` : "") + " · drag to rotate, scroll to zoom";
    }
    function labelOf(k) { const m = METHODS.find(x => x[0] === k); return m ? m[1] : k; }
    function applyProgress() {
      if (!cur) return; const d = cur.d; const nC = d.cams.length / 3; const chunks = d.offsets.length - 1;
      const camN = Math.max(2, Math.round(progress * nC)); cur.line.geometry.setDrawRange(0, camN);
      // chunk k covers cameras [30k, 30k+60) in the frozen VGGT-Long setting: reveal chunks whose first camera is reached
      const step = nC > 1 && chunks > 1 ? (nC - 60) / (chunks - 1) : nC; let shown = chunks;
      for (let k = 0; k < chunks; k++) { if (k * step > camN - 1) { shown = k; break; } }
      cur.pts.geometry.setDrawRange(0, d.offsets[Math.max(1, shown)]);
      const i = Math.min(nC - 1, camN - 1); marker.position.set(d.cams[3 * i], d.cams[3 * i + 1], d.cams[3 * i + 2]);
      gtLine.geometry.setDrawRange(0, Math.max(2, Math.round(progress * gt.gtc.length / 3))); gtLine.visible = state.showGTpath;
      slider.value = String(Math.round(progress * 1000)); prog.textContent = `view ${camN} / ${nC}`;
    }
    // controls
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
    const mrow = mk("div", "lv-methods"); METHODS.filter(m => D[m[0]]).forEach(([k, lab]) => { const b = mk("button", "", lab); b.dataset.m = k; b.onclick = () => { setMethod(k); requestRender(); }; mrow.appendChild(b); }); bar.appendChild(mrow);
    const crow = mk("div", "lv-ctrl");
    const play = mk("button", "lv-play", "▶"); crow.appendChild(play);
    const slider = mk("input"); slider.type = "range"; slider.min = "0"; slider.max = "1000"; slider.value = "1000"; crow.appendChild(slider);
    const prog = mk("span", "lv-prog", ""); crow.appendChild(prog);
    const cbGT = mk("label", "", ""); const iGT = mk("input"); iGT.type = "checkbox"; cbGT.appendChild(iGT); cbGT.appendChild(document.createTextNode(" GT cloud")); crow.appendChild(cbGT);
    const cbP = mk("label", "", ""); const iP = mk("input"); iP.type = "checkbox"; iP.checked = true; cbP.appendChild(iP); cbP.appendChild(document.createTextNode(" GT trajectory")); crow.appendChild(cbP);
    const reset = mk("button", "", "Reset view"); crow.appendChild(reset);
    bar.appendChild(crow);
    slider.oninput = () => { progress = parseInt(slider.value) / 1000; playing = false; play.textContent = "▶"; requestRender(); applyProgress(); };
    iGT.onchange = () => { state.showGT = iGT.checked; gtPts.visible = state.showGT; requestRender(); };
    iP.onchange = () => { state.showGTpath = iP.checked; gtLine.visible = state.showGTpath; requestRender(); };
    play.onclick = () => { playing = !playing; play.textContent = playing ? "❚❚" : "▶"; requestRender(); if (playing && progress >= 1) progress = 0; };
    reset.onclick = () => { home(); requestRender(); };
    // on-demand rendering: a frame is drawn only while replaying, while the orbit controls are still moving
    // (damping), or once after a change.  Scrolling the viewer off screen does not pause a replay: its clock keeps
    // running and only drawing is skipped.  A hidden tab stops everything (the replay resumes where it was).
    let last = 0, raf = 0, onScreen = false;
    function requestRender() { if (!raf && (onScreen || playing) && !document.hidden) raf = requestAnimationFrame(loop); }
    function loop(now) {
      raf = 0; const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
      if (playing) { progress = Math.min(1, progress + dt / 25); applyProgress(); if (progress >= 1) { playing = false; play.textContent = "▶"; } }
      if (onScreen) { controls.update(); renderer.render(scene, cam); }
      if (playing || interacting) requestRender(); else last = 0;
    }
    // TrackballControls only notices pointer / wheel input inside update(): keep rendering from "start" until "end"
    let interacting = false;
    controls.addEventListener("start", () => { interacting = true; requestRender(); });
    controls.addEventListener("end", () => { interacting = false; requestRender(); });
    controls.addEventListener("change", requestRender);
    new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) requestRender(); else if (raf && !playing) { cancelAnimationFrame(raf); raf = 0; last = 0; } }).observe(canvasBox);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } last = 0; } else requestRender(); });
    window.addEventListener("resize", () => { const w = el.clientWidth; renderer.setSize(w, H); cam.aspect = w / H; cam.updateProjectionMatrix(); controls.handleResize(); requestRender(); });
    setMethod(el.dataset.method || "crm"); requestRender();
  }
  document.querySelectorAll(".long-viewer").forEach(build);
})();

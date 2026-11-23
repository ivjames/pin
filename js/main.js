// Cornerpin editor: wiring between the model, the WebGL renderer, the editing overlay and the UI.

import { Renderer, SHADERS, effectiveFrame } from './renderer.js';
import { pointInPoly, closestOnSegment, bboxFrame, snapPoint } from './geometry.js';
import { newProject, quadShape, boxShapes, sanitize, History, autosave, loadSaved, uid } from './state.js';
import { media, loadAll, importFiles, remove as removeMedia, findByName, setPlaying, restartAll } from './media.js';
import { requestPersistence, storageEstimate } from './store.js';
import * as ex from './exporter.js';

const $ = (sel) => document.querySelector(sel);
const HIT = 10;      // px radius for grabbing a point
const SNAP = 10;     // px radius for snapping
const WELD = 1e-6;   // points closer than this (normalized) move together
const LIMIT = [-0.5, 1.5];

const app = {
  project: newProject(),
  history: new History(),
  sel: { shapeId: null, point: -1, frame: -1 },
  editFrame: false,
  guides: true,
  testPattern: false,
  playing: true,
  clock: 0,
  lastNow: performance.now(),
  busy: false,       // true while an offline export owns the renderer
  recording: false,
  drag: null,
  snapMark: null,
  view: { ox: 0, oy: 0, scale: 1 },
  outWin: null,
  outCtx: null,
};
window.cornerpin = app; // handy for debugging from the console

const sceneCanvas = $('#scene');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
let renderer;

// ---------- helpers ----------

const size = () => [app.project.output.w, app.project.output.h];
const shapeById = (id) => app.project.shapes.find((s) => s.id === id) || null;
const selected = () => shapeById(app.sel.shapeId);
const clampPt = (p) => [Math.max(LIMIT[0], Math.min(LIMIT[1], p[0])), Math.max(LIMIT[0], Math.min(LIMIT[1], p[1]))];

function toScreen(p) {
  const [W, H] = size();
  return [app.view.ox + p[0] * W * app.view.scale, app.view.oy + p[1] * H * app.view.scale];
}
function toNorm(x, y) {
  const [W, H] = size();
  return [(x - app.view.ox) / (W * app.view.scale), (y - app.view.oy) / (H * app.view.scale)];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

let msgTimer = null;
function say(text, isError = false) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/** Record an undo step, autosave and refresh the panels. */
function commit(refresh = true) {
  if (app.history.commit(app.project)) autosave(app.project);
  if (refresh) refreshUI();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undo').disabled = !app.history.past.length;
  $('#redo').disabled = !app.history.future.length;
}

function setProject(project, { resetHistory = false } = {}) {
  app.project = project;
  if (!shapeById(app.sel.shapeId)) app.sel = { shapeId: null, point: -1, frame: -1 };
  if (resetHistory) app.history.reset(project);
  renderer.setSize(project.output.w, project.output.h);
  layout();
  refreshUI();
  updateHistoryButtons();
}

function select(shapeId, point = -1) {
  if (app.sel.shapeId !== shapeId) app.editFrame = false;
  app.sel = { shapeId, point, frame: -1 };
  refreshUI();
}

// ---------- layout ----------

function layout() {
  const stage = $('#stage');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const [W, H] = size();
  const pad = 48;
  const scale = Math.max(0.01, Math.min((sw - pad * 2) / W, (sh - pad * 2) / H));
  app.view = { scale, ox: (sw - W * scale) / 2, oy: (sh - H * scale) / 2 };
  Object.assign(sceneCanvas.style, {
    left: app.view.ox + 'px', top: app.view.oy + 'px', width: W * scale + 'px', height: H * scale + 'px',
  });
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(sw * dpr);
  overlay.height = Math.round(sh * dpr);
}

// ---------- shape operations ----------

function addShapes(shapes) {
  app.project.shapes.push(...shapes);
  app.sel = { shapeId: shapes[shapes.length - 1].id, point: -1, frame: -1 };
  app.editFrame = false;
  commit();
}

function deleteShape(id) {
  const i = app.project.shapes.findIndex((s) => s.id === id);
  if (i < 0) return;
  app.project.shapes.splice(i, 1);
  if (app.sel.shapeId === id) app.sel = { shapeId: null, point: -1, frame: -1 };
  commit();
}

function duplicateShape(id) {
  const s = shapeById(id);
  if (!s) return;
  const copy = JSON.parse(JSON.stringify(s));
  copy.id = uid();
  copy.name = s.name + ' copy';
  const [W, H] = size();
  const d = [24 / W, 24 / H];
  copy.pts = copy.pts.map((p) => [p[0] + d[0], p[1] + d[1]]);
  if (copy.frame) copy.frame = copy.frame.map((p) => [p[0] + d[0], p[1] + d[1]]);
  app.project.shapes.splice(app.project.shapes.indexOf(s) + 1, 0, copy);
  app.sel = { shapeId: copy.id, point: -1, frame: -1 };
  commit();
}

function moveLayer(id, dir) {
  const arr = app.project.shapes;
  const i = arr.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
}

/** Keep the content frame consistent when the number of outline points changes. */
function beforePointCountChange(shape) {
  if (shape.pts.length === 4) shape.frame = shape.pts.map((p) => [p[0], p[1]]);
  else if (!shape.frame) shape.frame = bboxFrame(shape.pts);
}
function afterPointCountChange(shape) {
  if (shape.pts.length === 4) { shape.frame = null; app.editFrame = false; }
}

function insertPoint(shape, edgeIdx, p) {
  beforePointCountChange(shape);
  shape.pts.splice(edgeIdx + 1, 0, [p[0], p[1]]);
  afterPointCountChange(shape);
  return edgeIdx + 1;
}

function removePoint(shape, idx) {
  if (shape.pts.length <= 3) { say('A shape needs at least 3 points.', true); return false; }
  beforePointCountChange(shape);
  shape.pts.splice(idx, 1);
  afterPointCountChange(shape);
  return true;
}

/** Points in other shapes that sit exactly on this one and should move with it. */
function weldedWith(shape, idx) {
  const p = shape.pts[idx];
  const out = [];
  for (const s of app.project.shapes) {
    if (s === shape) continue;
    s.pts.forEach((q, i) => { if (Math.abs(q[0] - p[0]) < WELD && Math.abs(q[1] - p[1]) < WELD) out.push({ shape: s, idx: i }); });
  }
  return out;
}

function snapCandidates(exclude) {
  const out = [];
  for (const s of app.project.shapes) {
    if (!s.visible) continue;
    s.pts.forEach((p, i) => { if (!exclude(s, i)) out.push(p); });
  }
  return out;
}

// ---------- pointer interaction ----------

function hitTest(mx, my) {
  const m = [mx, my];
  const sel = selected();
  if (sel && app.editFrame && sel.pts.length !== 4) {
    const frame = effectiveFrame(sel);
    for (let i = 0; i < 4; i++) if (dist(toScreen(frame[i]), m) <= HIT) return { type: 'frame', shape: sel, idx: i };
  }
  const order = [...app.project.shapes].reverse().filter((s) => s.visible);
  if (sel && sel.visible) { order.splice(order.indexOf(sel), 1); order.unshift(sel); }
  for (const s of order) {
    let best = -1, bestD = HIT;
    s.pts.forEach((p, i) => { const d = dist(toScreen(p), m); if (d <= bestD) { bestD = d; best = i; } });
    if (best >= 0) return { type: 'point', shape: s, idx: best };
  }
  if (sel && sel.visible) {
    for (let i = 0; i < sel.pts.length; i++) {
      const a = toScreen(sel.pts[i]), b = toScreen(sel.pts[(i + 1) % sel.pts.length]);
      const c = closestOnSegment(m, a, b);
      if (dist(c.pt, m) <= 6) return { type: 'edge', shape: sel, idx: i, at: toNorm(c.pt[0], c.pt[1]) };
    }
  }
  const n = toNorm(mx, my);
  for (const s of [...app.project.shapes].reverse()) {
    if (s.visible && pointInPoly(n, s.pts)) return { type: 'body', shape: s };
  }
  return null;
}

function localXY(e) {
  const r = overlay.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || app.busy) return;
  const [mx, my] = localXY(e);
  const hit = hitTest(mx, my);
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (!hit) { select(null); return; }
  overlay.setPointerCapture(e.pointerId);
  const n = toNorm(mx, my);
  if (hit.type === 'frame') {
    if (!hit.shape.frame) hit.shape.frame = effectiveFrame(hit.shape).map((p) => [p[0], p[1]]);
    app.sel = { shapeId: hit.shape.id, point: -1, frame: hit.idx };
    app.drag = { type: 'frame', shape: hit.shape, idx: hit.idx, moved: false };
  } else if (hit.type === 'point' || hit.type === 'edge') {
    let idx = hit.idx, inserted = false;
    if (hit.type === 'edge') { idx = insertPoint(hit.shape, hit.idx, hit.at); inserted = true; }
    const welded = e.altKey || inserted ? [] : weldedWith(hit.shape, idx);
    const changedSel = app.sel.shapeId !== hit.shape.id;
    if (changedSel) app.editFrame = false;
    app.sel = { shapeId: hit.shape.id, point: idx, frame: -1 };
    app.drag = { type: 'point', shape: hit.shape, idx, welded, moved: inserted };
    if (changedSel || inserted) refreshUI();
  } else {
    if (app.sel.shapeId !== hit.shape.id || app.sel.point !== -1) select(hit.shape.id);
    app.drag = {
      type: 'shape', shape: hit.shape, start: n, moved: false,
      pts: hit.shape.pts.map((p) => [p[0], p[1]]),
      frame: hit.shape.frame ? hit.shape.frame.map((p) => [p[0], p[1]]) : null,
    };
  }
});

overlay.addEventListener('pointermove', (e) => {
  const [mx, my] = localXY(e);
  const d = app.drag;
  if (!d) {
    const hit = app.busy ? null : hitTest(mx, my);
    overlay.style.cursor = !hit ? 'default' : hit.type === 'body' ? 'move' : hit.type === 'edge' ? 'copy' : 'crosshair';
    return;
  }
  const [W, H] = size();
  const tol = SNAP / app.view.scale;
  const useSnap = !e.metaKey;
  let n = clampPt(toNorm(mx, my));
  app.snapMark = null;

  if (d.type === 'point') {
    if (useSnap) {
      const moving = new Set(d.welded.map((w) => w.shape.id + ':' + w.idx));
      const cands = snapCandidates((s, i) => s === d.shape || moving.has(s.id + ':' + i));
      const r = snapPoint(n, cands, [W, H], tol);
      n = r.pt;
      if (r.snapped) app.snapMark = n;
    }
    d.shape.pts[d.idx] = n;
    for (const w of d.welded) w.shape.pts[w.idx] = [n[0], n[1]];
    d.moved = true;
  } else if (d.type === 'frame') {
    if (useSnap) {
      const r = snapPoint(n, snapCandidates(() => false), [W, H], tol);
      n = r.pt;
      if (r.snapped) app.snapMark = n;
    }
    d.shape.frame[d.idx] = n;
    d.moved = true;
  } else if (d.type === 'shape') {
    let dx = n[0] - d.start[0], dy = n[1] - d.start[1];
    if (Math.hypot(dx * W, dy * H) * app.view.scale < 3 && !d.moved) return;
    if (useSnap) {
      const cands = snapCandidates((s) => s === d.shape);
      let best = null, bestD = tol;
      for (const p of d.pts) {
        const moved = [p[0] + dx, p[1] + dy];
        const r = snapPoint(moved, cands, [W, H], tol);
        if (!r.snapped) continue;
        const dd = Math.hypot((r.pt[0] - moved[0]) * W, (r.pt[1] - moved[1]) * H);
        if (dd <= bestD) { bestD = dd; best = { adj: [r.pt[0] - moved[0], r.pt[1] - moved[1]], at: r.pt }; }
      }
      if (best) { dx += best.adj[0]; dy += best.adj[1]; app.snapMark = best.at; }
    }
    d.shape.pts = d.pts.map((p) => [p[0] + dx, p[1] + dy]);
    if (d.frame) d.shape.frame = d.frame.map((p) => [p[0] + dx, p[1] + dy]);
    d.moved = true;
  }
});

function endDrag(e) {
  const d = app.drag;
  if (!d) return;
  app.drag = null;
  app.snapMark = null;
  try { overlay.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
  if (d.moved) commit();
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

// ---------- keyboard ----------

function nudge(dx, dy) {
  const s = selected();
  if (!s) return false;
  const [W, H] = size();
  const d = [dx / W, dy / H];
  const move = (p) => clampPt([p[0] + d[0], p[1] + d[1]]);
  if (app.sel.frame >= 0 && s.frame) s.frame[app.sel.frame] = move(s.frame[app.sel.frame]);
  else if (app.sel.point >= 0) {
    const welded = weldedWith(s, app.sel.point);
    s.pts[app.sel.point] = move(s.pts[app.sel.point]);
    for (const w of welded) w.shape.pts[w.idx] = [...s.pts[app.sel.point]];
  } else {
    s.pts = s.pts.map(move);
    if (s.frame) s.frame = s.frame.map(move);
  }
  return true;
}

let nudgeTimer = null;
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
    // Typing fields and menus keep every key; sliders, checkboxes and color wells keep only arrows and space.
    const passive = t instanceof HTMLInputElement && ['range', 'checkbox', 'color'].includes(t.type);
    if (!passive) {
      if (e.key === 'Escape' || e.key === 'Enter') t.blur();
      return;
    }
    if (e.key.startsWith('Arrow') || e.key === ' ') return;
  }
  if ($('#exportDlg').open || app.busy) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key;
  if (mod && key.toLowerCase() === 'z') {
    e.preventDefault();
    const p = e.shiftKey ? app.history.redo() : app.history.undo();
    if (p) { setProject(sanitizeKeepIds(p)); autosave(app.project); }
  } else if (mod && key.toLowerCase() === 'd') {
    e.preventDefault();
    if (app.sel.shapeId) duplicateShape(app.sel.shapeId);
  } else if (key === 'Delete' || key === 'Backspace') {
    const s = selected();
    if (!s) return;
    e.preventDefault();
    if (app.sel.point >= 0) {
      if (removePoint(s, app.sel.point)) { app.sel.point = -1; commit(); }
    } else deleteShape(s.id);
  } else if (key.startsWith('Arrow')) {
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
    if (v && nudge(v[0], v[1])) {
      e.preventDefault();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => commit(false), 350);
    }
  } else if (key === 'Escape') select(null);
  else if (key === ' ') { e.preventDefault(); togglePlay(); }
  else if (key.toLowerCase() === 'g' && !mod) { app.guides = !app.guides; $('#guides').checked = app.guides; }
});

// History snapshots are our own output, so they only need a structural pass.
const sanitizeKeepIds = (p) => sanitize(p);

// ---------- overlay drawing ----------

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const sel = selected();
  octx.lineJoin = 'round';

  for (const s of app.project.shapes) {
    if (!s.visible) continue;
    const isSel = s === sel;
    octx.beginPath();
    s.pts.forEach((p, i) => { const [x, y] = toScreen(p); i ? octx.lineTo(x, y) : octx.moveTo(x, y); });
    octx.closePath();
    octx.lineWidth = isSel ? 2 : 1;
    octx.strokeStyle = isSel ? '#ffb020' : 'rgba(255,255,255,.45)';
    octx.stroke();
    s.pts.forEach((p, i) => {
      const [x, y] = toScreen(p);
      octx.beginPath();
      octx.arc(x, y, isSel ? 6 : 3, 0, Math.PI * 2);
      const active = isSel && app.sel.point === i;
      octx.fillStyle = active ? '#ffb020' : isSel ? '#15161a' : 'rgba(255,255,255,.7)';
      octx.fill();
      if (isSel) { octx.lineWidth = 2; octx.strokeStyle = '#ffb020'; octx.stroke(); }
    });
  }

  if (sel && sel.visible && sel.pts.length !== 4) {
    const frame = effectiveFrame(sel);
    octx.beginPath();
    frame.forEach((p, i) => { const [x, y] = toScreen(p); i ? octx.lineTo(x, y) : octx.moveTo(x, y); });
    octx.closePath();
    octx.setLineDash([6, 5]);
    octx.lineWidth = 1.5;
    octx.strokeStyle = app.editFrame ? '#00d1ff' : 'rgba(0,209,255,.45)';
    octx.stroke();
    octx.setLineDash([]);
    if (app.editFrame) {
      frame.forEach((p, i) => {
        const [x, y] = toScreen(p);
        octx.fillStyle = app.sel.frame === i ? '#00d1ff' : '#15161a';
        octx.strokeStyle = '#00d1ff';
        octx.lineWidth = 2;
        octx.fillRect(x - 6, y - 6, 12, 12);
        octx.strokeRect(x - 6, y - 6, 12, 12);
      });
    }
  }

  if (app.snapMark) {
    const [x, y] = toScreen(app.snapMark);
    octx.beginPath();
    octx.arc(x, y, 11, 0, Math.PI * 2);
    octx.lineWidth = 2;
    octx.strokeStyle = '#7cff6b';
    octx.stroke();
  }
}

/** Outlines and the active point, drawn on the projector so you can align while looking at the surface. */
function drawOutputGuides(ctx, W, H) {
  const sel = selected();
  const px = (p) => [p[0] * W, p[1] * H];
  const unit = Math.max(1, Math.round(H / 540));
  ctx.lineJoin = 'round';
  for (const s of app.project.shapes) {
    if (!s.visible) continue;
    ctx.beginPath();
    s.pts.forEach((p, i) => { const [x, y] = px(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.lineWidth = (s === sel ? 2 : 1) * unit;
    ctx.strokeStyle = s === sel ? '#ffb020' : 'rgba(255,255,255,.8)';
    ctx.stroke();
  }
  if (!sel) return;
  let active = null;
  if (app.sel.frame >= 0 && sel.frame) active = sel.frame[app.sel.frame];
  else if (app.sel.point >= 0) active = sel.pts[app.sel.point];
  sel.pts.forEach((p) => {
    const [x, y] = px(p);
    ctx.beginPath();
    ctx.arc(x, y, 4 * unit, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb020';
    ctx.fill();
  });
  if (active) {
    const [x, y] = px(active);
    const r = 22 * unit;
    ctx.lineWidth = unit;
    ctx.strokeStyle = '#00ff88';
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- main loop ----------

let loopToken = 0;
let lastTick = 0;

function schedule() {
  const token = ++loopToken;
  let host = window;
  try {
    const w = app.outWin;
    if (w && !w.closed && w.document.visibilityState === 'visible' && document.visibilityState !== 'visible') host = w;
  } catch (_) { /* output window navigated away */ }
  host.requestAnimationFrame(() => tick(token));
}

function tick(token) {
  if (token !== loopToken) return;
  const now = performance.now();
  lastTick = now;
  const dt = Math.min(0.25, (now - app.lastNow) / 1000);
  app.lastNow = now;
  if (!app.busy) {
    if (app.playing) app.clock += dt;
    try {
      renderer.render(app.project, app.clock, media, { testPattern: app.testPattern && !app.recording });
      presentOutput();
    } catch (err) {
      console.error(err);
    }
  }
  drawOverlay();
  schedule();
}
// rAF stops when the host window is hidden or closed; this restarts the loop on whichever window is live.
setInterval(() => { if (performance.now() - lastTick > 600) schedule(); }, 500);

function presentOutput() {
  const w = app.outWin;
  if (!w) return;
  if (w.closed) { app.outWin = null; app.outCtx = null; $('#openOut').textContent = 'Open output'; return; }
  try {
    const c = w.document.getElementById('out');
    if (!c) return;
    const [W, H] = size();
    if (c.width !== W || c.height !== H || !app.outCtx || app.outCtx.canvas !== c) {
      c.width = W;
      c.height = H;
      app.outCtx = c.getContext('2d', { alpha: false });
    }
    app.outCtx.drawImage(sceneCanvas, 0, 0);
    if (app.guides && !app.recording) drawOutputGuides(app.outCtx, W, H);
  } catch (_) { /* window still loading */ }
}

function openOutput() {
  if (app.outWin && !app.outWin.closed) { app.outWin.focus(); return; }
  const w = window.open('output.html', 'cornerpin-output', 'popup=yes,width=960,height=540');
  if (!w) { say('The browser blocked the output window. Allow pop-ups for this site.', true); return; }
  app.outWin = w;
  app.outCtx = null;
  $('#openOut').textContent = 'Focus output';
}

function togglePlay() {
  app.playing = !app.playing;
  setPlaying(app.playing);
  $('#playPause').textContent = app.playing ? 'Pause' : 'Play';
}

// ---------- panels ----------

function refreshUI() {
  renderLayers();
  renderProps();
  renderMedia();
  $('#empty').hidden = app.project.shapes.length > 0;
  if (document.activeElement !== $('#projName')) $('#projName').value = app.project.name;
  syncSizeUI();
}

function contentSwatch(s) {
  const c = s.content;
  if (c.type === 'solid') return c.color;
  if (c.type === 'media') return '#555a66';
  return `linear-gradient(135deg, ${c.color}, ${c.color2})`;
}

function renderLayers() {
  const box = $('#layers');
  box.replaceChildren();
  const shapes = app.project.shapes;
  if (!shapes.length) { box.append(h('div', { class: 'none' }, 'No shapes yet.')); return; }
  [...shapes].reverse().forEach((s) => {
    const i = shapes.indexOf(s);
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const sw = h('span', { class: 'swatch' });
    sw.style.background = contentSwatch(s);
    box.append(h('div', { class: 'layer' + (s.id === app.sel.shapeId ? ' sel' : ''), onclick: () => select(s.id) },
      h('button', { title: s.visible ? 'Hide' : 'Show', 'aria-label': s.visible ? 'Hide layer' : 'Show layer', class: s.visible ? 'on' : '',
        onclick: stop(() => { s.visible = !s.visible; commit(); }) }, s.visible ? 'On' : 'Off'),
      sw,
      h('span', { class: 'nm' }, s.name),
      h('button', { title: 'Move up', 'aria-label': 'Move layer up', disabled: i === shapes.length - 1, onclick: stop(() => moveLayer(s.id, 1)) }, '↑'),
      h('button', { title: 'Move down', 'aria-label': 'Move layer down', disabled: i === 0, onclick: stop(() => moveLayer(s.id, -1)) }, '↓'),
    ));
  });
}

function row(label, control) {
  return h('div', { class: 'row' }, h('label', {}, label), control);
}

function renderProps() {
  const box = $('#props');
  box.replaceChildren();
  const s = selected();
  if (!s) { box.append(h('div', { class: 'none' }, 'Select a shape to edit it.')); return; }
  const c = s.content;
  const live = (fn) => (e) => { fn(e.target); };                     // while dragging a control
  const done = (fn) => (e) => { fn(e.target); commit(); };           // on release: undo step + refresh
  const range = (value, min, max, step, set) =>
    h('input', { type: 'range', min, max, step, value, oninput: live((t) => set(Number(t.value))), onchange: () => commit(false) });
  const opt = (value, text, cur) => h('option', { value, selected: value === cur }, text);

  box.append(row('Name', h('input', { type: 'text', value: s.name, onchange: done((t) => { s.name = t.value.trim() || 'Shape'; }) })));

  box.append(row('Content', h('select', { onchange: done((t) => {
    c.type = t.value;
    if (c.type === 'media' && !media.get(c.mediaId)) {
      const first = [...media.values()].find((m) => !m.error);
      if (first) { c.mediaId = first.id; c.mediaName = first.name; }
    }
  }) }, opt('solid', 'Solid color', c.type), opt('gradient', 'Gradient', c.type), opt('shader', 'Shader effect', c.type), opt('media', 'Video or image', c.type))));

  const color = (key) => h('input', { type: 'color', value: c[key], oninput: live((t) => { c[key] = t.value; }), onchange: () => commit() });

  if (c.type === 'solid') box.append(row('Color', color('color')));
  if (c.type === 'gradient' || c.type === 'shader') {
    box.append(row('Colors', h('div', { class: 'pair' }, color('color'), color('color2'))));
  }
  if (c.type === 'gradient') {
    box.append(row('Style', h('select', { onchange: done((t) => { c.gradType = t.value; }) }, opt('linear', 'Linear', c.gradType), opt('radial', 'Radial', c.gradType))));
    if (c.gradType === 'linear') box.append(row('Angle', range(c.angle, 0, 360, 1, (v) => { c.angle = v; })));
  }
  if (c.type === 'shader') {
    box.append(row('Effect', h('select', { onchange: done((t) => { c.shader = t.value; }) }, SHADERS.map((sh) => opt(sh.id, sh.name, c.shader)))));
    box.append(row('Speed', range(c.speed, 0, 4, 0.05, (v) => { c.speed = v; })));
    box.append(row('Density', range(c.scale, 0.25, 6, 0.05, (v) => { c.scale = v; })));
    if (['stripes', 'rainbow', 'scanner'].includes(c.shader)) box.append(row('Angle', range(c.angle, 0, 360, 1, (v) => { c.angle = v; })));
  }
  if (c.type === 'media') {
    const items = [...media.values()];
    const missing = !media.get(c.mediaId);
    box.append(row('Source', h('select', { onchange: done((t) => {
      const m = media.get(t.value);
      if (m) { c.mediaId = m.id; c.mediaName = m.name; }
    }) },
      missing ? h('option', { value: '', selected: true }, c.mediaName ? `Missing: ${c.mediaName}` : 'None imported yet') : null,
      items.map((m) => opt(m.id, m.name, c.mediaId)))));
    box.append(row('Fit', h('select', { onchange: done((t) => { s.fit = t.value; }) },
      opt('fill', 'Stretch to frame', s.fit), opt('cover', 'Cover (crop)', s.fit), opt('contain', 'Contain (bars)', s.fit))));
  }

  box.append(row('Orientation', h('div', { class: 'pair' },
    h('button', { onclick: () => { s.rot = (s.rot + 1) % 4; commit(); }, title: 'Rotate content 90 degrees' }, 'Rotate'),
    h('button', { class: s.flipH ? 'on' : '', onclick: () => { s.flipH = !s.flipH; commit(); } }, 'Flip H'),
    h('button', { class: s.flipV ? 'on' : '', onclick: () => { s.flipV = !s.flipV; commit(); } }, 'Flip V'))));
  box.append(row('Opacity', range(s.opacity, 0, 1, 0.01, (v) => { s.opacity = v; })));
  box.append(row('Blend', h('select', { onchange: done((t) => { s.blend = t.value; }) },
    opt('normal', 'Normal', s.blend), opt('add', 'Add', s.blend), opt('screen', 'Screen', s.blend), opt('multiply', 'Multiply', s.blend))));

  if (s.pts.length === 4) {
    box.append(h('p', { class: 'note' }, '4 points: the outline is also the content frame.'));
  } else {
    box.append(h('p', { class: 'note' }, `${s.pts.length} points: content is warped by a separate 4-corner frame (dashed).`));
    box.append(h('div', { class: 'actions' },
      h('button', { class: app.editFrame ? 'on' : '', onclick: () => { app.editFrame = !app.editFrame; app.sel.frame = -1; renderProps(); } },
        app.editFrame ? 'Done editing frame' : 'Edit content frame'),
      h('button', { onclick: () => { s.frame = bboxFrame(s.pts); commit(); } }, 'Reset frame to bounds')));
  }

  box.append(h('div', { class: 'actions' },
    h('button', { onclick: () => duplicateShape(s.id), title: 'Cmd+D' }, 'Duplicate'),
    h('button', { class: 'danger', onclick: () => deleteShape(s.id) }, 'Delete shape')));
}

const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

function renderMedia() {
  const box = $('#mediaList');
  box.replaceChildren();
  if (!media.size) { box.append(h('div', { class: 'none' }, 'Import video or image files, or drop them on the canvas.')); }
  for (const m of media.values()) {
    const meta = m.error ? m.error : `${m.w}x${m.h}${m.kind === 'video' ? ' ' + m.duration.toFixed(1) + 's' : ''} ${fmtSize(m.size || 0)}`;
    box.append(h('div', { class: 'media' + (m.error ? ' bad' : ''), title: `${m.name}\n${meta}`, onclick: () => assignMedia(m) },
      h('span', { class: 'nm' }, m.name),
      h('span', { class: 'meta' }, meta),
      h('button', { title: 'Remove from library', 'aria-label': `Remove ${m.name}`, onclick: async (e) => {
        e.stopPropagation();
        renderer.dropTexture(m.id);
        await removeMedia(m.id);
        refreshUI();
        updateStorage();
      } }, 'x')));
  }
}

function assignMedia(m) {
  const s = selected();
  if (!s) { say('Select a shape first, then click a media item to use it.'); return; }
  if (m.error) { say(m.error, true); return; }
  s.content.type = 'media';
  s.content.mediaId = m.id;
  s.content.mediaName = m.name;
  commit();
}

async function handleFiles(files) {
  const list = [...files];
  if (!list.length) return;
  say('Importing...');
  try {
    const added = await importFiles(list);
    if (!added.length) { say('No video or image files found.', true); return; }
    requestPersistence();
    const bad = added.filter((m) => m.error);
    const good = added.filter((m) => !m.error);
    if (good.length && selected()) assignMedia(good[0]);
    refreshUI();
    updateStorage();
    say(bad.length ? `${bad.length} file(s) could not be decoded.` : `Imported ${good.length} file(s).`, bad.length > 0);
  } catch (err) {
    console.error(err);
    say('Import failed: ' + (err.message || err), true);
  }
}

async function updateStorage() {
  const est = await storageEstimate();
  $('#storage').textContent = est && est.quota ? `Storage: ${fmtSize(est.usage || 0)} of ${fmtSize(est.quota)}` : '';
}

/** Reconnect media references by file name after importing a layout. */
function relinkMedia(project) {
  let missing = 0;
  for (const s of project.shapes) {
    const c = s.content;
    if (c.type !== 'media') continue;
    if (media.get(c.mediaId)) continue;
    const m = c.mediaName ? findByName(c.mediaName) : null;
    if (m) c.mediaId = m.id;
    else missing++;
  }
  return missing;
}

// ---------- output size ----------

const SIZES = [[1280, 720], [1920, 1080], [1920, 1200], [2560, 1440], [3840, 2160]];

function syncSizeUI() {
  const sel = $('#outSize');
  const { w, h: hh } = app.project.output;
  if (!sel.options.length) {
    for (const [a, b] of SIZES) sel.append(h('option', { value: `${a}x${b}` }, `${a} x ${b}`));
    sel.append(h('option', { value: 'match' }, 'Match output window'));
    sel.append(h('option', { value: 'custom' }, 'Custom'));
  }
  const key = `${w}x${hh}`;
  const preset = SIZES.some(([a, b]) => a === w && b === hh);
  if (document.activeElement !== sel) sel.value = preset ? key : 'custom';
  $('#customSize').hidden = sel.value !== 'custom';
  if (document.activeElement !== $('#outW')) $('#outW').value = w;
  if (document.activeElement !== $('#outH')) $('#outH').value = hh;
}

function setOutputSize(w, hh) {
  w = Math.max(16, Math.min(8192, Math.round(w / 2) * 2));
  hh = Math.max(16, Math.min(8192, Math.round(hh / 2) * 2));
  if (!isFinite(w) || !isFinite(hh)) return;
  app.project.output = { w, h: hh };
  renderer.setSize(w, hh);
  layout();
  commit();
}

// ---------- export dialog ----------

let exportAbort = null;

function openExport() {
  const vids = ex.usedVideos(app.project, media);
  const longest = Math.max(0, ...vids.map((m) => m.duration));
  $('#exDur').value = longest > 0 ? Math.round(longest * 10) / 10 : 10;
  const { w, h: hh } = app.project.output;
  $('#exBitrate').value = Math.round(ex.defaultBitrate(w, hh, Number($('#exFps').value)) / 1e6);
  const offline = ex.canOfflineExport();
  $('#exMode').querySelector('[value=offline]').disabled = !offline;
  if (!offline) $('#exMode').value = 'realtime';
  updateExportInfo();
  $('#exProgress').hidden = true;
  $('#exportDlg').showModal();
}

function updateExportInfo() {
  const { w, h: hh } = app.project.output;
  const dur = Number($('#exDur').value) || 0, fps = Number($('#exFps').value), mbps = Number($('#exBitrate').value) || 0;
  const mb = (dur * mbps) / 8;
  const mode = $('#exMode').value;
  const extra = mode === 'offline'
    ? (ex.canOfflineExport() ? 'Renders every frame in order; takes as long as it needs.' : 'Offline rendering needs WebCodecs (Chrome).')
    : 'Captures the live canvas; pacing depends on this machine.';
  $('#exInfo').textContent = `${w} x ${hh}, ${Math.round(dur * fps)} frames, about ${mb.toFixed(0)} MB, no audio. ${extra}`;
}

async function runExport() {
  const duration = Number($('#exDur').value), fps = Number($('#exFps').value), bitrate = Number($('#exBitrate').value) * 1e6;
  if (!(duration > 0) || !(bitrate > 0)) { say('Enter a duration and bitrate.', true); return; }
  if (!app.project.shapes.some((s) => s.visible)) { say('Nothing to export: no visible shapes.', true); return; }
  const mode = $('#exMode').value;
  const progress = $('#exProgress');
  exportAbort = new AbortController();
  progress.hidden = false;
  progress.value = 0;
  $('#exStart').disabled = true;
  $('#exCancel').hidden = false;
  $('#exClose').disabled = true;
  const base = ex.safeName(app.project.name);
  const wasPlaying = app.playing;
  try {
    if (mode === 'offline') {
      app.busy = true;
      const blob = await ex.exportMP4({
        project: app.project, media, renderer, duration, fps, bitrate,
        onProgress: (p) => { progress.value = p; }, signal: exportAbort.signal,
      });
      ex.download(blob, `${base}.mp4`);
      say(`Exported ${base}.mp4 (${fmtSize(blob.size)}).`);
    } else {
      if (!app.playing) togglePlay();
      restartAll();
      app.clock = 0;
      app.recording = true;
      const { blob, ext } = await ex.recordRealtime({
        canvas: sceneCanvas, duration, fps, bitrate,
        onProgress: (p) => { progress.value = p; }, signal: exportAbort.signal,
      });
      ex.download(blob, `${base}.${ext}`);
      say(`Recorded ${base}.${ext} (${fmtSize(blob.size)}).`);
    }
  } catch (err) {
    if (err.name === 'AbortError') say('Export cancelled.');
    else { console.error(err); say('Export failed: ' + (err.message || err), true); }
  } finally {
    app.busy = false;
    app.recording = false;
    app.lastNow = performance.now();
    if (wasPlaying) setPlaying(true);
    else setPlaying(false);
    exportAbort = null;
    progress.hidden = true;
    $('#exStart').disabled = false;
    $('#exCancel').hidden = true;
    $('#exClose').disabled = false;
  }
}

// ---------- wiring ----------

function wire() {
  $('#addQuad').onclick = () => addShapes([quadShape(app.project.shapes.length)]);
  $('#addBox').onclick = () => addShapes(boxShapes());
  $('#undo').onclick = () => { const p = app.history.undo(); if (p) { setProject(sanitize(p)); autosave(app.project); } };
  $('#redo').onclick = () => { const p = app.history.redo(); if (p) { setProject(sanitize(p)); autosave(app.project); } };
  $('#openOut').onclick = openOutput;
  $('#guides').onchange = (e) => { app.guides = e.target.checked; };
  $('#testPattern').onchange = (e) => { app.testPattern = e.target.checked; };
  $('#playPause').onclick = togglePlay;
  $('#restart').onclick = () => { restartAll(); app.clock = 0; };
  $('#projName').onchange = (e) => { app.project.name = e.target.value.trim() || 'Untitled'; commit(); };
  $('#newProj').onclick = () => {
    const p = newProject();
    p.output = { ...app.project.output };
    app.project = p;
    app.sel = { shapeId: null, point: -1, frame: -1 };
    commit();
    say('Cleared. Undo brings it back.');
  };

  $('#outSize').onchange = (e) => {
    const v = e.target.value;
    if (v === 'custom') { $('#customSize').hidden = false; $('#outW').focus(); return; }
    if (v === 'match') {
      const w = app.outWin;
      e.target.blur();
      if (!w || w.closed) { say('Open the output window first, put it fullscreen on the projector, then choose this again.', true); syncSizeUI(); return; }
      const dpr = w.devicePixelRatio || 1;
      setOutputSize(w.innerWidth * dpr, w.innerHeight * dpr);
      say(`Output set to ${app.project.output.w} x ${app.project.output.h}.`);
      return;
    }
    const [w, hh] = v.split('x').map(Number);
    e.target.blur();
    setOutputSize(w, hh);
  };
  const customChanged = () => setOutputSize(Number($('#outW').value), Number($('#outH').value));
  $('#outW').onchange = customChanged;
  $('#outH').onchange = customChanged;

  $('#importMedia').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dropping'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  $('#exportBtn').onclick = openExport;
  for (const id of ['#exDur', '#exBitrate', '#exMode']) $(id).oninput = updateExportInfo;
  $('#exFps').onchange = () => {
    const { w, h: hh } = app.project.output;
    $('#exBitrate').value = Math.round(ex.defaultBitrate(w, hh, Number($('#exFps').value)) / 1e6);
    updateExportInfo();
  };
  $('#exStart').onclick = runExport;
  $('#exCancel').onclick = () => exportAbort?.abort();
  $('#exportDlg').addEventListener('cancel', (e) => { if (exportAbort) e.preventDefault(); });
  $('#exSVG').onclick = () => {
    if (!app.project.shapes.length) { say('No shapes to export.', true); return; }
    ex.download(new Blob([ex.buildSVG(app.project)], { type: 'image/svg+xml' }), `${ex.safeName(app.project.name)}.svg`);
  };
  $('#exJSON').onclick = () => {
    ex.download(new Blob([ex.buildJSON(app.project)], { type: 'application/json' }), `${ex.safeName(app.project.name)}.json`);
  };
  $('#imJSON').onclick = () => $('#jsonInput').click();
  $('#jsonInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || !Array.isArray(raw.shapes)) throw new Error('Not a Cornerpin layout file.');
      const project = sanitize(raw);
      const missing = relinkMedia(project);
      app.sel = { shapeId: null, point: -1, frame: -1 };
      setProject(project);
      commit();
      $('#exportDlg').close();
      say(missing ? `Layout loaded. ${missing} shape(s) reference media that is not in this browser; import the files to relink.` : 'Layout loaded.', missing > 0);
    } catch (err) {
      say('Import failed: ' + (err.message || err), true);
    }
  };

  new ResizeObserver(layout).observe($('#stage'));
  window.addEventListener('beforeunload', () => { try { app.outWin?.close(); } catch (_) { /* ignore */ } });
}

async function init() {
  try {
    renderer = new Renderer(sceneCanvas);
  } catch (err) {
    $('#empty').hidden = false;
    $('#empty').textContent = err.message;
    return;
  }
  wire();
  try { await loadAll(); } catch (err) { console.warn('Media library unavailable', err); say('Browser storage is unavailable; media will not persist.', true); }
  const project = await loadSaved();
  relinkMedia(project);
  setProject(project, { resetHistory: true });
  updateStorage();
  schedule();
}

init();

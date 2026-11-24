// Cornerpin editor: wiring between the model, the WebGL renderer, the editing overlay and the UI.
//
// Every shape has two outlines:
//   quad - the 4 corners its content is warped to (cyan, square handles)
//   mask - the N-point outline that decides what part is visible (amber, round handles)
// On a fresh quad they are the same four points ("linked": shape.frame is null). Reshaping the
// mask, or adding or deleting a mask point, separates them; the quad then lives in shape.frame.

import { Renderer, SHADERS, effectiveFrame, isLinked } from './renderer.js';
import { pointInPoly, closestOnSegment, bboxFrame, snapPoint } from './geometry.js';
import { newProject, newShape, quadShape, boxShapes, presetShape, PRESETS, sanitize, History, autosave, loadSaved, uid } from './state.js';
import { parseSVG, fitRings } from './svgimport.js';
import { media, loadAll, importFiles, remove as removeMedia, findByName, setPlaying, restartAll } from './media.js';
import { requestPersistence, storageEstimate } from './store.js';
import * as ex from './exporter.js';

const $ = (sel) => document.querySelector(sel);
const HIT = 11;      // px radius for grabbing a handle
const SNAP = 10;     // px radius for snapping
const WELD = 1e-6;   // handles closer than this (normalized) move together
const LIMIT = [-0.5, 1.5];
const ZOOM = [0.25, 16];
const QUAD = '#00d1ff';
const MASK = '#ffb020';

const app = {
  project: newProject(),
  history: new History(),
  sel: { shapeId: null, handle: -1 },
  // What the handles edit: 'quad' | 'mask' | 'transform' (the whole shape). A shape keeps its quad
  // and mask locked together unless it has been unlocked (lockQuad: false), so on a locked shape
  // the only handles are the whole-shape transform and, where the mask is the quad, its corners.
  // Reading it through this getter covers every user of app.target.
  mode: 'quad',
  get target() {
    const s = this.project.shapes.find((x) => x.id === this.sel.shapeId);
    if (!s || !s.lockQuad || this.mode === 'transform') return this.mode;
    return isLinked(s) ? 'quad' : 'transform';
  },
  set target(v) { this.mode = v; },
  tool: 'select',    // 'select' | 'add' | 'delete'
  guides: true,
  testPattern: false,
  playing: true,
  clock: 0,
  lastNow: performance.now(),
  busy: false,       // true while an offline export owns the renderer
  recording: false,
  drag: null,
  hover: null,       // last pointer position over the stage, in stage px
  snapMark: null,
  view: { ox: 0, oy: 0, scale: 1, fit: 1, zoom: 1, panX: 0, panY: 0 },
  outWin: null,
  outCtx: null,
  outFs: false,
  outFsSettle: 0,
};
window.cornerpin = app; // handy for debugging from the console

const stage = $('#stage');
const sceneCanvas = $('#scene');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
let renderer;

// ---------- helpers ----------

const size = () => [app.project.output.w, app.project.output.h];
const shapeById = (id) => app.project.shapes.find((s) => s.id === id) || null;
const selected = () => shapeById(app.sel.shapeId);
const clampPt = (p) => [Math.max(LIMIT[0], Math.min(LIMIT[1], p[0])), Math.max(LIMIT[0], Math.min(LIMIT[1], p[1]))];
const copyPts = (pts) => pts.map((p) => [p[0], p[1]]);
const even = (n) => Math.max(16, Math.min(8192, Math.round(n / 2) * 2));

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
  if (text) msgTimer = setTimeout(() => { el.textContent = ''; }, 7000);
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
  if (!shapeById(app.sel.shapeId)) app.sel = { shapeId: null, handle: -1 };
  if (resetHistory) app.history.reset(project);
  renderer.setSize(project.output.w, project.output.h);
  refreshUI();
  arrange();
  updateHistoryButtons();
}

function select(shapeId, handle = -1) {
  app.sel = { shapeId, handle };
  refreshUI();
}

function setTarget(target) {
  const s = selected();
  if (s && s.lockQuad && (target === 'mask' || (target === 'quad' && !isLinked(s)))) {
    say('Quad and mask are locked together on this shape. Turn on Edit separately to change one without the other.');
    return;
  }
  if (app.target === target) return;
  app.target = target;
  app.sel.handle = -1;
  refreshUI();
}

function setTool(tool) {
  app.tool = tool;
  if (tool !== 'select') app.target = 'mask'; // points are added to and deleted from the mask
  app.sel.handle = -1;
  refreshUI();
}

// ---------- the two outlines ----------

const SEP_HINT = 'Mask points change the mask without the quad. Select the shape and turn on Edit separately first.';

function toggleSeparate() {
  const s = selected();
  if (!s) return;
  s.lockQuad = !s.lockQuad;
  app.sel.handle = -1;
  if (s.lockQuad && app.tool !== 'select') app.tool = 'select';
  commit();
  say(s.lockQuad ? 'Quad and mask locked together.' : 'Quad and mask can now be edited separately (Q / M).');
}

/** The point array a handle index refers to, for the given outline. */
function outline(shape, kind) {
  if (kind === 'mask') return shape.pts;
  return isLinked(shape) ? shape.pts : effectiveFrame(shape);
}

/** Give the quad its own points so the mask can change without moving the content. */
function unlink(shape) {
  if (!shape.frame) shape.frame = copyPts(effectiveFrame(shape));
}

function relink(shape) {
  shape.pts = copyPts(effectiveFrame(shape));
  shape.frame = null;
}

/** Writable array for an outline. Editing the quad of an unlinked shape edits shape.frame. */
function writable(shape, kind) {
  if (kind === 'mask' || isLinked(shape)) return shape.pts;
  unlink(shape);
  return shape.frame;
}

// ---------- layout, zoom and pan ----------

function layout() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const [W, H] = size();
  const pad = 20, top = $('#targetBar').offsetHeight + 16; // the top band is kept clear for the Editing bar
  const v = app.view;
  v.fit = Math.max(0.01, Math.min((sw - pad * 2) / W, (sh - top - pad) / H));
  v.scale = v.fit * v.zoom;
  v.ox = (sw - W * v.scale) / 2 + v.panX;
  v.oy = top + (sh - top - pad - H * v.scale) / 2 + v.panY;
  Object.assign(sceneCanvas.style, { left: v.ox + 'px', top: v.oy + 'px', width: W * v.scale + 'px', height: H * v.scale + 'px' });
  const dpr = window.devicePixelRatio || 1;
  const ow = Math.round(sw * dpr), oh = Math.round(sh * dpr);
  if (overlay.width !== ow) overlay.width = ow;
  if (overlay.height !== oh) overlay.height = oh;
  $('#zoomPct').textContent = Math.round(v.zoom * 100) + '%';
}

/** Zoom the canvas about a point given in stage px (defaults to the stage centre). */
function zoomAt(factor, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) {
  const v = app.view;
  const anchor = toNorm(cx, cy);
  v.zoom = Math.max(ZOOM[0], Math.min(ZOOM[1], v.zoom * factor));
  layout();
  const [ax, ay] = toScreen(anchor);
  v.panX += cx - ax;
  v.panY += cy - ay;
  layout();
}

function panBy(dx, dy) {
  app.view.panX += dx;
  app.view.panY += dy;
  layout();
}

function fitView() {
  Object.assign(app.view, { zoom: 1, panX: 0, panY: 0 });
  layout();
}

// ---------- arrangement ----------

const ARRANGEMENTS = [['left', 'right'], ['top', 'right'], ['left', 'bottom'], ['top', 'bottom']];

/**
 * Place the tool rail (left of the canvas, or a strip above it) and the lists (right of the
 * canvas, or a strip below it) so the canvas comes out as large as it can for this output shape
 * in this window. A landscape output in a tall window gets strips above and below; a portrait
 * output in a wide window gets panels at the sides, and so on.
 */
function arrange() {
  const body = document.body, rail = $('#rail'), lists = $('#lists');
  const [W, H] = size();
  const current = `${body.dataset.rail}/${body.dataset.lists}`;
  const fitOf = () => {
    const top = $('#targetBar').offsetHeight + 16;
    return Math.min((stage.clientWidth - 40) / W, (stage.clientHeight - top - 20) / H);
  };
  let best = null;
  for (const [r, l] of ARRANGEMENTS) {
    body.dataset.rail = r;
    body.dataset.lists = l;
    body.style.setProperty('--lists-w', '250px');
    let score = fitOf();
    // An arrangement that would push a tool out of view or squeeze the lists flat is not a candidate.
    // scrollHeight does not report content that only spills into the padding, so compare boxes.
    const rr = rail.getBoundingClientRect();
    const railFits = [...rail.children].every((c) => {
      if (c.hidden) return true;
      const cr = c.getBoundingClientRect();
      return cr.bottom <= rr.bottom - 3 && cr.right <= rr.right - 3;
    });
    const fits = railFits && lists.clientHeight >= 110 && lists.clientWidth >= 200;
    if (!fits || !(score > 0)) score = Math.min(score, 0) - 1;
    else if (`${r}/${l}` === current) score *= 1.04; // stay put unless another arrangement is clearly better
    if (!best || score > best.score) best = { r, l, score };
  }
  body.dataset.rail = best.r;
  body.dataset.lists = best.l;
  // Side lists take the width the canvas cannot use, so layer names are not cut short for nothing.
  if (best.l === 'right') {
    const fit = fitOf();
    const spare = stage.clientWidth - 40 - W * fit;
    body.style.setProperty('--lists-w', Math.round(Math.max(250, Math.min(420, 250 + spare * 0.6))) + 'px');
    if (fitOf() < fit - 1e-6) body.style.setProperty('--lists-w', '250px');
  }
  layout();
}

// ---------- shape operations ----------

function addShapes(shapes) {
  app.project.shapes.push(...shapes);
  app.sel = { shapeId: shapes[shapes.length - 1].id, handle: -1 };
  app.target = 'quad';
  app.tool = 'select';
  commit();
}

function deleteShape(id) {
  const i = app.project.shapes.findIndex((s) => s.id === id);
  if (i < 0) return;
  app.project.shapes.splice(i, 1);
  if (app.sel.shapeId === id) app.sel = { shapeId: null, handle: -1 };
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
  app.sel = { shapeId: copy.id, handle: -1 };
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

/** Handles in other shapes that sit exactly on this one and should move with it. */
function weldedWith(shape, kind, idx) {
  const p = outline(shape, kind)[idx];
  const out = [];
  for (const s of app.project.shapes) {
    if (s === shape || (s.lockQuad && !isLinked(s))) continue; // locked: nothing moves one outline alone
    outline(s, kind).forEach((q, i) => {
      if (Math.abs(q[0] - p[0]) < WELD && Math.abs(q[1] - p[1]) < WELD) out.push({ shape: s, kind, idx: i });
    });
  }
  return out;
}

/** Every quad corner and mask point of the visible shapes, minus what `exclude` rejects. */
function snapCandidates(exclude) {
  const out = [];
  for (const s of app.project.shapes) {
    if (!s.visible) continue;
    s.pts.forEach((p, i) => { if (!exclude(s, 'mask', i)) out.push(p); });
    if (s.frame) s.frame.forEach((p, i) => { if (!exclude(s, 'quad', i)) out.push(p); });
  }
  return out;
}

/** Nearest mask edge of a shape to a stage-px position. */
function nearestEdge(shape, m) {
  let best = null;
  for (let i = 0; i < shape.pts.length; i++) {
    const a = toScreen(shape.pts[i]), b = toScreen(shape.pts[(i + 1) % shape.pts.length]);
    const c = closestOnSegment(m, a, b);
    const d = dist(c.pt, m);
    if (!best || d < best.d) best = { idx: i, d, a, b };
  }
  return best;
}

/** Where the Add point tool would act for a pointer at stage px `m`. */
function addTargetAt(m) {
  const sel = selected();
  if (sel && sel.visible) return { shape: sel, edge: nearestEdge(sel, m) };
  let best = null;
  for (const s of app.project.shapes) {
    if (!s.visible) continue;
    const e = nearestEdge(s, m);
    if (e && (!best || e.d < best.edge.d)) best = { shape: s, edge: e };
  }
  return best;
}

/** The mask point the Delete point tool would remove for a pointer at stage px `m`. */
function deleteTargetAt(m) {
  const sel = selected();
  const order = app.project.shapes.filter((s) => s.visible).reverse();
  if (sel && sel.visible) { order.splice(order.indexOf(sel), 1); order.unshift(sel); }
  for (const s of order) {
    let best = -1, bestD = HIT + 3;
    s.pts.forEach((p, i) => { const d = dist(toScreen(p), m); if (d <= bestD) { bestD = d; best = i; } });
    if (best >= 0) return { shape: s, idx: best };
  }
  return null;
}

function addPointAt(m, snap) {
  const t = addTargetAt(m);
  if (!t) { say('Add a shape first.', true); return; }
  if (t.shape.lockQuad) { say(SEP_HINT, true); return; }
  let n = clampPt(toNorm(m[0], m[1]));
  if (snap) {
    const [W, H] = size();
    n = snapPoint(n, snapCandidates((s) => s === t.shape), [W, H], SNAP / app.view.scale).pt;
  }
  unlink(t.shape);
  t.shape.pts.splice(t.edge.idx + 1, 0, n);
  app.sel = { shapeId: t.shape.id, handle: t.edge.idx + 1 };
  app.target = 'mask';
  app.tool = 'select';
  commit();
  say('Point added to the mask. Drag it to adjust.');
}

function deletePoint(shape, idx) {
  if (shape.pts.length <= 3) { say('A mask needs at least 3 points.', true); return false; }
  unlink(shape);
  shape.pts.splice(idx, 1);
  app.sel = { shapeId: shape.id, handle: -1 };
  app.target = 'mask';
  return true;
}

/**
 * A shape's own frame of reference, in output pixels: rotated so the quad's top edge runs along
 * +x. Everything that has to stay undistorted on a non-square output (aspect ratios, scaling,
 * rotation) is done in this space, not in normalized coordinates.
 */
function localFrame(shape) {
  const [W, H] = size();
  const q = effectiveFrame(shape);
  const a = Math.atan2((q[1][1] - q[0][1]) * H, (q[1][0] - q[0][0]) * W);
  const cos = Math.cos(a), sin = Math.sin(a);
  const toL = (p) => { const x = p[0] * W, y = p[1] * H; return [x * cos + y * sin, -x * sin + y * cos]; };
  const toN = (l) => [(l[0] * cos - l[1] * sin) / W, (l[0] * sin + l[1] * cos) / H];
  return { toL, toN };
}

function localBounds(pts, toL) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    const [x, y] = toL(p);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Make the quad a true rectangle with the given width/height ratio (in output pixels), keeping
 * its centre and its current rotation, and fitting inside the space it occupied.
 */
function setQuadAspect(shape, ratio) {
  if (!(ratio > 0)) return;
  const f = localFrame(shape);
  const b = localBounds(effectiveFrame(shape), f.toL);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  let w = b.x1 - b.x0, hgt = b.y1 - b.y0;
  if (!(w > 0 && hgt > 0)) return;
  if (w / hgt > ratio) w = hgt * ratio; else hgt = w / ratio;
  const rect = [[cx - w / 2, cy - hgt / 2], [cx + w / 2, cy - hgt / 2], [cx + w / 2, cy + hgt / 2], [cx - w / 2, cy + hgt / 2]].map(f.toN);
  if (isLinked(shape)) shape.pts = rect; else shape.frame = rect;
}

/** Width/height ratio of the shape's media as its content is currently turned, or 0. */
function mediaRatio(shape) {
  const m = media.get(shape.content.mediaId);
  if (shape.content.type !== 'media' || !m || !m.w || !m.h) return 0;
  return shape.rot % 2 ? m.h / m.w : m.w / m.h;
}

// ---------- free transform ----------

const XFORM_HANDLES = [
  { id: 'nw', fx: 0, fy: 0 }, { id: 'n', fx: 0.5, fy: 0 }, { id: 'ne', fx: 1, fy: 0 }, { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 }, { id: 's', fx: 0.5, fy: 1 }, { id: 'sw', fx: 0, fy: 1 }, { id: 'w', fx: 0, fy: 0.5 },
];

/** The transform box of a shape: its bounds in its own frame, covering both the quad and the mask. */
function xformBox(shape) {
  const f = localFrame(shape);
  const b = localBounds(shape.frame ? [...shape.pts, ...shape.frame] : shape.pts, f.toL);
  const at = (fx, fy) => [b.x0 + (b.x1 - b.x0) * fx, b.y0 + (b.y1 - b.y0) * fy];
  const stem = 28 / app.view.scale; // the rotate handle sits a fixed screen distance above the box
  return { ...f, ...b, at, rot: [(b.x0 + b.x1) / 2, b.y0 - stem], centre: at(0.5, 0.5) };
}

function xformHit(shape, m) {
  const box = xformBox(shape);
  const scr = (l) => toScreen(box.toN(l));
  if (dist(scr(box.rot), m) <= HIT) return 'rot';
  for (const hd of XFORM_HANDLES) if (dist(scr(box.at(hd.fx, hd.fy)), m) <= HIT) return hd.id;
  const l = box.toL(toNorm(m[0], m[1]));
  return l[0] >= box.x0 && l[0] <= box.x1 && l[1] >= box.y0 && l[1] <= box.y1 ? 'body' : null;
}

/** Apply a scale or rotate drag. `d` holds the box and the points as they were at pointerdown. */
function applyXform(d, n, free, snapAngle) {
  const box = d.box;
  const pl = box.toL(n);
  let map;
  if (d.handle === 'rot') {
    const [cx, cy] = box.centre;
    let ang = Math.atan2(pl[1] - cy, pl[0] - cx) - Math.atan2(d.startL[1] - cy, d.startL[0] - cx);
    if (snapAngle) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    map = (l) => [cx + (l[0] - cx) * cos - (l[1] - cy) * sin, cy + (l[0] - cx) * sin + (l[1] - cy) * cos];
  } else {
    const hd = XFORM_HANDLES.find((x) => x.id === d.handle);
    const anchor = box.at(1 - hd.fx, 1 - hd.fy), grab = box.at(hd.fx, hd.fy);
    const vx = grab[0] - anchor[0], vy = grab[1] - anchor[1];
    let sx = 1, sy = 1;
    if (hd.fx === 0.5) sy = (pl[1] - anchor[1]) / vy;          // top or bottom side: height only
    else if (hd.fy === 0.5) sx = (pl[0] - anchor[0]) / vx;     // left or right side: width only
    else if (free) { sx = (pl[0] - anchor[0]) / vx; sy = (pl[1] - anchor[1]) / vy; }
    else sx = sy = ((pl[0] - anchor[0]) * vx + (pl[1] - anchor[1]) * vy) / (vx * vx + vy * vy); // corner: in proportion
    const floor = (v) => (isFinite(v) ? Math.max(0.02, v) : 1); // never collapse or flip the shape
    sx = floor(sx);
    sy = floor(sy);
    map = (l) => [anchor[0] + (l[0] - anchor[0]) * sx, anchor[1] + (l[1] - anchor[1]) * sy];
  }
  // The transform is applied to every point or to none. Clamping points one by one would bend a
  // rectangle that reaches past the working area, so a step that leaves it is simply not taken.
  const run = (pts) => pts.map((p) => box.toN(map(box.toL(p))));
  const pts = run(d.pts), frame = d.frame ? run(d.frame) : null;
  const sane = (p) => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0] - 0.5) <= 4 && Math.abs(p[1] - 0.5) <= 4;
  if (!pts.every(sane) || (frame && !frame.every(sane))) return false;
  d.shape.pts = pts;
  if (frame) d.shape.frame = frame;
  return true;
}

// ---------- pointer interaction ----------

function hitTest(m) {
  const sel = selected();
  if (sel && sel.visible && app.target === 'transform') {
    const part = xformHit(sel, m);
    if (part && part !== 'body') return { type: 'xform', shape: sel, handle: part };
    if (part === 'body') return { type: 'body', shape: sel };
  } else if (sel && sel.visible) {
    const pts = outline(sel, app.target);
    let best = -1, bestD = HIT;
    pts.forEach((p, i) => { const d = dist(toScreen(p), m); if (d <= bestD) { bestD = d; best = i; } });
    if (best >= 0) return { type: 'handle', shape: sel, idx: best };
  }
  const n = toNorm(m[0], m[1]);
  for (const s of [...app.project.shapes].reverse()) {
    if (s.visible && pointInPoly(n, s.pts)) return { type: 'body', shape: s };
  }
  if (sel && sel.visible && pointInPoly(n, effectiveFrame(sel))) return { type: 'body', shape: sel };
  return null;
}

function localXY(e) {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

const touches = new Map(); // active touch pointers, for pinch zoom on touch screens
let pinch = null;

overlay.addEventListener('pointerdown', (e) => {
  const m = localXY(e);
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, m);
    if (touches.size === 2) {
      abandonDrag();
      const [a, b] = [...touches.values()];
      pinch = { d: dist(a, b), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
  }
  if ((e.button !== 0 && e.button !== 1) || app.busy) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.button === 1) { // middle button drags the view
    capture(e);
    app.drag = { type: 'pan', last: m, moved: false };
    e.preventDefault();
    return;
  }
  if (app.tool === 'add') { addPointAt(m, !e.metaKey); return; }
  if (app.tool === 'delete') {
    const t = deleteTargetAt(m);
    if (!t) { say('Click a mask point to delete it.'); return; }
    if (t.shape.lockQuad) { say(SEP_HINT, true); return; }
    if (deletePoint(t.shape, t.idx)) { app.tool = 'select'; commit(); say('Point deleted from the mask.'); } else refreshUI();
    return;
  }
  const hit = hitTest(m);
  if (!hit) { select(null); return; }
  capture(e);
  // Snapshot for abandonDrag: a touch drag can turn into a pinch after it has already moved things.
  const before = JSON.stringify(app.project.shapes);
  if (hit.type === 'xform') {
    const box = xformBox(hit.shape);
    // A shape whose mask is not 4 points can still have frame: null (its quad is then the mask's
    // bounding rectangle, recomputed each frame). Transforming only the mask would leave that
    // rectangle upright, so the quad is snapshotted here and written back with the first movement.
    app.drag = {
      type: 'xform', shape: hit.shape, handle: hit.handle, box, startL: box.toL(toNorm(m[0], m[1])), moved: false, before,
      pts: copyPts(hit.shape.pts), frame: isLinked(hit.shape) ? null : copyPts(effectiveFrame(hit.shape)),
    };
  } else if (hit.type === 'handle') {
    const kind = app.target;
    // Shared corners move together only for quads; a mask point is always moved on its own.
    const welded = e.altKey || kind === 'mask' ? [] : weldedWith(hit.shape, kind, hit.idx);
    app.sel = { shapeId: hit.shape.id, handle: hit.idx };
    app.drag = { type: 'handle', shape: hit.shape, kind, idx: hit.idx, welded, moved: false, before };
  } else {
    if (app.sel.shapeId !== hit.shape.id || app.sel.handle !== -1) select(hit.shape.id);
    app.drag = {
      type: 'shape', shape: hit.shape, start: toNorm(m[0], m[1]), moved: false, before,
      pts: copyPts(hit.shape.pts), frame: hit.shape.frame ? copyPts(hit.shape.frame) : null,
    };
  }
});

overlay.addEventListener('pointermove', (e) => {
  const m = localXY(e);
  app.hover = m;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, m);
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = dist(a, b), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (pinch.d > 0) zoomAt(d / pinch.d, c[0], c[1]);
      panBy(c[0] - pinch.c[0], c[1] - pinch.c[1]);
      pinch = { d, c };
      return;
    }
  }
  const d = app.drag;
  if (!d) {
    if (app.tool !== 'select') { overlay.style.cursor = 'crosshair'; return; }
    const hit = app.busy ? null : hitTest(m);
    overlay.style.cursor = !hit ? 'default' : hit.type === 'body' ? 'move' : hit.type === 'xform' ? (hit.handle === 'rot' ? 'grab' : 'nwse-resize') : 'crosshair';
    return;
  }
  if (d.type === 'pan') {
    panBy(m[0] - d.last[0], m[1] - d.last[1]);
    d.last = m;
    return;
  }
  const [W, H] = size();
  const tol = SNAP / app.view.scale;
  const useSnap = !e.metaKey;
  let n = clampPt(toNorm(m[0], m[1]));
  app.snapMark = null;

  if (d.type === 'xform') {
    if (applyXform(d, toNorm(m[0], m[1]), e.shiftKey, e.shiftKey)) d.moved = true;
  } else if (d.type === 'handle') {
    if (useSnap) {
      const moving = new Set(d.welded.map((w) => w.shape.id + ':' + w.idx));
      const linked = isLinked(d.shape);
      const cands = snapCandidates((s, kind, i) =>
        (s === d.shape && (kind === d.kind || linked)) || (kind === d.kind && moving.has(s.id + ':' + i)) ||
        (isLinked(s) && d.kind === 'quad' && kind === 'mask' && moving.has(s.id + ':' + i)));
      const r = snapPoint(n, cands, [W, H], tol);
      n = r.pt;
      if (r.snapped) app.snapMark = n;
    }
    // Moving a mask point of a linked shape is what separates the mask from the quad. It happens
    // here, on the first real movement, so a click that never drags leaves the shape linked.
    if (d.kind === 'mask' && isLinked(d.shape)) unlink(d.shape);
    writable(d.shape, d.kind)[d.idx] = n;
    for (const w of d.welded) writable(w.shape, w.kind)[w.idx] = [n[0], n[1]];
    d.moved = true;
  } else if (d.type === 'shape') {
    let dx = n[0] - d.start[0], dy = n[1] - d.start[1];
    if (Math.hypot(dx * W, dy * H) * app.view.scale < 3 && !d.moved) return;
    if (useSnap) {
      const cands = snapCandidates((s) => s === d.shape);
      let best = null, bestD = tol;
      for (const p of d.frame ? [...d.pts, ...d.frame] : d.pts) {
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

/** Drop the drag in progress and put the shapes back as they were when it started. */
function abandonDrag() {
  const d = app.drag;
  if (!d) return;
  app.drag = null;
  app.snapMark = null;
  if (d.before && d.moved) {
    app.project.shapes = JSON.parse(d.before);
    refreshUI();
  }
}

function capture(e) {
  try { overlay.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
}

function endPointer(e) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  }
  const d = app.drag;
  if (!d) return;
  app.drag = null;
  app.snapMark = null;
  try { overlay.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
  if (d.type === 'pan') return;
  if (d.moved) commit(); else refreshUI();
}
overlay.addEventListener('pointerup', endPointer);
overlay.addEventListener('pointercancel', endPointer);
overlay.addEventListener('pointerleave', () => { app.hover = null; });
overlay.addEventListener('auxclick', (e) => e.preventDefault());

// Pinch on a trackpad arrives as a ctrl+wheel event. It must never zoom the page: over the canvas
// it zooms the canvas, anywhere else it does nothing. A plain two-finger scroll pans the canvas.
window.addEventListener('wheel', (e) => {
  const overStage = stage.contains(e.target);
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (overStage && !app.busy) {
      const [x, y] = localXY(e);
      // Trackpad pinch deltas are small; a mouse wheel notch is ~100, so cap the step.
      zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), x, y);
    }
  } else if (overStage) {
    e.preventDefault();
    if (!app.busy) panBy(-e.deltaX, -e.deltaY);
  }
}, { passive: false });
// Safari's own pinch events, for completeness.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  window.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// ---------- keyboard ----------

function nudge(dx, dy) {
  const s = selected();
  if (!s) return false;
  const [W, H] = size();
  const d = [dx / W, dy / H];
  const move = (p) => clampPt([p[0] + d[0], p[1] + d[1]]);
  // A handle index is only meaningful for the outline it was picked on. Undo can restore a lock
  // (or a different point count) under a retained selection, so the whole shape moves instead.
  const single = app.target !== 'transform' && app.sel.handle >= 0 && app.sel.handle < outline(s, app.target).length;
  if (!single) app.sel.handle = -1;
  if (single) {
    if (app.target === 'mask' && isLinked(s)) unlink(s);
    const welded = app.target === 'mask' ? [] : weldedWith(s, app.target, app.sel.handle);
    const arr = writable(s, app.target);
    arr[app.sel.handle] = move(arr[app.sel.handle]);
    for (const w of welded) writable(w.shape, w.kind)[w.idx] = [...arr[app.sel.handle]];
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
  const lower = key.toLowerCase();
  if (mod && lower === 'z') {
    e.preventDefault();
    const p = e.shiftKey ? app.history.redo() : app.history.undo();
    if (p) { setProject(sanitize(p)); autosave(app.project); }
  } else if (mod && lower === 'd') {
    e.preventDefault();
    if (app.sel.shapeId) duplicateShape(app.sel.shapeId);
  } else if (mod) {
    return;
  } else if (key === 'Delete' || key === 'Backspace') {
    const s = selected();
    if (!s) return;
    e.preventDefault();
    if (app.sel.handle >= 0 && app.target === 'mask') {
      if (deletePoint(s, app.sel.handle)) commit(); else refreshUI();
    } else if (app.sel.handle >= 0) {
      say('The quad always has 4 corners. Switch to Mask to delete a point.', true);
    } else deleteShape(s.id);
  } else if (key.startsWith('Arrow')) {
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
    if (v && nudge(v[0], v[1])) {
      e.preventDefault();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => commit(false), 350);
    }
  } else if (key === 'Escape') {
    if (app.tool !== 'select') setTool('select'); else select(null);
  } else if (key === ' ') { e.preventDefault(); togglePlay(); }
  else if (lower === 'g') { app.guides = !app.guides; $('#guides').checked = app.guides; }
  else if (lower === 'v') setTool('select');
  else if (lower === 'a') setTool(app.tool === 'add' ? 'select' : 'add');
  else if (lower === 'd') setTool(app.tool === 'delete' ? 'select' : 'delete');
  else if (lower === 'q') setTarget('quad');
  else if (lower === 'm') setTarget('mask');
  else if (lower === 't') setTarget('transform');
  else if (key === '0') fitView();
  else if (key === '=' || key === '+') zoomAt(1.25);
  else if (key === '-') zoomAt(0.8);
});

// ---------- overlay drawing ----------

function tracePoly(ctx, pts, map) {
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = map(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const sel = selected();
  octx.lineJoin = 'round';

  // Output frame, so the edge of the projection is visible when zoomed or panned.
  const [x0, y0] = toScreen([0, 0]), [x1, y1] = toScreen([1, 1]);
  octx.lineWidth = 1;
  octx.strokeStyle = 'rgba(255,255,255,.35)';
  octx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);

  for (const s of app.project.shapes) {
    if (!s.visible || s === sel) continue;
    tracePoly(octx, s.pts, toScreen);
    octx.lineWidth = 1;
    octx.strokeStyle = 'rgba(255,255,255,.5)';
    octx.stroke();
  }

  if (sel && sel.visible) {
    const linked = isLinked(sel);
    const active = app.target === 'transform' ? null : app.target;
    const draw = (kind) => {
      const pts = outline(sel, kind);
      const color = kind === 'quad' ? QUAD : MASK;
      const on = kind === active;
      tracePoly(octx, pts, toScreen);
      octx.setLineDash(on ? [] : [5, 5]);
      octx.lineWidth = on ? 2.5 : 1.5;
      octx.globalAlpha = on ? 1 : 0.85;
      octx.strokeStyle = color;
      octx.stroke();
      octx.setLineDash([]);
      octx.globalAlpha = 1;
      if (!on) return;
      pts.forEach((p, i) => {
        const [x, y] = toScreen(p);
        const hot = app.sel.handle === i;
        octx.fillStyle = hot ? color : '#15161a';
        octx.strokeStyle = color;
        octx.lineWidth = 2;
        if (kind === 'quad') {
          octx.fillRect(x - 6, y - 6, 12, 12);
          octx.strokeRect(x - 6, y - 6, 12, 12);
        } else {
          octx.beginPath();
          octx.arc(x, y, 6.5, 0, Math.PI * 2);
          octx.fill();
          octx.stroke();
        }
      });
    };
    // Inactive outline first so the active one sits on top. A linked shape has one outline.
    if (!active) { draw('quad'); if (!linked) draw('mask'); }
    else if (linked) draw(active);
    else { draw(active === 'quad' ? 'mask' : 'quad'); draw(active); }

    if (!active) {
      // Transform box: corners scale, sides stretch one way, the round handle on the stem rotates.
      const box = xformBox(sel);
      const scr = (l) => toScreen(box.toN(l));
      const corners = [box.at(0, 0), box.at(1, 0), box.at(1, 1), box.at(0, 1)].map(scr);
      octx.beginPath();
      corners.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      octx.closePath();
      octx.lineWidth = 1.5;
      octx.strokeStyle = '#ecedf2';
      octx.stroke();
      const top = scr(box.at(0.5, 0)), rot = scr(box.rot);
      octx.beginPath();
      octx.moveTo(top[0], top[1]);
      octx.lineTo(rot[0], rot[1]);
      octx.stroke();
      octx.fillStyle = '#15161a';
      octx.lineWidth = 2;
      for (const hd of XFORM_HANDLES) {
        const [x, y] = scr(box.at(hd.fx, hd.fy));
        const r = hd.fx === 0.5 || hd.fy === 0.5 ? 4.5 : 6;
        octx.fillRect(x - r, y - r, r * 2, r * 2);
        octx.strokeRect(x - r, y - r, r * 2, r * 2);
      }
      octx.beginPath();
      octx.arc(rot[0], rot[1], 6.5, 0, Math.PI * 2);
      octx.fill();
      octx.stroke();
    }

    // Mark the content's top-left corner so Rotate and Flip are predictable.
    const q = outline(sel, 'quad');
    const [tx, ty] = toScreen(q[0]);
    const c = toScreen([(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2]);
    const len = Math.hypot(c[0] - tx, c[1] - ty) || 1;
    octx.font = '600 10px -apple-system, system-ui, sans-serif';
    octx.fillStyle = QUAD;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText('TL', tx + ((c[0] - tx) / len) * 18, ty + ((c[1] - ty) / len) * 18);
  }

  // Tool previews.
  if (app.hover && !app.drag && !app.busy) {
    if (app.tool === 'add') {
      const t = addTargetAt(app.hover);
      if (t) {
        octx.beginPath();
        octx.moveTo(t.edge.a[0], t.edge.a[1]);
        octx.lineTo(app.hover[0], app.hover[1]);
        octx.lineTo(t.edge.b[0], t.edge.b[1]);
        octx.setLineDash([4, 4]);
        octx.lineWidth = 2;
        octx.strokeStyle = '#7cff6b';
        octx.stroke();
        octx.setLineDash([]);
        octx.beginPath();
        octx.arc(app.hover[0], app.hover[1], 6.5, 0, Math.PI * 2);
        octx.fillStyle = '#7cff6b';
        octx.fill();
      }
    } else if (app.tool === 'delete') {
      const t = deleteTargetAt(app.hover);
      if (t) {
        const [x, y] = toScreen(t.shape.pts[t.idx]);
        octx.beginPath();
        octx.arc(x, y, 10, 0, Math.PI * 2);
        octx.fillStyle = 'rgba(255,90,106,.35)';
        octx.fill();
        octx.lineWidth = 2.5;
        octx.strokeStyle = '#ff5a6a';
        octx.stroke();
        octx.beginPath();
        octx.moveTo(x - 5, y - 5); octx.lineTo(x + 5, y + 5);
        octx.moveTo(x + 5, y - 5); octx.lineTo(x - 5, y + 5);
        octx.stroke();
      }
    }
  }

  if (app.snapMark) {
    const [x, y] = toScreen(app.snapMark);
    octx.beginPath();
    octx.arc(x, y, 12, 0, Math.PI * 2);
    octx.lineWidth = 2;
    octx.strokeStyle = '#7cff6b';
    octx.stroke();
  }
}

/** Outlines and the active handle, drawn on the projector so you can align while looking at the surface. */
function drawOutputGuides(ctx, W, H) {
  const sel = selected();
  const px = (p) => [p[0] * W, p[1] * H];
  const unit = Math.max(1, Math.round(Math.min(W, H) / 540));
  ctx.lineJoin = 'round';
  for (const s of app.project.shapes) {
    if (!s.visible || s === sel) continue;
    tracePoly(ctx, s.pts, px);
    ctx.lineWidth = unit;
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.stroke();
  }
  if (!sel || !sel.visible) return;
  const color = app.target === 'quad' ? QUAD : app.target === 'mask' ? MASK : '#ecedf2';
  const pts = outline(sel, app.target === 'transform' ? 'mask' : app.target);
  tracePoly(ctx, pts, px);
  ctx.lineWidth = 2 * unit;
  ctx.strokeStyle = color;
  ctx.stroke();
  pts.forEach((p) => {
    const [x, y] = px(p);
    ctx.beginPath();
    ctx.arc(x, y, 4 * unit, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  if (app.sel.handle >= 0 && pts[app.sel.handle]) {
    const [x, y] = px(pts[app.sel.handle]);
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

/** Pixel size of the output window's display area. */
function outputWindowPixels(w) {
  const dpr = w.devicePixelRatio || 1;
  return [even(w.innerWidth * dpr), even(w.innerHeight * dpr)];
}

function presentOutput() {
  const w = app.outWin;
  if (!w) return;
  if (w.closed) {
    app.outWin = null;
    app.outCtx = null;
    app.outFs = false;
    $('#openOut').textContent = 'Open output';
    updateOutInfo();
    return;
  }
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

    // When the output goes fullscreen on a display whose pixel size differs from the output size,
    // adopt the display's size, so the projection and every export match the device exactly.
    const fs = !!w.document.fullscreenElement;
    if (fs !== app.outFs) {
      app.outFs = fs;
      app.outFsSettle = fs ? 20 : 0; // let the window finish resizing before measuring it
      if (!fs) updateOutInfo();
    } else if (fs && app.outFsSettle > 0 && --app.outFsSettle === 0) {
      const [tw, th] = outputWindowPixels(w);
      if ((tw !== W || th !== H) && !app.recording && !app.drag) {
        setOutputSize(tw, th);
        say(`Output set to the display: ${tw} x ${th}. Undo reverts it.`);
      }
      updateOutInfo();
    }
  } catch (_) { /* window still loading */ }
}

function openOutput() {
  if (app.outWin && !app.outWin.closed) { app.outWin.focus(); return; }
  const w = window.open('output.html', 'cornerpin-output', 'popup=yes,width=960,height=540');
  if (!w) { say('The browser blocked the output window. Allow pop-ups for this site.', true); return; }
  app.outWin = w;
  app.outCtx = null;
  app.outFs = false;
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
  renderInspector();
  renderMedia();
  renderTools();
  $('#empty').hidden = app.project.shapes.length > 0;
  if (document.activeElement !== $('#projName')) $('#projName').value = app.project.name;
  syncSizeUI();
  updateOutInfo();
}

function renderTools() {
  for (const b of document.querySelectorAll('#rail .tool')) b.classList.toggle('active', b.dataset.tool === app.tool);
  for (const b of document.querySelectorAll('#targetBar .tgt')) {
    b.classList.toggle('active', b.dataset.target === app.target);
    b.setAttribute('aria-pressed', b.dataset.target === app.target ? 'true' : 'false');
  }
  const s = selected();
  $('#targetBar').classList.toggle('off', !s);
  const locked = !!(s && s.lockQuad);
  $('#tgtQuad').disabled = locked && !isLinked(s);
  $('#tgtMask').disabled = locked;
  const sep = $('#tgtSep');
  sep.disabled = !s;
  sep.classList.toggle('active', !!s && !locked);
  sep.setAttribute('aria-pressed', s && !locked ? 'true' : 'false');
  $('#linkState').textContent = !s ? 'Select a shape'
    : app.target === 'transform' ? 'Corners scale in proportion (Shift: freely). Sides stretch. Top handle rotates (Shift: 15\u00b0 steps).'
    : s.lockQuad ? (isLinked(s) ? 'Corners move the quad and its mask together' : 'Quad and mask are locked: use Transform')
    : isLinked(s) ? 'Mask follows the quad' : `Mask: ${s.pts.length} points, separate from the quad`;
  const hint = $('#toolHint');
  hint.hidden = app.tool === 'select';
  hint.classList.toggle('del', app.tool === 'delete');
  if (app.tool === 'add') hint.textContent = 'Click where the new mask point goes. Esc cancels.';
  if (app.tool === 'delete') hint.textContent = 'Click the mask point to delete. Esc cancels.';
  overlay.style.cursor = app.tool === 'select' ? 'default' : 'crosshair';
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
  let selRow = null;
  [...shapes].reverse().forEach((s) => {
    const i = shapes.indexOf(s);
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const sw = h('span', { class: 'swatch' });
    sw.style.background = contentSwatch(s);
    const isSel = s.id === app.sel.shapeId;
    const rowEl = h('div', { class: 'layer' + (isSel ? ' sel' : ''), onclick: () => select(s.id) },
      h('button', { title: s.visible ? 'Hide' : 'Show', 'aria-label': s.visible ? 'Hide layer' : 'Show layer', class: s.visible ? 'on' : '',
        onclick: stop(() => { s.visible = !s.visible; commit(); }) }, s.visible ? 'On' : 'Off'),
      sw,
      h('span', { class: 'nm', title: s.name }, s.name),
      h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s.opacity, title: `Opacity ${Math.round(s.opacity * 100)}%`, 'aria-label': `Opacity of ${s.name}`,
        onclick: (e) => e.stopPropagation(),
        oninput: (e) => { s.opacity = Number(e.target.value); e.target.title = `Opacity ${Math.round(s.opacity * 100)}%`; },
        onchange: () => commit() }),
      h('button', { title: 'Move up', 'aria-label': 'Move layer up', disabled: i === shapes.length - 1, onclick: stop(() => moveLayer(s.id, 1)) }, '\u2191'),
      h('button', { title: 'Move down', 'aria-label': 'Move layer down', disabled: i === 0, onclick: stop(() => moveLayer(s.id, -1)) }, '\u2193'),
      h('button', { class: 'danger', title: 'Delete this shape', 'aria-label': `Delete ${s.name}`, onclick: stop(() => deleteShape(s.id)) }, 'x'),
    );
    if (isSel) selRow = rowEl;
    box.append(rowEl);
  });
  // The list is the one place that can scroll; keep the selected row inside it.
  if (selRow && selRow.scrollIntoView) selRow.scrollIntoView({ block: 'nearest' });
}

/** A labelled control group in the inspector bar. */
function grp(label, ...controls) {
  return h('span', { class: 'grp' }, label ? h('label', {}, label) : null, ...controls);
}

/**
 * The inspector holds every control for the selected shape in one wrapping bar. It grows by
 * wrapping onto another line and takes the space from the canvas, so nothing in it can ever be
 * scrolled out of view.
 */
function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  const s = selected();
  if (!s) {
    box.append(h('span', { class: 'none' }, 'No shape selected. Click a shape on the canvas or in Layers, or add one from the Add panel.'));
    return;
  }
  const c = s.content;
  const shapes = app.project.shapes;
  const idx = shapes.indexOf(s);
  const live = (fn) => (e) => { fn(e.target); };                     // while dragging a control
  const done = (fn) => (e) => { fn(e.target); commit(); };           // on release: undo step + refresh
  const range = (value, min, max, step, set, title) =>
    h('input', { type: 'range', min, max, step, value, title, oninput: live((t) => set(Number(t.value))), onchange: () => commit(false) });
  const opt = (value, text, cur) => h('option', { value, selected: value === cur }, text);
  const color = (key) => h('input', { type: 'color', value: c[key], oninput: live((t) => { c[key] = t.value; }), onchange: () => commit() });

  box.append(grp('Name', h('input', { type: 'text', value: s.name, onchange: done((t) => { s.name = t.value.trim() || 'Shape'; }) })));

  box.append(grp('Content', h('select', { onchange: done((t) => {
    c.type = t.value;
    if (c.type === 'media' && !media.get(c.mediaId)) {
      const first = [...media.values()].find((m) => !m.error);
      if (first) { c.mediaId = first.id; c.mediaName = first.name; }
    }
  }) }, opt('solid', 'Solid color', c.type), opt('gradient', 'Gradient', c.type), opt('shader', 'Shader effect', c.type), opt('media', 'Video or image', c.type))));

  if (c.type === 'solid') box.append(grp('Color', color('color')));
  if (c.type === 'gradient') {
    box.append(grp('Colors', color('color'), color('color2')));
    box.append(grp('Style', h('select', { onchange: done((t) => { c.gradType = t.value; }) }, opt('linear', 'Linear', c.gradType), opt('radial', 'Radial', c.gradType))));
    if (c.gradType === 'linear') box.append(grp('Angle', range(c.angle, 0, 360, 1, (v) => { c.angle = v; })));
  }
  if (c.type === 'shader') {
    box.append(grp('Effect', h('select', { onchange: done((t) => { c.shader = t.value; }) }, SHADERS.map((sh) => opt(sh.id, sh.name, c.shader)))));
    box.append(grp('Colors', color('color'), color('color2')));
    box.append(grp('Speed', range(c.speed, 0, 4, 0.05, (v) => { c.speed = v; })));
    box.append(grp('Density', range(c.scale, 0.25, 6, 0.05, (v) => { c.scale = v; })));
    if (['stripes', 'rainbow', 'scanner'].includes(c.shader)) box.append(grp('Angle', range(c.angle, 0, 360, 1, (v) => { c.angle = v; })));
  }
  if (c.type === 'media') {
    const items = [...media.values()];
    const m = media.get(c.mediaId);
    box.append(grp('Source', h('select', { onchange: done((t) => {
      const pick = media.get(t.value);
      if (pick) { c.mediaId = pick.id; c.mediaName = pick.name; }
    }) },
      !m ? h('option', { value: '', selected: true }, c.mediaName ? `Missing: ${c.mediaName}` : 'None imported yet') : null,
      items.map((it) => opt(it.id, it.name, c.mediaId)))));
    box.append(grp('Fit', h('select', { title: 'How the media fills the quad', onchange: done((t) => { s.fit = t.value; }) },
      opt('fill', 'Stretch to the quad', s.fit), opt('cover', 'Cover (crop, no distortion)', s.fit), opt('contain', 'Contain (bars, no distortion)', s.fit))));
  }

  const mr = mediaRatio(s);
  const [OW, OH] = size();
  const ratios = [['1', 'Square 1:1'], [String(4 / 3), '4:3'], [String(3 / 2), '3:2'], [String(16 / 9), '16:9'],
    [String(3 / 4), '3:4 portrait'], [String(2 / 3), '2:3 portrait'], [String(9 / 16), '9:16 portrait'], [String(OW / OH), `Same as output (${OW} x ${OH})`]];
  if (mr) ratios.push([String(mr), 'Same as media']);
  const quadOnly = s.lockQuad && !isLinked(s); // an edit to the quad alone needs Edit separately
  box.append(grp(quadOnly ? 'Shape' : 'Quad',
    quadOnly ? null : h('select', { id: 'quadAspect', title: 'Make the quad a true rectangle with this shape. It keeps its centre and rotation.', onchange: (e) => {
      const r = Number(e.target.value);
      e.target.value = '';
      if (r > 0) { setQuadAspect(s, r); app.sel.handle = -1; commit(); }
    } }, h('option', { value: '', selected: true }, 'Set shape…'), ratios.map(([v, label]) => h('option', { value: v }, label))),
    h('button', { class: app.target === 'transform' ? 'on' : '', title: 'Move, scale and rotate the whole shape (T)',
      onclick: () => setTarget(app.target !== 'transform' ? 'transform' : quadOnly ? 'transform' : 'quad') }, 'Transform')));

  box.append(grp('Turn',
    h('button', { onclick: () => { s.rot = (s.rot + 1) % 4; commit(); }, title: 'Rotate content 90 degrees' }, 'Rotate'),
    h('button', { class: s.flipH ? 'on' : '', onclick: () => { s.flipH = !s.flipH; commit(); }, title: 'Flip content horizontally' }, 'Flip H'),
    h('button', { class: s.flipV ? 'on' : '', onclick: () => { s.flipV = !s.flipV; commit(); }, title: 'Flip content vertically' }, 'Flip V')));

  const pct = h('span', { class: 'pct' }, Math.round(s.opacity * 100) + '%');
  box.append(grp('Opacity',
    h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s.opacity, title: 'Layer opacity (transparency)',
      oninput: (e) => { s.opacity = Number(e.target.value); pct.textContent = Math.round(s.opacity * 100) + '%'; }, onchange: () => commit() }),
    pct));
  box.append(grp('Blend', h('select', { onchange: done((t) => { s.blend = t.value; }) },
    opt('normal', 'Normal', s.blend), opt('add', 'Add', s.blend), opt('screen', 'Screen', s.blend), opt('multiply', 'Multiply', s.blend))));

  const linked = isLinked(s);
  box.append(grp('Mask',
    h('button', { disabled: linked || s.lockQuad, title: 'Make the mask the same 4 points as the quad again', onclick: () => { relink(s); app.sel.handle = -1; commit(); } }, 'Reset mask to quad'),
    h('button', { disabled: linked || s.lockQuad, title: 'Make the quad an upright rectangle around the mask', onclick: () => { s.frame = bboxFrame(s.pts); commit(); } }, 'Fit quad to mask')));

  box.append(grp('Layer',
    h('button', { title: 'Move this layer up', disabled: idx === shapes.length - 1, onclick: () => moveLayer(s.id, 1) }, 'Up'),
    h('button', { title: 'Move this layer down', disabled: idx === 0, onclick: () => moveLayer(s.id, -1) }, 'Down'),
    h('button', { class: s.visible ? '' : 'on', title: 'Show or hide this layer', onclick: () => { s.visible = !s.visible; commit(); } }, s.visible ? 'Hide' : 'Show')));

  box.append(h('span', { class: 'grp push' },
    h('button', { onclick: () => duplicateShape(s.id), title: 'Duplicate this shape (Cmd+D)' }, 'Duplicate'),
    h('button', { class: 'danger', onclick: () => deleteShape(s.id), title: 'Delete this shape (Delete key)' }, 'Delete shape')));
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

const SIZES = [[1280, 720], [1920, 1080], [1920, 1200], [2560, 1440], [3840, 2160], [1080, 1920], [1200, 1920], [2160, 3840]];

function syncSizeUI() {
  const sel = $('#outSize');
  const { w, h: hh } = app.project.output;
  if (!sel.options.length) {
    for (const [a, b] of SIZES) sel.append(h('option', { value: `${a}x${b}` }, `${a} x ${b}${b > a ? ' portrait' : ''}`));
    sel.append(h('option', { value: 'match' }, 'Match output window'));
    sel.append(h('option', { value: 'custom' }, 'Custom'));
  }
  const preset = SIZES.some(([a, b]) => a === w && b === hh);
  if (document.activeElement !== sel) sel.value = preset ? `${w}x${hh}` : 'custom';
  $('#customSize').hidden = sel.value !== 'custom';
  if (document.activeElement !== $('#outW')) $('#outW').value = w;
  if (document.activeElement !== $('#outH')) $('#outH').value = hh;
}

/** Say whether the output size matches the display the output window is on. */
function updateOutInfo() {
  const el = $('#outInfo');
  const { w, h: hh } = app.project.output;
  const orient = w === hh ? 'square' : w > hh ? 'landscape' : 'portrait';
  let text = orient, warn = false;
  try {
    const win = app.outWin;
    if (win && !win.closed && win.document.fullscreenElement) {
      const [tw, th] = outputWindowPixels(win);
      if (tw === w && th === hh) text = `${orient}, matches the display`;
      else { text = `display is ${tw} x ${th}: letterboxed`; warn = true; }
    }
  } catch (_) { /* window still loading */ }
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

/**
 * Change the output size. Shape coordinates are normalized to the output, so a change of aspect
 * ratio would stretch every shape; instead the layout is scaled uniformly and kept centred.
 */
function setOutputSize(w, hh) {
  w = even(w);
  hh = even(hh);
  if (!isFinite(w) || !isFinite(hh)) return;
  const { w: W0, h: H0 } = app.project.output;
  if (w === W0 && hh === H0) return;
  // Scale by the shorter side, so swapping width and height (Rotate) and swapping back is lossless.
  const k = Math.min(w, hh) / Math.min(W0, H0);
  const remap = (p) => [0.5 + ((p[0] - 0.5) * W0 * k) / w, 0.5 + ((p[1] - 0.5) * H0 * k) / hh];
  for (const s of app.project.shapes) {
    s.pts = s.pts.map(remap);
    if (s.frame) s.frame = s.frame.map(remap);
  }
  app.project.output = { w, h: hh };
  renderer.setSize(w, hh);
  commit();
  arrange();
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
  const orient = w === hh ? 'square' : w > hh ? 'landscape' : 'portrait';
  const extra = mode === 'offline'
    ? (ex.canOfflineExport() ? 'Renders every frame in order; takes as long as it needs.' : 'Offline rendering needs WebCodecs (Chrome).')
    : 'Captures the live canvas; pacing depends on this machine.';
  $('#exInfo').textContent = `${w} x ${hh} ${orient} (the output size), ${Math.round(dur * fps)} frames, about ${mb.toFixed(0)} MB, no audio. ${extra}`;
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
    setPlaying(wasPlaying);
    exportAbort = null;
    progress.hidden = true;
    $('#exStart').disabled = false;
    $('#exCancel').hidden = true;
    $('#exClose').disabled = false;
  }
}

// ---------- adding shapes ----------

function addPreset(kind) {
  const n = app.project.shapes.length;
  if (kind === 'quad') addShapes([quadShape(n)]);
  else if (kind === 'box') addShapes(boxShapes());
  else addShapes([presetShape(kind, app.project.output, n)]);
}

/** Every closed outline in an SVG file becomes a mask shape, fitted to the output with its proportions kept. */
async function importSVGShapes(file) {
  try {
    if (file.size > 5e6) throw new Error('That SVG is larger than 5 MB.');
    const { rings, skipped, bounds } = parseSVG(await file.text());
    const [W, H] = size();
    const base = file.name.replace(/\.svg$/i, '').slice(0, 40) || 'SVG';
    const shapes = fitRings(rings, bounds, W, H).map((r, i) => {
      const shape = newShape(r.pts, r.name || (rings.length > 1 ? `${base} ${i + 1}` : base));
      shape.frame = bboxFrame(shape.pts);
      if (r.color) shape.content.color = r.color;
      return shape;
    });
    addShapes(shapes);
    say(`Imported ${shapes.length} shape(s) from ${file.name}.` + (skipped ? ` ${skipped} element(s) skipped (text, images, open lines or references).` : ''));
  } catch (err) {
    say('SVG import failed: ' + (err.message || err), true);
  }
}

/** Draw the Add buttons' icons from the same outlines the buttons create. */
function buildShapeButtons() {
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (polys, cls) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-1.15 -1.15 2.3 2.3');
    svg.setAttribute('aria-hidden', 'true');
    for (const pts of polys) {
      const el = document.createElementNS(NS, 'polygon');
      el.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      if (cls) el.setAttribute('class', cls);
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(el);
    }
    return svg;
  };
  const art = {
    quad: [[[-1, -0.7], [0.9, -0.85], [1, 0.75], [-0.85, 0.8]]],
    box: [[[-0.9, -0.45], [0, -0.05], [0, 1], [-0.9, 0.55]], [[0.08, -0.05], [0.98, -0.45], [0.98, 0.55], [0.08, 1]], [[-0.86, -0.55], [0.04, -0.95], [0.94, -0.55], [0.04, -0.15]]],
  };
  for (const b of document.querySelectorAll('#shapeGrid .shape')) {
    const kind = b.dataset.add;
    if (b.id === 'addSVG') {
      b.append(icon([[[-0.9, -0.2], [-0.3, -0.9], [0.5, -0.6], [0.95, 0.1], [0.3, 0.9], [-0.6, 0.7]]], 'ln'), 'SVG file');
      b.onclick = () => $('#svgInput').click();
      continue;
    }
    b.append(icon(art[kind] || [PRESETS[kind].pts()]), kind === 'quad' ? 'Quad' : kind === 'box' ? 'Box' : PRESETS[kind].name);
    b.onclick = () => addPreset(kind);
  }
  $('#svgInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSVGShapes(f); };
}

// ---------- wiring ----------

function wire() {
  buildShapeButtons();
  $('#emptyQuad').onclick = () => addPreset('quad');
  $('#emptyBox').onclick = () => addPreset('box');
  for (const b of document.querySelectorAll('#rail .tool')) {
    b.onclick = () => setTool(app.tool === b.dataset.tool ? 'select' : b.dataset.tool);
  }
  for (const b of document.querySelectorAll('#targetBar .tgt[data-target]')) b.onclick = () => setTarget(b.dataset.target);
  $('#tgtSep').onclick = toggleSeparate;
  $('#zoomIn').onclick = () => zoomAt(1.25);
  $('#zoomOut').onclick = () => zoomAt(0.8);
  $('#zoomFit').onclick = fitView;
  const stepHistory = (p) => { if (p) { setProject(sanitize(p)); autosave(app.project); } };
  $('#undo').onclick = () => stepHistory(app.history.undo());
  $('#redo').onclick = () => stepHistory(app.history.redo());
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
    app.sel = { shapeId: null, handle: -1 };
    app.tool = 'select';
    commit();
    say('Cleared. Undo brings it back.');
  };

  $('#outSize').onchange = (e) => {
    const v = e.target.value;
    if (v === 'custom') { $('#customSize').hidden = false; $('#outW').focus(); return; }
    e.target.blur();
    if (v === 'match') {
      const w = app.outWin;
      if (!w || w.closed) { say('Open the output window first, then choose this again.', true); syncSizeUI(); return; }
      const [tw, th] = outputWindowPixels(w);
      setOutputSize(tw, th);
      syncSizeUI();
      say(`Output set to ${app.project.output.w} x ${app.project.output.h}.`);
      return;
    }
    const [w, hh] = v.split('x').map(Number);
    setOutputSize(w, hh);
  };
  const customChanged = () => setOutputSize(Number($('#outW').value), Number($('#outH').value));
  $('#outW').onchange = customChanged;
  $('#outH').onchange = customChanged;
  $('#rotateOut').onclick = () => { const { w, h: hh } = app.project.output; setOutputSize(hh, w); };

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
      app.sel = { shapeId: null, handle: -1 };
      setProject(project);
      commit();
      $('#exportDlg').close();
      say(missing ? `Layout loaded. ${missing} shape(s) reference media that is not in this browser; import the files to relink.` : 'Layout loaded.', missing > 0);
    } catch (err) {
      say('Import failed: ' + (err.message || err), true);
    }
  };

  new ResizeObserver(layout).observe(stage);
  // The inspector and top bar wrap, so their height changes with the selection and the window.
  let arranging = 0;
  const rearrange = () => { cancelAnimationFrame(arranging); arranging = requestAnimationFrame(arrange); };
  window.addEventListener('resize', rearrange);
  new ResizeObserver(rearrange).observe($('#inspector'));
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
  $('#build').textContent = typeof BUILD === 'string' ? 'build ' + BUILD : '';
  try { await loadAll(); } catch (err) { console.warn('Media library unavailable', err); say('Browser storage is unavailable; media will not persist.', true); }
  const project = await loadSaved();
  relinkMedia(project);
  setProject(project, { resetHistory: true });
  updateStorage();
  schedule();
}

init();

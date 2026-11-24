// Project model, undo history and autosave.

import * as store from './store.js';

const PALETTE = ['#ff3d71', '#00d1ff', '#ffd166', '#7cff6b', '#b388ff', '#ff8a3d'];
let nextColor = 0;

export const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function newProject() {
  return {
    app: 'cornerpin',
    version: 1,
    name: 'Untitled',
    output: { w: 1920, h: 1080 },
    shapes: [], // index 0 is the bottom layer
  };
}

export function newShape(pts, name) {
  const color = PALETTE[nextColor++ % PALETTE.length];
  return {
    id: uid(),
    name: name || 'Shape',
    visible: true,
    pts: pts.map((p) => [p[0], p[1]]),
    frame: null, // the content quad's 4 corners; null on a 4-point shape = the mask follows the quad
    content: { type: 'solid', color, color2: '#101020', gradType: 'linear', angle: 0, shader: 'plasma', speed: 1, scale: 1, mediaId: null, mediaName: null },
    fit: 'fill',
    rot: 0,
    flipH: false,
    flipV: false,
    opacity: 1,
    blend: 'normal',
  };
}

export function quadShape(n) {
  const o = ((n % 5) * 0.03);
  return newShape([[0.3 + o, 0.3 + o], [0.7 + o, 0.3 + o], [0.7 + o, 0.7 + o], [0.3 + o, 0.7 + o]], 'Quad');
}

/** Three quads sharing corners: the visible faces of a box seen from a front corner. */
export function boxShapes() {
  const top = [0.5, 0.2], left = [0.3, 0.33], right = [0.7, 0.33], mid = [0.5, 0.46];
  const bl = [0.3, 0.68], br = [0.7, 0.68], bottom = [0.5, 0.84];
  return [
    newShape([left, mid, bottom, bl], 'Box left'),
    newShape([mid, right, br, bottom], 'Box right'),
    newShape([left, top, right, mid], 'Box top'),
  ];
}

/** Validate and normalize a project loaded from storage or a JSON file. */
export function sanitize(raw) {
  const p = newProject();
  if (!raw || typeof raw !== 'object') return p;
  if (typeof raw.name === 'string') p.name = raw.name.slice(0, 120);
  const w = Number(raw.output?.w), h = Number(raw.output?.h);
  if (w >= 16 && w <= 8192 && h >= 16 && h <= 8192) p.output = { w: Math.round(w), h: Math.round(h) };
  const num = (v, d, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const pt = (q) => Array.isArray(q) && q.length >= 2 && isFinite(q[0]) && isFinite(q[1]) ? [Number(q[0]), Number(q[1])] : null;
  const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
  for (const s of Array.isArray(raw.shapes) ? raw.shapes : []) {
    const pts = (Array.isArray(s?.pts) ? s.pts : []).map(pt).filter(Boolean);
    if (pts.length < 3) continue;
    const shape = newShape(pts, typeof s.name === 'string' ? s.name.slice(0, 80) : 'Shape');
    shape.id = typeof s.id === 'string' ? s.id : uid();
    shape.visible = s.visible !== false;
    const frame = (Array.isArray(s.frame) ? s.frame : []).map(pt).filter(Boolean);
    shape.frame = frame.length === 4 ? frame : null;
    const c = s.content || {};
    shape.content = {
      type: ['solid', 'gradient', 'shader', 'media'].includes(c.type) ? c.type : 'solid',
      color: color(c.color, shape.content.color),
      color2: color(c.color2, '#101020'),
      gradType: c.gradType === 'radial' ? 'radial' : 'linear',
      angle: num(c.angle, 0, -360, 360),
      shader: typeof c.shader === 'string' ? c.shader : 'plasma',
      speed: num(c.speed, 1, 0, 10),
      scale: num(c.scale, 1, 0.1, 20),
      mediaId: typeof c.mediaId === 'string' ? c.mediaId : null,
      mediaName: typeof c.mediaName === 'string' ? c.mediaName : null,
    };
    shape.fit = ['fill', 'cover', 'contain'].includes(s.fit) ? s.fit : 'fill';
    shape.rot = [0, 1, 2, 3].includes(s.rot) ? s.rot : 0;
    shape.flipH = !!s.flipH;
    shape.flipV = !!s.flipV;
    shape.opacity = num(s.opacity, 1, 0, 1);
    shape.blend = ['normal', 'add', 'screen', 'multiply'].includes(s.blend) ? s.blend : 'normal';
    p.shapes.push(shape);
  }
  return p;
}

export class History {
  constructor(limit = 100) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.current = null;
  }
  reset(project) {
    this.past = [];
    this.future = [];
    this.current = JSON.stringify(project);
  }
  /** Record the project if it changed since the last commit. Returns true when something was recorded. */
  commit(project) {
    const snap = JSON.stringify(project);
    if (snap === this.current) return false;
    if (this.current !== null) this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = snap;
    this.future = [];
    return true;
  }
  undo() {
    if (!this.past.length) return null;
    this.future.push(this.current);
    this.current = this.past.pop();
    return JSON.parse(this.current);
  }
  redo() {
    if (!this.future.length) return null;
    this.past.push(this.current);
    this.current = this.future.pop();
    return JSON.parse(this.current);
  }
}

let saveTimer = null;
export function autosave(project) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.setKV('project', JSON.parse(JSON.stringify(project))).catch((e) => console.warn('Autosave failed', e));
  }, 400);
}

export async function loadSaved() {
  try {
    return sanitize(await store.getKV('project'));
  } catch (e) {
    console.warn('Could not load saved project', e);
    return newProject();
  }
}

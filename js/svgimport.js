// Turn an SVG file into mask outlines.
//
// The uploaded file is parsed with DOMParser and never inserted into the page. Only geometry
// (path data, basic-shape attributes, transform attributes and plain fill colours) is copied
// into clean elements in a private, hidden <svg>, which the browser then measures. Scripts,
// event-handler attributes, styles, images and links in the file are never instantiated.

const NS = 'http://www.w3.org/2000/svg';
const GEOMETRY = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline']);
const SKIP_INSIDE = new Set(['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter']);
const MAX_SHAPES = 80;
const MAX_POINTS = 72;

const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Split path data into subpaths, each rewritten to start with an absolute moveto. A relative
 * "m" depends on where the previous subpath ended, so the current point is tracked through
 * every command.
 */
export function splitSubpaths(d) {
  const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const out = [];
  let cur = '', x = 0, y = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) return out;
    const lower = cmd.toLowerCase(), rel = cmd === lower, n = ARGS[lower];
    if (n === undefined) return out;
    if (lower === 'z') { cur += ' Z'; x = sx; y = sy; cmd = null; continue; }
    if (i + n > tokens.length) break;
    const a = tokens.slice(i, i + n).map(Number);
    if (a.some((v) => !isFinite(v))) break;
    i += n;
    if (lower === 'm') {
      x = rel ? x + a[0] : a[0];
      y = rel ? y + a[1] : a[1];
      sx = x; sy = y;
      flush();
      cur = `M ${x} ${y}`;
      cmd = rel ? 'l' : 'L'; // further coordinate pairs after a moveto are linetos
      continue;
    }
    if (!cur) cur = `M ${x} ${y}`;
    cur += ` ${cmd} ${a.join(' ')}`;
    if (lower === 'h') x = rel ? x + a[0] : a[0];
    else if (lower === 'v') y = rel ? y + a[0] : a[0];
    else { x = rel ? x + a[n - 2] : a[n - 2]; y = rel ? y + a[n - 1] : a[n - 1]; }
  }
  flush();
  return out;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Douglas-Peucker on an open polyline. */
function rdp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring to at most `max` points, loosening the tolerance until it fits. */
export function simplifyRing(pts, tol, max = MAX_POINTS) {
  let ring = pts;
  if (ring.length > 1 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < tol * 0.5) {
    ring = ring.slice(0, -1);
  }
  if (ring.length <= 3) return ring;
  // Anchor the split at the two points farthest apart so the closing edge is simplified too.
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) { farD = d; far = i; }
  }
  const halfA = ring.slice(0, far + 1), halfB = [...ring.slice(far), ring[0]];
  for (let t = tol, n = 0; n < 24; n++, t *= 1.5) {
    const a = rdp(halfA, t), b = rdp(halfB, t);
    const out = [...a.slice(0, -1), ...b.slice(0, -1)];
    if (out.length <= max) return out;
  }
  return ring.filter((_, i) => i % Math.ceil(ring.length / max) === 0);
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function fillColor(el) {
  const style = el.getAttribute('style') || '';
  const m = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style);
  const raw = (m ? m[1] : el.getAttribute('fill') || '').trim();
  let h = /^#([0-9a-f]{3})$/i.exec(raw);
  if (h) return '#' + h[1].split('').map((c) => c + c).join('').toLowerCase();
  h = /^#([0-9a-f]{6})$/i.exec(raw);
  return h ? '#' + h[1].toLowerCase() : null;
}

const num = (el, name) => { const v = parseFloat(el.getAttribute(name)); return isFinite(v) ? v : 0; };

/** Path data for one geometry element, built only from numeric attributes. */
function pathDataFor(el, tag) {
  if (tag === 'path') return splitSubpaths(el.getAttribute('d') || '');
  if (tag === 'rect') {
    const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
    return w > 0 && h > 0 ? [`M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`] : [];
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = num(el, 'cx'), cy = num(el, 'cy');
    const rx = tag === 'circle' ? num(el, 'r') : num(el, 'rx'), ry = tag === 'circle' ? num(el, 'r') : num(el, 'ry');
    return rx > 0 && ry > 0 ? [`M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`] : [];
  }
  const nums = (el.getAttribute('points') || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  if (nums.length < 6) return [];
  let d = '';
  for (let i = 0; i + 1 < nums.length; i += 2) d += `${i ? ' L' : 'M'} ${Number(nums[i])} ${Number(nums[i + 1])}`;
  return [d + ' Z'];
}

/** Transform attributes from the element up to the root, outermost first. Only plain transform syntax is kept. */
function transformChain(el) {
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const t = n.getAttribute('transform');
    if (t && /^[\sa-zA-Z0-9().,+\-eE]*$/.test(t)) chain.unshift(t);
  }
  return chain;
}

/**
 * Parse SVG text into outlines.
 * @returns {{ rings: Array<{ pts: number[][], name: string, color: string|null }>, skipped: number }}
 *          points are in the file's own user units; the caller fits them to the output.
 */
export function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('That file is not a readable SVG.');
  }
  const host = document.createElementNS(NS, 'svg');
  host.setAttribute('width', '10');
  host.setAttribute('height', '10');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  const raw = [];
  let skipped = 0;
  try {
    const walk = (node) => {
      for (const el of node.children) {
        const tag = el.localName.toLowerCase();
        if (SKIP_INSIDE.has(tag)) continue;
        if (GEOMETRY.has(tag)) {
          const subs = pathDataFor(el, tag);
          const chain = transformChain(el);
          const base = (el.getAttribute('id') || '').replace(/[^\w\- ]+/g, ' ').trim().slice(0, 60);
          subs.forEach((d, k) => {
            // Rebuild just this subpath under clean <g transform> wrappers and let the browser measure it.
            let parent = host;
            const wrappers = [];
            for (const t of chain) {
              const g = document.createElementNS(NS, 'g');
              g.setAttribute('transform', t);
              parent.appendChild(g);
              wrappers.push(g);
              parent = g;
            }
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            parent.appendChild(path);
            try {
              const len = path.getTotalLength();
              if (!(len > 0)) { skipped++; return; }
              const ctm = path.getCTM() || new DOMMatrix();
              const steps = Math.max(8, Math.min(600, Math.ceil(len / 2)));
              const pts = [];
              for (let s = 0; s < steps; s++) {
                const p = path.getPointAtLength((s / steps) * len).matrixTransform(ctm);
                pts.push([p.x, p.y]);
              }
              raw.push({ pts, name: base ? (subs.length > 1 ? `${base} ${k + 1}` : base) : '', color: fillColor(el) });
            } catch (_) {
              skipped++;
            } finally {
              (wrappers[0] || path).remove();
            }
          });
        } else if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
          walk(el);
        } else if (tag === 'use' || tag === 'text' || tag === 'image' || tag === 'line') {
          skipped++;
        }
      }
    };
    walk(root);
  } finally {
    host.remove();
  }
  if (!raw.length) throw new Error('No closed shapes were found in that SVG.');

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of raw) for (const [x, y] of r.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  const rings = [];
  for (const r of raw) {
    const pts = simplifyRing(r.pts, diag * 0.002);
    if (pts.length < 3 || ringArea(pts) < diag * diag * 1e-6) { skipped++; continue; }
    rings.push({ ...r, pts });
  }
  if (!rings.length) throw new Error('No closed shapes were found in that SVG.');
  // Largest first, so big backgrounds end up at the bottom of the layer stack.
  rings.sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
  if (rings.length > MAX_SHAPES) { skipped += rings.length - MAX_SHAPES; rings.length = MAX_SHAPES; }
  return { rings, skipped, bounds: { x0, y0, x1, y1 } };
}

/** Fit rings into the output, keeping their proportions, centred, filling `fill` of the smaller dimension. */
export function fitRings(rings, bounds, W, H, fill = 0.7) {
  const bw = bounds.x1 - bounds.x0 || 1, bh = bounds.y1 - bounds.y0 || 1;
  const k = Math.min((W * fill) / bw, (H * fill) / bh);
  const ox = (W - bw * k) / 2, oy = (H - bh * k) / 2;
  return rings.map((r) => ({ ...r, pts: r.pts.map(([x, y]) => [(ox + (x - bounds.x0) * k) / W, (oy + (y - bounds.y0) * k) / H]) }));
}

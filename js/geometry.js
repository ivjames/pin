// Geometry helpers. All shape coordinates are normalized to the output (0..1 on both axes).

/** Solve the 8x8 linear system for the homography that maps src[i] -> dst[i] (4 point pairs). */
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[n] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Row-major 3x3 inverse. Returns null when singular. */
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

export function applyH(m, [x, y]) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * Matrix taking an output position (normalized) to content UV, for a 4-corner frame.
 * Frame order is TL, TR, BR, BL of the content. Returns null for a degenerate frame.
 */
export function frameToUV(frame) {
  const H = homography(UNIT, frame);
  return H ? invert3(H) : null;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function inTri(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Ear-clipping triangulation of a simple polygon. Returns index triples into pts. */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  const idx = pts.map((_, i) => i);
  if (signedArea(pts) < 0) idx.reverse();
  const out = [];
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(a, b, c) <= 1e-14) continue; // reflex or collinear
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate or self-intersecting input: drop a vertex so we always terminate.
      out.push(idx[0], idx[1], idx[2]);
      idx.splice(1, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on segment ab to p, with parameter t in 0..1. */
export function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { pt: [a[0] + dx * t, a[1] + dy * t], t };
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function bboxFrame(pts) {
  const b = bbox(pts);
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
}

/**
 * Snap a normalized position to the nearest candidate within `tol` pixels.
 * Candidates are other vertices plus the output edges. `size` is [W, H] in pixels.
 * Returns { pt, snapped } where snapped is 'point' | 'edge' | null.
 */
export function snapPoint(p, candidates, size, tol) {
  const [W, H] = size;
  let best = null, bestD = tol;
  for (const c of candidates) {
    const d = Math.hypot((c[0] - p[0]) * W, (c[1] - p[1]) * H);
    if (d <= bestD) { bestD = d; best = c; }
  }
  if (best) return { pt: [best[0], best[1]], snapped: 'point' };
  let [x, y] = p, snapped = null;
  for (const e of [0, 1]) {
    if (Math.abs(x - e) * W <= tol) { x = e; snapped = 'edge'; }
    if (Math.abs(y - e) * H <= tol) { y = e; snapped = 'edge'; }
  }
  return { pt: [x, y], snapped };
}

/** Aspect ratio (w/h) of a frame in output pixels, estimated from its edge lengths. */
export function frameAspect(frame, size) {
  const [W, H] = size;
  const d = (a, b) => Math.hypot((a[0] - b[0]) * W, (a[1] - b[1]) * H);
  const w = (d(frame[0], frame[1]) + d(frame[3], frame[2])) / 2;
  const h = (d(frame[1], frame[2]) + d(frame[0], frame[3])) / 2;
  return h > 0 ? w / h : 1;
}

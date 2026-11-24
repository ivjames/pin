// Runtime media library: decodes stored blobs into <video> elements and ImageBitmaps for the renderer.

import * as store from './store.js';

export const media = new Map(); // id -> { id, name, kind, blob, size, url, el, bitmap, w, h, duration, version }

const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function kindOf(type, name) {
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return 'video';
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)) return 'image';
  return null;
}

const isSVG = (m) => (m.blob && m.blob.type === 'image/svg+xml') || /\.svg$/i.test(m.name || '');

/**
 * createImageBitmap cannot decode an SVG blob, and an SVG may have no pixel size of its own.
 * Load it through an <img> (which runs no scripts) and draw it to a canvas at a fixed resolution.
 */
async function rasterizeSVG(blob) {
  const typed = blob.type === 'image/svg+xml' ? blob : new Blob([blob], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(typed);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('This SVG cannot be drawn as an image'));
      img.src = url;
    });
    let w = img.naturalWidth, hgt = img.naturalHeight;
    if (!w || !hgt) { w = 1024; hgt = 1024; }
    const k = 2048 / Math.max(w, hgt);
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(hgt * k));
    const canvas = new OffscreenCanvas(cw, ch);
    canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
    return canvas.transferToImageBitmap();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function hydrate(rec) {
  const m = { ...rec, url: null, el: null, bitmap: null, w: 0, h: 0, duration: 0, version: 0, error: null };
  try {
    if (m.kind === 'video') {
      m.url = URL.createObjectURL(m.blob);
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = m.url;
      await new Promise((resolve, reject) => {
        v.addEventListener('loadeddata', resolve, { once: true });
        v.addEventListener('error', () => reject(new Error('This video format cannot be decoded here')), { once: true });
      });
      m.el = v;
      m.w = v.videoWidth;
      m.h = v.videoHeight;
      m.duration = isFinite(v.duration) ? v.duration : 0;
      v.play().catch(() => {});
    } else {
      m.bitmap = isSVG(m) ? await rasterizeSVG(m.blob) : await createImageBitmap(m.blob);
      m.w = m.bitmap.width;
      m.h = m.bitmap.height;
    }
  } catch (err) {
    m.error = err.message || String(err);
  }
  media.set(m.id, m);
  return m;
}

export async function loadAll() {
  const recs = await store.allMedia();
  await Promise.all(recs.map(hydrate));
}

/** Import user-picked files. Returns the media entries that were added. */
export async function importFiles(files) {
  const added = [];
  for (const file of files) {
    const kind = kindOf(file.type || '', file.name);
    if (!kind) continue;
    const rec = { id: uid(), name: file.name, kind, blob: file, size: file.size };
    await store.putMedia(rec);
    added.push(await hydrate(rec));
  }
  return added;
}

export async function remove(id) {
  const m = media.get(id);
  if (!m) return;
  if (m.el) { m.el.pause(); m.el.removeAttribute('src'); m.el.load(); }
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.bitmap) m.bitmap.close();
  media.delete(id);
  await store.deleteMedia(id);
}

export function findByName(name) {
  for (const m of media.values()) if (m.name === name) return m;
  return null;
}

export function setPlaying(playing) {
  for (const m of media.values()) {
    if (!m.el) continue;
    if (playing) m.el.play().catch(() => {});
    else m.el.pause();
  }
}

export function restartAll() {
  for (const m of media.values()) if (m.el) m.el.currentTime = 0;
}

/** Seek a video to an exact time and resolve once that frame is ready to be sampled. */
export function seekTo(v, t) {
  return new Promise((resolve) => {
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const target = dur ? Math.min(t % dur, Math.max(0, dur - 0.001)) : 0;
    if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2 && !v.seeking) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    v.addEventListener('seeked', finish);
    v.currentTime = target;
  });
}

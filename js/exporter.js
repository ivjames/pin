// Exports: offline MP4 (WebCodecs), real-time recording fallback (MediaRecorder), SVG outlines, JSON layout.

import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.js';
import { seekTo } from './media.js';
import { effectiveFrame } from './renderer.js';

export const canOfflineExport = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const safeName = (name) => (name || 'cornerpin').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'cornerpin';

export function defaultBitrate(w, h, fps) {
  // About 12 Mbps at 1080p30, scaled by pixel rate and clamped to a sane range.
  const bps = 12e6 * ((w * h) / (1920 * 1080)) * Math.sqrt(fps / 30);
  return Math.round(Math.max(2e6, Math.min(80e6, bps)));
}

async function pickCodec(width, height, fps, bitrate) {
  const pixels = width * height;
  let candidates;
  if (pixels > 1920 * 1088) candidates = ['avc1.640034', 'avc1.640033', 'avc1.640032'];
  else if (fps > 30) candidates = ['avc1.64002A', 'avc1.640032', 'avc1.4D402A'];
  else candidates = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.64002A'];
  for (const codec of candidates) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const config = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: 'avc' } };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return config;
      } catch (_) { /* try next */ }
    }
  }
  return null;
}

/** Videos used by visible shapes. */
export function usedVideos(project, media) {
  const out = new Map();
  for (const s of project.shapes) {
    if (!s.visible || s.content.type !== 'media') continue;
    const m = media.get(s.content.mediaId);
    if (m && m.kind === 'video' && m.el && !m.error) out.set(m.id, m);
  }
  return [...out.values()];
}

/**
 * Render `duration` seconds frame by frame and encode to H.264 MP4.
 * Each source video is seeked to the exact frame time, so the result does not depend on machine speed.
 */
export async function exportMP4({ project, media, renderer, duration, fps, bitrate, onProgress, signal }) {
  const width = renderer.canvas.width, height = renderer.canvas.height;
  if (width % 2 || height % 2) throw new Error('H.264 needs even dimensions. Change the output size to even numbers.');
  const config = await pickCodec(width, height, fps, bitrate);
  if (!config) throw new Error(`This browser has no H.264 encoder for ${width}x${height} at ${fps} fps.`);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const videos = usedVideos(project, media);
  for (const m of videos) m.el.pause();
  const total = Math.max(1, Math.round(duration * fps));
  const frameUs = 1e6 / fps;
  const gop = Math.max(1, Math.round(fps * 2));

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const t = i / fps;
      // Sample each source video at the middle of the output frame. Seeking to the exact frame
      // boundary lands on the previous frame whenever i / fps rounds down.
      await Promise.all(videos.map((m) => seekTo(m.el, t + 0.5 / fps)));
      renderer.render(project, t, media, {});
      const frame = new VideoFrame(renderer.canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      if (i % 5 === 0) {
        onProgress?.(i / total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    onProgress?.(1);
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    for (const m of videos) m.el.play().catch(() => {});
  }
}

/** Real-time capture of the live canvas. Quality and pacing depend on the machine. */
export function recordRealtime({ canvas, duration, fps, bitrate, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder !== 'function') return reject(new Error('MediaRecorder is not available.'));
    const types = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return reject(new Error('No recordable video format is available.'));
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    const chunks = [];
    const start = performance.now();
    let timer = null;
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    rec.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (signal?.aborted) return reject(new DOMException('Recording cancelled', 'AbortError'));
      const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      resolve({ blob: new Blob(chunks, { type: mimeType.split(';')[0] }), ext });
    };
    signal?.addEventListener('abort', stop);
    timer = setInterval(() => {
      const p = (performance.now() - start) / (duration * 1000);
      onProgress?.(Math.min(1, p));
      if (p >= 1) stop();
    }, 100);
    rec.start(1000);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * SVG of every shape outline at output resolution, for use as a template in Photoshop, Illustrator, etc.
 * Shapes are white on a black background layer; content frames of non-quad shapes go in a separate group.
 */
export function buildSVG(project) {
  const { w, h } = project.output;
  const r = (n) => Math.round(n * 100) / 100;
  const poly = (pts) => pts.map(([x, y]) => `${r(x * w)},${r(y * h)}`).join(' ');
  const used = new Set();
  const idFor = (name, i) => {
    let id = safeName(name) || 'shape';
    if (/^[^a-zA-Z_]/.test(id)) id = 's_' + id;
    let out = id, n = 2;
    while (used.has(out)) out = `${id}_${n++}`;
    used.add(out);
    return out || `shape_${i + 1}`;
  };
  const outlines = [], frames = [];
  project.shapes.forEach((s, i) => {
    const id = idFor(s.name, i);
    const hidden = s.visible ? '' : ' display="none"';
    outlines.push(`    <polygon id="${id}" points="${poly(s.pts)}"${hidden}><title>${esc(s.name)}</title></polygon>`);
    if (s.pts.length !== 4) {
      frames.push(`    <polygon id="${id}_frame" points="${poly(effectiveFrame(s))}"><title>${esc(s.name)} content frame</title></polygon>`);
    }
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `  <title>${esc(project.name)} - Cornerpin outlines</title>`,
    `  <g id="background"><rect width="${w}" height="${h}" fill="#000000"/></g>`,
    '  <g id="outlines" fill="#ffffff" stroke="none">',
    ...outlines,
    '  </g>',
    ...(frames.length
      ? ['  <g id="content_frames" fill="none" stroke="#00d1ff" stroke-width="2" stroke-dasharray="8 6">', ...frames, '  </g>']
      : []),
    '</svg>',
    '',
  ].join('\n');
}

export function buildJSON(project) {
  return JSON.stringify(project, null, 2);
}

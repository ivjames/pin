// WebGL2 renderer. Each shape is a triangulated outline whose pixels look up content
// through the inverse homography of its 4-corner content frame, so flat surfaces stay
// perspective-correct no matter how many points the outline has.

import { triangulate, frameToUV, bboxFrame, frameAspect } from './geometry.js';

export const SHADERS = [
  { id: 'plasma', name: 'Plasma' },
  { id: 'stripes', name: 'Stripes' },
  { id: 'checker', name: 'Checker' },
  { id: 'rings', name: 'Rings' },
  { id: 'noise', name: 'Smoke' },
  { id: 'rainbow', name: 'Rainbow' },
  { id: 'scanner', name: 'Scanner' },
  { id: 'grid', name: 'Grid' },
];

const TYPE = { solid: 0, linear: 1, radial: 2, texture: 3, missing: 4, test: 5 };
const SHADER_BASE = 10;

const VS = `#version 300 es
in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 outColor;
uniform mat3 uInv;
uniform int uType;
uniform int uRot;
uniform vec2 uFlip;
uniform vec2 uFit;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uAngle;
uniform float uTime;
uniform float uScale;
uniform float uOpacity;
uniform vec2 uRes;
uniform sampler2D uTex;

const float PI = 3.14159265;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return s;
}
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }

vec3 testPattern(vec2 p) {
  vec2 px = p * uRes;
  float cell = max(40.0, floor(uRes.y / 9.0));
  vec2 g = abs(fract((px - uRes * 0.5) / cell + 0.5) - 0.5) * cell;
  float line = 1.0 - smoothstep(0.75, 1.75, min(g.x, g.y));
  vec3 col = vec3(0.07) + vec3(0.55) * line;
  vec2 c = px - uRes * 0.5;
  float r = length(c);
  float ring = 1.0 - smoothstep(1.0, 2.5, abs(r - uRes.y * 0.45));
  col = mix(col, vec3(1.0, 0.85, 0.1), ring);
  float crossL = (1.0 - smoothstep(1.0, 2.0, min(abs(c.x), abs(c.y))));
  col = mix(col, vec3(0.1, 0.9, 1.0), crossL);
  vec2 b = min(px, uRes - px);
  float border = 1.0 - step(3.0, min(b.x, b.y));
  col = mix(col, vec3(1.0, 0.2, 0.3), border);
  return col;
}

void main() {
  if (uType == ${TYPE.test}) { outColor = vec4(testPattern(vPos), 1.0); return; }

  vec3 q = uInv * vec3(vPos, 1.0);
  vec2 uv = q.xy / q.z;
  float alpha = 1.0;
  if (any(lessThan(uv, vec2(-0.003))) || any(greaterThan(uv, vec2(1.003)))) alpha = 0.0;
  uv = clamp(uv, 0.0, 1.0);

  if (uRot == 1) uv = vec2(uv.y, 1.0 - uv.x);
  else if (uRot == 2) uv = 1.0 - uv;
  else if (uRot == 3) uv = vec2(1.0 - uv.y, uv.x);
  uv = mix(uv, 1.0 - uv, uFlip);

  vec3 col = uC1;
  float t = uTime;
  float s = uScale;

  if (uType == ${TYPE.linear}) {
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    float k = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
    col = mix(uC1, uC2, clamp(k, 0.0, 1.0));
  } else if (uType == ${TYPE.radial}) {
    col = mix(uC1, uC2, clamp(length(uv - 0.5) * 2.0, 0.0, 1.0));
  } else if (uType == ${TYPE.texture}) {
    vec2 tuv = (uv - 0.5) * uFit + 0.5;
    if (any(lessThan(tuv, vec2(0.0))) || any(greaterThan(tuv, vec2(1.0)))) alpha = 0.0;
    vec4 tx = texture(uTex, clamp(tuv, 0.0, 1.0));
    col = tx.rgb;
    alpha *= tx.a;
  } else if (uType == ${TYPE.missing}) {
    vec2 c = floor(uv * 8.0);
    col = mod(c.x + c.y, 2.0) < 1.0 ? vec3(0.45, 0.0, 0.35) : vec3(0.12);
  } else if (uType == ${SHADER_BASE}) { // plasma
    vec2 p = (uv - 0.5) * s * 4.0;
    float v = sin(p.x + t) + sin(p.y * 1.3 - t * 0.7) + sin((p.x + p.y) * 0.8 + t * 0.5) + sin(length(p) * 1.5 - t);
    col = mix(uC1, uC2, 0.5 + 0.5 * sin(v * 1.2));
  } else if (uType == ${SHADER_BASE + 1}) { // stripes
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    float v = fract(dot(uv - 0.5, d) * s * 4.0 - t * 0.5);
    col = mix(uC1, uC2, smoothstep(0.48, 0.52, v) - smoothstep(0.98, 1.0, v));
  } else if (uType == ${SHADER_BASE + 2}) { // checker
    vec2 c = floor((uv + vec2(t * 0.05, 0.0)) * s * 4.0);
    col = mod(c.x + c.y, 2.0) < 1.0 ? uC1 : uC2;
  } else if (uType == ${SHADER_BASE + 3}) { // rings
    float v = fract(length(uv - 0.5) * s * 4.0 - t * 0.5);
    col = mix(uC1, uC2, smoothstep(0.0, 0.5, v) * (1.0 - smoothstep(0.5, 1.0, v)) * 2.0);
  } else if (uType == ${SHADER_BASE + 4}) { // smoke
    vec2 p = uv * s * 3.0;
    float v = fbm(p + vec2(fbm(p + t * 0.15), fbm(p - t * 0.11)) * 2.0);
    col = mix(uC1, uC2, smoothstep(0.25, 0.75, v));
  } else if (uType == ${SHADER_BASE + 5}) { // rainbow
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    col = hue(dot(uv - 0.5, d) * s * 0.5 + t * 0.1);
  } else if (uType == ${SHADER_BASE + 6}) { // scanner
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    float k = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
    float pos = 0.5 + 0.5 * sin(t);
    float w = 0.25 / max(s, 0.25);
    col = mix(uC2, uC1, exp(-pow((k - pos) / w, 2.0) * 4.0));
  } else if (uType == ${SHADER_BASE + 7}) { // grid
    vec2 g = abs(fract(uv * s * 4.0) - 0.5);
    float line = 1.0 - smoothstep(0.42, 0.47, max(g.x, g.y));
    float pulse = 0.75 + 0.25 * sin(t * 2.0);
    col = mix(uC1 * pulse, uC2, line);
  }

  float a = alpha * uOpacity;
  outColor = vec4(col * a, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The 4-corner quad that warps a shape's content.
 * `frame: null` on a 4-point shape means the mask follows the quad (they are the same points).
 */
export function effectiveFrame(shape) {
  if (shape.frame) return shape.frame;
  return shape.pts.length === 4 ? shape.pts : bboxFrame(shape.pts);
}

/** True when the mask and the quad are one and the same set of points. */
export const isLinked = (shape) => !shape.frame && shape.pts.length === 4;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const name of ['uInv', 'uType', 'uRot', 'uFlip', 'uFit', 'uC1', 'uC2', 'uAngle', 'uTime', 'uScale', 'uOpacity', 'uRes', 'uTex']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.textures = new Map(); // media id -> { tex, version }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  setSize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  _texture(m) {
    const gl = this.gl;
    let entry = this.textures.get(m.id);
    if (!entry) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, m.kind === 'image' ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      entry = { tex, uploaded: false, frame: -1 };
      this.textures.set(m.id, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    if (m.kind === 'image') {
      if (!entry.uploaded && m.bitmap) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.bitmap);
        gl.generateMipmap(gl.TEXTURE_2D);
        entry.uploaded = true;
      }
    } else if (m.el && m.el.readyState >= 2 && entry.frame !== this.frameId) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.el);
      entry.uploaded = true;
      entry.frame = this.frameId;
    }
    return entry.uploaded ? entry : null;
  }

  dropTexture(id) {
    const entry = this.textures.get(id);
    if (entry) { this.gl.deleteTexture(entry.tex); this.textures.delete(id); }
  }

  _blend(mode) {
    const gl = this.gl;
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _draw(verts) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
  }

  /**
   * Draw the whole project.
   * @param project  project model
   * @param time     seconds, drives the built-in shaders
   * @param media    Map of media entries
   * @param opts     { testPattern: boolean }
   */
  render(project, time, media, opts = {}) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    this.frameId = (this.frameId || 0) + 1;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uRes, W, H);
    gl.uniform1i(this.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    if (opts.testPattern) {
      gl.disable(gl.BLEND);
      gl.uniform1i(this.u.uType, TYPE.test);
      this._draw(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]));
    }

    gl.enable(gl.BLEND);
    for (const shape of project.shapes) {
      if (!shape.visible || shape.pts.length < 3) continue;
      const frame = effectiveFrame(shape);
      const inv = frameToUV(frame);
      if (!inv) continue;
      const tris = triangulate(shape.pts);
      if (!tris.length) continue;
      const verts = new Float32Array(tris.length * 2);
      for (let i = 0; i < tris.length; i++) {
        verts[i * 2] = shape.pts[tris[i]][0];
        verts[i * 2 + 1] = shape.pts[tris[i]][1];
      }

      const c = shape.content;
      let type = TYPE.solid;
      let fit = [1, 1];
      if (c.type === 'gradient') type = c.gradType === 'radial' ? TYPE.radial : TYPE.linear;
      else if (c.type === 'shader') {
        const idx = SHADERS.findIndex((s) => s.id === c.shader);
        type = SHADER_BASE + (idx < 0 ? 0 : idx);
      } else if (c.type === 'media') {
        const m = media.get(c.mediaId);
        const entry = m && !m.error ? this._texture(m) : null;
        if (!entry) type = TYPE.missing;
        else {
          type = TYPE.texture;
          if (shape.fit !== 'fill' && m.w && m.h) {
            let ar = frameAspect(frame, [W, H]);
            if (shape.rot % 2 === 1) ar = 1 / ar;
            const mr = m.w / m.h;
            const wider = mr > ar;
            if (shape.fit === 'cover') fit = wider ? [ar / mr, 1] : [1, mr / ar];
            else fit = wider ? [1, mr / ar] : [ar / mr, 1];
          }
        }
      }

      // uInv is row-major; WebGL wants column-major.
      gl.uniformMatrix3fv(this.u.uInv, false, [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]);
      gl.uniform1i(this.u.uType, type);
      gl.uniform1i(this.u.uRot, shape.rot || 0);
      gl.uniform2f(this.u.uFlip, shape.flipH ? 1 : 0, shape.flipV ? 1 : 0);
      gl.uniform2f(this.u.uFit, fit[0], fit[1]);
      gl.uniform3fv(this.u.uC1, hexToRgb(c.color));
      gl.uniform3fv(this.u.uC2, hexToRgb(c.color2));
      gl.uniform1f(this.u.uAngle, ((c.angle || 0) * Math.PI) / 180);
      gl.uniform1f(this.u.uTime, time * (c.speed ?? 1));
      gl.uniform1f(this.u.uScale, c.scale ?? 1);
      gl.uniform1f(this.u.uOpacity, shape.opacity ?? 1);
      this._blend(shape.blend);
      this._draw(verts);
    }
  }
}

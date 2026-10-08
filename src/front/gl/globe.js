// WebGL globe. Everything geographic is drawn by the GPU in one pass: base (terrain classes), land (Natural
// Earth rings filled by stencil parity into a texture, once), coasts and contour lines (segments extruded to a
// width in the vertex shader). The 2D canvas only carries life.
import { app } from '../state.js';
import { gcv } from '../dom.js';
import { cam, view } from '../camera.js';
import { GLOBE_VS, GLOBE_FS, QUAD_VS, WHITE_FS, FILL_VS, LINE_VS, LINE_FS } from './shaders.js';
import { MASK_MAX, LINE_CHUNK } from '../constants.js';

// Everything geographic is drawn by the GPU in one pass: base (terrain classes), land (Natural Earth rings
// filled by stencil parity into a texture, once), coasts and contour lines (segments extruded to a width in
// the vertex shader). The 2D canvas only carries life.
export const gl = gcv.getContext('webgl', { antialias: true, alpha: false, stencil: true, premultipliedAlpha: false });
function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
function program(vs, fs) { const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}, a = {}; for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const n = gl.getActiveUniform(p, i).name; u[n] = gl.getUniformLocation(p, n); } for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) { const n = gl.getActiveAttrib(p, i).name; a[n] = gl.getAttribLocation(p, n); } return { p, u, a }; }
const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

// --- 1. the globe: disc, base, land, graticule, shading
const GLOBE = program(GLOBE_VS, GLOBE_FS);
const texBase = gl.createTexture(), texMask = gl.createTexture();
function texParams(filter, wrapS) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
export function uploadBase(img) { gl.bindTexture(gl.TEXTURE_2D, texBase); texParams(gl.NEAREST, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); }

// --- 2. land: stencil parity over the rings, equirectangular, into a texture
const MASKW = Math.min(MASK_MAX, gl.getParameter(gl.MAX_TEXTURE_SIZE)), MASKH = MASKW / 2;
const QUADP = program(QUAD_VS, WHITE_FS);
const FILL = program(FILL_VS, WHITE_FS);
export function buildMask(rings) {
  // fan triangles from each ring's first point; stencil parity does the rest (holes included)
  let tri = 0; for (const r of rings) tri += Math.max(0, r.length / 2 - 2);
  const data = new Float32Array(tri * 6); let o = 0;
  for (const r of rings) { const ax = r[0], ay = r[1]; for (let i = 1; i + 1 < r.length / 2; i++) { data[o++] = ax; data[o++] = ay; data[o++] = r[2 * i]; data[o++] = r[2 * i + 1]; data[o++] = r[2 * i + 2]; data[o++] = r[2 * i + 3]; } }
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texMask); texParams(gl.LINEAR, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MASKW, MASKH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texMask, 0);
  const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, MASKW, MASKH);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
  gl.viewport(0, 0, MASKW, MASKH); gl.clearColor(0, 0, 0, 1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.useProgram(FILL.p); gl.enableVertexAttribArray(FILL.a.ll); gl.vertexAttribPointer(FILL.a.ll, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.STENCIL_TEST); gl.colorMask(false, false, false, false);
  gl.stencilFunc(gl.ALWAYS, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
  for (const off of [0, -360]) { gl.uniform1f(FILL.u.off, off); gl.drawArrays(gl.TRIANGLES, 0, tri * 3); }   // rings unwrapped past 180° come back on the left
  gl.colorMask(true, true, true, true); gl.stencilFunc(gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  gl.disableVertexAttribArray(FILL.a.ll);
  gl.useProgram(QUADP.p); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(QUADP.a.p); gl.vertexAttribPointer(QUADP.a.p, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);                 // white wherever parity is odd: the land
  gl.disableVertexAttribArray(QUADP.a.p);
  gl.disable(gl.STENCIL_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteBuffer(vb); gl.deleteRenderbuffer(rb); gl.deleteFramebuffer(fb);
}

// --- 3. lines: each segment extruded into a quad in the vertex shader
const LINE = program(LINE_VS, LINE_FS);
// flat geometry: 4 vertices per segment (a0, a1, corner), 16-bit indices in chunks of 16,000 segments
const CHUNK = LINE_CHUNK;
const lineSets = [];                       // { chunks: [{ vb, ib, n }], color, width }
export function addLines(lines, color, width) {
  const segs = [];
  for (const L of lines) for (let j = 0; j + 1 < L.n; j++) segs.push(L.x[j], L.y[j], L.z[j], L.x[j + 1], L.y[j + 1], L.z[j + 1]);
  const total = segs.length / 6, chunks = [];
  for (let c0 = 0; c0 < total; c0 += CHUNK) {
    const n = Math.min(CHUNK, total - c0), v = new Float32Array(n * 4 * 8), ix = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const s = (c0 + i) * 6;
      for (let k = 0; k < 4; k++) { const o = (i * 4 + k) * 8; v[o] = segs[s]; v[o + 1] = segs[s + 1]; v[o + 2] = segs[s + 2]; v[o + 3] = segs[s + 3]; v[o + 4] = segs[s + 4]; v[o + 5] = segs[s + 5]; v[o + 6] = k >> 1; v[o + 7] = (k & 1) ? 1 : -1; }
      const b = i * 4, q = i * 6; ix[q] = b; ix[q + 1] = b + 1; ix[q + 2] = b + 2; ix[q + 3] = b + 2; ix[q + 4] = b + 1; ix[q + 5] = b + 3;
    }
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
    chunks.push({ vb, ib, n });
  }
  lineSets.push({ chunks, color, width });
}
export function drawLines(M, R, cxd, cyd, w, h) {
  if (!lineSets.length) return;
  gl.useProgram(LINE.p); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniformMatrix3fv(LINE.u.M, false, M); gl.uniform2f(LINE.u.res, w, h); gl.uniform2f(LINE.u.center, cxd, cyd); gl.uniform1f(LINE.u.R, R);
  gl.enableVertexAttribArray(LINE.a.a0); gl.enableVertexAttribArray(LINE.a.a1); gl.enableVertexAttribArray(LINE.a.corner);
  for (const s of lineSets) {
    gl.uniform4fv(LINE.u.color, s.color); gl.uniform1f(LINE.u.hw, s.width * view.dpr / 2);
    for (const c of s.chunks) {
      gl.bindBuffer(gl.ARRAY_BUFFER, c.vb);
      gl.vertexAttribPointer(LINE.a.a0, 3, gl.FLOAT, false, 32, 0); gl.vertexAttribPointer(LINE.a.a1, 3, gl.FLOAT, false, 32, 12); gl.vertexAttribPointer(LINE.a.corner, 2, gl.FLOAT, false, 32, 24);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.ib);
      gl.drawElements(gl.TRIANGLES, c.n * 6, gl.UNSIGNED_SHORT, 0);
    }
  }
  gl.disableVertexAttribArray(LINE.a.a0); gl.disableVertexAttribArray(LINE.a.a1); gl.disableVertexAttribArray(LINE.a.corner);
  gl.disable(gl.BLEND);
}
export function drawGlobe(w, h, cxd, cyd, Rd) {
  gl.useProgram(GLOBE.p);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(GLOBE.a.p); gl.vertexAttribPointer(GLOBE.a.p, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texBase); gl.uniform1i(GLOBE.u.base, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texMask); gl.uniform1i(GLOBE.u.mask, 1);
  gl.uniform2f(GLOBE.u.res, w, h); gl.uniform2f(GLOBE.u.center, cxd - w / 2, h / 2 - cyd); gl.uniform1f(GLOBE.u.R, Rd);
  gl.uniform1f(GLOBE.u.lon0, cam.lon); gl.uniform1f(GLOBE.u.lat0, cam.lat); gl.uniform1f(GLOBE.u.climate, app.world.climate || 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(GLOBE.a.p);
}

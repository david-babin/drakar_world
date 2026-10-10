// GLSL sources of the globe.

// 1. the globe: disc, base, land, graticule, shading
export const GLOBE_VS = `attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0., 1.); }`;
export const GLOBE_FS = `
precision highp float;
varying vec2 v;
uniform vec2 res; uniform vec2 center; uniform float R; uniform float lon0, lat0; uniform float climate;
uniform sampler2D base; uniform sampler2D mask;
const float PI = 3.14159265;
// charte, theme nuit: surfaces and hairlines for the land, marine-tint for the shelf
vec3 landCol(float t) {
  if (t < 3.5) return vec3(0.137, 0.165, 0.200);     // plain (or unknown class at the edge): hairline #232a33
  if (t < 4.5) return vec3(0.170, 0.198, 0.233);     // hills
  if (t < 5.5) return vec3(0.215, 0.243, 0.278);     // mountain (towards hairline-strong)
  return vec3(0.200, 0.232, 0.268);                  // ice
}
void main() {
  vec2 px = v * res * .5;
  vec2 q = (px - center) / R;
  float d2 = dot(q, q);
  vec3 bg = vec3(0.027, 0.035, 0.047);
  float tint = climate;
  // the climate, as an atmosphere: a diffuse halo around the globe and a glow on its limb, brass when the index
  // rises, marine-text when it falls (charte colours)
  vec3 glowC = tint >= 0. ? vec3(0.831, 0.647, 0.227) : vec3(0.663, 0.741, 0.863);
  if (d2 > 1.0) { float d = sqrt(d2); float halo = exp(-(d - 1.0) * 14.0) * (0.10 + 0.10 * abs(tint)); gl_FragColor = vec4(bg + glowC * halo, 1.); return; }
  float z = sqrt(1.0 - d2);
  float cl0 = cos(lat0), sl0 = sin(lat0);
  float lat = asin(clamp(q.y * cl0 + z * sl0, -1., 1.));
  float lon = lon0 + atan(q.x, cl0 * z - q.y * sl0);
  vec2 uv = vec2(mod(lon / (2. * PI) + .5, 1.), 0.5 - lat / PI);
  float fv = floor(texture2D(base, uv).r * 255. + .5);
  float t = floor(fv / 32.), lvl = mod(fv, 32.) / 2.;
  float land = texture2D(mask, uv).r;                 // vector land, edges smoothed by filtering
  vec3 sea = (t >= 1.5 || t == 1.) ? vec3(0.082, 0.125, 0.184) : vec3(0.059, 0.075, 0.098);   // continental shelf: marine-tint #15202f · deep sea: surface-200 #0f1319
  vec3 c = mix(sea, landCol(t + 1.) * (1.0 + lvl * 0.035), land);
  if (t > 4.5 && land > 0.5) c = landCol(6.);        // ice
  float gla = abs(fract(lat / PI * 12. + .5) - .5), glo = abs(fract(lon / PI * 12. + .5) - .5);
  float gw = 0.012 * (1.0 + 3.0 * (1.0 - z));
  float grat = (1.0 - smoothstep(0.0, gw, gla)) + (1.0 - smoothstep(0.0, gw, glo));
  c += vec3(0.925, 0.922, 0.902) * grat * 0.035;
  float shade = 0.55 + 0.45 * pow(z, 0.6);
  c *= shade;
  c += glowC * (0.05 * abs(tint)) * (1.0 - z);
  float aa = smoothstep(1.0, 1.0 - 2.0 / R, d2);
  gl_FragColor = vec4(mix(bg, c, aa), 1.);
}`;

// 2. land: stencil parity over the rings, equirectangular, into a texture
export const QUAD_VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
export const WHITE_FS = `precision mediump float; void main(){ gl_FragColor = vec4(1.); }`;
export const FILL_VS = `attribute vec2 ll; uniform float off; void main(){ gl_Position = vec4((ll.x + off) / 180., ll.y / 90., 0., 1.); }`;

// 3. lines: each segment extruded into a quad in the vertex shader
export const LINE_VS = `
attribute vec3 a0, a1; attribute vec2 corner;
uniform mat3 M; uniform vec2 res, center; uniform float R, hw;
varying float vz;
void main() {
  vec3 q0 = M * a0, q1 = M * a1;
  vec2 s0 = center + R * vec2(q0.x, -q0.y), s1 = center + R * vec2(q1.x, -q1.y);
  vec2 d = s1 - s0; float L = length(d); d = L > 0.0 ? d / L : vec2(1., 0.);
  vec2 n = vec2(-d.y, d.x);
  vec2 p = (corner.x < 0.5 ? s0 : s1) + n * corner.y * hw;
  vz = min(q0.z, q1.z);
  gl_Position = vec4(p.x / res.x * 2. - 1., 1. - p.y / res.y * 2., 0., 1.);
}`;
export const LINE_FS = `precision mediump float; varying float vz; uniform vec4 color; void main(){ if (vz < 0.0) discard; gl_FragColor = vec4(color.rgb, color.a * smoothstep(0.0, 0.12, vz)); }`;

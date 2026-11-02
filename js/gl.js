/* Darkroom WebGL pipeline.
   geometry (crop/rotate/flip/straighten) → grade (preset curve, colour, split tone)
   → preset halation glow → look (softness, grain, vignette, leak, fisheye, strength mix, manual adjustments)
   → final (effects, frame, before/after split) → sprites (date stamp, text, film-rebate edge text). */
'use strict';
(function () {
const R = window.DRGL = {};
let gl = null, canvas = null;
let progGeom, progGrade, progBright, progBlur, progLook, progFinal, progSprite, quadBuf, dummyTex;

const VS = `attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const VS_SPRITE = `attribute vec2 a_pos; varying vec2 v_uv;
uniform vec2 u_out, u_center, u_half; uniform float u_rot;
void main(){
  vec2 l = vec2(a_pos.x, -a_pos.y) * u_half;
  float c = cos(u_rot), s = sin(u_rot);
  vec2 p = u_center + vec2(c * l.x - s * l.y, s * l.x + c * l.y);
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(p.x / u_out.x * 2.0 - 1.0, 1.0 - p.y / u_out.y * 2.0, 0.0, 1.0);
}`;

const FS_SPRITE = `precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha;
void main(){ vec4 c = texture2D(u_tex, v_uv); gl_FragColor = vec4(c.rgb, c.a * u_alpha); }`;

const FS_GEOM = `precision highp float;
varying vec2 v_uv; uniform sampler2D u_src; uniform vec3 u_m0, u_m1;
void main(){
  vec3 o = vec3(v_uv.x, 1.0 - v_uv.y, 1.0);
  vec2 s = clamp(vec2(dot(u_m0, o), dot(u_m1, o)), 0.0, 1.0);
  gl_FragColor = vec4(texture2D(u_src, vec2(s.x, 1.0 - s.y)).rgb, 1.0);
}`;

const FS_GRADE = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src, u_lut;
uniform float u_exposure, u_contrast, u_saturation, u_scale, u_fade, u_shadowAmt, u_hiAmt;
uniform vec3 u_mix, u_shadowTint, u_hiTint;
vec3 curve(vec3 x){ x = (clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return vec3(texture2D(u_lut, vec2(x.r, 0.5)).r, texture2D(u_lut, vec2(x.g, 0.5)).g, texture2D(u_lut, vec2(x.b, 0.5)).b); }
vec3 softLight(vec3 b, vec3 s){
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
}
void main(){
  vec3 c = texture2D(u_src, v_uv).rgb * exp2(u_exposure);
  c = curve(c);
  float l = dot(c, vec3(0.2125, 0.7154, 0.0721));
  c = mix(vec3(l), c, u_saturation);
  c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  c = clamp(c * u_mix * u_scale + u_fade, 0.0, 1.0);
  float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c, softLight(c, u_shadowTint), (1.0 - l2) * u_shadowAmt);
  c = mix(c, softLight(c, u_hiTint), l2 * u_hiAmt);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/* Bright pass (threshold >= 0) or plain downsample copy (threshold < 0) */
const FS_BRIGHT = `precision highp float;
varying vec2 v_uv; uniform sampler2D u_src; uniform float u_amount, u_thresh; uniform vec3 u_tint;
void main(){
  vec3 c = texture2D(u_src, v_uv).rgb;
  if (u_thresh < 0.0) { gl_FragColor = vec4(c, 1.0); return; }
  float h = smoothstep(u_thresh, 1.0, dot(c, vec3(0.3, 0.6, 0.1)));
  gl_FragColor = vec4(u_tint * h * u_amount, 1.0);
}`;

const FS_BLUR = `precision highp float;
varying vec2 v_uv; uniform sampler2D u_src; uniform vec2 u_dir;
void main(){
  vec3 s = texture2D(u_src, v_uv).rgb * 0.2270270270;
  s += (texture2D(u_src, v_uv + u_dir * 1.3846153846).rgb + texture2D(u_src, v_uv - u_dir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture2D(u_src, v_uv + u_dir * 3.2307692308).rgb + texture2D(u_src, v_uv - u_dir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(s, 1.0);
}`;

const NOISE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 overlay(vec3 b, vec3 s){ return mix(1.0 - 2.0 * (1.0 - s) * (1.0 - b), 2.0 * s * b, step(b, vec3(0.5))); }
vec3 screen(vec3 a, vec3 b){ return 1.0 - (1.0 - a) * (1.0 - b); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/* The preset "look" (identical maths to the original final pass, minus the border),
   followed by the manual adjustment panel. */
const FS_LOOK = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_orig, u_grade, u_glow, u_cblur;
uniform vec2 u_size, u_leakPos;
uniform float u_soft, u_grain, u_grainSize, u_chroma, u_vignette, u_leakStrength, u_intensity, u_fisheye, u_halation, u_unit;
uniform float u_adj;
uniform vec4 u_adjA, u_adjB, u_adjC, u_adjD;
${NOISE}
vec3 grade(vec2 uv){ return texture2D(u_grade, uv).rgb; }
vec3 adjust(vec3 c, vec2 uv, vec2 px){
  vec3 o = texture2D(u_orig, uv).rgb;
  if (u_adjD.x > 0.0) {
    vec2 t = max(1.0, u_unit) / u_size;
    vec3 n = (texture2D(u_orig, uv + vec2(t.x, 0.0)).rgb + texture2D(u_orig, uv - vec2(t.x, 0.0)).rgb
            + texture2D(u_orig, uv + vec2(0.0, t.y)).rgb + texture2D(u_orig, uv - vec2(0.0, t.y)).rgb) * 0.25;
    c += lum(o - n) * u_adjD.x * 2.5;
  }
  if (u_adjC.w != 0.0) {
    float l0 = lum(clamp(c, 0.0, 1.0));
    float w = 1.0 - pow(abs(2.0 * l0 - 1.0), 2.0);
    c += (lum(o) - lum(texture2D(u_cblur, uv).rgb)) * u_adjC.w * 1.1 * w;
  }
  c *= exp2(u_adjA.x);
  float tp = u_adjB.z, tn = u_adjB.w;
  c *= vec3(1.0 + tp * 0.12 + tn * 0.04, 1.0 - tn * 0.08, 1.0 - tp * 0.14 + tn * 0.04);
  float wp = 1.0 - u_adjB.x * 0.22, bp = -u_adjB.y * 0.10;
  c = (c - bp) / max(wp - bp, 0.05);
  float l = lum(clamp(c, 0.0, 1.0));
  c += u_adjA.z * 0.28 * smoothstep(0.4, 1.0, l);
  c += u_adjA.w * 0.28 * (1.0 - smoothstep(0.0, 0.55, l));
  vec3 cc = clamp(c, 0.0, 1.0);
  c = u_adjA.y >= 0.0 ? mix(c, cc * cc * (3.0 - 2.0 * cc), u_adjA.y) : mix(c, 0.5 + (c - 0.5) * 0.55, -u_adjA.y);
  l = lum(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, max(0.0, 1.0 + u_adjC.x + u_adjC.y * (1.0 - clamp(sat * 1.6, 0.0, 1.0))));
  c = c * (1.0 - u_adjC.z * 0.25) + u_adjC.z * 0.16;
  float v = u_adjD.y;
  if (v != 0.0) {
    float dn = length(px - u_size * 0.5) / (0.5 * length(u_size));
    float m = smoothstep(0.3, 1.1, dn);
    c = v > 0.0 ? c * (1.0 - v * 0.85 * m) : mix(c, vec3(1.0), -v * 0.6 * m);
  }
  return c;
}
void main(){
  vec2 px = v_uv * u_size;
  vec2 uv = v_uv;
  if (u_fisheye > 0.0) {
    vec2 c = (uv - 0.5) * u_size;
    float R = max(u_size.x, u_size.y) * 0.75;
    float f = 1.0 - u_fisheye * 0.6 * (1.0 - smoothstep(0.0, R, length(c)));
    uv = clamp(c * f / u_size + 0.5, 0.0, 1.0);
  }
  vec3 g;
  if (u_soft > 0.0) {
    vec2 t = u_soft * u_unit / u_size;
    g = grade(uv) * 0.25
      + (grade(uv + vec2(t.x, 0.0)) + grade(uv - vec2(t.x, 0.0)) + grade(uv + vec2(0.0, t.y)) + grade(uv - vec2(0.0, t.y))) * 0.125
      + (grade(uv + t) + grade(uv - t) + grade(uv + vec2(t.x, -t.y)) + grade(uv + vec2(-t.x, t.y))) * 0.0625;
  } else {
    g = grade(uv);
  }
  if (u_halation > 0.0) g = screen(g, texture2D(u_glow, uv).rgb);
  if (u_grain > 0.0 || u_chroma > 0.0) {
    float s = max(1.0, u_grainSize * u_unit);
    vec2 gp = floor(px) / s + 17.0;
    if (u_grain > 0.0) {
      float n = s > 1.01 ? (vnoise(gp) - 0.5) * 1.7 + 0.5 : hash(gp);
      g = overlay(g, vec3(0.5 + (n - 0.5) * u_grain * 0.5));
    }
    if (u_chroma > 0.0) {
      vec2 cp = floor(px / max(1.0, u_unit * 1.5));
      g += (vec3(hash(cp + 3.1), hash(cp + 7.7), hash(cp + 11.3)) - 0.5) * u_chroma * 0.16;
    }
  }
  if (u_vignette > 0.0) {
    float dn = length(px - u_size * 0.5) / (0.5 * length(u_size));
    g *= 1.0 - u_vignette * smoothstep(0.4, 1.05, dn);
  }
  if (u_leakStrength > 0.0) {
    float d = length(px - u_leakPos * u_size) / (max(u_size.x, u_size.y) * 0.7);
    g = screen(g, vec3(1.0, 0.42, 0.12) * u_leakStrength * max(0.0, 1.0 - d));
  }
  vec3 c = mix(texture2D(u_orig, uv).rgb, clamp(g, 0.0, 1.0), u_intensity);
  if (u_adj > 0.5) c = adjust(c, uv, px);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/* Effects layer + frame + before/after split */
const FS_FINAL = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_look, u_fxblur, u_base, u_photo2;
uniform vec2 u_size, u_outSize, u_padLB, u_p2scale, u_leakP, u_leakS;
uniform vec3 u_paper, u_leakC1, u_leakC2;
uniform float u_rebate, u_rebateW, u_unit, u_seed, u_split;
uniform vec4 u_fxA, u_fxB, u_fxC, u_fxD, u_fxE;
${NOISE}
float fbm(vec2 p){ return vnoise(p) * 0.5 + vnoise(p * 2.03 + 5.1) * 0.3 + vnoise(p * 4.1 + 9.7) * 0.2; }
vec3 look(vec2 uv){ return texture2D(u_look, clamp(uv, 0.0, 1.0)).rgb; }
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
float segDist(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

vec3 frameColor(vec2 q){
  if (u_rebate < 0.5) return u_paper;
  bool land = u_size.x >= u_size.y;
  float S = min(u_size.x, u_size.y);
  float a = land ? q.x : q.y;
  float b = land ? (q.y < 0.0 ? -q.y : q.y - u_size.y) : (q.x < 0.0 ? -q.x : q.x - u_size.x);
  if (b <= 0.0) return u_paper;
  float pitch = 0.198 * S;
  float along = mod(a + pitch * 0.25, pitch) - pitch * 0.5;
  float across = b - u_rebateW * 0.6;
  float d = sdBox(vec2(along, across), vec2(0.0575 * S, 0.0415 * S), 0.012 * S);
  return mix(vec3(0.93, 0.91, 0.86), u_paper, smoothstep(-0.8, 0.8, d));
}

void main(){
  vec2 px = v_uv * u_outSize - u_padLB;
  if (px.x < 0.0 || px.y < 0.0 || px.x > u_size.x || px.y > u_size.y) { gl_FragColor = vec4(frameColor(px), 1.0); return; }
  vec2 uv = px / u_size;
  if (uv.x < u_split) { gl_FragColor = vec4(texture2D(u_base, uv).rgb, 1.0); return; }
  float unit = u_unit;
  float seed = u_seed * 13.17;
  float vhs = u_fxC.z;
  vec2 suv = uv;
  if (vhs > 0.0) {
    float by = fract(0.12 + u_seed * 0.37) * 0.7 + 0.1;
    float band = smoothstep(by, by + 0.015, uv.y) * (1.0 - smoothstep(by + 0.03, by + 0.07, uv.y));
    float row = floor(px.y / max(1.0, 2.0 * unit));
    suv.x += ((vnoise(vec2(uv.y * 300.0, seed)) - 0.5) * 0.035 * band + (hash(vec2(row, seed)) - 0.5) * 0.0025) * vhs;
  }
  vec3 c;
  float rgb = u_fxC.w;
  if (rgb > 0.0) {
    vec2 d = u_fxD.x < 0.5 ? (suv - 0.5) * rgb * 0.02 : vec2(rgb * 8.0 * unit / u_size.x, rgb * 1.5 * unit / u_size.y);
    c = vec3(look(suv + d).r, look(suv).g, look(suv - d).b);
  } else {
    c = look(suv);
  }
  if (vhs > 0.0) {
    vec2 st = vec2(3.0 * unit / u_size.x, 0.0);
    vec3 bl = (look(suv - st) + look(suv - st * 2.0) + look(suv - st * 3.0) + look(suv - st * 4.0)) * 0.25;
    float y = lum(c);
    vec3 chroma = bl - lum(bl);
    c = mix(c, vec3(y) + chroma * 1.25, vhs);
  }
  vec3 bl = texture2D(u_fxblur, uv).rgb;
  float blur = u_fxD.y;
  if (blur > 0.0) {
    float st = u_fxD.z;
    if (st < 0.5) c = mix(c, max(c, bl), blur * 0.8);
    else if (st < 1.5) c = mix(c, bl, blur * smoothstep(0.15, 0.75, length((uv - 0.5) * vec2(u_size.x / u_size.y, 1.0)) ));
    else c = mix(c, bl, blur);
  }
  float prism = u_fxD.w;
  if (prism > 0.0) {
    vec2 o = vec2(0.05, 0.015) * (0.5 + prism);
    vec3 g1 = look(uv + o) * hue(fract(uv.y * 0.8 + 0.1));
    vec3 g2 = look(uv - o * 0.6) * hue(fract(uv.y * 0.8 + 0.55));
    float side = smoothstep(0.55, 0.0, uv.x) * 0.8 + 0.2;
    c = screen(c, (g1 * 0.5 + g2 * 0.3) * prism * side);
  }
  if (u_fxC.x > 0.0) c = screen(c, vec3(1.0, 0.28, 0.1) * smoothstep(0.5, 1.0, lum(bl)) * u_fxC.x * 1.4);
  if (u_fxC.y > 0.0) c = screen(c, bl * smoothstep(0.4, 1.0, lum(bl)) * u_fxC.y * 1.3);
  float dbl = u_fxE.x;
  if (dbl > 0.0) {
    vec3 p2 = texture2D(u_photo2, (uv - 0.5) * u_p2scale + 0.5).rgb;
    vec3 m = u_fxE.y < 0.5 ? screen(c, p2) : (u_fxE.y < 1.5 ? max(c, p2) : c * p2 * 1.4);
    c = mix(c, m, dbl);
  }
  float leak = u_fxB.x;
  if (leak > 0.0) {
    vec2 q = (uv - u_leakP) * vec2(u_size.x / max(u_size.x, u_size.y), u_size.y / max(u_size.x, u_size.y));
    float d = length(q * u_leakS);
    float n = fbm(uv * 2.5 + seed);
    float k = clamp(1.0 - d * (0.8 + n * 0.6), 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);
    vec3 col = u_fxB.y > 3.5 ? hue(fract(d * 0.9 + n * 0.3 + 0.95)) * 0.9 : mix(u_leakC2, u_leakC1, k);
    c = screen(c, col * k * leak * 1.15);
  }
  float burn = u_fxB.z;
  if (burn > 0.0) {
    float pos = u_fxB.w;
    float e = pos < 0.5 ? uv.x : (pos < 1.5 ? 1.0 - uv.x : (pos < 2.5 ? 1.0 - uv.y : uv.y));
    float along = pos < 1.5 ? uv.y : uv.x;
    e += (fbm(vec2(along * 5.0, seed)) - 0.5) * 0.18;
    float w = 0.12 + 0.35 * burn;
    float k = 1.0 - smoothstep(0.0, w, e);
    vec3 col = mix(vec3(0.85, 0.12, 0.02), vec3(1.0, 0.55, 0.12), smoothstep(0.1, 0.6, k));
    col = mix(col, vec3(1.0, 0.95, 0.8), smoothstep(0.7, 0.95, k));
    c = screen(c, col * k * min(1.0, burn * 1.4));
  }
  float tex = u_fxE.z;
  if (tex > 0.0) {
    float ts = u_fxE.w;
    if (ts < 0.5) {
      float f = fbm(px / (5.0 * unit) + seed) * 0.6 + fbm(px / (40.0 * unit) + seed) * 0.4;
      c = mix(c, c * (0.86 + 0.2 * f) * vec3(1.02, 1.0, 0.95), tex);
    } else {
      float r = (uv.x * 0.8 + uv.y) + (fbm(uv * 3.0 + seed) - 0.5) * 0.4;
      float sheen = smoothstep(0.45, 0.6, fract(r * 0.9)) * (1.0 - smoothstep(0.6, 0.8, fract(r * 0.9)));
      float wr = hash(floor(px / max(1.0, unit)) + seed);
      c = screen(c, vec3(0.9, 0.95, 1.0) * (sheen * 0.35 + step(0.9993, wr) * 0.6) * tex);
      c = mix(c, c * 0.94 + 0.04, tex * 0.5);
    }
  }
  float dust = u_fxA.z;
  if (dust > 0.0) {
    float ds = u_fxA.w;
    float a = 0.0, dk = 0.0;
    if (ds < 1.5) {
      for (int L = 0; L < 2; L++) {
        float cs = (L == 0 ? 26.0 : 61.0) * unit;
        vec2 cell = floor(px / cs);
        float h = hash(cell + seed + float(L) * 31.0);
        if (h > 1.0 - dust * (L == 0 ? 0.11 : 0.06)) {
          float r = (0.5 + 2.4 * hash(cell + 7.0 + seed)) * unit * (L == 0 ? 1.0 : 1.6);
          vec2 ctr = (cell + 0.2 + 0.6 * vec2(hash(cell + 1.3 + seed), hash(cell + 2.9 + seed))) * cs;
          float m = 1.0 - smoothstep(r - 0.7, r + 0.7, length(px - ctr));
          if (hash(cell + 5.5 + seed) > 0.25) a = max(a, m); else dk = max(dk, m);
        }
      }
      float hs = 180.0 * unit;
      vec2 hc = floor(px / hs);
      if (hash(hc + seed + 77.0) > 1.0 - dust * 0.22) {
        vec2 p0 = (hc + 0.25 + 0.5 * vec2(hash(hc + 3.0 + seed), hash(hc + 4.0 + seed))) * hs;
        float ang = hash(hc + 9.0 + seed) * 6.2832;
        vec2 dir = vec2(cos(ang), sin(ang)) * hs * (0.15 + 0.25 * hash(hc + 11.0 + seed));
        vec2 mid = p0 + dir * 0.5 + vec2(-dir.y, dir.x) * 0.25;
        float dd = min(segDist(px, p0, mid), segDist(px, mid, p0 + dir));
        a = max(a, (1.0 - smoothstep(0.3 * unit, 0.9 * unit, dd)) * 0.8);
      }
    }
    if (ds > 0.5) {
      float col = floor(px.x / max(1.0, 1.4 * unit));
      float h = hash(vec2(col, seed + 3.0));
      if (h > 1.0 - dust * 0.006) {
        float brk = smoothstep(0.35, 0.6, vnoise(vec2(px.y / (90.0 * unit), col)));
        a = max(a, brk * 0.7);
      }
    }
    c = mix(c, vec3(0.95, 0.94, 0.9), a * min(1.0, dust * 1.5));
    c = mix(c, vec3(0.05), dk * 0.8 * min(1.0, dust * 1.5));
  }
  if (vhs > 0.0) {
    c *= 1.0 - vhs * 0.14 * (0.5 + 0.5 * sin(px.y * 3.14159 / max(1.0, 1.5 * unit)));
    c += (hash(floor(px / max(1.0, unit)) + seed) - 0.5) * 0.08 * vhs;
    c = mix(c, c * vec3(1.03, 0.98, 1.06), vhs * 0.6);
  }
  float grain = u_fxA.x;
  if (grain > 0.0) {
    float s = max(1.0, mix(1.0, 4.5, u_fxA.y) * unit);
    vec2 gp = floor(px) / s + 91.0 + seed;
    float n = s > 1.01 ? (vnoise(gp) - 0.5) * 1.7 + 0.5 : hash(gp);
    float l = lum(c);
    float w = 0.55 + 0.45 * (1.0 - abs(2.0 * l - 1.0));
    c = overlay(clamp(c, 0.0, 1.0), vec3(0.5 + (n - 0.5) * grain * 0.7 * w));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return { p, locs: {} };
}
function use(prog, uniforms, textures) {
  gl.useProgram(prog.p);
  const loc = n => (n in prog.locs) ? prog.locs[n] : (prog.locs[n] = gl.getUniformLocation(prog.p, n));
  for (const [n, v] of Object.entries(uniforms)) {
    const l = loc(n); if (l === null) continue;
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v.length === 2) gl.uniform2fv(l, v);
    else if (v.length === 3) gl.uniform3fv(l, v);
    else gl.uniform4fv(l, v);
  }
  textures.forEach(([n, tex], i) => {
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex || dummyTex);
    const l = loc(n); if (l !== null) gl.uniform1i(l, i);
  });
}
function makeTex(w, h, source, flip = true) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (source) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  return t;
}
function makeTarget(w, h) {
  const tex = makeTex(w, h);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}
function freeTarget(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }
function drawTo(target, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/* Monotone cubic through curve points */
function evalCurve(pts, x) {
  if (!pts) return x;
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), n = pts.length;
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
}
const lutCache = {};
function lutFor(p) {
  const key = JSON.stringify([p.curve, p.rgb]);
  if (lutCache[key]) return lutCache[key];
  const data = new Uint8Array(256 * 4);
  const clamp = v => Math.min(1, Math.max(0, v));
  for (let k = 0; k < 256; k++) {
    const y = clamp(evalCurve(p.curve, k / 255));
    const ch = c => Math.round(clamp(p.rgb && p.rgb[c] ? evalCurve(p.rgb[c], y) : y) * 255);
    data.set([ch('r'), ch('g'), ch('b'), 255], k * 4);
  }
  const t = makeTex(256, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return (lutCache[key] = t);
}

/* ---------- Sources ---------- */
R.makeSource = function (img, release) {
  const w = img.width, h = img.height;
  const s = { w, h, tex: makeTex(w, h, img), t: {} };
  if (release && img.getContext) { img.width = img.height = 0; }
  return s;
};
R.freeSource = function (s) {
  if (!s) return;
  if (s.tex) gl.deleteTexture(s.tex);
  for (const k in s.t) freeTarget(s.t[k]);
  s.t = {}; s.tex = null;
};
function target(src, name, w, h) {
  const t = src.t[name];
  if (t && t.w === w && t.h === h) return t;
  freeTarget(t);
  return (src.t[name] = makeTarget(w, h));
}
function dropTarget(src, name) { if (src.t[name]) { freeTarget(src.t[name]); delete src.t[name]; } }

/* ---------- Geometry ---------- */
function mul(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
  return C;
}
R.orientedSize = function (sw, sh, crop) {
  const k = (((crop.rot || 0) % 4) + 4) % 4;
  return k % 2 ? [sh, sw] : [sw, sh];
};
R.geometry = function (sw, sh, crop, editing) {
  const k = (((crop.rot || 0) % 4) + 4) % 4;
  const [W, H] = R.orientedSize(sw, sh, crop);
  const th = (crop.straighten || 0) * Math.PI / 180;
  const r = editing ? [0, 0, 1, 1] : crop.rect;
  const identity = !k && !crop.flipH && !crop.flipV && !th && r[0] === 0 && r[1] === 0 && r[2] === 1 && r[3] === 1;
  const w = Math.max(1, Math.round(r[2] * W)), h = Math.max(1, Math.round(r[3] * H));
  let M = [[r[2], 0, r[0]], [0, r[3], r[1]], [0, 0, 1]];
  M = mul([[W, 0, -W / 2], [0, H, -H / 2], [0, 0, 1]], M);
  const c = Math.cos(th), s = Math.sin(th), a = Math.abs(th);
  const sc = Math.max((W * Math.cos(a) + H * Math.sin(a)) / W, (W * Math.sin(a) + H * Math.cos(a)) / H);
  M = mul([[c / sc, s / sc, 0], [-s / sc, c / sc, 0], [0, 0, 1]], M);
  M = mul([[1 / W, 0, 0.5], [0, 1 / H, 0.5], [0, 0, 1]], M);
  if (crop.flipH) M = mul([[-1, 0, 1], [0, 1, 0], [0, 0, 1]], M);
  if (crop.flipV) M = mul([[1, 0, 0], [0, -1, 1], [0, 0, 1]], M);
  for (let i = 0; i < k; i++) M = mul([[0, 1, 0], [-1, 0, 1], [0, 0, 1]], M);
  return { w, h, identity, m0: M[0], m1: M[1] };
};

/* ---------- Frames ---------- */
R.framePads = function (frame, preset, w, h) {
  const S = Math.min(w, h), r = v => Math.round(v);
  switch (frame) {
    case 'none': return { l: 0, r: 0, t: 0, b: 0, color: [1, 1, 1] };
    case 'thin': { const p = r(S * 0.025); return { l: p, r: p, t: p, b: p, color: [0.98, 0.975, 0.96] }; }
    case 'thick': { const p = r(S * 0.09); return { l: p, r: p, t: p, b: p, color: [0.98, 0.975, 0.96] }; }
    case 'black': { const p = r(S * 0.05); return { l: p, r: p, t: p, b: p, color: [0.035, 0.035, 0.035] }; }
    case 'polaroid': return { l: r(w * 0.06), r: r(w * 0.06), t: r(w * 0.07), b: r(w * 0.26), color: [0.955, 0.945, 0.915] };
    case 'rebate': {
      const rw = r(S * 0.23), e = r(S * 0.04);
      const land = w >= h;
      return land ? { l: e, r: e, t: rw, b: rw, color: [0.06, 0.05, 0.045], rebate: rw }
                  : { l: rw, r: rw, t: e, b: e, color: [0.06, 0.05, 0.045], rebate: rw };
    }
    default: // 'preset'
      if (preset.border) { const p = r(S * 0.04); return { l: p, r: p, t: p, b: p, color: preset.border.map(v => v / 255) }; }
      return { l: 0, r: 0, t: 0, b: 0, color: [1, 1, 1] };
  }
};

const LEAK_POS = { tl: [0, 1], tr: [1, 1], bl: [0, 0], br: [1, 0] }; // GL uv, y up
// effect light leak placements: centre (uv, y up) and anisotropic scale
const FX_LEAK_POS = [
  { p: [-0.12, 0.5], s: [1.7, 0.55] }, { p: [1.12, 0.5], s: [1.7, 0.55] },
  { p: [0.5, 1.12], s: [0.55, 1.7] }, { p: [0.5, -0.12], s: [0.55, 1.7] },
  { p: [0, 1], s: [1.25, 1.25] }, { p: [1, 1], s: [1.25, 1.25] },
  { p: [0, 0], s: [1.25, 1.25] }, { p: [1, 0], s: [1.25, 1.25] }
];
const FX_LEAK_COL = [
  [[1, 0.78, 0.35], [0.95, 0.25, 0.05]],   // warm
  [[1, 0.7, 0.75], [0.85, 0.15, 0.4]],     // rose
  [[1, 0.92, 0.6], [1, 0.6, 0.1]],         // gold
  [[0.75, 0.9, 1], [0.2, 0.35, 0.95]],     // cool
  [[1, 1, 1], [1, 1, 1]]                   // rainbow (computed in shader)
];

function blurChain(srcTex, A, B, bright, spread, passes) {
  use(progBright, bright, [['u_src', srcTex]]);
  drawTo(A, A.w, A.h);
  for (let i = 0; i < passes; i++) {
    use(progBlur, { u_dir: [spread / A.w, 0] }, [['u_src', A.tex]]); drawTo(B, B.w, B.h);
    use(progBlur, { u_dir: [0, spread / A.h] }, [['u_src', B.tex]]); drawTo(A, A.w, A.h);
  }
}

R.photo2 = null; // { tex, w, h } for double exposure
R.setPhoto2 = function (img) {
  if (R.photo2) gl.deleteTexture(R.photo2.tex);
  R.photo2 = img ? { tex: makeTex(img.width, img.height, img), w: img.width, h: img.height } : null;
};

/* Main render. st = edit state, p = resolved preset; o = { editing, split, original, overlays(layout) => sprites, lean }
   Returns true when the drawing buffer really got the requested size. */
R.render = function (src, st, p, o = {}) {
  const fx = st.fx || {}, adj = st.adjust || {};
  const geo = R.geometry(src.w, src.h, st.crop, o.editing);
  const w = geo.w, h = geo.h;
  const unit = Math.max(w, h) / 2000;
  const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));

  let baseTex = src.tex;
  if (!geo.identity) {
    const base = target(src, 'base', w, h);
    use(progGeom, { u_m0: geo.m0, u_m1: geo.m1 }, [['u_src', src.tex]]);
    drawTo(base, w, h);
    baseTex = base.tex;
    if (o.lean) { gl.deleteTexture(src.tex); src.tex = null; }
  } else dropTarget(src, 'base');

  const original = !!o.original;
  const strength = original ? 0 : st.strength;
  const grade = target(src, 'grade', w, h);
  use(progGrade, {
    u_exposure: p.exposure, u_contrast: p.contrast, u_saturation: p.saturation, u_scale: p.scale, u_fade: p.fade,
    u_mix: p.mix, u_shadowTint: p.shadowTint || [.5, .5, .5], u_shadowAmt: p.shadowTint ? p.shadowAmount : 0,
    u_hiTint: p.highlightTint || [.5, .5, .5], u_hiAmt: p.highlightTint ? p.highlightAmount : 0
  }, [['u_src', baseTex], ['u_lut', lutFor(p)]]);
  drawTo(grade, w, h);

  let glowTex = null;
  if (p.halation > 0) {
    const A = target(src, 'glowA', qw, qh), B = target(src, 'glowB', qw, qh);
    blurChain(grade.tex, A, B, { u_amount: p.halation, u_thresh: p.halThreshold, u_tint: p.halTint }, Math.max(1, 1.6 * unit), 2);
    glowTex = A.tex;
  }

  const a = k => (original ? 0 : (adj[k] || 0));
  const adjOn = !original && Object.keys(adj).some(k => adj[k]);
  let cblurTex = null;
  if (adjOn && adj.clarity) {
    const A = target(src, 'cA', qw, qh), B = target(src, 'cB', qw, qh);
    blurChain(baseTex, A, B, { u_amount: 1, u_thresh: -1, u_tint: [1, 1, 1] }, Math.max(1, 3 * unit), 3);
    cblurTex = A.tex;
  }

  const lookT = target(src, 'look', w, h);
  const fish = Math.min(1, p.fisheye + (original ? 0 : (fx.fisheye ? fx.fisheye.amount : 0)));
  use(progLook, {
    u_size: [w, h], u_soft: p.softness, u_grain: p.grain, u_grainSize: p.grainSize, u_chroma: p.chroma || 0,
    u_vignette: p.vignette, u_leakPos: LEAK_POS[p.leak] || [1, 1], u_leakStrength: p.leak ? p.leakStrength : 0,
    u_intensity: strength, u_fisheye: original ? p.fisheye : fish, u_halation: p.halation, u_unit: unit,
    u_adj: adjOn ? 1 : 0,
    u_adjA: [a('exposure'), a('contrast'), a('highlights'), a('shadows')],
    u_adjB: [a('whites'), a('blacks'), a('temp'), a('tint')],
    u_adjC: [a('saturation'), a('vibrance'), a('fade'), a('clarity')],
    u_adjD: [a('sharpen'), a('vignette'), 0, 0]
  }, [['u_orig', baseTex], ['u_grade', grade.tex], ['u_glow', glowTex], ['u_cblur', cblurTex]]);
  drawTo(lookT, w, h);
  if (o.lean) dropTarget(src, 'grade');

  const f = k => (original || !fx[k] ? 0 : fx[k].amount || 0);
  let fxBlurTex = null;
  if (f('halation') || f('bloom') || f('blur') || f('prism')) {
    const A = target(src, 'fA', qw, qh), B = target(src, 'fB', qw, qh);
    blurChain(lookT.tex, A, B, { u_amount: 1, u_thresh: -1, u_tint: [1, 1, 1] }, Math.max(1, 2.2 * unit), 3);
    fxBlurTex = A.tex;
  }

  const pads = o.editing ? R.framePads('none', p, w, h) : R.framePads(st.frame || 'preset', p, w, h);
  const ow = w + pads.l + pads.r, oh = h + pads.t + pads.b;
  if (canvas.width !== ow) canvas.width = ow;
  if (canvas.height !== oh) canvas.height = oh;

  const leak = fx.leak || {}, burn = fx.burn || {};
  const lp = FX_LEAK_POS[leak.pos || 0], lc = FX_LEAK_COL[leak.style || 0];
  let p2scale = [1, 1];
  if (R.photo2) {
    const ra = (w / h) / (R.photo2.w / R.photo2.h);
    p2scale = ra > 1 ? [1, 1 / ra] : [ra, 1];
  }
  const g = k => (fx[k] || {});
  use(progFinal, {
    u_size: [w, h], u_outSize: [ow, oh], u_padLB: [pads.l, pads.b], u_paper: pads.color,
    u_rebate: pads.rebate ? 1 : 0, u_rebateW: pads.rebate || 0, u_unit: unit, u_seed: (fx.seed || 1) % 97,
    u_split: original ? 2 : (o.split == null ? -1 : o.split),
    u_fxA: [f('grain'), g('grain').size ?? 0.4, f('dust'), g('dust').style || 0],
    u_fxB: [f('leak'), leak.style || 0, f('burn'), burn.pos || 0],
    u_fxC: [f('halation'), f('bloom'), f('vhs'), f('rgb')],
    u_fxD: [g('rgb').style || 0, f('blur'), g('blur').style || 0, f('prism')],
    u_fxE: [R.photo2 ? f('double') : 0, g('double').style || 0, f('texture'), g('texture').style || 0],
    u_leakP: lp.p, u_leakS: lp.s, u_leakC1: lc[0], u_leakC2: lc[1], u_p2scale: p2scale
  }, [['u_look', lookT.tex], ['u_fxblur', fxBlurTex], ['u_base', baseTex], ['u_photo2', R.photo2 && R.photo2.tex]]);
  drawTo(null, ow, oh);

  if (o.overlays && !original) {
    const sprites = o.overlays({ ow, oh, w, h, pads, unit }) || [];
    if (sprites.length) drawSprites(sprites, ow, oh);
  }
  return gl.drawingBufferWidth === ow && gl.drawingBufferHeight === oh;
};

function drawSprites(sprites, ow, oh) {
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, ow, oh);
  for (const s of sprites) {
    if (!s.canvas || !s.canvas.width) continue;
    const tex = makeTex(s.canvas.width, s.canvas.height, s.canvas, false);
    gl.useProgram(progSprite.p);
    const L = n => progSprite.locs[n] || (progSprite.locs[n] = gl.getUniformLocation(progSprite.p, n));
    gl.uniform2fv(L('u_out'), [ow, oh]);
    gl.uniform2fv(L('u_center'), [s.cx, s.cy]);
    gl.uniform2fv(L('u_half'), [s.w / 2, s.h / 2]);
    gl.uniform1f(L('u_rot'), s.rot || 0);
    gl.uniform1f(L('u_alpha'), s.alpha == null ? 1 : s.alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(L('u_tex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteTexture(tex);
  }
  gl.disable(gl.BLEND);
}

R.maxSize = function () {
  return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
};

R.init = function (cv) {
  canvas = cv;
  gl = cv.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false, alpha: false });
  if (!gl) return false;
  progGeom = compile(VS, FS_GEOM);
  progGrade = compile(VS, FS_GRADE);
  progBright = compile(VS, FS_BRIGHT);
  progBlur = compile(VS, FS_BLUR);
  progLook = compile(VS, FS_LOOK);
  progFinal = compile(VS, FS_FINAL);
  progSprite = compile(VS_SPRITE, FS_SPRITE);
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  dummyTex = makeTex(1, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return true;
};
R.gl = () => gl;
})();

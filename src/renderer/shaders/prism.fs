/*{
 "DESCRIPTION": "Prism: 576 generated modes from one shader \u2014 12 forms x 6 warps x 8 palettes, chosen by the form/warp/palette inputs (prism.js names them). Every mode answers the kick, bass and level.",
 "CREDIT": "Lyric Overlay (MIT)",
 "ISFVSN": "2",
 "CATEGORIES": [
  "Generator",
  "Audio"
 ],
 "INPUTS": [
  {
   "NAME": "bass",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "mid",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "treble",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "level",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "kick",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "beat",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "drop",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "hue",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 1.0
  },
  {
   "NAME": "form",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 11.0
  },
  {
   "NAME": "warp",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 5.0
  },
  {
   "NAME": "palette",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": 0.0,
   "MAX": 7.0
  }
 ]
}*/
// Branching on form/warp/palette is on uniforms, so every pixel takes the
// same path: one compiled program serves all 576 modes and switching mode is
// a uniform write, not a shader compile.
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
bool is(float v, float n) { return abs(v - n) < 0.5; }

vec2 warpIt(vec2 p, float t) {
  float r = length(p);
  float a = atan(p.y, p.x);
  if (is(warp, 1.0)) return rot(r * (2.0 + bass * 3.0) - t * 0.3) * p;                 // swirl
  if (is(warp, 2.0)) return p * (0.55 + 0.45 * r) / max(r, 0.001) * sqrt(r);          // fisheye
  if (is(warp, 3.0) || is(warp, 4.0)) {                                               // kaleido 6 / 8
    float n = is(warp, 3.0) ? 6.0 : 8.0;
    float seg = 6.2831853 / n;
    a = mod(a + t * 0.1, seg);
    a = abs(a - seg * 0.5);
    return vec2(cos(a), sin(a)) * r;
  }
  if (is(warp, 5.0)) return abs(p);                                                    // mirror
  return p;
}

// Each form returns a brightness 0..1 for point p; `w` is line width.
float formAt(vec2 p, float t, float w) {
  float r = length(p);
  float a = atan(p.y, p.x);
  if (is(form, 0.0)) return smoothstep(w, 0.0, abs(fract(r * 6.0 - t * 0.8) - 0.5) - 0.5 + w);   // rings
  if (is(form, 1.0)) return pow(0.5 + 0.5 * sin(a * 5.0 + log(r + 0.001) * 7.0 - t * 2.0), 6.0 - kick * 4.0); // spiral
  if (is(form, 2.0)) { vec2 g = abs(fract(p * 5.0 + t * 0.2) - 0.5); return smoothstep(w, 0.0, min(g.x, g.y)); } // grid
  if (is(form, 3.0)) {                                                                  // hex
    vec2 q = p * 5.0; q.x *= 1.1547; q.y += mod(floor(q.x), 2.0) * 0.5;
    vec2 f = abs(fract(q) - 0.5);
    return smoothstep(w, 0.0, abs(max(f.x * 1.5 + f.y, f.y * 2.0) - 1.0));
  }
  if (is(form, 4.0)) {                                                                  // cells
    vec2 q = p * 4.0; vec2 i = floor(q); float d = 1.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = o + 0.5 + 0.4 * sin(t * 0.6 + 6.2831853 * vec2(hash(i + o), hash(i + o + 7.0)));
      d = min(d, length(q - i - c));
    }
    return smoothstep(0.08 + w * 2.0, 0.0, d);
  }
  if (is(form, 5.0)) {                                                                  // tunnel
    float z = 0.5 / max(r, 0.02) + t * (1.0 + level * 2.0);
    return pow(abs(sin(z * 3.14159)), 18.0) * smoothstep(0.0, 0.2, r) + pow(abs(cos(a * 8.0)), 40.0) * 0.4;
  }
  if (is(form, 6.0)) return pow(abs(cos(a * 12.0 + t * 0.5)), 30.0 - kick * 22.0) * smoothstep(1.2, 0.0, r) * 1.4; // rays
  if (is(form, 7.0)) { float y = p.y + sin(p.x * 6.0 + t) * (0.15 + bass * 0.2); return smoothstep(w, 0.0, abs(fract(y * 4.0) - 0.5) - 0.5 + w); } // waves
  if (is(form, 8.0)) {                                                                  // plasma
    float v = sin(p.x * 6.0 + t) + sin(p.y * 7.0 - t * 1.3) + sin((p.x + p.y) * 5.0 + t * 0.7) + sin(r * 9.0 - t * 2.0);
    return 0.5 + 0.5 * sin(v * 1.6);
  }
  if (is(form, 9.0)) {                                                                  // flower
    float k = 6.0;
    float rr = 0.35 * (1.0 + 0.45 * cos(a * k + t)) * (1.0 + kick * 0.3);
    return smoothstep(w * 2.0, 0.0, abs(r - rr)) + smoothstep(w * 2.0, 0.0, abs(r - rr * 0.6)) * 0.6;
  }
  if (is(form, 10.0)) {                                                                 // stars
    // A starfield flying outward: three depth layers, denser and brighter
    // than a sprinkle, each star a core plus a glow that swells on the kick.
    float acc = 0.0;
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      float z = fract(t * (0.25 + bass * 0.3) + fl / 3.0);
      vec2 q = p * mix(14.0, 2.5, z) + fl * 7.3;
      vec2 i = floor(q); vec2 f = fract(q) - 0.5;
      float s = step(0.55, hash(i + fl));
      float d = length(f - 0.3 * vec2(hash(i + 3.0) - 0.5, hash(i + 5.0) - 0.5));
      float fade = smoothstep(0.0, 0.3, z) * smoothstep(1.0, 0.7, z);
      acc += s * fade * (smoothstep(0.08, 0.0, d) + 0.35 * smoothstep(0.3 + kick * 0.2, 0.0, d));
    }
    return min(acc, 1.0);
  }
  // 11: weave
  vec2 q = p * 6.0;
  float d = abs(fract(q.x + q.y * 0.5 + t * 0.3) - 0.5) * abs(fract(q.y - q.x * 0.5 - t * 0.2) - 0.5);
  return smoothstep(w * 0.4, 0.0, d);
}

vec3 paletteAt(float v, float r) {
  if (is(palette, 1.0)) return mix(vec3(0.6, 0.02, 0.0), vec3(1.0, 0.85, 0.2), v);                 // fire
  if (is(palette, 2.0)) return mix(vec3(0.0, 0.08, 0.35), vec3(0.6, 0.95, 1.0), v);                // ice
  if (is(palette, 3.0)) return mix(vec3(1.0, 0.1, 0.8), vec3(0.1, 0.9, 1.0), 0.5 + 0.5 * sin(r * 6.0)); // neon
  if (is(palette, 4.0)) return mix(vec3(0.55, 0.1, 0.45), vec3(1.0, 0.6, 0.2), v);                 // sunset
  if (is(palette, 5.0)) return vec3(0.9);                                                          // mono
  if (is(palette, 6.0)) return hsv(fract(r * 0.5 + TIME * 0.05), 0.9, 1.0);                       // rainbow
  if (is(palette, 7.0)) return mix(vec3(0.2, 1.0, 0.3), vec3(1.0, 0.2, 0.7), 0.5 + 0.5 * sin(r * 8.0 - TIME)); // acid
  return hsv(hue + r * 0.15, 0.85, 1.0);                                                           // the song's own
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float t = TIME * (0.6 + level * 1.4);
  p *= 1.0 - kick * 0.12;                       // punch in on the kick
  p = warpIt(p, t);
  float w = 0.04 + bass * 0.06 + kick * 0.05;
  float v = clamp(formAt(p, t, w), 0.0, 1.0);
  float r = length(p);
  vec3 col = paletteAt(v, r) * v * (0.6 + level * 1.2 + kick * 1.4);
  col += paletteAt(0.3, r + 1.0) * 0.06 * (1.0 + bass);   // a floor of colour, never pure black
  col += vec3(drop * 0.5);
  gl_FragColor = vec4(1.0 - exp(-col * 1.5), 1.0);
}

/*{
 "DESCRIPTION": "A city of equalizer towers on a reflective floor: every building is a frequency band, lit windows climb with the level, the sky pulses on the kick.",
 "CREDIT": "Lyric Overlay (MIT)",
 "ISFVSN": "2",
 "CATEGORIES": [
  "Generator",
  "Audio"
 ],
 "INPUTS": [
  {
   "NAME": "fftImage",
   "TYPE": "audioFFT"
  },
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
  }
 ]
}*/

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; } return v; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// Strobe: hard kicks only, first half of the beat only, so it never runs
// faster than the beat. kick and drop arrive pre-scaled by Reduce Motion.
float strobe() { return smoothstep(0.55, 0.9, kick) * step(beat, 0.5); }

void main() {
  vec2 res = RENDERSIZE;
  vec2 uv = gl_FragCoord.xy / res;
  float horizon = 0.32;
  bool refl = uv.y < horizon;
  float y = refl ? (horizon - uv.y) : (uv.y - horizon);
  float n = 48.0;
  float id = floor(uv.x * n);
  float fx = fract(uv.x * n);
  float k = (id + 0.5) / n;
  float v = IMG_NORM_PIXEL(fftImage, vec2(k * (0.3 + 0.5 * k), 0.5)).r;
  float h = 0.04 + v * 0.62 * (0.7 + level * 0.6) + hash(vec2(id, 1.0)) * 0.06;
  float inside = step(y, h) * step(0.08, fx) * step(fx, 0.92);
  // Windows: a grid inside the tower, lit at random, more as it gets loud.
  vec2 w = vec2(fract(fx * 4.0), fract(y * 60.0));
  float lit = step(0.5 - level * 0.4, hash(vec2(id, floor(y * 60.0)) + floor(TIME * 2.0) * 0.01));
  float win = step(0.3, w.x) * step(w.x, 0.7) * step(0.35, w.y) * step(w.y, 0.75) * lit;
  vec3 tower = hsv(hue + k * 0.4, 0.9, 0.18) + hsv(hue + 0.1 + k * 0.4, 0.6, 1.0) * win;
  float rim = inside * smoothstep(h - 0.006, h, y);
  vec3 col = tower * inside + hsv(hue + k * 0.4, 0.9, 1.0) * rim * 2.0;
  // Sky: gradient plus a sun that swells on the kick.
  vec2 sp = vec2((uv.x - 0.5) * res.x / res.y, y - 0.28);
  float sun = smoothstep(0.2 + kick * 0.05, 0.18, length(sp));
  vec3 sky = mix(hsv(hue + 0.75, 0.8, 0.25), hsv(hue + 0.95, 0.9, 0.05), y * 1.6) + hsv(hue + 0.08, 0.8, 1.0) * sun * (1.0 - inside);
  col += sky * (1.0 - inside) * (0.8 + kick * 0.5);
  if (refl) col *= 0.35 + 0.15 * sin(uv.y * 400.0 + TIME * 6.0);
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.4;
  col = mix(col, vec3(1.0), strobe() * 0.3);
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

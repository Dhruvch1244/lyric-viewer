/*{
 "DESCRIPTION": "A broken broadcast: colour bars torn by scanline slips and RGB split that jump on every kick.",
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
  float t = floor(TIME * 12.0);
  // Horizontal slices that slip sideways, more and wider on the kick.
  float row = floor(uv.y * 40.0);
  float slip = (hash(vec2(row, t)) - 0.5) * step(0.75 - kick * 0.5, hash(vec2(t, row * 0.3))) * (0.1 + kick * 0.4);
  float split = 0.004 + kick * 0.03 + treble * 0.01;
  vec3 col;
  for (int c = 0; c < 3; c++) {
    float x = uv.x + slip + (float(c) - 1.0) * split;
    float bars = floor(fract(x + TIME * 0.02) * 8.0);
    vec3 b = hsv(hue + bars / 8.0, 0.8, 0.9);
    float v = c == 0 ? b.r : (c == 1 ? b.g : b.b);
    v *= 0.6 + 0.4 * fbm(vec2(x * 3.0, uv.y * 3.0 + TIME * 0.3));
    col[c] = v;
  }
  col *= 0.75 + 0.25 * sin(uv.y * res.y * 1.5);
  col += step(0.985, hash(vec2(floor(uv.y * 200.0), t))) * (0.5 + level);
  col *= 0.5 + level * 0.6 + bass * 0.3;
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.5;
  col = mix(col, vec3(1.0), strobe() * 0.3);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}

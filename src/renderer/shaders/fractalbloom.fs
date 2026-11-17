/*{
 "DESCRIPTION": "A kaleidoscopic fractal folded eight times; it unfurls with the bass and spins faster on the kick.",
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
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = TIME * 0.2;
  vec2 z = p * (1.6 - bass * 0.4);
  float acc = 0.0, trap = 1e3;
  for (int i = 0; i < 8; i++) {
    z = abs(z) / clamp(dot(z, z), 0.12, 2.0) - vec2(0.9 + 0.1 * sin(t), 0.6 + 0.15 * cos(t * 1.3) + mid * 0.1);
    z *= rot(t * 0.5 + kick * 0.4);
    trap = min(trap, abs(z.y));
    acc += exp(-length(z) * 2.0);
  }
  vec3 col = hsv(hue + acc * 0.08 + trap, 0.85, 1.0) * acc * 0.35 * (0.7 + level);
  col += hsv(hue + 0.4, 0.7, 1.0) * exp(-trap * 30.0) * (0.6 + kick * 2.0);
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.4;
  col = mix(col, vec3(1.0), strobe() * 0.3);
  gl_FragColor = vec4(1.0 - exp(-col * 1.3), 1.0);
}

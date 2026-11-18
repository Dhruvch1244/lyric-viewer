/*{
 "DESCRIPTION": "Seven glowing blobs that merge and split, swelling on the bass and squeezing on the kick.",
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
  float t = TIME * 0.4;
  float f = 0.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.7 + fi * 0.13) + fi * 2.0) * 0.6, cos(t * (0.5 + fi * 0.11) + fi) * 0.4);
    float r = 0.09 + 0.05 * hash(vec2(fi)) + bass * 0.06 - kick * 0.02;
    float k = r * r / dot(p - c, p - c);
    f += k;
    tint += hsv(hue + fi * 0.07, 0.85, 1.0) * k;
  }
  tint /= max(f, 1e-3);
  float body = smoothstep(0.9, 1.1, f);
  float rim = smoothstep(0.7, 1.0, f) - body;
  vec3 col = tint * body * (0.6 + level * 0.6) + tint * rim * (2.0 + kick * 3.0);
  col += hsv(hue + 0.6, 0.7, 0.12) * (1.0 - body);
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.4;
  col = mix(col, vec3(1.0), strobe() * 0.3);
  gl_FragColor = vec4(1.0 - exp(-col * 1.3), 1.0);
}

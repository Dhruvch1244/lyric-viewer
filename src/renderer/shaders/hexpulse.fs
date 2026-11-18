/*{
 "DESCRIPTION": "A honeycomb floor that lights up in a wave from the centre on every beat; the kick fires the brightest ring.",
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

vec4 hexCoord(vec2 p) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  return vec4(g, p - g);
}
void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  p *= rot(TIME * 0.05);
  vec4 h = hexCoord(p * (9.0 - bass * 2.0));
  float d = length(h.zw) / 9.0;
  float edge = max(abs(h.x) * 0.866 + abs(h.y) * 0.5, abs(h.y));
  float line = smoothstep(0.5, 0.46, edge);
  // The wave: a ring at radius = beat phase, plus a slower tide.
  float wave = exp(-abs(d - beat * 1.1) * 18.0) * (0.5 + kick * 2.0);
  float tide = 0.5 + 0.5 * sin(d * 10.0 - TIME * 2.0 + hash(h.zw) * 2.0);
  float lit = clamp(wave + tide * 0.25 * (0.3 + level) + step(0.97, hash(h.zw + floor(TIME * 4.0))) * treble * 2.0, 0.0, 2.0);
  vec3 col = hsv(hue + d * 0.4 + hash(h.zw) * 0.1, 0.85, 1.0) * lit * line;
  col += hsv(hue + 0.5, 0.7, 1.0) * (1.0 - line) * (0.15 + wave * 0.6);
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.4;
  col = mix(col, vec3(1.0), strobe() * 0.3);
  gl_FragColor = vec4(1.0 - exp(-col * 1.5), 1.0);
}

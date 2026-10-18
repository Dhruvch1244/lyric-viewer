/*{
 "DESCRIPTION": "A rotating mirrored kaleidoscope; segments burst outward on kicks, rotation follows the beat.",
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
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float zoom = 1.5 - kick * 0.45 - bass * 0.25;
  uv *= zoom;
  float segs = 8.0;
  float r = length(uv);
  float a = atan(uv.y, uv.x) + TIME * 0.15 + beat * 0.3;
  float seg = 6.2831853 / segs;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 p = vec2(cos(a), sin(a)) * r;
  float t = TIME * 0.2;
  vec3 col = vec3(0.0);
  // Thin glowing filaments on black: each fold contributes where one axis
  // passes near zero, which is what reads as a crisp mirrored line pattern.
  for (int i = 0; i < 6; i++) {
    p = abs(p) / max(dot(p, p), 0.05) - vec2(0.85 + 0.1 * sin(t), 0.55 + 0.12 * mid);
    p *= rot(t * 0.25);
    float fi = float(i);
    float line = exp(-28.0 * min(abs(p.x), abs(p.y)));
    col += hsv(hue + fi * 0.03, 0.9, 1.0) * line * (0.25 + 0.12 * fi);
  }
  col *= 0.45 + level * 0.6 + kick * 0.9;
  col = col / (1.0 + col);
  col *= smoothstep(1.6, 0.2, r) * 1.3;
  col += vec3(drop * 0.5) * smoothstep(1.0, 0.0, r);
  gl_FragColor = vec4(col, 1.0);
}

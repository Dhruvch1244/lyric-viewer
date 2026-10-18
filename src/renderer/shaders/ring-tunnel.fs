/*{
 "DESCRIPTION": "Diving down a tunnel of neon rings; rings light up on the beat and the dive speeds up with the energy.",
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
  uv += vec2(sin(TIME * 0.4), cos(TIME * 0.3)) * 0.08;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float depth = 0.4 / max(r, 0.001);
  float t = TIME * (1.2 + level * 2.5);
  float z = depth + t;
  // Lines sit at the cell edges, where |fract - 0.5| approaches 0.5.
  float ring = smoothstep(0.40, 0.49, abs(fract(z * 0.5) - 0.5));
  float ribs = smoothstep(0.44, 0.495, abs(fract(a / 6.2831853 * 16.0 + z * 0.05) - 0.5));
  vec3 c = hsv(hue + floor(z * 0.5) * 0.07, 0.85, 1.0);
  float pulse = 0.5 + kick * 1.5 + bass * 0.6;
  vec3 col = c * (ring * pulse + ribs * 0.35);
  col *= smoothstep(0.0, 0.25, r) * (1.0 / (1.0 + depth * 0.05));
  col += hsv(hue + 0.5, 0.6, 1.0) * 0.05 / (r + 0.05);
  col += vec3(drop * 0.6) * smoothstep(0.8, 0.0, r);
  gl_FragColor = vec4(col, 1.0);
}

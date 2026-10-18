/*{
 "DESCRIPTION": "Warp-speed star streaks. Kicks stretch the streaks and punch the speed; a drop whites out.",
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
float layer(vec2 uv, float t, float n, float seed, float stretch) {
  float r = length(uv);
  float a = atan(uv.y, uv.x) / 6.2831853 + 0.5;
  vec2 p = vec2(a * n, 0.35 / max(r, 0.001) + t);
  vec2 id = floor(p);
  vec2 f = fract(p);
  float h = hash(id + seed);
  if (h < 0.55) return 0.0;
  float x = abs(f.x - 0.5);
  float w = 0.045 + 0.02 * h;
  float streak = smoothstep(w, 0.0, x) * smoothstep(0.08 + stretch, 0.0, f.y);
  return streak * (h - 0.55) * 2.6 * smoothstep(0.02, 0.35, r);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  uv *= rot(TIME * 0.05 + mid * 0.2);
  float t = TIME * (0.9 + level * 1.6) + kick * 0.35;
  float stretch = 0.25 + kick * 1.4 + level * 0.4;
  float s = 0.0;
  s += layer(uv, t * 1.0, 60.0, 1.0, stretch);
  s += layer(uv, t * 1.6, 110.0, 7.0, stretch * 1.3) * 0.8;
  s += layer(uv, t * 2.3, 170.0, 13.0, stretch * 1.6) * 0.6;
  float r = length(uv);
  vec3 tint = hsv(hue + r * 0.15, 0.7, 1.0);
  vec3 col = s * mix(tint, vec3(1.0), 0.35);
  col += hsv(hue, 0.85, 1.0) * (0.06 + bass * 0.5) / (r * 7.0 + 0.4);   // the hole you fly into
  col += vec3(drop * 0.85) * smoothstep(1.2, 0.0, r);
  gl_FragColor = vec4(col, 1.0);
}

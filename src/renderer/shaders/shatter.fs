/*{
 "DESCRIPTION": "Stained-glass cells that shatter and flash on the beat; edges burn with the treble.",
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
vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }
void main() {
  vec2 uv = gl_FragCoord.xy / RENDERSIZE.y;
  uv *= 6.0 - bass * 1.5;
  vec2 g = floor(uv), f = fract(uv);
  float d1 = 9.0, d2 = 9.0;
  vec2 cell = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = hash2(g + o);
      vec2 p = o + 0.5 + 0.45 * sin(TIME * 0.6 + 6.2831853 * h);
      float d = length(p - f);
      if (d < d1) { d2 = d1; d1 = d; cell = g + o; }
      else if (d < d2) { d2 = d; }
    }
  }
  float h = hash(cell);
  float flash = step(1.0 - kick * 0.9, h);
  vec3 col = hsv(hue + h * 0.4, 0.8, 0.25 + 0.75 * flash + level * 0.2);
  float edge = smoothstep(0.06, 0.0, d2 - d1);
  col = mix(col, hsv(hue + 0.5, 0.5, 1.0) * (0.6 + treble * 2.0), edge);
  col += vec3(drop * 0.5);
  gl_FragColor = vec4(col, 1.0);
}

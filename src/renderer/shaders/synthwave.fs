/*{
 "DESCRIPTION": "Retro neon grid racing to a striped sun; the grid flashes on kicks and the sun swells with the bass.",
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
  float horizon = -0.05;
  vec3 sky = mix(hsv(hue + 0.75, 0.8, 0.25), hsv(hue + 0.95, 0.7, 0.6), smoothstep(0.5, horizon, uv.y));
  vec3 col = sky;
  // Sun.
  vec2 sp = uv - vec2(0.0, 0.18);
  float sr = 0.28 + bass * 0.06 + kick * 0.03;
  float sun = smoothstep(sr, sr - 0.005, length(sp));
  float bands = step(0.0, sin((sp.y + TIME * 0.03) * 70.0) + (sp.y + 0.05) * 18.0);
  col = mix(col, mix(hsv(hue + 0.12, 0.9, 1.0), hsv(hue + 0.92, 0.9, 1.0), smoothstep(0.25, -0.2, sp.y)), sun * bands);
  col += hsv(hue + 0.05, 0.8, 1.0) * 0.25 * exp(-length(sp) * 3.0) * (0.5 + bass);
  // Grid floor.
  if (uv.y < horizon) {
    float d = horizon - uv.y;
    float zz = 0.25 / d;
    float xx = uv.x * zz;
    float speed = TIME * (1.5 + level * 3.0);
    // Lines at the cell edges; widened with distance so far lines do not alias away.
    float lw = 0.47 - min(0.12, d * 0.4);
    float gx = smoothstep(lw, 0.5, abs(fract(xx * 2.0) - 0.5));
    float gz = smoothstep(lw, 0.5, abs(fract(zz + speed) - 0.5));
    float grid = max(gx, gz) * smoothstep(0.0, 0.25, d * 3.0);
    col = mix(hsv(hue + 0.8, 0.9, 0.08), col, 0.15);
    col += hsv(hue + 0.85, 0.8, 1.0) * grid * (0.6 + kick * 1.6);
  }
  col += vec3(drop * 0.45);
  gl_FragColor = vec4(col, 1.0);
}

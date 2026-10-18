/*{
 "DESCRIPTION": "The music as 3D bars: the live spectrum in perspective with a mirrored floor, caps that flash on kicks.",
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
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float fftAt(float x) {
  // Log-ish spacing so the bass gets room instead of three bars.
  float k = pow(x, 1.8) * 0.85 + 0.005;
  return IMG_NORM_PIXEL(fftImage, vec2(k, 0.5)).r;
}
void main() {
  vec2 uv = gl_FragCoord.xy / RENDERSIZE;
  float horizon = 0.38;
  vec3 col = vec3(0.0);
  float bars = 48.0;
  // Perspective: the bar row recedes slightly towards the top of the screen.
  bool reflection = uv.y < horizon;
  float y = reflection ? (horizon - uv.y) * 0.6 : uv.y - horizon;
  float persp = 1.0 + y * 0.35;
  float x = (uv.x - 0.5) * persp + 0.5;
  if (x > 0.0 && x < 1.0) {
    float id = floor(x * bars);
    float fx = fract(x * bars);
    float h = fftAt((id + 0.5) / bars);
    h = pow(h, 1.4) * (0.55 + kick * 0.25);
    float body = step(0.08, fx) * step(fx, 0.92);
    float inBar = body * step(y, h);
    vec3 barCol = hsv(hue + id / bars * 0.6, 0.85, 1.0);
    float shade = 0.45 + 0.55 * (y / max(h, 0.001));
    col += barCol * inBar * shade;
    float cap = body * smoothstep(0.012, 0.0, abs(y - h - 0.012));
    col += mix(barCol, vec3(1.0), 0.6) * cap * (1.0 + kick * 2.0);
    if (reflection) col *= 0.35 * smoothstep(0.0, horizon, uv.y);
  }
  // Floor grid and a glow along the horizon.
  col += hsv(hue + 0.55, 0.7, 1.0) * (0.15 + bass * 0.6) * exp(-abs(uv.y - horizon) * 40.0);
  col += vec3(drop * 0.4);
  gl_FragColor = vec4(col, 1.0);
}

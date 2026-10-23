/*{
 "DESCRIPTION": "Concentric neon rings, one per frequency band, bursting outward with the spectrum.",
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
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  vec3 col = vec3(0.0);
  // Only the rings near this pixel can light it: a ring's radius is
  // 0.05 + i*0.036, pushed out at most ~0.156 by its band, the kick and the
  // wobble, and its glow fades out by 0.08 — a window of under 9 ring spacings.
  // So 10 candidate rings instead of all 20 — the loop
  // was 20 texture fetches per pixel, measured as the costliest shader in the
  // app (38.5ms -> 18.8ms per frame at 480x270 in the shader benchmark).
  float first = floor((r - 0.05 - 0.156 - 0.08) / 0.036);
  for (int k = 0; k < 10; k++) {
    float fi = first + float(k);
    if (fi < 0.0 || fi > 19.0) continue;
    float band = IMG_NORM_PIXEL(fftImage, vec2(pow((fi + 0.5) / 20.0, 1.7) * 0.8 + 0.01, 0.5)).r;
    float radius = 0.05 + fi * 0.036 + band * 0.1 + kick * 0.05;
    float wobble = 0.006 * sin(a * (3.0 + fi) + TIME * (1.0 + fi * 0.2));
    float dist = abs(r - radius - wobble);
    float ring = smoothstep(0.014 + band * 0.016, 0.0, dist);
    float glow = exp(-dist * 30.0) * band * 0.35 * smoothstep(0.08, 0.05, dist);
    col += hsv(hue + fi / 20.0 * 0.7, 0.85, 1.0) * (ring * (0.7 + band * 2.4 + kick) + glow);
  }
  col += hsv(hue, 0.6, 1.0) * (0.1 + bass) * 0.04 / (r + 0.03);
  col += vec3(drop * 0.5) * smoothstep(0.9, 0.0, r);
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

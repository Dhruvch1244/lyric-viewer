/*{
 "DESCRIPTION": "Spectrum reactor: the live spectrum as a full circle of bars around a pulsing core, with older copies of it rushing outward like a tunnel, flaring white on every kick.",
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
// Spectrum at 0..1 across the bars, log-spaced so the bass gets most of the
// circle instead of three bars, and lifted so a quiet master still fills it.
float spec(float x) {
  float k = pow(clamp(x, 0.0, 1.0), 1.7) * 0.8 + 0.004;
  float v = IMG_NORM_PIXEL(fftImage, vec2(k, 0.5)).r;
  return clamp(pow(v, 0.85) * (1.0 + level * 0.6), 0.0, 1.0);
}
// One ring of bars at base radius r0 and length scale len: brightness of p.
// The circle is mirrored left/right, so the bass meets at the bottom and the
// highs at the top and the shape is symmetric like a speaker cone.
vec3 ring(vec2 p, float r0, float len, float spin, float bars, float glow) {
  float r = length(p);
  float a = atan(p.x, -p.y) + spin;            // 0 at the bottom
  float m = abs(mod(a + 3.14159, 6.28318) - 3.14159) / 3.14159; // 0 bottom .. 1 top, mirrored
  float id = floor(m * bars);
  float fx = fract(m * bars);
  float h = spec((id + 0.5) / bars);
  float top = r0 + len * (0.02 + h);
  float gap = smoothstep(0.0, 0.12, fx) * smoothstep(1.0, 0.88, fx);
  float inBar = gap * step(r0, r) * smoothstep(top + 0.004, top - 0.004, r);
  float tip = gap * exp(-abs(r - top) * 140.0);
  vec3 c = hsv(hue + m * 0.55 + r0 * 0.3, 0.9, 1.0);
  float shade = 0.35 + 0.65 * clamp((r - r0) / max(top - r0, 0.001), 0.0, 1.0);
  return c * inBar * shade * glow + mix(c, vec3(1.0), 0.7) * tip * (1.2 + kick * 2.5) * glow;
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float r = length(p);
  float t = TIME;
  vec3 col = vec3(0.0);
  float spin = t * 0.15 + beat * 0.2;
  float core = 0.16 + bass * 0.05 + kick * 0.04;
  // The live ring.
  col += ring(p, core, 0.34 + kick * 0.12, spin, 64.0, 1.0);
  // Echoes: the same spectrum scaled outward and fading, each one a step
  // further "back in time", so the screen reads as a tunnel of past beats.
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    float z = fract(t * (0.35 + level * 0.6) + fi / 5.0);   // 0 new .. 1 gone
    float s = 1.0 + z * 2.6;
    vec2 q = p / s;
    col += ring(q, core, 0.34, spin - fi * 0.35, 64.0, (1.0 - z) * 0.45);
  }
  // Pulsing core: a disc that punches on the kick, rimmed in white.
  vec3 cc = hsv(hue + 0.5, 0.8, 1.0);
  col += cc * smoothstep(core, core - 0.02, r) * (0.25 + kick * 0.9) * (0.85 + 0.15 * sin(r * 60.0 - t * 6.0));
  col += vec3(1.0) * exp(-abs(r - core) * 220.0) * (0.6 + kick * 2.0);
  // A shockwave from the core on every beat.
  float wave = beat * 1.1 + core;
  col += cc * exp(-abs(r - wave) * 45.0) * (1.0 - beat) * (0.4 + kick * 1.6);
  col += hsv(hue, 0.6, 1.0) * drop * 0.6;
  gl_FragColor = vec4(1.0 - exp(-col * 1.5), 1.0);
}

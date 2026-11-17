/*{
 "DESCRIPTION": "Electric arcs that fork across a storm sky, a new strike on every kick, crackling with the treble.",
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

float bolt(vec2 p, float seed, float w) {
  // A jagged line: x offset by layered noise along y.
  float x = 0.0, a = 0.35;
  for (int i = 0; i < 4; i++) { x += (noise(vec2(p.y * (3.0 + float(i) * 5.0), seed + float(i))) - 0.5) * a; a *= 0.55; }
  return w / (abs(p.x - x) + w);
}
void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float strike = floor(TIME * 1.5 + kick * 3.0);
  float flash = kick * kick;
  vec3 col = hsv(hue + 0.65, 0.6, 0.06 + flash * 0.25) * (0.6 + fbm(p * 2.0 + TIME * 0.1));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 q = p - vec2((hash(vec2(strike, fi)) - 0.5) * 1.4, 0.0);
    q *= rot((hash(vec2(fi, strike)) - 0.5) * 0.6);
    float b = bolt(q, strike * 7.0 + fi * 13.0, 0.0025 + treble * 0.003);
    float life = (0.3 + flash * 1.5 + level * 0.4) * step(fi, 0.5 + bass * 2.5 + kick * 2.0);
    col += hsv(hue + 0.55 + fi * 0.05, 0.4, 1.0) * b * life;
  }
  col += vec3(0.9, 0.95, 1.0) * strobe() * 0.4;
  col += hsv(hue + 0.5, 0.7, 1.0) * drop * 0.5;
  gl_FragColor = vec4(1.0 - exp(-col * 1.3), 1.0);
}

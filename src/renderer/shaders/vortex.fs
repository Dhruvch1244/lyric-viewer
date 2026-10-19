/*{
 "DESCRIPTION": "Vortex: a spiral whirlpool that tightens with the bass and spins faster on every kick.",
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
// A fan of n thin beams covering the full circle, rotated by `rot`: 1 on a
// beam's axis, falling off with angular distance scaled by radius so a beam
// keeps a constant width on screen instead of widening like a wedge.
float fan(float ang, float r, float n, float rot, float width) {
  float seg = 6.2831853 / n;
  float d = abs(mod(ang - rot + seg * 0.5, seg) - seg * 0.5) * r;
  return exp(-d * d / (width * width));
}
// Strobe: hard kicks only, first half of the beat only, so it can never run
// faster than the beat. kick and drop arrive pre-scaled by Reduce Motion.
float strobe() { return smoothstep(0.55, 0.9, kick) * step(beat, 0.5); }
void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float r = max(length(p), 0.001);
  float a = atan(p.y, p.x);
  float t = TIME;
  float spin = t * (0.8 + level * 1.5) + kick * 1.5;
  float arms = 6.0;
  float s = a * arms + log(r) * (6.0 + bass * 10.0) - spin * 4.0;
  float band = 0.5 + 0.5 * sin(s);
  float edge = pow(band, 8.0 - kick * 5.0);
  vec3 c1 = hsv(hue + log(r) * 0.15 + t * 0.05, 0.95, 1.0);
  vec3 c2 = hsv(hue + 0.5, 0.9, 0.9);
  vec3 col = mix(c2 * 0.04, c1, edge) * (0.6 + level * 1.5 + kick);
  col += c1 * (0.02 / r) * (0.5 + kick * 2.0);
  col *= smoothstep(0.0, 0.08, r) + 0.3;
  col = mix(col, vec3(1.0), strobe() * 0.5);
  col += c2 * drop * 0.7;
  gl_FragColor = vec4(1.0 - exp(-col * 1.3), 1.0);
}

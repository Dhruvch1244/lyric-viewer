/*{
 "DESCRIPTION": "Starburst: 360-degree rays exploding from the centre, a shockwave ring on every beat, and sparks flung outward on kicks.",
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
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = TIME;
  vec3 c1 = hsv(hue + r * 0.3, 0.95, 1.0);
  vec3 c2 = hsv(hue + 0.5, 0.85, 1.0);
  // Rays of uneven length so it reads as an explosion, not a wheel.
  float n = 48.0;
  float id = floor((a + 3.14159) / 6.2831853 * n);
  float len = 0.2 + hash(vec2(id, floor(t * 2.0 + kick))) * (0.4 + bass * 0.9 + kick * 0.8);
  float ray = fan(a, r, n, t * 0.1, 0.004 + kick * 0.01) * smoothstep(len, len * 0.3, r);
  vec3 col = c1 * ray * (1.0 + kick * 2.0);
  // A shockwave every beat, travelling outward through the phase.
  float wave = exp(-abs(r - beat * 1.2) * 40.0) * (1.0 - beat) * (0.6 + kick * 2.0 + bass);
  col += c2 * wave;
  // Sparks.
  vec2 cell = floor(vec2(a * 8.0, r * 20.0 - t * (3.0 + kick * 8.0)));
  float spark = step(0.97 - treble * 0.05, hash(cell)) * smoothstep(0.05, 0.2, r);
  col += c1 * spark * (0.5 + treble * 2.0);
  col += vec3(1.0) * (0.03 / (r + 0.03)) * (0.5 + kick * 2.5);
  col = mix(col, vec3(1.0), strobe() * 0.6);
  col += c2 * drop * 0.7;
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

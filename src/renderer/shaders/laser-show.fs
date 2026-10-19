/*{
 "DESCRIPTION": "Laser show: full 360-degree beam fans from the centre and every corner, counter-rotating on the beat, flaring and multiplying on kicks, with a beat-capped strobe. Softened by Reduce Motion.",
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
  // Colour cuts on the beat grid; two complementary hues so crossing fans read.
  float cut = floor(t * 0.5 + kick);
  vec3 c1 = hsv(hue + hash(vec2(cut, 1.0)) * 0.25, 0.95, 1.0);
  vec3 c2 = hsv(hue + 0.5 + hash(vec2(cut, 2.0)) * 0.2, 0.95, 1.0);
  vec3 c3 = hsv(hue + 0.25, 0.9, 1.0);

  float energy = 0.55 + bass * 1.2 + kick * 1.5;
  float wid = 0.006 + 0.012 * kick + 0.006 * bass;
  // More beams the louder it gets: 12 at rest, up to 36.
  float n1 = 12.0 + floor(level * 3.0) * 8.0;
  float rot = t * (0.35 + mid * 0.8) + beat * 0.4 + kick * 0.6;
  vec3 col = vec3(0.0);
  col += c1 * fan(a, r, n1, rot, wid) * energy;
  col += c2 * fan(a, r, n1 * 0.5, -rot * 1.3 + 0.2, wid * 1.3) * energy;
  // Corner emitters sweeping inward across the whole frame.
  float wAsp = res.x / res.y * 0.5;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 o = vec2(mod(fi, 2.0) < 1.0 ? -wAsp : wAsp, fi < 2.0 ? -0.5 : 0.5);
    vec2 d = p - o;
    float ca = atan(d.y, d.x);
    float sweep = sin(t * (0.9 + fi * 0.21) + beat * 6.2831853 + fi) * 1.2;
    col += mix(c1, c3, fi / 3.0) * fan(ca, length(d), 10.0, sweep, wid * 0.9) * (0.35 + treble * 1.4 + kick);
  }
  // Glowing emitter and a halo that punches out on the kick.
  col += c3 * (0.02 / (r + 0.02)) * (0.6 + kick * 2.0);
  col += c1 * exp(-abs(r - (0.15 + kick * 0.6)) * 30.0) * kick * 1.5;
  // Smoke haze, so beams have something to light.
  float haze = noise(p * 4.0 + vec2(t * 0.3, -t * 0.2)) * 0.6 + 0.5;
  col *= haze;
  col += mix(c1, c2, 0.5 + 0.5 * sin(a * 2.0 + t)) * 0.05 * (1.0 + level * 2.0);
  col = mix(col, vec3(1.0), strobe() * 0.75);
  col += (c1 + c2) * drop * 0.6;
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

/*{
 "DESCRIPTION": "Laser tunnel: a 360-degree tube of laser lines rushing toward you, rings firing on the kick and the whole tube twisting with the bass.",
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
  float speed = 1.5 + level * 3.0 + kick * 4.0;
  float z = 0.35 / r + t * speed;
  float twist = a + z * (0.15 + bass * 0.35) + t * 0.3;
  vec3 c1 = hsv(hue + z * 0.02, 0.95, 1.0);
  vec3 c2 = hsv(hue + 0.5, 0.9, 1.0);
  // Laser lines running along the tube wall, all the way round.
  float n = 16.0 + floor(mid * 2.0) * 8.0;
  float lines = pow(abs(cos(twist * n * 0.5)), 60.0 - kick * 40.0);
  // Rings flying past, brighter on the kick.
  float ring = pow(abs(cos(z * 3.14159)), 80.0) * (0.4 + kick * 2.5 + bass);
  float fade = smoothstep(0.0, 0.25, r);
  vec3 col = (c1 * lines * (0.8 + treble * 1.5) + c2 * ring) * fade;
  col += c1 * (0.015 / r) * (0.4 + level);
  col = mix(col, vec3(1.0), strobe() * 0.6);
  col += c2 * drop * 0.7;
  gl_FragColor = vec4(1.0 - exp(-col * 1.5), 1.0);
}

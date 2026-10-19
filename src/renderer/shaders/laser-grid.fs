/*{
 "DESCRIPTION": "Laser grid: neon floor and ceiling grids racing to the horizon, laser sheets scanning across the room on the beat.",
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
  float t = TIME;
  vec3 c1 = hsv(hue, 0.95, 1.0);
  vec3 c2 = hsv(hue + 0.55, 0.9, 1.0);
  float ay = abs(p.y) + 0.0001;
  // Perspective grid on floor and ceiling.
  float depth = 0.25 / ay;
  vec2 g = vec2(p.x * depth * 2.0, depth + t * (2.0 + level * 4.0 + kick * 3.0));
  vec2 gd = abs(fract(g) - 0.5);
  float gw = 0.03 * depth;
  float grid = exp(-gd.x * gd.x / (gw * gw)) + exp(-gd.y * gd.y / (gw * gw));
  vec3 col = c1 * grid * smoothstep(0.0, 0.35, ay) * (0.6 + bass * 1.5 + kick);
  // Horizon glow.
  col += c2 * exp(-ay * 18.0) * (0.8 + level * 2.0 + kick * 2.0);
  // Laser sheets: vertical planes sweeping left-right, plus a horizontal scan on the beat.
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float x = sin(t * (0.7 + fi * 0.17) + fi * 1.7 + beat * 3.14159) * res.x / res.y * 0.5;
    col += mix(c2, c1, fi / 4.0) * exp(-abs(p.x - x) * (90.0 - kick * 50.0)) * (0.5 + treble * 1.5 + kick);
  }
  float scan = (beat - 0.5);
  col += c2 * exp(-abs(p.y - scan) * 120.0) * (0.6 + kick * 2.0);
  col = mix(col, vec3(1.0), strobe() * 0.6);
  col += c1 * drop * 0.6;
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

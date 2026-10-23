/*{
 "DESCRIPTION": "Club lights: laser fans sweeping from the stage, a 360-degree mirror-ball fan from the centre, colour cuts, and a strobe on the hardest kicks. Softened by Reduce Motion.",
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
// A beam's brightness from an emitter, given this pixel's angle from that
// emitter (`a`) and its height above it (`fade`, precomputed). The angle is
// passed in rather than computed here: all ten beams of an emitter share it,
// and computing it per beam cost 20 atan() per pixel — measured as the bulk
// of this shader's frame time (measured 12.6ms -> 5.0ms per frame at
// 480x270 in the shader benchmark).
float beam(float a, float fade, float ang, float width) {
  return smoothstep(width, 0.0, abs(a - ang)) * fade;
}
void main() {
  vec2 uv = gl_FragCoord.xy / RENDERSIZE.y;
  float w = RENDERSIZE.x / RENDERSIZE.y;
  float cut = floor(TIME * 1.0 + kick * 0.5);
  vec3 c1 = hsv(hue + hash(vec2(cut, 1.0)) * 0.6, 1.0, 1.0);
  vec3 c2 = hsv(hue + 0.5 + hash(vec2(cut, 2.0)) * 0.3, 1.0, 1.0);
  vec3 col = vec3(0.0);
  float swing = sin(TIME * 1.7 + beat * 6.2831853) * 0.6;
  vec2 d1 = uv - vec2(w * 0.2, -0.05);
  vec2 d2 = uv - vec2(w * 0.8, -0.05);
  float a1 = atan(d1.x, d1.y);
  float a2 = atan(d2.x, d2.y);
  float f1 = smoothstep(0.0, 0.15, d1.y);
  float f2 = smoothstep(0.0, 0.15, d2.y);
  float wid = 0.012 + 0.025 * kick;
  float gain = 0.6 + bass * 1.4 + kick;
  for (int i = 0; i < 10; i++) {
    float spread = (float(i) - 4.5) * 0.13;
    col += c1 * beam(a1, f1, spread + swing, wid) * gain;
    col += c2 * beam(a2, f2, -spread - swing, wid) * gain;
  }
  // Mirror-ball fan from the centre covering the full 360 degrees, spinning
  // with the beat: the stage beams alone left the top of the screen dark.
  vec2 cp = uv - vec2(w * 0.5, 0.5);
  float ca = atan(cp.y, cp.x);
  float seg = 6.2831853 / 24.0;
  float cd = abs(mod(ca - TIME * 0.6 - beat * 0.5 + seg * 0.5, seg) - seg * 0.5) * length(cp);
  col += mix(c2, c1, 0.5 + 0.5 * sin(ca * 3.0)) * exp(-cd * cd / 0.0001) * (0.8 + mid * 1.5 + kick * 2.0);
  // Haze where the beams cross the smoke.
  float haze = noise(uv * 3.0 + vec2(TIME * 0.2, 0.0)) * 0.5 + 0.5;
  col *= 0.55 + haze * 0.7;
  col += mix(c1, c2, uv.x / w) * 0.08 * (1.0 + level);
  // Strobe: only on hard kicks, and only on the first half of the beat so it
  // cannot exceed the beat rate.
  float strobe = smoothstep(0.55, 0.9, kick) * step(beat, 0.5);
  col = mix(col, vec3(1.0), strobe * 0.75);
  col += vec3(drop * 0.7);
  // Soft tone curve instead of a hard clip, so stacked beams stay coloured
  // rather than flattening to white.
  gl_FragColor = vec4(1.0 - exp(-col * 1.4), 1.0);
}

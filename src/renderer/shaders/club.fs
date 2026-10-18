/*{
 "DESCRIPTION": "Club lights: laser fans sweeping on the beat, colour cuts, and a strobe on the hardest kicks. Softened by Reduce Motion.",
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
float beam(vec2 p, vec2 origin, float ang, float width) {
  vec2 d = p - origin;
  float a = atan(d.x, d.y);
  return smoothstep(width, 0.0, abs(a - ang)) * smoothstep(0.0, 0.15, d.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / RENDERSIZE.y;
  float w = RENDERSIZE.x / RENDERSIZE.y;
  float cut = floor(TIME * 1.0 + kick * 0.5);
  vec3 c1 = hsv(hue + hash(vec2(cut, 1.0)) * 0.6, 1.0, 1.0);
  vec3 c2 = hsv(hue + 0.5 + hash(vec2(cut, 2.0)) * 0.3, 1.0, 1.0);
  vec3 col = vec3(0.0);
  float swing = sin(TIME * 1.7 + beat * 6.2831853) * 0.6;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float spread = (fi - 2.5) * 0.18;
    float wid = 0.012 + 0.02 * kick;
    col += c1 * beam(uv, vec2(w * 0.2, -0.05), spread + swing, wid) * (0.35 + bass);
    col += c2 * beam(uv, vec2(w * 0.8, -0.05), -spread - swing, wid) * (0.35 + bass);
  }
  // Haze where the beams cross the smoke.
  float haze = noise(uv * 3.0 + vec2(TIME * 0.2, 0.0)) * 0.5 + 0.5;
  col *= 0.55 + haze * 0.7;
  col += mix(c1, c2, uv.x / w) * 0.08 * (1.0 + level);
  // Strobe: only on hard kicks, and only on the first half of the beat so it
  // cannot exceed the beat rate.
  float strobe = smoothstep(0.55, 0.9, kick) * step(beat, 0.5);
  col = mix(col, vec3(1.0), strobe * 0.7);
  col += vec3(drop * 0.6);
  gl_FragColor = vec4(col, 1.0);
}

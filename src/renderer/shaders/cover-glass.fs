/*{
 "DESCRIPTION": "Cover Glass: the song's cover as Apple Music shows it. A big, soft, slowly flowing wash of the cover's own colours behind a sharp, rounded cover card that breathes with the music, slowly zooms in and out, and catches a sheen of light on a drop.",
 "CREDIT": "Lyric Overlay (MIT)",
 "ISFVSN": "2",
 "CATEGORIES": [
  "Generator",
  "Audio"
 ],
 "INPUTS": [
  {
   "NAME": "cover",
   "TYPE": "image"
  },
  {
   "NAME": "soft",
   "TYPE": "image"
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
vec3 softAt(vec2 uv) { vec2 q = clamp(uv, 0.001, 0.999); return IMG_NORM_PIXEL(soft, q).rgb; }
vec3 coverAt(vec2 uv) { vec2 q = clamp(uv, 0.001, 0.999); return IMG_NORM_PIXEL(cover, q).rgb; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Signed distance to a rounded square of half-size b, corner radius r.
float roundBox(vec2 p, float b, float r) {
  vec2 q = abs(p) - vec2(b - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = TIME;

  // The wash: the pre-blurred cover (renderer.js makes it), sampled through
  // two slow, crossing flow fields and blended — the drifting colour blobs
  // of Apple Music's lyrics screen. Moves a little faster with the music.
  float ft = t * (0.6 + level * 0.5);
  vec2 q = p * 0.55 + 0.5;
  vec2 w1 = q + 0.09 * vec2(sin(q.y * 3.1 + ft * 0.21), cos(q.x * 2.7 - ft * 0.17));
  vec2 r = (q - 0.5) * mat2(cos(ft * 0.05), -sin(ft * 0.05), sin(ft * 0.05), cos(ft * 0.05)) + 0.5;
  vec2 w2 = r + 0.11 * vec2(cos(r.y * 2.3 - ft * 0.13), sin(r.x * 3.4 + ft * 0.19));
  vec3 wash = mix(softAt(w1), softAt(1.0 - w2), 0.45);
  float l = dot(wash, vec3(0.333));
  wash = clamp(mix(vec3(l), wash, 1.45), 0.0, 1.0);      // richer than the source
  wash *= 0.62 + bass * 0.18;                            // dark enough for lyrics
  wash += (hash(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.025; // fine grain

  // The card: breathing on the beat, a slow zoom in and out over ~16s.
  float breathe = 1.0 + 0.035 * sin(t * 0.39) + kick * 0.03 + drop * 0.05;
  float half_ = 0.34 * breathe;
  vec2 cp = p - vec2(0.0, 0.01 * sin(t * 0.27));
  float d = roundBox(cp, half_, half_ * 0.07);

  // Soft shadow under the card, offset down like a lit object.
  float sh = roundBox(cp - vec2(0.0, -0.025), half_, half_ * 0.07);
  vec3 col = wash * (1.0 - 0.55 * exp(-max(sh, 0.0) * 14.0));

  if (d < 0.0) {
    // Inside: a slow Ken Burns — zoom 1.0..1.1 and a gentle pan.
    float kb = 1.0 + 0.05 * (1.0 + sin(t * 0.11));
    vec2 pan = 0.03 * vec2(sin(t * 0.07), cos(t * 0.09));
    vec2 uv = (cp / (2.0 * half_)) / kb + 0.5 + pan * (kb - 1.0) * 10.0;
    vec3 c = coverAt(uv);
    // A sheen sweeping across on a drop, and a faint one every bar.
    float sweep = fract(t * 0.08) * 3.0 - 1.0;
    float band = exp(-pow((cp.x + cp.y) / (2.0 * half_) - sweep, 2.0) * 60.0);
    c += vec3(band * (0.05 + drop * 0.5));
    col = c;
  }
  // Anti-aliased edge with a hairline in the cover's own colour.
  float edge = smoothstep(1.5 / res.y, 0.0, abs(d));
  col = mix(col, mix(col, vec3(1.0), 0.25), edge);
  gl_FragColor = vec4(col, 1.0);
}

/*{
 "DESCRIPTION": "Cover Earth: an endless zoom into the song's cover, Google Earth style. The cover holds a smaller copy of itself at its centre, and that one another, so the camera dives forever; the dive speeds up on the kick and pulls back out on a drop.",
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
   "NAME": "zoom",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": -1000.0,
   "MAX": 1000.0
  },
  {
   "NAME": "speed",
   "TYPE": "float",
   "DEFAULT": 0.0,
   "MIN": -4.0,
   "MAX": 4.0
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

// How much smaller each nested copy is. 2.6 keeps two or three copies on
// screen at once: enough to read as a dive, few enough that each is legible.
const float K = 2.6;
const float HALF = 0.42;   // half-size of the "home" copy, height-normalised

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
vec3 coverAt(vec2 uv) { vec2 q = clamp(uv, 0.001, 0.999); return IMG_NORM_PIXEL(cover, q).rgb; }

// The colour at screen point p for zoom phase z (fractional level).
//
// WHY THE NEXT COPY FADES IN. Drawn opaque, the nested copy permanently
// covered the middle 1/K of the cover — exactly where a cover's subject
// (usually a face) sits, so it was never seen. Instead copy i's opacity
// follows its size: the copies around the home one (i <= 0) are opaque, the
// next one in (i = 1) fades in from nothing as it grows (opacity = phase),
// deeper ones are not drawn. At the wrap (phase 1 -> 0) copy 1 becomes copy
// 0 at full opacity and copy 2 becomes copy 1 at zero, so the loop is
// seamless and the whole cover is visible for most of every cycle.
vec3 scene(vec2 p, float z) {
  float f = fract(z);
  float s = pow(K, f);                           // 1..K: the home copy's growth
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    float i = float(j) - 2.0;                    // copies -2, -1, 0, 1
    float half_ = HALF * s * pow(K, -i);
    vec2 uv = p / (2.0 * half_) + 0.5;
    vec2 e = min(uv, 1.0 - uv);
    float inside = step(0.0, min(e.x, e.y));
    float a = i < 0.5 ? 1.0 : f * f * (3.0 - 2.0 * f);
    // A soft shadow just outside the copy, so it reads as a picture lying
    // on the bigger one, and a rim in the song's colour.
    vec2 d = max(abs(uv - 0.5) - 0.5, 0.0);
    c *= 1.0 - 0.35 * a * exp(-length(d) * 30.0) * (1.0 - inside);
    float rim = smoothstep(0.008, 0.0, min(e.x, e.y)) * inside;
    vec3 pic = mix(coverAt(uv), hsv(hue + i * 0.07, 0.65, 1.0), rim * (0.55 + kick * 0.45));
    c = mix(c, pic, inside * a);
  }
  return c;
}

void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = TIME;
  // A slow roll and a lens bulge: the "globe" feel of a fly-in from orbit.
  float a = sin(t * 0.07) * 0.12 + drop * 0.25;
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  float r2 = dot(p, p);
  p *= 1.0 - 0.18 * r2 * (0.6 + level * 0.4);

  // Motion blur along the dive: average the picture a little further in
  // (or out, pulling back) — strongest when the camera is moving fastest.
  float blur = clamp(abs(speed), 0.0, 3.0) * 0.012;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float k = float(i) / 3.0;
    col += scene(p * (1.0 - sign(speed) * blur * k), zoom);
  }
  col /= 4.0;

  // Atmosphere: a glow in the song's colour at the edge, brighter on the kick.
  float rim = smoothstep(0.35, 1.1, length(p * vec2(res.y / res.x, 1.0) * 1.4));
  col = mix(col, hsv(hue, 0.6, 0.9), rim * (0.25 + kick * 0.25));
  col *= 0.92 + level * 0.18;
  col += vec3(drop * 0.18);
  gl_FragColor = vec4(col, 1.0);
}

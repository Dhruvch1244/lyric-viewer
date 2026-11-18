/*{
 "DESCRIPTION": "Cover 3D: the song's cover art as a lit relief you fly over. A depth map estimated from the cover (cover3d.js) is ray-marched as a height field, so the picture has real parallax: the camera sways, dollies in on the kick, and the relief deepens on a drop.",
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
   "NAME": "depthMap",
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

// Clamp into a variable first: passing clamp(uv, 0.0, 1.0) straight into
// IMG_NORM_PIXEL failed to compile ("no matching overloaded function") once
// the ISF renderer had rewritten the call, while this form compiles.
float depthAt(vec2 uv) { vec2 q = clamp(uv, 0.0, 1.0); return IMG_NORM_PIXEL(depthMap, q).r; }
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

void main() {
  vec2 res = RENDERSIZE;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;     // height-normalised, centred
  float t = TIME;

  // The camera: a slow orbit, a dolly on the kick, a lunge on the drop.
  vec2 sway = vec2(sin(t * 0.31), cos(t * 0.23)) * (0.55 + level * 0.6);
  float zoom = 1.0 + kick * 0.08 + drop * 0.12;
  float relief = 0.07 + bass * 0.05 + drop * 0.08;    // how far the picture stands out

  // The cover fills 86% of the height, square.
  float size = 0.86 / zoom;
  vec2 uv = p / size + 0.5;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));

  // Background: the cover again, huge, soft and dark, drifting the other way.
  vec2 bgUv = p * 0.45 + 0.5 - sway * 0.03;
  bgUv = clamp(bgUv, 0.0, 1.0);
  vec3 bg = IMG_NORM_PIXEL(cover, bgUv).rgb;
  bg = mix(bg, vec3(dot(bg, vec3(0.333))), 0.3) * (0.22 + level * 0.18);
  bg += hsv(hue, 0.7, 0.06) * (1.0 + kick);
  vec3 col = bg;

  if (inside) {
    // Parallax occlusion mapping: march the view ray down through the
    // height field until it goes below the surface, then refine once.
    vec2 dir = -sway * relief;
    const int STEPS = 24;
    float layer = 1.0 / float(STEPS);
    float rayH = 1.0;
    vec2 cur = uv;
    float surf = depthAt(cur);
    vec2 prevUv = cur;
    float prevRay = rayH, prevSurf = surf;
    for (int i = 0; i < STEPS; i++) {
      if (rayH <= surf) break;
      prevUv = cur; prevRay = rayH; prevSurf = surf;
      cur += dir * layer;
      rayH -= layer;
      surf = depthAt(cur);
    }
    float a = (prevRay - prevSurf), b = (surf - rayH);
    float w = a / max(a + b, 1e-4);
    vec2 hit = mix(prevUv, cur, w);

    hit = clamp(hit, 0.0, 1.0);
    vec3 base = IMG_NORM_PIXEL(cover, hit).rgb;
    // Light it from a lamp that circles the picture.
    float e = 1.0 / 256.0;
    float dx = depthAt(hit + vec2(e, 0.0)) - depthAt(hit - vec2(e, 0.0));
    float dy = depthAt(hit + vec2(0.0, e)) - depthAt(hit - vec2(0.0, e));
    vec3 n = normalize(vec3(-dx * 18.0 * (1.0 + drop), -dy * 18.0 * (1.0 + drop), 1.0));
    vec3 lamp = normalize(vec3(cos(t * 0.5), sin(t * 0.5), 0.9));
    float diff = 0.55 + 0.6 * max(dot(n, lamp), 0.0);
    float spec = pow(max(dot(reflect(-lamp, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
    float h = depthAt(hit);
    col = base * diff * (0.85 + level * 0.35) + hsv(hue, 0.5, 1.0) * spec * (0.35 + kick * 0.8);
    // The near parts glow on the beat.
    col += hsv(hue + 0.08, 0.8, 1.0) * smoothstep(0.6, 1.0, h) * kick * 0.35;
    // A thin lit frame so the card reads as an object.
    vec2 edge = min(uv, 1.0 - uv);
    float frame = smoothstep(0.012, 0.0, min(edge.x, edge.y));
    col = mix(col, hsv(hue, 0.6, 1.0), frame * (0.5 + kick));
    // Drop shadow-ish falloff into the background at the card edge.
  } else {
    vec2 d = max(abs(uv - 0.5) - 0.5, 0.0);
    col *= 1.0 - 0.6 * exp(-length(d) * 18.0);
  }
  col += vec3(drop * 0.25);
  gl_FragColor = vec4(col, 1.0);
}

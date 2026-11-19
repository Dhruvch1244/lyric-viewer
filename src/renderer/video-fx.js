'use strict';

/*
  Video FX — shaders that work on the music video's own footage.

  Only possible for a LOCAL video (music-video.js): YouTube's player is a
  cross-origin frame whose pixels cannot be read. A <video> on disk can be
  uploaded as a texture every frame and bent like any other picture.

  WHY ITS OWN SMALL WEBGL CANVAS, not a shader in the main engine. The main
  engine's shader is the LOOK — chosen by the song, the browser or the
  Director — and the visuals screen-blend over the video on top of that. An
  effect on the footage is a property of the VIDEO layer, so it lives in the
  video layer: the look, its shader and the Director's scene logic stay
  untouched, and the visuals still blend over the effected footage exactly
  as they blend over the plain one. One fragment shader, six modes, WebGL1
  for the widest support (WebView2 and WebKitGTK both).

  Exposed on window.VideoFX: { MODES, create(canvas) }.
*/

(function () {
  const MODES = ['none', 'kaleido', 'split', 'mosaic', 'edges', 'mirror',
    'neonglow', 'glitch', 'tunnel', 'thermal', 'zoomblur', 'halftone', 'dive',
    'echo', 'timewarp', 'mosh'];
  /* What each of the last three needs beyond the current frame: its own last
     output fed back (echo, mosh), and/or the recent frames (timewarp, mosh). */
  const FEEDBACK = new Set(['echo', 'mosh']);
  const HISTORY = new Set(['timewarp', 'mosh']);

  const VERT = `
attribute vec2 pos;
varying vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;

  const FRAG = `
precision mediump float;
uniform sampler2D tex;
uniform vec2 res;      // canvas size
uniform vec2 vres;     // video size
uniform float time, kick, bass, drop, amount, hue;
uniform int mode;
uniform sampler2D prev;   // last frame's OUTPUT (feedback modes)
uniform sampler2D hist;   // the last HN video frames, a 6x4 atlas of tiles
uniform float head;       // atlas tile holding the newest frame
varying vec2 uv;
const float HN = 24.0;

// Screen uv -> video uv, scaled to COVER the canvas (object-fit: cover).
vec2 cover(vec2 p) {
  float sa = res.x / res.y;
  float va = vres.x / max(1.0, vres.y);
  vec2 s = sa > va ? vec2(1.0, va / sa) : vec2(sa / va, 1.0);
  return (p - 0.5) * s + 0.5;
}
vec3 samp(vec2 p) { return texture2D(tex, clamp(cover(p), 0.001, 0.999)).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(float n) { return fract(sin(n) * 43758.5453); }
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

// The video as it was some frames back (0 = newest), from the history
// atlas. Tiles hold raw video frames, so cover() maps like samp(); the
// clamp keeps bilinear filtering from bleeding in the neighbouring tile.
vec3 histAt(vec2 p, float back) {
  float i = mod(head - floor(back) + HN, HN);
  vec2 tile = vec2(mod(i, 6.0), floor(i / 6.0));
  vec2 q = clamp(cover(p), 0.004, 0.996);
  return texture2D(hist, (tile + q) / vec2(6.0, 4.0)).rgb;
}

// Edge strength at p (Sobel on brightness), sampled w pixels apart.
float sobel(vec2 p, float w) {
  vec2 px = w / res;
  float tl = luma(samp(p + px * vec2(-1.0, 1.0))), t = luma(samp(p + px * vec2(0.0, 1.0))), tr = luma(samp(p + px * vec2(1.0, 1.0)));
  float l = luma(samp(p + px * vec2(-1.0, 0.0))), r = luma(samp(p + px * vec2(1.0, 0.0)));
  float bl = luma(samp(p + px * vec2(-1.0, -1.0))), b = luma(samp(p + px * vec2(0.0, -1.0))), br = luma(samp(p + px * vec2(1.0, -1.0)));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  return length(vec2(gx, gy));
}

void main() {
  vec2 p = uv;
  vec3 c = vec3(0.0);
  if (mode == 1) {
    // Kaleido: fold the angle into mirrored segments around the centre.
    vec2 d = (p - 0.5) * vec2(res.x / res.y, 1.0);
    float r = length(d);
    float seg = 6.0 + floor(drop * 4.0 + amount * 2.0) * 2.0;
    float a = atan(d.y, d.x) + time * 0.08 + kick * 0.15;
    float w = 6.2831853 / seg;
    a = mod(a, w);
    a = min(a, w - a);
    vec2 q = vec2(cos(a), sin(a)) * r * (1.0 - kick * 0.06);
    c = samp(q * vec2(res.y / res.x, 1.0) + 0.5);
  } else if (mode == 2) {
    // RGB split: channels pulled apart on the kick; glitch slices on a drop.
    float band = floor(p.y * 24.0) + floor(time * 12.0);
    p.x += (hash(band) - 0.5) * 0.08 * drop * step(0.6, hash(band + 7.0));
    float ang = time * 0.7;
    vec2 o = vec2(cos(ang), sin(ang)) * (0.003 + kick * 0.018 + amount * 0.008);
    c = vec3(samp(p + o).r, samp(p).g, samp(p - o).b);
    c *= 0.94 + 0.06 * sin(uv.y * res.y * 1.6);
  } else if (mode == 3) {
    // Mosaic: tiles that breathe with the bass, a grid that shows on the kick.
    float cell = mix(0.006, 0.045, clamp(bass * 0.7 + drop * 0.6 + amount * 0.3, 0.0, 1.0));
    vec2 aspect = vec2(res.x / res.y, 1.0);
    vec2 g = (floor(p * aspect / cell) + 0.5) * cell / aspect;
    c = samp(g);
    vec2 f = fract(p * aspect / cell);
    float edge = step(0.92, max(f.x, f.y));
    c = mix(c, c * 0.5, edge * (0.4 + kick * 0.6));
  } else if (mode == 4) {
    // Neon edges: a Sobel outline in the song's colour over a dim picture.
    vec2 px = 1.5 / res;
    float tl = luma(samp(p + px * vec2(-1.0, 1.0))), t = luma(samp(p + px * vec2(0.0, 1.0))), tr = luma(samp(p + px * vec2(1.0, 1.0)));
    float l = luma(samp(p + px * vec2(-1.0, 0.0))), r = luma(samp(p + px * vec2(1.0, 0.0)));
    float bl = luma(samp(p + px * vec2(-1.0, -1.0))), b = luma(samp(p + px * vec2(0.0, -1.0))), br = luma(samp(p + px * vec2(1.0, -1.0)));
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float e = clamp(length(vec2(gx, gy)) * (2.2 + kick * 2.5), 0.0, 1.0);
    c = samp(p) * 0.18 + hsv(hue + e * 0.15, 0.85, 1.0) * e;
  } else if (mode == 5) {
    // Mirror: the left half reflected, pushed in on the kick.
    p = (p - 0.5) / (1.0 + kick * 0.05) + 0.5;
    p.x = p.x > 0.5 ? 1.0 - p.x : p.x;
    c = samp(p);
  } else if (mode == 6) {
    // Neon glow: the picture pushed to full saturation, its outlines lit in
    // a hue that cycles with the song, and its bright parts blooming.
    vec3 base = samp(p);
    float e = clamp(sobel(p, 1.5) * (2.0 + kick * 2.0), 0.0, 1.0);
    vec3 bloom = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      bloom += max(samp(p + vec2(cos(a), sin(a)) * (7.0 + kick * 6.0) / res) - 0.7, 0.0);
    }
    float l = luma(base);
    // The picture sits dark and saturated so the lit outlines carry it —
    // measured on bright black-and-white footage, a brighter base and a
    // lower bloom threshold washed the whole frame out to white.
    vec3 vivid = clamp(mix(vec3(l), base, 2.2), 0.0, 1.0);
    vec3 tint = hsv(hue + time * 0.04 + e * 0.2, 0.9, 1.0);
    c = vivid * vivid * (0.35 + bass * 0.15) + tint * e * 1.4 + bloom * 0.25 * (0.8 + kick) * tint;
  } else if (mode == 7) {
    // Glitch: blocks of the frame jump sideways and lose a channel, a tear
    // line rolls down the picture; the kick and the drop make it worse.
    vec2 blk = floor(p * vec2(16.0, 9.0)) + floor(time * 9.0);
    float h = hash(blk.x * 13.0 + blk.y * 7.0);
    float on = step(0.86 - kick * 0.25 - drop * 0.4 - amount * 0.1, h);
    p.x += (hash(h * 91.0) - 0.5) * 0.18 * on;
    float tear = step(abs(fract(time * 0.37) - uv.y), 0.006 + kick * 0.01);
    p.x += tear * 0.05;
    float o = 0.004 + kick * 0.02 + on * 0.02;
    c = vec3(samp(p + vec2(o, 0.0)).r, samp(p).g, samp(p - vec2(o, 0.0)).b);
    c = mix(c, floor(c * 4.0) / 4.0 * vec3(1.2, 0.6, 1.4), on * step(0.5, hash(h * 17.0)));
    c = mix(c, 1.0 - c, step(0.985, hash(floor(time * 6.0))) * drop);
  } else if (mode == 8) {
    // Tunnel: the footage wrapped round the walls of a tube flying at you,
    // faster on the bass. Mirrored seams, so it never shows a hard edge.
    vec2 d = (p - 0.5) * vec2(res.x / res.y, 1.0);
    float r = max(length(d), 0.001);
    float a = atan(d.y, d.x) / 6.2831853 + 0.5;
    vec2 q = vec2(a * 2.0 + time * 0.03, 0.35 / r + time * (0.25 + bass * 0.6 + drop));
    q = abs(fract(q * 0.5) * 2.0 - 1.0);  // mirror-repeat
    c = samp(q) * smoothstep(0.0, 0.35, r) * (1.0 + kick * 0.3);
    c += hsv(hue, 0.8, 1.0) * exp(-r * 9.0) * (0.3 + kick);
  } else if (mode == 9) {
    // Thermal: brightness as a heat camera's palette, which runs hotter on
    // the kick.
    float l = clamp(luma(samp(p)) + kick * 0.12 + drop * 0.2, 0.0, 1.0);
    c = l < 0.33 ? mix(vec3(0.02, 0.0, 0.25), vec3(0.6, 0.0, 0.7), l * 3.0)
      : l < 0.66 ? mix(vec3(0.6, 0.0, 0.7), vec3(1.0, 0.25, 0.0), (l - 0.33) * 3.0)
      : mix(vec3(1.0, 0.25, 0.0), vec3(1.0, 1.0, 0.7), (l - 0.66) * 3.0);
  } else if (mode == 10) {
    // Zoom blur: the frame smeared toward the centre — a rush forward on
    // every kick, a hard punch on a drop.
    float k = 0.02 + kick * 0.08 + drop * 0.15 + amount * 0.03;
    for (int i = 0; i < 10; i++) {
      c += samp((p - 0.5) * (1.0 - k * float(i) / 9.0) + 0.5);
    }
    c /= 10.0;
    c = clamp(mix(vec3(luma(c)), c, 1.4), 0.0, 1.0);
  } else if (mode == 11) {
    // Neon halftone: the picture as a grid of glowing dots on black, each
    // dot sized by its brightness and lit in its own colour, pushed vivid.
    float cell = 9.0 + bass * 5.0;
    vec2 px = uv * res;
    vec2 ctr = (floor(px / cell) + 0.5) * cell;
    vec3 s = samp(ctr / res);
    float l = luma(s);
    float rad = cell * 0.46 * sqrt(l) * (1.0 + kick * 0.15);
    float dot_ = smoothstep(rad, rad - 1.5, length(px - ctr));
    // The dot's own colour, pulled toward the song's hue: footage with
    // little colour (black-and-white videos are common) still reads neon.
    vec3 vivid = clamp(mix(vec3(l), s, 2.5), 0.0, 1.0);
    vivid = mix(vivid, hsv(hue + l * 0.25, 0.9, 1.0), 0.65 * (1.0 - clamp((max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b))) * 3.0, 0.0, 1.0)));
    c = vivid * dot_ + hsv(hue, 0.8, 0.06) * (1.0 - dot_);
  } else if (mode == 12) {
    // Dive: an endless zoom into the video, which holds a smaller copy of
    // itself at its centre — the next copy fades in as the camera nears it,
    // the same seamless loop as the Cover Earth look.
    float z = fract(time * (0.12 + bass * 0.08));
    float s = pow(2.4, z);
    vec2 d = (p - 0.5);
    for (int j = 0; j < 3; j++) {
      float i = float(j) - 1.0;
      float sc = s * pow(2.4, -i);
      vec2 q = d / sc + 0.5;
      vec2 e = min(q, 1.0 - q);
      float inside = step(0.0, min(e.x, e.y));
      float a = i < 0.5 ? 1.0 : z * z * (3.0 - 2.0 * z);
      float rim = smoothstep(0.01, 0.0, min(e.x, e.y)) * inside;
      vec3 pic = mix(samp(q), hsv(hue + i * 0.1, 0.8, 1.0), rim * (0.6 + kick));
      c = mix(c, pic, inside * a);
    }
  } else if (mode == 13) {
    // Echo: neon outlines over the dimmed picture, fed back into a slowly
    // zooming, turning copy of the last frame — trails that stream out of
    // the centre and shift colour as they fade. Bigger zoom on the kick.
    vec3 cur = samp(p);
    float e = clamp(sobel(p, 1.5) * 2.5, 0.0, 1.0);
    vec3 src = cur * 0.55 + hsv(hue + time * 0.05, 0.9, 1.0) * e;
    float z = 0.985 - kick * 0.025 - drop * 0.04;
    float a = 0.004 + bass * 0.01;
    vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * ((uv - 0.5) * z) + 0.5;
    vec3 old = texture2D(prev, q).rgb;
    old = mix(old, old.gbr, 0.04) * (0.9 + amount * 0.04);   // hue drift as it fades
    c = max(src, old);
  } else if (mode == 14) {
    // Time warp (slit-scan): each row shows the video from a different
    // moment of the last second, bottom newest — a wave of delay that
    // stretches moving things into ribbons. The wave swells with the bass.
    float b = clamp(uv.y + (0.08 + bass * 0.12) * sin(uv.x * 5.0 + time * 1.3), 0.0, 1.0) * (HN - 2.0);
    c = mix(histAt(p, b), histAt(p, b + 1.0), fract(b));
  } else if (mode == 15) {
    // Datamosh: the last output is smeared along the picture's brightness
    // gradient in 12px blocks and only refreshed where the video actually
    // changed — the I-frame-dropped look. A kick or a drop refreshes it all.
    vec2 blk = (floor(uv * res / 12.0) + 0.5) * 12.0 / res;
    vec2 px = 3.0 / res;
    float gx = luma(samp(blk + vec2(px.x, 0.0))) - luma(samp(blk - vec2(px.x, 0.0)));
    float gy = luma(samp(blk + vec2(0.0, px.y))) - luma(samp(blk - vec2(0.0, px.y)));
    vec3 old = texture2D(prev, uv - vec2(gx, gy) * (0.02 + bass * 0.03)).rgb;
    vec3 cur = samp(p);
    float change = length(cur - histAt(p, 2.0));
    float refresh = clamp(step(0.35, change) + step(0.85, kick) + step(0.5, drop) + 0.015, 0.0, 1.0);
    c = mix(old, cur, refresh);
  } else {
    c = samp(p);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

  /* Draws a texture as it is: into the history atlas, and a feedback
     target to the screen. */
  const COPY = `
precision mediump float;
uniform sampler2D src;
varying vec2 uv;
void main() { gl_FragColor = texture2D(src, uv); }`;

  function create(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'compile failed');
      return sh;
    };
    const link = (fragSrc) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.bindAttribLocation(p, 0, 'pos'); // both programs share the quad
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
      return p;
    };
    let prog;
    let copyProg;
    try {
      prog = link(FRAG);
      copyProg = link(COPY);
    } catch (err) {
      console.warn('[video-fx] shader failed:', err && err.message);
      return null;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const makeTex = (w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    };
    /** A render target: a texture and the framebuffer that draws into it. */
    const makeTarget = (w, h) => {
      const texture = makeTex(w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { texture, fb, w, h };
    };
    const dropTarget = (t) => { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.texture); } };
    const tex = makeTex();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const u = {};
    for (const n of ['tex', 'res', 'vres', 'time', 'kick', 'bass', 'drop', 'amount', 'hue', 'mode', 'prev', 'hist', 'head']) u[n] = gl.getUniformLocation(prog, n);
    const copySrc = gl.getUniformLocation(copyProg, 'src');
    gl.useProgram(prog);
    gl.uniform1i(u.tex, 0);
    gl.uniform1i(u.prev, 1);
    gl.uniform1i(u.hist, 2);

    /* FRAME HISTORY. The last HN video frames at 320x180, as tiles of one
       6x4 atlas (1920x720, ~5.5 MB) — one texture, so the shader reads any
       moment of the last second with one lookup, and nothing is allocated
       per frame. Written only when the video shows a NEW frame (its
       currentTime moved): at 60 fps drawing and 25-30 fps footage, writing
       every draw would fill the ring with duplicates and halve the time it
       spans. Allocated on first use, so the plain modes never pay for it. */
    const HN = 24;
    const TW = 320;
    const TH = 180;
    let atlas = null;
    let head = 0;
    let lastFrameTime = -1;
    /* FEEDBACK. Two targets at the canvas size, drawn into alternately: the
       mode reads last frame's output from one while drawing the next into
       the other, then the result is copied to the screen. */
    let fbA = null;
    let fbB = null;

    const drawCopy = (srcTex) => {
      gl.useProgram(copyProg);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(copySrc, 3);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    /**
     * Draw one frame of `video` through `mode`.
     * @param {HTMLVideoElement} video
     * @param {{mode: string, time: number, kick: number, bass: number, drop: number, amount: number, hue: number}} q
     * @returns {boolean} false when there was no frame to draw
     */
    function render(video, q) {
      if (!video || video.readyState < 2 || !video.videoWidth) return false;
      // At most 1280px wide: the footage is 720p at best, so drawing more
      // pixels than that adds fill-rate cost and no detail.
      const scale = Math.min(1, 1280 / Math.max(1, canvas.clientWidth)) * Math.min(1, window.devicePixelRatio || 1);
      const w = Math.max(2, Math.round(canvas.clientWidth * scale));
      const h = Math.max(2, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      } catch {
        return false; // a frame that cannot be read (tainted/unsupported): skip it
      }

      const feedback = FEEDBACK.has(q.mode);
      if (HISTORY.has(q.mode)) {
        if (!atlas) { atlas = makeTarget(TW * 6, TH * 4); lastFrameTime = -1; }
        if (video.currentTime !== lastFrameTime) {
          lastFrameTime = video.currentTime;
          head = (head + 1) % HN;
          gl.bindFramebuffer(gl.FRAMEBUFFER, atlas.fb);
          gl.viewport((head % 6) * TW, Math.floor(head / 6) * TH, TW, TH);
          drawCopy(tex);
        }
      }
      if (feedback && (!fbA || fbA.w !== w || fbA.h !== h)) {
        dropTarget(fbA); dropTarget(fbB);
        fbA = makeTarget(w, h);
        fbB = makeTarget(w, h);
      }

      gl.useProgram(prog);
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.vres, video.videoWidth, video.videoHeight);
      gl.uniform1f(u.time, q.time || 0);
      gl.uniform1f(u.kick, q.kick || 0);
      gl.uniform1f(u.bass, q.bass || 0);
      gl.uniform1f(u.drop, q.drop || 0);
      gl.uniform1f(u.amount, q.amount || 0);
      gl.uniform1f(u.hue, ((q.hue || 0) % 360) / 360);
      gl.uniform1i(u.mode, Math.max(0, MODES.indexOf(q.mode)));
      gl.uniform1f(u.head, head);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, feedback ? fbB.texture : null);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, atlas ? atlas.texture : null);
      if (feedback) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbA.fb);
        gl.viewport(0, 0, w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        drawCopy(fbA.texture);
        [fbA, fbB] = [fbB, fbA];
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      return true;
    }

    function destroy() {
      gl.deleteTexture(tex);
      dropTarget(atlas); dropTarget(fbA); dropTarget(fbB);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteProgram(copyProg);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    return { render, destroy };
  }

  window.VideoFX = { MODES, create };
})();

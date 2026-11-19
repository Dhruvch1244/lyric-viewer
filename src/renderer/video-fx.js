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
  const MODES = ['none', 'kaleido', 'split', 'mosaic', 'edges', 'mirror'];

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
varying vec2 uv;

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

void main() {
  vec2 p = uv;
  vec3 c;
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
  } else {
    c = samp(p);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

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
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    } catch (err) {
      console.warn('[video-fx] shader failed:', err && err.message);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const u = {};
    for (const n of ['tex', 'res', 'vres', 'time', 'kick', 'bass', 'drop', 'amount', 'hue', 'mode']) u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(u.tex, 0);

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
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      } catch {
        return false; // a frame that cannot be read (tainted/unsupported): skip it
      }
      gl.uniform2f(u.res, w, h);
      gl.uniform2f(u.vres, video.videoWidth, video.videoHeight);
      gl.uniform1f(u.time, q.time || 0);
      gl.uniform1f(u.kick, q.kick || 0);
      gl.uniform1f(u.bass, q.bass || 0);
      gl.uniform1f(u.drop, q.drop || 0);
      gl.uniform1f(u.amount, q.amount || 0);
      gl.uniform1f(u.hue, ((q.hue || 0) % 360) / 360);
      gl.uniform1i(u.mode, Math.max(0, MODES.indexOf(q.mode)));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    function destroy() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    return { render, destroy };
  }

  window.VideoFX = { MODES, create };
})();

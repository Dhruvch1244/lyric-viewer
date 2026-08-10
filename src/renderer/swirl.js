'use strict';

/*
  GPU swirl field — the fluid base layer of the backdrop.

  Why this exists: the 2D-canvas layers in renderer.js are great at *discrete*
  things (stars, confetti, ripples, parametric curves) but a full-screen
  churning, domain-warped colour field is per-pixel work. Doing that on the CPU
  is impossible at 60fps; on the GPU it is close to free — it is one fullscreen
  quad and a fragment shader. So this layer owns the soft, continuous "liquid"
  look and renderer.js keeps everything else.

  The visual is a two-stage domain warp (the fbm-of-fbm technique) pushed
  through a set of moving vortices, so colour bands genuinely spiral inward and
  unwind outward rather than merely drifting. Vortex strength is driven from
  the host (see `render`), which is what makes the swirl *timed* to the music
  and the lyrics rather than just idling.

  Degrades safely: if WebGL2 is unavailable `init()` returns false, `isActive()`
  stays false, and renderer.js paints its original flat colour wash instead.

  Exposed on window.SwirlField:
    - init(canvas) -> boolean      compile + upload; false if WebGL2 is missing
    - resize(cssW, cssH, scale)    size the drawing buffer (scale <1 = cheaper)
    - render(state)                draw one frame (see STATE below)
    - isActive() -> boolean
    - setQuality(q)                0..1, lowers fbm octaves when frames run long

  STATE fields (all optional, sane defaults):
    timeMs   number   animation clock
    palette  string[] 4 hex colours ('#rrggbb'), darkest first
    alpha    number   0..1 overall opacity (follows the backdrop-level chip)
    life     number   0..1 general energy
    swirl    number   0..1 how hard the vortices spiral (the headline control)
    buildup  number   0..1 EDM riser
    drop     number   0..1 drop flash
    beat     number   0..1 decaying per-beat pulse
    bass     number   0..1 live bass band
*/

(function () {
  const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

  /*
    Fragment shader.

    Cost control: the fbm loops are bounded by compile-time constants (GLSL ES
    requires constant loop bounds for reliable unrolling) and cut short at run
    time by u_octaves, so lowering quality genuinely skips ALU work.
  */
  const FRAG = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_res;
uniform float u_time;      // seconds
uniform vec3  u_pal0;
uniform vec3  u_pal1;
uniform vec3  u_pal2;
uniform vec3  u_pal3;
uniform float u_alpha;
uniform float u_life;
uniform float u_swirl;
uniform float u_buildup;
uniform float u_drop;
uniform float u_beat;
uniform float u_bass;
uniform int   u_octaves;

const int MAX_OCTAVES = 6;

/* --- value noise ------------------------------------------------------- */

float hash(vec2 p) {
  // Cheap, stable, and good enough for a soft colour field.
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);       // smoothstep interpolation
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= u_octaves) break;
    sum += amp * noise(p);
    norm += amp;
    p *= 2.02;                            // slightly off 2.0 to avoid axis alignment
    amp *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

/* --- vortices ----------------------------------------------------------- */

/*
  Rotate p around centre c by an angle that grows as you approach the centre,
  which is what reads as a spiral. The +0.28 keeps the very centre from
  degenerating into an infinitely fast pinwheel.
*/
vec2 vortex(vec2 p, vec2 c, float strength) {
  vec2 d = p - c;
  float r = length(d);
  float a = strength / (r + 0.28);
  float s = sin(a);
  float co = cos(a);
  return c + mat2(co, -s, s, co) * d;
}

void main() {
  // Aspect-corrected coords centred on the screen.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);

  float t = u_time;

  // Breathing term: the swirl winds IN and unwinds OUT instead of spinning one
  // way forever. Build-up biases it to keep winding in (tension), and the drop
  // kicks it hard outward (release).
  float breathe = sin(t * 0.31) * 0.65 + sin(t * 0.13 + 1.7) * 0.35;
  float spiral = u_swirl * (0.55 + 0.45 * breathe) + u_buildup * 0.9 - u_drop * 1.5;

  // Three slowly orbiting vortex centres so the field never looks symmetric.
  vec2 c0 = vec2(cos(t * 0.21) * 0.42, sin(t * 0.17) * 0.34);
  vec2 c1 = vec2(cos(t * -0.13 + 2.1) * 0.55, sin(t * 0.19 + 0.7) * 0.42);
  vec2 c2 = vec2(cos(t * 0.09 + 4.0) * 0.30, sin(t * -0.23 + 2.5) * 0.30);

  vec2 p = uv;
  p = vortex(p, c0, spiral * 0.95);
  p = vortex(p, c1, spiral * -0.70);
  p = vortex(p, c2, spiral * 0.55);

  // Bass squeezes the whole field toward/away from centre — a subtle "pump".
  p *= 1.0 - u_bass * 0.10 - u_beat * 0.05;

  // Two-stage domain warp: q displaces the lookup, r displaces it again. This
  // is what produces the marbled, liquid banding rather than plain noise.
  // The scale has to be high enough to show structure — too low and the whole
  // screen is one smooth blob that reads as a plain gradient.
  float scale = 2.30 + u_life * 0.90;
  vec2 q = vec2(fbm(p * scale + vec2(0.0, t * 0.09)),
                fbm(p * scale + vec2(4.7, -t * 0.07)));
  vec2 r = vec2(fbm(p * scale + q * (1.6 + u_swirl * 1.4) + vec2(1.7, 9.2) + t * 0.05),
                fbm(p * scale + q * (1.6 + u_swirl * 1.4) + vec2(8.3, 2.8) - t * 0.04));

  float f = fbm(p * scale + r * (1.8 + u_buildup * 1.2));

  /*
    Flow ribbons. A domain warp alone is smooth, so on screen it reads as a
    soft gradient no matter how violently the coordinates are actually being
    twisted — there is no feature to watch move. Slicing the field into
    contour bands gives the eye filaments to track, which is what makes the
    spiralling legible. More swirl -> more bands, so the field visibly
    "tightens" as it winds in.
  */
  float bands = 2.5 + u_swirl * 4.5;
  float ribbon = 0.5 + 0.5 * sin((f * bands + length(r) * 0.55 - t * 0.10) * 6.28318);
  ribbon = pow(ribbon, 2.2 - u_life);          // tighten into distinct filaments

  // Shape the field so bands read crisply instead of washing to grey.
  f = clamp(f * 1.35 - 0.12, 0.0, 1.0);
  float shade = clamp(f * 0.62 + ribbon * (0.26 + u_swirl * 0.46), 0.0, 1.0);

  // Palette ramp: dark base -> mid -> accent, with the brightest stop reserved
  // for the energetic tail so quiet moments stay dark and legible.
  vec3 col = mix(u_pal0, u_pal1, smoothstep(0.05, 0.55, shade));
  col = mix(col, u_pal2, smoothstep(0.45, 0.85, shade));
  col = mix(col, u_pal3, smoothstep(0.72, 1.0, shade) * (0.35 + u_life * 0.65));

  // Bright rims where filaments crest — reads as light catching a fold.
  col += u_pal3 * pow(ribbon, 6.0) * (0.10 + u_swirl * 0.30);

  // Vortex glow: brighten the cores so the spirals have visible eyes.
  float g0 = 1.0 - smoothstep(0.0, 0.55, length(uv - c0));
  float g1 = 1.0 - smoothstep(0.0, 0.45, length(uv - c1));
  col += u_pal3 * (g0 * 0.16 + g1 * 0.12) * (0.35 + u_life + u_beat * 0.8);

  // Build-up bloom from the centre, and a full-field flash on the drop.
  float centre = 1.0 - smoothstep(0.0, 0.9, length(uv));
  col += u_pal3 * centre * u_buildup * 0.55;
  col += u_pal3 * u_drop * 0.40;
  col += col * u_beat * 0.18;

  // Depth vignette so the lyric column always sits on darker pixels.
  float vig = 1.0 - smoothstep(0.55, 1.35, length(uv) * 1.15);
  col *= 0.30 + 0.70 * vig;

  fragColor = vec4(col, u_alpha);
}
`;

  /** @type {WebGL2RenderingContext|null} */ let gl = null;
  /** @type {HTMLCanvasElement|null} */ let cv = null;
  /** @type {WebGLProgram|null} */ let prog = null;
  let active = false;
  let octaves = 5;
  const u = {};

  /* Reused scratch so render() allocates nothing per frame. */
  const rgb = [
    new Float32Array(3), new Float32Array(3),
    new Float32Array(3), new Float32Array(3),
  ];
  let lastPaletteKey = '';

  /**
   * Compile one shader stage.
   * @param {number} type gl.VERTEX_SHADER | gl.FRAGMENT_SHADER
   * @param {string} src GLSL source
   * @returns {WebGLShader|null}
   */
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[swirl] shader compile failed:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  /**
   * Parse '#rrggbb' into a normalised rgb triple, written into `out`.
   * @param {string} hex
   * @param {Float32Array} out
   */
  function hexToRgb(hex, out) {
    const h = (hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h.slice(0, 6), 16);
    if (Number.isNaN(n)) { out[0] = out[1] = out[2] = 0; return; }
    out[0] = ((n >> 16) & 255) / 255;
    out[1] = ((n >> 8) & 255) / 255;
    out[2] = (n & 255) / 255;
  }

  /**
   * Create the GL context, program and fullscreen quad.
   * @param {HTMLCanvasElement} canvas
   * @returns {boolean} whether the layer is usable
   */
  function init(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    cv = canvas;
    // No `desynchronized` here: the player window is transparent+borderless
    // (see main.js), and bypassing the compositor's normal path is what causes
    // tearing and lost transparency on Windows.
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,          // a soft colour field gains nothing from MSAA
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      console.warn('[swirl] WebGL2 unavailable — falling back to the 2D wash');
      return false;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[swirl] link failed:', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.useProgram(prog);

    // Fullscreen triangle pair.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 3, -1, -1, 3,
    ]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const name of [
      'u_res', 'u_time', 'u_pal0', 'u_pal1', 'u_pal2', 'u_pal3', 'u_alpha',
      'u_life', 'u_swirl', 'u_buildup', 'u_drop', 'u_beat', 'u_bass', 'u_octaves',
    ]) {
      u[name] = gl.getUniformLocation(prog, name);
    }

    // The layer is composited by the browser over the page, so no blending
    // inside GL is needed — the alpha channel we write is the layer opacity.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    active = true;
    return true;
  }

  /**
   * Size the drawing buffer. Rendering below CSS resolution is nearly free
   * visually here (the field is soft and blurred by design) and is the single
   * biggest performance lever this layer has.
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} [scale=0.7] drawing-buffer scale relative to CSS pixels
   */
  function resize(cssW, cssH, scale) {
    if (!active || !gl || !cv) return;
    const s = Math.max(0.35, Math.min(1, scale || 0.7));
    const w = Math.max(1, Math.floor(cssW * s));
    const h = Math.max(1, Math.floor(cssH * s));
    if (cv.width === w && cv.height === h) return;
    cv.width = w;
    cv.height = h;
    gl.viewport(0, 0, w, h);
  }

  /**
   * Lower shader cost when the host reports a sagging frame rate.
   * @param {number} q 0..1
   */
  function setQuality(q) {
    octaves = q > 0.85 ? 5 : q > 0.6 ? 4 : q > 0.4 ? 3 : 2;
  }

  /**
   * Draw one frame.
   * @param {object} state see STATE in the file header
   */
  function render(state) {
    if (!active || !gl) return;
    const s = state || {};

    // Palette uploads only when it actually changes (per-track, not per-frame).
    const pal = s.palette && s.palette.length >= 4
      ? s.palette
      : ['#0d0d1a', '#4361ee', '#7209b7', '#4cc9f0'];
    const key = pal.join('');
    if (key !== lastPaletteKey) {
      lastPaletteKey = key;
      for (let i = 0; i < 4; i += 1) hexToRgb(pal[i], rgb[i]);
      gl.uniform3fv(u.u_pal0, rgb[0]);
      gl.uniform3fv(u.u_pal1, rgb[1]);
      gl.uniform3fv(u.u_pal2, rgb[2]);
      gl.uniform3fv(u.u_pal3, rgb[3]);
    }

    gl.uniform2f(u.u_res, cv.width, cv.height);
    gl.uniform1f(u.u_time, (s.timeMs || 0) / 1000);
    gl.uniform1f(u.u_alpha, s.alpha == null ? 1 : s.alpha);
    gl.uniform1f(u.u_life, s.life || 0);
    gl.uniform1f(u.u_swirl, s.swirl || 0);
    gl.uniform1f(u.u_buildup, s.buildup || 0);
    gl.uniform1f(u.u_drop, s.drop || 0);
    gl.uniform1f(u.u_beat, s.beat || 0);
    gl.uniform1f(u.u_bass, s.bass || 0);
    gl.uniform1i(u.u_octaves, octaves);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  window.SwirlField = { init, resize, render, setQuality, isActive: () => active };
})();

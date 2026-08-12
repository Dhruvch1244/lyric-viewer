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
// Per-preset character multipliers (see presets.js): how tightly the field
// bands, how hard it spirals, and how much the vortex cores glow.
uniform float u_bandBias;
uniform float u_vortexBias;
uniform float u_glowBias;
uniform float u_stars;     // deep-space starfield intensity (0 = off)

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

/*
  Two-octave fbm for the domain-warp stages.

  The warp only needs low-frequency displacement — the fine detail it adds is
  destroyed by the very warping it feeds. Running full octaves here was
  invisible on screen and cost most of the shader's budget: the field used
  5 fbm calls x 5 octaves x 4 hashes = ~100 hash evaluations per pixel, which
  at 1080p is ~100M per frame and is why weak/integrated GPUs sat at ~20fps.
*/
float fbmWarp(vec2 p) {
  float sum = noise(p) * 0.5;
  sum += noise(p * 2.02) * 0.25;
  return sum / 0.75;
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

/* --- deep-space stars (GPU) -------------------------------------------- */
/*
  A hashed grid of sparse, twinkling points. This is a 2D layer that used to
  cost the CPU one draw per star; on the GPU it is a few instructions per pixel,
  reuses the field own hash, and scales to any density for free. thresh is how
  empty the grid is (higher = sparser); scale is the grid frequency.
*/
float starLayer(vec2 uv, float t, float thresh, float scale) {
  vec2 g = uv * scale;
  vec2 cell = floor(g);
  float h = hash(cell);
  if (h < thresh) return 0.0;                 // most cells hold no star
  vec2 f = fract(g) - 0.5;
  vec2 off = (vec2(hash(cell + 1.7), hash(cell + 4.3)) - 0.5) * 0.6;
  float d = length(f - off);
  float tw = 0.55 + 0.45 * sin(t * (0.8 + h * 2.5) + h * 40.0);  // twinkle
  return smoothstep(0.06, 0.0, d) * tw;
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
  float vb = u_vortexBias;
  p = vortex(p, c0, spiral * 0.95 * vb);
  p = vortex(p, c1, spiral * -0.70 * vb);
  p = vortex(p, c2, spiral * 0.55 * vb);

  // Bass squeezes the whole field toward/away from centre — a subtle "pump".
  p *= 1.0 - u_bass * 0.10 - u_beat * 0.05;

  // Two-stage domain warp: q displaces the lookup, r displaces it again. This
  // is what produces the marbled, liquid banding rather than plain noise.
  // The scale has to be high enough to show structure — too low and the whole
  // screen is one smooth blob that reads as a plain gradient.
  float scale = 2.30 + u_life * 0.90;
  vec2 q = vec2(fbmWarp(p * scale + vec2(0.0, t * 0.09)),
                fbmWarp(p * scale + vec2(4.7, -t * 0.07)));
  vec2 warp = q * (1.6 + u_swirl * 1.4);
  vec2 r = vec2(fbmWarp(p * scale + warp + vec2(1.7, 9.2) + t * 0.05),
                fbmWarp(p * scale + warp + vec2(8.3, 2.8) - t * 0.04));

  float f = fbm(p * scale + r * (1.8 + u_buildup * 1.2));

  /*
    Flow ribbons. A domain warp alone is smooth, so on screen it reads as a
    soft gradient no matter how violently the coordinates are actually being
    twisted — there is no feature to watch move. Slicing the field into
    contour bands gives the eye filaments to track, which is what makes the
    spiralling legible. More swirl -> more bands, so the field visibly
    "tightens" as it winds in.
  */
  float bands = (2.5 + u_swirl * 4.5) * u_bandBias;
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
  col += u_pal3 * (g0 * 0.16 + g1 * 0.12) * (0.35 + u_life + u_beat * 0.8) * u_glowBias;

  // Build-up bloom from the centre, and a full-field flash on the drop.
  float centre = 1.0 - smoothstep(0.0, 0.9, length(uv));
  col += u_pal3 * centre * u_buildup * 0.55;
  col += u_pal3 * u_drop * 0.40;
  col += col * u_beat * 0.18;

  // Depth vignette so the lyric column always sits on darker pixels.
  float vig = 1.0 - smoothstep(0.55, 1.35, length(uv) * 1.15);
  col *= 0.30 + 0.70 * vig;

  // Deep-space starfield: two parallax layers, added after the vignette so the
  // points stay crisp across the whole field. Reads as depth behind the liquid.
  // Costs nothing on the CPU — this is the old galaxy-style layer, on the GPU.
  if (u_stars > 0.001) {
    float stars = starLayer(uv, t, 0.90, 7.0)
                + starLayer(uv * 1.6 + vec2(3.1, 1.7), t * 1.3, 0.93, 12.0) * 0.6;
    col += vec3(0.82, 0.88, 1.0) * stars * u_stars * (0.6 + u_beat * 0.6);
  }

  fragColor = vec4(col, u_alpha);
}
`;

  /*
    The phyllotaxis galaxy, as a GPU point pass.

    This is the 260-point Fibonacci spiral that used to be drawn on the 2D
    canvas — one fillRect per point per frame. As discrete points it cannot go
    in the fragment shader (a per-pixel loop over 260 points is hundreds of
    millions of iterations a frame), so it is a SECOND program drawing GL_POINTS
    from a VBO seeded once with each point's (angle, radius). The spin, spread,
    tilt, twinkle and beat-swell are all computed on the GPU from the same
    uniforms the field uses, so the CPU uploads nothing per frame and this scales
    to any point count for free.

    It is optional: if this program fails to build, the field still renders and
    the caller keeps the CPU galaxy. See `galaxyReady`.
  */
  const GALAXY_VERT = `#version 300 es
layout(location = 0) in vec2 a_pt;   // (angle radians, radius 0..1)
uniform vec2  u_res;
uniform float u_time;                 // seconds
uniform float u_life;
uniform float u_beat;
out float v_rad;
out float v_phase;
void main() {
  // Match the CPU look: spin = now*0.00006 (ms) + beat*0.05; now*0.00006/ms is
  // 0.06 per second, so u_time (seconds) * 0.06.
  float ang = a_pt.x + u_time * 0.06 + u_beat * 0.05;
  float spread = min(u_res.x, u_res.y) * (0.42 + u_life * 0.10 + u_beat * 0.04);
  float r = a_pt.y * spread;
  vec2 centre = vec2(u_res.x * 0.5, u_res.y * 0.44);
  vec2 pos = centre + vec2(cos(ang) * r, sin(ang) * r * 0.72); // tilt → disc
  vec2 clip = (pos / u_res) * 2.0 - 1.0;
  clip.y = -clip.y;                    // canvas y is down; clip y is up
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 2.0 + a_pt.y * 6.0 + u_beat * 5.0;
  v_rad = a_pt.y;
  v_phase = a_pt.x;                    // per-point twinkle seed
}
`;

  const GALAXY_FRAG = `#version 300 es
precision highp float;
in float v_rad;
in float v_phase;
uniform vec3  u_pal2;
uniform vec3  u_pal3;
uniform float u_time;
uniform float u_life;
uniform float u_beat;
uniform float u_galaxy;               // intensity, 0 = off
out vec4 fragColor;
void main() {
  // Soft round sprite from the point's own coords.
  float d = length(gl_PointCoord - 0.5);
  float soft = smoothstep(0.5, 0.0, d);
  float tw = 0.5 + 0.5 * sin(u_time * 2.0 + v_phase * 30.0);
  float a = (soft * ((0.10 + u_life * 0.16) * tw + u_beat * 0.12)) * u_galaxy;
  vec3 col = mix(u_pal2, u_pal3, v_rad);   // hue ramp by radius, like the buckets
  fragColor = vec4(col, a);
}
`;

  /** @type {WebGL2RenderingContext|null} */ let gl = null;
  /** @type {HTMLCanvasElement|null} */ let cv = null;
  /** @type {WebGLProgram|null} */ let prog = null;
  let active = false;
  let octaves = 5;
  const u = {};

  /** The field's own VAO, re-bound each render so the galaxy pass can borrow GL. */
  let fieldVao = null;

  /* The galaxy point pass. Null/false until built; a build failure leaves the
     field untouched and the caller falls back to the CPU galaxy. */
  let galaxyProg = null;
  let galaxyVao = null;
  let galaxyReady = false;
  let galaxyCount = 0;
  const gu = {};

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
    fieldVao = vao;
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
      'u_bandBias', 'u_vortexBias', 'u_glowBias', 'u_stars',
    ]) {
      u[name] = gl.getUniformLocation(prog, name);
    }

    // The layer is composited by the browser over the page, so no blending
    // inside GL is needed for the FIELD — the alpha channel we write is the
    // layer opacity. The galaxy pass toggles blending on for itself.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // Optional galaxy point pass. Its own try/catch: a failure here must not
    // take the field down with it.
    buildGalaxy();

    active = true;
    return true;
  }

  /*
    GL_POINTS point-sprites render as untextured SQUARES under ANGLE (the
    Direct3D backend Electron uses on Windows) on many drivers — gl_PointCoord
    and large gl_PointSize are the historically flaky bits. On the reporting
    machine the galaxy points came out as coloured rectangles across the screen.
    So the GPU galaxy is OFF until it is reimplemented as instanced quads (which
    do not depend on point-sprite support); the CPU galaxy is the fallback and
    is what draws in the meantime. Flip this to re-enable after that rework.
  */
  const GALAXY_GPU_ENABLED = false;

  /**
   * Build the galaxy point program + VBO. Sets `galaxyReady`; on any failure it
   * stays false and the field is unaffected.
   */
  function buildGalaxy() {
    if (!GALAXY_GPU_ENABLED) return;
    try {
      const gvs = compile(gl.VERTEX_SHADER, GALAXY_VERT);
      const gfs = compile(gl.FRAGMENT_SHADER, GALAXY_FRAG);
      if (!gvs || !gfs) return;
      galaxyProg = gl.createProgram();
      gl.attachShader(galaxyProg, gvs);
      gl.attachShader(galaxyProg, gfs);
      gl.linkProgram(galaxyProg);
      if (!gl.getProgramParameter(galaxyProg, gl.LINK_STATUS)) {
        console.warn('[swirl] galaxy link failed:', gl.getProgramInfoLog(galaxyProg));
        return;
      }
      gl.deleteShader(gvs);
      gl.deleteShader(gfs);

      // Seed the phyllotaxis spiral once: point i at angle i·137.507° and
      // radius √(i/count), the same golden-angle packing the CPU used.
      const count = 260;
      const GOLDEN = Math.PI * (3 - Math.sqrt(5));
      const data = new Float32Array(count * 2);
      for (let i = 0; i < count; i += 1) {
        data[i * 2] = i * GOLDEN;
        data[i * 2 + 1] = Math.sqrt(i / count);
      }
      galaxyCount = count;

      galaxyVao = gl.createVertexArray();
      gl.bindVertexArray(galaxyVao);
      const gbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, gbuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      for (const name of ['u_res', 'u_time', 'u_life', 'u_beat', 'u_pal2', 'u_pal3', 'u_galaxy']) {
        gu[name] = gl.getUniformLocation(galaxyProg, name);
      }
      galaxyReady = true;
    } catch (err) {
      console.warn('[swirl] galaxy pass unavailable:', err && err.message);
      galaxyReady = false;
    }
  }

  /**
   * Size the drawing buffer. Rendering below CSS resolution is nearly free
   * visually here (the field is soft and blurred by design) and is the single
   * biggest performance lever this layer has.
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} [scale=0.55] drawing-buffer scale relative to CSS pixels
   */
  function resize(cssW, cssH, scale) {
    if (!active || !gl || !cv) return;
    const s = Math.max(0.3, Math.min(1, scale || 0.55));
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
    // Ribbons supply the visible structure, so extra octaves cost real
    // milliseconds for detail the contour banding hides anyway.
    octaves = q > 0.85 ? 3 : q > 0.5 ? 2 : 1;
  }

  /**
   * Draw one frame.
   * @param {object} state see STATE in the file header
   */
  function render(state) {
    if (!active || !gl) return;
    const s = state || {};

    // Make the field the current program + VAO every frame: the galaxy pass
    // below switches both, so the field can no longer assume they persist from
    // init the way it used to.
    gl.useProgram(prog);
    gl.bindVertexArray(fieldVao);

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
    const style = s.style || {};
    gl.uniform1f(u.u_bandBias, style.bandBias == null ? 1 : style.bandBias);
    gl.uniform1f(u.u_vortexBias, style.vortexBias == null ? 1 : style.vortexBias);
    gl.uniform1f(u.u_glowBias, style.glowBias == null ? 1 : style.glowBias);
    gl.uniform1f(u.u_stars, s.stars || 0);
    gl.uniform1i(u.u_octaves, octaves);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /*
      The phyllotaxis galaxy, drawn additively on top of the field. Uploads only
      the handful of uniforms that change; the 260 point positions live in the
      VBO and never move. rgb[2]/rgb[3] hold the current palette (refreshed above
      on a change), so the point colours track the song.
    */
    const galaxy = s.galaxy || 0;
    if (galaxyReady && galaxy > 0.001) {
      gl.useProgram(galaxyProg);
      gl.bindVertexArray(galaxyVao);
      gl.uniform2f(gu.u_res, cv.width, cv.height);
      gl.uniform1f(gu.u_time, (s.timeMs || 0) / 1000);
      gl.uniform1f(gu.u_life, s.life || 0);
      gl.uniform1f(gu.u_beat, s.beat || 0);
      gl.uniform3fv(gu.u_pal2, rgb[2]);
      gl.uniform3fv(gu.u_pal3, rgb[3]);
      gl.uniform1f(gu.u_galaxy, galaxy);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // additive, like the CPU 'lighter'
      gl.drawArrays(gl.POINTS, 0, galaxyCount);
      gl.disable(gl.BLEND);
    }
  }

  /** Whether the GPU galaxy pass is available (else the caller draws the CPU one). */
  function hasGalaxy() {
    return galaxyReady;
  }

  window.SwirlField = {
    init, resize, render, setQuality, hasGalaxy, isActive: () => active,
  };
})();

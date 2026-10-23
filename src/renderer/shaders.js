'use strict';

/*
  The third engine: ISF (Interactive Shader Format) shaders.

  WHY A THIRD ENGINE. MilkDrop answered "more looks" with 1755 community
  presets, but they are all one family — feedback-warp fractals from 2003 —
  and the intense, hard-edged looks people asked for (a warp tunnel, club
  strobes, a kaleidoscope, a literal 3D spectrum) are not in it. ISF is the
  open format VDMX, Resolume and the ISF editor share: a GLSL fragment shader
  with a JSON header declaring its inputs. That gives us a real format to write
  our own scenes in, and lets anyone drop more `.fs` files in later.

  WHY NOT A FRAME, UNLIKE MILKDROP. MilkDrop needs `unsafe-eval` (presets are
  equation sources compiled to JS), so it lives in its own document. ISF does
  not: a shader is GLSL handed to the GPU driver, and the vendored renderer
  (interactive-shader-format 2.8.1, ISC, vendor/isf.min.js) has no eval or
  `new Function` in it — checked in the bundle. So it renders straight into a
  canvas on this page, which saves a postMessage per frame.

  AUDIO. The renderer predates ISF's `audio`/`audioFFT` input types and throws
  on them, so `prepare()` rewrites both to plain `image` inputs, and every
  frame they are fed from the app's own analyser as small canvases — the ISF
  spec's layout: waveform 0.5-centred, FFT 0..1, one row, low bins left. On top
  of the spec, a shader may declare float inputs with these names and they are
  driven every frame (all 0..1):

    bass mid treble level   band and overall levels
    kick                    our kick detector (audio.js), already decaying
    beat                    phase within the current beat, 0 at the downbeat
    drop                    the drop flash, 1 on a drop and falling
    hue                     the app's live palette hue, so shaders follow the
                            song's colours

  Shaders without those names (the Vidvox ones) get `drive` mappings from the
  catalogue instead: "this input follows bass between its default and max".

  Exposed on window.ShaderFX.
*/

(function () {
  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {WebGLRenderingContext|null} */
  let gl = null;
  let renderer = null;
  let failed = false;

  /** name -> { file, credit, drive, intense } from shaders/index.json */
  let catalogue = [];
  let catalogueReady = null;
  /** name -> raw ISF source, fetched on first use */
  const sources = new Map();

  let currentName = null;
  /** The parsed header of the loaded shader: which inputs it declares. */
  let inputs = [];
  let audioInputs = { audio: [], audioFFT: [] };
  let loadToken = 0;

  // Audio textures, the ISF spec's shape: one row, waveform 0.5-centred, FFT
  // 0..1. Uploaded straight from the analyser's bytes as single-channel
  // LUMINANCE textures (a shader's `.r` reads the value either way). This used
  // to go through 2D canvases (putImageData, then texImage2D of the canvas),
  // and the canvas-to-texture upload was the whole cost: measured 277us per
  // frame of JS for an FFT shader against ~8us for one without audio inputs.
  const WAVE_W = 512;
  const FFT_W = 256;
  const RESERVED_UNITS = 4;
  const timeBytes = new Uint8Array(1024);
  const freqBytes = new Uint8Array(512);
  const waveRow = new Uint8Array(WAVE_W);

  /** Load shaders/index.json once. */
  function loadCatalogue() {
    if (!catalogueReady) {
      catalogueReady = fetch('shaders/index.json')
        .then((r) => r.json())
        .then((list) => { catalogue = Array.isArray(list) ? list : []; return catalogue; })
        .catch((err) => { console.warn('[shaders] catalogue failed:', err && err.message); return []; });
    }
    return catalogueReady;
  }

  /**
   * Make an ISF source loadable by this renderer: `audio`/`audioFFT` inputs
   * become `image` (see the module comment). Returns the rewritten source and
   * which inputs were audio. A header that does not parse is passed through
   * for the renderer to report.
   */
  function prepare(src) {
    const audio = { audio: [], audioFFT: [] };
    const m = /\/\*([\s\S]*?)\*\//.exec(src);
    if (!m) return { src, audio, header: {} };
    let header;
    try { header = JSON.parse(m[1]); } catch { return { src, audio, header: {} }; }
    for (const input of header.INPUTS || []) {
      if (input.TYPE === 'audio' || input.TYPE === 'audioFFT') {
        audio[input.TYPE].push(input.NAME);
        input.TYPE = 'image';
      }
    }
    const rewritten = src.slice(0, m.index) + '/*' + JSON.stringify(header, null, 1) + '*/' + src.slice(m.index + m[0].length);
    return { src: rewritten, audio, header };
  }

  function init(el) {
    if (canvas) return;
    canvas = el;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
      const ISF = window.interactiveShaderFormat;
      if (!gl || !ISF || !ISF.Renderer) throw new Error(gl ? 'ISF bundle did not load' : 'WebGL unavailable');
      // Persistent float buffers (feedback trails) need this on WebGL1.
      gl.getExtension('OES_texture_float');
      gl.getExtension('OES_texture_float_linear');
      renderer = new ISF.Renderer(gl);
      /*
        Texture units 0..RESERVED_UNITS-1 belong to our audio inputs. The
        renderer hands out a NEW unit on every texture setValue and resets the
        counter to 0 only inside draw(), where it then binds its pass buffers
        from unit 0 up — so an input set before draw() was overwritten by the
        first buffer (every FFT shader rendered black in the contact sheet),
        and an input updated every frame walked the counter past the GPU's unit
        limit. Starting its count above ours and binding ours ourselves
        (bindAudioTexture) sidesteps both without forking the library.
      */
      renderer.contextState.reset = function reset() { this.textureIndex = RESERVED_UNITS; };
      failed = false;
    } catch (err) {
      console.warn('[shaders] init failed:', err && err.message);
      failed = true;
    }
    loadCatalogue();
  }

  /**
   * Let the GPU context go — the engine is not on screen.
   *
   * Losing the context frees its memory now instead of whenever the GC gets to
   * it, but a canvas whose context was lost can never hand out another one: the
   * next init() on it got a dead context and every shader failed to load. So the
   * element is swapped for a fresh clone, which callers find again by id.
   */
  function destroy() {
    if (gl) {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
    if (canvas && canvas.parentNode) {
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
    }
    canvas = null;
    gl = null;
    renderer = null;
    currentName = null;
  }

  /**
   * Switch to a shader by catalogue name. Resolves to the name actually
   * loaded, or null. A shader that fails to compile is reported and skipped,
   * never left half-loaded: the previous one keeps drawing.
   */
  async function load(name) {
    await loadCatalogue();
    if (!renderer) return null;
    const entry = catalogue.find((c) => c.name === name) || catalogue[0];
    if (!entry) return null;
    const token = ++loadToken;
    let src = sources.get(entry.name);
    if (!src) {
      try {
        const path = entry.file.split('/').map(encodeURIComponent).join('/');
        src = await (await fetch(`shaders/${path}`)).text();
      } catch (err) {
        console.warn('[shaders] could not read', entry.file, err && err.message);
        return null;
      }
      sources.set(entry.name, src);
    }
    if (token !== loadToken || !renderer) return null; // a newer choice won
    const prepared = prepare(src);
    renderer.loadSource(prepared.src);
    if (!renderer.valid) {
      console.warn('[shaders]', entry.name, 'failed to compile:', renderer.error, renderer.errorLine);
      if (currentName) { // put the last good one back
        const prev = prepare(sources.get(currentName));
        renderer.loadSource(prev.src);
      }
      return null;
    }
    currentName = entry.name;
    inputs = prepared.header.INPUTS || [];
    audioInputs = prepared.audio;
    plan = planInputs(inputs, entry.drive || {});
    return currentName;
  }

  function resize(w, h, scale) {
    if (!canvas) return;
    const s = Math.max(0.25, Math.min(2, scale || 1));
    const bw = Math.max(1, Math.floor(w * s));
    const bh = Math.max(1, Math.floor(h * s));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
  }

  /**
   * Upload one row of bytes into image input `name` on a reserved texture
   * unit — see the RESERVED_UNITS note in init(). Never through
   * renderer.setValue, which is what leaked units. The first upload sizes the
   * texture; later ones only replace its contents (texSubImage2D), which
   * skips reallocating it every frame.
   */
  function bindAudioTexture(name, bytes, width, unit) {
    const uniform = renderer.uniforms[name];
    if (!uniform || !uniform.texture || unit >= RESERVED_UNITS) return;
    renderer.program.use();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, uniform.texture.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (uniform.sized !== width) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
      // A non-power-of-two-safe sampler: clamp, no mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      uniform.sized = width;
      renderer.setValue(`_${name}_imgSize`, [width, 1]);
      renderer.setValue(`_${name}_imgRect`, [0, 0, 1, 1]);
      renderer.setValue(`_${name}_flip`, false);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
    }
    gl.uniform1i(renderer.program.getUniformLocation(name), unit);
  }

  /** Fill the audio textures from the analyser and hand them to the shader. */
  function feedAudio() {
    if (!audioInputs.audio.length && !audioInputs.audioFFT.length) return;
    const audio = window.AudioReactive;
    if (!audio || !audio.isActive || !audio.isActive()) return;
    if (audioInputs.audio.length && audio.timeDomain && audio.timeDomain(timeBytes)) {
      const step = timeBytes.length / WAVE_W;
      for (let i = 0; i < WAVE_W; i += 1) waveRow[i] = timeBytes[Math.floor(i * step)];
      audioInputs.audio.forEach((n, i) => bindAudioTexture(n, waveRow, WAVE_W, i));
    }
    if (audioInputs.audioFFT.length && audio.frequency && audio.frequency(freqBytes)) {
      // 512 bins -> the low 256: the top half is mostly air above 11kHz.
      const fft = freqBytes.subarray(0, FFT_W);
      audioInputs.audioFFT.forEach((n, i) => bindAudioTexture(n, fft, FFT_W, audioInputs.audio.length + i));
    }
  }

  const SIGNALS = ['bass', 'mid', 'treble', 'level', 'kick', 'beat', 'drop', 'hue'];

  /**
   * How each input of the loaded shader is fed, worked out once at load
   * instead of every frame (render() used to look the catalogue entry up and
   * classify every input per frame). One of:
   *   { name, kind: 'signal' }                       a SIGNALS float
   *   { name, kind: 'drive', signal, k, lo, hi }     a catalogue drive mapping
   *   { name, kind: 'color', role }                  a palette-tinted colour
   */
  let plan = [];
  function planInputs(list, drive) {
    const out = [];
    for (const input of list) {
      if (input.TYPE === 'color' && typeof drive[input.NAME] === 'string') {
        out.push({ name: input.NAME, kind: 'color', role: drive[input.NAME] });
      } else if (input.TYPE !== 'float') {
        continue;
      } else if (SIGNALS.includes(input.NAME)) {
        out.push({ name: input.NAME, kind: 'signal' });
      } else if (drive[input.NAME]) {
        // { "speed": "bass" } or { "speed": ["kick", 3] }: default + (max - default) * signal * k
        const d = drive[input.NAME];
        const [signal, k] = Array.isArray(d) ? d : [d, 1];
        const lo = typeof input.DEFAULT === 'number' ? input.DEFAULT : (input.MIN || 0);
        const hi = typeof input.MAX === 'number' ? input.MAX : lo + 1;
        out.push({ name: input.NAME, kind: 'drive', signal, k, lo, hi });
      }
    }
    return out;
  }

  /** RGBA for a palette role: 'hue' (the accent), 'hueAlt' (its complement), 'dark'. */
  function paletteColor(role, hue) {
    const h = role === 'hueAlt' ? hue + 0.45 : hue;
    const v = role === 'dark' ? 0.06 : 1;
    const s = role === 'dark' ? 0.6 : 0.85;
    const k = (n) => {
      const x = (((h * 6 + n) % 6) + 6) % 6;
      return Math.min(1, Math.max(0, Math.abs(x - 3) - 1));
    };
    return [v * (1 - s + s * k(0)), v * (1 - s + s * k(4)), v * (1 - s + s * k(2)), 1];
  }

  /**
   * Draw one frame.
   * @param {object} sig 0..1 signals, keyed as SIGNALS above
   */
  function render(sig) {
    if (!renderer || !renderer.valid || !currentName || !canvas) return;
    feedAudio();
    for (const p of plan) {
      if (p.kind === 'signal') {
        renderer.setValue(p.name, sig[p.name] || 0);
      } else if (p.kind === 'drive') {
        renderer.setValue(p.name, p.lo + (p.hi - p.lo) * Math.min(1, (sig[p.signal] || 0) * p.k));
      } else {
        // The Vidvox generators default to greyscale; tint them from the
        // song's palette so they sit with the rest of the app.
        renderer.setValue(p.name, paletteColor(p.role, sig.hue || 0));
      }
    }
    renderer.draw(canvas);
  }

  window.ShaderFX = {
    init, destroy, load, resize, render,
    names: () => catalogue.map((c) => c.name),
    catalogue: () => catalogue,
    ready: loadCatalogue,
    current: () => currentName,
    isSupported: () => Boolean(renderer) && !failed,
    failed: () => failed,
    prepare, // exported for tests
  };
})();

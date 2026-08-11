'use strict';

/*
  The MilkDrop engine, running inside its own frame.

  Everything here exists on the far side of a CSP boundary — see the comment in
  milkdrop.html for why. The contract with the parent (milkdrop.js) is a small
  postMessage protocol, deliberately one-way for control and one-way for
  reporting, with no shared objects:

    parent → frame
      {type:'init'}                       build the visualizer, report the catalogue
      {type:'preset', name, blend, data}  load a preset (blend in seconds); `data`
                                          is the preset object for anything not in
                                          the resident pack
      {type:'resize', width, height}      CSS pixels
      {type:'render', t, l, r, elapsed}   draw one frame with this audio

    frame → parent
      {type:'ready', names:[...]}         the resident catalogue, once it is known
      {type:'loaded', name}               which preset is actually showing
      {type:'missing', name}              asked for a preset it does not hold, and
                                          was sent no data for it
      {type:'error', message}

  THE PARENT DRIVES THE CLOCK. The frame has no requestAnimationFrame of its
  own, on purpose: the overlay parks its render loops when it is hidden and
  throttles them when the compositor is struggling, and a frame animating itself
  would ignore both — burning a full-screen WebGL2 context behind a window
  nobody can see, which is exactly the bug this release fixed elsewhere.

  AUDIO ARRIVES AS NUMBERS. An AudioNode cannot cross a frame boundary, but
  Butterchurn's `render({audioLevels})` accepts externally supplied time-domain
  data, so the parent samples its existing analyser and posts the bytes. No
  second capture, no second permission prompt, and no audio graph in here at
  all.
*/

(function () {
  const canvas = document.getElementById('cv');

  let visualizer = null;
  /** The resident pack. Never added to; it is the fallback, not the catalogue. */
  let presetMap = null;
  /** Resident names only, so `names[0]` is always something that can be drawn. */
  let names = [];
  let currentName = null;

  /** Presets the parent has sent in, most-recent-last. */
  const sent = new Map();
  const SENT_CACHE_MAX = 256;

  /* Butterchurn wants a context even when it is fed audio externally: it builds
     its internal AudioProcessor against one. Nothing is ever connected to this,
     so it stays silent and idle. */
  let ctx = null;

  /** UMD interop: the bundles may expose either the namespace or its default. */
  function unwrap(mod) {
    return mod ? (mod.default || mod) : null;
  }

  function post(msg) {
    // The parent is same-origin (file://), but '*' would broadcast to any
    // embedder; targeting the origin keeps that closed.
    try {
      window.parent.postMessage(msg, '*');
    } catch { /* the parent went away — nothing to do about it from here */ }
  }

  function init() {
    if (visualizer) {
      post({ type: 'ready', names });
      return;
    }
    const bc = unwrap(window.butterchurn);
    if (!bc || !window.butterchurnPresets) {
      post({ type: 'error', message: 'butterchurn bundles did not load' });
      return;
    }

    try {
      /*
        The resident pack, which is the floor rather than the catalogue: the
        other 1654 presets are files the parent reads and sends in. Listed
        rather than discovered so a pack that fails to load is a missing set of
        names, not a silent catalogue of a different size.
      */
      presetMap = {};
      for (const global of ['butterchurnPresets']) {
        const pack = unwrap(window[global]);
        if (!pack) continue;
        const got = typeof pack.getPresets === 'function' ? pack.getPresets() : pack;
        Object.assign(presetMap, got);
      }
      names = Object.keys(presetMap).sort();

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const w = Math.max(1, Math.floor(window.innerWidth));
      const h = Math.max(1, Math.floor(window.innerHeight));
      canvas.width = w;
      canvas.height = h;
      visualizer = bc.createVisualizer(ctx, canvas, { width: w, height: h, pixelRatio: 1 });
      post({ type: 'ready', names });
    } catch (err) {
      post({ type: 'error', message: (err && err.message) || 'init failed' });
    }
  }

  /**
   * Load a preset by name, optionally with the preset object supplied.
   *
   * `data` is how everything outside the resident pack arrives: the parent
   * reads it from a file and sends it across. It is cached here so that
   * stepping back and forth through the browser does not re-read the same file
   * on every keypress, and so a re-load after a resize costs nothing.
   *
   * A name that is neither resident nor supplied is reported as missing rather
   * than silently substituted — the parent knows what it asked for and can
   * decide, where here the only options are a lie or a black screen. A name
   * that is missing *and* has no fallback still falls back, because a black
   * screen is the one outcome worth avoiding outright.
   */
  function loadPreset(name, blend, data) {
    if (!visualizer) return;

    if (data && name) {
      sent.set(name, data);
      /* Bounded, because stepping through the whole catalogue would otherwise
         hold all 8.4MB of it. Oldest first — the browser walks forwards, so the
         entry least likely to be wanted next is the one longest unused. */
      if (sent.size > SENT_CACHE_MAX) sent.delete(sent.keys().next().value);
    }

    let key = name;
    let preset = key ? (presetMap[key] || sent.get(key)) : null;
    if (!preset) {
      /* Reported rather than silently substituted: the parent knows what it
         asked for and can re-read the file. Here the only options are a lie or
         a black screen — and a black screen is the one outcome worth avoiding
         outright, so it still falls back to something drawable. */
      post({ type: 'missing', name: key || '' });
      if (names.length === 0) return;
      key = names[0];
      preset = presetMap[key];
    }

    try {
      visualizer.loadPreset(preset, Math.max(0, Number(blend) || 0));
      currentName = key;
      post({ type: 'loaded', name: key });
    } catch (err) {
      post({ type: 'error', message: (err && err.message) || 'preset failed' });
    }
  }

  function render(msg) {
    if (!visualizer) return;
    try {
      // `t`/`l`/`r` are Uint8Arrays of time-domain samples. When the parent has
      // no audio it sends nothing, and Butterchurn falls back to its own
      // (silent) analysers — presets still animate on their time-based terms.
      const audioLevels = msg.t
        ? { timeByteArray: msg.t, timeByteArrayL: msg.l || msg.t, timeByteArrayR: msg.r || msg.t }
        : undefined;
      visualizer.render({ audioLevels, elapsedTime: msg.elapsed });
    } catch (err) {
      /* One bad preset must not throw every frame forever. Step to the next
         one, which is also what the parent would do but cannot see from there. */
      post({ type: 'error', message: (err && err.message) || 'render failed' });
      const i = names.indexOf(currentName);
      if (names.length > 1) loadPreset(names[(i + 1) % names.length], 0);
    }
  }

  function resize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = w;
    canvas.height = h;
    if (!visualizer) return;
    try {
      visualizer.setRendererSize(w, h);
    } catch { /* a failed resize is not worth losing the frame over */ }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init': init(); break;
      case 'preset': loadPreset(msg.name, msg.blend, msg.data); break;
      case 'resize': resize(msg.width, msg.height); break;
      case 'render': render(msg); break;
      default: break;
    }
  });

  // The parent may have posted 'init' before this script ran; announce instead
  // of waiting to be asked.
  init();
})();

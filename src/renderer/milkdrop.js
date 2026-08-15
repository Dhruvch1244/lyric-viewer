'use strict';

/*
  MilkDrop presets, via Butterchurn — the app's second visual engine.

  WHY THIS EXISTS. On visuals alone the app had one aesthetic: the swirl field
  plus a handful of 2D layers. projectM ships thousands of MilkDrop presets and
  Plane9 ships 250 scenes, and variety is the entire axis on which visualisers
  are judged. That gap cannot be closed by writing more layers by hand.
  Butterchurn is MilkDrop 2 reimplemented in WebGL2, MIT licensed, so a few
  hundred KB buys the whole preset ecosystem.

  WHAT IT IS NOT. The swirl field stays the default and stays the identity. It
  times itself to lyric density, which no MilkDrop preset does or can, because
  they know nothing about lyrics. If this ever looks like "Butterchurn with
  subtitles" the thing that makes the app ours has been lost.

  THE CATALOGUE IS 1754, NOT 395. 0.19.0 shipped four minified preset bundles
  and took them for the catalogue. They are not: `butterchurn-presets` also
  ships the 1754 presets those bundles were built from, so 1360 looks sat in
  node_modules unexposed. They now ship as files (see scripts/vendor-presets.js)
  and are read by main on demand, so the renderer holds a list of names and the
  bytes stay on disk until something is actually shown. One resident bundle
  remains as the floor: if the files cannot be read, the engine still draws.

  WHY IT LIVES IN A FRAME. MilkDrop presets are equation *sources* that
  Butterchurn compiles into JavaScript at load time, so it needs 'unsafe-eval'.
  Granting that to the overlay page would extend it to every line that handles
  network-sourced lyrics, artwork and translations. Instead the engine runs in
  milkdrop.html, which relaxes CSP for itself alone, has no network access, and
  never sees a string that came off the network. This file is the parent-side
  proxy over that boundary; the protocol is documented in milkdrop-frame.js.

  THE ENGINES ARE MUTUALLY EXCLUSIVE. Both are full-screen WebGL2 contexts. Two
  alive at once doubles GPU cost for no benefit on an app whose dominant cost is
  already compositing, so switching engines tears the other one down.

  Exposed on window.MilkDrop.
*/

(function () {
  /** @type {HTMLIFrameElement|null} */
  let frame = null;
  /** Everything that can be shown: the frame's resident pack plus the corpus. */
  let names = [];
  /** @type {Set<string>} names the frame already holds, needing no file read. */
  let resident = new Set();
  let ready = false;
  let failed = false;
  let currentName = null;
  /** The preset asked for before the frame was ready, replayed on 'ready'. */
  let pendingPreset = null;
  /** Guards against an old, slow file read landing after a newer choice. */
  let loadToken = 0;

  /* Time-domain scratch buffer, allocated once. Butterchurn reads 1024 samples;
     posting a fresh array every frame at 60fps would be 180KB/s of garbage. */
  let timeBuf = null;

  function post(msg) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(msg, '*');
    } catch { /* frame not loaded yet; the next call will land */ }
  }

  window.addEventListener('message', (e) => {
    // Only ever from our own frame, and only the three shapes it sends.
    if (!frame || e.source !== frame.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ready') {
      resident = new Set(Array.isArray(msg.names) ? msg.names : []);
      /* The frame reports only what it holds. The catalogue is the union of
         that and the corpus main can read — merged here rather than there so
         the frame keeps no way to reach a file. */
      names = mergeCatalogue(resident, corpus);
      ready = names.length > 0;
      if (ready && pendingPreset) {
        const { name, blend } = pendingPreset;
        pendingPreset = null;
        loadPreset(name, blend);
      }
    } else if (msg.type === 'loaded') {
      currentName = msg.name;
    } else if (msg.type === 'thumb') {
      const pending = thumbWaiters.get(msg.name);
      if (pending) {
        thumbWaiters.delete(msg.name);
        clearTimeout(pending.timer);
        pending.resolve(msg.url || null);
      }
    } else if (msg.type === 'missing') {
      // The frame was asked for something it does not hold and was sent no
      // data. Either the file read failed or the name is stale (a pin from an
      // older corpus); both are worth a line, neither is worth a dialog.
      console.warn('[milkdrop] no preset named', msg.name);
    } else if (msg.type === 'error') {
      console.warn('[milkdrop]', msg.message);
    }
  });

  /** @type {string[]} names main can read from the vendored corpus. */
  let corpus = [];

  /** Union of the resident pack and the corpus, sorted, no duplicates. */
  function mergeCatalogue(residentNames, corpusNames) {
    return [...new Set([...residentNames, ...corpusNames])]
      .sort((a, b) => a.localeCompare(b));
  }

  /*
    Ask main for the corpus once. It is a list of ~1754 strings, not the
    presets themselves — the bytes stay on disk until something is shown.
  */
  if (window.player && window.player.milkdropCatalogue) {
    window.player.milkdropCatalogue().then((list) => {
      corpus = Array.isArray(list) ? list : [];
      names = mergeCatalogue(resident, corpus);
      /* `ready` deliberately not touched here. It means "the frame has a
         visualizer and can draw", which a list of names says nothing about —
         and every send path is guarded on it. */
    }).catch(() => { /* the resident pack still works */ });
  }

  /**
   * Whether the engine can run at all.
   *
   * Answered by the frame reporting a preset catalogue, not by feature
   * detection here: the failure modes that matter (no WebGL2, a bundle that did
   * not load, a preset pack that would not parse) are all only visible from
   * inside the frame.
   */
  function isSupported() {
    return ready && !failed;
  }

  /**
   * Attach to the frame element and start it up. Idempotent.
   * @param {HTMLIFrameElement} el
   * @returns {boolean} whether the engine is ready to draw *now*
   */
  function init(el) {
    if (!el) return false;
    if (frame !== el) {
      frame = el;
      ready = false;
      // The frame announces itself on load, but it may already have loaded —
      // asking again is harmless and covers both orders.
      post({ type: 'init' });
      el.addEventListener('load', () => post({ type: 'init' }), { once: true });
    }
    return ready;
  }

  /**
   * Switch preset.
   * @param {string} name
   * @param {number} [blendSeconds] cross-fade time; 0 cuts instantly
   * @returns {string|null} the name requested, or null if nothing can load it
   */
  function loadPreset(name, blendSeconds = 2.7) {
    if (!frame) return null;
    const blend = Math.max(0, blendSeconds);
    if (!ready) {
      // Asked for before the catalogue arrived — replay it on 'ready' rather
      // than dropping it, or the first look after a cold start is whatever the
      // pack happens to list first.
      pendingPreset = { name, blend };
      return name || null;
    }
    const target = name && names.includes(name) ? name : names[0];

    // Held by the frame already: no file to read, so this stays synchronous and
    // a beat-synced switch lands on the beat it was asked for.
    if (resident.has(target)) {
      loadToken += 1;
      post({ type: 'preset', name: target, blend });
      return target;
    }

    /*
      Everything else is a file. The read is a few milliseconds, but it is
      asynchronous, and a user holding the arrow key can outrun it — so a token
      drops any reply that a newer request has already overtaken. Without it the
      preset that lands is whichever read happened to finish last.
    */
    loadToken += 1;
    const token = loadToken;
    window.player.milkdropPreset(target).then((data) => {
      if (token !== loadToken || !frame) return;
      // A null reply means the corpus could not produce it. Send the name
      // anyway: the frame reports it as missing and falls back to something
      // drawable, which beats leaving the previous preset up with no word.
      post({ type: 'preset', name: target, blend, data: data || undefined });
    }).catch((err) => {
      console.warn('[milkdrop] preset read failed:', err && err.message);
    });
    return target;
  }

  /**
   * Draw one frame, feeding the engine whatever audio the app already has.
   *
   * The parent drives the clock deliberately: the overlay parks its loops when
   * hidden and throttles them when the compositor struggles, and a frame
   * animating itself would ignore both.
   *
   * @param {number} elapsedSeconds time since the last rendered frame
   */
  function render(elapsedSeconds) {
    if (!frame || !ready) return;

    let t = null;
    const audio = window.AudioReactive;
    if (audio && audio.isActive && audio.isActive() && audio.timeDomain) {
      if (!timeBuf) timeBuf = new Uint8Array(1024);
      t = audio.timeDomain(timeBuf) ? timeBuf : null;
    }

    // Sent as a plain array copy rather than transferred: a transfer detaches
    // the buffer here and it would have to be reallocated every frame.
    post({ type: 'render', t, elapsed: elapsedSeconds });
  }

  /** @param {number} w @param {number} h CSS pixels @param {boolean} [lite] Lite mode — render at a lower internal resolution */
  function resize(w, h, lite) {
    post({ type: 'resize', width: w, height: h, lite: Boolean(lite) });
  }

  /**
   * Re-attach after the audio graph changed. Nothing to rebuild here — audio
   * crosses as numbers, so a new AudioContext on this side is invisible to the
   * frame — but kept as a named no-op so callers do not have to know that.
   */
  function reconnect() { /* audio is sampled per frame; nothing is bound */ }

  /* --------------------------------------------------------------- previews */

  /** @type {Map<string, {resolve: (url: string|null) => void, timer: number}>} */
  const thumbWaiters = new Map();

  /** A preset that will not compile posts an error, not a preview. */
  const THUMB_TIMEOUT_MS = 6000;

  /**
   * Render a preview of a preset, for the browser's grid.
   *
   * The parent has to supply the preset object for anything outside the
   * resident pack — the frame cannot read files, which is the whole point of
   * the frame — so this is the same fetch the live loader does, at a different
   * destination.
   *
   * @param {string} name
   * @returns {Promise<string|null>} a JPEG data URL, or null if it cannot be drawn
   */
  function thumbnail(name) {
    if (!frame || !ready || !name) return Promise.resolve(null);
    // One request per name in flight. The grid can ask twice while scrolling.
    const already = thumbWaiters.get(name);
    if (already) return already.promise;

    const send = (data) => post({ type: 'thumb', name, data: data || undefined });

    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const timer = setTimeout(() => {
      thumbWaiters.delete(name);
      resolve(null);
    }, THUMB_TIMEOUT_MS);
    thumbWaiters.set(name, { resolve, timer, promise });

    if (resident.has(name)) send(null);
    else {
      window.player.milkdropPreset(name)
        .then((data) => send(data))
        .catch(() => send(null));
    }
    return promise;
  }

  /** Release the preview renderer. Called when the browser panel closes. */
  function endThumbnails() {
    for (const [, pending] of thumbWaiters) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    thumbWaiters.clear();
    post({ type: 'thumb-end' });
  }

  /** Take the engine off screen and let its WebGL context go. */
  function destroy() {
    if (!frame) return;
    /* Reloading the frame is what actually releases the WebGL2 context. Hiding
       the element does not: the context, its render targets and its compiled
       preset stay resident, which is the whole cost this is meant to avoid. */
    try {
      frame.contentWindow.location.reload();
    } catch { /* not loaded — nothing to release */ }
    ready = false;
    pendingPreset = currentName ? { name: currentName, blend: 0 } : null;
  }

  window.MilkDrop = {
    init, loadPreset, render, resize, reconnect, destroy,
    thumbnail, endThumbnails,
    names: () => names, isSupported, current: () => currentName,
    isResident: (name) => resident.has(name),
  };
})();

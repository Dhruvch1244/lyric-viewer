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
  /** @type {string[]} */
  let names = [];
  let ready = false;
  let failed = false;
  let currentName = null;
  /** The preset asked for before the frame was ready, replayed on 'ready'. */
  let pendingPreset = null;

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
      names = Array.isArray(msg.names) ? msg.names : [];
      ready = names.length > 0;
      if (ready && pendingPreset) {
        post({ type: 'preset', name: pendingPreset.name, blend: pendingPreset.blend });
        pendingPreset = null;
      }
    } else if (msg.type === 'loaded') {
      currentName = msg.name;
    } else if (msg.type === 'error') {
      console.warn('[milkdrop]', msg.message);
    }
  });

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
    post({ type: 'preset', name: target, blend });
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

  /** @param {number} w @param {number} h CSS pixels */
  function resize(w, h) {
    post({ type: 'resize', width: w, height: h });
  }

  /**
   * Re-attach after the audio graph changed. Nothing to rebuild here — audio
   * crosses as numbers, so a new AudioContext on this side is invisible to the
   * frame — but kept as a named no-op so callers do not have to know that.
   */
  function reconnect() { /* audio is sampled per frame; nothing is bound */ }

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
    names: () => names, isSupported, current: () => currentName,
  };
})();

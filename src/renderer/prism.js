'use strict';

/*
  Prism — the generated mode library (shaders/prism.fs).

  One shader, 576 modes: every combination of 12 forms, 6 warps and 8
  palettes. A mode is just three numbers handed to the shader as inputs
  (ShaderFX.setParams), so there is nothing to compile or download per mode
  and switching between them is instant. This file is the catalogue: stable
  ids (form-warp-palette, so a saved choice survives the list being
  extended), display names, and a colour per palette for the browser.

  Exposed on window.PrismLibrary: { MODES, count, byIndex, byId, indexOf, FORMS, WARPS, PALETTES,
  REMIX_ID, createRemix }.
*/

(function () {
  const FORMS = ['Rings', 'Spiral', 'Grid', 'Hex', 'Cells', 'Tunnel', 'Rays', 'Waves', 'Plasma', 'Flower', 'Stars', 'Weave'];
  const WARPS = ['', 'Swirl', 'Fisheye', 'Kaleido 6', 'Kaleido 8', 'Mirror'];
  const PALETTES = [
    { name: 'Song', a: '#9a6bff', b: '#28e0ec' },
    { name: 'Fire', a: '#990500', b: '#ffd933' },
    { name: 'Ice', a: '#001459', b: '#99f2ff' },
    { name: 'Neon', a: '#ff1acc', b: '#1ae6ff' },
    { name: 'Sunset', a: '#8c1a73', b: '#ff9933' },
    { name: 'Mono', a: '#2a2a2a', b: '#e6e6e6' },
    { name: 'Rainbow', a: '#ff4d4d', b: '#4db8ff' },
    { name: 'Acid', a: '#33ff4d', b: '#ff33b3' },
  ];

  /* A CSS sketch of each form in its palette for the browser cards — cheap
     gradients, not a render, so 576 cards cost nothing to draw. Same order as
     FORMS. */
  const SKETCH = [
    (a, b) => `repeating-radial-gradient(circle at 50% 50%, ${b} 0 3px, ${a} 3px 12px)`,
    (a, b) => `repeating-conic-gradient(from 0deg at 50% 50%, ${a} 0 20deg, ${b} 20deg 40deg)`,
    (a, b) => `repeating-linear-gradient(0deg, ${b} 0 2px, transparent 2px 16px), repeating-linear-gradient(90deg, ${b} 0 2px, ${a} 2px 16px)`,
    (a, b) => `repeating-linear-gradient(60deg, ${b} 0 2px, transparent 2px 14px), repeating-linear-gradient(-60deg, ${b} 0 2px, transparent 2px 14px), repeating-linear-gradient(0deg, ${b} 0 2px, ${a} 2px 14px)`,
    (a, b) => `radial-gradient(circle at 20% 30%, ${b} 0 6px, transparent 7px), radial-gradient(circle at 60% 70%, ${b} 0 5px, transparent 6px), radial-gradient(circle at 80% 25%, ${b} 0 4px, transparent 5px), ${a}`,
    (a, b) => `repeating-radial-gradient(circle at 50% 50%, ${b} 0 2px, #000 2px 6px, ${a} 6px 9px)`,
    (a, b) => `repeating-conic-gradient(from 0deg at 50% 50%, ${b} 0 4deg, #000 4deg 15deg)`,
    (a, b) => `repeating-linear-gradient(170deg, ${a} 0 8px, ${b} 8px 10px, ${a} 10px 18px)`,
    (a, b) => `radial-gradient(ellipse at 30% 40%, ${b}, transparent 60%), radial-gradient(ellipse at 70% 60%, ${a}, transparent 60%), linear-gradient(135deg, ${a}, ${b})`,
    (a, b) => `repeating-conic-gradient(from 0deg at 50% 50%, ${b} 0 30deg, ${a} 30deg 60deg), radial-gradient(circle, ${b}, ${a})`,
    (a, b) => `radial-gradient(circle at 15% 30%, ${b} 0 1.5px, transparent 2px), radial-gradient(circle at 45% 70%, ${b} 0 2px, transparent 3px), radial-gradient(circle at 75% 20%, ${b} 0 1.5px, transparent 2px), radial-gradient(circle at 85% 80%, ${b} 0 2px, transparent 3px), #05070d`,
    (a, b) => `repeating-linear-gradient(45deg, ${b} 0 3px, transparent 3px 12px), repeating-linear-gradient(-45deg, ${b} 0 3px, ${a} 3px 12px)`,
  ];

  /* Grouped by form, then warp, then palette — the order the browser shows,
     so related looks sit together. */
  const MODES = [];
  FORMS.forEach((form, f) => {
    WARPS.forEach((warp, w) => {
      PALETTES.forEach((pal, p) => {
        MODES.push({
          id: `${f}-${w}-${p}`,
          name: `${pal.name} ${form}${warp ? ` · ${warp}` : ''}`,
          form, warp: warp || 'Plain', palette: pal.name,
          swatch: SKETCH[f](pal.a, pal.b),
          params: { form: f, warp: w, palette: p },
        });
      });
    });
  });

  const index = new Map(MODES.map((m, i) => [m.id, i]));

  /* The id that means "Remix" rather than one mode: saved like any other
     choice, so it survives a restart. */
  const REMIX_ID = 'remix';

  /** Small deterministic PRNG (mulberry32), so a song remixes the same way twice. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h;
  }

  /*
    Prism Remix: one mode morphing into the next on the music's big moments.

    The next mode changes one or two of form / warp / palette, never all
    three, so each change reads as the same picture turning into something
    related, not a channel flip. The shader blends the two over `durMs`
    (prism.fs: the morph input); a drop morphs faster than a section change.
    `MIN_GAP_MS` stops a run of kicks from morphing every bar, and an idle
    timer keeps a song with no detected structure from sitting still.
  */
  const MIN_GAP_MS = 6000;
  const IDLE_MS = 16000;

  function createRemix(seedText) {
    const rand = rng(hashString(String(seedText || 'remix')));
    let from = { ...MODES[Math.floor(rand() * MODES.length)].params };
    let to = null;
    let startAt = 0;
    let durMs = 1400;
    let lastAt = -Infinity;

    function pickNext(base) {
      const next = { ...base };
      const dims = [['form', FORMS.length], ['warp', WARPS.length], ['palette', PALETTES.length]];
      const changes = rand() < 0.35 ? 2 : 1;
      const order = dims.slice().sort(() => rand() - 0.5).slice(0, changes);
      for (const [key, n] of order) {
        const step = 1 + Math.floor(rand() * (n - 1));
        next[key] = (base[key] + step) % n;
      }
      return next;
    }

    /** Settle a finished morph so `from` is what is on screen. */
    function settle(now) {
      if (to && now - startAt >= durMs) { from = to; to = null; }
    }

    return {
      /**
       * A musical moment happened. kind: 'drop' | 'section' | 'idle'.
       * Returns true when it started a morph.
       */
      trigger(now, kind) {
        settle(now);
        if (to || now - lastAt < MIN_GAP_MS) return false;
        to = pickNext(from);
        startAt = now;
        durMs = kind === 'drop' ? 900 : 1600;
        lastAt = now;
        return true;
      },
      /** Shader params for this frame (ShaderFX.setParams). */
      params(now) {
        if (lastAt === -Infinity) lastAt = now; // the idle clock starts on the first frame
        settle(now);
        if (!to && now - lastAt >= IDLE_MS) this.trigger(now, 'idle');
        const morph = to ? Math.min(1, (now - startAt) / durMs) : 0;
        const b = to || from;
        return {
          form: from.form, warp: from.warp, palette: from.palette,
          form2: b.form, warp2: b.warp, palette2: b.palette,
          morph,
        };
      },
      /** The mode currently showing (or arriving), for labels. */
      current() {
        const p = to || from;
        return MODES[(p.form * WARPS.length + p.warp) * PALETTES.length + p.palette];
      },
    };
  }

  window.PrismLibrary = {
    MODES,
    count: MODES.length,
    FORMS, WARPS, PALETTES,
    byIndex: (i) => MODES[((Math.floor(i) % MODES.length) + MODES.length) % MODES.length],
    byId: (id) => MODES[index.has(id) ? index.get(id) : 0],
    indexOf: (id) => (index.has(id) ? index.get(id) : 0),
    REMIX_ID,
    createRemix,
  };
})();

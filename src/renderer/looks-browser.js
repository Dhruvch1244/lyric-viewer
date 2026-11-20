'use strict';

/*
  ☰ Browse — the picker inside the current mode.

  ◈ steps between modes (presets.js FAMILIES); this lists what is inside the
  one on screen and makes a click the look:
    Overlay   this app's own canvas looks (Liquid, Vinyl, Stage, Studio, ...)
    Shaders   every ISF scene, or Mix — the rotation through all of them
    Prism     the 576 generated modes (prism.js)
    MilkDrop  hands over to the MilkDrop browser it always had (milkdrop-panel.js)

  Runs after renderer.js and shares its globals (els, presetId, chooseLook,
  setShaderPick, setPrismMode, shaderPick, prismModeId, closeRailPanels), the
  way milkdrop-panel.js does.
*/

(function () {
  const panel = document.getElementById('looks');
  const grid = document.getElementById('looks-grid');
  const title = document.getElementById('looks-title');
  const count = document.getElementById('looks-count');
  const search = document.getElementById('looks-search');
  const closeBtn = document.getElementById('looks-close');
  const browseBtn = document.getElementById('btn-browse');
  if (!panel || !grid || !browseBtn) return;

  let family = 'overlay';

  /*
    Previews. MilkDrop renders each preview offscreen in its own renderer
    (milkdrop-frame.js). The other three engines draw straight into the live
    canvases and have no offscreen path, and building one per engine would put
    three more renderers on the GPU that is drawing the visual. So a preview
    here is a snapshot of the real thing: once a look has been on screen for
    SETTLE_MS, the visible canvases are composited into a small JPEG and kept
    in the same local thumbnail store MilkDrop uses (presets.rs thumbs/, keyed
    `look:<family>:<key>`). Looks never shown keep their gradient until they
    are. Lyrics are DOM, not canvas, so they never appear in a preview.
  */
  const THUMB_W = 240;
  const THUMB_H = 135;
  const SETTLE_MS = 3000;
  const MAX_TRIES = 4;
  const thumbs = new Map();   // thumb key -> data URL
  const tries = new Map();    // thumb key -> blank captures so far
  const thumbKey = (fam, key) => `look:${fam}:${key}`;

  function currentThumbKey() {
    const fam = window.VisualPresets && window.VisualPresets.familyOf(presetId);
    if (fam === 'overlay') return thumbKey(fam, presetId);
    if (fam === 'shaders') return thumbKey(fam, shaderPick || '__mix');
    if (fam === 'prism') return thumbKey(fam, prismModeId);
    return null; // MilkDrop has its own previews
  }

  /** Composite the visible engine canvases, cover-cropped. Null if blank. */
  function snapshot() {
    const out = document.createElement('canvas');
    out.width = THUMB_W;
    out.height = THUMB_H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    let drew = false;
    for (const id of ['swirl', 'shaderfx', 'backdrop']) {
      const el = document.getElementById(id);
      if (!el || el.hidden || !el.width || !el.height) continue;
      const cs = getComputedStyle(el);
      const alpha = Number(cs.opacity);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !(alpha > 0)) continue;
      const scale = Math.max(THUMB_W / el.width, THUMB_H / el.height);
      const sw = THUMB_W / scale;
      const sh = THUMB_H / scale;
      try {
        ctx.globalAlpha = alpha;
        ctx.drawImage(el, (el.width - sw) / 2, (el.height - sh) / 2, sw, sh, 0, 0, THUMB_W, THUMB_H);
        drew = true;
      } catch { /* a tainted or lost canvas: skip it */ }
    }
    ctx.globalAlpha = 1;
    if (!drew) return null;
    try {
      // Blank check: a look still fading in, or a paused loop, is flat.
      const px = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
      let lo = 255; let hi = 0;
      for (let i = 0; i < px.length; i += 4 * 37) {
        const l = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
      }
      if (hi - lo < 10) return null;
      return out.toDataURL('image/jpeg', 0.8);
    } catch { return null; }
  }

  function paintSwatch(sw, url) {
    sw.style.background = `#000 center / cover no-repeat url("${url}")`;
  }

  /** Swap stored previews into the built cards. */
  function loadThumbs() {
    if (!built || !window.player || !window.player.milkdropThumbs) return;
    const fam = built.family;
    const want = built.cards.map((c) => thumbKey(fam, c.key)).filter((k) => !thumbs.has(k));
    const apply = () => {
      if (!built || built.family !== fam) return;
      for (const c of built.cards) {
        const url = thumbs.get(thumbKey(fam, c.key));
        if (url) paintSwatch(c.sw, url);
      }
    };
    if (!want.length) { apply(); return; }
    window.player.milkdropThumbs(want).then((got) => {
      for (const [k, url] of Object.entries(got || {})) thumbs.set(k, url);
      apply();
    }).catch(() => {});
  }

  /*
    Capture loop: cheap (a key comparison) except on the one tick a settled,
    unpreviewed look is captured. Each look is asked for from the store once
    before it is captured, so a preview from an earlier session isn't redone.
  */
  let watchKey = null;
  let watchSince = 0;
  const asked = new Set();
  setInterval(() => {
    if (document.hidden) return;
    const k = currentThumbKey();
    const now = performance.now();
    if (k !== watchKey) { watchKey = k; watchSince = now; return; }
    if (!k || thumbs.has(k) || now - watchSince < SETTLE_MS) return;
    if ((tries.get(k) || 0) >= MAX_TRIES) return;
    if (!asked.has(k) && window.player && window.player.milkdropThumbs) {
      asked.add(k);
      window.player.milkdropThumbs([k]).then((got) => {
        if (got && got[k]) thumbs.set(k, got[k]);
      }).catch(() => {});
      return;
    }
    // After the engine's own draw in the next frame, so a WebGL canvas
    // without preserveDrawingBuffer still holds its pixels.
    requestAnimationFrame(() => {
      if (currentThumbKey() !== k) return;
      const url = snapshot();
      if (!url) { tries.set(k, (tries.get(k) || 0) + 1); watchSince = performance.now(); return; }
      thumbs.set(k, url);
      if (window.player.milkdropThumbSave) window.player.milkdropThumbSave(k, url).catch(() => {});
      if (built) {
        const [fam, ...rest] = k.slice(5).split(':');
        const key = rest.join(':');
        if (built.family === fam) {
          const c = built.cards.find((x) => x.key === key);
          if (c) paintSwatch(c.sw, url);
        }
      }
    });
  }, 1000);

  /** A gradient for looks with no picture of their own, varied by position. */
  const gradientFor = (i) => {
    const h = (i * 47) % 360;
    return `linear-gradient(135deg, hsl(${h} 80% 45%), hsl(${(h + 70) % 360} 85% 60%))`;
  };

  /** What this mode lists: { key, name, meta, swatch, selected, pick } */
  function itemsFor(fam) {
    const VP = window.VisualPresets;
    if (fam === 'overlay') {
      return VP.looksIn('overlay').map((p, i) => ({
        key: p.id, name: p.name, meta: 'Overlay', swatch: gradientFor(i),
        selected: presetId === p.id,
        pick: () => chooseLook(p.id),
      }));
    }
    if (fam === 'shaders') {
      const list = (window.ShaderFX ? window.ShaderFX.catalogue() : []).filter((c) => !c.library);
      return [{
        key: '__mix', name: 'Mix', meta: `All ${list.length}, changing with the music`, swatch: 'linear-gradient(135deg, #ff1acc, #28e0ec, #ffd933)',
        selected: presetId === 'shaders' && !shaderPick,
        pick: () => { setShaderPick(null); chooseLook('shaders'); },
      }].concat(list.map((c, i) => ({
        key: c.name, name: c.name, meta: c.credit || '', swatch: gradientFor(i + 3),
        selected: presetId === 'shaders' && shaderPick === c.name,
        pick: () => { setShaderPick(c.name); chooseLook('shaders'); },
      })));
    }
    if (fam === 'prism' && window.PrismLibrary) {
      const L = window.PrismLibrary;
      // Remix first, like Mix in Shaders: the way to have all of them.
      return [{
        key: L.REMIX_ID, name: 'Remix', meta: 'Morphs into a new mode on every drop and section',
        swatch: 'conic-gradient(from 0deg, #ff4d4d, #ffe14d, #4dff88, #4db8ff, #c44dff, #ff4d4d)',
        selected: presetId === 'prism' && prismModeId === L.REMIX_ID,
        pick: () => { setPrismMode(L.REMIX_ID); chooseLook('prism'); },
      }].concat(L.MODES.map((m) => ({
        key: m.id, name: m.name, meta: `${m.form} · ${m.warp}`, swatch: m.swatch,
        selected: presetId === 'prism' && prismModeId === m.id,
        pick: () => { setPrismMode(m.id); chooseLook('prism'); },
      })));
    }
    return [];
  }

  /*
    Cards are built once per mode and then filtered by toggling `hidden`, not
    rebuilt per keystroke. Measured on the 576 Prism cards: rebuilding cost
    ~3ms a keystroke and ~17ms to clear the search or reopen; filtering in
    place is a fraction of that. The cards are kept across opens and only
    their selection is refreshed.
  */
  let built = null; // { family, size, cards: [{ card, text, key }] }

  function build() {
    const fam = window.VisualPresets.FAMILIES.find((f) => f.id === family);
    const items = itemsFor(family);
    const frag = document.createDocumentFragment();
    const cards = items.map((it) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'looks__card';
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(it.selected));
      const sw = document.createElement('span');
      sw.className = 'looks__swatch';
      sw.style.background = it.swatch;
      const name = document.createElement('span');
      name.className = 'looks__name';
      name.textContent = it.name;
      const meta = document.createElement('span');
      meta.className = 'looks__meta';
      meta.textContent = it.meta;
      card.append(sw, name, meta);
      card.addEventListener('click', () => {
        it.pick();
        for (const c of grid.querySelectorAll('[aria-selected="true"]')) c.setAttribute('aria-selected', 'false');
        card.setAttribute('aria-selected', 'true');
        setStatus(`${fam ? fam.name : ''} — ${it.name}`);
      });
      frag.appendChild(card);
      return { card, sw, key: it.key, text: `${it.name} ${it.meta}`.toLowerCase() };
    });
    grid.textContent = '';
    grid.appendChild(frag);
    built = { family, size: items.length, cards };
    loadThumbs();
  }

  /** Mark the current choice; rebuild only if the list itself changed. */
  function refresh() {
    const items = itemsFor(family);
    if (!built || built.family !== family || built.size !== items.length) { build(); return; }
    for (let i = 0; i < items.length; i += 1) {
      const want = String(items[i].selected);
      const card = built.cards[i].card;
      if (card.getAttribute('aria-selected') !== want) card.setAttribute('aria-selected', want);
    }
  }

  function render() {
    const fam = window.VisualPresets.FAMILIES.find((f) => f.id === family);
    if (!built || built.family !== family) build();
    const q = (search.value || '').trim().toLowerCase();
    let shown = 0;
    for (const c of built.cards) {
      const hide = Boolean(q) && !c.text.includes(q);
      if (c.card.hidden !== hide) c.card.hidden = hide;
      if (!hide) shown += 1;
    }
    title.textContent = fam ? fam.name : 'Looks';
    count.textContent = `${shown} ${family === 'prism' ? 'modes' : family === 'shaders' ? 'shaders' : 'looks'}${q ? ' match' : ''}`;
  }

  function open() {
    family = window.VisualPresets.familyOf(presetId);
    if (family === 'milkdrop') {
      close();
      if (els.mdBtn) els.mdBtn.click(); // the MilkDrop browser, as before
      return;
    }
    if (typeof closeRailPanels === 'function') closeRailPanels(panel);
    search.value = '';
    panel.hidden = false;
    browseBtn.setAttribute('aria-pressed', 'true');
    document.body.classList.add('show-cursor');
    // The shader catalogue loads on first use; list it once it is in.
    if (family === 'shaders' && window.ShaderFX) window.ShaderFX.ready().then(() => { refresh(); render(); });
    refresh();
    render();
    const sel = grid.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'center' });
    search.focus();
  }

  function close() {
    panel.hidden = true;
    browseBtn.setAttribute('aria-pressed', 'false');
  }

  browseBtn.addEventListener('click', () => (panel.hidden ? open() : close()));
  if (closeBtn) closeBtn.addEventListener('click', close);
  search.addEventListener('input', render);
  // ◈ changes the mode under an open browser: follow it.
  if (els.presetBtn) els.presetBtn.addEventListener('click', () => { if (!panel.hidden) open(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { close(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'm' || e.key === 'M') browseBtn.click();
  });

  window.LooksBrowser = { open, close, isOpen: () => !panel.hidden };
})();

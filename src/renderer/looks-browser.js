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
      return window.PrismLibrary.MODES.map((m) => ({
        key: m.id, name: m.name, meta: `${m.form} · ${m.warp}`, swatch: m.swatch,
        selected: presetId === 'prism' && prismModeId === m.id,
        pick: () => { setPrismMode(m.id); chooseLook('prism'); },
      }));
    }
    return [];
  }

  function render() {
    const VP = window.VisualPresets;
    const fam = VP.FAMILIES.find((f) => f.id === family);
    const q = (search.value || '').trim().toLowerCase();
    const items = itemsFor(family).filter((it) => !q || `${it.name} ${it.meta}`.toLowerCase().includes(q));
    title.textContent = fam ? fam.name : 'Looks';
    count.textContent = `${items.length} ${family === 'prism' ? 'modes' : family === 'shaders' ? 'shaders' : 'looks'}${q ? ' match' : ''}`;
    const frag = document.createDocumentFragment();
    for (const it of items) {
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
    }
    grid.textContent = '';
    grid.appendChild(frag);
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
    if (family === 'shaders' && window.ShaderFX) window.ShaderFX.ready().then(render);
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
    if (e.key === 'b' || e.key === 'B') browseBtn.click();
  });

  window.LooksBrowser = { open, close, isOpen: () => !panel.hidden };
})();

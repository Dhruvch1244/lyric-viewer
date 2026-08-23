'use strict';

/*
  MilkDrop preset browser — pulled out of renderer.js, which had grown into a
  single 7,365-line file. Loaded AFTER renderer.js (see index.html) rather
  than wrapped as a window.Namespace module like wordtiming.js/mood.js: this
  code is pure UI glue over renderer.js's own DOM refs (`els`) and playback
  state (`currentTrack`, `milkdropChosen`, `trackLookKey`, ...), not a
  reusable unit with a real API, and it isn't unit-tested — same shape as the
  other panels still living in renderer.js. Every name here stays a plain
  top-level binding in the shared script scope classic (non-module) <script>
  tags all share in one document, so nothing elsewhere in renderer.js needed
  to change to call into this file, and nothing here needed to change to call
  back into renderer.js.

  0.19.0 shipped 395 presets and no way to reach them: two named entry points,
  and everything else only by waiting for a drop on a 42-second cooldown. A
  catalogue you cannot open is not a catalogue.

  0.20.0 gave it a search box and a list of names. That was better and still
  wrong, because a preset is a picture and its name is not: these are titles
  written by strangers in 2003 — `$$$ Royal - Mashup (160)`, `!!!---flexi +
  amandio c - organic12-3d-2` — and no amount of searching them tells you what
  any of them looks like. Choosing meant loading one and looking, 1754 times.

  So 0.21.0 shows the pictures. Three things follow from that, and all three are
  what actually make a catalogue this size usable:

    - **Previews.** Rendered by the engine frame at 192x108 with synthetic
      audio, cached to disk, and only ever generated for cards you have actually
      scrolled to. A background pass over all 1754 would cost minutes of GPU
      time for previews of presets nobody asked to see.

    - **Liking and hiding.** With 100 presets a search box is enough. With 1754
      you need to keep the handful you love and never see the ones you hate
      again — and a hidden preset is excluded from the dice and the beat-synced
      cycle too, or hiding it would mean nothing.

    - **Stepping.** The arrow keys move through the filtered set and load each
      one instantly, so browsing is watching rather than reading. This is the
      part the old list could not do at all.

  Pinning uses the same per-track shape as the visual-look override, so a
  preset you liked on a song comes back next play. It is stored separately from
  `visualLooks` because it answers a different question — that one picks the
  LOOK (which may not even be a MilkDrop look), this one picks the preset
  within it.
*/

/** How many cards to render at once; more arrive as the grid is scrolled. */
const MDP_PAGE = 60;

/** Storage keys. Sets rather than maps: membership is the whole question. */
const MDP_FAV_KEY = 'milkdropFavourites';
const MDP_HIDDEN_KEY = 'milkdropHidden';
const MDP_SEEN_KEY = 'milkdropSeen';

/** @param {string} key @returns {Set<string>} */
function readNameSet(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

/** @param {string} key @param {Set<string>} set */
function writeNameSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

let mdpFavourites = readNameSet(MDP_FAV_KEY);
let mdpHidden = readNameSet(MDP_HIDDEN_KEY);
let mdpSeen = readNameSet(MDP_SEEN_KEY);

/** 'all' | 'fav' | 'unseen' — which slice of the catalogue the grid shows. */
let mdpFilter = 'all';
/** How many of the current match set are rendered. */
let mdpShown = MDP_PAGE;
/** The filtered names as last rendered; the arrow keys step through this. */
let mdpMatches = [];
/** Previews already in hand this session, so re-filtering repaints instantly. */
const mdpThumbCache = new Map();
/** Names queued for rendering, oldest first, one at a time. */
const mdpThumbQueue = [];
let mdpThumbBusy = false;
/** @type {IntersectionObserver|null} watches cards and the "more" sentinel */
let mdpObserver = null;

/**
 * Record that a preset has actually been watched.
 *
 * Drives the "Unseen" filter, which is the only practical way to work through
 * a catalogue of 1754 over many sessions — a search box cannot tell you where
 * you got to.
 *
 * @param {string} name
 */
function markMilkdropSeen(name) {
  if (!name || mdpSeen.has(name)) return;
  mdpSeen.add(name);
  writeNameSet(MDP_SEEN_KEY, mdpSeen);
}

/**
 * Names the automatic paths are allowed to choose from.
 *
 * Hiding a preset has to mean it stops appearing, or it is a bookmark rather
 * than a veto — the beat-synced cycle and the dice are where an unwanted preset
 * actually shows up.
 *
 * @returns {string[]}
 */
function milkdropAllowed() {
  const all = window.MilkDrop.names();
  if (mdpHidden.size === 0) return all;
  const kept = all.filter((n) => !mdpHidden.has(n));
  // Never hand back nothing: someone who hides everything gets the catalogue
  // back rather than a frozen visual.
  return kept.length > 0 ? kept : all;
}

/*
  A hand-picked shortlist of presets that reliably look good.

  The catalogue is 1754 presets contributed over twenty years, and a large
  share of them are dim, broken on this renderer, or just ugly — so opening
  MilkDrop on a *random* one, or cycling the whole set on the beat, lands on a
  dud more often than not. That is what "the default MilkDrop sucks" was.

  These are verified present in the shipped corpus (see the curated check in
  scripts) and chosen for being bright, legible under lyrics, and stable. They
  are the pool the automatic paths draw from until the user has liked some of
  their own; the browser still offers all 1754.
*/
const MILKDROP_CURATED = [
  'Cope - Cartune (extrusion machine) [fixed]',
  'Geiss - Artifact Plasma',
  'Flexi - Julia fractal',
  'Rovastar - VooV′s Organic Light',
  'Flexi + fiShbRaiN - operation fatcap II',
  'Aderrasi - Kevlar Tunnel',
  'Geiss - Artifact Plasma 2',
  '$$$ Royal - Mashup (169)',
  'martin - mandelbox explorer - high speed demo version',
  'Flexi - alien fish pond',
];

/**
 * The pool the dice and the beat-synced cycle draw from.
 *
 * Favourites first, once there are enough to cycle. Otherwise the curated
 * shortlist (minus anything hidden), so the automatic look is a good one rather
 * than a roll of the 1754-sided die. Falls through to the whole allowed set
 * only if the curated names somehow are not in this corpus.
 *
 * @returns {string[]}
 */
function milkdropCyclePool() {
  const allowed = milkdropAllowed();
  const liked = allowed.filter((n) => mdpFavourites.has(n));
  if (liked.length > 1) return liked;

  const allowedSet = new Set(allowed);
  const curated = MILKDROP_CURATED.filter((n) => allowedSet.has(n));
  return curated.length > 0 ? curated : allowed;
}

/**
 * The preset to open MilkDrop on when nothing is pinned or chosen.
 *
 * Random, not `pool[0]`. It used to take the first entry, so every session
 * without a pin opened on the identical look — out of 1754 presets, which
 * rather defeats the point of having them. The pool is already the right set
 * to draw from: liked presets when there are any, the curated list otherwise
 * (see `milkdropCyclePool`), so a random pick here is a random pick from
 * *your* presets rather than from everything.
 *
 * The caller is responsible for asking once and remembering the answer —
 * `milkdropTargetFor` runs every frame, so a fresh random on each call would
 * change the preset sixty times a second. It records the result as the
 * current intent, the same way the drop-triggered cycle does.
 */
function milkdropDefault() {
  const pool = milkdropCyclePool();
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Per-track MilkDrop preset pins, keyed like every other per-track override. */
function readMilkdropPins() {
  try { return JSON.parse(localStorage.getItem('milkdropPins') || '{}') || {}; }
  catch { return {}; }
}

function writeMilkdropPin(name) {
  if (!currentTrack) return;
  const pins = readMilkdropPins();
  const key = trackLookKey(currentTrack);
  if (name) pins[key] = name;
  else delete pins[key];
  try { localStorage.setItem('milkdropPins', JSON.stringify(pins)); } catch { /* ignore */ }
}

/** The pinned preset for the current track, if any. */
function pinnedMilkdrop() {
  if (!currentTrack) return null;
  return readMilkdropPins()[trackLookKey(currentTrack)] || null;
}

function closeMilkdropPanel() {
  if (els.mdPanel) els.mdPanel.hidden = true;
  if (els.mdBtn) els.mdBtn.setAttribute('aria-pressed', 'false');
  if (mdpObserver) { mdpObserver.disconnect(); mdpObserver = null; }
  // Stop the preview pipeline and let its WebGL context go. Nothing queued is
  // worth holding a second context open for once the panel is shut.
  mdpThumbQueue.length = 0;
  if (window.MilkDrop.endThumbnails) window.MilkDrop.endThumbnails();
}

function openMilkdropPanel() {
  if (!els.mdPanel || !window.MilkDrop) return;
  els.mdPanel.hidden = false;
  document.body.classList.add('show-cursor');
  els.mdBtn.setAttribute('aria-pressed', 'true');
  mdpShown = MDP_PAGE;
  renderMilkdropList();
  if (els.mdSearch) els.mdSearch.focus();
}

/**
 * Switch to a preset from the browser.
 *
 * Recorded as the session choice, not merely loaded — `applyEngine` owns what
 * should be showing and would revert a bare load on the next frame. Cut rather
 * than blend: someone browsing wants the preset they picked, not a three-second
 * cross-fade into it.
 *
 * @param {string} name
 */
function chooseMilkdrop(name) {
  milkdropChosen = name;
  milkdropName = window.MilkDrop.loadPreset(name, 0);
  lastMilkdropSwitchAt = performance.now();
  markMilkdropSeen(name);
  for (const el of els.mdList.querySelectorAll('[aria-current="true"]')) {
    el.removeAttribute('aria-current');
  }
  const card = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"]`);
  if (card) card.setAttribute('aria-current', 'true');
  updateMilkdropPinChip();
}

/** Preset names contain quotes and brackets; a selector needs them escaped. */
function cssEscape(value) {
  return window.CSS && window.CSS.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** The names matching the current search and filter. */
function milkdropMatches() {
  const all = window.MilkDrop.names();
  const q = ((els.mdSearch && els.mdSearch.value) || '').trim().toLowerCase();
  return all.filter((name) => {
    if (q && !name.toLowerCase().includes(q)) return false;
    if (mdpFilter === 'fav') return mdpFavourites.has(name);
    // Hidden presets stay reachable through search and the ♥ filter — hiding
    // is "stop showing me this", not "delete it", and un-hiding needs a route.
    if (mdpHidden.has(name) && !q) return false;
    if (mdpFilter === 'unseen') return !mdpSeen.has(name);
    return true;
  });
}

/** Redraw the grid against the current search, filter and page size. */
function renderMilkdropList() {
  if (!els.mdList) return;
  mdpMatches = milkdropMatches();
  const shown = mdpMatches.slice(0, mdpShown);
  const current = window.MilkDrop.current();

  const total = mdpMatches.length;
  renderMilkdropStatus();

  const cards = shown.map((name) => buildMilkdropCard(name, name === current));

  if (shown.length < total) {
    const more = document.createElement('p');
    more.className = 'mdp__more';
    more.dataset.more = '1';
    more.textContent = `${total - shown.length} more…`;
    cards.push(more);
  }
  els.mdList.replaceChildren(...cards);
  observeMilkdropCards();
}

/**
 * One card: a picture, a name, and the two marks.
 * @param {string} name
 * @param {boolean} isCurrent
 */
function buildMilkdropCard(name, isCurrent) {
  /*
    A div, not a button. As a <button> the card measured 2px tall around a
    90px image: Chromium lays a button's children out in a special content box
    that did not take its height from an aspect-ratio-sized child, so every
    card collapsed and the grid's pager then ran away filling a viewport that
    could never be filled. The role and tabindex keep it a button to anything
    that cares; only the layout changes.
  */
  const card = document.createElement('div');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.className = 'mdp__card';
  card.dataset.preset = name;
  card.title = name;
  if (mdpFavourites.has(name)) card.classList.add('is-fav');
  if (isCurrent) card.setAttribute('aria-current', 'true');

  const shot = document.createElement('img');
  shot.className = 'mdp__shot';
  shot.alt = '';
  const cached = mdpThumbCache.get(name);
  if (cached) shot.src = cached;
  card.appendChild(shot);

  const label = document.createElement('span');
  label.className = 'mdp__name';
  label.textContent = name;
  card.appendChild(label);

  const marks = document.createElement('span');
  marks.className = 'mdp__marks';

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'mdp__mark';
  fav.textContent = '♥';
  fav.title = 'Like this preset (F)';
  fav.setAttribute('aria-pressed', String(mdpFavourites.has(name)));
  fav.addEventListener('click', (e) => { e.stopPropagation(); toggleMilkdropFavourite(name); });
  marks.appendChild(fav);

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'mdp__mark';
  hide.textContent = '🚫';
  hide.title = 'Never show this one again (X)';
  hide.setAttribute('aria-pressed', String(mdpHidden.has(name)));
  hide.addEventListener('click', (e) => { e.stopPropagation(); toggleMilkdropHidden(name); });
  marks.appendChild(hide);

  card.appendChild(marks);
  card.addEventListener('click', () => chooseMilkdrop(name));
  // A div with role=button is not activated by the keyboard for free.
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); chooseMilkdrop(name); }
  });
  return card;
}

/** @param {string} name */
function toggleMilkdropFavourite(name) {
  if (mdpFavourites.has(name)) mdpFavourites.delete(name);
  else {
    mdpFavourites.add(name);
    // Liking something you have hidden is a change of mind, not a conflict.
    mdpHidden.delete(name);
    writeNameSet(MDP_HIDDEN_KEY, mdpHidden);
  }
  writeNameSet(MDP_FAV_KEY, mdpFavourites);
  renderMilkdropList();
}

/** @param {string} name */
function toggleMilkdropHidden(name) {
  if (mdpHidden.has(name)) mdpHidden.delete(name);
  else {
    mdpHidden.add(name);
    mdpFavourites.delete(name);
    writeNameSet(MDP_FAV_KEY, mdpFavourites);
    /* Hiding the preset that is on screen should take it off screen, or the
       veto does not appear to have worked. */
    if (window.MilkDrop.current() === name) {
      const allowed = milkdropAllowed();
      if (allowed.length) chooseMilkdrop(allowed[Math.floor(Math.random() * allowed.length)]);
    }
  }
  writeNameSet(MDP_HIDDEN_KEY, mdpHidden);
  renderMilkdropList();
}

/* ------------------------------------------------------ preview generation */

/**
 * Watch the cards on screen. Previews are generated for what is visible and
 * nothing else: a background pass over 1754 presets is minutes of GPU time
 * spent on images nobody asked to see, and it competes with the visuals.
 */
function observeMilkdropCards() {
  if (mdpObserver) mdpObserver.disconnect();
  if (!els.mdList) return;

  mdpObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target.dataset.more) {
        /*
          Extend only if the grid can actually be scrolled, or if it is not yet
          full. A collapsed layout leaves this sentinel permanently on screen,
          and without the guard the pager walks the whole catalogue into the DOM
          before anyone has touched the scrollbar — which is precisely what
          happened when the card height measured 2px.
        */
        const grid = els.mdList;
        const scrollable = grid.scrollHeight > grid.clientHeight + 4;
        if (!scrollable && mdpShown > MDP_PAGE * 3) return;
        mdpShown += MDP_PAGE;
        renderMilkdropList();
        return;
      }
      const name = entry.target.dataset.preset;
      if (name && !mdpThumbCache.has(name)) queueMilkdropThumb(name);
    }
  }, { root: els.mdList, rootMargin: '160px' });

  for (const child of els.mdList.children) mdpObserver.observe(child);
  loadCachedThumbs();
}

/** Paint whatever previews are already on disk, in one round trip. */
function loadCachedThumbs() {
  const wanted = [...els.mdList.querySelectorAll('[data-preset]')]
    .map((el) => el.dataset.preset)
    .filter((name) => !mdpThumbCache.has(name));
  if (wanted.length === 0 || !window.player.milkdropThumbs) return;

  window.player.milkdropThumbs(wanted).then((found) => {
    let painted = 0;
    for (const [name, url] of Object.entries(found || {})) {
      mdpThumbCache.set(name, url);
      const img = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"] .mdp__shot`);
      if (img) { img.src = url; painted += 1; }
    }
    if (painted) renderMilkdropStatus();
  }).catch(() => { /* previews are a nicety; the names still work */ });
}

/**
 * Just the count line.
 *
 * Separate from the grid because previews arrive one at a time: rebuilding
 * 60 cards to update a number would replace the card under the cursor sixty
 * times while someone is trying to click it.
 */
function renderMilkdropStatus() {
  if (!els.mdStatus) return;
  const total = mdpMatches.length;
  if (total === 0) {
    els.mdStatus.textContent = mdpFilter === 'fav'
      ? 'nothing liked yet — press ♥ on one you want to keep'
      : 'nothing matches';
    return;
  }
  const shown = mdpMatches.slice(0, mdpShown);
  const pending = shown.filter((n) => !mdpThumbCache.has(n)).length;
  els.mdStatus.textContent = `${total} preset${total === 1 ? '' : 's'}`
    + (total > shown.length ? ` · showing ${shown.length}` : '')
    + (mdpHidden.size ? ` · ${mdpHidden.size} hidden` : '')
    + (pending ? ` · ${pending} preview${pending === 1 ? '' : 's'} to render` : '');
}

/** @param {string} name */
function queueMilkdropThumb(name) {
  if (mdpThumbQueue.includes(name)) return;
  mdpThumbQueue.push(name);
  drainMilkdropThumbs();
}

/**
 * Render queued previews one at a time.
 *
 * Serialised on purpose. Each one is a preset compile plus 34 frames on the
 * same GPU that is drawing the live visual, and firing a dozen at once is how
 * the panel would stutter the thing it is a browser for.
 */
function drainMilkdropThumbs() {
  if (mdpThumbBusy || mdpThumbQueue.length === 0) return;
  if (!els.mdPanel || els.mdPanel.hidden) { mdpThumbQueue.length = 0; return; }

  const name = mdpThumbQueue.shift();
  if (mdpThumbCache.has(name)) { drainMilkdropThumbs(); return; }

  mdpThumbBusy = true;
  window.MilkDrop.thumbnail(name).then((url) => {
    if (url) {
      mdpThumbCache.set(name, url);
      const img = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"] .mdp__shot`);
      if (img) img.src = url;
      if (window.player.milkdropThumbSave) {
        window.player.milkdropThumbSave(name, url).catch(() => { /* cache only */ });
      }
      renderMilkdropStatus();
    }
  }).finally(() => {
    mdpThumbBusy = false;
    /* One frame between previews so the live visual and the panel both get a
       turn. Without it a long queue holds the main thread for seconds. */
    requestAnimationFrame(() => drainMilkdropThumbs());
  });
}

/** The pin chip reflects whether the preset on screen is the pinned one. */
function updateMilkdropPinChip() {
  if (!els.mdPin) return;
  const pinned = pinnedMilkdrop();
  const on = Boolean(pinned && pinned === window.MilkDrop.current());
  els.mdPin.setAttribute('aria-pressed', String(on));
  els.mdPin.title = on
    ? 'Pinned to this song — click to unpin'
    : 'Keep this preset for this song';
}

if (els.mdBtn) {
  els.mdBtn.addEventListener('click', () => {
    if (els.mdPanel && els.mdPanel.hidden) openMilkdropPanel();
    else closeMilkdropPanel();
  });
}
if (els.mdClose) els.mdClose.addEventListener('click', closeMilkdropPanel);
if (els.mdSearch) {
  els.mdSearch.addEventListener('input', () => {
    mdpShown = MDP_PAGE;
    renderMilkdropList();
  });
}

for (const chip of document.querySelectorAll('.mdp__filter')) {
  chip.addEventListener('click', () => {
    mdpFilter = chip.dataset.filter;
    for (const other of document.querySelectorAll('.mdp__filter')) {
      other.setAttribute('aria-pressed', String(other === chip));
    }
    mdpShown = MDP_PAGE;
    renderMilkdropList();
  });
}

if (els.mdRandom) {
  els.mdRandom.addEventListener('click', () => {
    const allowed = milkdropAllowed();
    if (allowed.length === 0) return;
    chooseMilkdrop(allowed[Math.floor(Math.random() * allowed.length)]);
  });
}

/*
  Step through the filtered set with the arrow keys, loading each one as it is
  reached. This is the part a list of names could not do: browsing 1754 presets
  is watching, not reading, and a preview is a still of something that moves.

  Scoped to the panel and skipped while the search box has focus, where the
  left/right keys belong to the text cursor.
*/
if (els.mdPanel) {
  /* On the document rather than the panel: re-rendering the grid replaces every
     card, which drops focus to the body — and a key handler bound to the panel
     would then stop firing exactly when someone is stepping through it. */
  document.addEventListener('keydown', (e) => {
    if (els.mdPanel.hidden) return;

    /*
      The panel focuses its search box on open, which is right — narrowing 1754
      presets by typing is the first thing anyone does. But it made the arrow
      keys belong to the text caret, and stepping through previews is the whole
      point of the rebuild, so it was dead on arrival: measured in the harness,
      the arrow key moved nothing.

      The rule that keeps both: arrows always step, and the letter keys act only
      when there is no query being typed. Nobody navigates a caret through a
      search box they can retype in a second; everybody expects `f` in a focused
      text field to write an f.
    */
    const query = ((els.mdSearch && els.mdSearch.value) || '').length > 0;
    const typing = document.activeElement === els.mdSearch && query;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];

    if (step) {
      if (mdpMatches.length === 0) return;
      e.preventDefault();
      const at = mdpMatches.indexOf(window.MilkDrop.current());
      const next = (at + step + mdpMatches.length) % mdpMatches.length;
      const name = mdpMatches[next];
      // Extend the page if stepping walked past what is rendered, so the
      // selected card can be scrolled to and marked.
      if (next >= mdpShown) { mdpShown = next + MDP_PAGE; renderMilkdropList(); }
      chooseMilkdrop(name);
      const card = els.mdList.querySelector(`[data-preset="${cssEscape(name)}"]`);
      if (card) card.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (typing) return;
    const showing = window.MilkDrop.current();
    if (!showing) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleMilkdropFavourite(showing); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); toggleMilkdropHidden(showing); }
    else if (e.key === 'Enter' && els.mdPin) { e.preventDefault(); els.mdPin.click(); }
  });
}
if (els.mdPin) {
  els.mdPin.addEventListener('click', () => {
    if (!currentTrack) return;
    const showing = window.MilkDrop.current();
    const already = pinnedMilkdrop() === showing;
    writeMilkdropPin(already ? null : showing);
    updateMilkdropPinChip();
    els.mdStatus.textContent = already ? 'unpinned' : `pinned to ${currentTrack.title || 'this song'}`;
  });
}

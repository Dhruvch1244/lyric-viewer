'use strict';

/*
  Beat-synced lyric typography: the word being sung takes the beat.

  Until now a line animated once, as it arrived, and then sat still while the
  karaoke wipe ran across it — the music kept hitting and the words did not.
  Here every kick lands on the word being sung (a hard kick or a drop on the
  whole line, rippling word by word), in a style that fits the song:

    shatter   hard genres and energetic songs — a violent scale and twist
    glitch    electronic — a sideways tear in steps
    bounce    the default — a springy hop
    float     calm and soft songs — a slow lift

  Web Animations with `composite: 'add'`: the hit adds to whatever the word's
  CSS entrance animation is doing instead of replacing it, restarts without a
  forced layout (no class-toggle-and-reflow), and only animates transform, so
  it stays on the compositor. One element per kick — a few a second.

  Runs after renderer.js; reads nothing of it. The renderer calls `onBeat`
  with the line's word spans. Settings → Lyric typography picks a style or
  turns it off (localStorage `kineticType`).

  Exposed on window.KineticType: { onBeat, styleFor, mode, STYLES }.
*/

(function () {
  const STYLES = ['shatter', 'glitch', 'bounce', 'float'];
  const MODES = ['auto', ...STYLES, 'off'];

  let mode = 'auto';
  try { const m = localStorage.getItem('kineticType'); if (MODES.includes(m)) mode = m; } catch { /* ignore */ }

  const HARD = /\b(metal|rock|punk|hardstyle|dubstep|trap|phonk|drill)\b/i;
  const ELECTRONIC = /\b(edm|electro|electronic|techno|house|trance|synth|dance|drum|bass|garage)\b/i;
  const SOFT = /\b(r&b|rnb|soul|jazz|lo.?fi|ambient|chill|acoustic|classical|folk|ghazal|sufi|ballad)\b/i;

  /** The style a song gets on Auto. Genre first (it says more), then mood. */
  function styleFor(mood, genre) {
    if (genre) {
      if (HARD.test(genre)) return 'shatter';
      if (ELECTRONIC.test(genre)) return 'glitch';
      if (SOFT.test(genre)) return 'float';
    }
    if (mood === 'energetic') return 'shatter';
    if (mood === 'calm') return 'float';
    if (mood === 'dark') return 'glitch';
    return 'bounce';
  }

  /* Keyframes per style at strength s (0..1). Transform only. */
  const FRAMES = {
    shatter: (s, i) => {
      const tw = (i % 2 ? -1 : 1) * (3 + 5 * s);
      return [
        { transform: 'scale(1) rotate(0deg)' },
        { transform: `scale(${1 + 0.38 * s}) rotate(${tw}deg) skewX(${-tw}deg)`, offset: 0.18 },
        { transform: `scale(${1 - 0.06 * s}) rotate(${-tw * 0.3}deg)`, offset: 0.55 },
        { transform: 'scale(1) rotate(0deg)' },
      ];
    },
    glitch: (s) => {
      const d = 3 + 9 * s;
      return [
        { transform: 'translateX(0) skewX(0deg)' },
        { transform: `translateX(${-d}px) skewX(${12 * s}deg)`, offset: 0.2 },
        { transform: `translateX(${d * 0.8}px) skewX(${-8 * s}deg)`, offset: 0.4 },
        { transform: `translateX(${-d * 0.4}px)`, offset: 0.65 },
        { transform: 'translateX(0) skewX(0deg)' },
      ];
    },
    bounce: (s) => [
      { transform: 'translateY(0) scale(1)' },
      { transform: `translateY(${-0.28 * s}em) scale(${1 + 0.16 * s})`, offset: 0.3 },
      { transform: `translateY(${0.05 * s}em) scale(${1 - 0.03 * s})`, offset: 0.7 },
      { transform: 'translateY(0) scale(1)' },
    ],
    float: (s) => [
      { transform: 'translateY(0) scale(1)' },
      { transform: `translateY(${-0.14 * s}em) scale(${1 + 0.06 * s})`, offset: 0.5 },
      { transform: 'translateY(0) scale(1)' },
    ],
  };
  const DURATION = { shatter: 240, glitch: 200, bounce: 300, float: 560 };
  const EASING = { shatter: 'cubic-bezier(.2,.9,.3,1.2)', glitch: 'steps(4, jump-none)', bounce: 'cubic-bezier(.3,1.4,.5,1)', float: 'ease-in-out' };

  const MIN_GAP_MS = 110; // a roll of kicks still reads as separate hits
  let lastHit = 0;
  let hitCount = 0;

  function hit(el, style, s, delay) {
    if (!el || typeof el.animate !== 'function') return;
    try {
      el.animate(FRAMES[style](s, hitCount++), {
        duration: DURATION[style], easing: EASING[style], delay, composite: 'add',
      });
    } catch { /* an engine without composite support simply skips the hit */ }
  }

  /**
   * A beat landed.
   * @param {Array<{el: Element, state: number}>} words  the active line's words
   *   (renderer.js activeWords); state 1 = being sung, 2 = sung
   * @param {number} strength 0..1
   * @param {{mood?: string, genre?: string, reduced?: boolean, drop?: boolean, now?: number}} ctx
   */
  function onBeat(words, strength, ctx = {}) {
    if (mode === 'off' || !words || words.length === 0) return;
    const now = ctx.now || performance.now();
    if (now - lastHit < MIN_GAP_MS && !ctx.drop) return;
    lastHit = now;

    let style = mode === 'auto' ? styleFor(ctx.mood, ctx.genre) : mode;
    let s = Math.max(0.25, Math.min(1, strength));
    if (ctx.reduced) { style = 'float'; s *= 0.4; } // Reduce Motion: a lift, never a jolt

    // A drop or a hard kick takes the whole line, rippling out word by word.
    if ((ctx.drop || s > 0.8) && !ctx.reduced) {
      const step = Math.min(40, 240 / words.length);
      for (let i = 0; i < words.length; i += 1) hit(words[i].el, style, s * 0.8, i * step);
      return;
    }
    // Otherwise the word being sung; between words, the last one sung.
    let target = null;
    for (let i = 0; i < words.length; i += 1) {
      if (words[i].state === 1) { target = words[i]; break; }
      if (words[i].state === 2) target = words[i];
    }
    if (target) hit(target.el, style, s, 0);
  }

  /* Settings → Lyric typography. */
  const select = document.getElementById('keybox-kinetic');
  if (select) {
    select.value = mode;
    select.addEventListener('change', () => {
      mode = MODES.includes(select.value) ? select.value : 'auto';
      try { localStorage.setItem('kineticType', mode); } catch { /* ignore */ }
    });
  }

  window.KineticType = { onBeat, styleFor, mode: () => mode, STYLES, MODES };
})();

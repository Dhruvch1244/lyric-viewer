'use strict';

/*
  Studio — the song drawn as if it were being produced in a DAW, live.

  Producer reels (FL Studio especially) are the channel rack's step grid
  lighting up, notes landing in the piano roll and the mixer meters slamming.
  This builds that view from whatever is playing, with nothing authored per
  song: the "programming" is the music itself, read every 16th note.

    Playlist     one clip per bar, coloured and labelled by how hard the bar
                 hit, so the song's arrangement draws itself left to right.
    Channel rack Kick / Clap / Hat / Bass / Lead / Perc over 16 steps. The
                 playhead walks the bar on the app's beat clock; when it leaves
                 a step, that step is written with what was actually heard in
                 it, so the pattern is the beat as played, not a guess.
    Piano roll   the strongest pitch in the melody range on each step, as a
                 note — held notes extend, new pitches start new notes.
    Mixer        a strip per channel plus master, with peak hold.

  Detection is deliberately simple and per-band: the kick is the app's own kick
  detector (audio.js), the others are onsets — a band rising clearly above its
  own recent average — so a loud but steady pad never fills the hat row.

  Without audio capture there is no spectrum, so the rack falls back to a plain
  four-on-the-floor pattern on the lyric-driven beat clock: the view stays a
  working rack instead of an empty grid.

  Exposed on window.StudioView: { draw, reset, ROWS, STEPS } and, for the
  tests, { createState, rowSignals, observe, commitStep, pitchOf }.
*/

(function () {
  const STEPS = 16;
  const ROWS = ['Kick', 'Clap', 'Hat', 'Bass', 'Lead', 'Perc'];
  const ROLL_STEPS = 64;  // four bars of piano roll
  const ROLL_LOW = 48;    // C3
  const ROLL_HIGH = 84;   // C6
  const PLAYLIST_BARS = 24;
  // What a loud bar is taken to be before the song has shown its own. Without
  // it the first bars of a song that builds are each "the loudest so far", and
  // a quiet intro was labelled Drop. It fades toward the song's real peak
  // (LOUD_FADE a bar), so a quietly mastered track still gets its drop.
  const LOUD_PRIOR = 0.75;
  const LOUD_FADE = 0.97;

  // FL Studio's own look: graphite panels, orange pads, green notes.
  const C = {
    bg: 'rgba(22, 26, 30, 0.80)',
    panel: 'rgba(40, 46, 52, 0.86)',
    header: 'rgba(58, 66, 73, 0.95)',
    text: '#c9d1d7',
    dim: '#7d8790',
    padOff: '#3e464d',
    padOffAlt: '#495159',
    orange: '#ff9a1f',
    green: '#86e07a',
    meterLow: '#59d36b',
    meterMid: '#f2d14b',
    meterHigh: '#ff5a3c',
  };

  function createState() {
    return {
      key: null,
      pattern: ROWS.map(() => new Float32Array(STEPS)),
      acc: new Float32Array(ROWS.length),   // strongest hit per row in the current step
      avg: new Float32Array(ROWS.length).fill(0.15),
      lastPhase: 0,
      beatIndex: 0,
      lastStep: -1,
      stepTotal: 0,
      pitchAcc: { midi: -1, vel: 0 },
      notes: [],          // { start, len, midi, vel } in global step numbers
      clips: [],          // { energy, label }
      barLevel: 0,        // summed loudness over the current bar
      barFrames: 0,
      loudestBar: LOUD_PRIOR,
      meters: new Float32Array(ROWS.length + 1),
      peaks: new Float32Array(ROWS.length + 1),
    };
  }

  /** Mean of `freq` bins [a, b), 0..1. */
  function band(freq, a, b) {
    let s = 0;
    for (let i = a; i < b; i += 1) s += freq[i];
    return s / ((b - a) * 255);
  }

  /**
   * Per-row signal for one frame, 0..1. `env` is audio.js's envelope (bass,
   * mid, treble, level, kick); `freq` its 512-bin spectrum (~46Hz a bin).
   */
  function rowSignals(env, freq) {
    const clap = freq ? band(freq, 22, 64) : env.mid;     // ~1-3kHz: snare/clap body
    const hat = freq ? band(freq, 160, 300) : env.treble; // ~7.5-14kHz: hats, shakers
    const perc = freq ? band(freq, 64, 140) : env.treble; // ~3-6.5kHz: rims, toms' click
    return [env.kick || 0, clap, hat, env.bass || 0, env.mid || 0, perc];
  }

  // Rows read as hits (onsets) vs. as held level. Bass is an onset too: read as
  // a level, a bassline that never stops filled every pad of its row, which
  // looks like nothing was detected at all. Lead is written from the melody
  // instead (commitStep), so its row lines up with the piano roll.
  const LEAD = ROWS.indexOf('Lead');
  const ONSET = [false, true, true, true, false, true];
  const THRESH = [0.38, 0.06, 0.05, 0.06, 0.40, 0.05];

  /**
   * Fold one frame's signals into the current step. `level` is the overall
   * loudness (0..1), which is what the playlist labels bars by.
   */
  function observe(state, signals, level = 0) {
    state.barLevel += level;
    state.barFrames += 1;
    for (let r = 0; r < ROWS.length; r += 1) {
      const v = signals[r];
      const hit = ONSET[r] ? Math.max(0, v - state.avg[r] * 1.12) : v;
      state.avg[r] = state.avg[r] * 0.96 + v * 0.04;
      if (hit > state.acc[r]) state.acc[r] = hit;
      // Meters follow the raw level, onset rows lifted so they read.
      const m = Math.min(1, ONSET[r] ? v * 2.2 : v);
      state.meters[r + 1] = Math.max(m, state.meters[r + 1] * 0.9);
    }
  }

  /** The step the playhead just left gets what was heard in it. */
  function commitStep(state, step) {
    for (let r = 0; r < ROWS.length; r += 1) {
      if (r === LEAD) { state.acc[r] = 0; continue; } // written from the melody, below
      const a = state.acc[r];
      const vel = a > THRESH[r] ? Math.min(1, 0.45 + (a - THRESH[r]) * (ONSET[r] ? 6 : 1.6)) : 0;
      state.pattern[r][step] = vel;
      state.acc[r] = 0;
    }
    const p = state.pitchAcc;
    state.pattern[LEAD][step] = 0;
    if (p.midi >= 0) {
      const last = state.notes[state.notes.length - 1];
      if (last && last.midi === p.midi && last.start + last.len === state.stepTotal) {
        last.len += 1; // a held note: a dim pad, as a tie would look
        state.pattern[LEAD][step] = 0.3;
      } else {
        state.notes.push({ start: state.stepTotal, len: 1, midi: p.midi, vel: p.vel });
        state.pattern[LEAD][step] = Math.max(0.6, p.vel);
      }
    }
    state.pitchAcc = { midi: -1, vel: 0 };
    while (state.notes.length && state.notes[0].start + state.notes[0].len < state.stepTotal - ROLL_STEPS) {
      state.notes.shift();
    }
    state.stepTotal += 1;

    if (step === STEPS - 1) {
      /*
        Labelled by loudness relative to the loudest bar so far (see
        LOUD_PRIOR), not by an absolute level: masters differ by a lot, and
        counting lit pads did not work either — onsets fire about as often in
        a verse as in a drop.
      */
      const e = state.barFrames ? state.barLevel / state.barFrames : 0;
      state.loudestBar = Math.max(e, state.loudestBar * LOUD_FADE);
      const rel = state.loudestBar > 0 ? e / state.loudestBar : 0;
      const label = e < 0.05 ? 'Intro' : rel > 0.9 ? 'Drop' : rel > 0.75 ? 'Chorus' : rel > 0.6 ? 'Verse' : 'Intro';
      state.clips.push({ energy: rel, label });
      if (state.clips.length > PLAYLIST_BARS) state.clips.shift();
      state.barLevel = 0;
      state.barFrames = 0;
    }
  }

  /**
   * The strongest pitch in the melody range as a MIDI note, or -1. Parabolic
   * interpolation on the peak bin: at ~46Hz a bin a raw bin index is a
   * semitone or more off below 800Hz.
   */
  function pitchOf(freq, sampleRate) {
    const hz = (sampleRate || 48000) / 1024;
    let best = -1;
    let bestV = 0;
    for (let i = 4; i < 44; i += 1) { // ~190Hz-2kHz
      if (freq[i] > bestV && freq[i] >= freq[i - 1] && freq[i] >= freq[i + 1]) {
        bestV = freq[i];
        best = i;
      }
    }
    if (best < 0 || bestV < 110) return -1;
    const a = freq[best - 1];
    const b = freq[best];
    const c = freq[best + 1];
    const denom = a - 2 * b + c;
    const offset = denom ? 0.5 * (a - c) / denom : 0;
    const f = (best + offset) * hz;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    return Math.max(ROLL_LOW, Math.min(ROLL_HIGH - 1, midi));
  }

  let state = createState();

  function reset() { state = createState(); }

  /** Advance the transport from the beat clock; returns the current step. */
  function transport(beatPhase) {
    if (beatPhase + 0.5 < state.lastPhase) state.beatIndex += 1; // the beat wrapped
    state.lastPhase = beatPhase;
    return ((state.beatIndex % 4) * 4) + Math.min(3, Math.floor(beatPhase * 4));
  }

  /* -------------------------------------------------------------- drawing */

  /*
    Static chrome is drawn once into a cache, not every frame.

    Measured in Chromium at 1920x1080: the old draw() cost 2.1-2.6ms a frame,
    and most of that was furniture that never moves — four panels with titles,
    the rack's 96 unlit pads and six labels, the mixer wells and names, and
    the piano roll's 48 keys and lanes — each one a fillRect or a fillText
    that re-parsed its font string. Now that layer is painted into an
    offscreen canvas when the size changes and copied with one drawImage; the
    frame draws only what moves (clips, lit pads, playhead, meters, grid,
    notes). The one meter gradient is shared by every channel instead of
    allocated per channel per frame.
  */
  let cache = null; // { key, canvas }
  let lastFont = '';

  function font(ctx, px) {
    const f = `600 ${Math.round(px)}px system-ui, sans-serif`;
    if (f !== lastFont) { ctx.font = f; lastFont = f; }
  }

  function panel(ctx, x, y, w, h, title, s) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.header;
    ctx.fillRect(x, y, w, 18 * s);
    ctx.fillStyle = C.text;
    font(ctx, 11 * s);
    ctx.textBaseline = 'middle';
    ctx.fillText(title, x + 8 * s, y + 9 * s);
  }

  /** The four panels' rectangles for a w x h view. */
  function layout(w, h) {
    const s = Math.max(0.75, Math.min(2, h / 800));
    const m = 0.025 * w;
    return {
      s,
      playlist: [m, h * 0.03, w - 2 * m, h * 0.13],
      rack: [m, h * 0.18, w * 0.6 - m, h * 0.36],
      mixer: [w * 0.62, h * 0.18, w * 0.38 - m, h * 0.36],
      roll: [m, h * 0.56, w - 2 * m, h * 0.41],
    };
  }

  function rackGeom(x, y, w, h, s) {
    const labelW = 64 * s;
    const top = y + 24 * s;
    const rowH = (h - 30 * s) / ROWS.length;
    const padW = (w - labelW - 12 * s) / STEPS;
    return { labelW, top, rowH, padW };
  }

  function mixerGeom(x, y, w, h, s) {
    const names = ['Master', ...ROWS];
    const top = y + 24 * s;
    return { names, top, mh: h - 46 * s, sw: w / names.length };
  }

  function rollGeom(x, y, w, h, s) {
    const keyW = 34 * s;
    const top = y + 20 * s;
    const rh = h - 22 * s;
    return { keyW, top, rh, noteH: rh / (ROLL_HIGH - ROLL_LOW) };
  }

  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

  function drawStatic(ctx, w, h, L) {
    const s = L.s;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    panel(ctx, ...L.playlist, 'Playlist — Arrangement', s);

    let [x, y, pw, ph] = L.rack;
    panel(ctx, x, y, pw, ph, 'Channel rack', s);
    const R = rackGeom(x, y, pw, ph, s);
    for (let r = 0; r < ROWS.length; r += 1) {
      const ry = R.top + r * R.rowH;
      ctx.fillStyle = C.header;
      ctx.fillRect(x + 6 * s, ry + 2, R.labelW - 10 * s, R.rowH - 4);
      ctx.fillStyle = C.text;
      font(ctx, Math.min(12 * s, R.rowH * 0.42));
      ctx.fillText(ROWS[r], x + 12 * s, ry + R.rowH / 2);
      for (let i = 0; i < STEPS; i += 1) {
        ctx.fillStyle = Math.floor(i / 4) % 2 === 0 ? C.padOff : C.padOffAlt;
        ctx.fillRect(x + R.labelW + i * R.padW + 2, ry + 3, R.padW - 4, R.rowH - 6);
      }
    }

    [x, y, pw, ph] = L.mixer;
    panel(ctx, x, y, pw, ph, 'Mixer', s);
    const M = mixerGeom(x, y, pw, ph, s);
    font(ctx, 9 * s);
    ctx.textAlign = 'center';
    for (let i = 0; i < M.names.length; i += 1) {
      ctx.fillStyle = '#15181b';
      ctx.fillRect(x + i * M.sw + M.sw * 0.28, M.top, M.sw * 0.44, M.mh);
      ctx.fillStyle = C.dim;
      ctx.fillText(M.names[i], x + i * M.sw + M.sw / 2, M.top + M.mh + 11 * s);
    }
    ctx.textAlign = 'left';

    [x, y, pw, ph] = L.roll;
    panel(ctx, x, y, pw, ph, 'Piano roll — Lead', s);
    const P = rollGeom(x, y, pw, ph, s);
    for (let m = ROLL_LOW; m < ROLL_HIGH; m += 1) {
      const ny = P.top + (ROLL_HIGH - 1 - m) * P.noteH;
      const black = BLACK_KEYS.has(m % 12);
      ctx.fillStyle = black ? '#22272b' : '#2b3136';
      ctx.fillRect(x + P.keyW, ny, pw - P.keyW, P.noteH);
      ctx.fillStyle = black ? '#1a1d20' : '#e9edf0';
      ctx.fillRect(x + 2, ny + 0.5, P.keyW - 4, P.noteH - 1);
      if (m % 12 === 0 && P.noteH > 7) {
        ctx.fillStyle = '#3a3f44';
        font(ctx, Math.min(9, P.noteH));
        ctx.fillText(`C${m / 12 - 1}`, x + 4, ny + P.noteH / 2);
      }
    }
  }

  /** The static layer for this size, painted on first use after a resize. */
  function staticLayer(ctx, w, h, L) {
    const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1 };
    const scale = t.a || 1;
    const key = `${w}x${h}@${scale}`;
    if (cache && cache.key === key) return cache.canvas;
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    let canvas;
    if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(bw, bh);
    else if (typeof document !== 'undefined') { canvas = document.createElement('canvas'); canvas.width = bw; canvas.height = bh; }
    else return null;
    const c = canvas.getContext('2d');
    if (!c) return null;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    const savedFont = lastFont;
    lastFont = '';
    drawStatic(c, w, h, L);
    lastFont = savedFont;
    cache = { key, canvas };
    return canvas;
  }

  function drawPlaylist(ctx, x, y, w, h, s, accent) {
    const top = y + 22 * s;
    const lane = h - 26 * s;
    const cw = w / PLAYLIST_BARS;
    const labels = cw > 34 * s;
    if (labels) font(ctx, 9 * s);
    for (let i = 0; i < state.clips.length; i += 1) {
      const clip = state.clips[i];
      const cx = x + i * cw;
      const ch = lane * (0.35 + Math.min(1, clip.energy * 1.6) * 0.65);
      ctx.fillStyle = clip.label === 'Drop' ? C.orange : clip.label === 'Chorus' ? accent : clip.label === 'Verse' ? C.green : C.padOffAlt;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(cx + 1, top + lane - ch, cw - 2, ch);
      ctx.globalAlpha = 1;
      if (labels) {
        ctx.fillStyle = '#16191c';
        ctx.fillText(clip.label, cx + 4 * s, top + lane - ch + 8 * s);
      }
    }
    // The "now" edge, where the next bar will land.
    const nx = x + Math.min(state.clips.length, PLAYLIST_BARS - 0.5) * cw;
    ctx.fillStyle = C.orange;
    ctx.fillRect(nx, top, 2, lane);
  }

  function drawRack(ctx, x, y, w, h, s, step, kick) {
    const { labelW, top, rowH, padW } = rackGeom(x, y, w, h, s);
    ctx.fillStyle = C.orange;
    for (let r = 0; r < ROWS.length; r += 1) {
      const ry = top + r * rowH;
      for (let i = 0; i < STEPS; i += 1) {
        const vel = state.pattern[r][i];
        if (vel <= 0) continue;
        const px = x + labelW + i * padW;
        ctx.globalAlpha = 0.35 + vel * 0.65;
        if (i === step) {
          ctx.shadowColor = C.orange;
          ctx.shadowBlur = 10 * s * (0.6 + kick);
          ctx.fillRect(px + 2, ry + 3, padW - 4, rowH - 6);
          ctx.shadowBlur = 0;
        } else {
          ctx.fillRect(px + 2, ry + 3, padW - 4, rowH - 6);
        }
      }
    }
    ctx.globalAlpha = 1;
    // Playhead column.
    const hx = x + labelW + step * padW;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fillRect(hx, top, padW, rowH * ROWS.length);
    ctx.fillStyle = C.orange;
    ctx.fillRect(hx, top - 4 * s, padW, 3 * s);
  }

  function drawMixer(ctx, x, y, w, h, s) {
    const { names, top, mh, sw } = mixerGeom(x, y, w, h, s);
    const grad = ctx.createLinearGradient(0, top + mh, 0, top);
    grad.addColorStop(0, C.meterLow);
    grad.addColorStop(0.7, C.meterMid);
    grad.addColorStop(1, C.meterHigh);
    for (let i = 0; i < names.length; i += 1) {
      const v = state.meters[i];
      state.peaks[i] = Math.max(v, state.peaks[i] - 0.008);
      const mx = x + i * sw + sw * 0.28;
      const mw = sw * 0.44;
      const lh = mh * v;
      ctx.fillStyle = grad;
      ctx.fillRect(mx, top + mh - lh, mw, lh);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx, top + mh - mh * state.peaks[i] - 1, mw, 2);
    }
  }

  function drawRoll(ctx, x, y, w, h, s, phase) {
    const { keyW, top, rh, noteH } = rollGeom(x, y, w, h, s);
    // Beat and bar lines, scrolling with the notes: global step g sits
    // (now - g) steps left of the right edge.
    const stepW = (w - keyW) / ROLL_STEPS;
    const now = state.stepTotal + phase;
    for (let g = Math.ceil((now - ROLL_STEPS) / 4) * 4; g <= now; g += 4) {
      const lx = x + w - (now - g) * stepW;
      if (lx < x + keyW) continue;
      ctx.fillStyle = g % 16 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(lx, top, 1, rh);
    }
    // Notes, newest at the right edge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + keyW, top, w - keyW, rh);
    ctx.clip();
    for (const n of state.notes) {
      const nx = x + w - (now - n.start) * stepW;
      const nw = Math.max(3, n.len * stepW - 2);
      const ny = top + (ROLL_HIGH - 1 - n.midi) * noteH;
      ctx.globalAlpha = 0.55 + n.vel * 0.45;
      ctx.fillStyle = C.green;
      ctx.fillRect(nx, ny + 1, nw, Math.max(2, noteH - 2));
      ctx.fillStyle = '#d9ffd2';
      ctx.fillRect(nx, ny + 1, 2, Math.max(2, noteH - 2));
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Draw one frame.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w @param {number} h CSS pixels
   * @param {object} input { trackKey, beatPhase, env (audio envelope or null),
   *   freq (Uint8Array spectrum or null), sampleRate, beatFlash, accent }
   */
  function draw(ctx, w, h, input) {
    if (input.trackKey !== state.key) {
      reset();
      state.key = input.trackKey;
    }
    const step = transport(input.beatPhase || 0);
    if (state.lastStep !== -1 && step !== state.lastStep) commitStep(state, state.lastStep);
    state.lastStep = step;

    const env = input.env;
    if (env && env.active) {
      const level = Math.min(1, (env.level || 0) * 1.6);
      observe(state, rowSignals(env, input.freq), level);
      state.meters[0] = Math.max(level, state.meters[0] * 0.9);
      if (input.freq) {
        const midi = pitchOf(input.freq, input.sampleRate);
        if (midi >= 0) {
          const vel = Math.min(1, (env.mid || 0) * 1.4 + 0.2);
          if (vel > state.pitchAcc.vel) state.pitchAcc = { midi, vel };
        }
      }
    } else {
      // No capture: a plain four-on-the-floor on the lyric beat clock.
      const f = input.beatFlash || 0;
      const sub = step % 4;
      observe(state, [sub === 0 ? 0.9 * f + 0.4 : 0, step % 8 === 4 ? 0.5 : 0, sub === 2 ? 0.3 : 0, sub === 0 ? 0.6 : 0, 0, 0], 0.5);
      state.meters[0] = Math.max(0.5 * f, state.meters[0] * 0.9);
    }

    const L = layout(w, h);
    const s = L.s;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    lastFont = ''; // the caller's canvas may have had its font changed since
    const layer = staticLayer(ctx, w, h, L);
    if (layer) ctx.drawImage(layer, 0, 0, w, h);
    else drawStatic(ctx, w, h, L);
    ctx.textBaseline = 'middle';
    const accent = input.accent || '#9a6bff';
    drawPlaylist(ctx, ...L.playlist, s, accent);
    drawRack(ctx, ...L.rack, s, step, (env && env.kick) || input.beatFlash || 0);
    drawMixer(ctx, ...L.mixer, s);
    drawRoll(ctx, ...L.roll, s, (input.beatPhase || 0) * 4 % 1);
    ctx.restore();
  }

  window.StudioView = {
    draw, reset, ROWS, STEPS,
    // For the tests.
    createState, rowSignals, observe, commitStep, pitchOf,
  };
})();

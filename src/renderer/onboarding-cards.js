'use strict';

/*
  Onboarding and notification cards — pulled out of renderer.js, which had
  grown into a single 7,365-line file. Loaded AFTER renderer.js (see
  index.html), same reasoning as milkdrop-panel.js: this is UI glue over
  renderer.js's own DOM refs (`els`) and state (`currentTrack`,
  `audioEnabled`, `appVersion`, ...), sharing the same top-level script scope
  rather than wrapped as a window.Namespace module.

  Covers: the 20-seconds-in audio-capture nudge, the auto-update prompt, and
  the local-CLI fallback offer. The first-run welcome / what's-new cards stay
  in renderer.js itself — see the comment there for why they couldn't move
  here along with the rest.
*/

/* Esc also dismisses the welcome/what's-new cards. Scoped to "while the card
   is up" so this does not become a global key handler competing with the
   panels' own Esc bindings. closeWelcome/closeWhatsNew live in renderer.js;
   referencing them here is safe in this direction — this file loads AFTER
   renderer.js, so both already exist by the time any real keydown fires. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (els.welcome && !els.welcome.hidden) closeWelcome();
  else if (els.whatsnew && !els.whatsnew.hidden) closeWhatsNew(appVersion);
  else if (els.mdPanel && !els.mdPanel.hidden) closeMilkdropPanel();
  else if (els.poster && !els.poster.hidden) closePoster();
});

/** Playback needed before asking, so the prompt does not land during startup. */
const CAPTURE_NUDGE_AFTER_MS = 20000;
const CAPTURE_NUDGE_KEY = 'captureNudgeAnswered';

let captureNudgeVisible = false;

/** Whether this install has already answered the prompt, either way. */
function captureNudgeAnswered() {
  try {
    return localStorage.getItem(CAPTURE_NUDGE_KEY) === '1';
  } catch {
    return true;   // no storage means we cannot remember a "no" — so never ask
  }
}

/** Record that it was answered and take it off screen. */
function closeCaptureNudge() {
  captureNudgeVisible = false;
  if (els.captureNudge) els.captureNudge.hidden = true;
  try { localStorage.setItem(CAPTURE_NUDGE_KEY, '1'); } catch { /* ignore */ }
}

/**
 * Show the prompt once a song has been playing long enough, if capture is off
 * and this install has never answered.
 * @param {number} positionMs
 */
function maybeShowCaptureNudge(positionMs) {
  if (captureNudgeVisible || audioEnabled || !els.captureNudge) return;
  // Never stack the two cards. A first-time user who has not dismissed the
  // welcome yet is not ready for a second thing to read.
  if (els.welcome && !els.welcome.hidden) return;
  if (els.whatsnew && !els.whatsnew.hidden) return;
  if (!currentTrack || positionMs < CAPTURE_NUDGE_AFTER_MS) return;
  if (captureNudgeAnswered()) return;
  captureNudgeVisible = true;
  els.captureNudge.hidden = false;
}

if (els.nudgeEnable) {
  els.nudgeEnable.addEventListener('click', async () => {
    closeCaptureNudge();
    await enableAudio();
    refreshButtons();
  });
}
if (els.nudgeDismiss) {
  els.nudgeDismiss.addEventListener('click', closeCaptureNudge);
}

/* ------------------------------------------------------------------ updating */
/*
  Auto-update, made visible.

  0.19.0 shipped auto-update, 0.20.0 made it actually reach GitHub, and both
  reported it into the tray menu alone. On an app whose whole surface is a
  full-screen overlay, a state that only exists inside a right-click menu is a
  state nobody sees: the update downloaded, waited, and the only way to learn
  that was to go looking for it.

  Main decides whether to prompt (see `updateStateForRenderer`), because the
  dismissal has to outlive this renderer — changing display mode reloads it.
*/

/** @param {{phase: string, version?: string, percent?: number, prompt: boolean}} s */
function applyUpdateState(state) {
  if (!state) return;

  if (els.updateCard) {
    els.updateCard.hidden = !state.prompt;
    if (state.prompt && els.updateVersion) {
      els.updateVersion.textContent = state.version ? `Version ${state.version}` : 'A new version';
    }
  }

  if (els.updatePill) {
    // Only while it is arriving. Once ready the card says it better, and two
    // things saying the same thing at once reads as a bug.
    const busy = state.phase === 'downloading' || state.phase === 'available';
    els.updatePill.hidden = !busy;
    if (busy) {
      const pct = Math.max(0, Math.min(99, Math.floor(state.percent || 0)));
      els.updatePill.textContent = state.phase === 'available'
        ? `Downloading ${state.version || 'update'}…`
        : `Downloading ${state.version || 'update'}… ${pct}%`;
    }
  }
}

if (els.updateInstall) {
  els.updateInstall.addEventListener('click', () => {
    // The app quits from under us if this succeeds, so nothing follows it.
    window.player.updateAction('install');
  });
}
if (els.updateLater) {
  els.updateLater.addEventListener('click', async () => {
    if (els.updateCard) els.updateCard.hidden = true;
    await window.player.updateAction('dismiss');
  });
}
if (window.player.onUpdateState) window.player.onUpdateState(applyUpdateState);

/* Ask once at startup: a cold start can settle on 'ready' before this file has
   run, and the push-only path would then never fire. */
if (window.player.getUpdateState) {
  window.player.getUpdateState().then(applyUpdateState).catch(() => { /* not packaged */ });
}

/* ------------------------------------------------------- local-CLI fallback */
/*
  When every cloud AI provider has failed, main sends `localcli-offer` with the
  CLIs it detected. This turns that into a card: one button per installed CLI to
  turn it on, an install hint for the rest, and a dismiss that is remembered so
  it does not ask again. Nothing runs a CLI until a button here is clicked —
  consent is the whole point.
*/
function closeLocalcliCard() {
  if (els.localcliCard) els.localcliCard.hidden = true;
}

function showLocalcliOffer(detected) {
  if (!els.localcliCard || !els.localcliOptions) return;
  const clis = Array.isArray(detected) ? detected : [];
  const installed = clis.filter((c) => c.installed);

  els.localcliOptions.replaceChildren();

  if (installed.length > 0) {
    if (els.localcliText) {
      els.localcliText.textContent = 'Cloud AI is unavailable. Pick a tool you have installed to use instead:';
    }
    // Verified first, so the one that definitely works is the obvious choice.
    const ordered = [...installed].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));
    for (const c of ordered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      // A clear badge on each: what works vs what is best-effort.
      const badge = c.verified ? ' ✓' : (c.unverified ? ' · experimental' : ' · best-effort');
      btn.textContent = `${c.label}${badge}`;
      btn.title = c.verified
        ? `${c.label} is verified working — recommended`
        : c.unverified
          ? `${c.label}'s non-interactive mode is unverified — may not work`
          : `${c.label} should work but is not fully verified`;
      if (c.verified) btn.classList.add('chip--recommended');
      btn.addEventListener('click', async () => {
        try { await window.player.localcliConsent(c.id); } catch { /* command may not exist on this backend yet */ }
        closeLocalcliCard();
        setStatus(`AI features will use ${c.label} from now on`);
      });
      els.localcliOptions.appendChild(btn);
    }
  } else {
    // None installed: offer install hints for the ones worth getting.
    if (els.localcliText) {
      els.localcliText.textContent = 'Cloud AI is unavailable. Install a local AI CLI to keep these features working:';
    }
    for (const c of clis.slice(0, 3)) {
      const hint = document.createElement('span');
      hint.className = 'localcli__hint';
      hint.textContent = `${c.label}: ${c.install}`;
      els.localcliOptions.appendChild(hint);
    }
  }

  els.localcliCard.hidden = false;
}

if (els.localcliDismiss) {
  els.localcliDismiss.addEventListener('click', async () => {
    closeLocalcliCard();
    // Remembered as a decision so it does not ask again.
    try { await window.player.localcliConsent('declined'); } catch { /* command may not exist on this backend yet */ }
  });
}
if (window.player.onLocalcliOffer) {
  window.player.onLocalcliOffer(({ detected }) => showLocalcliOffer(detected));
}

/* --------------------------------------------------------- focus trap (U3) */
/*
  One registration point for every real panel in the app, rather than hand-
  wiring trapFocus/releaseFocus into each one's own open()/close() — see
  panel-focus.js for what registerPanel() actually does. This file loads
  last (index.html), so every element and close() function below already
  exists, including milkdrop-panel.js's (loaded just before this file).

  The three ambient notification cards below (capture-nudge, update-card,
  localcli-card) are deliberately NOT registered the same way: they carry
  `role="status"` because they are non-blocking toasts that appear alongside
  whatever the user is already doing, not panels that take over the screen.
  Force-focusing them or trapping Tab inside would fight that — a keyboard
  user tabbing through the HUD should be able to tab past one, not get stuck
  in it. They still get Escape-to-dismiss, scoped to when focus is actually
  inside one (e.g. a user tabbed onto its button on purpose).
*/
if (window.PanelFocus) {
  const { registerPanel } = window.PanelFocus;
  registerPanel(els.welcome, () => els.welcomeClose && els.welcomeClose.click());
  registerPanel(els.whatsnew, () => els.whatsnewClose && els.whatsnewClose.click());
  registerPanel(els.modelConsent, () => closeModelConsent());
  registerPanel(els.keybox, () => closeKeybox());
  registerPanel(els.presync, () => closePresync());
  registerPanel(els.poster, () => closePoster());
  registerPanel(els.lyricSearch, () => closeLyricSearch());
  registerPanel(els.library, () => closeLibrary());
  registerPanel(els.insights, () => closeInsights());
  registerPanel(els.mdPanel, () => closeMilkdropPanel());
  registerPanel(els.cheatsheet, () => closeCheatsheet());
  registerPanel(typeof modeMenu !== 'undefined' ? modeMenu : null, () => closeModeMenu());
  registerPanel(typeof moreMenu !== 'undefined' ? moreMenu : null, () => closeMoreMenu(false));
}

for (const [el, dismiss] of [
  [els.captureNudge, closeCaptureNudge],
  [els.updateCard, () => els.updateLater && els.updateLater.click()],
  [els.localcliCard, () => els.localcliDismiss && els.localcliDismiss.click()],
]) {
  if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });
}

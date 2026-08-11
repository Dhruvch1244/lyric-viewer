'use strict';

/*
  Unit tests for the auto-updater's pure parts (src/main/updater.js).

  The Electron plumbing is not testable without a packaged app and a network,
  and mocking electron-updater would only assert that the mock was called. What
  IS worth pinning down is the state → label mapping, because it is what the
  user reads and it is the part with branching: every phase must produce
  something honest, and the menu row must not be clickable while a download it
  would interrupt is in flight.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AppUpdater, describeUpdate, isUpdateActionable, shouldPromptRestart,
} = require('../src/main/updater');

test('every phase produces a non-empty label', () => {
  const phases = ['idle', 'checking', 'available', 'downloading', 'ready', 'none', 'error'];
  for (const phase of phases) {
    const label = describeUpdate({ phase });
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `${phase} produced no label`);
  }
});

test('an unknown or missing state falls back to the idle label', () => {
  // The tray renders this row on its very first refresh, which can happen
  // before the updater has reported anything at all.
  assert.equal(describeUpdate(null), 'Check for updates');
  assert.equal(describeUpdate({}), 'Check for updates');
  assert.equal(describeUpdate({ phase: 'nonsense' }), 'Check for updates');
});

test('download progress never shows 100%', () => {
  // Reaching "100%" while bytes are still arriving reads as a hang. 100 belongs
  // to the 'ready' phase alone.
  assert.match(describeUpdate({ phase: 'downloading', percent: 99.9 }), /99%/);
  assert.match(describeUpdate({ phase: 'downloading', percent: 100 }), /99%/);
  assert.match(describeUpdate({ phase: 'downloading', percent: 140 }), /99%/);
});

test('download progress tolerates a missing or negative percent', () => {
  assert.match(describeUpdate({ phase: 'downloading' }), /0%/);
  assert.match(describeUpdate({ phase: 'downloading', percent: -5 }), /0%/);
});

test('the version is named once it is known', () => {
  assert.match(describeUpdate({ phase: 'ready', version: '0.19.0' }), /0\.19\.0/);
  assert.match(describeUpdate({ phase: 'downloading', version: '0.19.0', percent: 40 }), /0\.19\.0/);
  // ...and its absence must not print "undefined" at the user.
  assert.doesNotMatch(describeUpdate({ phase: 'ready' }), /undefined/);
  assert.doesNotMatch(describeUpdate({ phase: 'downloading', percent: 40 }), /undefined/);
});

test('the row is inert while a check or download is in flight', () => {
  // Clicking during a download would call checkNow() and restart the whole
  // dance; there is nothing useful for a click to do until it settles.
  assert.equal(isUpdateActionable({ phase: 'checking' }), false);
  assert.equal(isUpdateActionable({ phase: 'available' }), false);
  assert.equal(isUpdateActionable({ phase: 'downloading', percent: 10 }), false);

  assert.equal(isUpdateActionable({ phase: 'idle' }), true);
  assert.equal(isUpdateActionable({ phase: 'ready' }), true);
  assert.equal(isUpdateActionable({ phase: 'none' }), true);
  assert.equal(isUpdateActionable({ phase: 'error' }), true);
  assert.equal(isUpdateActionable(null), true);
});

test('a development build never touches electron-updater', () => {
  // `npm start` must stay clean: electron-updater looks for a dev-app-update.yml
  // that is not there and throws.
  const updater = new AppUpdater();
  updater.start(false);
  assert.equal(updater.enabled, false);
  assert.equal(updater.updater, null);
  assert.equal(updater.state.phase, 'idle');
});

test('installNow refuses unless something is actually downloaded', () => {
  // The caller falls back to checkNow() on a false return, so a wrong answer
  // here means either a no-op menu row or a quit with nothing to install.
  const updater = new AppUpdater();
  updater.enabled = true;
  updater.updater = { quitAndInstall: () => { throw new Error('must not be called'); } };

  for (const phase of ['idle', 'checking', 'available', 'downloading', 'none', 'error']) {
    updater.state = { phase };
    assert.equal(updater.installNow(), false, `installNow ran in phase ${phase}`);
  }
});

test('installNow quits and restarts when an update is ready', () => {
  let args = null;
  const updater = new AppUpdater();
  updater.enabled = true;
  updater.updater = { quitAndInstall: (...a) => { args = a; } };
  updater.state = { phase: 'ready', version: '0.19.0' };

  assert.equal(updater.installNow(), true);
  // Force the quit: an always-on-top window can otherwise keep the app alive.
  assert.deepEqual(args, [true, true]);
});

test('state changes notify the listener so the tray can redraw', () => {
  let calls = 0;
  const updater = new AppUpdater({ onChange: () => { calls += 1; } });
  updater.set({ phase: 'checking' });
  updater.set({ phase: 'none' });
  assert.equal(calls, 2);
  assert.equal(updater.state.phase, 'none');
});

/* --- the on-screen card (0.21.0) --- */

test('only a downloaded update earns a prompt', () => {
  // 'available' and 'downloading' are shown as a passive pill instead: an
  // update still arriving has no question for the user to answer.
  for (const phase of ['idle', 'checking', 'available', 'downloading', 'none', 'error']) {
    assert.equal(shouldPromptRestart({ phase, version: '0.21.0' }, null), false,
      `phase ${phase} raised a card`);
  }
  assert.equal(shouldPromptRestart({ phase: 'ready', version: '0.21.0' }, null), true);
  assert.equal(shouldPromptRestart(null, null), false);
});

test('a dismissed version stays dismissed, but a newer one does not', () => {
  // Re-prompting for the same build every few hours is how a card trains
  // someone to dismiss it unread.
  assert.equal(shouldPromptRestart({ phase: 'ready', version: '0.21.0' }, '0.21.0'), false);
  assert.equal(shouldPromptRestart({ phase: 'ready', version: '0.22.0' }, '0.21.0'), true);
  // An unnamed version cannot be matched against a dismissal, so it prompts.
  assert.equal(shouldPromptRestart({ phase: 'ready' }, '0.21.0'), true);
});

test('dismiss records the version currently ready', () => {
  const updater = new AppUpdater();
  updater.state = { phase: 'ready', version: '0.21.0' };
  assert.equal(updater.shouldPrompt(), true);
  updater.dismiss();
  assert.equal(updater.dismissedVersion, '0.21.0');
  assert.equal(updater.shouldPrompt(), false);
});

test('history records phase changes, not progress ticks', () => {
  // A download emits progress many times a second; recording each one would
  // push everything else out of the buffer during a single update.
  let clock = 1000;
  const updater = new AppUpdater({ now: () => (clock += 1) });
  updater.set({ phase: 'checking' });
  updater.set({ phase: 'available', version: '0.21.0' });
  for (let i = 0; i < 200; i += 1) {
    updater.set({ phase: 'downloading', percent: i / 2, version: '0.21.0' });
  }
  updater.set({ phase: 'ready', version: '0.21.0' });

  assert.deepEqual(updater.history.map((h) => h.phase),
    ['checking', 'available', 'downloading', 'ready']);
  assert.equal(updater.history[1].detail, '0.21.0');
  assert.ok(updater.history[3].at > updater.history[0].at);
});

test('history is bounded', () => {
  const updater = new AppUpdater();
  for (let i = 0; i < 500; i += 1) {
    updater.set({ phase: i % 2 ? 'checking' : 'none' });
  }
  assert.equal(updater.history.length, 50);
});

test('an error message is what gets recorded, not a version', () => {
  const updater = new AppUpdater();
  updater.set({ phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.equal(updater.history[0].detail, 'net::ERR_INTERNET_DISCONNECTED');
});

test('stop is safe before start and safe twice', () => {
  // `start` is skipped entirely in development, so `will-quit` calls stop() on
  // an updater that never had a timer.
  const updater = new AppUpdater();
  updater.stop();
  updater.stop();
  assert.equal(updater.timer, null);
});

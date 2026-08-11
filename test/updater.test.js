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

const { AppUpdater, describeUpdate, isUpdateActionable } = require('../src/main/updater');

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

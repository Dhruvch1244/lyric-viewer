'use strict';

/*
  Wallpaper mode (src/main/wallpaper.js).

  The Win32 calls need a desktop and cannot be unit-tested. `pickWorkerW` can,
  and it is the part that matters: Progman spawns two WorkerW windows, one
  hosting the desktop icons and one empty behind them, and picking the wrong one
  does not fail loudly — it puts the visuals IN FRONT of the icons, which is not
  wallpaper mode, or into a window that shows nothing at all.

  Everything else here checks that an unavailable or unrecognised desktop
  declines rather than throwing. This runs in the main process during a mode
  switch; an exception is a crash, and the fallback is a working overlay.
*/

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickWorkerW, attach, detach, isAvailable, unavailableReason,
} = require('../src/main/wallpaper');

/* --- choosing the window to draw into --- */

/** A desktop-sized top-level candidate. */
function big(handle, hasDefView = false) {
  return { handle, hasDefView, width: 1920, height: 1080 };
}

test('the Progman child wins, which is the Windows 11 layout', () => {
  // Measured on this machine: Progman keeps SHELLDLL_DefView itself and owns a
  // full-screen WorkerW child, and THIRTEEN unrelated top-level WorkerW
  // windows exist. The classic rule finds nothing here.
  const found = {
    progmanWorker: 'progmanChild',
    topLevel: [big('stray1'), big('stray2')],
  };
  assert.equal(pickWorkerW(found), 'progmanChild');
});

test('the WorkerW after the icon host is the classic answer', () => {
  const found = {
    progmanWorker: null,
    topLevel: [big('iconHost', true), big('behindIcons')],
  };
  assert.equal(pickWorkerW(found), 'behindIcons');
});

test('the icon host is never chosen', () => {
  // Choosing it would draw over the desktop icons, which is a window covering
  // the desktop rather than a wallpaper.
  const found = {
    progmanWorker: null,
    topLevel: [big('other'), big('iconHost', true), big('behindIcons')],
  };
  assert.equal(pickWorkerW(found), 'behindIcons');
});

test('an icon host with nothing behind it declines', () => {
  const found = { progmanWorker: null, topLevel: [big('iconHost', true)] };
  assert.equal(pickWorkerW(found), null);
});

test('a lone desktop-sized candidate is accepted', () => {
  assert.equal(pickWorkerW({ progmanWorker: null, topLevel: [big('only')] }), 'only');
});

test('the 136x39 strays this machine reports are never chosen', () => {
  // Twelve of the thirteen top-level WorkerW windows here are 136x39 and
  // invisible; they belong to something else entirely. Without a size floor the
  // lone-candidate rule would reparent the overlay into one and report success,
  // and nothing would ever appear.
  const strays = Array.from({ length: 12 }, (_, i) => (
    { handle: `stray${i}`, hasDefView: false, width: 136, height: 39 }
  ));
  assert.equal(pickWorkerW({ progmanWorker: null, topLevel: strays }), null);
  assert.equal(
    pickWorkerW({ progmanWorker: null, topLevel: [...strays, big('real')] }),
    'real',
    'the one desktop-sized candidate among strays is still found',
  );
});

test('several desktop-sized candidates and no icon host declines', () => {
  const found = { progmanWorker: null, topLevel: [big('a'), big('b')] };
  assert.equal(pickWorkerW(found), null);
});

test('no candidates is null, not a throw', () => {
  assert.equal(pickWorkerW({ progmanWorker: null, topLevel: [] }), null);
  assert.equal(pickWorkerW(null), null);
  assert.equal(pickWorkerW(undefined), null);
});

/* --- declining safely --- */

test('a missing window handle is refused with a reason', () => {
  // The caller reports the reason; it must never be an exception, because this
  // runs during a mode switch in the main process.
  for (const bad of [null, undefined, Buffer.alloc(0)]) {
    const res = attach(bad);
    assert.equal(res.ok, false);
    assert.equal(typeof res.reason, 'string');
    assert.ok(res.reason.length > 0);
  }
});

test('detaching a missing handle is refused the same way', () => {
  const res = detach(null);
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, 'string');
});

test('availability is a question with an answer, either way', () => {
  // On Windows with koffi present this binds; anywhere else it must report why
  // rather than leaving the caller to find out by crashing.
  const available = isAvailable();
  assert.equal(typeof available, 'boolean');
  if (!available) {
    assert.equal(typeof unavailableReason(), 'string');
    assert.ok(unavailableReason().length > 0);
  } else {
    assert.equal(unavailableReason(), null);
  }
});

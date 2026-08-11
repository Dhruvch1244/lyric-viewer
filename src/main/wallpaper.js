'use strict';

/*
  Wallpaper mode — render behind the desktop icons instead of over everything.

  WHY. This is the last untouched item on the roadmap's "very high" list, and
  the only one that changes what the app *is* rather than what it does. A
  fullscreen always-on-top overlay is a commitment: you launch it, watch it, and
  close it. Wallpaper Engine's entire proposition is that it is simply there,
  and the same visuals reparented behind the desktop turn this from something
  you start into something that is on.

  HOW IT WORKS, AND WHY IT LOOKS LIKE A TRICK. Windows has no API for "be the
  wallpaper". What it has is Progman, the desktop window, which hosts the icons
  in a SHELLDLL_DefView child. Sending Progman the undocumented message 0x052C
  makes it spawn a WorkerW window and move the icon view into it, leaving a
  second, empty WorkerW *behind* the icons. Reparenting our window into that one
  puts it under the icons and above the wallpaper. This is the technique every
  desktop-wallpaper app on Windows uses, Wallpaper Engine and Lively included;
  there is no supported alternative.

  Because it is undocumented, everything here is defensive. Any step that does
  not find what it expects returns a reason rather than throwing, and the caller
  stays in normal overlay mode. A wallpaper mode that fails to a working overlay
  is a missing feature; one that fails to an invisible window is a bug report
  that says "the app stopped opening".

  WHAT MUST CHANGE ABOUT THE WINDOW. Transparency has to go. There is nothing
  behind the desktop to show through, so a transparent window there renders as
  black — the caller reopens the window opaque for this mode rather than
  reparenting the transparent one.
*/

const HWND_NULL = null;

/** Progman's "spawn a WorkerW" message. Undocumented, and the whole basis. */
const WM_SPAWN_WORKER = 0x052c;

const SMTO_NORMAL = 0x0000;

/*
  Window style bits.

  SetParent alone is not enough, which the first attempt proved on screen: the
  reparent reported success and the overlay still covered the desktop icons AND
  the taskbar, because an Electron window is WS_POPUP and a popup is not clipped
  to its parent — it merely acquires an owner. The window has to actually become
  a child for Windows to draw it inside the desktop surface.
*/
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;

/** SetWindowPos: apply the new style, keep position, size and Z-order. */
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;

/** Bottom of the Z-order, as a pseudo-handle. */
const HWND_BOTTOM = 1;

/** Give Progman a second to answer; it is a message pump, not a network. */
const SPAWN_TIMEOUT_MS = 1000;

/** @type {object|null} lazily-bound user32 functions */
let user32 = null;
/** @type {string|null} why binding failed, for the caller to report */
let bindError = null;

/**
 * Bind the handful of user32 calls this needs. Idempotent.
 *
 * Lazy because koffi loads a native module: a session that never turns on
 * wallpaper mode should not pay for it at startup, and a koffi that fails to
 * load must not take the app down with it.
 *
 * @returns {boolean}
 */
function bind() {
  if (user32) return true;
  if (bindError) return false;
  if (process.platform !== 'win32') {
    bindError = 'wallpaper mode is Windows-only';
    return false;
  }
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    koffi.struct('RECT', {
      left: 'int', top: 'int', right: 'int', bottom: 'int',
    });
    user32 = {
      FindWindowExW: lib.func('void* __stdcall FindWindowExW(void*, void*, const char16_t*, const char16_t*)'),
      SendMessageTimeoutW: lib.func('long __stdcall SendMessageTimeoutW(void*, unsigned int, size_t, size_t, unsigned int, unsigned int, _Out_ size_t*)'),
      SetParent: lib.func('void* __stdcall SetParent(void*, void*)'),
      GetWindowRect: lib.func('bool __stdcall GetWindowRect(void*, _Out_ RECT*)'),
      GetWindowLongPtrW: lib.func('intptr_t __stdcall GetWindowLongPtrW(void*, int)'),
      SetWindowLongPtrW: lib.func('intptr_t __stdcall SetWindowLongPtrW(void*, int, intptr_t)'),
      SetWindowPos: lib.func('bool __stdcall SetWindowPos(void*, void*, int, int, int, int, unsigned int)'),
      koffi,
    };
    return true;
  } catch (err) {
    bindError = `koffi/user32 unavailable: ${err.message}`;
    return false;
  }
}

/** Whether wallpaper mode can be attempted at all. */
function isAvailable() {
  return bind();
}

/** Why it cannot, when it cannot. */
function unavailableReason() {
  bind();
  return bindError;
}

/**
 * Smallest window worth treating as a desktop surface, in pixels.
 *
 * Measured, not guessed: this machine reports THIRTEEN top-level WorkerW
 * windows, and twelve of them are 136x39 and invisible. They have nothing to do
 * with the desktop. Without a size floor the fallback below would cheerfully
 * reparent the overlay into one and report success.
 */
const MIN_DESKTOP_SIDE = 640;

/**
 * Decide which window to reparent into.
 *
 * Pure, and separated from the Win32 calls because it is the only part with
 * real logic and the only part testable without a desktop.
 *
 * There are two desktop layouts in the wild and this app has now met both:
 *
 *   - **Windows 11 (measured here).** Progman keeps SHELLDLL_DefView itself and
 *     owns a full-screen WorkerW *child*. That child is the wallpaper surface,
 *     sitting behind the icon view inside Progman. Every top-level WorkerW on
 *     this machine was a 136x39 stray belonging to something else.
 *
 *   - **The classic layout**, which every write-up of this technique describes:
 *     Progman spawns two TOP-LEVEL WorkerW windows, the first hosting
 *     SHELLDLL_DefView and the second empty behind it. Picking the icon host
 *     there would draw over the icons, which is a window covering the desktop
 *     rather than a wallpaper.
 *
 * The Progman child wins when both are present, because it is the one this was
 * actually verified against.
 *
 * @param {{progmanWorker: unknown|null,
 *          topLevel: Array<{handle: unknown, hasDefView: boolean, width: number, height: number}>}} found
 * @returns {unknown|null} the handle to reparent into
 */
function pickWorkerW(found) {
  if (!found) return null;
  if (found.progmanWorker) return found.progmanWorker;

  const workers = Array.isArray(found.topLevel) ? found.topLevel : [];
  if (workers.length === 0) return null;

  const hostIndex = workers.findIndex((w) => w.hasDefView);
  if (hostIndex >= 0) {
    const behind = workers[hostIndex + 1];
    return behind ? behind.handle : null;
  }

  /*
    No icon host anywhere. A single desktop-sized candidate is still a
    reasonable answer; several, or a tiny one, are not — the wrong choice here
    fails silently as "nothing appears", with no error to explain it.
  */
  const plausible = workers.filter(
    (w) => (w.width || 0) >= MIN_DESKTOP_SIDE && (w.height || 0) >= MIN_DESKTOP_SIDE / 2,
  );
  return plausible.length === 1 ? plausible[0].handle : null;
}

/** @param {unknown} handle @returns {{width: number, height: number}} */
function sizeOf(handle) {
  const r = {};
  try {
    user32.GetWindowRect(handle, r);
    return { width: (r.right - r.left) || 0, height: (r.bottom - r.top) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Ask Progman to spawn its wallpaper surface, then collect the candidates.
 *
 * @returns {{progmanWorker: unknown|null, topLevel: Array<object>, progman: unknown}|null}
 */
function collectWorkers() {
  if (!bind()) return null;
  const progman = user32.FindWindowExW(HWND_NULL, HWND_NULL, 'Progman', null);
  if (!progman) return null;

  /*
    Harmless to send more than once — Progman only spawns the surface if it has
    not already — which matters because the user can toggle this mode on and
    off, and because Explorer restarting takes the WorkerW with it.

    Three parameter pairs, because builds disagree about which one Progman
    listens to. (0,0) is the form every write-up uses; (0xD, 0x1) is what
    Explorer itself sends on Windows 10 and 11, and is the one that works on
    builds where the plain form is ignored. All three are no-ops if the surface
    already exists.
  */
  const out = [null];
  for (const [wParam, lParam] of [[0, 0], [0x000d, 0x0001], [0x000d, 0x0000]]) {
    user32.SendMessageTimeoutW(
      progman, WM_SPAWN_WORKER, wParam, lParam, SMTO_NORMAL, SPAWN_TIMEOUT_MS, out,
    );
  }

  // The Windows 11 layout: a full-screen WorkerW child of Progman itself.
  let progmanWorker = user32.FindWindowExW(progman, HWND_NULL, 'WorkerW', null) || null;
  if (progmanWorker) {
    const { width, height } = sizeOf(progmanWorker);
    // A child that is not desktop-sized is not the wallpaper surface.
    if (width < MIN_DESKTOP_SIDE || height < MIN_DESKTOP_SIDE / 2) progmanWorker = null;
  }

  /* The classic layout, kept as the fallback. FindWindowExW with a null parent
     walks top-level windows in Z-order, which is the order the classic rule
     needs — and it avoids EnumWindows, which would mean a native callback
     across the FFI boundary for no extra information. */
  const topLevel = [];
  let handle = HWND_NULL;
  for (let guard = 0; guard < 64; guard += 1) {
    handle = user32.FindWindowExW(HWND_NULL, handle, 'WorkerW', null);
    if (!handle) break;
    const defView = user32.FindWindowExW(handle, HWND_NULL, 'SHELLDLL_DefView', null);
    topLevel.push({ handle, hasDefView: Boolean(defView), ...sizeOf(handle) });
  }
  return { progmanWorker, topLevel, progman };
}

/**
 * Put a window behind the desktop icons.
 *
 * @param {Buffer} nativeHandle from `BrowserWindow.getNativeWindowHandle()`
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function attach(nativeHandle) {
  if (!bind()) return { ok: false, reason: bindError };
  if (!nativeHandle || nativeHandle.length === 0) {
    return { ok: false, reason: 'no native window handle' };
  }

  const found = collectWorkers();
  if (!found) return { ok: false, reason: 'the desktop window (Progman) was not found' };

  const target = pickWorkerW(found);
  if (!target) {
    return {
      ok: false,
      reason: 'could not identify the desktop surface behind the icons '
        + `(no Progman child, ${found.topLevel.length} top-level candidates)`,
    };
  }

  try {
    const hwnd = user32.koffi.as(nativeHandle, 'void*');

    /* Popup to child, BEFORE the reparent. A WS_POPUP window that is merely
       given a parent is owned by it, not clipped into it — measured: the
       overlay reparented "successfully" and still covered the icons and the
       taskbar. Only WS_CHILD makes Windows draw it inside the desktop surface. */
    const style = Number(user32.GetWindowLongPtrW(hwnd, GWL_STYLE));
    const asChild = (style & ~WS_POPUP) | WS_CHILD;
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, asChild);

    const previous = user32.SetParent(hwnd, target);

    /* The style change only takes effect once the frame is recalculated, and
       the same call sinks the window to the bottom of its new parent's
       Z-order — being a child of the desktop surface is not enough on its own
       if it sits above the icon view inside it. */
    user32.SetWindowPos(hwnd, user32.koffi.as(HWND_BOTTOM, 'void*'), 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);

    /* SetParent returns the OLD parent, and null means it failed — but null is
       also a legitimate old parent for a top-level window, so it cannot be used
       as the success test. Nothing here throws, so reaching this line is the
       signal; the wrong target shows up as "nothing on the desktop", which is
       why picking it is done carefully above rather than checked after. */
    return { ok: true, previousParent: previous, previousStyle: style };
  } catch (err) {
    return { ok: false, reason: `reparent failed: ${err.message}` };
  }
}

/**
 * Return a window to the desktop's top level.
 *
 * @param {Buffer} nativeHandle
 * @returns {{ok: boolean, reason?: string}}
 */
function detach(nativeHandle) {
  if (!bind()) return { ok: false, reason: bindError };
  if (!nativeHandle || nativeHandle.length === 0) {
    return { ok: false, reason: 'no native window handle' };
  }
  try {
    const hwnd = user32.koffi.as(nativeHandle, 'void*');
    user32.SetParent(hwnd, HWND_NULL);
    // Back to a popup, or the orphaned child never draws again.
    const style = Number(user32.GetWindowLongPtrW(hwnd, GWL_STYLE));
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP);
    user32.SetWindowPos(hwnd, null, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `reparent failed: ${err.message}` };
  }
}

module.exports = {
  attach, detach, isAvailable, unavailableReason, pickWorkerW,
  WM_SPAWN_WORKER,
};

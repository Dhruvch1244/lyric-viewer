'use strict';

const { Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');

/*
  System tray icon and background-work notifications.

  The overlay has no window chrome and hides itself on a hotkey, so once it is
  running there is nothing on screen that says it exists. A tray icon is the
  conventional answer, and it also gives the app somewhere to put "what is it
  doing right now" — work that takes minutes (downloading a speech model,
  transcribing a song) previously reported only into a status line inside a HUD
  that is invisible until the cursor moves.

  ON NOTIFYING SPARINGLY. Only transcription completing raises an OS
  notification. "Finding lyrics" fires on literally every track and would train
  the user to dismiss everything this app ever says; the tray tooltip carries
  the rest, where it costs nothing to ignore.
*/

/** Jobs worth an OS-level notification when they finish. */
const NOTIFY_ON_DONE = new Set(['transcribe']);

class AppTray {
  /**
   * @param {object} opts
   * @param {() => void} opts.onToggleWindow
   * @param {() => void} opts.onQuit
   */
  constructor(opts) {
    this.onToggleWindow = opts.onToggleWindow;
    this.onQuit = opts.onQuit;
    /** @type {Tray|null} */
    this.tray = null;
    this.track = null;
    this.jobs = [];
  }

  /** Create the icon. Safe to call once app is ready. */
  start() {
    if (this.tray) return;
    const icon = nativeImage
      .createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'))
      // Windows tray art is 16px; handing it a 512px source gives a blurry mess.
      .resize({ width: 16, height: 16 });
    try {
      this.tray = new Tray(icon);
    } catch (err) {
      // A tray is a convenience; never let its absence stop the app starting.
      console.error('[tray] unavailable:', err.message);
      return;
    }
    this.tray.on('click', () => this.onToggleWindow());
    this.refresh();
  }

  /**
   * The song now playing, for the tooltip and menu.
   * @param {{title?: string, artist?: string}|null} track
   */
  setTrack(track) {
    this.track = track;
    this.refresh();
  }

  /**
   * Background work in progress, as the renderer reports it.
   * @param {Array<{id: string, label: string}>} jobs
   */
  setJobs(jobs) {
    this.jobs = Array.isArray(jobs) ? jobs : [];
    this.refresh();
  }

  /**
   * A job finished. Raises a notification only for the few that are worth
   * interrupting for — see NOTIFY_ON_DONE.
   * @param {string} id @param {string} label
   */
  jobFinished(id, label) {
    if (!NOTIFY_ON_DONE.has(id)) return;
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Lyric Overlay',
      body: label,
      silent: true,        // it is information, not an alarm
    }).show();
  }

  /** Rebuild the tooltip and context menu from current state. */
  refresh() {
    if (!this.tray) return;
    const now = this.track && this.track.title
      ? `${this.track.title}${this.track.artist ? ` — ${this.track.artist}` : ''}`
      : 'Nothing playing';
    const work = this.jobs.length ? this.jobs.map((j) => j.label).join(' · ') : '';

    this.tray.setToolTip(work ? `Lyric Overlay\n${now}\n${work}` : `Lyric Overlay\n${now}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: now, enabled: false },
      ...(work ? [{ label: work, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Show / hide overlay', click: () => this.onToggleWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.onQuit() },
    ]));
  }

  destroy() {
    if (this.tray) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { AppTray, NOTIFY_ON_DONE };

//! Native "now playing" detection on Linux via MPRIS over the D-Bus session bus.
//!
//! The Linux counterpart of `smtc.rs`: every mainstream player (Spotify,
//! Firefox/Chromium tabs, VLC, mpv-mpris, ...) publishes a
//! `org.mpris.MediaPlayer2.<name>` bus name, and this reads the same fields
//! SMTC gives on Windows into the same `Session`, so the poll loop in
//! `watchers.rs` and everything downstream is platform-blind.
//!
//! Shape of the reads: one `Properties.GetAll` per player per poll rather than
//! zbus's cached `Proxy` properties. MPRIS players do not emit
//! `PropertiesChanged` for `Position` (the spec says so, to avoid spamming the
//! bus), so a cached proxy would hand back a position frozen at the last
//! play/pause/seek and freeze every synced lyric with it. `GetAll` is a single
//! round trip that also carries status and metadata, so there is no separate
//! slower metadata cadence like SMTC needs. `staleness_ms` is therefore always
//! 0: the position was read this instant.

#![cfg(target_os = "linux")]

use std::collections::HashMap;

use zbus::blocking::{fdo::DBusProxy, Connection};
use zbus::zvariant::OwnedValue;

use crate::state::Session;

const BUS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPERTIES_IFACE: &str = "org.freedesktop.DBus.Properties";

pub struct Watcher {
    conn: Connection,
}

/// `mpris:length` is specified as int64 but some players (Spotify among them)
/// send uint64, so accept either.
fn as_i64(v: OwnedValue) -> Option<i64> {
    let again = v.try_clone().ok()?;
    i64::try_from(v)
        .ok()
        .or_else(|| u64::try_from(again).ok().and_then(|n| i64::try_from(n).ok()))
}

/// `xesam:artist` is a string list; a few players send a bare string instead.
fn artist_of(v: OwnedValue) -> String {
    let again = match v.try_clone() {
        Ok(a) => a,
        Err(_) => return String::new(),
    };
    match Vec::<String>::try_from(v) {
        Ok(list) => list.join(", "),
        Err(_) => String::try_from(again).unwrap_or_default(),
    }
}

/// `org.mpris.MediaPlayer2.firefox.instance_1_23` -> `firefox`.
fn app_name(bus_name: &str) -> String {
    let rest = bus_name.strip_prefix(BUS_PREFIX).unwrap_or(bus_name);
    rest.split('.').next().unwrap_or(rest).to_string()
}

/// Higher wins: an actively playing player beats a paused one, which beats a
/// stopped one — "the current session" in SMTC terms.
fn status_rank(status: &str) -> u8 {
    match status {
        "Playing" => 2,
        "Paused" => 1,
        _ => 0,
    }
}

impl Watcher {
    /// Connect to the session bus. Fails only when there is no bus at all
    /// (headless, no `DBUS_SESSION_BUS_ADDRESS`), in which case the caller
    /// leaves detection off rather than retrying forever.
    pub fn new() -> zbus::Result<Self> {
        Ok(Watcher { conn: Connection::session()? })
    }

    fn sample_player(&self, bus_name: &str) -> zbus::Result<Option<Session>> {
        let reply = self.conn.call_method(
            Some(bus_name),
            OBJECT_PATH,
            Some(PROPERTIES_IFACE),
            "GetAll",
            &(PLAYER_IFACE,),
        )?;
        let mut props: HashMap<String, OwnedValue> = reply.body().deserialize()?;

        let status = props
            .remove("PlaybackStatus")
            .and_then(|v| String::try_from(v).ok())
            .unwrap_or_else(|| "Stopped".to_string());
        let position_us = props.remove("Position").and_then(as_i64).unwrap_or(0);

        let mut meta = props
            .remove("Metadata")
            .and_then(|v| <HashMap<String, OwnedValue>>::try_from(v).ok())
            .unwrap_or_default();
        let title = meta
            .remove("xesam:title")
            .and_then(|v| String::try_from(v).ok())
            .unwrap_or_default();
        let artist = meta.remove("xesam:artist").map(artist_of).unwrap_or_default();
        let album = meta
            .remove("xesam:album")
            .and_then(|v| String::try_from(v).ok())
            .unwrap_or_default();
        let length_us = meta.remove("mpris:length").and_then(as_i64).unwrap_or(0);

        // A player that is open but has loaded nothing (idle Spotify window)
        // is not a session worth showing.
        if title.is_empty() && artist.is_empty() {
            return Ok(None);
        }

        Ok(Some(Session {
            source_app: app_name(bus_name),
            title,
            artist,
            album,
            status,
            position_ms: (position_us / 1000).max(0),
            end_ms: (length_us / 1000).max(0),
            staleness_ms: 0,
        }))
    }

    /// Sample the best current player. `Ok(None)` means nothing is playing;
    /// `Err` is a transient bus failure the caller skips rather than treating
    /// as "playback stopped" (see `run_poll_loop`).
    pub fn poll(&mut self) -> zbus::Result<Option<Session>> {
        let names = DBusProxy::new(&self.conn)?.list_names()?;
        let mut best: Option<Session> = None;
        for name in names {
            let name = name.to_string();
            // playerctld mirrors whichever player is current, which would
            // report the same track twice.
            if !name.starts_with(BUS_PREFIX) || name.contains("playerctld") {
                continue;
            }
            // A player can exit between list_names and GetAll; that one
            // vanishing is not a reason to fail the whole poll.
            let Ok(Some(candidate)) = self.sample_player(&name) else { continue };
            let better = match &best {
                None => true,
                Some(b) => status_rank(&candidate.status) > status_rank(&b.status),
            };
            if better {
                best = Some(candidate);
            }
        }
        Ok(best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_name_drops_the_prefix_and_any_instance_suffix() {
        assert_eq!(app_name("org.mpris.MediaPlayer2.spotify"), "spotify");
        assert_eq!(app_name("org.mpris.MediaPlayer2.firefox.instance_1_23"), "firefox");
    }

    #[test]
    fn playing_outranks_paused_outranks_stopped() {
        assert!(status_rank("Playing") > status_rank("Paused"));
        assert!(status_rank("Paused") > status_rank("Stopped"));
    }

    /// Live: needs a running MPRIS player on the session bus.
    /// `cargo test --workspace -- --ignored live_mpris --nocapture`
    #[test]
    #[ignore]
    fn live_mpris_reports_the_running_player() {
        let mut w = Watcher::new().expect("session bus");
        let s = w.poll().expect("poll").expect("a player should be running");
        println!("{} - {} [{}] {}ms/{}ms", s.artist, s.title, s.status, s.position_ms, s.end_ms);
        assert!(!s.title.is_empty());
    }
}

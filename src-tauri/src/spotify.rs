//! Spotify OAuth (Authorization Code + PKCE) and playlist import, feeding
//! straight into the existing `presync_list` pipeline (lib.rs) rather than
//! duplicating the lyric-fetch logic — this module's only job is turning a
//! Spotify login into a plain "Artist - Title" text block.
//!
//! REDIRECT: a local loopback HTTP listener (`http://127.0.0.1:<port>/callback`),
//! not a custom URI scheme. tauri-plugin-deep-link has a known, confirmed bug
//! where the OS never delivers the redirect to NSIS builds (only MSI) — and
//! NSIS is the GitHub-distributed installer, so that would break this for
//! most users. A loopback redirect needs no OS protocol registration at all,
//! and is what RFC 8252 ("OAuth 2.0 for Native Apps") recommends over custom
//! schemes anyway — not a workaround, the better-engineered choice.
//!
//! No refresh token is persisted: the access token lives in memory for the
//! session only. Importing a playlist is an occasional, deliberate action,
//! not something that needs to survive a restart — one more OAuth click on
//! next use is a fair trade for not writing a Spotify credential to disk.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const SCOPE: &str = "playlist-read-private playlist-read-collaborative";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

pub struct SpotifyToken {
    pub access_token: String,
    pub expires_at: Instant,
}

/// App-managed state: `Mutex<Option<SpotifyToken>>`, set once `authorize()`
/// completes. `None` means "not connected this session".
pub type TokenState = Mutex<Option<SpotifyToken>>;

fn client_id() -> Option<String> {
    std::env::var("SPOTIFY_CLIENT_ID").ok().filter(|s| !s.trim().is_empty())
}

/// A random, URL-safe PKCE code verifier (RFC 7636 wants 43-128 chars from
/// `[A-Za-z0-9-._~]`; 96 is comfortably inside that with plenty of entropy).
fn random_verifier() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::rng();
    (0..96).map(|_| CHARS[rng.random_range(0..CHARS.len())] as char).collect()
}

fn code_challenge(verifier: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Bind a loopback listener on an OS-assigned free port. Returns the port and
/// listener together since the redirect URI has to name the exact port
/// before the browser ever opens.
fn bind_loopback() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Accept exactly one connection, pull `code` (or `error`) off the request
/// line's query string, and answer with a small human-readable page — the
/// browser tab is what the user is looking at in the moment, so it should say
/// something rather than hang or 404.
fn await_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(false).ok();
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for the Spotify login".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| format!("loopback accept failed: {e}"))?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            continue; // a stray connection with nothing to read; keep waiting
        }
        // "GET /callback?code=...&state=... HTTP/1.1"
        let path = request_line.split_whitespace().nth(1).unwrap_or("");
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let params = parse_query(query);

        let (status_line, body) = if params.get("error").is_some() {
            ("HTTP/1.1 200 OK", "<html><body>Spotify sign-in was cancelled. You can close this tab.</body></html>")
        } else if params.get("state").map(String::as_str) != Some(expected_state) {
            ("HTTP/1.1 400 Bad Request", "<html><body>Sign-in state mismatch — please try again from the app.</body></html>")
        } else if let Some(code) = params.get("code") {
            let resp = format!(
                "{status_line}\r\nContent-Type: text/html\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                status_line = "HTTP/1.1 200 OK",
                len = SUCCESS_BODY.len(),
                body = SUCCESS_BODY,
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            return Ok(code.clone());
        } else {
            ("HTTP/1.1 400 Bad Request", "<html><body>No authorization code in the redirect.</body></html>")
        };
        let resp = format!(
            "{status_line}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        if params.get("code").is_none() {
            return Err("Spotify sign-in did not complete".into());
        }
    }
}

const SUCCESS_BODY: &str =
    "<html><body style=\"font-family:sans-serif;padding:2rem\">Connected — you can close this tab and go back to Lyric Overlay.</body></html>";

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((url_decode(k), url_decode(v)))
        })
        .collect()
}

/// Minimal `application/x-www-form-urlencoded` decode — just `%XX` and `+`,
/// which is all a Spotify redirect's query string ever contains.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn exchange_code(code: &str, verifier: &str, redirect_uri: &str, client_id: &str) -> Result<SpotifyToken, String> {
    let form = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        urlencoding_component(code),
        urlencoding_component(redirect_uri),
        urlencoding_component(client_id),
        urlencoding_component(verifier),
    );
    let resp = ureq::post(TOKEN_URL)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .timeout(HTTP_TIMEOUT)
        .send_string(&form);
    let data: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| format!("token decode: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("token exchange {code}: {}", detail.chars().take(200).collect::<String>()));
        }
        Err(e) => return Err(format!("token exchange transport: {e}")),
    };
    let access_token = data.get("access_token").and_then(|v| v.as_str()).ok_or("no access_token in response")?;
    let expires_in = data.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    Ok(SpotifyToken {
        access_token: access_token.to_string(),
        expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(30)), // refresh 30s early
    })
}

/// `x-www-form-urlencoded` component encoding — narrower than a general URI
/// encoder, but that's all a token-exchange body needs.
fn urlencoding_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Drops the overlay's always-on-top for the lifetime of the guard, restoring
/// it on drop (success, error, or an early `?` return — RAII covers all of
/// them, unlike a plain "restore at the end" which a `?` would skip).
///
/// This is the actual fix for "the browser doesn't load right": the overlay
/// window is `alwaysOnTop: true` by design, so a browser window Spotify's
/// login opens in — a completely normal, unrelated top-level window — was
/// opening BEHIND the overlay the whole time. Not a lag, not a failed open;
/// invisible and unclickable behind an always-on-top surface. Same shape of
/// bug as wallpaper mode's own interactive-surface lift, just for a window
/// belonging to a different process this time.
struct AlwaysOnTopGuard<'a> {
    window: Option<tauri::WebviewWindow>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> AlwaysOnTopGuard<'a> {
    fn engage(app: &'a tauri::AppHandle) -> Self {
        let window = app.get_webview_window("main");
        if let Some(w) = &window {
            let _ = w.set_always_on_top(false);
        }
        AlwaysOnTopGuard { window, _marker: std::marker::PhantomData }
    }
}

impl<'a> Drop for AlwaysOnTopGuard<'a> {
    fn drop(&mut self) {
        if let Some(w) = &self.window {
            let _ = w.set_always_on_top(true);
        }
    }
}

/// Run the whole PKCE + loopback + browser + token-exchange flow. Blocking —
/// call this on its own thread, never from a command handler directly, since
/// it waits on the user's browser for up to `CALLBACK_TIMEOUT`.
pub fn authorize(app: &tauri::AppHandle) -> Result<SpotifyToken, String> {
    let cid = client_id().ok_or("no SPOTIFY_CLIENT_ID set — paste one into the 🔑 panel")?;
    let verifier = random_verifier();
    let challenge = code_challenge(&verifier);
    let state = random_verifier(); // reused as a plain anti-CSRF nonce, not PKCE-related

    let (listener, port) = bind_loopback().map_err(|e| format!("could not open a local port: {e}"))?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "{AUTH_URL}?client_id={}&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge={}&scope={}&state={}",
        urlencoding_component(&cid),
        urlencoding_component(&redirect_uri),
        urlencoding_component(&challenge),
        urlencoding_component(SCOPE),
        urlencoding_component(&state),
    );

    // Engaged before opening the browser, dropped (restoring always-on-top)
    // when this function returns by any path — the browser needs to be
    // choosable/clickable for the whole login, not just the first instant.
    let _surfaced = AlwaysOnTopGuard::engage(app);

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(&auth_url, None::<&str>).map_err(|e| format!("could not open the browser: {e}"))?;
    }

    let code = await_callback(listener, &state)?;
    exchange_code(&code, &verifier, &redirect_uri, &cid)
}

fn bearer(token: &SpotifyToken) -> String {
    format!("Bearer {}", token.access_token)
}

/// The current user's playlists — id, name, and track count (for the picker).
pub fn list_playlists(token: &SpotifyToken) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut url = "https://api.spotify.com/v1/me/playlists?limit=50".to_string();
    loop {
        let resp = ureq::get(&url).set("Authorization", &bearer(token)).timeout(HTTP_TIMEOUT).call();
        let data: Value = match resp {
            Ok(r) => r.into_json().map_err(|e| format!("playlists decode: {e}"))?,
            Err(ureq::Error::Status(code, r)) => {
                return Err(format!("playlists {code}: {}", r.into_string().unwrap_or_default().chars().take(160).collect::<String>()));
            }
            Err(e) => return Err(format!("playlists transport: {e}")),
        };
        for item in data.get("items").and_then(|v| v.as_array()).into_iter().flatten() {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let track_count = item.pointer("/tracks/total").and_then(|v| v.as_u64()).unwrap_or(0);
            out.push(json!({ "id": id, "name": name, "trackCount": track_count }));
        }
        match data.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }
    Ok(out)
}

/// A playlist's tracks as "Artist - Title" lines, ready for `presync_list`.
/// Local/unavailable/podcast-episode entries are skipped — `presync_list`
/// wants songs, and a null `track` (removed from Spotify) or an episode has
/// no artist/title shape worth guessing at.
pub fn playlist_tracks_as_text(token: &SpotifyToken, playlist_id: &str) -> Result<String, String> {
    let mut lines = Vec::new();
    let mut url = format!(
        "https://api.spotify.com/v1/playlists/{playlist_id}/tracks?limit=100&fields=next,items(track(name,type,artists(name)))"
    );
    loop {
        let resp = ureq::get(&url).set("Authorization", &bearer(token)).timeout(HTTP_TIMEOUT).call();
        let data: Value = match resp {
            Ok(r) => r.into_json().map_err(|e| format!("tracks decode: {e}"))?,
            Err(ureq::Error::Status(code, r)) => {
                return Err(format!("tracks {code}: {}", r.into_string().unwrap_or_default().chars().take(160).collect::<String>()));
            }
            Err(e) => return Err(format!("tracks transport: {e}")),
        };
        for item in data.get("items").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(track) = item.get("track") else { continue };
            if track.get("type").and_then(|v| v.as_str()) != Some("track") {
                continue; // episodes, local files, and removed tracks report other shapes
            }
            let title = track.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let artist = track
                .pointer("/artists/0/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if title.is_empty() {
                continue;
            }
            lines.push(if artist.is_empty() { title.to_string() } else { format!("{artist} - {title}") });
        }
        match data.get("next").and_then(|v| v.as_str()) {
            Some(next) => url = next.to_string(),
            None => break,
        }
    }
    Ok(lines.join("\n"))
}

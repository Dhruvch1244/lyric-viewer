//! Auto-update for the Arch package (`--features distro`).
//!
//! The Tauri updater cannot serve this build: it replaces the running binary
//! in place, and here `/usr/bin/lyric-overlay` belongs to pacman. So the Arch
//! build had no updates at all — a new release only reached it if the user
//! went and downloaded it. This gives it the same experience the other builds
//! have, the pacman way:
//!
//!   1. Read the same `latest.json` the Tauri updater reads, from the latest
//!      GitHub release, for the version and its notes.
//!   2. If newer, download that release's `.pkg.tar.zst` and its `.sig` in the
//!      background.
//!   3. Verify the signature against the updater public key in tauri.conf.json,
//!      with `minisign-verify` — the same key, format and library the Tauri
//!      updater uses for every other platform. release.yml signs the package
//!      with the same private key. An unsigned or tampered package is refused.
//!   4. Prompt; on "Install & restart", run `pkexec pacman -U` on the verified
//!      file. pkexec shows the desktop's own password dialog, and pacman keeps
//!      owning the install — the package database stays correct.
//!
//! The release also carries a pacman repository (`lyric-overlay.db`, see
//! release.yml), so users who add it to pacman.conf get updates through
//! `pacman -Syu` and whatever their distro runs for that. Either path installs
//! the same signed-off package.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const REPO: &str = "Dhruvch1244/lyric-viewer";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// `major.minor.patch` → comparable tuple. Hand-rolled ("std first"): the
/// versions here are always three plain numbers from tauri.conf.json.
pub(crate) fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.split(['-', '+']).next()?.parse().ok()?;
    Some((major, minor, patch))
}

pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((parse_version(candidate), parse_version(current)), (Some(a), Some(b)) if a > b)
}

/// Verify a Tauri-format signature: both the public key and the `.sig` file
/// are base64 of minisign's text format. Mirrors tauri-plugin-updater's own
/// check, so one key pair signs every platform's update.
pub(crate) fn verify(data: &[u8], sig_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_text = String::from_utf8(b64.decode(pubkey_b64.trim()).map_err(|e| format!("bad public key: {e}"))?)
        .map_err(|e| format!("bad public key: {e}"))?;
    let sig_text = String::from_utf8(b64.decode(sig_b64.trim()).map_err(|e| format!("bad signature file: {e}"))?)
        .map_err(|e| format!("bad signature file: {e}"))?;
    let pk = minisign_verify::PublicKey::decode(&pk_text).map_err(|e| format!("bad public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("bad signature: {e}"))?;
    pk.verify(data, &sig, true).map_err(|e| format!("signature does not match: {e}"))
}

/// What a newer release offers this build.
pub(crate) struct Available {
    pub(crate) version: String,
    pub(crate) notes: String,
}

/// The newest release's version and notes, if it is newer than this build.
pub(crate) fn check(app: &AppHandle) -> Result<Option<Available>, String> {
    let url = format!("https://github.com/{REPO}/releases/latest/download/latest.json");
    let manifest: Value = ureq::get(&url)
        .timeout(TIMEOUT)
        .call()
        .map_err(|e| format!("update check failed: {e}"))?
        .into_json()
        .map_err(|e| format!("update manifest unreadable: {e}"))?;
    let version = manifest["version"].as_str().unwrap_or_default().to_string();
    let current = app.package_info().version.to_string();
    if !is_newer(&version, &current) {
        return Ok(None);
    }
    let notes = manifest["notes"].as_str().unwrap_or_default().to_string();
    Ok(Some(Available { version, notes }))
}

fn package_name(version: &str) -> String {
    format!("lyric-overlay-{version}-1-{}.pkg.tar.zst", std::env::consts::ARCH)
}

fn fetch(url: &str, dest: &Path, mut on_progress: impl FnMut(u8)) -> Result<(), String> {
    let resp = ureq::get(url).timeout(TIMEOUT).call().map_err(|e| format!("download failed: {e}"))?;
    let total = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let tmp = dest.with_extension("part");
    let mut out = std::fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        read += n as u64;
        if let Some(pct) = (read * 100).checked_div(total) {
            on_progress(pct.min(99) as u8);
        }
    }
    drop(out);
    std::fs::rename(&tmp, dest).map_err(|e| format!("cannot write {}: {e}", dest.display()))
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn pubkey(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "no updater public key in the app config".into())
}

/// Download and verify `version`'s package. Returns the verified file, which
/// is the only thing `install` will hand to pacman.
pub(crate) fn download(app: &AppHandle, version: &str, on_progress: impl FnMut(u8)) -> Result<PathBuf, String> {
    let dir = update_dir(app)?;
    // Older downloads are of no further use once a newer one is wanted.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    let name = package_name(version);
    let base = format!("https://github.com/{REPO}/releases/download/v{version}");
    let pkg = dir.join(&name);
    fetch(&format!("{base}/{name}"), &pkg, on_progress)?;
    let sig = ureq::get(&format!("{base}/{name}.sig"))
        .timeout(TIMEOUT)
        .call()
        .map_err(|e| format!("no signature for {name}: {e}"))?
        .into_string()
        .map_err(|e| format!("signature unreadable: {e}"))?;
    let data = std::fs::read(&pkg).map_err(|e| e.to_string())?;
    if let Err(e) = verify(&data, &sig, &pubkey(app)?) {
        let _ = std::fs::remove_file(&pkg);
        return Err(format!("refusing {name}: {e}"));
    }
    Ok(pkg)
}

/// Install a verified package through pacman, asking for the password with
/// the desktop's own polkit dialog. Blocking; run off the main thread.
pub(crate) fn install(pkg: &Path) -> Result<(), String> {
    let status = std::process::Command::new("pkexec")
        .args(["pacman", "-U", "--noconfirm"])
        .arg(pkg)
        .status()
        .map_err(|e| format!("cannot run pkexec (is polkit installed?): {e}"))?;
    match status.code() {
        Some(0) => Ok(()),
        // pkexec's own codes: the dialog was dismissed, or not authorised.
        Some(126) | Some(127) => Err("the password prompt was cancelled".into()),
        _ => Err(format!("pacman could not install the update ({status})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway key pair made with `tauri signer generate`, and a signature
    // of DATA made with `tauri signer sign` — the exact tool release.yml signs
    // the real package with. Not the app's key.
    const PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdENjEyMUREMkUxN0I3RTUKUldUbHR4Y3UzU0ZoZlVIam9HMmd2T0w2N05pK2c5TGVGNWx5b1VRNEQ5V2pLMGhwdUUrRmczaTgK";
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUbHR4Y3UzU0ZoZmRHZVFtcXFKOWlzSVB2UVQvS2lDVGphTjZmcjNzMzhrNnFDdHNJU0RGclpQYWlRSzhvVFlUNE9HSzhEblY5bFlkZEwxM1Y5bTJjc2RzWjREcHlNbUFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzNTQzNzk4CWZpbGU6cGtnLmJpbgoyMVAyQ2pDM2d0TExiSU5XSE5uTUJjWjhRWEt1SnJXOURKblVadzM3MUxobmhCRVpUb0NTRlFFSEJjNXEvV2xRb2hja3hydHd1SkpKZ3ArSW95OENEQT09Cg==";
    const DATA: &[u8] = b"lyric-overlay test package\n";

    #[test]
    fn a_genuine_signature_verifies() {
        verify(DATA, SIG, PUB).expect("signed by the test key");
    }

    #[test]
    fn a_tampered_package_is_refused() {
        let err = verify(b"lyric-overlay test packagf\n", SIG, PUB).unwrap_err();
        assert!(err.contains("does not match"), "{err}");
    }

    #[test]
    fn a_package_signed_by_another_key_is_refused() {
        // The app's real key did not sign DATA.
        let app_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM1M0E0NTc3Q0Q3OTFGMTIKUldRU0gzbk5kMFU2eFIzUXJQam1WZDJoQ252cFd6TE82TTROSm1CdFdwVDVIYXRMaVFQVFZJN0cK";
        assert!(verify(DATA, SIG, app_key).is_err());
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(verify(DATA, "not base64 !!", PUB).is_err());
        assert!(verify(DATA, SIG, "").is_err());
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.60.0", "0.59.0"));
        assert!(is_newer("0.59.10", "0.59.9"), "not a string compare");
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(!is_newer("0.59.0", "0.59.0"));
        assert!(!is_newer("0.58.3", "0.59.0"));
        assert!(!is_newer("garbage", "0.59.0"));
    }

    #[test]
    fn the_package_name_matches_what_makepkg_writes() {
        // PKGBUILD: pkgname=lyric-overlay, pkgrel=1, arch=(x86_64 ...).
        if std::env::consts::ARCH == "x86_64" {
            assert_eq!(package_name("0.60.0"), "lyric-overlay-0.60.0-1-x86_64.pkg.tar.zst");
        }
    }
}

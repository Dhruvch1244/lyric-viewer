//! Downloads and verifies the ONNX artefacts the inference sidecar needs.
//!
//! `inference.rs::model_dir` has said "downloaded on first use" in its own
//! doc comment since Phase 3 stage 1 landed — this is that download. Before
//! this module existed, nothing in the app ever wrote a file into that
//! directory, so every real transcription attempt on a fresh install failed
//! deep inside the sidecar with "model file not found", which is correct but
//! unhelpful: the fix was never "reinstall", it was "nothing ever fetched the
//! model in the first place".
//!
//! Mirrors the shape `src/renderer/whisper.js` already established for the
//! WASM path — model fetched lazily, on the first transcription that needs
//! it, cached on disk after that — so this is not new user-facing behaviour,
//! only a new implementation of behaviour the app already had.
//!
//! Every file is pinned to an exact source revision (a commit SHA, not a
//! branch) and checked against a SHA-256 recorded here, for the same reason
//! `mel.rs`'s reference numbers are pinned to a specific transformers.js
//! version: "the file at this URL" is not a stable identity on its own, and a
//! silently different file would make **transcription** silently wrong
//! rather than fail loudly.
//!
//! Verification only happens right after a download — an already-present file
//! is trusted on size alone, which is what keeps `ensure` cheap enough to call
//! before every transcription rather than only at install time.

use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

/// One artefact, pinned to an exact revision, with the SHA-256 and byte size
/// measured from a real download so a mismatch cannot be silently "close
/// enough".
pub(crate) struct ModelFile {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

// `onnx-community/whisper-base_timestamped` at commit
// 608c49e61301901684bc36cac8f74b95ff6b5a8e. `_timestamped` is not a
// preference — the ordinary `whisper-base` export has no cross-attention
// output, so word timing is impossible against it. See sidecar/src/whisper.rs
// and the `whisper.js` fix that hit the same fact from the WebView side.
//
// `snakers4/silero-vad` at commit bfdc0193023f121ea5b3cc7b176dbed570a68a59
// for silero_vad.onnx — GitHub's `raw/master` URL would let the file change
// under this app without warning, so it is pinned the same way.
const FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder_model_quantized.onnx",
        url: "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/608c49e61301901684bc36cac8f74b95ff6b5a8e/onnx/encoder_model_quantized.onnx",
        sha256: "2714484ebe1bae7c1646e8eadb768bb9d415cf11763466d21f23039a29c62e6f",
        size: 23_159_167,
    },
    ModelFile {
        name: "decoder_model_merged_quantized.onnx",
        url: "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/608c49e61301901684bc36cac8f74b95ff6b5a8e/onnx/decoder_model_merged_quantized.onnx",
        sha256: "cf9a8d5bcddc0917a0078135b484cedcaf44f28909cd91910abd29dced9171db",
        size: 53_712_708,
    },
    ModelFile {
        name: "tokenizer.json",
        url: "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/608c49e61301901684bc36cac8f74b95ff6b5a8e/tokenizer.json",
        sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
        size: 2_480_466,
    },
    ModelFile {
        name: "config.json",
        url: "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/608c49e61301901684bc36cac8f74b95ff6b5a8e/config.json",
        sha256: "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b",
        size: 2_243,
    },
    ModelFile {
        name: "generation_config.json",
        url: "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/608c49e61301901684bc36cac8f74b95ff6b5a8e/generation_config.json",
        sha256: "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0",
        size: 3_832,
    },
    SILERO_VAD,
];

/// Silero VAD, shared by transcription and diarization.
///
/// Pulled out as its own const because both model sets need it and pinning
/// the same file twice invites the two copies drifting to different commits.
/// `already_present` means whichever feature is used first pays for it and the
/// other finds it on disk.
const SILERO_VAD: ModelFile = ModelFile {
    name: "silero_vad.onnx",
    url: "https://github.com/snakers4/silero-vad/raw/bfdc0193023f121ea5b3cc7b176dbed570a68a59/src/silero_vad/data/silero_vad.onnx",
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    size: 2_327_524,
};

/// Speaker diarization's model (`diarize.rs`, sidecar), kept as its own list
/// rather than folded into `FILES`: diarization is a separate, optional,
/// exploratory capability (ROADMAP.md §5.8), not part of transcription, and
/// bundling its ~25MB into the download the existing consent prompt already
/// describes ("Whisper + a voice detector") would make that prompt wrong for
/// everyone who only ever wants synced lyrics.
///
/// `Alkd/speaker-embedding-onnx` — an ONNX export of the ResNet34 backbone
/// from `pyannote/wespeaker-voxceleb-resnet34-LM`, the same model pyannote's
/// own diarization pipeline uses. Picked over the SpeechBrain ECAPA-TDNN
/// alternative considered alongside it because its required feature
/// front end (Kaldi fbank) is fully specified inline on the model card, with
/// no opaque auxiliary binary to reverse-engineer. Downloaded and run
/// end-to-end (`sidecar/src/diarize.rs`'s `#[ignore]`d live test) before
/// being pinned here — real SHA-256, not copied from the card.
/// Silero is in here as well as in `FILES`, and that is load-bearing rather
/// than duplication: diarization runs the VAD first so it never embeds an
/// instrumental passage (see `sidecar/src/diarize.rs`), so a user who has only
/// ever diarized still needs it. Whichever feature runs first downloads it.
const DIARIZATION_FILES: &[ModelFile] = &[
    ModelFile {
        name: "speaker-embedding-resnet34.onnx",
        url: "https://huggingface.co/Alkd/speaker-embedding-onnx/resolve/edf8e8c67f02ad879326f49af2bd17d56612e88c/model.onnx",
        sha256: "fe9ad5d8200b998ab627916b27e792f03f72b514867f8f60c79fff98fda6e395",
        size: 26_542_869,
    },
    SILERO_VAD,
];

const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Make sure every model file in `files` is present and correctly sized,
/// downloading (and verifying) whatever is missing.
///
/// Called on the Inference lane, right before a transcription — the lane is
/// already concurrency-1 and already blocks for the length of a whole decode,
/// so blocking it further for a one-time download costs nothing structural.
/// `on_progress` receives the file currently downloading and 0..100 within
/// it; callers with several files to fetch will see it called several times.
/// `cancelled` is checked between chunks, so a track change mid-download
/// stops it within one buffer's worth of bytes rather than running to
/// completion for a song that is no longer playing.
pub(crate) fn ensure(
    model_dir: &Path,
    files: &[ModelFile],
    mut on_progress: impl FnMut(&str, u8),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    std::fs::create_dir_all(model_dir).map_err(|e| format!("cannot create {}: {e}", model_dir.display()))?;
    for file in files {
        let path = model_dir.join(file.name);
        if already_present(&path, file) {
            continue;
        }
        download(file, &path, |pct| on_progress(file.name, pct), cancelled)?;
    }
    Ok(())
}

/// The speech-transcription model set (Whisper + Silero VAD) — the existing,
/// already-shipped download the model-consent prompt describes.
pub(crate) fn ensure_speech(
    model_dir: &Path,
    on_progress: impl FnMut(&str, u8),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    ensure(model_dir, FILES, on_progress, cancelled)
}

/// The diarization model, downloaded (and consented to) independently of
/// the speech models above — see `DIARIZATION_FILES`'s doc comment.
pub(crate) fn ensure_diarization(
    model_dir: &Path,
    on_progress: impl FnMut(&str, u8),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    ensure(model_dir, DIARIZATION_FILES, on_progress, cancelled)
}

/// Cheap presence check: exists, and is the exact size a correct download
/// produces. Not a hash check — that only runs once, right after a download,
/// which is what keeps `ensure` fast enough to call unconditionally.
fn already_present(path: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(path).map(|m| m.len() == file.size).unwrap_or(false)
}

/// (name, size) of every file in `files` that `ensure` would actually have to
/// download right now. Empty on a machine that already has everything —
/// which is what lets `model_consent::allow` skip the prompt entirely on
/// every transcription after the first, rather than only skipping the
/// download itself.
fn missing(model_dir: &Path, files: &[ModelFile]) -> Vec<(&'static str, u64)> {
    files.iter().filter(|f| !already_present(&model_dir.join(f.name), f)).map(|f| (f.name, f.size)).collect()
}

pub(crate) fn missing_files(model_dir: &Path) -> Vec<(&'static str, u64)> {
    missing(model_dir, FILES)
}

pub(crate) fn missing_diarization_files(model_dir: &Path) -> Vec<(&'static str, u64)> {
    missing(model_dir, DIARIZATION_FILES)
}

/// Stream one file to disk via a `.part` temp path, verify it, then rename
/// into place. The temp path plus the rename is what stops a download killed
/// mid-write from being mistaken for a complete file later — `already_present`
/// only checks size, and without the atomic rename an interrupted download
/// that happened to stop at exactly the right byte count would pass that
/// check forever.
fn download(
    file: &ModelFile,
    dest: &Path,
    mut on_progress: impl FnMut(u8),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let resp = ureq::get(file.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .call()
        .map_err(|e| format!("cannot start downloading {}: {e}", file.name))?;
    let total = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(file.size).max(1);

    let tmp = dest.with_extension("part");
    let mut out = std::fs::File::create(&tmp).map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut read: u64 = 0;
    let mut last_pct = u8::MAX;

    loop {
        if cancelled() {
            drop(out);
            let _ = std::fs::remove_file(&tmp);
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("download of {} failed: {e}", file.name))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        hasher.update(&buf[..n]);
        read += n as u64;
        let pct = progress_pct(read, total);
        if pct != last_pct {
            last_pct = pct;
            on_progress(pct);
        }
    }
    drop(out);

    let digest = format!("{:x}", hasher.finalize());
    if digest != file.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "{} failed verification after download (got sha256 {digest}, expected {}) — the file may be corrupted or the upstream source changed",
            file.name, file.sha256
        ));
    }

    std::fs::rename(&tmp, dest).map_err(|e| format!("cannot finalise {}: {e}", dest.display()))?;
    Ok(())
}

/// `read` bytes of `total`, as a 0..100 percentage. Split out because the
/// arithmetic — clamping `read` so a `Content-Length` that undercounts cannot
/// push the bar past 100 — is exactly the kind of thing worth a test with a
/// known answer instead of trusting it inline.
fn progress_pct(read: u64, total: u64) -> u8 {
    ((read.min(total) * 100) / total.max(1)) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both model sets share every shape invariant below (well-formed hash,
    /// real size, unique name, a pinned non-branch URL) — checked together so
    /// adding a third list later cannot forget to extend these.
    fn all_lists() -> Vec<&'static [ModelFile]> {
        vec![FILES, DIARIZATION_FILES]
    }

    #[test]
    fn every_entry_has_a_well_formed_sha256() {
        for list in all_lists() {
            for f in list {
                assert_eq!(f.sha256.len(), 64, "{} sha256 is not 64 hex chars: {}", f.name, f.sha256);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{} sha256 has a non-hex char", f.name);
            }
        }
    }

    #[test]
    fn every_entry_has_a_real_size_and_a_unique_name() {
        for list in all_lists() {
            let mut names = std::collections::HashSet::new();
            for f in list {
                assert!(f.size > 0, "{} has a zero size", f.name);
                assert!(names.insert(f.name), "duplicate model file name: {}", f.name);
            }
        }
    }

    #[test]
    fn every_url_actually_points_at_the_pinned_revision() {
        // A file fetched from `main`/`master` instead of the pinned commit
        // could silently change under this app; this is the check that would
        // catch a copy-paste of the wrong URL into the table.
        for list in all_lists() {
            for f in list {
                let pinned = f.url.contains("608c49e61301901684bc36cac8f74b95ff6b5a8e")
                    || f.url.contains("bfdc0193023f121ea5b3cc7b176dbed570a68a59")
                    || f.url.contains("edf8e8c67f02ad879326f49af2bd17d56612e88c");
                assert!(pinned, "{} is not fetched from a pinned revision: {}", f.name, f.url);
                assert!(!f.url.contains("/main/") && !f.url.contains("/master/"), "{} names a moving branch: {}", f.name, f.url);
            }
        }
    }

    #[test]
    fn the_speaker_embedding_model_is_not_in_the_speech_set() {
        // Bundling it into FILES would make the existing model-consent
        // prompt's "Whisper + a voice detector" copy wrong for everyone who
        // only ever wants synced lyrics. The VAD going the *other* way is
        // deliberate (see DIARIZATION_FILES), so this checks the one
        // direction that matters rather than blanket disjointness.
        assert!(!FILES.iter().any(|f| f.name.contains("speaker-embedding")));
    }

    #[test]
    fn both_sets_pin_the_same_silero_build() {
        // Two independently-written copies of this entry drifting to
        // different commits is exactly what the SILERO_VAD const prevents.
        let speech = FILES.iter().find(|f| f.name == SILERO_VAD.name).expect("speech set has no VAD");
        let diarization = DIARIZATION_FILES.iter().find(|f| f.name == SILERO_VAD.name).expect("diarization set has no VAD");
        assert_eq!(speech.url, diarization.url);
        assert_eq!(speech.sha256, diarization.sha256);
        assert_eq!(speech.size, diarization.size);
    }

    #[test]
    fn missing_diarization_files_lists_everything_when_absent() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-diarize", std::process::id()));
        let missing = missing_diarization_files(&dir);
        assert_eq!(missing.len(), DIARIZATION_FILES.len());
        // The embedding model AND the VAD it now depends on.
        assert!(missing.iter().any(|(n, _)| n.contains("speaker-embedding")));
        assert!(missing.iter().any(|(n, _)| *n == SILERO_VAD.name));
    }

    #[test]
    fn missing_diarization_files_is_empty_once_present() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-diarize2", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in DIARIZATION_FILES {
            std::fs::write(dir.join(f.name), vec![0u8; f.size as usize]).unwrap();
        }
        assert!(missing_diarization_files(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_never_exceeds_100_even_with_a_wrong_content_length() {
        assert_eq!(progress_pct(0, 100), 0);
        assert_eq!(progress_pct(50, 100), 50);
        assert_eq!(progress_pct(100, 100), 100);
        // A server that undercounts Content-Length must not push the bar
        // past what a percentage can mean.
        assert_eq!(progress_pct(150, 100), 100);
    }

    #[test]
    fn progress_does_not_divide_by_a_zero_total() {
        assert_eq!(progress_pct(0, 0), 0);
    }

    #[test]
    fn a_missing_file_is_not_already_present() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-a", std::process::id()));
        let file = &FILES[0];
        assert!(!already_present(&dir.join(file.name), file));
    }

    #[test]
    fn a_file_of_the_wrong_size_is_not_already_present() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-b", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = &FILES[3]; // config.json, small enough to write a wrong copy of
        let path = dir.join(file.name);
        std::fs::write(&path, b"not the real file").unwrap();
        assert!(!already_present(&path, file), "a truncated/wrong file was accepted as present");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_of_the_exact_expected_size_is_accepted_without_hashing() {
        // Deliberately not the real bytes: this is the fast path, and the
        // fast path trusts size alone. If it started hashing every call, this
        // test would need real model bytes to pass, which is the signal that
        // the fast path stopped being fast.
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-c", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = &FILES[3];
        let path = dir.join(file.name);
        std::fs::write(&path, vec![0u8; file.size as usize]).unwrap();
        assert!(already_present(&path, file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Hits the real network. `#[ignore]`d so `cargo test` stays offline;
    /// this is the test that actually proves the downloader works, the way
    /// `real_transcription.rs` proves the decoder does — the unit tests above
    /// check the logic, this checks that the six pinned URLs and hashes still
    /// agree with what is actually being served today.
    #[test]
    #[ignore = "downloads ~79 MB from HuggingFace + GitHub"]
    fn every_file_downloads_and_verifies_against_the_real_sources() {
        let dir = std::env::temp_dir().join(format!("lyric-models-real-download-{}", std::process::id()));
        let mut seen_files = std::collections::HashSet::new();
        let result = ensure(
            &dir,
            FILES,
            |file, pct| {
                seen_files.insert(file.to_string());
                if pct == 100 {
                    println!("[models test] {file} done");
                }
            },
            &|| false,
        );
        assert!(result.is_ok(), "{result:?}");
        for f in FILES {
            let path = dir.join(f.name);
            assert!(path.is_file(), "{} was not written", f.name);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), f.size, "{} has the wrong size", f.name);
        }
        // Every file was actually downloaded (not pre-existing from a
        // previous crashed run under the same PID), so progress fired for
        // each — proof the fast path was not accidentally taken.
        assert_eq!(seen_files.len(), FILES.len(), "not every file reported progress: {seen_files:?}");

        // Run again: everything should now be the fast, already-present path.
        let mut calls = 0;
        ensure(&dir, FILES, |_, _| calls += 1, &|| false).unwrap();
        assert_eq!(calls, 0, "a re-run re-downloaded files that were already verified");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_skips_downloading_when_every_file_is_already_present() {
        // No network access in this test: if `ensure` tried to download
        // anything here, it would hang or fail on a sandboxed CI runner. That
        // makes this also a regression test for the fast path actually being
        // taken.
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-d", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in FILES {
            std::fs::write(dir.join(f.name), vec![0u8; f.size as usize]).unwrap();
        }
        let mut calls = 0;
        let result = ensure(&dir, FILES, |_, _| calls += 1, &|| false);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(calls, 0, "progress was reported for files that were already present");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_is_empty_once_everything_is_on_disk() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-e", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in FILES {
            std::fs::write(dir.join(f.name), vec![0u8; f.size as usize]).unwrap();
        }
        assert!(missing_files(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_lists_only_what_is_actually_absent() {
        let dir = std::env::temp_dir().join(format!("lyric-models-test-{}-f", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Only the first file present; the rest of the directory is empty.
        std::fs::write(dir.join(FILES[0].name), vec![0u8; FILES[0].size as usize]).unwrap();
        let missing = missing_files(&dir);
        assert_eq!(missing.len(), FILES.len() - 1);
        assert!(!missing.iter().any(|(name, _)| *name == FILES[0].name));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

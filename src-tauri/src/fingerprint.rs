//! Chromaprint audio fingerprints, for identifying what is actually playing.
//!
//! The problem this exists to solve (JOB-ENGINE §5.1): SMTC from a browser
//! reports the *video* title. `"Song Name (Official Video) [4K] Lyrics"` with
//! the uploader as the artist is not metadata, and every lookup downstream —
//! lyrics, artwork, mood — inherits it. `lyrics::clean_title` strips the
//! obvious noise, but no amount of text cleaning recovers a title that was
//! never in the string, or fixes an artist field holding a channel name.
//!
//! The audio does not lie. Fingerprint what is coming out of the speakers,
//! ask AcoustID which recording that is, and the correct artist and title come
//! back — see `acoustid.rs` for that half.
//!
//! **What "fingerprint" means here.** Chromaprint reduces audio to a sequence
//! of 32-bit sub-fingerprints, one per ~0.12 s, each a hash of which chroma
//! bands rose or fell. It is robust to encoding, bitrate and volume, and it is
//! not a hash of the bytes — two rips of the same recording agree, a cover
//! version does not. AcoustID indexes those sub-fingerprints, so a query is a
//! near-neighbour search rather than an exact lookup.
//!
//! **Why a pure-Rust port.** `rusty-chromaprint` needs no C toolchain and no
//! `chromaprint.dll` shipped beside the exe. It also carries the compressor,
//! which matters more than it sounds: AcoustID does not accept raw u32s, it
//! accepts Chromaprint's own compressed encoding, and reimplementing that
//! format by hand is exactly the kind of thing that produces a request the
//! server rejects for reasons no local test can reproduce.

use base64::Engine;
use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};

/// Below this there is not enough audio for a trustworthy match. AcoustID's
/// index is built from full recordings; a very short excerpt matches too many
/// things. Deliberately the same threshold `audio.rs` uses to decide a
/// recording is worth transcribing, so one recording can serve both.
pub const MIN_SECONDS: f64 = 20.0;

/// Ceiling on the audio actually analysed. `fpcalc`'s own default is 120 s,
/// and AcoustID's index is built from fingerprints of that length — sending
/// more is wasted work that does not improve the match.
pub const MAX_SECONDS: f64 = 120.0;

/// Peak amplitude below which the input is treated as silence. Fingerprinting
/// silence succeeds and returns a degenerate fingerprint that matches nothing,
/// which costs a network round trip to discover. Catch it here instead.
const SILENCE_PEAK: f32 = 1e-4;

/// A fingerprint ready to send to AcoustID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    /// Chromaprint's compressed form, URL-safe base64 with no padding — the
    /// exact encoding `fpcalc -json` emits and the API expects.
    pub encoded: String,
    /// Seconds of audio this fingerprint covers, after the `MAX_SECONDS` cap.
    ///
    /// **Not** the value to send as AcoustID's `duration` parameter: that one
    /// is the whole track's length, which the caller knows and this module
    /// does not. Reported so a caller can log or sanity-check what was
    /// actually analysed.
    pub analysed_secs: u32,
}

/// Chromaprint's default algorithm — `CHROMAPRINT_ALGORITHM_DEFAULT` is
/// `TEST2`, which is what `fpcalc` uses and therefore what every fingerprint
/// in AcoustID's index was built with. A fingerprint computed with any other
/// preset is well-formed, encodes its own algorithm id, and matches nothing.
fn config() -> Configuration {
    Configuration::preset_test2()
}

/// Fingerprint mono PCM.
///
/// `samples` is mono f32 in -1..1 at `sample_rate`; the fingerprinter
/// resamples to its own 11025 Hz internally, so the native capture rate can be
/// passed straight in. Only the first `MAX_SECONDS` are analysed.
///
/// **Feed it the start of the song.** AcoustID can match a mid-song excerpt,
/// but its index is built from fingerprints that begin at t=0, so a match from
/// the opening is far more reliable than one from the third chorus. A caller
/// recording live playback should start at the track change.
///
/// # Errors
/// Returns a message when the input is too short, silent, or the sample rate
/// is unusable — all three are ordinary conditions a caller decides about, not
/// failures worth logging as errors.
pub fn compute(samples: &[f32], sample_rate: u32) -> Result<Fingerprint, String> {
    if sample_rate == 0 {
        return Err("sample rate is zero".into());
    }
    let seconds = samples.len() as f64 / sample_rate as f64;
    if seconds < MIN_SECONDS {
        return Err(format!("only {seconds:.1}s of audio, need {MIN_SECONDS:.0}s"));
    }

    let wanted = (MAX_SECONDS * sample_rate as f64) as usize;
    let clip = &samples[..samples.len().min(wanted)];

    let peak = clip.iter().fold(0f32, |m, s| m.max(s.abs()));
    if peak < SILENCE_PEAK {
        return Err("audio is silent".into());
    }

    // Chromaprint consumes i16. Scaling by 32767 and clamping (rather than
    // 32768, which overflows on a sample of exactly 1.0) is what every decoder
    // feeding fpcalc does, so this matches the input the index was built from.
    let pcm: Vec<i16> = clip.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect();

    let cfg = config();
    let mut printer = Fingerprinter::new(&cfg);
    printer.start(sample_rate, 1).map_err(|e| format!("fingerprinter rejected {sample_rate} Hz mono: {e:?}"))?;
    printer.consume(&pcm);
    printer.finish();

    let raw = printer.fingerprint();
    if raw.is_empty() {
        // Reachable if the resampled clip is shorter than one analysis frame.
        // MIN_SECONDS makes that impossible today; it is checked anyway
        // because an empty fingerprint encodes to a valid-looking string.
        return Err("fingerprint came back empty".into());
    }

    let compressed = FingerprintCompressor::from(&cfg).compress(raw);
    Ok(Fingerprint {
        encoded: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&compressed),
        analysed_secs: (clip.len() as f64 / sample_rate as f64) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic tone sweep — musical enough that chroma bands actually
    /// move, which is what the fingerprint is built from. A constant tone
    /// produces a nearly constant fingerprint and would hide real bugs.
    fn sweep(seconds: f64, rate: u32, start_hz: f64, end_hz: f64) -> Vec<f32> {
        let n = (seconds * rate as f64) as usize;
        let mut phase = 0f64;
        (0..n)
            .map(|i| {
                let t = i as f64 / n.max(1) as f64;
                let hz = start_hz + (end_hz - start_hz) * t;
                phase += std::f64::consts::TAU * hz / rate as f64;
                (phase.sin() * 0.5) as f32
            })
            .collect()
    }

    #[test]
    fn the_preset_is_the_one_acoustids_index_was_built_with() {
        // The single most consequential constant in this file, and the one
        // whose being wrong is completely silent: every other preset produces
        // a well-formed fingerprint that simply never matches anything.
        // TEST2 is CHROMAPRINT_ALGORITHM_DEFAULT, algorithm id 1.
        assert_eq!(config().id(), 1, "not Chromaprint's default algorithm");
    }

    #[test]
    fn a_real_signal_fingerprints_to_a_url_safe_base64_string() {
        let fp = compute(&sweep(30.0, 44_100, 200.0, 2_000.0), 44_100).unwrap();
        assert!(!fp.encoded.is_empty());
        assert_eq!(fp.analysed_secs, 30);
        // URL-safe alphabet, no padding — anything else means the encoder was
        // swapped for the standard one and the query would need escaping.
        assert!(
            fp.encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "not URL-safe base64: {}",
            &fp.encoded[..40.min(fp.encoded.len())]
        );
    }

    #[test]
    fn the_encoded_header_declares_the_algorithm() {
        // Chromaprint's compressed format opens with the algorithm id, so
        // this reads back the one thing a server checks before anything else.
        let fp = compute(&sweep(30.0, 44_100, 200.0, 2_000.0), 44_100).unwrap();
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&fp.encoded).unwrap();
        assert_eq!(bytes[0], config().id(), "compressed header does not name the algorithm used");
    }

    #[test]
    fn the_same_audio_always_fingerprints_the_same() {
        let audio = sweep(25.0, 44_100, 300.0, 1_500.0);
        assert_eq!(compute(&audio, 44_100).unwrap(), compute(&audio, 44_100).unwrap());
    }

    #[test]
    fn different_audio_fingerprints_differently() {
        // The property that makes it an identifier at all. A bug that fed the
        // fingerprinter a constant (an empty buffer, say) would still produce
        // a plausible string and would still pass every test above this one.
        let a = compute(&sweep(25.0, 44_100, 300.0, 1_500.0), 44_100).unwrap();
        let b = compute(&sweep(25.0, 44_100, 1_500.0, 300.0), 44_100).unwrap();
        assert_ne!(a.encoded, b.encoded);
    }

    #[test]
    fn the_fingerprint_follows_the_content_not_the_clock() {
        // The real property AcoustID relies on: the same music offset in time
        // still matches. Fingerprint a sweep, then the same sweep with two
        // seconds of quiet audio in front, and check the two share a matching
        // segment. This is what proves the sub-fingerprints track the audio
        // rather than the buffer index.
        let rate = 44_100;
        let audio = sweep(30.0, rate, 300.0, 1_500.0);
        let mut shifted = sweep(2.0, rate, 40.0, 40.0);
        shifted.extend_from_slice(&audio);

        let cfg = config();
        let raw = |pcm: &[f32]| {
            let s: Vec<i16> = pcm.iter().map(|&v| (v.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
            let mut p = Fingerprinter::new(&cfg);
            p.start(rate, 1).unwrap();
            p.consume(&s);
            p.finish();
            p.fingerprint().to_vec()
        };
        let segments = rusty_chromaprint::match_fingerprints(&raw(&audio), &raw(&shifted), &cfg).unwrap();
        assert!(!segments.is_empty(), "a time-shifted copy of the same audio did not match");
    }

    #[test]
    fn audio_past_the_cap_is_ignored_rather_than_analysed() {
        // Both the cap itself and the thing that makes it safe: the first
        // MAX_SECONDS decide the fingerprint, so a longer recording of the
        // same song produces the identical query.
        let rate = 8_000; // low rate keeps the test fast; the cap is in seconds
        let short = sweep(MAX_SECONDS, rate, 300.0, 1_500.0);
        let mut long = short.clone();
        long.extend(sweep(45.0, rate, 90.0, 90.0));

        let a = compute(&short, rate).unwrap();
        let b = compute(&long, rate).unwrap();
        assert_eq!(a.encoded, b.encoded, "audio past the cap changed the fingerprint");
        assert_eq!(b.analysed_secs, MAX_SECONDS as u32);
    }

    #[test]
    fn too_little_audio_is_refused_with_a_reason() {
        let err = compute(&sweep(5.0, 44_100, 300.0, 1_500.0), 44_100).unwrap_err();
        assert!(err.contains("5.0s"), "the message should say how much there was: {err}");
    }

    #[test]
    fn silence_is_refused_before_the_network_finds_out() {
        let err = compute(&vec![0.0; 44_100 * 30], 44_100).unwrap_err();
        assert!(err.contains("silent"), "{err}");
    }

    #[test]
    fn a_zero_sample_rate_is_an_error_not_a_divide_by_zero() {
        assert!(compute(&[0.1; 1000], 0).is_err());
    }

    #[test]
    fn empty_input_is_refused() {
        assert!(compute(&[], 44_100).is_err());
    }

    #[test]
    fn the_native_capture_rate_is_accepted_directly() {
        // audio.rs records at whatever WASAPI hands it — 48 kHz on most
        // machines — and this must not need a resampling step of its own.
        assert!(compute(&sweep(25.0, 48_000, 300.0, 1_500.0), 48_000).is_ok());
    }

    #[test]
    fn a_full_scale_sample_does_not_wrap_to_negative() {
        // (1.0 * 32768.0) as i16 saturates in Rust rather than wrapping, but
        // relying on that is one refactor away from a clipped peak becoming
        // the most negative sample there is. 32767 leaves no doubt.
        let mut audio = sweep(25.0, 44_100, 300.0, 1_500.0);
        audio[1000] = 1.0;
        audio[1001] = -1.0;
        assert!(compute(&audio, 44_100).is_ok());
        assert_eq!((1.0f32.clamp(-1.0, 1.0) * 32767.0) as i16, 32767);
        assert_eq!(((-1.0f32).clamp(-1.0, 1.0) * 32767.0) as i16, -32767);
    }
}

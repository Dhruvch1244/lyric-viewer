//! Offline song analysis in Rust — the whole shape of a track, before it plays.
//!
//! A port of the renderer's `analyze.js`. The renderer used to decode a local
//! file with Web Audio and run this DSP on the main thread, which stalled the
//! first frame of every track (a synchronous pass over millions of samples).
//! Here it runs off-thread: `symphonia` decodes the file to mono, the same
//! two-band envelope + onset analysis runs natively, and the compact result is
//! handed to the renderer to feed the heat map + tempo — so the visuals can
//! anticipate a drop on the FIRST play with no capture and no stall.
//!
//! `analyse_samples` is pure arithmetic (numbers in, numbers out) and is
//! unit-tested; `decode_to_mono` is the only part that touches a codec.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Envelope window. ~23ms: short enough to catch a kick.
const WINDOW_MS: f64 = 23.0;
const BASS_HZ: f64 = 200.0;
const TREBLE_HZ: f64 = 4000.0;
/// An onset needs the bass to exceed its running floor by this much.
const ONSET_THRESHOLD: f32 = 0.12;
/// How fast the running floor follows the signal (per window).
const FLOOR_RATE: f32 = 0.10;

/// The measured shape of a track: per-window envelopes + bass onset times (ms).
#[derive(serde::Serialize, Default)]
pub struct Analysis {
    #[serde(rename = "windowMs")]
    pub window_ms: f64,
    pub level: Vec<f32>,
    pub bass: Vec<f32>,
    pub treble: Vec<f32>,
    pub onsets: Vec<f64>,
}

/// One-pole coefficient for a cutoff frequency.
fn pole_alpha(hz: f64, sample_rate: f64) -> f32 {
    let dt = 1.0 / sample_rate;
    let rc = 1.0 / (2.0 * std::f64::consts::PI * hz);
    (dt / (rc + dt)) as f32
}

fn peak_of(arr: &[f32]) -> f32 {
    arr.iter().cloned().fold(0.0_f32, f32::max)
}

/// Bass onsets as timestamps in ms, tested by DIFFERENCE against a running floor
/// (a ratio has no headroom once a hot master saturates the band).
fn find_onsets(bass: &[f32], window_ms: f64) -> Vec<f64> {
    let mut onsets = Vec::new();
    let mut floor = 0.0_f32;
    let mut armed = true;
    for (i, &v) in bass.iter().enumerate() {
        if armed && v - floor > ONSET_THRESHOLD {
            onsets.push(i as f64 * window_ms);
            armed = false; // wait for a fall before firing again
        } else if v <= floor + ONSET_THRESHOLD * 0.4 {
            armed = true;
        }
        floor += (v - floor) * FLOOR_RATE;
    }
    onsets
}

/// Measure a song from its mono PCM. Envelopes are normalised against the
/// track's own peak (one shared scale for all three bands, so `bass >= treble`
/// stays meaningful for the heat-map tint).
pub fn analyse_samples(samples: &[f32], sample_rate: u32) -> Analysis {
    let mut out = Analysis { window_ms: WINDOW_MS, ..Default::default() };
    if samples.is_empty() || sample_rate == 0 {
        return out;
    }
    let sr = sample_rate as f64;
    let hop = ((WINDOW_MS / 1000.0) * sr).round().max(1.0) as usize;
    let count = samples.len() / hop;
    if count < 1 {
        return out;
    }

    let mut level = vec![0.0_f32; count];
    let mut bass = vec![0.0_f32; count];
    let mut treble = vec![0.0_f32; count];

    let a_low = pole_alpha(BASS_HZ, sr);
    let hp_a = 1.0 - pole_alpha(TREBLE_HZ, sr);
    let mut low = 0.0_f32;
    let mut hp_prev_in = 0.0_f32;
    let mut hp_prev_out = 0.0_f32;

    for w in 0..count {
        let start = w * hop;
        let end = start + hop;
        let mut sum_sq = 0.0_f32;
        let mut sum_low = 0.0_f32;
        let mut sum_high = 0.0_f32;
        for &x in &samples[start..end] {
            sum_sq += x * x;
            low += a_low * (x - low);
            sum_low += low * low;
            let hp = hp_a * (hp_prev_out + x - hp_prev_in);
            hp_prev_in = x;
            hp_prev_out = hp;
            sum_high += hp * hp;
        }
        let hopf = hop as f32;
        level[w] = (sum_sq / hopf).sqrt();
        bass[w] = (sum_low / hopf).sqrt();
        treble[w] = (sum_high / hopf).sqrt();
    }

    let scale = 1.0 / peak_of(&level).max(peak_of(&bass)).max(peak_of(&treble)).max(1e-9);
    for i in 0..count {
        level[i] *= scale;
        bass[i] *= scale;
        treble[i] *= scale;
    }

    out.onsets = find_onsets(&bass, WINDOW_MS);
    out.level = level;
    out.bass = bass;
    out.treble = treble;
    out
}

/// Decode any supported audio file to mono f32 samples + its sample rate.
pub fn decode_to_mono(path: &str) -> Option<(Vec<f32>, u32)> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
    let track = format.default_track()?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;

    let mut mono: Vec<f32> = Vec::new();
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        if sbuf.is_none() {
            sbuf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let buf = sbuf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    if mono.is_empty() {
        None
    } else {
        Some((mono, sample_rate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_has_no_onsets() {
        let a = analyse_samples(&vec![0.0; 48_000], 48_000);
        assert!(a.level.len() > 1);
        assert!(a.onsets.is_empty());
    }

    #[test]
    fn a_bass_burst_registers_an_onset() {
        // 1s of near-silence, then a loud low-frequency burst -> at least one onset.
        let sr = 48_000u32;
        let mut s = vec![0.0_f32; sr as usize];
        // ~60Hz sine burst for 0.2s.
        for i in 0..(sr as usize / 5) {
            let t = i as f32 / sr as f32;
            s.push((2.0 * std::f32::consts::PI * 60.0 * t).sin() * 0.9);
        }
        let a = analyse_samples(&s, sr);
        assert!(!a.onsets.is_empty(), "expected a bass onset after the burst");
        // The onset should land after the silent lead-in (~1000ms).
        assert!(a.onsets[0] >= 900.0, "onset too early: {}", a.onsets[0]);
    }

    #[test]
    #[ignore] // live: set LYRIC_TEST_AUDIO to a real file, run with -- --ignored
    fn decode_and_analyse_a_real_file() {
        let path = std::env::var("LYRIC_TEST_AUDIO").expect("set LYRIC_TEST_AUDIO");
        let (samples, sr) = decode_to_mono(&path).expect("decode failed");
        eprintln!("decoded {} samples @ {} Hz ({:.1}s)", samples.len(), sr, samples.len() as f64 / sr as f64);
        assert!(sr >= 8000, "implausible sample rate {sr}");
        assert!(samples.len() > sr as usize, "suspiciously short decode");
        let a = analyse_samples(&samples, sr);
        eprintln!("{} windows, {} onsets, first onset {:?}ms", a.level.len(), a.onsets.len(), a.onsets.first());
        assert!(a.level.len() > 100, "too few windows");
        assert!(!a.onsets.is_empty(), "a real song should have bass onsets");
    }

    #[test]
    fn envelopes_are_normalised_to_peak() {
        let sr = 48_000u32;
        let s: Vec<f32> = (0..sr)
            .map(|i| (i as f32 / sr as f32 * std::f32::consts::TAU * 200.0).sin() * 0.3)
            .collect();
        let a = analyse_samples(&s, sr);
        let peak = a.level.iter().cloned().fold(0.0_f32, f32::max);
        assert!((peak - 1.0).abs() < 0.05, "peak should be ~1.0, got {peak}");
    }
}

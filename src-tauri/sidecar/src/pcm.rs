//! Reading the host's PCM without copying it.
//!
//! A 4-minute song at 16 kHz mono `f32` is ~15 MB. The host writes it to a
//! temp file and sends only the path; this maps that file read-only, so the
//! samples are never serialized, never sent over a pipe, and never duplicated
//! in this process's heap — the kernel pages them in on demand and drops them
//! under memory pressure without any bookkeeping here.

use std::path::Path;

use memmap2::Mmap;

/// Whisper's fixed input rate. The host resamples before writing, because it
/// already owns the decode path (`analysis::decode_to_mono`) and doing it
/// twice in two languages is how the two drift apart.
pub const REQUIRED_SAMPLE_RATE: u32 = 16_000;

/// A memory-mapped block of `f32` samples.
///
/// Holds the mapping alive for as long as the slice is reachable — `samples()`
/// borrows from `self`, so the map cannot be dropped while the audio is in use.
pub struct Pcm {
    map: Mmap,
    /// Number of whole `f32` values in the mapping.
    len: usize,
}

/// Reports the sample count, never the samples. A derived `Debug` on a
/// 15 MB mapping would render megabytes into a panic message.
impl std::fmt::Debug for Pcm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pcm").field("samples", &self.len).finish()
    }
}

impl Pcm {
    /// Map a file of raw little-endian `f32` samples.
    ///
    /// # Safety of the mapping
    /// `Mmap::map` is unsafe because another process modifying or truncating
    /// the file would change bytes under us. The host owns this file: it
    /// writes it fully, closes it, sends the path, and deletes it only after
    /// the job ends. Nothing else knows the path.
    pub fn open(path: &Path) -> Result<Pcm, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("cannot open PCM at {}: {e}", path.display()))?;
        let map = unsafe { Mmap::map(&file) }.map_err(|e| format!("cannot map PCM at {}: {e}", path.display()))?;

        if map.len() % 4 != 0 {
            return Err(format!("PCM file is {} bytes, not a whole number of f32 samples", map.len()));
        }
        let len = map.len() / 4;
        if len == 0 {
            return Err("PCM file is empty".into());
        }
        Ok(Pcm { map, len })
    }

    /// The samples.
    ///
    /// Falls back to a copy in the (practically impossible) case that the
    /// mapping is not 4-byte aligned. mmap returns page-aligned addresses, so
    /// `align_to` will not produce a prefix here — but returning wrong data
    /// on a bad assumption is worse than an allocation that never happens.
    pub fn samples(&self) -> std::borrow::Cow<'_, [f32]> {
        let (prefix, aligned, _suffix) = unsafe { self.map.align_to::<f32>() };
        if prefix.is_empty() && aligned.len() == self.len {
            std::borrow::Cow::Borrowed(aligned)
        } else {
            let copied = self.map.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect::<Vec<_>>();
            std::borrow::Cow::Owned(copied)
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn duration_ms(&self, sample_rate: u32) -> u32 {
        if sample_rate == 0 {
            return 0;
        }
        ((self.len as u64 * 1000) / sample_rate as u64) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pcm(name: &str, samples: &[f32]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        for s in samples {
            f.write_all(&s.to_le_bytes()).unwrap();
        }
        f.flush().unwrap();
        path
    }

    #[test]
    fn maps_samples_back_exactly() {
        let want: Vec<f32> = (0..1000).map(|i| (i as f32) * 0.001 - 0.5).collect();
        let path = write_pcm("lyric-pcm-roundtrip.pcm", &want);
        let pcm = Pcm::open(&path).unwrap();
        assert_eq!(pcm.len(), want.len());
        assert_eq!(pcm.samples().as_ref(), want.as_slice());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn duration_is_derived_from_the_sample_rate() {
        let path = write_pcm("lyric-pcm-duration.pcm", &vec![0.0; 16_000 * 3]);
        let pcm = Pcm::open(&path).unwrap();
        assert_eq!(pcm.duration_ms(REQUIRED_SAMPLE_RATE), 3000);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_truncated_file_is_rejected_rather_than_misread() {
        let path = std::env::temp_dir().join("lyric-pcm-ragged.pcm");
        std::fs::write(&path, [0u8, 1, 2, 3, 4, 5]).unwrap(); // 6 bytes: 1.5 samples
        let err = Pcm::open(&path).unwrap_err();
        assert!(err.contains("whole number"), "got: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_empty_file_is_rejected() {
        let path = std::env::temp_dir().join("lyric-pcm-empty.pcm");
        std::fs::write(&path, []).unwrap();
        assert!(Pcm::open(&path).unwrap_err().contains("empty"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        assert!(Pcm::open(Path::new("C:\\definitely\\not\\here.pcm")).is_err());
    }
}

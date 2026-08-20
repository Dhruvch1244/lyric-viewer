//! The wire protocol between the app and the inference sidecar.
//!
//! Shared by both sides so the message shapes cannot drift apart — a struct
//! field added on one side and forgotten on the other is a class of bug that
//! simply cannot occur if there is one definition.
//!
//! FRAMING: `[u32 len][u8 kind][bincode payload]`, little-endian length,
//! `len` counting the kind byte plus the payload.
//!
//! The `kind` byte duplicates the enum's own discriminant on purpose. It lets
//! a reader decide what to do with a frame without paying to decode it, which
//! matters for exactly one message: `Progress` arrives many times a second
//! during a transcription and is worth dropping under backpressure, while a
//! `Result` never is. Cheap to write, and it keeps that decision from
//! requiring a full deserialize of a frame that is about to be discarded.
//!
//! WHY NOT SEND PCM OVER THIS: a 4-minute song at 16 kHz mono f32 is ~15 MB.
//! It goes through a temp file the sidecar memory-maps read-only; only the
//! path travels over the pipe. See `Request::Transcribe::pcm_path`.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Bumped whenever a message shape changes incompatibly. The sidecar reports
/// the version it was built with in `Response::Ready`, and the host refuses to
/// use a sidecar that disagrees — a stale binary left behind by a partial
/// upgrade otherwise fails much later and far less legibly.
pub const PROTOCOL_VERSION: u16 = 1;

/// Frames larger than this are treated as corruption rather than honoured.
/// Without a ceiling, a garbled length prefix asks the reader to allocate up
/// to 4 GB before it discovers the frame is nonsense.
pub const MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;

/// A voiced span of audio, in milliseconds from the start of the PCM.
///
/// Produced by the VAD pass and consumed by the transcriber, which only runs
/// the model over these — that is where the speed win comes from, and it is
/// also what stops Whisper inventing lyrics over an instrumental passage.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start_ms: u32,
    pub end_ms: u32,
}

impl Span {
    pub fn duration_ms(&self) -> u32 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

/// One word with measured timing.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub word: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// A line-shaped cue carrying its own words, matching the shape the renderer
/// and `align.rs` already expect from the WASM path being replaced.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Cue {
    pub time_ms: u32,
    pub end_ms: u32,
    pub text: String,
    pub words: Vec<Word>,
}

/// What the sidecar is doing, so the UI can say something truthful rather
/// than showing an unqualified spinner for what may be a minute of work.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// First run only — the model is being fetched or read from disk.
    LoadingModel,
    /// Finding the voiced spans (Silero).
    DetectingSpeech,
    /// Running Whisper over those spans.
    Transcribing,
}

/// Host → sidecar.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Sent immediately after spawn; the sidecar answers `Response::Ready`.
    Hello { version: u16 },
    Transcribe {
        job_id: u64,
        /// Path to a raw `f32` little-endian mono PCM file, memory-mapped by
        /// the sidecar. Owned by the host, which deletes it when the job ends.
        pcm_path: String,
        sample_rate: u32,
        /// Directory holding the ONNX models and tokenizer.
        model_dir: String,
        /// BCP-47-ish language hint, or `None` to let the model detect it.
        language: Option<String>,
        /// Run the VAD pass first. Off makes the sidecar transcribe the whole
        /// file, which is the useful comparison when diagnosing a bad result.
        vad: bool,
    },
    /// Cooperative — the sidecar checks between spans, so this stops the next
    /// one starting rather than interrupting the model mid-run.
    Cancel { job_id: u64 },
    Shutdown,
}

/// Sidecar → host.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Ready { version: u16, runtime: String },
    Progress { job_id: u64, stage: Stage, pct: u8 },
    Result { job_id: u64, cues: Vec<Cue> },
    Error { job_id: u64, message: String },
    /// Answer to `Shutdown`, so the host can wait for a clean exit instead of
    /// killing the process and hoping nothing was mid-write.
    Bye,
}

/// A message that can be framed. `kind` must match the variant order so the
/// byte stays a faithful summary of what follows it.
pub trait Framed {
    fn kind(&self) -> u8;
}

impl Framed for Request {
    fn kind(&self) -> u8 {
        match self {
            Request::Hello { .. } => 0,
            Request::Transcribe { .. } => 1,
            Request::Cancel { .. } => 2,
            Request::Shutdown => 3,
        }
    }
}

/// Frame kinds worth naming, because the host routes on them without decoding.
pub mod response_kind {
    pub const READY: u8 = 0;
    pub const PROGRESS: u8 = 1;
    pub const RESULT: u8 = 2;
    pub const ERROR: u8 = 3;
    pub const BYE: u8 = 4;
}

impl Framed for Response {
    fn kind(&self) -> u8 {
        match self {
            Response::Ready { .. } => response_kind::READY,
            Response::Progress { .. } => response_kind::PROGRESS,
            Response::Result { .. } => response_kind::RESULT,
            Response::Error { .. } => response_kind::ERROR,
            Response::Bye => response_kind::BYE,
        }
    }
}

fn config() -> bincode::config::Configuration {
    bincode::config::standard()
}

/// Encode and write one frame, then flush.
///
/// The flush is not optional: both ends are pipes with their own buffering,
/// and a request left sitting in a buffer is indistinguishable from a hung
/// sidecar from the other side's point of view.
pub fn write_frame<W: Write, M: Framed + Serialize>(w: &mut W, msg: &M) -> io::Result<()> {
    let payload = bincode::serde::encode_to_vec(msg, config()).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len = u32::try_from(payload.len() + 1).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame too large to address"))?;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame of {len} bytes exceeds the {MAX_FRAME_BYTES} ceiling")));
    }
    w.write_all(&len.to_le_bytes())?;
    w.write_all(&[msg.kind()])?;
    w.write_all(&payload)?;
    w.flush()
}

/// Read one frame's kind byte and raw payload, without decoding it.
///
/// Returns `Ok(None)` at a clean end of stream — the peer closed the pipe
/// between frames, which is the normal way a shutdown looks and not an error.
/// A stream that ends *mid*-frame is an error, because that means the peer
/// died partway through writing.
pub fn read_raw_frame<R: Read>(r: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut len_bytes = [0u8; 4];
    match r.read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_bytes);
    if len == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "zero-length frame"));
    }
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame of {len} bytes exceeds the {MAX_FRAME_BYTES} ceiling")));
    }
    let mut kind = [0u8; 1];
    r.read_exact(&mut kind)?;
    let mut payload = vec![0u8; (len - 1) as usize];
    r.read_exact(&mut payload)?;
    Ok(Some((kind[0], payload)))
}

/// Decode a payload previously returned by `read_raw_frame`.
pub fn decode<M: for<'de> Deserialize<'de>>(payload: &[u8]) -> io::Result<M> {
    bincode::serde::decode_from_slice::<M, _>(payload, config())
        .map(|(m, _)| m)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Read and decode one frame. `Ok(None)` at a clean end of stream.
pub fn read_frame<R: Read, M: for<'de> Deserialize<'de>>(r: &mut R) -> io::Result<Option<M>> {
    match read_raw_frame(r)? {
        None => Ok(None),
        Some((_, payload)) => decode(&payload).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> Request {
        Request::Transcribe {
            job_id: 42,
            pcm_path: "C:\\tmp\\song.pcm".into(),
            sample_rate: 16_000,
            model_dir: "C:\\models".into(),
            language: Some("en".into()),
            vad: true,
        }
    }

    fn sample_response() -> Response {
        Response::Result {
            job_id: 42,
            cues: vec![Cue {
                time_ms: 1000,
                end_ms: 2500,
                text: "hello there".into(),
                words: vec![
                    Word { word: "hello".into(), start_ms: 1000, end_ms: 1600 },
                    Word { word: "there".into(), start_ms: 1700, end_ms: 2500 },
                ],
            }],
        }
    }

    #[test]
    fn a_request_survives_a_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &sample_request()).unwrap();
        let back: Request = read_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(back, sample_request());
    }

    #[test]
    fn a_response_survives_a_round_trip_with_its_words_intact() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &sample_response()).unwrap();
        let back: Response = read_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(back, sample_response(), "per-word timing must survive the wire; align.rs depends on it");
    }

    #[test]
    fn frames_are_read_back_one_at_a_time_in_order() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &Request::Hello { version: PROTOCOL_VERSION }).unwrap();
        write_frame(&mut buf, &sample_request()).unwrap();
        write_frame(&mut buf, &Request::Shutdown).unwrap();

        let mut r = buf.as_slice();
        assert_eq!(read_frame::<_, Request>(&mut r).unwrap().unwrap(), Request::Hello { version: PROTOCOL_VERSION });
        assert_eq!(read_frame::<_, Request>(&mut r).unwrap().unwrap(), sample_request());
        assert_eq!(read_frame::<_, Request>(&mut r).unwrap().unwrap(), Request::Shutdown);
        assert!(read_frame::<_, Request>(&mut r).unwrap().is_none(), "a clean end of stream is not an error");
    }

    #[test]
    fn the_kind_byte_matches_the_variant() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &Response::Progress { job_id: 1, stage: Stage::Transcribing, pct: 50 }).unwrap();
        let (kind, _) = read_raw_frame(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(kind, response_kind::PROGRESS, "the host drops progress frames without decoding them");
    }

    #[test]
    fn a_progress_frame_can_be_skipped_without_decoding_it() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &Response::Progress { job_id: 1, stage: Stage::DetectingSpeech, pct: 10 }).unwrap();
        write_frame(&mut buf, &sample_response()).unwrap();

        let mut r = buf.as_slice();
        let (kind, _) = read_raw_frame(&mut r).unwrap().unwrap();
        assert_eq!(kind, response_kind::PROGRESS); // discarded, never decoded
        let (kind, payload) = read_raw_frame(&mut r).unwrap().unwrap();
        assert_eq!(kind, response_kind::RESULT);
        assert_eq!(decode::<Response>(&payload).unwrap(), sample_response());
    }

    #[test]
    fn a_stream_ending_mid_frame_is_an_error() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &sample_response()).unwrap();
        buf.truncate(buf.len() - 4); // sidecar died partway through writing
        let err = read_frame::<_, Response>(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn an_absurd_length_prefix_is_rejected_rather_than_allocated() {
        // A garbled prefix must not ask for a 4 GB allocation.
        let mut buf = Vec::new();
        buf.extend_from_slice(&u32::MAX.to_le_bytes());
        buf.push(0);
        let err = read_raw_frame(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_zero_length_frame_is_rejected() {
        let buf = 0u32.to_le_bytes().to_vec();
        let err = read_raw_frame(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn an_empty_stream_reads_as_a_clean_close() {
        let buf: Vec<u8> = Vec::new();
        assert!(read_raw_frame(&mut buf.as_slice()).unwrap().is_none());
    }

    #[test]
    fn a_long_transcription_stays_well_under_the_frame_ceiling() {
        // ~1200 words is a wordy 4-minute song; the result must fit in one
        // frame, since nothing here reassembles a split message.
        let words: Vec<Word> =
            (0..1200).map(|i| Word { word: format!("word{i}"), start_ms: i * 200, end_ms: i * 200 + 180 }).collect();
        let cues = words
            .chunks(8)
            .map(|w| Cue { time_ms: w[0].start_ms, end_ms: w[w.len() - 1].end_ms, text: "line".into(), words: w.to_vec() })
            .collect();
        let mut buf = Vec::new();
        write_frame(&mut buf, &Response::Result { job_id: 1, cues }).unwrap();
        assert!((buf.len() as u32) < MAX_FRAME_BYTES, "a whole song's words must fit one frame, got {} bytes", buf.len());
    }
}

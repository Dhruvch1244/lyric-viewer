//! Print the encoder/decoder/VAD graph signatures: input and output names,
//! dtypes and declared shapes.
//!
//! `#[ignore]`d — this needs downloaded model files and produces nothing a CI
//! run would assert on. It exists because the graph's actual I/O contract is
//! not fully described anywhere else, and getting it wrong is silent: an ONNX
//! export missing an output you assumed exists fails only once code tries to
//! read it, potentially deep into a decode loop. This is how the two real
//! bugs fixed in whisper.rs and vad.rs were found — `commit_from_file` plus a
//! walk over `session.inputs()`/`outputs()` is cheaper than guessing from the
//! HuggingFace model card, which does not describe the ONNX graph at all.
//!
//! Run with:
//! ```text
//! cargo test -p lyric-inference --test dump_model_io -- --ignored --nocapture
//! ```
//! against `%APPDATA%/com.dhruv.lyricoverlay/models` (Windows) — the same
//! directory the app downloads models into.

#[test]
#[ignore = "needs downloaded models; prints, does not assert"]
fn dump() {
    let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.dhruv.lyricoverlay/models");
    for name in ["encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx", "silero_vad.onnx"] {
        let path = dir.join(name);
        println!("\n===== {name}");
        let session = match ort::session::Session::builder().unwrap().commit_from_file(&path) {
            Ok(s) => s,
            Err(e) => {
                println!("  load failed: {e}");
                continue;
            }
        };
        for i in session.inputs() {
            println!("  IN  {:<40} {:?}", i.name(), i.dtype());
        }
        for o in session.outputs() {
            println!("  OUT {:<40} {:?}", o.name(), o.dtype());
        }
    }
}

//! Temporary: print the encoder/decoder graph signatures.
//! Run with `cargo test -p lyric-inference --test dump_model_io -- --ignored --nocapture`.

#[test]
#[ignore]
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

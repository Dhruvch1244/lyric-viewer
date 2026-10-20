//! Launch on the best GPU by default.
//!
//! The visuals are a full-screen fragment shader or MilkDrop at the display's
//! refresh rate, so on a laptop with two GPUs the integrated one is the wrong
//! default: it is what every app gets unless it asks, and it is what this app
//! got. Measured on the reference hybrid laptop (GTX 1650 Ti + Intel), the
//! MilkDrop path ran at 43 fps on the NVIDIA GPU (see the explicit-sync note in
//! `lib.rs`); getting there took launching through `prime-run` by hand.
//!
//! - **Windows**: WebView2 is Chromium, which picks its adapter itself; the
//!   window's `additionalBrowserArgs` in tauri.conf.json passes it
//!   `--force_high_performance_gpu`. Nothing to do here at runtime.
//! - **Linux**: WebKitGTK renders through EGL/GL in the process it is created
//!   in (and its web process inherits our environment), so PRIME render
//!   offload has to be switched on in our own environment before the webview
//!   exists. That is what `prime-run` does from outside; this does the same
//!   from inside, only when there is a second GPU to offload to.
//!
//! Never overrides a choice already made: a user who launched through
//! `prime-run`, set `DRI_PRIME`, or set `LYRIC_OVERLAY_GPU=default` to keep the
//! integrated GPU, gets exactly what they asked for.

// The detection is Linux-only; the pure decision is still unit-tested everywhere.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// One display adapter, as `/sys/class/drm/cardN/device` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Gpu {
    /// PCI vendor id, e.g. 0x10de (NVIDIA), 0x1002 (AMD), 0x8086 (Intel).
    pub(crate) vendor: u32,
    /// The firmware's boot display. On a hybrid laptop that is the
    /// integrated GPU, which is exactly how the discrete one is told apart.
    pub(crate) boot_vga: bool,
}

const NVIDIA: u32 = 0x10de;

/// The environment to set to offload rendering to the discrete GPU, or
/// nothing when there is no second GPU to prefer. Pure, for the tests.
pub(crate) fn offload_env(gpus: &[Gpu], nvidia_egl: Option<&str>) -> Vec<(&'static str, String)> {
    // A single GPU (a desktop, or a laptop with one) is already the best one.
    if gpus.len() < 2 || !gpus.iter().any(|g| g.boot_vga) {
        return Vec::new();
    }
    let Some(discrete) = gpus.iter().find(|g| !g.boot_vga) else { return Vec::new() };
    if discrete.vendor == NVIDIA {
        // NVIDIA's proprietary stack offloads through glvnd. Without its EGL
        // vendor file (nouveau, or a broken install) these variables would
        // point EGL at a library that is not there, so fall through to Mesa's
        // own switch instead.
        if let Some(egl) = nvidia_egl {
            return vec![
                ("__NV_PRIME_RENDER_OFFLOAD", "1".into()),
                ("__GLX_VENDOR_LIBRARY_NAME", "nvidia".into()),
                ("__EGL_VENDOR_LIBRARY_FILENAMES", egl.into()),
                ("__VK_LAYER_NV_optimus", "NVIDIA_only".into()),
            ];
        }
    }
    // Mesa (AMD, Intel Arc, nouveau): DRI_PRIME=1 picks the non-boot GPU.
    vec![("DRI_PRIME", "1".into())]
}

#[cfg(target_os = "linux")]
fn detect() -> Vec<Gpu> {
    let Ok(dir) = std::fs::read_dir("/sys/class/drm") else { return Vec::new() };
    let mut gpus = Vec::new();
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // card0, card1 — not the connector entries like card0-HDMI-A-1.
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        let read = |f: &str| std::fs::read_to_string(device.join(f)).ok();
        let Some(vendor) = read("vendor").and_then(|v| u32::from_str_radix(v.trim().trim_start_matches("0x"), 16).ok()) else {
            continue;
        };
        let boot_vga = read("boot_vga").map(|v| v.trim() == "1").unwrap_or(false);
        gpus.push(Gpu { vendor, boot_vga });
    }
    gpus
}

/// Switch rendering to the discrete GPU when there is one. Must run before
/// the webview exists.
#[cfg(target_os = "linux")]
pub(crate) fn prefer_discrete() {
    let already_chosen = ["__NV_PRIME_RENDER_OFFLOAD", "DRI_PRIME", "__GLX_VENDOR_LIBRARY_NAME"]
        .iter()
        .any(|v| std::env::var_os(v).is_some());
    let opted_out = std::env::var("LYRIC_OVERLAY_GPU").map(|v| v == "default" || v == "integrated").unwrap_or(false);
    if already_chosen || opted_out {
        return;
    }
    let egl = ["/usr/share/glvnd/egl_vendor.d/10_nvidia.json", "/etc/glvnd/egl_vendor.d/10_nvidia.json"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists());
    for (key, value) in offload_env(&detect(), egl) {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTEL: u32 = 0x8086;
    const AMD: u32 = 0x1002;
    const EGL: Option<&str> = Some("/usr/share/glvnd/egl_vendor.d/10_nvidia.json");

    fn keys(env: &[(&'static str, String)]) -> Vec<&'static str> {
        env.iter().map(|(k, _)| *k).collect()
    }

    #[test]
    fn intel_plus_nvidia_offloads_to_nvidia() {
        let gpus = [Gpu { vendor: INTEL, boot_vga: true }, Gpu { vendor: NVIDIA, boot_vga: false }];
        let env = offload_env(&gpus, EGL);
        assert!(keys(&env).contains(&"__NV_PRIME_RENDER_OFFLOAD"));
        assert!(env.iter().any(|(k, v)| *k == "__EGL_VENDOR_LIBRARY_FILENAMES" && v.ends_with("10_nvidia.json")));
    }

    #[test]
    fn nvidia_without_its_egl_vendor_file_uses_mesa_offload() {
        let gpus = [Gpu { vendor: INTEL, boot_vga: true }, Gpu { vendor: NVIDIA, boot_vga: false }];
        assert_eq!(offload_env(&gpus, None), vec![("DRI_PRIME", "1".to_string())]);
    }

    #[test]
    fn amd_hybrid_uses_dri_prime() {
        let gpus = [Gpu { vendor: AMD, boot_vga: true }, Gpu { vendor: AMD, boot_vga: false }];
        assert_eq!(offload_env(&gpus, EGL), vec![("DRI_PRIME", "1".to_string())]);
    }

    #[test]
    fn a_single_gpu_needs_nothing() {
        assert!(offload_env(&[Gpu { vendor: NVIDIA, boot_vga: true }], EGL).is_empty());
        assert!(offload_env(&[], EGL).is_empty());
    }

    #[test]
    fn no_boot_display_means_no_way_to_tell_which_is_discrete() {
        let gpus = [Gpu { vendor: AMD, boot_vga: false }, Gpu { vendor: NVIDIA, boot_vga: false }];
        assert!(offload_env(&gpus, EGL).is_empty());
    }
}

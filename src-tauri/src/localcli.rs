//! Local developer-CLI fallback for the LLM layer. A Rust port of `localcli.js`.
//!
//! WHY. The cloud providers all fail the same way in practice: a free Gemini
//! quota runs out, an HF token lacks a scope, a key is revoked. When they all
//! miss, every AI feature — translation, transliteration, mood, per-line
//! artist attribution — dies, even on a developer's machine that has a
//! perfectly good model a shell command away. This uses one of those (Claude,
//! Gemini, Ollama, `gh models`, Antigravity CLIs) as the last link in the
//! chain, once the user has explicitly consented (see `set_consent`).
//!
//! BEST-EFFORT BY DESIGN. These are third-party CLIs whose non-interactive
//! contracts are not all stable or documented. Every call runs with a timeout
//! and, on any failure, returns an error so the caller (`llm::convert`) falls
//! through exactly as it does for a cloud provider outage.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

const RUN_TIMEOUT: Duration = Duration::from_secs(90);
const DETECT_TIMEOUT: Duration = Duration::from_secs(4);

/// Must match `identifier` in `tauri.conf.json` — consent is stored
/// standalone (not via an `AppHandle`) so `llm::convert` can reach it from
/// deep in the provider chain without threading one through four modules.
const IDENTIFIER: &str = "com.dhruv.lyricoverlay";

struct Adapter {
    id: &'static str,
    label: &'static str,
    cmd: &'static str,
    install: &'static str,
    verified: bool,
    unverified: bool,
    needs_model: Option<&'static str>,
    /// Builds (program, args) for a one-shot non-interactive call. The prompt
    /// always goes on stdin, never in argv — lyric batches run to thousands
    /// of characters and Windows command lines have a hard length limit.
    command: fn(Option<&str>) -> (String, Vec<String>),
}

static ADAPTERS: &[Adapter] = &[
    Adapter {
        id: "claude",
        label: "Claude CLI",
        cmd: "claude",
        install: "curl -fsSL https://claude.ai/install.sh | bash",
        verified: true,
        unverified: false,
        needs_model: Some("claude"),
        // `-p` is print/non-interactive: read stdin, print the reply, exit.
        // The same `claude` you run in a terminal, signed in the same way —
        // the app never installs or logs it in.
        command: |model| {
            ("claude".into(), vec!["-p".into(), "--model".into(), model.unwrap_or(CLAUDE_MODELS[0].0).into()])
        },
    },
    Adapter {
        id: "gemini",
        label: "Gemini CLI",
        cmd: "gemini",
        install: "npm install -g @google/gemini-cli",
        verified: false,
        unverified: false,
        needs_model: None,
        // Not `-p`: that flag requires the prompt as its own value, and ours
        // is multi-line JSON. Run bare and feed the prompt on stdin instead.
        command: |_| ("gemini".into(), vec![]),
    },
    Adapter {
        id: "ollama",
        label: "Ollama (fully local)",
        cmd: "ollama",
        install: "https://ollama.com/download",
        verified: false,
        unverified: false,
        needs_model: Some("ollama"),
        command: |model| ("ollama".into(), vec!["run".into(), model.unwrap_or("llama3.2").into()]),
    },
    Adapter {
        id: "copilot",
        label: "GitHub Models (gh)",
        cmd: "gh",
        install: "gh extension install github/gh-models",
        verified: false,
        unverified: false,
        needs_model: Some("gh"),
        command: |model| {
            ("gh".into(), vec!["models".into(), "run".into(), model.unwrap_or("openai/gpt-4o-mini").into()])
        },
    },
    Adapter {
        id: "antigravity",
        label: "Antigravity",
        cmd: "antigravity",
        install: "https://antigravity.google/",
        verified: false,
        unverified: true,
        needs_model: None,
        command: |_| ("antigravity".into(), vec![]),
    },
];

/// Models offered for the Claude CLI, newest first; the first is the default.
/// Explicit ids rather than the CLI's `opus`/`sonnet` aliases, so the
/// settings card can say exactly which model answers.
pub const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Opus 5.5 — newest, most capable"),
    ("claude-sonnet-5-5", "Sonnet 5.5 — faster"),
    ("claude-haiku-5-5", "Haiku 5.5 — fastest, lightest"),
];

#[derive(Serialize, Deserialize, Clone, Default)]
struct Consent {
    consented: bool,
    id: Option<String>,
    /// Claude CLI model id; `None` means `CLAUDE_MODELS[0]`.
    #[serde(default)]
    model: Option<String>,
}

/// The per-OS config root, matching where Tauri's `app_config_dir` puts the
/// rest of this app's state.
///
/// This used to be `%APPDATA%` unconditionally — a Windows-only variable. On
/// Linux and macOS there was no path, `save_consent` silently did nothing, and
/// choosing "Use Claude CLI" was forgotten the moment it was clicked: the CLI
/// could never actually be connected outside Windows.
fn config_root() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library").join("Application Support"));
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| h.join(".config")))
}

fn consent_path() -> Option<std::path::PathBuf> {
    Some(config_root()?.join(IDENTIFIER).join("localcli.json"))
}

fn load_consent() -> Consent {
    consent_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_consent(c: &Consent) {
    let Some(path) = consent_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(c) {
        let _ = std::fs::write(path, s);
    }
}

/// Record the user's choice. A known adapter id turns it on; the literal
/// `"declined"` is stored as a real decision (distinct from "never asked",
/// which is what an absent file means); anything else clears it.
pub fn set_consent(id: Option<&str>) {
    // The model choice outlives a disconnect, so reconnecting keeps it.
    let model = load_consent().model;
    let c = match id {
        Some("declined") => Consent { consented: false, id: Some("declined".into()), model },
        Some(x) if ADAPTERS.iter().any(|a| a.id == x) => Consent { consented: true, id: Some(x.to_string()), model },
        _ => Consent { consented: false, id: None, model },
    };
    save_consent(&c);
}

/// Pick the Claude CLI model. Unknown ids are ignored rather than stored, so a
/// typo can never become a `--model` that fails every call.
pub fn set_model(model: &str) {
    if !CLAUDE_MODELS.iter().any(|(id, _)| *id == model) {
        return;
    }
    let mut c = load_consent();
    c.model = Some(model.to_string());
    save_consent(&c);
}

fn claude_model() -> &'static str {
    let chosen = load_consent().model;
    CLAUDE_MODELS
        .iter()
        .find(|(id, _)| Some(*id) == chosen.as_deref())
        .map(|(id, _)| *id)
        .unwrap_or(CLAUDE_MODELS[0].0)
}

pub fn consent() -> Value {
    let c = load_consent();
    let models: Vec<Value> = CLAUDE_MODELS.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect();
    json!({
        "consented": c.consented, "id": c.id, "model": claude_model(), "models": models,
        "saveable": consent_path().is_some(),
    })
}

/// Whether a consented CLI is selected and thus usable.
pub fn is_ready() -> bool {
    let c = load_consent();
    c.consented && c.id.is_some()
}

fn chosen_adapter() -> Option<&'static Adapter> {
    let c = load_consent();
    if !c.consented {
        return None;
    }
    let id = c.id?;
    ADAPTERS.iter().find(|a| a.id == id)
}

/// Which of the known CLIs are installed right now. Reports every adapter
/// (not only installed ones) so the UI can offer an install link.
pub fn detect() -> Value {
    let results: Vec<Value> = ADAPTERS
        .iter()
        .map(|a| {
            let path = resolve_cmd(a.cmd);
            json!({
                "id": a.id, "label": a.label, "installed": path.is_some(),
                "path": path.map(|p| p.to_string_lossy().into_owned()),
                "install": a.install, "unverified": a.unverified, "verified": a.verified,
            })
        })
        .collect();
    json!(results)
}

/// Where `cmd` lives, or None if it is not installed.
///
/// Windows asks `where`, which knows the `.cmd`/`.ps1` shim rules. Elsewhere
/// the search is done here, not by `which`: `which` is not in Arch's `base`
/// (so it can be missing outright), and an app started from a desktop
/// launcher inherits a PATH without the per-user directories CLIs install to
/// — Claude's own installer puts it in `~/.local/bin`, which a Hyprland or
/// GNOME session started by a display manager often does not have. So PATH,
/// then those directories.
fn resolve_cmd(cmd: &str) -> Option<std::path::PathBuf> {
    if cfg!(windows) {
        let out = run_direct("where", &[cmd.to_string()], DETECT_TIMEOUT, None).ok()?;
        return out.lines().map(str::trim).find(|l| !l.is_empty()).map(std::path::PathBuf::from);
    }
    search_dirs().into_iter().map(|d| d.join(cmd)).find(|p| is_executable(p))
}

/// PATH plus the per-user install directories `resolve_cmd` explains.
fn search_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
            dirs.push(home.join(rel));
        }
    }
    for abs in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(abs));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &std::path::Path) -> bool {
    p.is_file()
}

/// Discover a usable model name for adapters that need one.
fn discover_model(kind: &str) -> Option<String> {
    if kind == "claude" {
        return Some(claude_model().to_string());
    }
    if kind != "ollama" {
        // gh-models: no cheap list parse worth the round trip; a default is used.
        return None;
    }
    let out = run_direct("ollama", &["list".to_string()], DETECT_TIMEOUT, None).ok()?;
    // First data row (after the header), first column: a tag like "llama3.2:latest".
    let first_line = out.trim().lines().nth(1)?;
    first_line.split_whitespace().next().map(String::from)
}

/// Build the single prompt string sent to a CLI. These have no structured-
/// output mode, so — like the Groq/HF adapters in `llm.rs` — the schema is
/// described in the prompt and the caller validates the shape.
fn build_prompt(system: &str, user: &str, schema: &Value) -> String {
    format!(
        "{system}\n\n\
Respond with ONLY a JSON object conforming to this JSON Schema. No markdown, no\n\
code fence, no commentary — just the JSON.\n\n\
Schema:\n{schema}\n\n\
Input:\n{user}\n\n\
Remember: output the JSON object and nothing else."
    )
}

/// Run the chosen CLI once and return the parsed JSON. Matches the shape
/// `llm::convert`'s chain expects, so it slots in as one more provider.
pub fn call(system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let adapter = chosen_adapter().ok_or("no local CLI selected")?;
    call_with(adapter, system, user, schema)
}

/// One tiny round trip through a CLI, connected or not, for the settings
/// card's Test button: proves the binary starts, is signed in, and answers in
/// JSON. Returns which model answered and how long it took.
pub fn test(id: &str) -> Result<Value, String> {
    let adapter = ADAPTERS.iter().find(|a| a.id == id).ok_or("unknown CLI")?;
    let schema = json!({ "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] });
    let start = std::time::Instant::now();
    let out = call_with(adapter, "You are a connectivity check.", "Reply with {\"ok\": true}.", &schema)?;
    Ok(json!({
        "ok": out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        "ms": start.elapsed().as_millis() as u64,
        "model": if adapter.id == "claude" { Some(claude_model()) } else { None },
    }))
}

fn call_with(adapter: &Adapter, system: &str, user: &str, schema: &Value) -> Result<Value, String> {

    let mut model = None;
    if let Some(kind) = adapter.needs_model {
        model = discover_model(kind);
        if kind == "ollama" && model.is_none() {
            return Err("ollama has no models pulled (try: ollama pull llama3.2)".into());
        }
    }

    let (file, args) = (adapter.command)(model.as_deref());
    let prompt = build_prompt(system, user, schema);
    let out = run_cli(&file, &args, RUN_TIMEOUT, &prompt).map_err(|e| format!("{}: {e}", adapter.id))?;
    // Name the tool in the parse failure too. These CLIs exit 0 while
    // answering in prose — a usage limit, a login prompt — so "unparseable
    // JSON" with no attribution was the least useful thing this could say
    // about a completely explicable situation.
    crate::llm::parse_json_loose(&out).map_err(|e| format!("{}: {e}", adapter.id))
}

/// Windows npm-global CLIs install as `.cmd`/`.ps1` shims that a direct
/// CreateProcess (what `Command::new` does) cannot execute even when the
/// command is on PATH — measured, matches the same problem `localcli.js`
/// worked around with `shell: true`. Route through `cmd /C` there; spawn
/// directly everywhere else.
fn run_cli(file: &str, args: &[String], timeout: Duration, stdin_data: &str) -> Result<String, String> {
    if cfg!(windows) {
        let mut full_args = vec!["/C".to_string(), file.to_string()];
        full_args.extend(args.iter().cloned());
        run_direct("cmd", &full_args, timeout, Some(stdin_data))
    } else {
        // By absolute path, for the reason `resolve_cmd` gives — and with the
        // same directories on the child's PATH, since an npm-installed CLI is
        // a `#!/usr/bin/env node` script that has to find `node` the same way.
        let program = resolve_cmd(file).ok_or_else(|| format!("{file} not found on PATH or in ~/.local/bin"))?;
        let program = program.to_string_lossy().into_owned();
        run_direct(&program, args, timeout, Some(stdin_data))
    }
}

/// Spawn a process, optionally write `stdin_data` then close stdin, and wait
/// up to `timeout` — killing and erroring out past it. stdout/stderr are
/// drained on their own threads throughout (not just after exit) so a CLI
/// that writes more than fits in one pipe buffer before exiting can't
/// deadlock the wait.
fn run_direct(program: &str, args: &[String], timeout: Duration, stdin_data: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    if let Ok(path) = std::env::join_paths(search_dirs()) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not start: {e}"))?;

    let mut stdin = child.stdin.take();
    let data = stdin_data.map(String::from);
    std::thread::spawn(move || {
        if let (Some(si), Some(d)) = (stdin.as_mut(), data) {
            let _ = si.write_all(d.as_bytes());
        }
        // `si` (and `stdin`) drop here either way, closing the pipe.
    });

    let mut stdout = child.stdout.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(so) = stdout.as_mut() {
            let _ = so.read_to_string(&mut buf);
        }
        buf
    });
    let mut stderr = child.stderr.take();
    let err_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(se) = stderr.as_mut() {
            let _ = se.read_to_string(&mut buf);
        }
        buf
    });

    let start = std::time::Instant::now();
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break Some(status);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let out = out_handle.join().unwrap_or_default();
    let err = err_handle.join().unwrap_or_default();

    match status {
        None => Err(format!("timed out after {}s", timeout.as_secs())),
        Some(s) if s.success() => Ok(out),
        Some(s) => Err(format!("exited {:?}: {}", s.code(), err.chars().take(160).collect::<String>())),
    }
}

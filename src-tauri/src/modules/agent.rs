use serde_json::{json, Value};
use std::io::{Read, Write};

// How a given agent's hook delivers our OSC 777 marker into the terminal.
#[derive(Clone, Copy)]
enum Delivery {
    // Claude returns the sequence via a `terminalSequence` JSON field (it lost
    // /dev/tty access in v2.1.139) and emits it in-band. Cross-platform.
    TerminalSequence,
    // Codex/Gemini hooks can't write to the terminal, so the hook command emits
    // the marker itself: to /dev/tty on Unix, via a CONOUT$ helper on Windows.
    Osc,
}

struct AgentSpec {
    agent: &'static str,
    dir: &'static str,
    file: &'static str,
    events: &'static [(&'static str, &'static str)],
    matcher: bool,
    delivery: Delivery,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        dir: ".claude",
        file: "settings.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("Notification", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::TerminalSequence,
    },
    AgentSpec {
        agent: "codex",
        dir: ".codex",
        file: "hooks.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("PermissionRequest", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
    AgentSpec {
        agent: "gemini",
        dir: ".gemini",
        file: "settings.json",
        events: &[
            ("BeforeAgent", "working"),
            ("Notification", "attention"),
            ("AfterAgent", "finished"),
        ],
        matcher: true,
        delivery: Delivery::Osc,
    },
];

const PI_EXTENSION_DIR: &str = ".pi/agent/extensions";
const PI_EXTENSION_FILE: &str = "anbo-notifications.ts";
const PI_EXTENSION_MARKER: &str = "anbo-pi-notifications-v2";
const PI_STATUS_NEEDLES: [&str; 8] = [
    PI_EXTENSION_MARKER,
    "agent_start",
    "agent_settled",
    "notify;Anbo;pi;${event}",
    "ctx.sessionManager.getSessionId()",
    "session;${sessionId}",
    "emit(\"working\")",
    "emit(\"finished\")",
];
const PI_EXTENSION: &str = r#"// anbo-pi-notifications-v2
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const emit = (event: string) => {
    if (process.env.ANBO_TERMINAL) {
      process.stdout.write(`\u001b]777;notify;Anbo;pi;${event}\u0007`);
    }
  };

  pi.on("agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      emit(`session;${sessionId}`);
    }
    emit("working");
  });
  pi.on("agent_settled", () => emit("finished"));
}
"#;
const OPENCODE_PLUGIN_DIR: &str = ".config/opencode/plugins";
const OPENCODE_PLUGIN_FILE: &str = "anbo-notifications.js";
const OPENCODE_PLUGIN_MARKER: &str = "anbo-opencode-notifications-v1";
const OPENCODE_PLUGIN: &str = r#"// anbo-opencode-notifications-v1
export const AnboNotifications = async () => ({
  event: async ({ event }) => {
    if (!process.env.ANBO_TERMINAL || event.type !== "session.created") return;
    const id = event.properties?.sessionID || event.properties?.info?.id;
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(id)) return;
    process.stdout.write(`\u001b]777;notify;Anbo;opencode;session;${id}\u0007`);
  },
});
"#;

// Substrings identifying a hook command as ours, across every form we've ever
// emitted (legacy /dev/tty Claude, current TerminalSequence, Osc, Windows
// helper). Used to prune our own groups before reinserting so installs are
// idempotent and migrate older markers.
const OWNED_MARKERS: [&str; 4] = [
    "notify;Anbo;",
    "anbo;notify",
    "__anbo_notify",
    "__anbo_hook",
];

fn find(agent: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|s| s.agent == agent)
        .ok_or_else(|| format!("unknown agent {agent}"))
}

fn hook_command(spec: &AgentSpec, event: &str) -> String {
    hook_helper_command(spec.agent, event)
}

#[cfg(unix)]
fn quote_executable(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn quote_executable(path: &str) -> String {
    format!(r#""{path}""#)
}

fn hook_helper_command(agent: &str, event: &str) -> String {
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "anbo".to_string());
    format!("{} __anbo_hook {agent} {event}", quote_executable(&exe))
}

// The stable substring that proves a given (agent, event) hook is installed.
// Kept in sync with hook_command so status reflects what enable writes.
fn status_needle(spec: &AgentSpec, event: &str) -> String {
    format!("__anbo_hook {} {event}", spec.agent)
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value, spec: &AgentSpec) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, marker) in spec.events {
        let arr = hooks.entry(*event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        let mut group = json!({
            "hooks": [ { "type": "command", "command": hook_command(spec, marker) } ]
        });
        if spec.matcher {
            group["matcher"] = json!("*");
        }
        arr.push(group);
    }
    root
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); refusing to overwrite",
                path.display()
            )
        }),
        _ => Ok(json!({})),
    }
}

fn home_path(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(dir)
        .join(file))
}

fn settings_path(spec: &AgentSpec) -> Result<std::path::PathBuf, String> {
    home_path(spec.dir, spec.file)
}

fn pi_extension_path() -> Result<std::path::PathBuf, String> {
    home_path(PI_EXTENSION_DIR, PI_EXTENSION_FILE)
}

fn opencode_plugin_path() -> Result<std::path::PathBuf, String> {
    home_path(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE)
}

fn pi_extension_contents(
    existing: Option<&str>,
    path: &std::path::Path,
) -> Result<&'static str, String> {
    if existing.is_some_and(|s| !s.trim().is_empty() && !s.contains(PI_EXTENSION_MARKER)) {
        return Err(format!(
            "{} is not managed by Anbo; refusing to overwrite",
            path.display()
        ));
    }
    Ok(PI_EXTENSION)
}

fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("anbo-tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

fn pi_extension_write_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|e| format!("resolve {}: {e}", path.display()))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn enable_pi_extension_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == PI_EXTENSION => return Ok(()),
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let contents = pi_extension_contents(existing.as_deref(), path)?;
    write_atomic(&pi_extension_write_path(path)?, contents)
}

fn enable_pi_extension() -> Result<(), String> {
    enable_pi_extension_at(&pi_extension_path()?)
}

fn enable_opencode_plugin_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == OPENCODE_PLUGIN => return Ok(()),
        Ok(s) if s.contains(OPENCODE_PLUGIN_MARKER) => Some(s),
        Ok(_) => {
            return Err(format!(
                "{} is not managed by Anbo; refusing to overwrite",
                path.display()
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let _ = existing;
    write_atomic(&pi_extension_write_path(path)?, OPENCODE_PLUGIN)
}

fn enable_opencode_plugin() -> Result<(), String> {
    enable_opencode_plugin_at(&opencode_plugin_path()?)
}

#[tauri::command]
pub fn agent_enable_hooks(agent: String) -> Result<(), String> {
    if agent == "pi" {
        return enable_pi_extension();
    }
    if agent == "opencode" {
        return enable_opencode_plugin();
    }
    let spec = find(&agent)?;
    let path = settings_path(spec)?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };

    let merged = merge_hooks(existing, spec);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    write_atomic(&path, &out)
}

const HOOK_INPUT_MAX_BYTES: u64 = 64 * 1024;

fn terminal_marker(agent: &str, event: &str) -> String {
    format!("\x1b]777;notify;Anbo;{agent};{event}\x07")
}

fn valid_exact_session_id(agent: &str, session_id: &str) -> bool {
    if agent == "opencode" {
        return session_id.strip_prefix("ses_").is_some_and(|tail| {
            !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric())
        });
    }
    if session_id.len() != 36 {
        return false;
    }
    session_id
        .bytes()
        .enumerate()
        .all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => matches!(byte, b'1'..=b'5'),
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

fn hook_session_id_from_reader(reader: impl Read, agent: &str) -> Option<String> {
    let mut input = Vec::new();
    reader
        .take(HOOK_INPUT_MAX_BYTES + 1)
        .read_to_end(&mut input)
        .ok()?;
    if input.len() as u64 > HOOK_INPUT_MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&input).ok()?;
    let session_id = value.get("session_id")?.as_str()?;
    valid_exact_session_id(agent, session_id).then(|| session_id.to_string())
}

fn hook_terminal_sequence(agent: &str, event: &str, session_id: Option<&str>) -> String {
    let mut sequence = String::new();
    if let Some(session_id) = session_id {
        sequence.push_str(&terminal_marker(agent, &format!("session;{session_id}")));
    }
    sequence.push_str(&terminal_marker(agent, event));
    sequence
}

#[cfg(unix)]
fn emit_tty_sequence(sequence: &str) {
    if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open("/dev/tty") {
        let _ = tty.write_all(sequence.as_bytes());
    }
}

#[cfg(windows)]
fn emit_tty_sequence(sequence: &str) {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
    {
        let _ = f.write_all(sequence.as_bytes());
    }
}

pub fn run_hook_helper(agent: &str, event: &str) {
    let spec = find(agent).ok();
    let valid_event = spec.is_some_and(|candidate| {
        candidate
            .events
            .iter()
            .any(|(_, emitted)| *emitted == event)
    });
    let output = if std::env::var_os("ANBO_TERMINAL").is_none() || !valid_event {
        "{}".to_string()
    } else {
        let session_id = hook_session_id_from_reader(std::io::stdin().lock(), agent);
        let sequence = hook_terminal_sequence(agent, event, session_id.as_deref());
        match spec.map(|candidate| candidate.delivery) {
            Some(Delivery::TerminalSequence) => json!({ "terminalSequence": sequence }).to_string(),
            Some(Delivery::Osc) => {
                emit_tty_sequence(&sequence);
                "{}".to_string()
            }
            None => "{}".to_string(),
        }
    };
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(output.as_bytes());
    let _ = stdout.flush();
}

#[cfg(windows)]
pub fn emit_conout_marker(agent: &str, event: &str) {
    if std::env::var_os("ANBO_TERMINAL").is_some() {
        emit_tty_sequence(&terminal_marker(agent, event));
    }
}

#[tauri::command]
pub fn agent_hooks_status(agent: String) -> bool {
    if agent == "pi" {
        return pi_extension_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|content| {
                PI_STATUS_NEEDLES
                    .iter()
                    .all(|needle| content.contains(needle))
            });
    }
    if agent == "opencode" {
        return opencode_plugin_path()
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|content| content.contains(OPENCODE_PLUGIN_MARKER));
    }
    let Ok(spec) = find(&agent) else {
        return false;
    };
    let Some(content) = settings_path(spec)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    spec.events
        .iter()
        .all(|(_, m)| content.contains(&status_needle(spec, m)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(agent: &str) -> &'static AgentSpec {
        find(agent).unwrap()
    }

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn claude_adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}), spec("claude"));
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("__anbo_hook claude attention"));
        assert!(command(&out, "Stop", 0).contains("__anbo_hook claude finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("__anbo_hook claude working"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn is_idempotent_per_agent() {
        for agent in ["claude", "codex", "gemini"] {
            let s = spec(agent);
            let once = merge_hooks(json!({}), s);
            let twice = merge_hooks(once.clone(), s);
            assert_eq!(once, twice, "{agent} not idempotent");
        }
    }

    #[test]
    fn terminal_marker_matches_detector_format() {
        // Exactly the bytes pty/agent_detect parses (ESC ] 777 ; ... BEL).
        assert_eq!(
            terminal_marker("gemini", "attention"),
            "\u{1b}]777;notify;Anbo;gemini;attention\u{7}"
        );
    }

    #[test]
    fn hook_helper_commands_are_agent_and_event_scoped() {
        let out = merge_hooks(json!({}), spec("codex"));
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "PermissionRequest"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        let stop = command(&out, "Stop", 0);
        assert!(stop.contains("__anbo_hook codex finished"));
    }

    #[test]
    fn gemini_uses_matcher_and_hook_helper() {
        let out = merge_hooks(json!({}), spec("gemini"));
        assert_eq!(out["hooks"]["BeforeAgent"][0]["matcher"], "*");
        assert!(command(&out, "AfterAgent", 0).contains("__anbo_hook gemini finished"));
        assert!(command(&out, "Notification", 0).contains("__anbo_hook gemini attention"));
    }

    #[test]
    fn hook_input_yields_only_valid_real_session_ids() {
        let id = "00000000-0000-4000-8000-000000000001";
        let input = format!(r#"{{"session_id":"{id}"}}"#);
        assert_eq!(
            hook_session_id_from_reader(input.as_bytes(), "claude").as_deref(),
            Some(id)
        );
        assert!(
            hook_session_id_from_reader(br#"{"session_id":"../../bad"}"#.as_slice(), "claude")
                .is_none()
        );
    }

    #[test]
    fn hook_sequence_reports_session_before_activity() {
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(
            hook_terminal_sequence("claude", "working", Some(id)),
            format!(
                "{}{}",
                terminal_marker("claude", &format!("session;{id}")),
                terminal_marker("claude", "working")
            )
        );
    }

    #[test]
    fn pi_extension_emits_named_working_and_finished_markers() {
        let path = std::path::Path::new("/x/anbo-notifications.ts");
        let extension = pi_extension_contents(None, path).unwrap();
        for needle in PI_STATUS_NEEDLES {
            assert!(extension.contains(needle), "missing {needle}");
        }
        assert!(extension.contains("process.env.ANBO_TERMINAL"));
        assert!(extension.contains("process.stdout.write"));
    }

    #[test]
    fn pi_extension_only_replaces_anbo_owned_file() {
        let path = std::path::Path::new("/x/anbo-notifications.ts");
        assert!(pi_extension_contents(Some("export const mine = true;"), path).is_err());
        assert!(pi_extension_contents(Some(PI_EXTENSION), path).is_ok());
        assert!(pi_extension_contents(Some("  \n"), path).is_ok());
    }

    #[test]
    fn pi_extension_install_is_atomic_idempotent_and_preserves_foreign_files() {
        let dir = std::env::temp_dir().join(format!("anbo-pi-extension-{}", std::process::id()));
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        enable_pi_extension_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PI_EXTENSION);
        enable_pi_extension_at(&path).unwrap();

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_pi_extension_at(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "export const mine = true;"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_plugin_emits_exact_session_marker_and_preserves_foreign_files() {
        assert!(OPENCODE_PLUGIN.contains("session.created"));
        assert!(OPENCODE_PLUGIN.contains("notify;Anbo;opencode;session;${id}"));
        assert!(OPENCODE_PLUGIN.contains("process.env.ANBO_TERMINAL"));

        let dir = std::env::temp_dir().join(format!("anbo-opencode-plugin-{}", std::process::id()));
        let path = dir.join(OPENCODE_PLUGIN_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        enable_opencode_plugin_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENCODE_PLUGIN);
        enable_opencode_plugin_at(&path).unwrap();

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_opencode_plugin_at(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "export const mine = true;"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pi_extension_install_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("anbo-pi-extension-symlink-{}", std::process::id()));
        let target = dir.join("managed.ts");
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&target, format!("// {PI_EXTENSION_MARKER}\n")).unwrap();
        symlink(&target, &path).unwrap();

        enable_pi_extension_at(&path).unwrap();

        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), PI_EXTENSION);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$ANBO_TERMINAL\" ] && printf '\\033]777;anbo;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy, spec("claude"));
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("__anbo_hook claude attention"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"));
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"), spec("codex"));
        assert_eq!(hook_count(&out, "Stop"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_command(spec("claude"), "attention") } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude"));
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("__anbo_hook claude attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }
}

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

use crate::modules::workspace::{resolve_path, wsl_home, WorkspaceEnv, WorkspaceRegistry};

// How a given agent's hook delivers our OSC 777 marker into the terminal.
#[derive(Clone, Copy)]
enum Delivery {
    // Claude returns the sequence via a `terminalSequence` JSON field (it lost
    // /dev/tty access in v2.1.139) and emits it in-band. Cross-platform.
    TerminalSequence,
    // Codex/Antigravity hooks can't write to the terminal, so the hook command emits
    // the marker itself: to /dev/tty on Unix, via a CONOUT$ helper on Windows.
    Osc,
}

struct AgentSpec {
    agent: &'static str,
    project_file: &'static str,
    legacy_global_file: &'static str,
    events: &'static [(&'static str, &'static str)],
    matcher: bool,
    delivery: Delivery,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        project_file: ".claude/settings.local.json",
        legacy_global_file: ".claude/settings.json",
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
        project_file: ".codex/hooks.json",
        legacy_global_file: ".codex/hooks.json",
        events: &[
            ("SessionStart", "started"),
            ("UserPromptSubmit", "working"),
            ("PermissionRequest", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
    AgentSpec {
        agent: "antigravity",
        project_file: ".agents/hooks.json",
        legacy_global_file: ".gemini/config/hooks.json",
        events: &[
            ("PreInvocation", "working"),
            ("PreToolUse", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
];

const PI_PROJECT_FILE: &str = ".pi/extensions/anbo-notifications.ts";
const PI_LEGACY_GLOBAL_FILE: &str = ".pi/agent/extensions/anbo-notifications.ts";
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
const OPENCODE_PROJECT_FILE: &str = ".opencode/plugins/anbo-notifications.js";
const OPENCODE_LEGACY_GLOBAL_FILE: &str = ".config/opencode/plugins/anbo-notifications.js";
const OPENCODE_PLUGIN_MARKER: &str = "anbo-opencode-notifications-v2";
const OPENCODE_PLUGIN_LEGACY_MARKER: &str = "anbo-opencode-notifications-v1";
const OPENCODE_PLUGIN: &str = r#"// anbo-opencode-notifications-v2
export const AnboNotifications = async () => {
  let sessionId = null;
  let announced = false;
  let phase = "idle";
  const childSessions = new Set();

  const emit = (event) => {
    if (process.env.ANBO_TERMINAL) {
      process.stdout.write(`\u001b]777;notify;Anbo;opencode;${event}\u0007`);
    }
  };
  const validId = (id) =>
    typeof id === "string" && /^ses_[A-Za-z0-9]+$/.test(id);
  const eventId = (event) =>
    event.properties?.sessionID || event.properties?.info?.id || null;
  const announce = () => {
    if (!announced && validId(sessionId)) {
      emit(`session;${sessionId}`);
      announced = true;
    }
  };
  const setPhase = (next) => {
    if (phase === next) return;
    announce();
    if (!announced) return;
    phase = next;
    emit(next);
  };

  return {
    event: async ({ event }) => {
      if (!process.env.ANBO_TERMINAL) return;

      if (event.type === "session.created") {
        const info = event.properties?.info;
        const id = eventId(event);
        if (!validId(id)) return;
        if (info?.parentID) {
          childSessions.add(id);
          return;
        }
        sessionId = id;
        announced = false;
        phase = "idle";
        return;
      }

      if (event.type === "session.updated" && !sessionId) {
        const info = event.properties?.info;
        const id = eventId(event);
        if (validId(id) && !info?.parentID) sessionId = id;
        return;
      }

      const id = eventId(event);
      if (validId(id)) {
        if (childSessions.has(id)) return;
        if (sessionId && id !== sessionId) return;
        if (!sessionId) sessionId = id;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status?.type || event.properties?.status;
        if (status === "busy" || status === "retry") setPhase("working");
        else if (status === "idle" && announced) setPhase("finished");
        return;
      }
      if (event.type === "session.idle") {
        if (announced) setPhase("finished");
        return;
      }
      if (
        event.type === "permission.asked" ||
        event.type === "question.asked" ||
        event.type === "session.error"
      ) {
        setPhase("attention");
      }
    },
  };
};
"#;

const ANBO_MCP_NAME: &str = "anbomcp";
const ANBO_MCP_URL: &str = "http://127.0.0.1:7331/mcp";
const CLAUDE_MCP_FILE: &str = ".claude/anbo-mcp.json";
const LEGACY_CLAUDE_MCP_FILE: &str = ".mcp.json";
const LEGACY_CLAUDE_MCP_NAME: &str = "anbo-browser";
const CODEX_MCP_FILE: &str = ".codex/config.toml";
const ANTIGRAVITY_MCP_FILE: &str = ".agents/mcp_config.json";
const OPENCODE_MCP_FILE: &str = ".opencode/anbo-mcp.json";

// Substrings identifying a hook command as ours, across every form we've ever
// emitted (legacy /dev/tty Claude, current TerminalSequence, Osc, Windows
// helper). Used to prune our own groups before reinserting so installs are
// idempotent and migrate older markers.
const OWNED_MARKERS: [&str; 8] = [
    "notify;Anbo;",
    "anbo;notify",
    "__anbo_notify",
    "__anbo_hook",
    "notify;Terax;",
    "terax;notify",
    "__terax_notify",
    "__terax_hook",
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
    #[cfg(windows)]
    if agent == "antigravity" {
        let fallback = hook_noop_output(agent, event);
        return format!(
            "if defined ANBO_HOOK_EXE (%ANBO_HOOK_EXE% __anbo_hook {agent} {event}) else (echo {fallback})"
        );
    }
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "anbo".to_string());
    #[cfg(windows)]
    if agent == "codex" {
        let exe = exe.replace('\'', "''");
        return format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"& '{exe}' __anbo_hook {agent} {event}\""
        );
    }
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
    if spec.agent == "antigravity" {
        if !root.is_object() {
            root = json!({});
        }
        let definition = spec.events.iter().fold(
            serde_json::Map::from_iter([("enabled".into(), json!(true))]),
            |mut value, (event, marker)| {
                let handlers = if *event == "PreToolUse" {
                    json!([{
                        "matcher": "ask_question|ask_permission",
                        "hooks": [{
                            "type": "command",
                            "command": hook_command(spec, marker)
                        }]
                    }])
                } else {
                    json!([{ "type": "command", "command": hook_command(spec, marker) }])
                };
                value.insert((*event).into(), handlers);
                value
            },
        );
        root.as_object_mut().unwrap().insert(
            "anbo-desktop-agent-alerts".into(),
            Value::Object(definition),
        );
        return root;
    }
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

fn home_path(relative: &str) -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(relative))
}

fn legacy_global_path(spec: &AgentSpec) -> Result<PathBuf, String> {
    home_path(spec.legacy_global_file)
}

fn authorize_project_root(
    registry: &WorkspaceRegistry,
    workspace_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<PathBuf, String> {
    let resolved = resolve_path(workspace_root, workspace);
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|e| format!("workspace root is not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!(
            "workspace root is not a directory: {}",
            canonical.display()
        ));
    }
    if !registry.is_authorized_root(&canonical) {
        return Err(format!(
            "workspace root is not registered: {}",
            canonical.display()
        ));
    }
    let workspace_home = match workspace {
        WorkspaceEnv::Local => dirs::home_dir(),
        WorkspaceEnv::Wsl { distro } => wsl_home(distro.clone())
            .ok()
            .map(|home| resolve_path(&home, workspace)),
    }
    .and_then(|home| std::fs::canonicalize(home).ok());
    if workspace_home.as_ref() == Some(&canonical) || canonical.parent().is_none() {
        return Err(
            "agent integrations require a project folder; the workspace home/root would make them global"
                .to_string(),
        );
    }
    Ok(canonical)
}

/// Resolve a fixed, project-relative integration path without following a
/// symlink out of the workspace. Missing directories are created one level at
/// a time only after every existing ancestor is verified.
fn project_file_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("project integration path must stay inside the workspace".to_string());
    }

    let parent = relative
        .parent()
        .ok_or_else(|| "project integration path has no parent".to_string())?;
    let mut cursor = root.to_path_buf();
    for component in parent.components() {
        cursor.push(component.as_os_str());
        match std::fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{} is a symlink; refusing to write project integration outside the workspace",
                    cursor.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("{} is not a directory", cursor.display()));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                std::fs::create_dir(&cursor)
                    .map_err(|e| format!("create {}: {e}", cursor.display()))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("inspect {}: {e}", cursor.display())),
        }
    }

    let path = root.join(relative);
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(format!(
            "{} is a symlink; refusing to replace it",
            path.display()
        ));
    }
    Ok(path)
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
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("create temporary file in {}: {e}", parent.display()))?;
    tmp.as_file_mut()
        .write_all(contents.as_bytes())
        .map_err(|e| format!("write temporary file for {}: {e}", path.display()))?;
    tmp.as_file_mut()
        .sync_all()
        .map_err(|e| format!("sync temporary file for {}: {e}", path.display()))?;
    tmp.persist(path)
        .map_err(|e| format!("replace {}: {}", path.display(), e.error))?;
    Ok(())
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

fn enable_opencode_plugin_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == OPENCODE_PLUGIN => return Ok(()),
        Ok(s)
            if s.contains(OPENCODE_PLUGIN_MARKER) || s.contains(OPENCODE_PLUGIN_LEGACY_MARKER) =>
        {
            Some(s)
        }
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

fn remove_owned_hooks(mut root: Value, spec: &AgentSpec) -> (Value, bool) {
    if spec.agent == "antigravity" {
        let changed = root
            .as_object_mut()
            .and_then(|object| object.remove("anbo-desktop-agent-alerts"))
            .is_some();
        return (root, changed);
    }

    let Some(object) = root.as_object_mut() else {
        return (root, false);
    };
    let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) else {
        return (root, false);
    };

    let mut changed = false;
    let events = hooks.keys().cloned().collect::<Vec<_>>();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = groups.len();
        groups.retain(|group| !is_ours(group));
        if groups.len() != before {
            changed = true;
            if groups.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if changed && hooks.is_empty() {
        object.remove("hooks");
    }
    (root, changed)
}

fn remove_legacy_json_at(path: &Path, spec: &AgentSpec) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let root = existing_config(Some(&contents), path)?;
    let (cleaned, changed) = remove_owned_hooks(root, spec);
    if !changed {
        return Ok(false);
    }
    if cleaned.as_object().is_some_and(serde_json::Map::is_empty) {
        std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    } else {
        let output = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
        write_atomic(&pi_extension_write_path(path)?, &output)?;
    }
    Ok(true)
}

fn remove_legacy_owned_file(path: &Path, marker: &str) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    if !contents.contains(marker) {
        return Ok(false);
    }
    std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    Ok(true)
}

/// One-way migration from historical home-scoped integrations. Only commands
/// and files carrying Anbo ownership markers are removed; every foreign hook,
/// plugin, setting, and trust decision is left intact.
pub fn cleanup_legacy_global_integrations() -> Result<usize, String> {
    let mut removed = 0;
    let mut errors = Vec::new();
    for spec in AGENTS {
        match legacy_global_path(spec).and_then(|path| remove_legacy_json_at(&path, spec)) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => errors.push(error),
        }
    }
    for (relative, marker) in [
        (PI_LEGACY_GLOBAL_FILE, PI_EXTENSION_MARKER),
        (OPENCODE_LEGACY_GLOBAL_FILE, OPENCODE_PLUGIN_MARKER),
    ] {
        match home_path(relative).and_then(|path| remove_legacy_owned_file(&path, marker)) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(removed)
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub fn agent_enable_hooks(
    agent: String,
    workspace_root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = authorize_project_root(&registry, &workspace_root, &workspace)?;
    enable_project_integration(&agent, &root)
}

fn enable_project_integration(agent: &str, root: &Path) -> Result<(), String> {
    if agent == "pi" {
        let path = project_file_path(root, PI_PROJECT_FILE, true)?;
        return enable_pi_extension_at(&path);
    }
    if agent == "opencode" {
        let path = project_file_path(root, OPENCODE_PROJECT_FILE, true)?;
        return enable_opencode_plugin_at(&path);
    }
    let spec = find(agent)?;
    let path = project_file_path(root, spec.project_file, true)?;

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
            14 => matches!(byte, b'1'..=b'8'),
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

fn hook_payload_from_reader(reader: impl Read) -> Option<Value> {
    let mut input = Vec::new();
    reader
        .take(HOOK_INPUT_MAX_BYTES + 1)
        .read_to_end(&mut input)
        .ok()?;
    if input.len() as u64 > HOOK_INPUT_MAX_BYTES {
        return None;
    }
    serde_json::from_slice(&input).ok()
}

fn hook_session_id_from_payload(value: &Value, agent: &str) -> Option<String> {
    let key = if agent == "antigravity" {
        "conversationId"
    } else {
        "session_id"
    };
    let session_id = value.get(key)?.as_str()?;
    valid_exact_session_id(agent, session_id).then(|| session_id.to_string())
}

fn should_emit_hook_event(value: Option<&Value>, agent: &str, event: &str) -> bool {
    agent != "antigravity"
        || event != "finished"
        || value
            .and_then(|payload| payload.get("fullyIdle"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
}

fn hook_noop_output(agent: &str, event: &str) -> String {
    if agent == "antigravity" {
        return match event {
            "attention" => json!({ "decision": "allow" }).to_string(),
            "finished" => json!({ "decision": "" }).to_string(),
            _ => "{}".to_string(),
        };
    }
    "{}".to_string()
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
        hook_noop_output(agent, event)
    } else {
        let payload = hook_payload_from_reader(std::io::stdin().lock());
        let session_id = payload
            .as_ref()
            .and_then(|value| hook_session_id_from_payload(value, agent));
        let sequence = if should_emit_hook_event(payload.as_ref(), agent, event) {
            hook_terminal_sequence(agent, event, session_id.as_deref())
        } else {
            String::new()
        };
        match spec.map(|candidate| candidate.delivery) {
            Some(Delivery::TerminalSequence) => json!({ "terminalSequence": sequence }).to_string(),
            Some(Delivery::Osc) => {
                emit_tty_sequence(&sequence);
                hook_noop_output(agent, event)
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
pub fn agent_hooks_status(
    agent: String,
    workspace_root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> bool {
    let workspace = WorkspaceEnv::from_option(workspace);
    let Ok(root) = authorize_project_root(&registry, &workspace_root, &workspace) else {
        return false;
    };
    project_integration_status(&agent, &root)
}

fn project_integration_status(agent: &str, root: &Path) -> bool {
    if agent == "pi" {
        return project_file_path(root, PI_PROJECT_FILE, false)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|content| {
                PI_STATUS_NEEDLES
                    .iter()
                    .all(|needle| content.contains(needle))
            });
    }
    if agent == "opencode" {
        return project_file_path(root, OPENCODE_PROJECT_FILE, false)
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .is_some_and(|content| content.contains(OPENCODE_PLUGIN_MARKER));
    }
    let Ok(spec) = find(agent) else {
        return false;
    };
    let Some(content) = project_file_path(root, spec.project_file, false)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    spec.events
        .iter()
        .all(|(_, m)| content.contains(&status_needle(spec, m)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpResult {
    configured: bool,
    config_path: String,
}

fn mcp_project_file(agent: &str) -> Result<&'static str, String> {
    match agent {
        "claude" => Ok(CLAUDE_MCP_FILE),
        "codex" => Ok(CODEX_MCP_FILE),
        "antigravity" => Ok(ANTIGRAVITY_MCP_FILE),
        "opencode" => Ok(OPENCODE_MCP_FILE),
        _ => Err(format!(
            "agent {agent} does not support automatic Anbo MCP setup"
        )),
    }
}

fn expected_json_mcp(agent: &str) -> Result<(&'static str, Value), String> {
    match agent {
        "claude" => Ok(("mcpServers", json!({ "type": "http", "url": ANBO_MCP_URL }))),
        "antigravity" => Ok(("mcpServers", json!({ "serverUrl": ANBO_MCP_URL }))),
        "opencode" => Ok((
            "mcp",
            json!({
                "type": "remote",
                "url": ANBO_MCP_URL,
                "enabled": true,
                "oauth": false
            }),
        )),
        _ => Err(format!("agent {agent} does not use JSON MCP configuration")),
    }
}

fn json_mcp_matches(agent: &str, value: &Value) -> bool {
    match agent {
        "claude" => {
            value.get("type").and_then(Value::as_str) == Some("http")
                && value.get("url").and_then(Value::as_str) == Some(ANBO_MCP_URL)
        }
        "antigravity" => value.get("serverUrl").and_then(Value::as_str) == Some(ANBO_MCP_URL),
        "opencode" => {
            value.get("type").and_then(Value::as_str) == Some("remote")
                && value.get("url").and_then(Value::as_str) == Some(ANBO_MCP_URL)
        }
        _ => false,
    }
}

fn enable_json_mcp_at(agent: &str, path: &Path) -> Result<(), String> {
    let (container_key, expected) = expected_json_mcp(agent)?;
    let mut root = match std::fs::read_to_string(path) {
        Ok(contents) => existing_config(Some(&contents), path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))?;
    let container = object
        .entry(container_key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "{}.{} must be an object; refusing to overwrite",
                path.display(),
                container_key
            )
        })?;
    if let Some(existing) = container.get(ANBO_MCP_NAME) {
        if !json_mcp_matches(agent, existing) {
            return Err(format!(
                "{}.{}.{} already exists with a different configuration",
                path.display(),
                container_key,
                ANBO_MCP_NAME
            ));
        }
        return Ok(());
    }
    container.insert(ANBO_MCP_NAME.to_string(), expected);
    let mut output = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    output.push('\n');
    write_atomic(path, &output)
}

fn disable_json_mcp_at(agent: &str, path: &Path) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let (container_key, _) = expected_json_mcp(agent)?;
    let mut root = existing_config(Some(&contents), path)?;
    let Some(object) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(container) = object.get_mut(container_key).and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    if !container
        .get(ANBO_MCP_NAME)
        .is_some_and(|entry| json_mcp_matches(agent, entry))
    {
        return Ok(false);
    }
    container.remove(ANBO_MCP_NAME);
    if container.is_empty() {
        object.remove(container_key);
    }
    let dedicated = matches!(agent, "claude" | "opencode");
    let only_schema = object.len() == 1 && object.contains_key("$schema");
    if object.is_empty() || (dedicated && only_schema) {
        std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    } else {
        let mut output = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        output.push('\n');
        write_atomic(path, &output)?;
    }
    Ok(true)
}

fn json_mcp_status_at(agent: &str, path: &Path) -> bool {
    let Ok((container_key, _)) = expected_json_mcp(agent) else {
        return false;
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|root| {
            root.get(container_key)
                .and_then(Value::as_object)
                .and_then(|container| container.get(ANBO_MCP_NAME))
                .cloned()
        })
        .is_some_and(|entry| json_mcp_matches(agent, &entry))
}

fn remove_legacy_claude_mcp_at(path: &Path) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut root = existing_config(Some(&contents), path)?;
    let Some(object) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(servers) = object.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let owned = servers.get(LEGACY_CLAUDE_MCP_NAME).is_some_and(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("http")
            && entry.get("url").and_then(Value::as_str) == Some(ANBO_MCP_URL)
    });
    if !owned {
        return Ok(false);
    }
    servers.remove(LEGACY_CLAUDE_MCP_NAME);
    if servers.is_empty() {
        object.remove("mcpServers");
    }
    if object.is_empty() {
        std::fs::remove_file(path)
            .map_err(|error| format!("remove {}: {error}", path.display()))?;
    } else {
        let mut output = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
        output.push('\n');
        write_atomic(path, &output)?;
    }
    Ok(true)
}

fn parse_codex_config(contents: &str, path: &Path) -> Result<DocumentMut, String> {
    if contents.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    contents.parse::<DocumentMut>().map_err(|error| {
        format!(
            "{} is not valid TOML ({error}); refusing to overwrite",
            path.display()
        )
    })
}

fn codex_mcp_table(document: &DocumentMut) -> Option<&Table> {
    document
        .get("mcp_servers")?
        .as_table()?
        .get(ANBO_MCP_NAME)?
        .as_table()
}

fn codex_mcp_matches(document: &DocumentMut) -> bool {
    codex_mcp_table(document)
        .and_then(|table| table.get("url"))
        .and_then(Item::as_value)
        .and_then(toml_edit::Value::as_str)
        == Some(ANBO_MCP_URL)
}

fn enable_codex_mcp_at(path: &Path) -> Result<(), String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut document = parse_codex_config(&contents, path)?;
    if codex_mcp_table(&document).is_some() {
        if codex_mcp_matches(&document) {
            return Ok(());
        }
        return Err(format!(
            "{}.mcp_servers.{} already exists with a different configuration",
            path.display(),
            ANBO_MCP_NAME
        ));
    }
    if document.get("mcp_servers").is_none() {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = document["mcp_servers"].as_table_mut().ok_or_else(|| {
        format!(
            "{}.mcp_servers must be a table; refusing to overwrite",
            path.display()
        )
    })?;
    let mut server = Table::new();
    server["url"] = toml_value(ANBO_MCP_URL);
    servers[ANBO_MCP_NAME] = Item::Table(server);
    write_atomic(path, &document.to_string())
}

fn disable_codex_mcp_at(path: &Path) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut document = parse_codex_config(&contents, path)?;
    if !codex_mcp_matches(&document) {
        return Ok(false);
    }
    let servers = document["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| format!("{}.mcp_servers is not a table", path.display()))?;
    servers.remove(ANBO_MCP_NAME);
    if servers.is_empty() {
        document.as_table_mut().remove("mcp_servers");
    }
    if document.as_table().is_empty() {
        std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    } else {
        write_atomic(path, &document.to_string())?;
    }
    Ok(true)
}

fn configure_mcp_at(agent: &str, path: &Path, enabled: bool) -> Result<bool, String> {
    if agent == "codex" {
        if enabled {
            enable_codex_mcp_at(path)?;
            Ok(true)
        } else {
            disable_codex_mcp_at(path)?;
            Ok(false)
        }
    } else if enabled {
        enable_json_mcp_at(agent, path)?;
        Ok(true)
    } else {
        disable_json_mcp_at(agent, path)?;
        Ok(false)
    }
}

#[tauri::command]
pub fn agent_configure_mcp(
    agent: String,
    workspace_root: String,
    enabled: bool,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<AgentMcpResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = authorize_project_root(&registry, &workspace_root, &workspace)?;
    let relative = mcp_project_file(&agent)?;
    if agent == "claude" && enabled {
        let legacy = project_file_path(&root, LEGACY_CLAUDE_MCP_FILE, false)?;
        remove_legacy_claude_mcp_at(&legacy)?;
    }
    let path = project_file_path(&root, relative, enabled)?;
    let configured = configure_mcp_at(&agent, &path, enabled)?;
    Ok(AgentMcpResult {
        configured,
        config_path: relative.to_string(),
    })
}

#[tauri::command]
pub fn agent_mcp_status(
    agent: String,
    workspace_root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> bool {
    let workspace = WorkspaceEnv::from_option(workspace);
    let Ok(root) = authorize_project_root(&registry, &workspace_root, &workspace) else {
        return false;
    };
    let Ok(relative) = mcp_project_file(&agent) else {
        return false;
    };
    let Ok(path) = project_file_path(&root, relative, false) else {
        return false;
    };
    if agent == "codex" {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|contents| contents.parse::<DocumentMut>().ok())
            .is_some_and(|document| codex_mcp_matches(&document))
    } else {
        json_mcp_status_at(&agent, &path)
    }
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
        for agent in ["claude", "codex", "antigravity"] {
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
            terminal_marker("antigravity", "attention"),
            "\u{1b}]777;notify;Anbo;antigravity;attention\u{7}"
        );
    }

    #[test]
    fn hook_helper_commands_are_agent_and_event_scoped() {
        let out = merge_hooks(json!({}), spec("codex"));
        assert_eq!(hook_count(&out, "SessionStart"), 1);
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "PermissionRequest"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        let start = command(&out, "SessionStart", 0);
        assert!(start.contains("__anbo_hook codex started"));
        let stop = command(&out, "Stop", 0);
        assert!(stop.contains("__anbo_hook codex finished"));
        #[cfg(windows)]
        {
            assert!(start.starts_with("powershell.exe "));
            assert!(start.contains("-Command \"& '"));
        }
    }

    #[test]
    fn antigravity_uses_named_hook_definition_and_camel_case_conversation_id() {
        let out = merge_hooks(json!({ "mine": { "enabled": true } }), spec("antigravity"));
        let definition = &out["anbo-desktop-agent-alerts"];
        assert_eq!(definition["enabled"], true);
        assert!(definition["PreInvocation"][0]["command"]
            .as_str()
            .unwrap()
            .contains("__anbo_hook antigravity working"));
        assert_eq!(
            definition["PreToolUse"][0]["matcher"],
            "ask_question|ask_permission"
        );
        assert!(definition["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("__anbo_hook antigravity attention"));
        assert!(definition["Stop"][0]["command"]
            .as_str()
            .unwrap()
            .contains("__anbo_hook antigravity finished"));
        assert_eq!(out["mine"]["enabled"], true);

        let id = "00000000-0000-4000-8000-000000000001";
        let payload = json!({ "conversationId": id });
        assert_eq!(
            hook_session_id_from_payload(&payload, "antigravity").as_deref(),
            Some(id)
        );
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_windows_hook_avoids_literal_executable_quotes() {
        let command = hook_helper_command("antigravity", "working");
        assert_eq!(
            command,
            "if defined ANBO_HOOK_EXE (%ANBO_HOOK_EXE% __anbo_hook antigravity working) else (echo {})"
        );
        assert!(!command.contains('"'));

        let attention = hook_helper_command("antigravity", "attention");
        assert!(attention.contains("__anbo_hook antigravity attention"));
        assert!(attention.contains(r#"else (echo {"decision":"allow"})"#));
    }

    #[test]
    fn hook_input_yields_only_valid_real_session_ids() {
        let id = "00000000-0000-4000-8000-000000000001";
        let input = format!(r#"{{"session_id":"{id}"}}"#);
        let payload = hook_payload_from_reader(input.as_bytes()).unwrap();
        assert_eq!(
            hook_session_id_from_payload(&payload, "claude").as_deref(),
            Some(id)
        );
        let invalid =
            hook_payload_from_reader(br#"{"session_id":"../../bad"}"#.as_slice()).unwrap();
        assert!(hook_session_id_from_payload(&invalid, "claude").is_none());

        let codex_v7 = "01a0068e-3c06-75c3-bfdd-89323e589767";
        let codex_payload = json!({ "session_id": codex_v7 });
        assert_eq!(
            hook_session_id_from_payload(&codex_payload, "codex").as_deref(),
            Some(codex_v7)
        );
    }

    #[test]
    fn antigravity_stop_waits_for_background_work_to_be_idle() {
        assert!(!should_emit_hook_event(
            Some(&json!({ "fullyIdle": false })),
            "antigravity",
            "finished"
        ));
        assert!(should_emit_hook_event(
            Some(&json!({ "fullyIdle": true })),
            "antigravity",
            "finished"
        ));
        assert_eq!(
            hook_noop_output("antigravity", "finished"),
            r#"{"decision":""}"#
        );
        assert_eq!(hook_noop_output("antigravity", "working"), "{}");
        assert_eq!(
            hook_noop_output("antigravity", "attention"),
            r#"{"decision":"allow"}"#
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
        let path = dir.join("anbo-notifications.ts");
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
        assert!(OPENCODE_PLUGIN.contains("session.status"));
        assert!(OPENCODE_PLUGIN.contains("session.idle"));
        assert!(OPENCODE_PLUGIN.contains("permission.asked"));
        assert!(OPENCODE_PLUGIN.contains("question.asked"));
        assert!(OPENCODE_PLUGIN.contains("setPhase(\"working\")"));
        assert!(OPENCODE_PLUGIN.contains("setPhase(\"finished\")"));
        assert!(OPENCODE_PLUGIN.contains("notify;Anbo;opencode;${event}"));
        assert!(OPENCODE_PLUGIN.contains("emit(`session;${sessionId}`)"));
        assert!(OPENCODE_PLUGIN.contains("process.env.ANBO_TERMINAL"));

        let dir = std::env::temp_dir().join(format!("anbo-opencode-plugin-{}", std::process::id()));
        let path = dir.join("anbo-notifications.js");
        let _ = std::fs::remove_dir_all(&dir);
        enable_opencode_plugin_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENCODE_PLUGIN);
        enable_opencode_plugin_at(&path).unwrap();

        std::fs::write(
            &path,
            "// anbo-opencode-notifications-v1\nexport const legacy = true;",
        )
        .unwrap();
        enable_opencode_plugin_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENCODE_PLUGIN);

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_opencode_plugin_at(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "export const mine = true;"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_cleanup_removes_only_anbo_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = json!({
            "theme": "mine",
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "my-stop-hook" }] },
                    { "hooks": [{ "type": "command", "command": "anbo __anbo_hook claude finished" }] }
                ],
                "Notification": [
                    { "hooks": [{ "type": "command", "command": "anbo __anbo_hook claude attention" }] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        assert!(remove_legacy_json_at(&path, spec("claude")).unwrap());
        let cleaned: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(cleaned["theme"], "mine");
        assert_eq!(hook_count(&cleaned, "Stop"), 1);
        assert_eq!(command(&cleaned, "Stop", 0), "my-stop-hook");
        assert!(cleaned["hooks"].get("Notification").is_none());
    }

    #[test]
    fn legacy_cleanup_removes_pre_anbo_hooks_without_touching_foreign_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        let original = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "my-stop-hook" }] },
                    { "hooks": [{ "type": "command", "command": "terax.exe __terax_notify codex finished" }] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        assert!(remove_legacy_json_at(&path, spec("codex")).unwrap());
        let cleaned: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(hook_count(&cleaned, "Stop"), 1);
        assert_eq!(command(&cleaned, "Stop", 0), "my-stop-hook");
    }

    #[test]
    fn legacy_cleanup_deletes_anbo_only_json_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        let installed = merge_hooks(json!({}), spec("codex"));
        std::fs::write(&path, serde_json::to_string_pretty(&installed).unwrap()).unwrap();

        assert!(remove_legacy_json_at(&path, spec("codex")).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn project_integration_requires_an_exact_registered_root() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("child");
        std::fs::create_dir(&child).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();

        assert!(
            authorize_project_root(&registry, child.to_str().unwrap(), &WorkspaceEnv::Local)
                .is_err()
        );
        registry.authorize(&child).unwrap();
        assert_eq!(
            authorize_project_root(&registry, child.to_str().unwrap(), &WorkspaceEnv::Local)
                .unwrap(),
            std::fs::canonicalize(child).unwrap()
        );
    }

    #[test]
    fn project_integration_path_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        assert!(project_file_path(dir.path(), "../hooks.json", true).is_err());
        let path = project_file_path(dir.path(), ".codex/hooks.json", true).unwrap();
        assert!(path.starts_with(dir.path()));
        assert!(path.parent().unwrap().is_dir());
    }

    #[test]
    fn every_supported_integration_installs_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        for agent in ["claude", "codex", "antigravity", "pi", "opencode"] {
            enable_project_integration(agent, dir.path()).unwrap();
            assert!(
                project_integration_status(agent, dir.path()),
                "{agent} project integration was not detected"
            );
        }
        for relative in [
            ".claude/settings.local.json",
            ".codex/hooks.json",
            ".agents/hooks.json",
            PI_PROJECT_FILE,
            OPENCODE_PROJECT_FILE,
        ] {
            assert!(dir.path().join(relative).is_file(), "missing {relative}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn pi_extension_install_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("anbo-pi-extension-symlink-{}", std::process::id()));
        let target = dir.join("managed.ts");
        let path = dir.join("anbo-notifications.ts");
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

    #[test]
    fn json_mcp_install_is_idempotent_and_preserves_foreign_servers() {
        for (agent, relative) in [
            ("claude", CLAUDE_MCP_FILE),
            ("antigravity", ANTIGRAVITY_MCP_FILE),
            ("opencode", OPENCODE_MCP_FILE),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = project_file_path(dir.path(), relative, true).unwrap();
            let (container, _) = expected_json_mcp(agent).unwrap();
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&json!({
                    (container): {
                        "foreign": { "url": "https://example.com/mcp" }
                    }
                }))
                .unwrap(),
            )
            .unwrap();

            enable_json_mcp_at(agent, &path).unwrap();
            let once = std::fs::read_to_string(&path).unwrap();
            enable_json_mcp_at(agent, &path).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), once);
            let root: Value = serde_json::from_str(&once).unwrap();
            assert!(root[container]["foreign"].is_object());
            assert!(json_mcp_matches(agent, &root[container][ANBO_MCP_NAME]));

            assert!(disable_json_mcp_at(agent, &path).unwrap());
            let root: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert!(root[container]["foreign"].is_object());
            assert!(root[container].get(ANBO_MCP_NAME).is_none());
        }
    }

    #[test]
    fn json_mcp_refuses_to_replace_a_foreign_anbomcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = project_file_path(dir.path(), CLAUDE_MCP_FILE, true).unwrap();
        std::fs::write(
            &path,
            r#"{"mcpServers":{"anbomcp":{"type":"http","url":"https://other.test/mcp"}}}"#,
        )
        .unwrap();
        assert!(enable_json_mcp_at("claude", &path).is_err());
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("https://other.test/mcp"));
    }

    #[test]
    fn claude_mcp_migration_removes_anbo_only_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY_CLAUDE_MCP_FILE);
        std::fs::write(
            &path,
            r#"{"mcpServers":{"anbo-browser":{"type":"http","url":"http://127.0.0.1:7331/mcp"}}}"#,
        )
        .unwrap();

        assert!(remove_legacy_claude_mcp_at(&path).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn claude_mcp_migration_preserves_foreign_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY_CLAUDE_MCP_FILE);
        std::fs::write(
            &path,
            r#"{"custom":true,"mcpServers":{"anbo-browser":{"type":"http","url":"http://127.0.0.1:7331/mcp"},"foreign":{"type":"http","url":"https://example.com/mcp"}}}"#,
        )
        .unwrap();

        assert!(remove_legacy_claude_mcp_at(&path).unwrap());
        let root: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(root["custom"], json!(true));
        assert!(root["mcpServers"]["foreign"].is_object());
        assert!(root["mcpServers"].get(LEGACY_CLAUDE_MCP_NAME).is_none());
    }

    #[test]
    fn claude_mcp_migration_does_not_claim_a_foreign_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY_CLAUDE_MCP_FILE);
        let original =
            r#"{"mcpServers":{"anbo-browser":{"type":"http","url":"https://example.com/mcp"}}}"#;
        std::fs::write(&path, original).unwrap();

        assert!(!remove_legacy_claude_mcp_at(&path).unwrap());
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn claude_mcp_migration_refuses_invalid_json_without_changing_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY_CLAUDE_MCP_FILE);
        let original = "{ not json";
        std::fs::write(&path, original).unwrap();

        assert!(remove_legacy_claude_mcp_at(&path).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn codex_mcp_install_preserves_toml_and_removes_only_anbo() {
        let dir = tempfile::tempdir().unwrap();
        let path = project_file_path(dir.path(), CODEX_MCP_FILE, true).unwrap();
        std::fs::write(
            &path,
            "# keep this comment\nmodel = \"gpt-test\"\n\n[mcp_servers.foreign]\nurl = \"https://example.com/mcp\"\n",
        )
        .unwrap();

        enable_codex_mcp_at(&path).unwrap();
        let installed = std::fs::read_to_string(&path).unwrap();
        assert!(installed.contains("# keep this comment"));
        assert!(installed.contains("[mcp_servers.foreign]"));
        assert!(installed.contains("[mcp_servers.anbomcp]"));
        let parsed = installed.parse::<DocumentMut>().unwrap();
        assert!(codex_mcp_matches(&parsed));

        assert!(disable_codex_mcp_at(&path).unwrap());
        let removed = std::fs::read_to_string(path).unwrap();
        assert!(removed.contains("# keep this comment"));
        assert!(removed.contains("[mcp_servers.foreign]"));
        assert!(!removed.contains("mcp_servers.anbomcp"));
    }
}

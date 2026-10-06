use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

use crate::modules::workspace::{resolve_path, wsl_home, WorkspaceEnv, WorkspaceRegistry};

// Where older Anbo versions wrote each agent's hook commands. Anbo writes no
// hooks any more (agent status comes from the rendered terminal screen), so
// these files are only cleaned up.
struct HookFiles {
    agent: &'static str,
    project_file: &'static str,
    legacy_global_file: &'static str,
}

const HOOK_FILES: &[HookFiles] = &[
    HookFiles {
        agent: "claude",
        project_file: ".claude/settings.local.json",
        legacy_global_file: ".claude/settings.json",
    },
    HookFiles {
        agent: "codex",
        project_file: ".codex/hooks.json",
        legacy_global_file: ".codex/hooks.json",
    },
    HookFiles {
        agent: "antigravity",
        project_file: ".agents/hooks.json",
        legacy_global_file: ".gemini/config/hooks.json",
    },
];

// The Pi extension and the OpenCode plugin older versions wrote, each told
// apart from a foreign file by the marker on its first line.
const PI_PROJECT_FILE: &str = ".pi/extensions/anbo-notifications.ts";
const PI_LEGACY_GLOBAL_FILE: &str = ".pi/agent/extensions/anbo-notifications.ts";
const PI_EXTENSION_MARKER: &str = "anbo-pi-notifications-v2";
const OPENCODE_PROJECT_FILE: &str = ".opencode/plugins/anbo-notifications.js";
const OPENCODE_LEGACY_GLOBAL_FILE: &str = ".config/opencode/plugins/anbo-notifications.js";
const OPENCODE_PLUGIN_MARKER: &str = "anbo-opencode-notifications-v2";
const OPENCODE_PLUGIN_LEGACY_MARKER: &str = "anbo-opencode-notifications-v1";

const ANBO_MCP_NAME: &str = "anbomcp";
const ANBO_MCP_URL: &str = "http://127.0.0.1:7331/mcp";
const CLAUDE_MCP_FILE: &str = ".claude/anbo-mcp.json";
const LEGACY_CLAUDE_MCP_FILE: &str = ".mcp.json";
const LEGACY_CLAUDE_MCP_NAME: &str = "anbo-browser";
const CODEX_MCP_FILE: &str = ".codex/config.toml";
const ANTIGRAVITY_MCP_FILE: &str = ".agents/mcp_config.json";
const OPENCODE_MCP_FILE: &str = ".opencode/anbo-mcp.json";
// Kimi Code reads three MCP files; this is its project-local one, which is
// scoped to the directory the CLI was started in and so cannot leak Anbo's
// server into a repo the user shares.
const KIMI_MCP_FILE: &str = ".kimi-code/mcp.json";

// Substrings that mark a hook command as Anbo's, across every form an older
// Anbo (or Terax before it) wrote. Cleanup removes only groups carrying one.
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

fn legacy_global_path(files: &HookFiles) -> Result<PathBuf, String> {
    home_path(files.legacy_global_file)
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

// Where a rewrite of `path` lands: a symlinked config is rewritten at its
// target, so the link stays a link.
fn resolved_write_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|e| format!("resolve {}: {e}", path.display()))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn remove_owned_hooks(mut root: Value, files: &HookFiles) -> (Value, bool) {
    if files.agent == "antigravity" {
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

fn remove_legacy_json_at(path: &Path, files: &HookFiles) -> Result<bool, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let root = existing_config(Some(&contents), path)?;
    let (cleaned, changed) = remove_owned_hooks(root, files);
    if !changed {
        return Ok(false);
    }
    if cleaned.as_object().is_some_and(serde_json::Map::is_empty) {
        std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    } else {
        let output = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
        write_atomic(&resolved_write_path(path)?, &output)?;
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
    for files in HOOK_FILES {
        match legacy_global_path(files).and_then(|path| remove_legacy_json_at(&path, files)) {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => errors.push(error),
        }
    }
    for (relative, marker) in [
        (PI_LEGACY_GLOBAL_FILE, PI_EXTENSION_MARKER),
        (OPENCODE_LEGACY_GLOBAL_FILE, OPENCODE_PLUGIN_MARKER),
        (OPENCODE_LEGACY_GLOBAL_FILE, OPENCODE_PLUGIN_LEGACY_MARKER),
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

fn cleanup_project_integrations(root: &Path) -> Result<usize, String> {
    let mut removed = 0;
    let mut errors = Vec::new();
    for files in HOOK_FILES {
        match project_file_path(root, files.project_file, false)
            .and_then(|path| remove_legacy_json_at(&path, files))
        {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => errors.push(error),
        }
    }
    for (relative, marker) in [
        (PI_PROJECT_FILE, PI_EXTENSION_MARKER),
        (OPENCODE_PROJECT_FILE, OPENCODE_PLUGIN_MARKER),
        (OPENCODE_PROJECT_FILE, OPENCODE_PLUGIN_LEGACY_MARKER),
    ] {
        match project_file_path(root, relative, false)
            .and_then(|path| remove_legacy_owned_file(&path, marker))
        {
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
pub fn agent_cleanup_hooks(
    workspace_root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<usize, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = authorize_project_root(&registry, &workspace_root, &workspace)?;
    cleanup_project_integrations(&root)
}

// What an agent expects back from a hook that changes nothing. Antigravity
// reads a decision from its hooks; these leave its behavior as it was.
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

/// Answers a hook command an older Anbo wrote (`anbo __anbo_hook <agent>
/// <event>`, or `__anbo_notify` on Windows) that cleanup never reached, such
/// as one in a project that is not a space: the agent's no-op reply, so the
/// hook succeeds, changes nothing and starts no Anbo window.
pub fn answer_leftover_hook(agent: &str, event: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(hook_noop_output(agent, event).as_bytes());
    let _ = stdout.flush();
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
        "kimi" => Ok(KIMI_MCP_FILE),
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
        // Kimi infers the transport from `command` vs `url`, and rejects the
        // entry if both are present -- so the url stands alone here.
        "kimi" => Ok(("mcpServers", json!({ "url": ANBO_MCP_URL }))),
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
        "kimi" => value.get("url").and_then(Value::as_str) == Some(ANBO_MCP_URL),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn files(agent: &str) -> &'static HookFiles {
        HOOK_FILES
            .iter()
            .find(|files| files.agent == agent)
            .unwrap()
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

    fn anbo_command(agent: &str, event: &str) -> String {
        format!(r#""C:\Users\me\AppData\Local\Anbo\anbo.exe" __anbo_hook {agent} {event}"#)
    }

    fn group(command: String) -> Value {
        json!({ "hooks": [{ "type": "command", "command": command }] })
    }

    // The hook files older versions wrote, as they wrote them.
    fn claude_hooks_as_written() -> Value {
        json!({ "hooks": {
            "SessionStart": [group(anbo_command("claude", "ready"))],
            "UserPromptSubmit": [group(anbo_command("claude", "working"))],
            "Notification": [group(anbo_command("claude", "attention"))],
            "Stop": [group(anbo_command("claude", "finished"))]
        } })
    }

    fn codex_hooks_as_written() -> Value {
        let command = |event: &str| {
            format!(
                r#"powershell.exe -NoLogo -NoProfile -NonInteractive -Command "& 'C:\Users\me\AppData\Local\Anbo\anbo.exe' __anbo_hook codex {event}""#
            )
        };
        json!({ "hooks": {
            "SessionStart": [group(command("ready"))],
            "UserPromptSubmit": [group(command("working"))],
            "PermissionRequest": [group(command("attention"))],
            "Stop": [group(command("finished"))]
        } })
    }

    fn antigravity_hooks_as_written() -> Value {
        let command = |event: &str| {
            format!("if defined ANBO_HOOK_EXE (%ANBO_HOOK_EXE% __anbo_hook antigravity {event}) else (echo {{}})")
        };
        json!({ "anbo-desktop-agent-alerts": {
            "enabled": true,
            "PreInvocation": [{ "type": "command", "command": command("working") }],
            "PreToolUse": [{
                "matcher": "ask_question|ask_permission",
                "hooks": [{ "type": "command", "command": command("attention") }]
            }],
            "Stop": [{ "type": "command", "command": command("finished") }]
        } })
    }

    #[test]
    fn leftover_hooks_get_the_agents_no_op_answer() {
        assert_eq!(hook_noop_output("claude", "finished"), "{}");
        assert_eq!(hook_noop_output("codex", "attention"), "{}");
        assert_eq!(hook_noop_output("antigravity", "working"), "{}");
        assert_eq!(
            hook_noop_output("antigravity", "attention"),
            r#"{"decision":"allow"}"#
        );
        assert_eq!(
            hook_noop_output("antigravity", "finished"),
            r#"{"decision":""}"#
        );
        assert_eq!(hook_noop_output("", ""), "{}");
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

        assert!(remove_legacy_json_at(&path, files("claude")).unwrap());
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

        assert!(remove_legacy_json_at(&path, files("codex")).unwrap());
        let cleaned: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(hook_count(&cleaned, "Stop"), 1);
        assert_eq!(command(&cleaned, "Stop", 0), "my-stop-hook");
    }

    #[test]
    fn legacy_cleanup_deletes_anbo_only_json_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        let installed = codex_hooks_as_written();
        std::fs::write(&path, serde_json::to_string_pretty(&installed).unwrap()).unwrap();

        assert!(remove_legacy_json_at(&path, files("codex")).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn legacy_cleanup_removes_the_old_dev_tty_hook() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
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
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        assert!(remove_legacy_json_at(&path, files("claude")).unwrap());
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
    fn project_cleanup_removes_only_anbo_owned_integrations() {
        let dir = tempfile::tempdir().unwrap();
        let write = |relative: &str, contents: String| {
            let path = dir.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        };
        let mut claude = claude_hooks_as_written();
        claude["theme"] = json!("mine");
        claude["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "hooks": [{ "type": "command", "command": "my-stop-hook" }] }));
        write(
            ".claude/settings.local.json",
            serde_json::to_string_pretty(&claude).unwrap(),
        );
        write(
            ".codex/hooks.json",
            serde_json::to_string_pretty(&codex_hooks_as_written()).unwrap(),
        );
        write(
            ".agents/hooks.json",
            serde_json::to_string_pretty(&antigravity_hooks_as_written()).unwrap(),
        );
        write(
            PI_PROJECT_FILE,
            format!("// {PI_EXTENSION_MARKER}\nexport default function () {{}}\n"),
        );
        // A plugin from before v2 goes too.
        write(
            OPENCODE_PROJECT_FILE,
            format!("// {OPENCODE_PLUGIN_LEGACY_MARKER}\nexport const legacy = true;\n"),
        );

        assert_eq!(cleanup_project_integrations(dir.path()).unwrap(), 5);
        let claude_path = dir.path().join(".claude/settings.local.json");
        let cleaned: Value =
            serde_json::from_str(&std::fs::read_to_string(&claude_path).unwrap()).unwrap();
        assert_eq!(cleaned["theme"], "mine");
        assert_eq!(hook_count(&cleaned, "Stop"), 1);
        assert_eq!(command(&cleaned, "Stop", 0), "my-stop-hook");
        assert!(cleaned["hooks"].get("SessionStart").is_none());
        for relative in [
            ".codex/hooks.json",
            ".agents/hooks.json",
            PI_PROJECT_FILE,
            OPENCODE_PROJECT_FILE,
        ] {
            assert!(
                !dir.path().join(relative).exists(),
                "{relative} is still there"
            );
        }
        assert_eq!(cleanup_project_integrations(dir.path()).unwrap(), 0);
    }

    #[test]
    fn project_cleanup_leaves_a_foreign_plugin_at_anbos_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(OPENCODE_PROJECT_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "export const mine = true;").unwrap();

        assert_eq!(cleanup_project_integrations(dir.path()).unwrap(), 0);
        assert!(path.exists());
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
            ("kimi", KIMI_MCP_FILE),
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
    fn kimi_gets_a_url_only_entry_in_its_project_local_file() {
        // Kimi infers the transport from `command` vs `url`. Writing a `type`
        // beside the url is how the other CLIs want it and how Kimi refuses it,
        // so the entry is deliberately bare -- and it goes in the project-local
        // file, never the repo-shared .mcp.json.
        assert_eq!(mcp_project_file("kimi").unwrap(), ".kimi-code/mcp.json");
        let (container, entry) = expected_json_mcp("kimi").unwrap();
        assert_eq!(container, "mcpServers");
        assert_eq!(entry["url"], json!(ANBO_MCP_URL));
        assert!(entry.get("type").is_none());
        assert!(entry.get("transport").is_none());
        assert!(entry.get("command").is_none());
        assert!(json_mcp_matches("kimi", &entry));
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

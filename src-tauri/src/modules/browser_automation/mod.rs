mod accessible_name;
pub mod actions;
pub mod activity;
pub mod agent_actions;
pub mod caller;
pub mod cdp;
pub mod design;
pub mod download;
pub mod http;
pub mod locator;
mod locator_target;
pub mod mcp;
pub(crate) mod network;
mod output_path;
mod page_state;
mod peer;
pub mod protocol;
mod readable_text;
mod ref_context;
mod ref_scan;
pub mod registry;
pub mod server;
pub mod snapshot;
mod timings;
mod visibility;

use tauri::AppHandle;

const MAX_ACTION_REQUEST_BYTES: usize = 64 * 1024;

#[tauri::command]
pub fn browser_automation_finish_turn(
    app: AppHandle,
    webview: tauri::Webview,
    target: activity::TurnEnd,
) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("main webview required".into());
    }
    Ok(activity::end_observed(&app, &target))
}

#[tauri::command]
pub async fn browser_automation_start(app: AppHandle) -> Result<(), String> {
    server::start_server(app)
}

#[tauri::command]
pub async fn browser_automation_stop() -> Result<(), String> {
    server::stop_server();
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "running": server::is_running(),
        "mcpUrl": if http::is_running() { Some(http::MCP_URL) } else { None }
    }))
}

/// Publish what each live agent goes by, keyed by the terminal it runs in.
///
/// Only the frontend mints a callsign, and only the browser side knows which
/// terminal a caller speaks from; this is where the two meet, so a driven tab
/// can say "Leander" instead of naming the CLI for the third time.
#[tauri::command]
pub async fn browser_set_agent_callsigns(
    window: tauri::Window,
    callsigns: std::collections::HashMap<u32, String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main window may publish agent callsigns".into());
    }
    const MAX_AGENTS: usize = 256;
    const MAX_NAME: usize = 48;
    if callsigns.len() > MAX_AGENTS {
        return Err(format!("at most {MAX_AGENTS} callsigns"));
    }
    let bounded = callsigns
        .into_iter()
        .filter_map(|(pty, name)| {
            let name = name.trim();
            (!name.is_empty() && name.chars().count() <= MAX_NAME)
                .then(|| (pty, name.to_string()))
        })
        .collect();
    caller::set_agent_callsigns(bounded);
    Ok(())
}

fn ensure_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main window may drive design mode".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_design_set(
    app: AppHandle,
    window: tauri::Window,
    tab_id: i64,
    active: bool,
    theme: Option<serde_json::Value>,
) -> Result<design::Status, String> {
    ensure_main_window(&window)?;
    if tab_id <= 0 {
        return Err("invalid browser tab id".into());
    }
    design::set_active(&app, tab_id, active, theme).await
}

#[tauri::command]
pub async fn browser_design_theme(
    app: AppHandle,
    window: tauri::Window,
    tab_id: i64,
    theme: serde_json::Value,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    if tab_id <= 0 {
        return Err("invalid browser tab id".into());
    }
    design::set_theme(&app, tab_id, &theme).await
}

#[tauri::command]
pub async fn browser_design_command(
    app: AppHandle,
    window: tauri::Window,
    tab_id: i64,
    command: String,
) -> Result<design::Status, String> {
    ensure_main_window(&window)?;
    if tab_id <= 0 {
        return Err("invalid browser tab id".into());
    }
    if command.len() > 32 {
        return Err("unknown design command".into());
    }
    design::command(&app, tab_id, &command).await
}

#[tauri::command]
pub async fn browser_design_capture(
    app: AppHandle,
    window: tauri::Window,
    tab_id: i64,
    workspace: String,
    include_image: Option<bool>,
) -> Result<serde_json::Value, String> {
    ensure_main_window(&window)?;
    if tab_id <= 0 {
        return Err("invalid browser tab id".into());
    }
    design::capture(&app, tab_id, &workspace, include_image.unwrap_or(false)).await
}

#[tauri::command]
pub async fn browser_automation_handle_action(
    app: AppHandle,
    request_json: String,
) -> Result<String, String> {
    if request_json.len() > MAX_ACTION_REQUEST_BYTES {
        return Err(format!(
            "browser automation request exceeds {MAX_ACTION_REQUEST_BYTES} bytes"
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(&request_json).map_err(|e| format!("invalid json request: {e}"))?;
    let method = value
        .get("action")
        .or_else(|| value.get("method"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing 'action' or 'method' field".to_string())?
        .to_string();

    actions::handle_action_as(&app, &method, value, caller::Caller::internal())
        .await
        .map(|res| res.to_string())
        .map_err(|(code, msg)| format!("[{code}] {msg}"))
}

pub fn on_exit() {
    server::stop_server();
    activity::clear();
    design::clear();
    download::clear();
    registry::clear_tab_locks();
    snapshot::clear_generations();
}

#[cfg(test)]
mod tests {
    use super::{on_exit, registry, snapshot};
    use std::sync::Arc;

    #[test]
    fn shutdown_clears_browser_locks_and_snapshot_generations() {
        let first_lock = registry::get_tab_lock(991_339);
        assert_eq!(snapshot::get_next_generation(991_339), 1);
        on_exit();
        let second_lock = registry::get_tab_lock(991_339);
        assert!(!Arc::ptr_eq(&first_lock, &second_lock));
        assert_eq!(snapshot::get_current_generation(991_339), 0);
        registry::remove_tab_lock(991_339);
    }
}

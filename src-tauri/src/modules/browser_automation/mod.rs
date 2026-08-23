pub mod actions;
pub mod agent_actions;
pub mod cdp;
pub mod download;
pub mod http;
pub mod locator;
pub mod mcp;
pub mod protocol;
pub mod registry;
pub mod server;
pub mod snapshot;

use tauri::AppHandle;

const MAX_ACTION_REQUEST_BYTES: usize = 64 * 1024;

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

    actions::handle_action(&app, &method, value)
        .await
        .map(|res| res.to_string())
        .map_err(|(code, msg)| format!("[{code}] {msg}"))
}

pub fn on_exit() {
    server::stop_server();
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

pub mod actions;
pub mod cdp;
pub mod protocol;
pub mod registry;
pub mod server;
pub mod snapshot;

use tauri::AppHandle;

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
        "running": server::is_running()
    }))
}

#[tauri::command]
pub async fn browser_automation_handle_action(
    app: AppHandle,
    request_json: String,
) -> Result<String, String> {
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
}

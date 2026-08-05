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

pub fn on_exit() {
    server::stop_server();
}

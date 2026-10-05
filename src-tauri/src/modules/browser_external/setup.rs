use super::protocol::Browser;
use serde::Serialize;
use tauri::{AppHandle, Webview};

#[cfg(windows)]
mod windows;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    browser: Browser,
    extension_path: String,
    extensions_url: String,
    warning: Option<String>,
}

#[tauri::command]
pub async fn browser_external_setup(
    app: AppHandle,
    webview: Webview,
    browser: Browser,
) -> Result<SetupResult, String> {
    super::ensure_main(&webview)?;
    #[cfg(windows)]
    {
        windows::install(app, browser).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, browser);
        Err("Browser setup is currently available on Windows only.".into())
    }
}

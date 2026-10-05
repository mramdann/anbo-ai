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

/// After an update, brings an earlier Setup's extension files and native host
/// up to this build, off the main thread. A Setup never run is left alone.
#[cfg(windows)]
pub fn refresh_installed(app: &AppHandle) {
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(executable) = std::env::current_exe() else {
            return;
        };
        let sidecar = executable.with_file_name("anbo-browser.exe");
        match windows::refresh_installed(&identifier, &sidecar) {
            Ok(refreshed) => {
                if refreshed.extension {
                    log::info!("[browser_bridge] extension files updated; browsers run them after a reload");
                }
                if refreshed.native_host {
                    log::info!("[browser_bridge] native host updated");
                }
            }
            Err(error) => {
                log::warn!("[browser_bridge] could not update the browser bridge: {error}")
            }
        }
    });
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

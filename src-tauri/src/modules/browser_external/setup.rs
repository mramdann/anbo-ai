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

fn ensure_preview(identifier: &str, development: bool) -> Result<(), String> {
    if !development || identifier == "com.anbo.desktop" {
        return Err("Browser setup requires an isolated Anbo development preview.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_external_setup(
    app: AppHandle,
    webview: Webview,
    browser: Browser,
) -> Result<SetupResult, String> {
    super::ensure_main(&webview)?;
    ensure_preview(&app.config().identifier, cfg!(debug_assertions))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_setup_never_modifies_the_production_installation() {
        assert!(ensure_preview("com.anbo.desktop", true).is_err());
        assert!(ensure_preview("com.anbo.desktop", false).is_err());
        assert!(ensure_preview("com.anbo.desktop.dev", false).is_err());
        assert!(ensure_preview("com.anbo.desktop.dev", true).is_ok());
    }
}

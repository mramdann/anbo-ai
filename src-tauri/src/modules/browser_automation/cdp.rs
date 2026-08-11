use tauri::Webview;

#[cfg(windows)]
pub async fn execute_script(webview: &Webview, script: &str) -> Result<String, String> {
    execute_script_with_timeout(webview, script, std::time::Duration::from_secs(10)).await
}

/// Same as [`execute_script`] but with a caller-controlled timeout. Use a short
/// timeout (e.g. 2s) for readiness/wait polling: during navigation the WebView2
/// script-completion callback is dropped, and a single drop must not be allowed
/// to block for the full default timeout and consume the entire poll budget.
#[cfg(windows)]
pub async fn execute_script_with_timeout(
    webview: &Webview,
    script: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::PCWSTR;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let script_utf16: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();

    let platform_sender = sender.clone();

    webview
        .with_webview(move |platform| {
            let run = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let callback_sender = platform_sender.clone();
                let handler = ExecuteScriptCompletedHandler::create(Box::new(
                    move |error_code, result_json| {
                        let result = if error_code.is_ok() {
                            let json_str = if result_json.is_empty() {
                                "null".to_string()
                            } else {
                                result_json
                            };
                            Ok(json_str)
                        } else {
                            Err(format!("ExecuteScript HRESULT error: {:?}", error_code))
                        };

                        if let Ok(mut guard) = callback_sender.lock() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(result);
                            }
                        }
                        Ok(())
                    },
                ));

                unsafe { core.ExecuteScript(PCWSTR(script_utf16.as_ptr()), &handler) }
                    .map_err(|error| error.to_string())
            })();

            if let Err(error) = run {
                if let Ok(mut guard) = platform_sender.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(error));
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;

    tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "script execution timed out".to_string())?
        .map_err(|_| "script execution cancelled".to_string())?
}

#[cfg(not(windows))]
pub async fn execute_script(_webview: &Webview, _script: &str) -> Result<String, String> {
    Err("browser automation is only supported on Windows".to_string())
}

#[cfg(not(windows))]
pub async fn execute_script_with_timeout(
    _webview: &Webview,
    _script: &str,
    _timeout: std::time::Duration,
) -> Result<String, String> {
    Err("browser automation is only supported on Windows".to_string())
}

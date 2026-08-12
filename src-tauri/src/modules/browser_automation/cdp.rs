use tauri::Webview;

#[cfg(windows)]
pub async fn execute_script(webview: &Webview, script: &str) -> Result<String, String> {
    execute_script_with_timeout(webview, script, std::time::Duration::from_secs(10)).await
}

#[cfg(windows)]
pub async fn call_devtools_protocol_method(
    webview: &Webview,
    method: &str,
    params_json: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::PCWSTR;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let method_utf16: Vec<u16> = method.encode_utf16().chain(std::iter::once(0)).collect();
    let params_utf16: Vec<u16> = params_json
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let platform_sender = sender.clone();

    webview
        .with_webview(move |platform| {
            let call = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let callback_sender = platform_sender.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |error_code, result_json| {
                        let result = if error_code.is_ok() {
                            Ok(result_json)
                        } else {
                            Err(format!("DevTools HRESULT error: {error_code:?}"))
                        };
                        if let Ok(mut guard) = callback_sender.lock() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(result);
                            }
                        }
                        Ok(())
                    },
                ));
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        PCWSTR(method_utf16.as_ptr()),
                        PCWSTR(params_utf16.as_ptr()),
                        &handler,
                    )
                }
                .map_err(|error| error.to_string())
            })();

            if let Err(error) = call {
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
        .map_err(|_| format!("DevTools method '{method}' timed out"))?
        .map_err(|_| format!("DevTools method '{method}' was cancelled"))?
}

#[cfg(windows)]
pub async fn capture_screenshot(webview: &Webview) -> Result<String, String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::RECT;

    let (sender, receiver) =
        tokio::sync::oneshot::channel::<Result<Option<(RECT, RECT)>, String>>();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<Option<(RECT, RECT)>, String> {
                let controller = platform.controller();
                let mut visible = BOOL::default();
                unsafe { controller.IsVisible(&mut visible) }.map_err(|error| error.to_string())?;
                if visible.as_bool() {
                    return Ok(None);
                }
                let mut original = RECT::default();
                unsafe { controller.Bounds(&mut original) }.map_err(|error| error.to_string())?;
                let width = (original.right - original.left).max(1);
                let height = (original.bottom - original.top).max(1);
                let offscreen = RECT {
                    left: -width - 64,
                    top: 0,
                    right: -64,
                    bottom: height,
                };
                unsafe {
                    controller
                        .SetBounds(offscreen)
                        .map_err(|error| error.to_string())?;
                    controller
                        .SetIsVisible(true)
                        .map_err(|error| error.to_string())?;
                }
                Ok(Some((original, offscreen)))
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let restore = tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "timed out preparing background screenshot".to_string())?
        .map_err(|_| "background screenshot preparation was cancelled".to_string())??;
    if restore.is_some() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let result = call_devtools_protocol_method(
        webview,
        "Page.captureScreenshot",
        r#"{"format":"png","fromSurface":true,"captureBeyondViewport":false}"#,
        std::time::Duration::from_secs(10),
    )
    .await;

    if let Some((original, offscreen)) = restore {
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
        webview
            .with_webview(move |platform| {
                let restore_result = (|| -> Result<(), String> {
                    let controller = platform.controller();
                    let mut current = RECT::default();
                    unsafe { controller.Bounds(&mut current) }
                        .map_err(|error| error.to_string())?;
                    if current == offscreen {
                        unsafe {
                            controller
                                .SetIsVisible(false)
                                .map_err(|error| error.to_string())?;
                            controller
                                .SetBounds(original)
                                .map_err(|error| error.to_string())?;
                        }
                    }
                    Ok(())
                })();
                let _ = sender.send(restore_result);
            })
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(2), receiver)
            .await
            .map_err(|_| "timed out restoring background browser visibility".to_string())?
            .map_err(|_| "background browser visibility restore was cancelled".to_string())??;
    }
    result
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
pub async fn call_devtools_protocol_method(
    _webview: &Webview,
    _method: &str,
    _params_json: &str,
    _timeout: std::time::Duration,
) -> Result<String, String> {
    Err("browser automation is only supported on Windows".to_string())
}

#[cfg(not(windows))]
pub async fn capture_screenshot(_webview: &Webview) -> Result<String, String> {
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

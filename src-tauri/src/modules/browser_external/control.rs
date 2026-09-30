use super::*;
use crate::modules::browser_automation::{activity, cdp, registry, target::BrowserTarget};

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Control {
    Focus,
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    InsertText {
        text: String,
    },
    Capture,
    Effects {
        enabled: bool,
    },
    Viewport {
        width: u32,
        height: u32,
        scale: f64,
        mobile: bool,
    },
}

#[tauri::command]
pub async fn browser_external_control(
    app: AppHandle,
    webview: Webview,
    tab_id: i64,
    connection_id: String,
    selection_id: String,
    control: Control,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    let lock = registry::get_tab_lock(tab_id);
    let _guard = lock.lock().await;
    let target = get_target(tab_id).ok_or("Reconnect and select this browser tab first")?;
    target.check_lease(Some(&connection_id), Some(&selection_id))?;
    let handle = BrowserTarget::External {
        app: app.clone(),
        target: target.clone(),
        label: format!("browser-embed-{tab_id}"),
    };
    let inserting = matches!(control, Control::InsertText { .. });
    let (method, params) = match control {
        Control::Focus => ("anbo.focusTab", json!({})),
        Control::Navigate { url } => {
            let url = protocol::validate_url(&url)?;
            ("Page.navigate", json!({"url":url.as_str()}))
        }
        Control::Reload => ("Page.reload", json!({})),
        Control::Back | Control::Forward => {
            let result = target
                .call("Page.getNavigationHistory", json!({}), REQUEST_TIMEOUT)
                .await?;
            let index = result["currentIndex"]
                .as_i64()
                .ok_or("navigation history unavailable")?
                + if matches!(control, Control::Back) {
                    -1
                } else {
                    1
                };
            let entry = usize::try_from(index)
                .ok()
                .and_then(|index| result["entries"].get(index));
            let Some(entry) = entry else {
                return Ok(json!({}));
            };
            (
                "Page.navigateToHistoryEntry",
                json!({"entryId":entry["id"]}),
            )
        }
        Control::InsertText { text } => {
            if text.len() > 16 * 1024 {
                return Err("text exceeds 16 KiB".into());
            }
            let focused = cdp::execute_script_with_timeout(
                &handle,
                include_str!("../browser/focusedInput.js"),
                Duration::from_secs(2),
            )
            .await?;
            match serde_json::from_str::<String>(&focused)
                .unwrap_or_default()
                .as_str()
            {
                "password" => {
                    return Err("AnboVoice does not insert text into password fields".into())
                }
                "editable" if !text.is_empty() => {}
                _ => return Ok(json!({"inserted":false})),
            }
            ("Input.insertText", json!({"text":text}))
        }
        Control::Capture => {
            return serde_json::from_str(
                &cdp::capture_screenshot(&handle, cdp::ScreenshotEncoding::default()).await?,
            )
            .map_err(|error| error.to_string());
        }
        Control::Effects { enabled } => {
            activity::set_enabled(&app, tab_id, enabled);
            return Ok(json!({}));
        }
        Control::Viewport {
            width,
            height,
            scale,
            mobile,
        } => {
            if width > 7680
                || height > 7680
                || (width > 0 && height == 0)
                || !(0.1..=4.0).contains(&scale)
            {
                return Err("invalid browser viewport".into());
            }
            registry::apply_viewport(&handle, width, height, scale, mobile, 1.0).await?;
            return Ok(json!({}));
        }
    };
    let result = target.call(method, params, REQUEST_TIMEOUT).await?;
    if let Some(error) = result.get("errorText").and_then(Value::as_str) {
        return Err(error.into());
    }
    if inserting {
        return Ok(json!({"inserted":true}));
    }
    Ok(result)
}

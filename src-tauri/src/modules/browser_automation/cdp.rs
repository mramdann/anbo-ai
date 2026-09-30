use super::{embedded_cdp, target::BrowserTarget};
pub use embedded_cdp::ScreenshotEncoding;
use serde_json::{json, Value};
use std::time::Duration;

pub async fn read_page_info(
    target: &BrowserTarget,
    timeout: Duration,
) -> Result<(String, String), String> {
    match target {
        BrowserTarget::Embedded(webview) => embedded_cdp::read_page_info(webview, timeout).await,
        BrowserTarget::External { target, .. } => {
            let info = target.info()?;
            Ok((info.title, info.url))
        }
    }
}

pub async fn read_url(target: &BrowserTarget, timeout: Duration) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => embedded_cdp::read_url(webview, timeout).await,
        BrowserTarget::External { target, .. } => Ok(target.info()?.url),
    }
}

pub async fn call_devtools_protocol_method(
    target: &BrowserTarget,
    method: &str,
    params_json: &str,
    timeout: Duration,
) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => {
            embedded_cdp::call_devtools_protocol_method(webview, method, params_json, timeout).await
        }
        BrowserTarget::External { target, .. } => {
            let params = serde_json::from_str(params_json).map_err(|error| error.to_string())?;
            Ok(target.call(method, params, timeout).await?.to_string())
        }
    }
}

pub async fn execute_script(target: &BrowserTarget, script: &str) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => embedded_cdp::execute_script(webview, script).await,
        BrowserTarget::External { .. } => {
            execute_script_with_timeout(target, script, Duration::from_secs(10)).await
        }
    }
}

pub async fn execute_script_with_timeout(
    target: &BrowserTarget,
    script: &str,
    timeout: Duration,
) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => {
            embedded_cdp::execute_script_with_timeout(webview, script, timeout).await
        }
        BrowserTarget::External { target, .. } => {
            let result = target.call("Runtime.evaluate", json!({"expression":script,"returnByValue":true,"awaitPromise":false,"userGesture":true}), timeout).await?;
            if result.get("exceptionDetails").is_some() {
                return Err("browser script failed".into());
            }
            Ok(result["result"]
                .get("value")
                .unwrap_or(&Value::Null)
                .to_string())
        }
    }
}

pub async fn capture_screenshot(
    target: &BrowserTarget,
    encoding: ScreenshotEncoding,
) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => {
            embedded_cdp::capture_screenshot(webview, encoding).await
        }
        BrowserTarget::External { .. } => {
            let _visual = super::activity::prepare_capture(target).await?;
            let mut params =
                json!({"format":encoding.format,"fromSurface":true,"captureBeyondViewport":false});
            if let Some(quality) = encoding.quality {
                params["quality"] = json!(quality);
            }
            call_devtools_protocol_method(
                target,
                "Page.captureScreenshot",
                &params.to_string(),
                Duration::from_secs(10),
            )
            .await
        }
    }
}

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
            // An agent's input: a tab the page opens right after stays behind.
            if method.starts_with("Input.") {
                crate::modules::browser::new_tab::note_agent_input(webview.label());
            }
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

/// How long a capture may take in Anbo's own browser and in Chrome or Edge.
const FULL_CAPTURE_BUDGET: Duration = Duration::from_secs(10);

pub async fn capture_screenshot(
    target: &BrowserTarget,
    encoding: ScreenshotEncoding,
) -> Result<String, String> {
    capture_screenshot_within(target, encoding, FULL_CAPTURE_BUDGET).await
}

/// How a capture of a Chrome or Edge page reaches the extension.
#[derive(Debug, PartialEq, Eq)]
enum CapturePlan {
    /// The short try alone, for a viewport capture of a page that may not draw.
    Try,
    /// The short try as a viewport capture, then the whole page with the whole
    /// budget once that try came back with a frame.
    TryThenWhole,
    /// The capture asked for, with the whole budget.
    Whole,
}

/// A viewport capture holds no later command up when it ends late, so the
/// extension may give up on it sooner. A full-page one holds the tab's later
/// commands until it is done, and the extension lets the tab go 20 s past its
/// deadline. A page that draws nothing never finishes one: each full-page
/// capture of a page its browser did not show lost the tab 30 s after it
/// started, nine times in round 68 (R68-3). So such a page first gets the short
/// viewport try, and only a page that drew for it gets the whole capture.
fn capture_plan(full_page: bool, timeout: Duration) -> CapturePlan {
    match (full_page, timeout < FULL_CAPTURE_BUDGET) {
        (_, false) => CapturePlan::Whole,
        (false, true) => CapturePlan::Try,
        (true, true) => CapturePlan::TryThenWhole,
    }
}

/// A capture the page has to draw a frame for, its picture dropped. A Chrome or
/// Edge page its browser does not show keeps a cleared viewport override in its
/// layout until it draws or reloads, and one such capture laid it out at its
/// own size in 77 ms (round 68, R68-4). Anbo's own pages lay out at once. Like
/// any capture of such a page it gets a frame only while something on the page
/// changes, so it paints too: without, a hidden tab's reset after a 375 px
/// emulation waited out its 1.5 s, kept the phone layout, and left the next
/// capture refused as still pending (round 73).
pub async fn draw_frame(target: &BrowserTarget, timeout: Duration) -> Result<(), String> {
    let BrowserTarget::External {
        target: external, ..
    } = target
    else {
        return Ok(());
    };
    let cheap = ScreenshotEncoding {
        format: "jpeg",
        quality: Some(1),
        clip: None,
    };
    let painting = begin_capture_paint(target).await;
    let drawn = external
        .call_within("Page.captureScreenshot", cheap.protocol_params(), timeout)
        .await
        .map(|_| ());
    if painting {
        end_capture_paint(target).await;
    }
    drawn
}

/// A pixel in the page's corner whose colour changes every frame, too faint
/// to see in the picture. A Chrome or Edge page its browser does not show
/// draws a frame for a capture only when something on it changes: in a
/// minimized window a fresh page gave no frame in 8 s, with focus emulation or
/// without, and with this pixel one in 55 ms to 1.1 s (round 73); a page typed
/// into drew in 2.6 to 4.5 s, by its blinking caret (round 72, R72-2).
const CAPTURE_PAINT_JS: &str = r#"(() => {
    const paint = document.createElement('anbo-capture-paint');
    paint.setAttribute('aria-hidden', 'true');
    paint.style.cssText = 'position:fixed!important;right:0!important;bottom:0!important;width:1px!important;height:1px!important;margin:0!important;border:0!important;padding:0!important;z-index:2147483647!important;pointer-events:none!important;contain:strict!important;display:block!important;background:rgba(0,0,0,0.004)';
    paint.animate([{ backgroundColor: 'rgba(0,0,0,0.004)' }, { backgroundColor: 'rgba(0,0,0,0.008)' }], { duration: 100, iterations: Infinity, direction: 'alternate' });
    const root = document.documentElement || document.body;
    if (!root) return false;
    root.appendChild(paint);
    return true;
})()"#;
const CAPTURE_PAINT_END_JS: &str =
    "(() => { for (const paint of document.querySelectorAll('anbo-capture-paint')) paint.remove(); return true; })()";
const CAPTURE_PAINT_TIMEOUT: Duration = Duration::from_secs(1);

/// Puts CAPTURE_PAINT_JS's pixel on a Chrome or Edge page for a capture its
/// browser does not show; true once it is there, for `end_capture_paint`.
pub async fn begin_capture_paint(target: &BrowserTarget) -> bool {
    matches!(target, BrowserTarget::External { .. })
        && run_capture_paint(target, CAPTURE_PAINT_JS).await == Ok(true)
}

pub async fn end_capture_paint(target: &BrowserTarget) {
    let _ = run_capture_paint(target, CAPTURE_PAINT_END_JS).await;
}

/// In Anbo's own world, where the page's scripts cannot reach the code, and
/// without a user gesture, which would let the page open a window meanwhile.
async fn run_capture_paint(target: &BrowserTarget, script: &str) -> Result<bool, String> {
    let context = super::ref_context::main_context(target).await?;
    let raw = call_devtools_protocol_method(
        target,
        "Runtime.evaluate",
        &json!({"expression": script, "contextId": context, "returnByValue": true}).to_string(),
        CAPTURE_PAINT_TIMEOUT,
    )
    .await?;
    let payload: Value = super::page_json::from_str(&raw).map_err(|error| error.to_string())?;
    Ok(payload["result"]["value"] == true)
}

/// A capture whose Chrome or Edge page gets `timeout` to draw a frame.
pub async fn capture_screenshot_within(
    target: &BrowserTarget,
    encoding: ScreenshotEncoding,
    timeout: Duration,
) -> Result<String, String> {
    match target {
        BrowserTarget::Embedded(webview) => {
            embedded_cdp::capture_screenshot(webview, encoding).await
        }
        BrowserTarget::External {
            target: external, ..
        } => {
            let _visual = super::activity::prepare_capture(target).await?;
            let plan = capture_plan(encoding.clip.is_some(), timeout);
            if plan != CapturePlan::Whole {
                let viewport = ScreenshotEncoding {
                    clip: None,
                    ..encoding
                };
                let tried = external
                    .call_within(
                        "Page.captureScreenshot",
                        viewport.protocol_params(),
                        timeout,
                    )
                    .await?;
                if plan == CapturePlan::Try {
                    return Ok(tried.to_string());
                }
            }
            call_devtools_protocol_method(
                target,
                "Page.captureScreenshot",
                &encoding.protocol_params().to_string(),
                FULL_CAPTURE_BUDGET,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_page_capture_of_a_page_that_may_not_draw_tries_the_viewport_first() {
        let unshown = Duration::from_secs(3);
        assert_eq!(capture_plan(true, unshown), CapturePlan::TryThenWhole);
        assert_eq!(capture_plan(false, unshown), CapturePlan::Try);
        // A page its browser draws gets the capture it asked for at once.
        assert_eq!(capture_plan(true, FULL_CAPTURE_BUDGET), CapturePlan::Whole);
        assert_eq!(capture_plan(false, FULL_CAPTURE_BUDGET), CapturePlan::Whole);
    }

    #[test]
    fn the_capture_paint_is_a_faint_pixel_the_end_takes_away() {
        // Round 73 (R72-2): a hidden page drew for a capture only while
        // something on it changed.
        for part in [
            "createElement('anbo-capture-paint')",
            "pointer-events:none!important",
            "width:1px!important",
            "rgba(0,0,0,0.004)",
            "iterations: Infinity",
        ] {
            assert!(CAPTURE_PAINT_JS.contains(part), "{part}");
        }
        assert!(CAPTURE_PAINT_END_JS.contains("querySelectorAll('anbo-capture-paint')"));
        assert!(CAPTURE_PAINT_END_JS.contains("paint.remove()"));
    }

    #[test]
    fn the_viewport_try_is_a_capture_the_extension_lets_go_of_at_its_deadline() {
        // bridge.js holds the tab's later commands behind any capture but one
        // drawn from the surface, inside the viewport and without a clip.
        let whole = ScreenshotEncoding::default().full_page(984.0, 5_000.0);
        let tried = ScreenshotEncoding {
            clip: None,
            ..whole
        }
        .protocol_params();
        assert_eq!(tried["fromSurface"], true);
        assert_eq!(tried["captureBeyondViewport"], false);
        assert!(tried.get("clip").is_none());
        assert_eq!(whole.protocol_params()["captureBeyondViewport"], true);
    }
}

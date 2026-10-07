//! A Chrome or Edge page takes no pointer input while it is hidden: behind
//! another tab of its window, where every tab an agent opens starts, or in a
//! minimized window. Before such input Anbo brings the tab to the front of its
//! panel, as a click on it would, the dock shows the page, and the action waits
//! for it. Anbo never switches tabs in the user's own browser window.

use super::protocol::error_codes;
use super::registry::get_embed_webview;
use super::target::BrowserTarget;
use crate::modules::browser_external::dock::{self, Standing};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener};

const SHOW_REQUEST_EVENT: &str = "anbo:browser-show-request";
const SHOW_RESPONSE_EVENT: &str = "anbo:browser-show-response";
/// A dock takes about 0.7 s, after the page it replaces went back to its own
/// window.
const SHOW_PATIENCE: Duration = Duration::from_secs(5);
/// A page counts as shown once it draws a frame. One in a window that Anbo
/// covers can read as visible and still draw nothing, and then a pointer move
/// waits for a frame that never comes.
const DRAWN_JS: &str = "document.visibilityState !== 'visible' ? 'hidden' : new Promise((resolve) => { requestAnimationFrame(() => resolve('drawn')); setTimeout(() => resolve('undrawn'), 150); })";
static SHOW_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Actions that reach the page as pointer input. Typing, selecting, scrolling
/// and uploads work on a hidden page. Focus is here because agents reach for it
/// to bring a tab forward, and it answered `focused: true` while the page
/// stayed hidden.
pub fn needs_shown_page(method: &str) -> bool {
    matches!(
        method,
        "click" | "double_click" | "check" | "drag" | "hover" | "focus"
    )
}

#[derive(Deserialize)]
struct ShowResponse {
    shown: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Returns at once for Anbo's own browser, a docked page, or a page its
/// browser already shows and draws.
pub async fn bring_to_front(app: &AppHandle, tab_id: i64) -> Result<(), (String, String)> {
    let Ok(target) = get_embed_webview(app, tab_id) else {
        // The action reports a missing tab itself.
        return Ok(());
    };
    if target.embedded().is_ok() || docked_live(tab_id) || page_shown(&target).await {
        return Ok(());
    }
    if let Some(why) = not_in_front(dock::standing(app)) {
        return Err(refusal(why));
    }
    let answer = request_show(app, tab_id).await?;
    if !answer.shown {
        return Err(refusal(not_shown(answer.reason.as_deref())));
    }
    let deadline = tokio::time::Instant::now() + SHOW_PATIENCE;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if docked_live(tab_id) || page_shown(&target).await {
            return Ok(());
        }
    }
    Err(refusal(not_docked(
        dock::docked(tab_id).and_then(|(_, reason)| reason),
    )))
}

/// A page the dock shows in its panel is drawn there.
fn docked_live(tab_id: i64) -> bool {
    dock::docked(tab_id).is_some_and(|(live, _)| live)
}

async fn page_shown(target: &BrowserTarget) -> bool {
    let drawn = tokio::time::timeout(
        Duration::from_millis(600),
        super::ref_context::execute_awaited(target, None, DRAWN_JS),
    )
    .await
    .is_ok_and(|state| state.is_ok_and(|state| state == "\"drawn\""));
    drawn && in_front(target).await
}

/// Whether the browser has the tab in front in its window. While an agent's
/// focus emulation is on, a tab behind another one reads as visible and
/// draws, as the page does that has just handed the dock window to another
/// tab, yet the browser shows it nowhere. An extension too old to answer
/// leaves it to the drawing.
async fn in_front(target: &BrowserTarget) -> bool {
    let BrowserTarget::External { target, .. } = target else {
        return true;
    };
    target
        .call("anbo.tabState", json!({}), Duration::from_millis(600))
        .await
        .map_or(true, |state| shown_in_window(&state))
}

/// A tab shares the front of its window with the other half of a split view.
fn shown_in_window(state: &serde_json::Value) -> bool {
    let flag = |name: &str, otherwise: bool| state[name].as_bool().unwrap_or(otherwise);
    (flag("active", true) || flag("split", false)) && !flag("minimized", false)
}

async fn request_show(app: &AppHandle, tab_id: i64) -> Result<ShowResponse, (String, String)> {
    let request_id = format!(
        "{}-{}",
        std::process::id(),
        SHOW_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let listener_id = app.once(
        format!("{SHOW_RESPONSE_EVENT}:{request_id}"),
        move |event| {
            let _ = sender.send(event.payload().to_string());
        },
    );
    if let Err(error) = app.emit(
        SHOW_REQUEST_EVENT,
        json!({ "requestId": request_id, "tabId": tab_id }),
    ) {
        app.unlisten(listener_id);
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to ask Anbo to show the tab: {error}; no input was sent"),
        ));
    }
    let received = tokio::time::timeout(Duration::from_secs(2), receiver).await;
    app.unlisten(listener_id);
    let payload = received
        .map_err(|_| {
            (
                error_codes::TIMEOUT.to_string(),
                "Anbo UI did not bring the tab forward in time; no input was sent".to_string(),
            )
        })?
        .map_err(|_| {
            (
                error_codes::APP_UNAVAILABLE.to_string(),
                "Anbo UI closed before bringing the tab forward; no input was sent".to_string(),
            )
        })?;
    serde_json::from_str(&payload).map_err(|error| {
        (
            error_codes::INTERNAL.to_string(),
            format!("invalid browser-show response: {error}"),
        )
    })
}

fn refusal(why: &str) -> (String, String) {
    (
        error_codes::INPUT_NOT_READY.to_string(),
        format!("the tab is hidden in its browser, which delivers no pointer input to a hidden page, and {why} No input was sent."),
    )
}

fn not_in_front(standing: Standing) -> Option<&'static str> {
    match standing {
        Standing::Front => None,
        Standing::Minimized => Some("Anbo is minimized, so it cannot bring the tab to the front. Ask the user to restore Anbo, then retry."),
        Standing::Behind => Some("Anbo is not the window the user is in: bringing the tab forward now would open its browser window over what they are using. Retry once they are back in Anbo, or ask them to switch to it."),
    }
}

fn not_shown(reason: Option<&str>) -> &'static str {
    match reason {
        Some("workspace") => "it is in a workspace Anbo is not showing. Ask the user to open that workspace in Anbo, then retry.",
        Some("in-use") => "it shares its Anbo panel with the tab the user is working in, which Anbo does not switch away under them. Ask the user to show the tab, or to give browser tabs their own panel with the layout button in Anbo's tab bar, then retry.",
        _ => "Anbo could not bring it to the front of its panel. Ask the user to show the tab in Anbo, then retry.",
    }
}

fn not_docked(reason: Option<&str>) -> &'static str {
    match reason {
        Some("panel-too-narrow") => "Anbo's panel is narrower than the browser allows, so the page cannot show there. Ask the user to widen the panel, then retry.",
        Some("panel-outside-host") => "Anbo's panel reaches outside its window, so the page cannot show there. Ask the user to move the panel back inside, then retry.",
        _ => "Anbo brought the tab to the front of its panel, but the page did not show within 5 s. Retry, or ask the user what the panel shows.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pointer_input_waits_for_a_shown_page() {
        for method in ["click", "double_click", "check", "drag", "hover", "focus"] {
            assert!(needs_shown_page(method), "{method}");
        }
        for method in [
            "type_text",
            "type",
            "press_key",
            "select_option",
            "scroll",
            "upload_files",
            "fill_form",
            "get_text",
            "snapshot",
            "screenshot",
            "navigate",
        ] {
            assert!(!needs_shown_page(method), "{method}");
        }
    }

    #[test]
    fn a_tab_behind_another_in_its_window_is_not_shown() {
        assert!(shown_in_window(
            &json!({"active":true,"split":false,"minimized":false})
        ));
        assert!(!shown_in_window(
            &json!({"active":false,"split":false,"minimized":false})
        ));
        assert!(shown_in_window(
            &json!({"active":false,"split":true,"minimized":false})
        ));
        assert!(!shown_in_window(
            &json!({"active":true,"split":false,"minimized":true})
        ));
        assert!(shown_in_window(&json!({})));
    }

    #[test]
    fn refusals_say_why_and_that_nothing_was_sent() {
        let (code, message) = refusal(not_shown(Some("workspace")));
        assert_eq!(code, error_codes::INPUT_NOT_READY);
        assert!(message.contains("workspace Anbo is not showing"));
        assert!(message.ends_with("No input was sent."));
        assert!(refusal(not_shown(Some("in-use")))
            .1
            .contains("layout button"));
        assert!(refusal(not_shown(None))
            .1
            .contains("Ask the user to show the tab"));
        assert!(refusal(not_docked(Some("panel-too-narrow")))
            .1
            .contains("widen the panel"));
        assert!(refusal(not_docked(Some("measuring")))
            .1
            .contains("within 5 s"));
        assert_eq!(not_in_front(Standing::Front), None);
        assert!(refusal(not_in_front(Standing::Minimized).unwrap())
            .1
            .contains("restore Anbo"));
        assert!(refusal(not_in_front(Standing::Behind).unwrap())
            .1
            .contains("and Anbo is not the window the user is in: bringing"));
    }
}

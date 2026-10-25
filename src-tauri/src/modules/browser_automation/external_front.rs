//! A Chrome or Edge page takes no pointer input while it is hidden: behind
//! another tab of its window, where every tab an agent opens starts, or in a
//! minimized window. Before such input Anbo brings the tab to the front of its
//! panel, as a click on it would, the dock shows the page, and the action waits
//! for it. Anbo never switches tabs in the user's own browser window. A page
//! that cannot be shown now, as one in a workspace Anbo is not showing, takes
//! keys and its own DOM events instead (`actions/hidden_input.rs`).
//!
//! Reads and waits leave the tab where it is, and its browser runs a hidden
//! page slowly, so a lookup or wait that runs out of time there says so.
//!
//! The dock shows one page, so agents take turns: pointer input to a Chrome or
//! Edge tab holds the turn until the input is done, and another agent's input
//! waits for it instead of moving that page out from under it. A page can still
//! leave the dock before the input, when another tab of its panel takes the dock
//! window over; nothing is sent then, and the action runs once more
//! (`actions.rs` `handle_action_inner`).

use super::protocol::error_codes;
use super::registry::get_embed_webview;
use super::target::BrowserTarget;
use super::ui_answer::Answer;
use crate::modules::browser_external::dock::{self, Standing};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SHOW_REQUEST_EVENT: &str = "anbo:browser-show-request";
/// A dock takes about 0.7 s, after the page it replaces went back to its own
/// window.
const SHOW_PATIENCE: Duration = Duration::from_secs(5);
/// On a busy machine a dock can take several seconds, so the wait goes on this
/// long while the dock is still bringing the page in.
const DOCKING_PATIENCE: Duration = Duration::from_secs(15);
/// A page not shown by then, with the dock idle, is asked for once more.
const ASK_AGAIN: Duration = Duration::from_millis(2_500);
/// How long a second try at pointer input waits for a dock move under way.
const SETTLE_PATIENCE: Duration = Duration::from_secs(2);
/// How long pointer input waits for other agents' input on Chrome/Edge tabs.
const TURN_PATIENCE: Duration = Duration::from_secs(30);
/// The UI hears which tab holds the turn, and brings no agent's new tab to
/// the front of a panel meanwhile.
const TURN_EVENT: &str = "anbo:browser-pointer-turn";
static TURN: LazyLock<Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));
/// A page counts as shown once it draws a frame. One in a window that Anbo
/// covers can read as visible and still draw nothing, and then a pointer move
/// waits for a frame that never comes.
const DRAWN_JS: &str = "document.visibilityState !== 'visible' ? 'hidden' : new Promise((resolve) => { requestAnimationFrame(() => resolve('drawn')); setTimeout(() => resolve('undrawn'), 150); })";
/// Chrome and Edge run the timers of a page they are not showing about once a
/// second, and an agent's tab is shown only while Anbo docks it. A button that
/// five chained 100 ms timers put on the page was found after 4.7 s on such a
/// tab, against 0.8 to 1.6 s docked (Oct 11 2026). An agent's input turns on
/// focus emulation, under which the page runs as if shown.
const HIDDEN_PAGE_NOTE: &str = "this Chrome/Edge tab is not shown, so its browser runs the page's timers about once a second and content that waits on them comes late: retry with a longer timeout; after a click, hover or key press on the tab, its page runs at full speed until your session ends";

/// Actions that reach the page as pointer input. Typing, selecting, scrolling
/// and uploads work on a hidden page. Focus is here because agents reach for it
/// to bring a tab forward, and it answered `focused: true` while the page
/// stayed hidden.
pub fn needs_shown_page(method: &str) -> bool {
    matches!(
        method,
        "click" | "double_click" | "check" | "drag" | "hover" | "focus" | "dialog"
    )
}

/// One agent's turn at pointer input to a Chrome or Edge tab, until dropped.
pub struct PointerTurn {
    app: AppHandle,
    _turn: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for PointerTurn {
    fn drop(&mut self) {
        let _ = self.app.emit(TURN_EVENT, json!({ "tabId": Value::Null }));
    }
}

async fn take_turn(app: &AppHandle, tab_id: i64) -> Result<PointerTurn, (String, String)> {
    let turn = tokio::time::timeout(TURN_PATIENCE, TURN.clone().lock_owned())
        .await
        .map_err(|_| {
            (
                error_codes::INPUT_NOT_READY.to_string(),
                format!("other agents' clicks on Chrome/Edge tabs kept Anbo's browser panel, which shows one page at a time, busy for {} s. No input was sent. Retry.", TURN_PATIENCE.as_secs()),
            )
        })?;
    let _ = app.emit(TURN_EVENT, json!({ "tabId": tab_id }));
    Ok(PointerTurn {
        app: app.clone(),
        _turn: turn,
    })
}

#[derive(Deserialize)]
struct ShowResponse {
    shown: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Returns at once for Anbo's own browser. A Chrome or Edge tab first waits for
/// its turn, then returns once its page is docked or its browser shows and
/// draws it. The caller keeps the turn until its input is done.
pub async fn bring_to_front(
    app: &AppHandle,
    tab_id: i64,
) -> Result<Option<PointerTurn>, (String, String)> {
    let Ok(target) = get_embed_webview(app, tab_id) else {
        // The action reports a missing tab itself.
        return Ok(None);
    };
    if target.embedded().is_ok() {
        return Ok(None);
    }
    let turn = take_turn(app, tab_id).await?;
    if docked_live(tab_id) || page_shown(&target).await {
        return Ok(Some(turn));
    }
    if let Some(why) = not_in_front(dock::standing(app)) {
        return Err(refusal(why));
    }
    let answer = request_show(app, tab_id).await?;
    if !answer.shown {
        return Err(refusal(not_shown(answer.reason.as_deref())));
    }
    let started = tokio::time::Instant::now();
    let mut asked_again = false;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if docked_live(tab_id) || page_shown(&target).await {
            return Ok(Some(turn));
        }
        let docking = docking(tab_id);
        // Nothing moved: the UI may have been too busy to dock the tab, or
        // kept it from the dock after a failure. Asked again, it retries.
        if !asked_again && !docking && started.elapsed() >= ASK_AGAIN {
            asked_again = true;
            if let Ok(answer) = request_show(app, tab_id).await {
                if !answer.shown {
                    return Err(refusal(not_shown(answer.reason.as_deref())));
                }
            }
        }
        if !keep_waiting(started.elapsed(), docking) {
            break;
        }
    }
    Err(refusal(&not_docked(
        dock::docked(tab_id).and_then(|(_, reason)| reason),
        started.elapsed(),
    )))
}

/// Brings a Chrome or Edge tab its browser does not show forward for a
/// capture, as for pointer input: the turn, held while the capture runs, or
/// why the tab could not come. A shown page, or Anbo's own browser, needs
/// nothing. Called before the tab lock, which the dock takes to bring it in.
pub async fn front_for_capture(
    app: &AppHandle,
    tab_id: i64,
) -> Result<Option<PointerTurn>, String> {
    let Ok(target) = get_embed_webview(app, tab_id) else {
        return Ok(None);
    };
    if capture_shown(&target).await {
        return Ok(None);
    }
    bring_to_front(app, tab_id).await.map_err(|(_, why)| why)
}

/// Waits a moment for a dock move under way to finish, so the next look at a
/// page reads where that move left it.
pub async fn settle_dock() {
    let started = tokio::time::Instant::now();
    while dock::working() && started.elapsed() < SETTLE_PATIENCE {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether the dock is still bringing this tab's page in.
fn docking(tab_id: i64) -> bool {
    dock::working()
        || matches!(
            dock::docked(tab_id),
            Some((false, None | Some("measuring")))
        )
}

fn keep_waiting(waited: Duration, docking: bool) -> bool {
    waited < SHOW_PATIENCE || (docking && waited < DOCKING_PATIENCE)
}

/// A page the dock shows in its panel is drawn there.
fn docked_live(tab_id: i64) -> bool {
    dock::docked(tab_id).is_some_and(|(live, _)| live)
}

/// Why a capture of a Chrome or Edge page its browser does not show is
/// refused.
pub const NOT_SHOWN_FOR_CAPTURE: &str = "this Chrome/Edge tab is not shown in its browser, so its page draws nothing to capture; nothing was captured. Anbo brings such a tab forward for a capture, as for a click, only while its workspace is shown and the user is in Anbo. Read the page with browser_snapshot or browser_get_text, or capture again once the tab can be shown.";

/// Whether a capture of a Chrome or Edge page should answer at once: its
/// browser draws the page, or has it in front of a window that is not
/// minimized. A page behind another tab of its window can still be captured
/// while that window draws (one behind the dock's page), but not in a window
/// that Anbo covers (a tab Anbo has not docked, as one opened in a workspace
/// that was then hidden): that capture waited 10 s for a frame, and every
/// retry was refused as still pending (round 60).
pub async fn capture_shown(target: &BrowserTarget) -> bool {
    if !matches!(target, BrowserTarget::External { .. }) {
        return true;
    }
    let drawn = tokio::time::timeout(
        Duration::from_millis(600),
        super::ref_context::execute_awaited(target, None, DRAWN_JS),
    )
    .await
    .is_ok_and(|state| state.is_ok_and(|state| state == "\"drawn\""));
    drawn || in_front(target).await
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
    let mut answer = Answer::expect();
    if let Err(error) = app.emit(
        SHOW_REQUEST_EVENT,
        json!({ "requestId": answer.request_id(), "tabId": tab_id }),
    ) {
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to ask Anbo to show the tab: {error}; no input was sent"),
        ));
    }
    let received = tokio::time::timeout(Duration::from_secs(2), answer.receiver()).await;
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

/// Calls that wait for the page to show something: a find, a wait, a locator
/// lookup, a field of a form, or a `waitFor` on the action's result.
pub fn waits_on_page(method: &str, params: &Value) -> bool {
    matches!(method, "find" | "wait" | "fill_form")
        || params.get("locator").is_some()
        || params.get("waitFor").is_some()
}

/// `message` with HIDDEN_PAGE_NOTE when the tab is a Chrome or Edge page its
/// browser is not showing. Asked only once a lookup or wait has run out of
/// time, so a call that succeeds pays nothing for it.
pub async fn with_hidden_page_note(tab_id: i64, message: String) -> String {
    let Some(target) = crate::modules::browser_external::get_target(tab_id) else {
        return message;
    };
    let visibility = target
        .call(
            "Runtime.evaluate",
            json!({"expression": "document.visibilityState", "returnByValue": true}),
            Duration::from_millis(600),
        )
        .await
        .unwrap_or_default();
    noted(message, &visibility)
}

/// `visibility` is the page's answer to Runtime.evaluate.
fn noted(message: String, visibility: &Value) -> String {
    if visibility["result"]["value"] == "hidden" {
        format!("{message}; {HIDDEN_PAGE_NOTE}")
    } else {
        message
    }
}

const REFUSAL: &str = "the tab is hidden in its browser";
const POINTER_CLAUSE: &str = ", which delivers no pointer input to a hidden page, and ";
const NOTHING_SENT: &str = " No input was sent.";

fn refusal(why: &str) -> (String, String) {
    (
        error_codes::INPUT_NOT_READY.to_string(),
        format!("{REFUSAL}{POINTER_CLAUSE}{why}{NOTHING_SENT}"),
    )
}

/// Only the why of a bring_to_front refusal, for a capture's answer: the
/// words about pointer input were beside the point there (round 66, R66-2).
pub fn refusal_reason(message: &str) -> &str {
    let why = message
        .strip_prefix(REFUSAL)
        .and_then(|rest| rest.strip_prefix(POINTER_CLAUSE))
        .unwrap_or(message);
    why.strip_suffix(NOTHING_SENT).unwrap_or(why)
}

/// Whether bring_to_front refused because the page cannot be shown now, as
/// against other agents holding the turn: such a page still takes keys and
/// its own DOM events (actions/hidden_input.rs).
pub fn cannot_show((code, message): &(String, String)) -> bool {
    code == error_codes::INPUT_NOT_READY && message.starts_with(REFUSAL)
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

fn not_docked(reason: Option<&str>, waited: Duration) -> String {
    match reason {
        Some("panel-too-narrow") => "Anbo's panel is narrower than the browser allows, so the page cannot show there. Ask the user to widen the panel, then retry.".into(),
        Some("panel-outside-host") => "Anbo's panel reaches outside its window, so the page cannot show there. Ask the user to move the panel back inside, then retry.".into(),
        _ => format!("Anbo brought the tab to the front of its panel, but the page did not show within {} s. Retry, or ask the user what the panel shows.", waited.as_secs_f32().round()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pointer_input_waits_for_a_shown_page() {
        // A dialog click is a click too (round 60: refused on hidden Chrome tabs).
        for method in [
            "click",
            "double_click",
            "check",
            "drag",
            "hover",
            "focus",
            "dialog",
        ] {
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
    fn the_wait_for_a_page_goes_on_while_the_dock_brings_it_in() {
        assert!(keep_waiting(Duration::from_secs(4), false));
        assert!(!keep_waiting(SHOW_PATIENCE, false));
        assert!(keep_waiting(Duration::from_secs(12), true));
        assert!(!keep_waiting(DOCKING_PATIENCE, true));
    }

    #[tokio::test]
    async fn pointer_input_takes_turns_in_order() {
        let first = TURN.clone().lock_owned().await;
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut waiting = Vec::new();
        for index in 0..3 {
            let order = order.clone();
            waiting.push(tokio::spawn(async move {
                let _turn = TURN.clone().lock_owned().await;
                order.lock().unwrap().push(index);
            }));
            tokio::task::yield_now().await;
        }
        assert!(order.lock().unwrap().is_empty());
        drop(first);
        for task in waiting {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
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
    fn only_lookups_and_waits_hear_about_a_hidden_page() {
        for method in ["find", "wait", "fill_form"] {
            assert!(waits_on_page(method, &json!({"tabId":1})), "{method}");
        }
        let lookup = json!({"tabId":1,"locator":{"by":"role","value":"button"}});
        assert!(waits_on_page("click", &lookup));
        assert!(waits_on_page("get_text", &lookup));
        assert!(waits_on_page(
            "type",
            &json!({"ref":"g1-e1","waitFor":{"text":"Done"}})
        ));
        for method in [
            "click",
            "type",
            "snapshot",
            "screenshot",
            "close",
            "download",
        ] {
            assert!(
                !waits_on_page(method, &json!({"tabId":1,"ref":"g1-e1"})),
                "{method}"
            );
        }
    }

    #[test]
    fn a_miss_on_a_hidden_page_says_why_it_may_have_come_late() {
        let message = || "timed out finding css '#ready' after 5000ms: absent".to_string();
        let hidden = json!({"result":{"type":"string","value":"hidden"}});
        let noted_message = noted(message(), &hidden);
        assert!(noted_message.starts_with(&message()));
        assert!(noted_message.contains("; this Chrome/Edge tab is not shown"));
        assert!(noted_message.contains("retry with a longer timeout"));
        let visible = json!({"result":{"type":"string","value":"visible"}});
        assert_eq!(noted(message(), &visible), message());
        // A page that did not answer gets no note rather than a guess.
        assert_eq!(noted(message(), &Value::Null), message());
        assert_eq!(noted(message(), &json!({"exceptionDetails":{}})), message());
    }

    #[test]
    fn refusals_say_why_and_that_nothing_was_sent() {
        let (code, message) = refusal(not_shown(Some("workspace")));
        assert_eq!(code, error_codes::INPUT_NOT_READY);
        assert!(message.contains("workspace Anbo is not showing"));
        assert!(message.ends_with("No input was sent."));
        // Every page that cannot be shown takes keys and its own events
        // instead; a busy turn is waited out, not worked around.
        for why in [
            not_shown(Some("workspace")),
            not_shown(Some("in-use")),
            not_in_front(Standing::Behind).unwrap(),
        ] {
            assert!(cannot_show(&refusal(why)), "{why}");
        }
        assert!(cannot_show(&refusal(&not_docked(None, SHOW_PATIENCE))));
        assert!(!cannot_show(&(
            error_codes::INPUT_NOT_READY.to_string(),
            "other agents' clicks on Chrome/Edge tabs kept Anbo's browser panel busy".to_string()
        )));
        assert!(!cannot_show(&(
            error_codes::TIMEOUT.to_string(),
            message.clone()
        )));
        assert!(refusal(not_shown(Some("in-use")))
            .1
            .contains("layout button"));
        assert!(refusal(not_shown(None))
            .1
            .contains("Ask the user to show the tab"));
        assert!(
            refusal(&not_docked(Some("panel-too-narrow"), SHOW_PATIENCE))
                .1
                .contains("widen the panel")
        );
        assert!(refusal(&not_docked(Some("measuring"), SHOW_PATIENCE))
            .1
            .contains("within 5 s"));
        assert!(refusal(&not_docked(None, Duration::from_millis(14_960)))
            .1
            .contains("within 15 s"));
        assert_eq!(not_in_front(Standing::Front), None);
        assert!(refusal(not_in_front(Standing::Minimized).unwrap())
            .1
            .contains("restore Anbo"));
        assert!(refusal(not_in_front(Standing::Behind).unwrap())
            .1
            .contains("and Anbo is not the window the user is in: bringing"));
    }

    #[test]
    fn a_capture_gets_the_reason_without_the_pointer_words() {
        let behind = not_in_front(Standing::Behind).unwrap();
        assert_eq!(refusal_reason(&refusal(behind).1), behind);
        let workspace = not_shown(Some("workspace"));
        assert_eq!(refusal_reason(&refusal(workspace).1), workspace);
        let narrow = not_docked(Some("panel-too-narrow"), SHOW_PATIENCE);
        assert_eq!(refusal_reason(&refusal(&narrow).1), narrow);
        // Any other message comes back as it is.
        assert_eq!(refusal_reason("other agents hold the turn"), "other agents hold the turn");
    }
}

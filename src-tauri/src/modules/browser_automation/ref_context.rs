use super::target::BrowserTarget as Webview;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::cdp::call_devtools_protocol_method;
use super::registry::active_navigation_generation;

pub const REF_REGISTRY_JS: &str = include_str!("refRegistry.js");
const CONTEXT_TIMEOUT: Duration = Duration::from_secs(2);
static ROOT_CONTEXTS: Mutex<Option<HashMap<i64, (u64, i64)>>> = Mutex::new(None);
static PREPARED: Mutex<Option<HashMap<i64, PreparedDocument>>> = Mutex::new(None);
/// When each tab last got a new document or viewport. WebView2 155.0.4283.33
/// drops a key sent through Input.dispatchKeyEvent within about 100 ms of
/// either: the call succeeds, but the page never sees a keydown. Of 120 Enters
/// sent right after a fresh tab's viewport emulation, 27 were lost; of 360 sent
/// 100 ms later, none (Oct 3 2026). Mouse input waits a frame for actionability
/// and never lost a click.
static LAYOUT_CHANGES: Mutex<Option<HashMap<i64, Instant>>> = Mutex::new(None);
/// How old the newest document or viewport must be before a key goes out: the
/// 100 ms that held, with margin.
const KEY_SETTLE: Duration = Duration::from_millis(150);
/// Tabs whose focus emulation an agent's input turned on. Chromium counts such
/// a page as shown: a hidden tab keeps running as if in view, and a Chrome tab
/// moved into another window can keep its page window hidden there.
static FOCUS_EMULATED: Mutex<Option<HashSet<i64>>> = Mutex::new(None);

#[derive(Default)]
struct PreparedDocument {
    navigation: u64,
    refs: HashSet<i64>,
    focus: bool,
}

fn with_prepared<T>(
    tab: i64,
    navigation: u64,
    f: impl FnOnce(&mut PreparedDocument) -> T,
) -> Option<T> {
    let mut guard = PREPARED.lock().ok()?;
    let entries = guard.get_or_insert_with(HashMap::new);
    if entries.len() >= 256 && !entries.contains_key(&tab) {
        return None;
    }
    let entry = entries.entry(tab).or_default();
    if entry.navigation != navigation {
        *entry = PreparedDocument {
            navigation,
            ..Default::default()
        };
    }
    Some(f(entry))
}

fn ref_expression(expression: &str, installed: bool) -> Cow<'_, str> {
    if !expression.contains(REF_REGISTRY_JS) {
        return Cow::Borrowed(expression);
    }
    let compact = expression.replace(
        REF_REGISTRY_JS,
        "const refRegistry = globalThis.__anboBrowserRefs;",
    );
    Cow::Owned(if installed {
        compact
    } else {
        format!("(() => {{ {REF_REGISTRY_JS}\nreturn {compact}; }})()")
    })
}

pub async fn ensure_focus(webview: &Webview) -> Result<(), String> {
    let tab = tab_id(webview)?;
    let navigation = active_navigation_generation(tab).ok_or("browser tab closed")?;
    if with_prepared(tab, navigation, |entry| entry.focus) == Some(true) {
        return Ok(());
    }
    call_devtools_protocol_method(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        CONTEXT_TIMEOUT,
    )
    .await?;
    note_focus_emulated(tab);
    if active_navigation_generation(tab) == Some(navigation) {
        with_prepared(tab, navigation, |entry| entry.focus = true);
    }
    Ok(())
}

fn note_focus_emulated(tab: i64) {
    if let Ok(mut guard) = FOCUS_EMULATED.lock() {
        let tabs = guard.get_or_insert_with(HashSet::new);
        if tabs.len() < 256 {
            tabs.insert(tab);
        }
    }
}

/// Forgets that the tab's focus is emulated, so the next input turns it on
/// again; true when it was.
fn take_focus_emulated(tab: i64) -> bool {
    let emulated = FOCUS_EMULATED
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().map(|tabs| tabs.remove(&tab)))
        .unwrap_or(false);
    if let Ok(mut guard) = PREPARED.lock() {
        if let Some(entry) = guard.as_mut().and_then(|entries| entries.get_mut(&tab)) {
            entry.focus = false;
        }
    }
    emulated
}

/// Ends the focus emulation an agent's input turned on, for a tab no agent
/// holds any more: the page gets its real focus and visibility back.
pub async fn release_focus(webview: &Webview) {
    let Ok(tab) = tab_id(webview) else {
        return;
    };
    if take_focus_emulated(tab) {
        let _ = call_devtools_protocol_method(
            webview,
            "Emulation.setFocusEmulationEnabled",
            r#"{"enabled":false}"#,
            CONTEXT_TIMEOUT,
        )
        .await;
    }
}

/// Record that a tab got a new document or viewport, so its next key waits.
pub fn note_layout_change(webview: &Webview) {
    if let Ok(tab) = tab_id(webview) {
        record_layout_change(tab, Instant::now());
    }
}

fn record_layout_change(tab: i64, at: Instant) {
    if let Ok(mut guard) = LAYOUT_CHANGES.lock() {
        let changes = guard.get_or_insert_with(HashMap::new);
        if changes.len() >= 256 && !changes.contains_key(&tab) {
            return;
        }
        changes.insert(tab, at);
    }
}

/// Hold a key until the tab's newest document or viewport is KEY_SETTLE old.
/// Agents call tools seconds apart, so only scripted sequences ever wait.
pub async fn settle_before_keys(webview: &Webview) {
    let Ok(tab) = tab_id(webview) else {
        return;
    };
    if let Some(wait) = key_settle_wait(tab, Instant::now()) {
        tokio::time::sleep(wait).await;
    }
}

fn key_settle_wait(tab: i64, now: Instant) -> Option<Duration> {
    let changed = *LAYOUT_CHANGES.lock().ok()?.as_ref()?.get(&tab)?;
    (changed + KEY_SETTLE)
        .checked_duration_since(now)
        .filter(|wait| !wait.is_zero())
}

pub fn remove(tab_id: i64) {
    if let Ok(mut guard) = PREPARED.lock() {
        if let Some(entries) = guard.as_mut() {
            entries.remove(&tab_id);
        }
    }
    if let Ok(mut guard) = ROOT_CONTEXTS.lock() {
        if let Some(contexts) = guard.as_mut() {
            contexts.remove(&tab_id);
        }
    }
    if let Ok(mut guard) = LAYOUT_CHANGES.lock() {
        if let Some(changes) = guard.as_mut() {
            changes.remove(&tab_id);
        }
    }
    if let Ok(mut guard) = FOCUS_EMULATED.lock() {
        if let Some(tabs) = guard.as_mut() {
            tabs.remove(&tab_id);
        }
    }
}

pub fn clear() {
    if let Ok(mut guard) = PREPARED.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = ROOT_CONTEXTS.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = LAYOUT_CHANGES.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = FOCUS_EMULATED.lock() {
        *guard = None;
    }
}

pub async fn frame_context(webview: &Webview, frame_id: &str) -> Result<i64, String> {
    let raw = call_devtools_protocol_method(
        webview,
        "Page.createIsolatedWorld",
        &json!({"frameId": frame_id, "worldName": "anbo-browser-automation"}).to_string(),
        CONTEXT_TIMEOUT,
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    payload["executionContextId"]
        .as_i64()
        .ok_or_else(|| "isolated world omitted executionContextId".into())
}

fn tab_id(webview: &Webview) -> Result<i64, String> {
    webview
        .label()
        .strip_prefix("browser-embed-")
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| "browser ref context requires an embedded tab".into())
}

pub async fn main_context(webview: &Webview) -> Result<i64, String> {
    let tab_id = tab_id(webview)?;
    let navigation = active_navigation_generation(tab_id).ok_or("browser tab closed")?;
    if let Some(context) = ROOT_CONTEXTS.lock().ok().and_then(|guard| {
        guard
            .as_ref()?
            .get(&tab_id)
            .and_then(|(epoch, context)| (*epoch == navigation).then_some(*context))
    }) {
        return Ok(context);
    }
    let raw =
        call_devtools_protocol_method(webview, "Page.getFrameTree", "{}", CONTEXT_TIMEOUT).await?;
    let tree: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let frame_id = tree["frameTree"]["frame"]["id"]
        .as_str()
        .ok_or("browser frame tree omitted root id")?;
    let context = frame_context(webview, frame_id).await?;
    if active_navigation_generation(tab_id) != Some(navigation) {
        return Err("browser document changed while preparing refs".into());
    }
    if let Ok(mut guard) = ROOT_CONTEXTS.lock() {
        let contexts = guard.get_or_insert_with(HashMap::new);
        if contexts.len() < 256 || contexts.contains_key(&tab_id) {
            contexts.insert(tab_id, (navigation, context));
        }
    }
    Ok(context)
}

pub async fn evaluate_context(
    webview: &Webview,
    context_id: i64,
    expression: &str,
) -> Result<String, String> {
    evaluate_context_with_promise(webview, context_id, expression, false).await
}

async fn evaluate_context_with_promise(
    webview: &Webview,
    context_id: i64,
    expression: &str,
    await_promise: bool,
) -> Result<String, String> {
    let tab = tab_id(webview)?;
    let navigation = active_navigation_generation(tab).ok_or("browser tab closed")?;
    let uses_refs = expression.contains(REF_REGISTRY_JS);
    let installed = uses_refs
        && with_prepared(tab, navigation, |entry| entry.refs.contains(&context_id)) == Some(true);
    let expression = ref_expression(expression, installed);
    let raw = call_devtools_protocol_method(
        webview,
        "Runtime.evaluate",
        &json!({"expression": expression.as_ref(), "contextId": context_id, "returnByValue": true,
            "awaitPromise": await_promise, "userGesture": true})
        .to_string(),
        Duration::from_secs(5),
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if payload.get("exceptionDetails").is_some() {
        with_prepared(tab, navigation, |entry| {
            entry.refs.remove(&context_id);
        });
        return Err("browser ref script failed".into());
    }
    if uses_refs && active_navigation_generation(tab) == Some(navigation) {
        with_prepared(tab, navigation, |entry| {
            if entry.refs.len() < 32 {
                entry.refs.insert(context_id);
            }
        });
    }
    if let Some(value) = payload["result"].get("value") {
        return Ok(value.to_string());
    }
    if payload["result"]["subtype"] == "null" {
        return Ok("null".into());
    }
    Err("browser ref context is unavailable".into())
}

pub async fn execute_main(webview: &Webview, expression: &str) -> Result<String, String> {
    let context_id = main_context(webview).await?;
    let result = evaluate_context(webview, context_id, expression).await;
    if result.is_err() {
        remove(tab_id(webview)?);
    }
    result
}

pub async fn execute_awaited(
    webview: &Webview,
    frame_id: Option<&str>,
    expression: &str,
) -> Result<String, String> {
    let context_id = match frame_id {
        Some(frame_id) => frame_context(webview, frame_id).await?,
        None => main_context(webview).await?,
    };
    let result = evaluate_context_with_promise(webview, context_id, expression, true).await;
    if result.is_err() && frame_id.is_none() {
        remove(tab_id(webview)?);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_source_is_sent_once_without_replaying_the_expression() {
        let expression =
            format!("(() => {{ {REF_REGISTRY_JS} return refRegistry.resolve('g1-e1'); }})()");
        let cold = ref_expression(&expression, false);
        let warm = ref_expression(&expression, true);
        assert_eq!(cold.matches(REF_REGISTRY_JS).count(), 1);
        assert!(!warm.contains(REF_REGISTRY_JS));
        assert!(warm.len() < 150);
        assert_eq!(warm.matches("resolve('g1-e1')").count(), 1);
        assert!(matches!(ref_expression("42", false), Cow::Borrowed(_)));
    }

    #[test]
    fn released_focus_is_turned_on_again_by_the_next_input() {
        let tab = -920007;
        with_prepared(tab, 1, |entry| entry.focus = true);
        note_focus_emulated(tab);
        assert!(take_focus_emulated(tab));
        // The page's next input sends the emulation again.
        assert_eq!(with_prepared(tab, 1, |entry| entry.focus), Some(false));
        // Nothing to end twice, and nothing for a tab Anbo never emulated.
        assert!(!take_focus_emulated(tab));
        assert!(!take_focus_emulated(-920008));
        remove(tab);
    }

    #[test]
    fn prepared_state_is_scoped_to_document_and_bounded() {
        let tab = -920002;
        with_prepared(tab, 1, |entry| {
            entry.focus = true;
            entry.refs.insert(10);
        });
        assert_eq!(
            with_prepared(tab, 1, |entry| entry.focus && entry.refs.contains(&10)),
            Some(true)
        );
        assert_eq!(
            with_prepared(tab, 2, |entry| !entry.focus && entry.refs.is_empty()),
            Some(true)
        );
        remove(tab);
        assert!(!PREPARED
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains_key(&tab));
    }

    #[test]
    fn keys_wait_only_for_a_fresh_document_or_viewport() {
        let tab = -920003;
        let now = Instant::now();
        assert_eq!(key_settle_wait(tab, now), None);
        record_layout_change(tab, now);
        assert_eq!(key_settle_wait(tab, now), Some(KEY_SETTLE));
        assert_eq!(
            key_settle_wait(tab, now + KEY_SETTLE / 3),
            Some(KEY_SETTLE - KEY_SETTLE / 3)
        );
        assert_eq!(key_settle_wait(tab, now + KEY_SETTLE), None);
        remove(tab);
        assert_eq!(key_settle_wait(tab, now), None);
    }

    #[test]
    fn closed_tabs_remove_only_their_context() {
        ROOT_CONTEXTS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(-920001, (1, 10));
        remove(-920001);
        assert!(!ROOT_CONTEXTS
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|contexts| contexts.contains_key(&-920001)));
    }
}

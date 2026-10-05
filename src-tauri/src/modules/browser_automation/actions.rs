use super::target::BrowserTarget as Webview;
use base64::Engine;
use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Listener;

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::context_block::{Ancestors, CONTEXT_BLOCK_JS};
use super::registry::{
    active_loading, active_local_root, active_navigation_generation, active_pending_url,
    set_active_loading, set_active_pending_url,
};
use crate::modules::browser::embed::BROWSER_POPUP_REQUEST_EVENT;
use crate::modules::browser_automation::cdp::{
    call_devtools_protocol_method, capture_screenshot, execute_script, execute_script_with_timeout,
    read_url,
};
use crate::modules::browser_automation::download;
use crate::modules::browser_automation::locator::{
    build_find_js, LocatorMatch, LocatorPayload, LocatorQuery, PageScanState, MAX_CACHED_SCAN_AGE,
    MAX_LOCATOR_MATCHES, PAGE_SCAN_STATE_JS,
};
use crate::modules::browser_automation::page_state::{
    input_guard_body, PageExpectation, StableMatch, TitleSource,
};
use crate::modules::browser_automation::protocol::error_codes;
use crate::modules::browser_automation::readable_text::READABLE_TEXT_JS;
use crate::modules::browser_automation::ref_context::{self, REF_REGISTRY_JS};
use crate::modules::browser_automation::ref_scan::scan_with_fresh_refs;
use crate::modules::browser_automation::registry::{
    get_active_tabs, get_embed_webview, get_tab_lock, remove_tab_lock,
};
use crate::modules::browser_automation::reveal::{
    build_reveal_js, parse_reveal, reveal_budget, DEFAULT_REVEAL_MS, REVEAL_BASELINE_JS,
};
use crate::modules::browser_automation::snapshot::{
    build_frame_snapshot_js, build_snapshot_js, commit_generation, format_snapshot,
    get_current_generation, get_next_generation, get_ref_frame_target, peek_next_generation,
    prioritize_snapshot_elements, record_ref_frame_targets, RefFrameTarget, SnapshotPayload,
    DEFAULT_SNAPSHOT_MAX_CHARS, REF_GENERATIONS_KEPT,
};
use crate::modules::browser_automation::timings::ActionTimings;
use crate::modules::browser_automation::visibility::VISIBILITY_JS;
const VALUE_ACTION_JS: &str = include_str!("valueAction.js");

/// Per-poll timeout for `execute_script` inside readiness/wait loops. Short on
/// purpose: while a tab is navigating, WebView2 drops the script callback, and a
/// single dropped callback must not be allowed to eat the whole wait budget.
const SCRIPT_POLL_TIMEOUT: Duration = Duration::from_secs(2);
const HIDDEN_TAB: &str = "the page went out of view in its browser while the action ran (another tab came in front of it, or its window was minimized), and the browser delivers no pointer input to a hidden page. Retry: Anbo brings the tab forward first.";
const UNDRAWN_TAB: &str = "the browser stopped drawing this tab while the action ran (its window went out of view), and a pointer move waits for a drawn frame. Retry: Anbo brings the tab forward first.";
const MAX_TEXT_OUTPUT_CHARS: u64 = 16_000;
/// The longest a wait may actually run.
///
/// The published ceiling stays 60s so existing callers keep working, but the
/// MCP transport gives up around there too, and a tool that runs to the very
/// edge trades its own structured diagnosis for a bare "The operation timed
/// out." Stopping first means the caller always learns what was seen.
const MAX_WAIT_TIMEOUT_MS: u64 = 50_000;
const ACCEPTED_WAIT_TIMEOUT_MS: u64 = 60_000;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_INPUT_TEXT_BYTES: usize = 64 * 1024;
const MAX_WAIT_TEXT_BYTES: usize = 2 * 1024;
const MAX_LOCATOR_VALUE_BYTES: usize = 4 * 1024;
/// A screenshot up to this size rides along in the tool reply as an image;
/// larger ones are only written to disk, since a full-quality PNG of a large
/// viewport costs more context than the turn it saves.
const INLINE_SCREENSHOT_LIMIT: usize = 600 * 1024;
const MAX_KEY_BYTES: usize = 64;
const MAX_WORKSPACE_BYTES: usize = 4 * 1024;
const MAX_REF_BYTES: usize = 32;
const MAX_FILE_PATH_BYTES: usize = 32 * 1024;
const MAX_UPLOAD_FILES: usize = 16;
const MAX_DOWNLOAD_ID_BYTES: usize = 128;
const MAX_SNAPSHOT_FRAMES: usize = 32;
const FRAME_CONCURRENCY: usize = 6;
const MAX_SNAPSHOT_ELEMENTS: usize = 1_000;
const MAX_SCREENSHOT_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const SUBMISSION_OBSERVATION_MS: u64 = 3_000;
const BROWSER_OPEN_REQUEST_EVENT: &str = "anbo:browser-open-request";
const BROWSER_OPEN_RESPONSE_EVENT: &str = "anbo:browser-open-response";
const BROWSER_CLOSE_REQUEST_EVENT: &str = "anbo:browser-close-request";
const BROWSER_CLOSE_RESPONSE_EVENT: &str = "anbo:browser-close-response";
const BROWSER_TABS_REQUEST_EVENT: &str = "anbo:browser-tabs-request";
const BROWSER_TABS_RESPONSE_EVENT: &str = "anbo:browser-tabs-response";
static OPEN_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static SUBMISSION_OBSERVATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserOpenResponse {
    tab_id: Option<i64>,
    space_id: Option<String>,
    workspace: Option<String>,
    placement: Option<String>,
    error: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTabMetadata {
    tab_id: i64,
    title: String,
    url: String,
    space_id: String,
    workspace: Option<String>,
    active: bool,
    space_active: bool,
    automation_target: bool,
    automation_active: bool,
    automation_method: Option<String>,
    loading: bool,
    #[serde(default)]
    pending_url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTabsResponse {
    active_tab_id: Option<i64>,
    active_space_id: Option<String>,
    /// Tabs in the active space that are not browser tabs. They are invisible
    /// to every browser tool, yet they decide whether an opened tab appears in
    /// front of the user, so a caller that cannot see them cannot predict
    /// placement.
    #[serde(default)]
    other_tabs: usize,
    tabs: Vec<BrowserTabMetadata>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCloseResponse {
    tab_id: Option<i64>,
    space_id: Option<String>,
    workspace: Option<String>,
    error: Option<String>,
}

pub async fn handle_action(
    app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, (String, String)> {
    handle_action_as(app, method, params, super::caller::Caller::default()).await
}

pub async fn handle_action_as(
    app: &AppHandle,
    method: &str,
    params: Value,
    caller: super::caller::Caller,
) -> Result<Value, (String, String)> {
    let started = Instant::now();
    // start_session and end_session are no longer MCP tools: the first browser
    // call opens the session and endSession on the last call closes it. The
    // named-pipe protocol still dispatches both by name, so they stay for it.
    if method == "start_session" {
        // tabId is optional: the session is a contract with this caller, not
        // with one tab. Passing one just paints that tab straight away.
        let tab_id = params
            .get("tabId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0);
        let Some(control_id) = super::activity::begin_session(app, tab_id, &caller) else {
            return Err((
                error_codes::INVALID_REQUEST.into(),
                match tab_id {
                    Some(id) => {
                        format!("browser tab {id} is not open, or cannot be controlled yet")
                    }
                    None => "too many open control sessions; end one first".into(),
                },
            ));
        };
        return Ok(json!({
            "tabId": tab_id,
            "controlId": control_id,
            "actor": caller,
            "durationMs": started.elapsed().as_millis() as u64,
        }));
    }
    if method == "end_session" {
        // tabId is accepted and ignored: one call closes the whole session, and
        // agents written against the older per-tab shape keep working.
        let tab_id = params
            .get("tabId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0);
        let Some(control_id) = params
            .get("controlId")
            .and_then(as_count)
            .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        else {
            return Err((
                error_codes::INVALID_REQUEST.into(),
                "controlId must be a positive safe integer".into(),
            ));
        };
        return Ok(json!({
            "tabId": tab_id,
            "controlId": control_id,
            "ended": super::activity::end_session(app, control_id, &caller),
            "durationMs": started.elapsed().as_millis() as u64,
        }));
    }
    let mut timings =
        ActionTimings::new(params.get("diagnostics").and_then(Value::as_bool) == Some(true));
    // The caller is needed twice: track owns it for the session, and open has to
    // hand it to the UI. browser_open cannot be tracked -- the tab does not exist
    // yet, so there is no id -- which is why the first thing the tab strip ever
    // heard about a freshly driven tab carried no identity, and it fell back to
    // the generic robot until a second, tracked call arrived.
    let actor = caller.clone();
    let tab_id = params.get("tabId").and_then(Value::as_i64);
    // endSession rides whatever call is the last of the task: closing the tab,
    // or the final read when the page stays open for the user. Measured through
    // MCP, close plus browser_end_session were the last two calls of every
    // task; with the flag on any last call there is no session tool to
    // remember, and nothing to forget.
    let end_session_after = params.get("endSession").and_then(Value::as_bool) == Some(true)
        && !method.starts_with("agent_")
        && !method.starts_with("terminal_")
        && !method.starts_with("skills_");
    if let Some((id, root)) = tab_id.and_then(|id| Some((id, active_local_root(id)?))) {
        if super::activity::foreign_holder(id, &root, &actor).is_some() {
            return Err((
                error_codes::TAB_IN_USE.to_string(),
                format!(
                    "tab {id} is in another workspace, where another agent is working in it; nothing was done. Use a tab you opened with browser_open in your own workspace."
                ),
            ));
        }
    }
    let before_navigation = tab_id.and_then(active_navigation_generation);
    // A single-page app moves to a new URL without a native navigation:
    // YouTube and Maps after a search, YouTube after a result click. Their
    // replies came back without hints, so the next call went to a find.
    let lands = LANDING_METHODS.contains(&method) || submits_type(method, &params);
    let search = submits_type(method, &params)
        .then(|| {
            params
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .flatten();
    let before_url = match tab_id.filter(|_| lands) {
        Some(id) => match get_embed_webview(app, id) {
            Ok(webview) => super::cdp::read_page_info(&webview, Duration::from_millis(150))
                .await
                .ok()
                .map(|(_, url)| url),
            Err(_) => None,
        },
        None => None,
    };
    let result = super::activity::track(
        app,
        method,
        tab_id,
        caller,
        handle_action_inner(app, method, params, &mut timings, &actor),
    )
    .await;
    let result = timings.finish(result);
    if method.starts_with("agent_") || method.starts_with("terminal_") {
        return result;
    }
    let mut result = result;
    if method == "open" {
        if let Some(root) = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("tabId").and_then(Value::as_i64))
            .and_then(active_local_root)
        {
            super::activity::note_workspace(&actor, root);
        }
    } else if let Some(root) = tab_id
        .filter(|_| result.is_ok())
        .and_then(active_local_root)
    {
        super::activity::touch_workspace(&actor, &root);
    }
    if let Ok(value) = &mut result {
        // An action that can move the page says where it landed. Without this
        // the agent asked browser_get_url after almost every one: 19 times in
        // 15 tasks, 14 of them right before closing the tab, each a full turn.
        let submitted_type = matches!(method, "type" | "type_text")
            && value.get("submitted").and_then(Value::as_bool) == Some(true);
        if LANDING_METHODS.contains(&method) || submitted_type {
            if let Some(webview) = tab_id.and_then(|id| get_embed_webview(app, id).ok()) {
                value["page"] = landing(&webview, tab_id.unwrap_or_default()).await;
                // A navigation during the action put the agent somewhere new.
                // The heading and the few visible controls it is about to look
                // for ride along, so a snapshot is not the only way to learn
                // them: on the OpenCode/Antigravity series the calls after a
                // search submit or a product click went to snapshot, find and
                // get_text purely to learn what these hints carry.
                let id = tab_id.unwrap_or_default();
                let native = value.get("navigationObserved").and_then(Value::as_bool) == Some(true)
                    || tab_id
                        .and_then(active_navigation_generation)
                        .zip(before_navigation)
                        .is_some_and(|(after, before)| after != before);
                let routed = before_url
                    .as_deref()
                    .zip(value["page"]["url"].as_str())
                    .is_some_and(|(before, after)| url_moved(before, after));
                let mut navigated = native || routed;
                if !navigated
                    && (active_pending_url(id).is_some() || active_loading(id) == Some(true))
                {
                    // The commit can lag the action. Only wait while a
                    // navigation is actually in flight -- an ordinary click
                    // that stays on the page pays nothing.
                    let deadline = tokio::time::Instant::now() + Duration::from_millis(1_500);
                    while tokio::time::Instant::now() < deadline {
                        if active_navigation_generation(id)
                            .zip(before_navigation)
                            .is_some_and(|(after, before)| after != before)
                        {
                            navigated = true;
                            break;
                        }
                        if active_pending_url(id).is_none() && active_loading(id) != Some(true) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
                // A submitted search always looks: Maps can answer before its
                // URL moves, and the look waits for results naming the query.
                if navigated || search.is_some() {
                    let hints = if routed && !native && search.is_none() {
                        routed_landing_hints(&webview, id).await
                    } else {
                        navigation_hints(&webview, id, search.as_deref()).await
                    };
                    // The wait may have let the page retitle itself or move on.
                    if search.is_some() || (routed && !native) {
                        value["page"] = landing(&webview, id).await;
                    }
                    if let Some(hints) = hints {
                        value["page"]["hints"] = hints;
                    }
                }
                // Landing on a player that is already playing says so: the next
                // call on YouTube was a get_property to learn it before pressing
                // k. A paused or not yet started player is left out, because it
                // may be about to autoplay and "paused" would be a guess.
                if navigated && value.get("media").is_none() && active_loading(id) != Some(true) {
                    if let Some(media) = page_media_state(&webview)
                        .await
                        .filter(|media| media["paused"] == json!(false))
                    {
                        value["page"]["media"] = media;
                    }
                }
            }
        }
        // A successful last call releases the session: cursor and badge go,
        // tabs stay unless this was browser_close. An error leaves it, so the
        // agent can recover, and the sweep covers whatever is then forgotten.
        if end_session_after {
            super::activity::end_owner(app, &actor);
            value["sessionEnded"] = json!(true);
        }
    }
    result.map(|mut value| {
        if let Some(object) = value.as_object_mut() {
            let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            object.insert("durationMs".to_string(), Value::from(elapsed));
        }
        value
    })
}

/// Plain DOM properties browser_get_property may read: state a page exposes
/// directly and that an agent otherwise probes through several finds. Closed
/// list, primitives only; nothing here runs page code or reaches storage.
pub(crate) const ELEMENT_PROPERTIES: [&str; 25] = [
    "value",
    "checked",
    "disabled",
    "readOnly",
    "selected",
    "paused",
    "ended",
    "muted",
    "currentTime",
    "duration",
    "volume",
    "playbackRate",
    "scrollTop",
    "scrollLeft",
    "scrollHeight",
    "scrollWidth",
    "clientHeight",
    "clientWidth",
    "href",
    "src",
    "title",
    "placeholder",
    "open",
    "hidden",
    "tagName",
];

/// Whether browser_type was asked to press Enter after filling.
fn submits_type(method: &str, params: &Value) -> bool {
    matches!(method, "type" | "type_text")
        && params.get("submit").and_then(Value::as_bool) == Some(true)
}

/// A committed URL that changed other than by its fragment: a single-page
/// route change counts, an in-page anchor jump does not.
fn url_moved(before: &str, after: &str) -> bool {
    let page = |url: &str| url.split('#').next().unwrap_or(url).to_string();
    !before.is_empty() && !after.is_empty() && page(before) != page(after)
}

/// Actions after which the agent wants to know where the tab is.
const LANDING_METHODS: [&str; 12] = [
    "click",
    "double_click",
    // A pan or a slider moves maps and viewers to a new URL; without the page
    // block the agent spent a ToolSearch and a page_info to read it back.
    "drag",
    "press_key",
    "press",
    "key",
    "wait",
    "navigate",
    "reload",
    "back",
    "forward",
    "dialog",
];

/// The tab's committed URL and native title, read from WebView2 without page
/// JavaScript, plus whether a load is still in flight. Bounded and best
/// effort: a tab that cannot answer in half a second reports only its loading
/// state rather than slowing the action it rides on.
async fn landing(webview: &Webview, tab_id: i64) -> Value {
    let mut page = json!({ "loading": active_loading(tab_id) });
    if let Some(pending) = active_pending_url(tab_id) {
        page["pendingUrl"] = json!(pending);
    }
    if let Ok((title, url)) = super::cdp::read_page_info(webview, Duration::from_millis(500)).await
    {
        page["url"] = json!(url);
        page["title"] = json!(title.chars().take(160).collect::<String>());
    }
    page
}

/// The visible things a freshly landed-on page offers: its main heading (the
/// first line of the first h1 a reader can see, falling back to og:title), up
/// to five result titles (links in or around an h2-h4 within two screens) and
/// up to three interactive controls outside the page chrome, each carrying a
/// live ref so the agent can act on what it just landed on without a find or a
/// snapshot first. After a search, results must name one of the query's words:
/// a single-page app shows its old page for a moment, and YouTube's home feed
/// was read as the answer to "lofi hip hop radio". With `HintsGate::Results`
/// the script answers nothing, and registers nothing, until such a result or a
/// heading naming the query is on the page; with `HintsGate::Heading`, until a
/// visible h1 is. A document still loading answers nothing.
fn build_navigation_hints_js(
    generation: u64,
    ref_prefix: &str,
    query_words: &[String],
    gate: HintsGate,
) -> String {
    format!(
        r#"(() => {{
    {REF_REGISTRY_JS}
    refRegistry.begin({generation});
    const refPrefix = {ref_prefix};
    const queryWords = {query_words};
    const gate = {gate};
    if (document.readyState === 'loading' || !document.body) return null;
    const namesQuery = (text) => {{
        const lower = text.toLocaleLowerCase();
        return queryWords.some((word) => lower.includes(word));
    }};
    const chromeOf = (el) => el.closest('nav,header,aside,footer,[role=banner],[role=navigation]');
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    // Amazon keeps a screen-reader-only h1 ahead of the product title and puts
    // its whole results toolbar inside another; the title is the first line of
    // the first h1 anyone can see.
    const shown = (el) => {{
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2
            && (!el.checkVisibility || el.checkVisibility({{ opacityProperty: true, visibilityProperty: true }}));
    }};
    let heading = '';
    for (const h1 of document.querySelectorAll('h1')) {{
        if (!shown(h1)) continue;
        heading = clean(String(h1.innerText || '').split('\n').find((line) => line.trim()) || '');
        if (heading) break;
    }}
    const fromH1 = !!heading;
    const siteName = clean(document.querySelector('meta[property="og:title"]')?.content);
    if (gate === 'heading' && !heading && siteName && clean(document.title) === siteName) return null;
    // A route change's own title is fresher than the og:title of the first load.
    if (!heading) heading = gate === 'heading' ? clean(document.title) || siteName : siteName;
    // A search landing is read for its result titles: YouTube, Amazon, Google
    // and Bing all put them in links inside or around an h2-h4. Without them
    // the agent guessed a results selector, missed, and looked again.
    const found = [];
    const hrefs = new Set();
    let links = 0;
    for (const el of document.querySelectorAll('a[href]')) {{
        if (found.length >= 5 || ++links > 3000) break;
        if (!(el.closest('h2,h3,h4') || el.querySelector('h2,h3,h4')) || chromeOf(el)) continue;
        // Laid out is not visible: YouTube keeps the page it is leaving in the
        // layout, faded, while the next one renders.
        if (!shown(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!(rect.bottom > 0 && rect.top < innerHeight * 2)) continue;
        // YouTube's home feed stays on screen while the results render, and a
        // profile that keeps searching lofi is recommended lofi: its titles name
        // the query too. Only titles drawn since the search count as results; a
        // recycled title element pointing somewhere new is a new result.
        if (queryWords.length && globalThis.__anboBeforeSubmit?.get(el) === el.href) continue;
        const name = clean(el.getAttribute('aria-label') || el.innerText || el.textContent).slice(0, 100);
        if (!name || hrefs.has(el.href) || (queryWords.length && !namesQuery(name))) continue;
        hrefs.add(el.href);
        found.push({{ el, name }});
    }}
    // A search that lands on one place names the place, not the query (Maps:
    // "Monas Jakarta" is "Monumen Nasional"), so an h1 drawn since the submit
    // answers too; the caller waits for it to hold still.
    const beforeHeading = globalThis.__anboBeforeSubmitHeading;
    const newHeading = queryWords.length > 0 && fromH1 && typeof beforeHeading === 'string' && heading !== beforeHeading;
    if (gate === 'results' && !found.length && !(heading && namesQuery(heading)) && !newHeading) return null;
    let registered = 0;
    const remember = (el) => {{
        const ref = refPrefix + (++registered);
        refRegistry.remember(ref, el);
        return ref;
    }};
    const results = found.map(({{ el, name }}) => ({{ ref: remember(el), name }}));
    const controls = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role]')) {{
        if (controls.length >= 3) break;
        if (el.tagName.startsWith('ANBO-') || chromeOf(el)) continue;
        const tag = el.tagName;
        const role = el.getAttribute('role')
            || (tag === 'A' ? 'link' : tag === 'BUTTON' ? 'button'
            : tag === 'INPUT' ? String(el.type || 'text').toLowerCase()
            : tag === 'SELECT' ? 'combobox' : tag === 'TEXTAREA' ? 'textbox' : '');
        if (!role || role === 'presentation' || role === 'none') continue;
        const name = clean(el.getAttribute('aria-label') || el.textContent || el.getAttribute('value') || el.placeholder).slice(0, 60);
        if (!name) continue;
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight)) continue;
        // A box is not visibility: TradingView lays out a hidden twin of its
        // symbol button, and the ref handed back for it could not be clicked.
        if (!shown(el)) continue;
        const key = role + '|' + name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        controls.push({{ ref: remember(el), role, name }});
    }}
    if (!heading && !results.length && !controls.length) return null;
    return JSON.stringify({{ heading: heading.slice(0, 120) || null, results, controls }});
}})()"#,
        generation = generation,
        ref_prefix = serde_json::to_string(ref_prefix).unwrap(),
        query_words = serde_json::to_string(query_words).unwrap(),
        gate = serde_json::to_string(gate.as_str()).unwrap(),
    )
}

/// What a look at a landed page must see before it answers and registers refs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HintsGate {
    Any,
    /// A result title or heading naming the search.
    Results,
    /// A visible h1: the view a route change moved to has been drawn.
    Heading,
}

impl HintsGate {
    fn as_str(self) -> &'static str {
        match self {
            HintsGate::Any => "any",
            HintsGate::Results => "results",
            HintsGate::Heading => "heading",
        }
    }
}

/// The result-title links a page shows before a search, kept in the automation
/// world so the landing hints can skip them. Bounded like the hints scan; a new
/// document starts without it.
const PRE_SUBMIT_TITLES_JS: &str = r#"(() => {
    const titles = new WeakMap();
    let links = 0;
    for (const el of document.querySelectorAll('a[href]')) {
        if (++links > 3000) break;
        if (el.closest('h2,h3,h4') || el.querySelector('h2,h3,h4')) titles.set(el, el.href);
    }
    globalThis.__anboBeforeSubmit = titles;
    // Read exactly as the hints read their heading, so an unchanged h1 is
    // never mistaken for a new one.
    let heading = '';
    for (const h1 of document.querySelectorAll('h1')) {
        const rect = h1.getBoundingClientRect();
        if (!(rect.width > 2 && rect.height > 2)
            || (h1.checkVisibility && !h1.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
        heading = String(h1.innerText || '').split('\n').find((line) => line.trim()) || '';
        heading = heading.replace(/\s+/g, ' ').trim();
        if (heading) break;
    }
    globalThis.__anboBeforeSubmitHeading = heading;
    return 'ok';
})()"#;

/// The words of a search a result title must name: lowercase, two characters
/// or more, at most eight. "usb c hub" gives usb and hub.
fn query_words(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for word in text
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|word| word.chars().count() >= 2)
    {
        if words.len() < 8 && !words.contains(&word) {
            words.push(word);
        }
    }
    words
}

/// Whether a hints answer registered any ref, and so spent its generation.
fn hints_registered_refs(hints: &Value) -> bool {
    ["results", "controls"].iter().any(|key| {
        hints
            .get(*key)
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty())
    })
}

/// How long a landing may take to draw what its hints read. Every wait ends
/// as soon as the page is ready, so this is only spent on a slow page: with
/// eight agents on four cores, YouTube and Maps drew their headings after the
/// 1.2 to 1.5 seconds these waits used to allow, and each miss cost the agent
/// a turn (about 4.5 seconds) to read what the reply could have carried.
const LANDING_PATIENCE: Duration = Duration::from_millis(3_000);

/// Hints for the page an action just landed on. After a search the page is
/// looked at every 250 ms to show a result or heading that names the query,
/// or an h1 drawn since the submit; the looks before the last register
/// nothing. Results, and a new heading that does not name the query, are
/// handed back only once two looks in a row saw the same, with the same tab
/// title and URL, and with the refs of the later look: YouTube hides the results it has just drawn and draws them
/// again, and a ref from the first drawing was "not visible" by the agent's
/// click in one session in five. Any other landing is looked at every 150 ms
/// until it shows something.
async fn navigation_hints(webview: &Webview, tab_id: i64, query: Option<&str>) -> Option<Value> {
    let words = query.map(query_words).unwrap_or_default();
    if words.is_empty() {
        // A navigation answers the moment it commits, and a busy machine may
        // still be parsing the page: four agents at once left Amazon's product
        // reply without a heading. A page with nothing to show yet is looked
        // at again every 150 ms.
        let deadline = tokio::time::Instant::now() + LANDING_PATIENCE;
        loop {
            let hints = navigation_hints_once(webview, tab_id, &words, HintsGate::Any).await;
            let last = tokio::time::Instant::now() + Duration::from_millis(150) >= deadline;
            if hints.is_some() || last {
                return hints;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    let deadline = tokio::time::Instant::now() + LANDING_PATIENCE;
    let mut previous: Option<(Vec<String>, String, (String, String))> = None;
    loop {
        let last = tokio::time::Instant::now() + Duration::from_millis(250) >= deadline;
        let gate = if last {
            HintsGate::Any
        } else {
            HintsGate::Results
        };
        match navigation_hints_once(webview, tab_id, &words, gate).await {
            Some(hints) => {
                let titles = result_titles(&hints);
                let heading = hints
                    .get("heading")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_lowercase();
                // A heading naming the query answers at once; results, or a
                // new heading that does not name it, must hold still, and so
                // must the tab's title and URL: Maps drew "Monumen Nasional"
                // while its title still said "Monas Jakarta" and its URL was
                // still the search, and every agent then spent a find checking
                // which page it was on.
                let named = titles.is_empty() && words.iter().any(|word| heading.contains(word));
                let page = super::cdp::read_page_info(webview, Duration::from_millis(150))
                    .await
                    .unwrap_or_default();
                let seen = (titles, heading, page);
                if last || named || previous.as_ref() == Some(&seen) {
                    return Some(hints);
                }
                previous = Some(seen);
            }
            None if last => return None,
            None => previous = None,
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Hints after a route change inside the same document. The reply can come
/// before the new view is drawn: YouTube's watch page answered with no h1 and
/// the title "YouTube", the site name its og:title has carried since the first
/// load, and the agent spent a find on the video title. While the page shows
/// only that site name, it is looked at again every 150 ms; the looks before
/// the answer register nothing. A page with an h1, or a title of its own,
/// answers at once.
async fn routed_landing_hints(webview: &Webview, tab_id: i64) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + LANDING_PATIENCE;
    loop {
        if tokio::time::Instant::now() + Duration::from_millis(150) >= deadline {
            return navigation_hints_once(webview, tab_id, &[], HintsGate::Any).await;
        }
        if let Some(hints) = navigation_hints_once(webview, tab_id, &[], HintsGate::Heading).await {
            return Some(hints);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// The result titles a hints answer carries, in order, to tell a list that
/// held still from one the page is still redrawing.
fn result_titles(hints: &Value) -> Vec<String> {
    hints
        .get("results")
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .filter_map(|result| result.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// One look at a landed page, or None when the document is still loading or
/// cannot answer in time. Runs through the same fresh-ref protocol as find and
/// snapshot: the generation is published only when a ref was actually
/// registered, and an empty answer retires nothing the caller is holding.
async fn navigation_hints_once(
    webview: &Webview,
    tab_id: i64,
    words: &[String],
    gate: HintsGate,
) -> Option<Value> {
    let scan = |generation: u64| async move {
        let script =
            build_navigation_hints_js(generation, &format!("g{generation}-e"), words, gate);
        let raw = tokio::time::timeout(
            Duration::from_millis(500),
            ref_context::execute_main(webview, &script),
        )
        .await
        .ok()
        .and_then(Result::ok);
        let parsed = raw
            .as_deref()
            .map(str::trim)
            .filter(|raw| !raw.is_empty() && *raw != "null" && *raw != "undefined")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .map(|value| match value {
                Value::String(inner) => {
                    serde_json::from_str::<Value>(&inner).unwrap_or(Value::Null)
                }
                other => other,
            })
            .filter(Value::is_object);
        Ok::<Option<Value>, (String, String)>(parsed)
    };
    let (_, hints) = super::ref_scan::scan_with_fresh_refs(
        tab_id,
        tokio::time::Instant::now() + Duration::from_millis(1_500),
        scan,
        |hints: &Option<Value>| hints.as_ref().is_some_and(hints_registered_refs),
    )
    .await
    .ok()?;
    hints
}

/// A count or size parameter: an integer, or a finite non-negative float
/// truncated toward zero. `Value::as_u64` alone is None for `400.5`, and every
/// caller then fell back to its own default without saying so. Measured on
/// browser_find: timeout 400 took 413 ms, timeout 400.5 took 5,008 ms.
fn as_count(value: &Value) -> Option<u64> {
    if let Some(count) = value.as_u64() {
        return Some(count);
    }
    let float = value.as_f64()?;
    (float.is_finite() && float >= 0.0).then(|| float.trunc() as u64)
}

async fn handle_action_inner(
    app: &AppHandle,
    method: &str,
    mut params: Value,
    timings: &mut ActionTimings,
    caller: &super::caller::Caller,
) -> Result<Value, (String, String)> {
    if method.starts_with("agent_") || method.starts_with("terminal_") {
        return crate::modules::browser_automation::agent_actions::handle_agent_action(
            app, method, params,
        )
        .await;
    }
    // Skills are documents, not surfaces. Reading one drives nothing the user
    // can see, so it is not something to hold a browser session for.
    // The session is the gate, not a formality. Every browser action runs under
    // a session that names its caller, so an action arriving without one has
    // nobody to attribute it to -- which is how a tab ended up on screen
    // claiming a controller Anbo could not name. Anbo's own UI answers for
    // itself and needs no session.
    if !method.starts_with("skills_")
        && !caller.is_internal()
        && !super::activity::holds_control(caller)
    {
        // The first browser tool opens the session itself. The caller is named
        // by its terminal or connection either way, so refusing here bought no
        // attribution; measured over fifteen agent-driven tasks it only cost
        // browser_start_session on top of every task. A session with no tab
        // claims nothing yet: the action that follows paints the tab it
        // touches under this same id, and the reply carries the controlId.
        if super::activity::begin_session(app, None, caller).is_none() {
            return Err((
                error_codes::INVALID_REQUEST.into(),
                "too many open control sessions; end one with endSession:true on its last call first".into(),
            ));
        }
    }
    // While the user is drawing on a tab, the layer sits over the page and
    // would swallow any press or drag; refusing up front says why, where the
    // pointer guard could only report a covered target.
    if super::design::blocks_input(method)
        && params
            .get("tabId")
            .and_then(Value::as_i64)
            .is_some_and(super::design::is_active)
    {
        return Err((
            error_codes::INPUT_NOT_READY.into(),
            super::design::refusal(),
        ));
    }
    // Before the tab lock and any lookup: the dock takes that lock to bring the
    // page in, and the page's layout changes as it comes.
    if super::external_front::needs_shown_page(method) {
        if let Some(tab_id) = params.get("tabId").and_then(Value::as_i64) {
            timings
                .measure("front", super::external_front::bring_to_front(app, tab_id))
                .await?;
        }
    }
    if params.get("locator").is_some() {
        // A malformed submit is refused before the lookup can spend its timeout.
        if matches!(method, "type" | "type_text") {
            type_submit(&params)?;
        }
        if params.get("ref").is_some()
            || (method == "drag"
                && (params.get("sourceRef").is_some() || params.get("targetRef").is_some()))
            || (method != "wait" && !super::locator_target::supports_locator(method))
        {
            return Err((
                error_codes::INVALID_REQUEST.into(),
                "use exactly one ref or locator on a supported action".into(),
            ));
        }
        let resolved = timings
            .measure(
                "locator",
                resolve_target_locator(app, &params, method == "wait", method == "get_text"),
            )
            .await?;
        if method == "wait" {
            return Ok(resolved);
        }
        params["ref"] = resolved["ref"].clone();
        for key in ["sameTextMatches", "onlyInformativeOf"] {
            if let Some(merged) = resolved.get(key) {
                params[key] = merged.clone();
            }
        }
        // Only the lookup says a read took screen-reader text, never the caller.
        if method == "get_text" {
            params["screenReaderOnly"] =
                (resolved.get("screenReaderOnly").and_then(Value::as_bool) == Some(true)).into();
        }
        if method == "drag" {
            // One element, two positions: a locator on drag means "pan inside
            // this". Every measured canvas drag was exactly that, and each cost
            // a find first because drag took refs only.
            if params.get("sourcePosition").is_none() || params.get("targetPosition").is_none() {
                return Err((
                    error_codes::INVALID_REQUEST.into(),
                    "drag with locator pans inside one element: pass sourcePosition and targetPosition".into(),
                ));
            }
            params["sourceRef"] = resolved["ref"].clone();
            params["targetRef"] = resolved["ref"].clone();
        }
    }
    match method {
        "open" => {
            let read = open_read_request(&params)?;
            let mut result = open_browser(app, &params, caller, timings).await?;
            // The tab an agent just opened is the tab it is about to work, and
            // the open response is the first thing it reads. Naming the session
            // here spares it hunting for the id in some later call's payload,
            // which is what agents were actually doing.
            if let Some(object) = result.as_object_mut() {
                let tab_id = object.get("tabId").and_then(Value::as_i64);
                if let Some(target) = tab_id.and_then(crate::modules::browser_external::get_target)
                {
                    object.insert("backend".into(), json!("external"));
                    object.insert("profile".into(), target.profile().unwrap_or(Value::Null));
                    object.insert("managedDownloads".into(), json!(false));
                }
                if let Some(control_id) = super::activity::begin_session(app, tab_id, caller) {
                    object.insert("controlId".into(), control_id.into());
                }
            }
            if let Some((method, mut read_params)) = read {
                let tab_id = result["tabId"].clone();
                read_params["tabId"] = tab_id.clone();
                match read_initial_page(app, method, read_params, timings, caller).await {
                    Ok(value) => {
                        result["read"] = value;
                        result["readOk"] = json!(true);
                        if let Some(id) = tab_id.as_i64() {
                            if let Ok(webview) = get_embed_webview(app, id) {
                                result["page"] = landing(&webview, id).await;
                            }
                        }
                        if params["closeTab"] == true
                            && !read_lets_tab_close(method, &result["read"])
                        {
                            result["closed"] = json!(false);
                            result["closeSkipped"] = json!("the snapshot continues at nextOffset, so the tab stays open for the rest");
                        } else if params["closeTab"] == true {
                            let close_params =
                                json!({"tabId":tab_id,"workspace":params["workspace"]});
                            match close_browser(app, &close_params).await {
                                Ok(_) => {
                                    result["closed"] = json!(true);
                                    result["refsUsable"] = json!(false);
                                }
                                Err((code, message)) => {
                                    result["closeError"] = json!({"code":code,"message":message})
                                }
                            }
                        }
                    }
                    Err((code, message)) => {
                        result["readOk"] = json!(false);
                        result["readError"] = json!({"code":code,"message":message});
                        result["closed"] = json!(false);
                        if let Some(id) = tab_id.as_i64() {
                            if let Ok(webview) = get_embed_webview(app, id) {
                                result["page"] = landing(&webview, id).await;
                            }
                        }
                    }
                }
            }
            Ok(result)
        }
        "close" => close_browser(app, &params).await,
        "list_tabs" | "tabs" => {
            let tab_ids = get_active_tabs();
            let active_ids = tab_ids.iter().copied().collect::<HashSet<_>>();
            let metadata = request_browser_tabs_metadata(app).await;
            let active_tab_id = metadata
                .as_ref()
                .and_then(|response| response.active_tab_id)
                .filter(|tab_id| active_ids.contains(tab_id));
            let active_space_id = metadata
                .as_ref()
                .and_then(|response| response.active_space_id.clone());
            let other_tabs = metadata.as_ref().map_or(0, |response| response.other_tabs);
            let mut by_id = metadata
                .map(|response| {
                    response
                        .tabs
                        .into_iter()
                        .filter(|tab| active_ids.contains(&tab.tab_id))
                        .map(|tab| (tab.tab_id, tab))
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default();
            let mut result = Vec::new();
            for tab_id in tab_ids {
                if let Some(mut tab) = by_id.remove(&tab_id) {
                    if let Some(loading) = active_loading(tab_id) {
                        tab.loading = loading;
                    }
                    tab.pending_url = active_pending_url(tab_id);
                    let mut item = serde_json::to_value(tab).unwrap_or_default();
                    item["titleSource"] = json!("ui");
                    result.push(item);
                    continue;
                }
                if let Ok(webview) = get_embed_webview(app, tab_id) {
                    let (title, url) = super::cdp::read_page_info(&webview, SCRIPT_POLL_TIMEOUT)
                        .await
                        .unwrap_or_default();

                    result.push(json!({
                        "tabId": tab_id,
                        "url": url,
                        "title": title,
                        "titleSource": "native",
                        "spaceId": null,
                        "workspace": null,
                        "active": active_tab_id == Some(tab_id),
                        "spaceActive": false,
                        "automationTarget": false,
                        "automationActive": false,
                        "automationMethod": null,
                        "loading": active_loading(tab_id),
                        "pendingUrl": active_pending_url(tab_id),
                    }));
                }
            }
            for item in &mut result {
                if let Some(target) = item["tabId"]
                    .as_i64()
                    .and_then(crate::modules::browser_external::get_target)
                {
                    item["backend"] = json!("external");
                    item["profile"] = target.profile().unwrap_or(Value::Null);
                    item["managedDownloads"] = json!(false);
                    if let Some(dock) =
                        crate::modules::browser_external::dock::diagnostics(target.tab_id)
                    {
                        item["nativeDock"] = dock;
                    }
                }
            }
            Ok(json!({
                "tabs": result,
                "activeTabId": active_tab_id,
                "activeSpaceId": active_space_id,
                "otherTabsInSpace": other_tabs,
                "workspaceHasTabs": other_tabs > 0 || !result.is_empty(),
            }))
        }

        "get_url" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let url = read_url(&webview, SCRIPT_POLL_TIMEOUT)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            Ok(
                json!({ "tabId": tab_id, "url": url, "pendingUrl": active_pending_url(tab_id), "loading": active_loading(tab_id) }),
            )
        }

        "navigate" => {
            let tab_id = extract_tab_id(&params)?;
            let url = params.get("url").and_then(|v| v.as_str()).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'url' parameter".to_string(),
                )
            })?;
            ensure_bounded(url, MAX_URL_BYTES, "url")?;

            let target = url::Url::parse(url).map_err(|error| {
                (
                    error_codes::NAVIGATION_FAILED.to_string(),
                    format!("invalid URL: {error}"),
                )
            })?;
            if !matches!(target.scheme(), "http" | "https") {
                return Err((
                    error_codes::NAVIGATION_FAILED.to_string(),
                    "only http:// and https:// URLs are allowed".to_string(),
                ));
            }

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            set_active_loading(tab_id, true);
            set_active_pending_url(tab_id, Some(target.to_string()));
            if let Err(error) = webview.navigate(target).await {
                set_active_loading(tab_id, false);
                return Err((
                    error_codes::NAVIGATION_FAILED.to_string(),
                    error.to_string(),
                ));
            }

            Ok(json!({ "tabId": tab_id, "url": url, "ok": true, "loading": true }))
        }

        "reload" | "back" | "forward" | "stop" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            // Read the load state before cutting it: afterwards there is
            // nothing left to distinguish "there was nothing to stop" from
            // "a load was cut", and both report loading=false.
            let was_loading = active_loading(tab_id);
            let pending_url = active_pending_url(tab_id);
            let navigated = dispatch_navigation_action(&webview, tab_id, method)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            let mut body = json!({
                "tabId": tab_id,
                "action": method,
                "ok": true,
                "navigated": navigated,
                "loading": active_loading(tab_id)
            });
            if method == "stop" {
                // Stopping is not navigating. Reporting navigated=false next to
                // a URL that had already committed read as "the tab is still on
                // the old page", which was the opposite of the truth.
                body.as_object_mut().map(|body| body.remove("navigated"));
                body["wasLoading"] = json!(was_loading.unwrap_or(false));
                body["cancelledUrl"] = json!(match was_loading {
                    Some(true) => pending_url,
                    _ => None,
                });
            }
            Ok(body)
        }

        "snapshot" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 5000).await;
            let gen = get_next_generation(tab_id);
            let (payload, included_frames, skipped_frames) =
                collect_snapshot_payload(&webview, tab_id, gen)
                    .await
                    .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            let requested_max_chars = params
                .get("maxChars")
                .and_then(as_count)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS);
            let offset = params
                .get("offset")
                .and_then(as_count)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(0);
            let formatted = format_snapshot(&payload, gen, requested_max_chars, offset);

            Ok(json!({
                "tabId": tab_id,
                "generation": gen,
                "snapshot": formatted.text,
                "title": payload.title,
                "titleSource": "document",
                "url": payload.url,
                "truncated": formatted.truncated,
                "includedItems": formatted.included_items,
                "totalItems": formatted.total_items,
                "maxChars": formatted.max_chars,
                "offset": formatted.offset,
                "nextOffset": formatted.next_offset,
                "includedFrames": included_frames,
                "skippedFrames": skipped_frames
            }))
        }

        "find" => {
            let tab_id = extract_tab_id(&params)?;
            let locator = extract_locator(&params)?;
            let timeout_ms = params
                .get("timeout")
                .and_then(as_count)
                .unwrap_or(5_000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

            let mut empty_scans = 0;
            let mut last_empty_scan = None;
            let mut scanned_state: Option<PageScanState> = None;
            let mut scanned_at = tokio::time::Instant::now();
            let mut quiet_waits = 0usize;
            let mut backoff_ms = LOCATOR_RETRY_MS;
            // Early absence requires another complete scan after settling.
            // browser_open's read fills in a timeout either way and says
            // whether it was the caller's.
            let mut clock = MissClock {
                patient: params
                    .get("callerTimeout")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| params.get("timeout").is_some()),
                ..MissClock::default()
            };
            let mut recoveries = 0usize;
            loop {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Err(find_timeout(
                        &locator,
                        timeout_ms,
                        empty_scans,
                        None,
                        last_empty_scan.as_ref(),
                        quiet_waits,
                    ));
                }
                let current_state = page_scan_state(&webview).await;
                if let Some(previous) = &scanned_state {
                    clock.page_read(previous, current_state.as_ref());
                    if current_state.as_ref().is_some_and(|current| {
                        !clock.absence_settled(now, timeout_ms)
                            && previous.can_reuse(
                                current,
                                now.saturating_duration_since(scanned_at),
                                clock.absence_pending(),
                            )
                    }) {
                        quiet_waits += 1;
                        backoff_ms = (backoff_ms * 2).min(MAX_LOCATOR_RETRY_MS);
                        tokio::time::sleep_until(locator_retry_at(
                            now, scanned_at, backoff_ms, deadline,
                        ))
                        .await;
                        continue;
                    }
                }
                scanned_state = current_state;
                scanned_at = tokio::time::Instant::now();
                let scanned = scan_with_fresh_refs(
                    tab_id,
                    deadline,
                    |generation| collect_locator_matches(&webview, tab_id, generation, &locator),
                    |result| !result.matches.is_empty(),
                )
                .await;
                let (generation, result) = match scanned {
                    Ok(scanned) => scanned,
                    // TradingView replaces its document right after it loads, and
                    // a find asked to wait 15 s failed at once on the change. A
                    // document that changes under the scan is looked at again
                    // within the caller's timeout, as browser_open's read does.
                    Err((code, message))
                        if super::initial_read::retry_read_error(
                            &code,
                            &message,
                            message.contains("document changed during reference scan"),
                            recoveries,
                        ) =>
                    {
                        recoveries += 1;
                        scanned_state = None;
                        tokio::time::sleep_until(
                            (tokio::time::Instant::now() + Duration::from_millis(LOCATOR_RETRY_MS))
                                .min(deadline),
                        )
                        .await;
                        continue;
                    }
                    Err(error) if error.0 == error_codes::TIMEOUT => {
                        return Err(find_timeout(
                            &locator,
                            timeout_ms,
                            empty_scans,
                            Some(&error.1),
                            last_empty_scan.as_ref(),
                            quiet_waits,
                        ));
                    }
                    Err(error) => return Err(error),
                };
                if !result.matches.is_empty() {
                    let count = result.matches.len();
                    return Ok(json!({
                        "tabId": tab_id,
                        "generation": generation,
                        "by": locator.by,
                        "value": locator.value,
                        "matches": result.matches,
                        "count": count,
                        "scanned": result.scanned,
                        "truncated": result.truncated,
                        "nodeLimitReached": result.node_limit_reached,
                        "includedFrames": result.included_frames,
                        "skippedFrames": result.skipped_frames,
                        "hiddenMatches": result.hidden
                    }));
                }
                empty_scans += 1;
                let completed = tokio::time::Instant::now();
                if clock.missed(
                    &result,
                    scanned_state.as_ref(),
                    completed,
                    timeout_ms,
                    active_loading(tab_id) == Some(true),
                ) {
                    let elapsed = timeout_ms.saturating_sub(
                        deadline.saturating_duration_since(completed).as_millis() as u64,
                    );
                    return Err(find_timeout(
                        &locator,
                        elapsed,
                        empty_scans,
                        None,
                        Some(&result),
                        quiet_waits,
                    ));
                }
                last_empty_scan = Some(result);
                // A page that has already disappointed twice rarely answers on
                // the third ask either, and every ask is a full walk on the
                // user's own main thread. Back off rather than hammer it.
                backoff_ms = (backoff_ms * 2).min(MAX_LOCATOR_RETRY_MS);
                tokio::time::sleep_until(locator_retry_at(
                    tokio::time::Instant::now(),
                    scanned_at,
                    backoff_ms,
                    deadline,
                ))
                .await;
            }
        }

        "click" | "double_click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let click_count = extract_click_count(&params, method == "double_click")?;
            let expectation = PageExpectation::parse(params.get("waitFor"))?;
            let tab_lock = get_tab_lock(tab_id);
            // A menu, date picker or dialog the click opened is read inside the
            // call that opened it, under the same lock, instead of in the
            // caller's next turn. With nothing declared and nothing newly
            // visible the wait ends after a couple of frames, so an ordinary
            // click keeps paying almost nothing for it.
            let budget = reveal_budget(&params, DEFAULT_REVEAL_MS);
            let (webview, dispatch, revealed, media) = {
                let _lock = timings.measure("queue", tab_lock.lock()).await;
                let webview = get_embed_webview(app, tab_id)
                    .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
                let generation = get_current_generation(tab_id);
                ensure_current_ref(&ref_id, generation)?;
                timings
                    .measure("ready", wait_for_ready(&webview, 3000))
                    .await;
                let target = get_ref_frame_target(tab_id, &ref_id);
                let (dispatch, popup_url) =
                    click_ref_profiled(&webview, tab_id, &ref_id, click_count, timings).await?;
                // Chrome and Edge open a new-tab link themselves; only the
                // embedded browser leaves it to Anbo.
                if let Some(url) = popup_url.filter(|_| webview.embedded().is_ok()) {
                    let _ = app.emit(
                        BROWSER_POPUP_REQUEST_EVENT,
                        json!({ "sourceTabId": tab_id, "url": url }),
                    );
                }
                let revealed = timings
                    .measure(
                        "reveal",
                        run_reveal(
                            &webview,
                            tab_id,
                            target.as_ref(),
                            &ref_id,
                            budget,
                            RevealAfter::Click,
                        ),
                    )
                    .await;
                // A click that starts a navigation leaves nothing to report and
                // must not wait on a document that is going away.
                let media = if active_loading(tab_id) == Some(true)
                    || active_pending_url(tab_id).is_some()
                {
                    None
                } else {
                    timings
                        .measure("media", media_state(&webview, target.as_ref(), &ref_id))
                        .await
                };
                (webview, dispatch, revealed, media)
            };
            let mut result = json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "dispatch": dispatch
            });
            if click_count == 2 {
                result["clickCount"] = json!(2);
            }
            if let Some(media) = media {
                result["media"] = media;
            }
            if let Some(revealed) = revealed.filter(|revealed| {
                revealed["count"].as_u64().unwrap_or(0) > 0 || revealed.get("observed").is_some()
            }) {
                merge_reveal(&mut result, revealed);
            }
            if let Some(expectation) = expectation {
                result["postcondition"] = timings.measure("postcondition", wait_for_page_state(&webview, tab_id, &expectation)).await
                    .map_err(|(code, message)| (code, format!("click was dispatched, but {message}; inspect the page before retrying the click")))?;
            }
            Ok(result)
        }

        "focus" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let generation = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, generation)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            wait_for_actionable_ref(
                &webview,
                target.as_ref(),
                &ref_id,
                ActionabilityRequirement::Focus,
            )
            .await?;
            let script = deep_ref_expression(
                &ref_id,
                r#"
                    if (!el) {
                        return JSON.stringify({ ok: false, error: 'stale_ref' });
                    }
                    el.focus({ preventScroll: true });
                    const root = el.getRootNode && el.getRootNode();
                    return JSON.stringify({ ok: !!root && root.activeElement === el });"#,
            );
            let response = execute_ref_script(&webview, target.as_ref(), &script)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            let decoded: String = serde_json::from_str(&response).unwrap_or(response);
            let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
            if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err((
                    error_codes::CDP_FAILED.to_string(),
                    format!("element ref '{ref_id}' could not be focused"),
                ));
            }
            Ok(json!({ "tabId": tab_id, "ref": ref_id, "ok": true, "focused": true }))
        }

        "check" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let requested = params
                .get("checked")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let tab_lock = get_tab_lock(tab_id);
            let _lock = timings.measure("queue", tab_lock.lock()).await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let generation = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, generation)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let actionable = timings
                .measure(
                    "actionability",
                    wait_for_actionable_ref(
                        &webview,
                        target.as_ref(),
                        &ref_id,
                        ActionabilityRequirement::Check(requested),
                    ),
                )
                .await?;
            if actionable.tag != "input"
                || !matches!(actionable.input_type.as_str(), "checkbox" | "radio")
            {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("element ref '{ref_id}' is not a checkbox or radio"),
                ));
            }
            if actionable.input_type == "radio" && !requested {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "radio inputs cannot be unchecked directly".to_string(),
                ));
            }
            let before = actionable.checked.unwrap_or(false);
            if before != requested {
                if target.as_ref().is_some_and(|target| !target.is_main) {
                    timings
                        .measure(
                            "frameClick",
                            dom_click_ref(&webview, target.as_ref(), &ref_id, 1),
                        )
                        .await?;
                } else {
                    dispatch_mouse_click_profiled(&webview, &actionable, &ref_id, 1, timings)
                        .await?;
                }
            }
            let checked = timings
                .measure(
                    "verifyChecked",
                    wait_for_checked_state(&webview, target.as_ref(), &ref_id, requested),
                )
                .await?;
            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "checked": checked,
                "changed": before != requested
            }))
        }

        "drag" => {
            let tab_id = extract_tab_id(&params)?;
            let source_ref = extract_named_ref(&params, "sourceRef")?;
            let target_ref = extract_named_ref(&params, "targetRef")?;
            let source_position = extract_fraction_position(&params, "sourcePosition")?;
            let target_position = extract_fraction_position(&params, "targetPosition")?;
            // Two centres of the same element are the same point, so this used
            // to be refused outright. With a fraction on each end it is the
            // ordinary way to pan a chart or a map.
            if source_ref == target_ref && source_position == target_position {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "sourceRef and targetRef are the same element; give sourcePosition and targetPosition to drag within it".to_string(),
                ));
            }
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let generation = get_current_generation(tab_id);
            ensure_current_ref(&source_ref, generation)?;
            ensure_current_ref(&target_ref, generation)?;
            let source_target = get_ref_frame_target(tab_id, &source_ref);
            let destination_target = get_ref_frame_target(tab_id, &target_ref);
            if source_target != destination_target {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "drag source and target must be in the same document or frame".to_string(),
                ));
            }
            let source = wait_for_actionable_ref(
                &webview,
                source_target.as_ref(),
                &source_ref,
                ActionabilityRequirement::ClickAt(source_position),
            )
            .await?;
            let dispatch = if source.draggable
                || source_target.as_ref().is_some_and(|target| !target.is_main)
            {
                wait_for_actionable_ref(
                    &webview,
                    destination_target.as_ref(),
                    &target_ref,
                    ActionabilityRequirement::ClickAt(target_position),
                )
                .await?;
                dispatch_dom_drag(&webview, source_target.as_ref(), &source_ref, &target_ref)
                    .await?;
                if source.draggable {
                    "dom-html5"
                } else {
                    "dom-frame"
                }
            } else {
                if source.page_hidden || source.no_frames {
                    let reason = if source.page_hidden {
                        HIDDEN_TAB
                    } else {
                        UNDRAWN_TAB
                    };
                    return Err((
                        error_codes::INPUT_NOT_READY.to_string(),
                        format!("{reason} No input was sent."),
                    ));
                }
                let pair = wait_for_drag_pair(
                    &webview,
                    &source_ref,
                    &target_ref,
                    (source_position, target_position),
                )
                .await?;
                dispatch_mouse_drag(
                    &webview,
                    pair,
                    &source_ref,
                    &target_ref,
                    (source_position, target_position),
                )
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
                "devtools"
            };
            Ok(json!({
                "tabId": tab_id,
                "sourceRef": source_ref,
                "targetRef": target_ref,
                "ok": true,
                "dispatch": dispatch
            }))
        }

        // Several fields, one call: each runs the same type, check or select path
        // as its single-target tool, in order, so every guard those tools apply
        // still applies. Measured on a five-field form the agent spent one turn
        // per field; the comparison filled the form in a single turn.
        "fill_form" => {
            let tab_id = extract_tab_id(&params)?;
            let fields = params
                .get("fields")
                .and_then(Value::as_array)
                .filter(|fields| !fields.is_empty())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "fields must be a non-empty array".to_string(),
                    )
                })?;
            if fields.len() > MAX_FORM_FIELDS {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!(
                        "fields holds {} entries; at most {MAX_FORM_FIELDS} per call",
                        fields.len()
                    ),
                ));
            }
            let mut done: Vec<Value> = Vec::new();
            for (index, field) in fields.iter().enumerate() {
                let number = index + 1;
                let (method, mut field_params) = form_field_action(field, tab_id, number)?;
                let result = Box::pin(handle_action_inner(
                    app,
                    method,
                    field_params.take(),
                    timings,
                    caller,
                ))
                .await;
                match result {
                    Ok(value) => done.push(json!({
                        "field": number,
                        "action": method,
                        "ref": value.get("ref").cloned().unwrap_or(Value::Null),
                        "ok": true
                    })),
                    Err((code, message)) => {
                        let filled = if done.is_empty() {
                            "none".to_string()
                        } else {
                            done.iter()
                                .filter_map(|entry| entry["field"].as_u64())
                                .map(|n| n.to_string())
                                .collect::<Vec<_>>()
                                .join(", ")
                        };
                        return Err((
                            code,
                            format!(
                                "field {number} of {} ({method}) failed: {message}; fields done before it: {filled}",
                                fields.len()
                            ),
                        ));
                    }
                }
            }
            Ok(json!({
                "tabId": tab_id,
                "ok": true,
                "filled": done.len(),
                "fields": done
            }))
        }

        "type_text" | "type" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let text = params.get("text").and_then(|v| v.as_str()).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'text' parameter".to_string(),
                )
            })?;
            ensure_bounded(text, MAX_INPUT_TEXT_BYTES, "text")?;
            let (submit, submit_expectation) = type_submit(&params)?;
            // Suggestions are not worth waiting for when the field is submitted.
            let budget = if submit {
                0
            } else {
                reveal_budget(&params, DEFAULT_REVEAL_MS)
            };
            let append = params
                .get("append")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // Canvas/terminal/remote-desktop inputs capture keystrokes then clear the field; verifyValue:false
            // accepts a dispatched-but-not-retained value instead of reporting it as input_mismatch.
            let verify_value = params
                .get("verifyValue")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            // `force` (alias skipActionability) skips the viewport/hit-test gate for canvas,
            // terminal, or remote-desktop inputs whose real field is intentionally off-viewport
            // or covered. fillValue's own guard still requires a rendered, enabled, editable
            // element, so this skips actionability — not safety.
            let force = params
                .get("force")
                .and_then(|v| v.as_bool())
                .or_else(|| params.get("skipActionability").and_then(|v| v.as_bool()))
                .unwrap_or(false);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = timings.measure("queue", tab_lock.lock()).await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, cur_gen)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    {VISIBILITY_JS}
                    {REVEAL_BASELINE_JS}
                    {VALUE_ACTION_JS}
                    return JSON.stringify(fillValue(el, refRegistry, refId, {}, {}, {}, {}));"#,
                    serde_json::to_string(text).unwrap(),
                    append,
                    verify_value,
                    budget > 0
                ),
            );

            let parsed = if force {
                // Run the value action directly, skipping the actionability wait. Same result
                // shape as wait_for_value_action; fillValue still guards rendered/enabled/editable.
                let frame_id = target
                    .as_ref()
                    .filter(|target| !target.is_main)
                    .map(|target| target.frame_id.as_str());
                let response = timings
                    .measure(
                        "valueAction",
                        ref_context::execute_awaited(&webview, frame_id, &js),
                    )
                    .await
                    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
                let decoded: String = serde_json::from_str(&response).unwrap_or(response);
                serde_json::from_str(&decoded).unwrap_or_default()
            } else {
                timings
                    .measure(
                        "valueAction",
                        wait_for_value_action(
                            &webview,
                            target.as_ref(),
                            &ref_id,
                            ActionabilityRequirement::Editable,
                            &js,
                        ),
                    )
                    .await?
            };
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                // valueVerified stays true unless the field was dispatched but did not keep the value
                // (only possible with verifyValue:false); the caller then knows to confirm by screenshot.
                let value_verified =
                    parsed.get("valueRetained").and_then(Value::as_bool) != Some(false);
                let mut result = json!({ "tabId": tab_id, "ref": ref_id, "ok": true, "valueVerified": value_verified, "dispatched": true });
                // A field the page opens a list under is worth a bounded wait:
                // the suggestions arrive in this reply instead of costing the
                // caller a round trip to discover that they arrived at all.
                if budget > 0 && parsed.get("popup").and_then(Value::as_bool) == Some(true) {
                    let before = parsed.get("before");
                    let mut revealed = timings
                        .measure(
                            "reveal",
                            run_reveal(
                                &webview,
                                tab_id,
                                target.as_ref(),
                                &ref_id,
                                budget,
                                RevealAfter::Fill {
                                    before,
                                    query: text,
                                },
                            ),
                        )
                        .await;
                    // Nothing opened, and this is a field things open under.
                    // Some autocompletes only listen for real keystrokes
                    // (Wikipedia's is one), so the value goes in once more
                    // through the input pipeline before the caller is told the
                    // page stayed shut.
                    let opened = |value: &Option<Value>| matches!(value, Some(value) if value["count"].as_u64().unwrap_or(0) > 0);
                    if value_verified
                        && !append
                        && revealed.is_some()
                        && !opened(&revealed)
                        && timings.measure("nativeRetype", native_retype(&webview, target.as_ref(), &ref_id, text)).await
                            .map_err(|_| (error_codes::INPUT_NOT_READY.into(), "value was dispatched; native autocomplete input stopped after target/focus/value drift or a transport error; inspect before retrying".into()))?
                    {
                        result["nativeRetype"] = json!(true);
                        if let Some(retried) = timings.measure("fallbackReveal", run_reveal(
                            &webview,
                            tab_id,
                            target.as_ref(),
                            &ref_id,
                            budget,
                            RevealAfter::Fill { before, query: text },
                        ))
                        .await
                        {
                            if retried["count"].as_u64().unwrap_or(0) > 0 {
                                revealed = Some(retried);
                            }
                        }
                    }
                    if let Some(revealed) = revealed {
                        merge_reveal(&mut result, revealed);
                    }
                }
                let fill_expectation = if submit {
                    None
                } else {
                    PageExpectation::parse(submit_expectation.as_ref())?
                };
                if let Some(expectation) = fill_expectation {
                    // Waits release the tab lock between polls, like click's.
                    drop(_lock);
                    result["postcondition"] = timings
                        .measure("postcondition", wait_for_page_state(&webview, tab_id, &expectation))
                        .await
                        .map_err(|(code, message)| {
                            (code, format!("the text was typed, but {message}; inspect the page before typing again"))
                        })?;
                    return Ok(result);
                }
                if submit {
                    // Remember the result titles on screen before the search, so
                    // the landing's hints can tell new results from the page the
                    // search replaces. Best effort: a slow page just goes without.
                    let _ = tokio::time::timeout(
                        Duration::from_millis(300),
                        ref_context::execute_main(&webview, PRE_SUBMIT_TITLES_JS),
                    )
                    .await;
                    // browser_press takes the same tab lock.
                    drop(_lock);
                    let mut press = json!({ "tabId": tab_id, "ref": ref_id, "key": "Enter" });
                    // Refuse to submit a field the page replaced or rewrote
                    // between the fill and the key. An appended value is not
                    // known here, so only the ref identity guards it.
                    if !append && value_verified {
                        press["expectedValue"] = json!(text);
                    }
                    if let Some(expectation) = submit_expectation {
                        press["waitFor"] = expectation;
                    }
                    let pressed =
                        Box::pin(handle_action_inner(app, "press", press, timings, caller))
                            .await
                            .map_err(|(code, message)| {
                                (
                                    code,
                                    format!(
                                        "the text was typed, but Enter did not complete: {message}"
                                    ),
                                )
                            })?;
                    result["submitted"] = json!(true);
                    for key in [
                        "postcondition",
                        "submissionObserved",
                        "navigationObserved",
                        "observationPerformed",
                        "observationWindowMs",
                    ] {
                        if let Some(value) = pressed.get(key) {
                            result[key] = value.clone();
                        }
                    }
                }
                Ok(result)
            } else {
                if parsed["error"] == "input_not_ready" {
                    return Err((
                        error_codes::INPUT_NOT_READY.to_string(),
                        "input changed before filling; no value was written".into(),
                    ));
                }
                if parsed.get("error").and_then(Value::as_str) == Some("input_mismatch") {
                    return Err((error_codes::INPUT_MISMATCH.to_string(), "input was dispatched (input/change fired) but the field did not retain the value; for a canvas, terminal, or otherwise managed input retry with verifyValue:false and confirm via screenshot".to_string()));
                }
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!("element ref '{ref_id}' is stale or no longer valid"),
                ))
            }
        }

        "upload_files" | "upload" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let workspace_root = resolve_tab_workspace(tab_id, &params)?;
            let files = resolve_upload_files(&workspace_root, &params)?;
            let total_size = files.iter().try_fold(0_u64, |total, file| {
                fs::metadata(file)
                    .map(|metadata| total.saturating_add(metadata.len()))
                    .map_err(|error| {
                        (
                            error_codes::INVALID_REQUEST.to_string(),
                            format!("upload file became unavailable: {error}"),
                        )
                    })
            })?;

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            wait_for_ready(&webview, 5000).await;
            let current_generation = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, current_generation)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let preflight = inspect_file_input(&webview, target.as_ref(), &ref_id).await?;
            if preflight.get("disabled").and_then(Value::as_bool) == Some(true) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("file input ref '{ref_id}' is disabled"),
                ));
            }
            if files.len() > 1 && preflight.get("multiple").and_then(Value::as_bool) != Some(true) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("file input ref '{ref_id}' does not accept multiple files"),
                ));
            }

            set_file_input_files(&webview, target.as_ref(), &ref_id, &files)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            let selected = inspect_file_input(&webview, target.as_ref(), &ref_id).await?;
            let selected_names = selected
                .get("files")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if selected_names.len() != files.len() {
                return Err((
                    error_codes::CDP_FAILED.to_string(),
                    format!(
                        "browser selected {} of {} requested files",
                        selected_names.len(),
                        files.len()
                    ),
                ));
            }

            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "fileCount": files.len(),
                "totalSize": total_size,
                "files": selected_names,
                "multiple": preflight.get("multiple").cloned().unwrap_or(Value::Bool(false)),
                "accept": preflight.get("accept").cloned().unwrap_or(Value::String(String::new())),
                "workspace": super::output_path::display(&workspace_root)
            }))
        }

        "press_key" | "press" => {
            let tab_id = extract_tab_id(&params)?;
            let key = params.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'key' parameter".to_string(),
                )
            })?;
            ensure_bounded(key, MAX_KEY_BYTES, "key")?;
            let action = extract_key_action(&params)?;
            let modifiers = extract_key_modifiers(&params)?;
            let expectation = PageExpectation::parse(params.get("waitFor"))?;
            if action != "press"
                && (expectation.is_some()
                    || params
                        .get("observationTimeout")
                        .is_some_and(|value| value.as_u64() != Some(0)))
            {
                return Err((
                    error_codes::INVALID_REQUEST.into(),
                    "waitFor and Enter observation require keyAction press".into(),
                ));
            }
            let input_ref = if params.get("ref").is_some() {
                Some(extract_ref(&params)?)
            } else {
                None
            };
            let expected_value = params
                .get("expectedValue")
                .map(|value| {
                    let value = value.as_str().ok_or_else(|| {
                        (
                            error_codes::INVALID_REQUEST.to_string(),
                            "expectedValue must be a string".to_string(),
                        )
                    })?;
                    ensure_bounded(value, MAX_INPUT_TEXT_BYTES, "expectedValue")?;
                    Ok::<_, (String, String)>(value)
                })
                .transpose()?;
            if expected_value.is_some() && input_ref.is_none() {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "expectedValue requires a current input ref".to_string(),
                ));
            }
            let observation_timeout_ms = params
                .get("observationTimeout")
                .and_then(as_count)
                .unwrap_or(SUBMISSION_OBSERVATION_MS)
                .min(10_000);
            let should_observe = action == "press"
                && modifiers == 0
                && key == "Enter"
                && observation_timeout_ms > 0
                && expectation.is_none();

            let tab_lock = get_tab_lock(tab_id);
            let mut focused_ancestor: Option<Value> = None;
            let (webview, before_url, before_navigation_generation, observation_id) = {
                let _lock = timings.measure("queue", tab_lock.lock()).await;
                let webview = get_embed_webview(app, tab_id)
                    .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
                if let Some(ref_id) = input_ref.as_deref() {
                    ensure_current_ref(ref_id, get_current_generation(tab_id))?;
                }
                let before_url = if should_observe {
                    timings
                        .measure("beforeUrl", current_url(&webview))
                        .await
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let before_navigation_generation =
                    active_navigation_generation(tab_id).unwrap_or(0);
                let observation_id = SUBMISSION_OBSERVATION_ID.fetch_add(1, Ordering::Relaxed);
                if should_observe {
                    let script = submission_observer_script(observation_id, observation_timeout_ms);
                    let _ = timings
                        .measure(
                            "observerInstall",
                            execute_script_with_timeout(&webview, &script, SCRIPT_POLL_TIMEOUT),
                        )
                        .await;
                }
                let dispatched = async {
                    timings.measure("keySettle", ref_context::settle_before_keys(&webview)).await;
                    // Focus emulation can run page focus handlers. Prepare it before
                    // checking the target, immediately ahead of native key dispatch.
                    timings.measure("focusEmulation", ref_context::ensure_focus(&webview)).await.map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
                    if let Some(ref_id) = input_ref.as_deref() {
                        let generation = get_current_generation(tab_id);
                        ensure_current_ref(ref_id, generation)?;
                        let target = get_ref_frame_target(tab_id, ref_id);
                        let script = deep_ref_expression(ref_id, &input_guard_body(expected_value));
                        let response = timings.measure("inputGuard", execute_ref_script(&webview, target.as_ref(), &script))
                            .await.map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
                        let decoded: String = serde_json::from_str(&response).unwrap_or(response);
                        let guard: Value = serde_json::from_str(&decoded).unwrap_or_default();
                        if guard.get("ok").and_then(Value::as_bool) != Some(true) {
                            let code = match guard.get("error").and_then(Value::as_str) {
                                Some("stale_ref") => error_codes::STALE_REF,
                                Some("input_mismatch") => error_codes::INPUT_MISMATCH,
                                _ => error_codes::INPUT_NOT_READY,
                            };
                            return Err((code.to_string(), "key was not dispatched: the input changed or could not be focused; inspect it before retrying".to_string()));
                        }
                        focused_ancestor = guard.get("focusedAncestor").filter(|value| value.is_object()).cloned();
                    }
                    dispatch_key(&webview, key, action, modifiers, timings).await.map_err(|error| (error_codes::CDP_FAILED.to_string(), error))
                }.await;
                if let Err(error) = dispatched {
                    if should_observe {
                        cleanup_submission_observer(&webview, observation_id).await;
                    }
                    return Err(error);
                }
                (
                    webview,
                    before_url,
                    before_navigation_generation,
                    observation_id,
                )
            };
            let observation = if should_observe {
                timings
                    .measure(
                        "submitObservation",
                        observe_submission(
                            &webview,
                            tab_id,
                            &before_url,
                            before_navigation_generation,
                            observation_id,
                            observation_timeout_ms,
                        ),
                    )
                    .await
            } else {
                SubmissionObservation::default()
            };
            // A submit that navigated is only half done. The reply used to
            // come back with loading=true, and every measured agent then added
            // a browser_wait before reading anything -- two turns per search
            // on the non-Claude series. Settle the document here, bounded, so
            // the page block (and its navigation hints) lands ready.
            if should_observe && observation.navigation && expectation.is_none() {
                let deadline = tokio::time::Instant::now() + Duration::from_millis(4_000);
                while tokio::time::Instant::now() < deadline {
                    let ready = execute_script_with_timeout(
                        &webview,
                        "document.readyState",
                        Duration::from_millis(300),
                    )
                    .await
                    .unwrap_or_default();
                    if ready.trim_matches('"') == "complete" {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }

            let mut result = json!({
                "tabId": tab_id,
                "key": key,
                "action": action,
                "modifiers": modifier_names(modifiers),
                "ok": true,
                "dispatch": "devtools",
            });
            // The key went to the focusable element around the target, not the
            // target itself; say which, so the caller never has to guess.
            if let Some(ancestor) = focused_ancestor {
                result["focusedAncestor"] = ancestor;
            }
            // A text field is not a player, and a page mid-navigation has no
            // state worth waiting on, so only an aimed key on a settled page asks.
            if let Some(ref_id) = input_ref.as_deref().filter(|_| {
                expected_value.is_none()
                    && !observation.navigation
                    && active_loading(tab_id) != Some(true)
            }) {
                let target = get_ref_frame_target(tab_id, ref_id);
                if let Some(media) = timings
                    .measure("media", media_state(&webview, target.as_ref(), ref_id))
                    .await
                {
                    result["media"] = media;
                }
            } else if input_ref.is_none()
                && player_key(key, action, modifiers)
                && !observation.navigation
                && active_loading(tab_id) != Some(true)
            {
                // A player shortcut is usually pressed at the page, not at a
                // ref: YouTube's 'k' then cost a get_property to learn it paused.
                if let Some(media) = timings.measure("media", page_media_state(&webview)).await {
                    result["media"] = media;
                }
            }
            if let Some(expectation) = expectation {
                // The caller asked a question and gets its answer. Repeating the
                // observation flags beside it invited the reading that a
                // successful submit had failed -- three of them said false while
                // the postcondition said matched -- and re-submitting a form is
                // not a harmless way to find out.
                result["postcondition"] = timings.measure("postcondition", wait_for_page_state(&webview, tab_id, &expectation)).await
                    .map_err(|(code, message)| (code, format!("key was dispatched, but {message}; inspect the page before resubmitting")))?;
            } else {
                result["submissionObserved"] = json!(observation.submit_event);
                result["navigationObserved"] = json!(observation.navigation);
                result["observationPerformed"] = json!(should_observe);
                result["observationWindowMs"] = json!(if should_observe {
                    observation_timeout_ms
                } else {
                    0
                });
            }
            Ok(result)
        }

        "key" => {
            let tab_id = extract_tab_id(&params)?;
            let key = params.get("key").and_then(Value::as_str).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'key' parameter".to_string(),
                )
            })?;
            ensure_bounded(key, MAX_KEY_BYTES, "key")?;
            let action = params
                .get("keyAction")
                .and_then(Value::as_str)
                .unwrap_or("press");
            if !matches!(action, "press" | "down" | "up") {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("unsupported keyboard action '{action}'"),
                ));
            }
            let modifiers = extract_key_modifiers(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            dispatch_key_action(&webview, key, action, modifiers)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            Ok(json!({
                "tabId": tab_id,
                "key": key,
                "action": action,
                "modifiers": modifier_names(modifiers),
                "ok": true,
                "dispatch": "devtools"
            }))
        }

        "scroll" => {
            let tab_id = extract_tab_id(&params)?;
            let x = params.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = params.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let js = format!("window.scrollBy({x}, {y}); JSON.stringify({{ ok: true }});");
            execute_script(&webview, &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            Ok(json!({ "tabId": tab_id, "x": x, "y": y, "ok": true }))
        }

        "wait" => {
            let tab_id = extract_tab_id(&params)?;
            let wait_for = params
                .get("waitFor")
                .map(|wait_for| with_outer_timeout(wait_for, params.get("timeout")));
            if let Some(expectation) = PageExpectation::parse(wait_for.as_ref())? {
                if ["condition", "text", "url", "ref", "state", "loadState"]
                    .iter()
                    .any(|key| params.get(*key).is_some())
                {
                    return Err((error_codes::INVALID_REQUEST.to_string(), "waitFor cannot be combined with legacy wait conditions; put the condition inside waitFor".to_string()));
                }
                let webview = get_embed_webview(app, tab_id)
                    .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
                let mut result = timings
                    .measure(
                        "postcondition",
                        wait_for_page_state(&webview, tab_id, &expectation),
                    )
                    .await?;
                result["tabId"] = json!(tab_id);
                result["found"] = json!(true);
                return Ok(result);
            }
            let condition = extract_wait_condition(&params)?;
            let timeout_ms = params
                .get("timeout")
                .and_then(as_count)
                .unwrap_or(10000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);

            let tab_lock = get_tab_lock(tab_id);
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            return timings
                .measure("condition", async {
                    loop {
                        let remaining =
                            deadline.saturating_duration_since(tokio::time::Instant::now());
                        let poll_timeout = remaining.min(Duration::from_millis(750));
                        let matched = {
                            let _lock = tab_lock.lock().await;
                            wait_condition_matches(
                                &webview,
                                tab_id,
                                &condition,
                                deadline,
                                poll_timeout,
                            )
                            .await?
                        };
                        if matched {
                            return Ok(json!({
                                "tabId": tab_id,
                                "found": true,
                                "condition": condition.kind(),
                                "state": condition.state_label()
                            }));
                        }

                        if tokio::time::Instant::now() >= deadline {
                            let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
                            return Err((
                                error_codes::TIMEOUT.to_string(),
                                format!(
                                    "timed out waiting for {} '{}' after {timeout_ms}ms at {url}",
                                    condition.kind(),
                                    condition.state_label()
                                ),
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                })
                .await;
        }

        "dialog" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let action = params
                .get("dialogAction")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "browser_dialog requires an action".to_string(),
                    )
                })?;
            if !matches!(action, "accept" | "dismiss") {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("unsupported dialog action '{action}'"),
                ));
            }
            let prompt_text = params
                .get("promptText")
                .and_then(Value::as_str)
                .unwrap_or("");
            ensure_bounded(prompt_text, MAX_LOCATOR_VALUE_BYTES, "promptText")?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let generation = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, generation)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let actionable = wait_for_actionable_ref(
                &webview,
                target.as_ref(),
                &ref_id,
                ActionabilityRequirement::Click,
            )
            .await?;
            install_dialog_capture(&webview, target.as_ref(), action == "accept", prompt_text)
                .await?;
            let trigger_result = if target.as_ref().is_some_and(|target| !target.is_main) {
                dom_click_ref(&webview, target.as_ref(), &ref_id, 1)
                    .await
                    .map(|_| "dom-frame")
            } else {
                dispatch_mouse_click(&webview, &actionable, &ref_id, 1)
                    .await
                    .map(|_| "devtools")
            };
            let dialog_result = take_dialog_capture(&webview, target.as_ref()).await;
            let dispatch = trigger_result?;
            let dialog = dialog_result?;
            let opened = dialog.get("kind").and_then(Value::as_str).is_some();
            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "action": action,
                "ok": opened,
                "clickDispatched": true,
                "dialogOpened": opened,
                "dispatch": dispatch,
                "kind": dialog.get("kind").cloned().unwrap_or(Value::Null),
                "message": dialog.get("message").cloned().unwrap_or(Value::Null),
                "defaultText": dialog.get("defaultText").cloned().unwrap_or(Value::Null),
                "promptTextSet": opened && action == "accept" && !prompt_text.is_empty()
            }))
        }

        "skills_list" | "skills_read" => {
            // Purely a read of the workspace's own files, so this needs neither
            // a tab nor the UI: it answers here rather than crossing to the
            // frontend the way agent and terminal tools must.
            let workspace = params
                .get("workspace")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "skills tools require the agent's own workspace root".to_string(),
                    )
                })?;
            let root = PathBuf::from(workspace);
            if !root.is_dir() {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("workspace is not a directory: {workspace}"),
                ));
            }
            if method == "skills_list" {
                let skills = crate::modules::skills::list_skills(&root)
                    .map_err(|e| (error_codes::INTERNAL.to_string(), e))?;
                return Ok(json!({ "workspace": workspace, "skills": skills }));
            }
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let section = params.get("section").and_then(Value::as_str);
            let skill = crate::modules::skills::read_skill(&root, name, section)
                .map_err(|e| (error_codes::INVALID_REQUEST.to_string(), e))?;
            Ok(serde_json::to_value(skill).unwrap_or_default())
        }

        "emulate" => {
            let tab_id = extract_tab_id(&params)?;
            let width = params.get("width").and_then(as_count).unwrap_or(0);
            let height = params.get("height").and_then(as_count).unwrap_or(0);
            let scale = params.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
            let mobile = params
                .get("mobile")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // An agent asking for a desktop viewport inside a narrow pane wants
            // the whole layout, not a crop, so it can pass a fit the same way
            // the tab UI does.
            let fit = params.get("fit").and_then(Value::as_f64).unwrap_or(1.0);
            if !(0.05..=1.0).contains(&fit) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "viewport fit is outside the supported range".to_string(),
                ));
            }
            if width > 10_000 || height > 10_000 {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "viewport is outside the supported range".to_string(),
                ));
            }
            if width > 0 && height == 0 {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "an emulated viewport needs a height".to_string(),
                ));
            }
            if !(0.1..=4.0).contains(&scale) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "viewport scale is outside the supported range".to_string(),
                ));
            }
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            super::registry::apply_viewport(
                &webview,
                width as u32,
                height as u32,
                scale,
                mobile,
                fit,
            )
            .await
            .map_err(|e| (error_codes::INTERNAL.to_string(), e))?;
            // Report what the page ended up with, not just what was asked
            // for: an override that silently failed to apply would otherwise
            // look identical to one that worked.
            let applied = call_devtools_protocol_method(
                &webview,
                "Page.getLayoutMetrics",
                "{}",
                SCRIPT_POLL_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|metrics| metrics.get("cssVisualViewport").cloned());
            Ok(json!({
                "tabId": tab_id,
                "emulating": width > 0,
                "width": width,
                "height": height,
                "scale": scale,
                "mobile": mobile,
                "fit": fit,
                "applied": applied,
            }))
        }

        "screenshot" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let options = super::artifacts::Options::parse(&params)
                .map_err(|e| (error_codes::INVALID_REQUEST.to_string(), e))?;
            let actual = active_local_root(tab_id).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "screenshot requires the tab's local workspace".into(),
                )
            })?;
            let requested = options.workspace.clone();
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let encoding = super::cdp::ScreenshotEncoding::parse(
                params.get("format").and_then(Value::as_str),
                params.get("quality").and_then(as_count),
            )
            .map_err(|error| (error_codes::INVALID_REQUEST.to_string(), error))?;
            let extension = if encoding.format == "jpeg" {
                "jpg"
            } else {
                encoding.format
            };
            let control = super::activity::current_control_id().ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "screenshot requires an active browser control session".into(),
                )
            })?;
            let root = tauri::async_runtime::spawn_blocking(move || {
                super::artifacts::prepare(&actual, requested.as_deref())
            })
            .await
            .map_err(|e| (error_codes::INTERNAL.to_string(), e.to_string()))?
            .map_err(|e| (error_codes::INVALID_REQUEST.to_string(), e))?;
            let source_url = read_url(&webview, Duration::from_millis(250))
                .await
                .unwrap_or_default();
            let (fallback, origin) = super::artifacts::source(&source_url);
            let _design_layer = super::design::hide_for_capture(&webview).await;
            let response = capture_screenshot(&webview, encoding)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let bytes = decode_screenshot_response(&response)
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let capture = super::artifacts::Capture {
                root,
                control,
                options,
                fallback,
                origin,
                timestamp: ts.min(u128::from(u64::MAX)) as u64,
                tab_id,
                actor: serde_json::to_value(caller).unwrap_or(Value::Null),
                extension,
                format: encoding.format,
            };
            let (mut result, bytes) = tauri::async_runtime::spawn_blocking(move || {
                super::artifacts::save(capture, &bytes).map(|result| (result, bytes))
            })
            .await
            .map_err(|e| (error_codes::INTERNAL.to_string(), e.to_string()))?
            .map_err(|e| (error_codes::INTERNAL.to_string(), e))?;
            result["tabId"] = json!(tab_id);
            result["size"] = json!(bytes.len());
            result["format"] = json!(encoding.format);
            result["quality"] = json!(encoding.quality);
            // The agent asked to see the page; handing back only a path made
            // it spend another call reading the file. Measured: three extra
            // reads in one TradingView task. The image rides along in the
            // reply unless it is too large to be worth a turn of context.
            let inline = params
                .get("inline")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if inline && bytes.len() <= INLINE_SCREENSHOT_LIMIT {
                use base64::Engine as _;
                result["inlineImage"] = json!({
                    "mimeType": format!("image/{}", encoding.format),
                    "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
                });
            } else if inline {
                result["inlineSkipped"] = json!("larger than 600 KB; read the file instead");
            }
            Ok(result)
        }

        "download" => {
            let tab_id = extract_tab_id(&params)?;
            if crate::modules::browser_external::get_target(tab_id).is_some() {
                return Err((error_codes::INVALID_REQUEST.into(), "Managed downloads into an Anbo workspace are not supported by the external browser bridge yet. No click was sent. Use the browser's normal download UI.".into()));
            }
            let ref_id = extract_ref(&params)?;
            let workspace_root = resolve_tab_workspace(tab_id, &params)?;
            let preferred_file_name = params
                .get("fileName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(file_name) = preferred_file_name {
                ensure_bounded(file_name, 255, "fileName")?;
            }
            let timeout_ms = params
                .get("timeout")
                .and_then(as_count)
                .unwrap_or(10_000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);

            let tab_lock = get_tab_lock(tab_id);
            let lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            wait_for_ready(&webview, 5000).await;
            ensure_current_ref(&ref_id, get_current_generation(tab_id))?;
            let record = download::arm_download(tab_id, &workspace_root, preferred_file_name)
                .map_err(|error| (error_codes::INVALID_REQUEST.to_string(), error))?;
            let dispatch = match click_ref(&webview, tab_id, &ref_id).await {
                Ok(dispatch) => dispatch,
                Err(error) => {
                    download::fail_download(&record, error.1.clone());
                    return Err(error);
                }
            };
            drop(lock);

            let (status, timed_out) = download::wait_for_status_change(
                &record,
                "armed",
                Duration::from_millis(timeout_ms),
            )
            .await
            .map_err(|error| (error_codes::INTERNAL.to_string(), error))?;
            if timed_out && status.status == "armed" {
                download::fail_download(
                    &record,
                    format!("no download started within {timeout_ms}ms"),
                );
                return Err((
                    error_codes::TIMEOUT.to_string(),
                    format!("no download started from ref '{ref_id}' within {timeout_ms}ms"),
                ));
            }
            let mut result = serde_json::to_value(status).unwrap_or_default();
            result["ref"] = Value::String(ref_id);
            result["dispatch"] = Value::String(dispatch.to_string());
            result["timedOut"] = Value::Bool(timed_out);
            Ok(result)
        }

        "download_status" => {
            let workspace_root = resolve_requested_workspace(&params)?;
            let download_id = extract_download_id(&params)?;
            let record = download::find_download(download_id, &workspace_root)
                .map_err(|error| (error_codes::INVALID_REQUEST.to_string(), error))?;
            serde_json::to_value(
                download::snapshot(&record)
                    .map_err(|error| (error_codes::INTERNAL.to_string(), error))?,
            )
            .map_err(|error| (error_codes::INTERNAL.to_string(), error.to_string()))
        }

        "download_wait" => {
            let workspace_root = resolve_requested_workspace(&params)?;
            let download_id = extract_download_id(&params)?;
            let timeout_ms = params
                .get("timeout")
                .and_then(as_count)
                .unwrap_or(30_000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);
            let record = download::find_download(download_id, &workspace_root)
                .map_err(|error| (error_codes::INVALID_REQUEST.to_string(), error))?;
            let before = download::snapshot(&record)
                .map_err(|error| (error_codes::INTERNAL.to_string(), error))?;
            let (status, timed_out) =
                if matches!(before.status.as_str(), "completed" | "failed" | "cancelled") {
                    (before, false)
                } else {
                    download::wait_for_status_change(
                        &record,
                        &before.status,
                        Duration::from_millis(timeout_ms),
                    )
                    .await
                    .map_err(|error| (error_codes::INTERNAL.to_string(), error))?
                };
            let mut result = serde_json::to_value(status).unwrap_or_default();
            result["timedOut"] = Value::Bool(timed_out);
            Ok(result)
        }

        "select_option" | "select" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "missing 'value' parameter".to_string(),
                    )
                })?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, cur_gen)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let value_json = serde_json::to_string(value).unwrap();
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    {VISIBILITY_JS}
                    {VALUE_ACTION_JS}
                    return JSON.stringify(selectValue(el, refRegistry, refId, {value_json}));"#
                ),
            );
            let parsed = wait_for_value_action(
                &webview,
                target.as_ref(),
                &ref_id,
                ActionabilityRequirement::Select,
                &js,
            )
            .await?;
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                Ok(json!({
                    "tabId": tab_id,
                    "ref": ref_id,
                    "value": parsed.get("value").cloned().unwrap_or(Value::Null),
                    "label": parsed.get("label").cloned().unwrap_or(Value::Null),
                    "valueVerified": true,
                    "ok": true
                }))
            } else {
                let err = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stale_ref");
                if err == "input_not_ready" {
                    return Err((
                        error_codes::INPUT_NOT_READY.to_string(),
                        "select or option changed before selection; no value was written".into(),
                    ));
                }
                if err == "input_mismatch" {
                    return Err((
                        error_codes::INPUT_MISMATCH.to_string(),
                        "select did not retain the requested option; inspect it before retrying"
                            .into(),
                    ));
                }
                if err == "stale_ref" {
                    Err((
                        error_codes::STALE_REF.to_string(),
                        format!("element ref '{ref_id}' is stale or no longer valid"),
                    ))
                } else {
                    Err((
                        error_codes::INVALID_REQUEST.to_string(),
                        format!("select_option on ref '{ref_id}' failed: {err}"),
                    ))
                }
            }
        }

        "hover" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let position = extract_hover_position(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, cur_gen)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let actionable = wait_for_actionable_ref(
                &webview,
                target.as_ref(),
                &ref_id,
                ActionabilityRequirement::Hover(position),
            )
            .await?;
            if actionable.page_hidden || actionable.no_frames {
                let _ = execute_ref_script(
                    &webview,
                    target.as_ref(),
                    "globalThis.__anboHoverObservation?.stop()",
                )
                .await;
                let reason = if actionable.page_hidden {
                    HIDDEN_TAB
                } else {
                    UNDRAWN_TAB
                };
                return Err((
                    error_codes::INPUT_NOT_READY.to_string(),
                    format!("{reason} No input was sent."),
                ));
            }
            let main_document = target.as_ref().is_none_or(|target| target.is_main);
            if main_document {
                if let Err(error) = dispatch_mouse_move(&webview, actionable.x, actionable.y).await
                {
                    let _ = execute_ref_script(
                        &webview,
                        target.as_ref(),
                        "globalThis.__anboHoverObservation?.stop()",
                    )
                    .await;
                    return Err((error_codes::CDP_FAILED.to_string(), error));
                }
            }
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if ({main_document}) {{
                        const observed = globalThis.__anboHoverObservation?.take(refId);
                        if (observed) return JSON.stringify(observed);
                    }}
                    if (!el) {{
                        return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    }}
                    if (!{main_document}) {{
                    const x = {x};
                    const y = {y};
                    const opts = {{ bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }};
                    el.dispatchEvent(new MouseEvent('mouseover', opts));
                    el.dispatchEvent(new MouseEvent('mousemove', opts));
                    el.dispatchEvent(new MouseEvent('mouseenter', {{ bubbles: false, cancelable: false, clientX: x, clientY: y, view: window }}));
                    }}
                    return JSON.stringify({{ ok: true, cssHover: el.matches(':hover') }});"#,
                    x = actionable.x,
                    y = actionable.y,
                ),
            );
            let res = execute_ref_script(&webview, target.as_ref(), &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                let css_hover = parsed.get("cssHover").and_then(Value::as_bool) == Some(true);
                let event_verified =
                    parsed.get("eventVerified").and_then(Value::as_bool) == Some(true);
                if main_document && !css_hover && !event_verified {
                    return Err((
                        error_codes::CDP_FAILED.to_string(),
                        format!("hover did not activate the CSS pseudo-state for ref '{ref_id}'"),
                    ));
                }
                Ok(json!({
                    "tabId": tab_id,
                    "ref": ref_id,
                    "ok": true,
                    "cssHover": css_hover,
                    "eventVerified": event_verified,
                    "connected": parsed.get("connected").cloned().unwrap_or(json!(true)),
                    "dispatch": if main_document { "devtools" } else { "dom-frame" }
                }))
            } else {
                if matches!(
                    parsed["error"].as_str(),
                    Some("hover_intercepted" | "hover_not_observed")
                ) {
                    return Err((error_codes::CDP_FAILED.to_string(), format!(
                        "hover verification failed for ref '{ref_id}': {}; native movement was dispatched once; inspect the current target before retrying",
                        parsed["error"].as_str().unwrap_or_default()
                    )));
                }
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!("element ref '{ref_id}' is stale or no longer valid"),
                ))
            }
        }

        "scroll_to_element" | "scroll_into_view" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, cur_gen)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let js = deep_ref_expression(
                &ref_id,
                r#"
                    if (!el) {
                        return JSON.stringify({ ok: false, error: "stale_ref" });
                    }
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    const r = el.getBoundingClientRect();
                    return JSON.stringify({ ok: true, rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } });"#,
            );
            let res = execute_ref_script(&webview, target.as_ref(), &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                Ok(json!({
                    "tabId": tab_id,
                    "ref": ref_id,
                    "rect": parsed.get("rect").cloned().unwrap_or(Value::Null),
                    "ok": true
                }))
            } else {
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!("element ref '{ref_id}' is stale or no longer valid"),
                ))
            }
        }

        "get_text" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = if params.get("ref").is_some() || params.get("ref_id").is_some() {
                Some(extract_ref(&params)?)
            } else {
                None
            };
            let max_length = params
                .get("maxLength")
                .and_then(as_count)
                .unwrap_or(8000)
                .clamp(1, MAX_TEXT_OUTPUT_CHARS);
            // Climb N ancestors from the target before reading, so one call
            // returns the block (row, list, card, section) a found leaf sits in
            // instead of just the leaf -- browser_find hands back flat leaves
            // with no neighbourhood, so reading a multi-fact block otherwise
            // costs a probe per fact. Capped, and only meaningful with a target.
            let ancestors = Ancestors::parse(params.get("ancestors"))?.value();
            if ancestors == "row" && ref_id.is_none() {
                return Err((
                    error_codes::INVALID_REQUEST.into(),
                    "ancestors:'row' requires a ref or locator".into(),
                ));
            }
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            if let Some(ref_id) = ref_id.as_deref() {
                ensure_current_ref(ref_id, get_current_generation(tab_id))?;
            }
            let target = ref_id
                .as_deref()
                .and_then(|ref_id| get_ref_frame_target(tab_id, ref_id));
            let text_body = format!(
                r#"
                    if (!el) return JSON.stringify({{ ok: false, error: "no_body" }});
                    {VISIBILITY_JS}
                    {READABLE_TEXT_JS}
                    {ACCESSIBLE_NAME_JS}
                    {CONTEXT_BLOCK_JS}
                    const target = contextBlock(el, climbCount);
                    if (!target) return JSON.stringify({{ok:false,error:'context_not_found'}});
                    const readable = readableText(target);
                    const domText = readable.text;
                    const accessibleText = domText ? '' : accessibleName(target);
                    // Words drawn on screen but hidden from assistive technology
                    // read as nothing to both of those: Amazon marks its visible
                    // price aria-hidden. A rendered target still says what it shows.
                    const drawnText = domText || accessibleText.trim() || !isRenderedElement(target)
                        ? '' : String(target.innerText || '').replace(/\s+/g, ' ').trim();
                    const text = domText || accessibleText.trim() || drawnText;
                    const source = domText ? 'domText' : accessibleText.trim() ? 'accessibleName' : (text ? 'renderedText' : 'empty');
                    // A control that hides itself seconds later reads one way now
                    // and another way then, and an accessible name can hold a
                    // value the visible text has already moved past. Say which
                    // reading this is rather than leaving it to be noticed.
                    const sourceNote = source === 'accessibleName'
                        ? 'the element renders no text, so this is its accessible name, which can lag the value on screen'
                        : source === 'renderedText'
                          ? 'the page hides this text from assistive technology; this is what is drawn on screen'
                          : null;
                    const max = {max_length};
                    let truncated = readable.sourceTruncated;
                    let out = text;
                    if (text.length > max) {{ out = clipReadableText(text, max); truncated = true; }}
                    return JSON.stringify({{ ok: true, text: out, source: source, sourceNote: sourceNote, visible: isRenderedElement(target), truncated: truncated, totalLength: text.length, totalLengthIsLowerBound: readable.sourceTruncated }});"#
            );
            let js = if let Some(ref_id) = ref_id.as_deref() {
                deep_ref_expression(
                    ref_id,
                    &format!(
                        r#"
                        if (!el) {{
                            return JSON.stringify({{ ok: false, error: "stale_ref", reason: refRegistry.reason(refId) }});
                        }}
                        const climbCount = {ancestors};
                        {text_body}"#
                    ),
                )
            } else {
                format!("(function() {{ const el = document.body; const climbCount = 0; {text_body} }})()")
            };
            let readiness = include_str!("readWhenReady.js");
            let ready_js = format!("(() => {{ {readiness} return readWhenReady(() => {js}); }})()");
            let ready_deadline = Instant::now() + Duration::from_secs(5);
            let navigation = active_navigation_generation(tab_id);
            let read = execute_ref_script(&webview, target.as_ref(), &ready_js).await;
            let res = match read {
                Ok(res) => res,
                Err(error)
                    if super::initial_read::retry_read_error(
                        error_codes::CDP_FAILED,
                        &error,
                        active_navigation_generation(tab_id) != navigation,
                        0,
                    ) =>
                {
                    wait_for_ready(
                        &webview,
                        ready_deadline
                            .saturating_duration_since(Instant::now())
                            .as_millis() as u64,
                    )
                    .await;
                    execute_ref_script(&webview, target.as_ref(), &js)
                        .await
                        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?
                }
                Err(error) => return Err((error_codes::CDP_FAILED.to_string(), error)),
            };
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let mut parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();
            if parsed["error"].as_str() == Some("document_not_ready") {
                wait_for_ready(
                    &webview,
                    ready_deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64,
                )
                .await;
                let res = execute_ref_script(&webview, target.as_ref(), &js)
                    .await
                    .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
                let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
                parsed = serde_json::from_str(&unquoted).unwrap_or_default();
            }
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                let reported_ancestors = if ref_id.is_some() {
                    ancestors
                } else {
                    json!(0)
                };
                Ok(json!({
                    "tabId": tab_id,
                    "ancestors": reported_ancestors,
                    "ref": ref_id,
                    "text": parsed.get("text").cloned().unwrap_or(Value::Null),
                    "source": parsed.get("source").cloned().unwrap_or(Value::Null),
                    "sourceNote": parsed.get("sourceNote").cloned().unwrap_or(Value::Null),
                    "visible": parsed.get("visible").and_then(Value::as_bool).unwrap_or(false),
                    "truncated": parsed.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                    "totalLength": parsed.get("totalLength").and_then(as_count).unwrap_or(0),
                    "totalLengthIsLowerBound": parsed.get("totalLengthIsLowerBound").and_then(Value::as_bool).unwrap_or(false)
                }))
                .map(|mut reply| {
                    for key in ["sameTextMatches", "onlyInformativeOf"] {
                        if let Some(merged) = params.get(key).filter(|value| value.is_u64()) {
                            reply[key] = merged.clone();
                        }
                    }
                    if params.get("locator").is_some()
                        && params.get("screenReaderOnly").and_then(Value::as_bool) == Some(true)
                    {
                        reply["screenReaderOnly"] = true.into();
                        reply["sourceNote"] = "nothing visible matched; this element is hidden from sight but kept for screen readers".into();
                    }
                    reply
                })
            } else {
                let err = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stale_ref");
                if err == "context_not_found" {
                    return Err(("context_not_found".into(), "no enclosing row within 32 ancestors; the target ref is still valid, choose another context explicitly".into()));
                }
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!(
                        "get_text failed: {err} (reason: {}). Re-find the element, or pass a locator instead of ref so get_text resolves it fresh each call.",
                        ref_failure_reason(&parsed)
                    ),
                ))
            }
        }

        "get_property" => {
            // Live element state without page JavaScript. Measured on YouTube:
            // an agent that wanted to know whether the video was paused spent
            // 12 finds, 3 focuses and 6 key presses per task probing hidden
            // controls, where a tool with JS eval read `paused` once. The list
            // is closed on purpose: every name is a plain DOM property that
            // reads without side effects, and nothing here runs caller code.
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let names: Vec<String> = match params.get("properties") {
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                Some(Value::String(one)) => vec![one.clone()],
                _ => Vec::new(),
            };
            if names.is_empty() || names.len() > 8 {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!(
                        "properties must name 1 to 8 of: {}",
                        ELEMENT_PROPERTIES.join(", ")
                    ),
                ));
            }
            if let Some(unknown) = names
                .iter()
                .find(|name| !ELEMENT_PROPERTIES.contains(&name.as_str()))
            {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!(
                        "'{unknown}' is not a readable property; choose from: {}",
                        ELEMENT_PROPERTIES.join(", ")
                    ),
                ));
            }
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let generation = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, generation)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            let wanted = serde_json::to_string(&names).unwrap_or_else(|_| "[]".into());
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if (!el) {{
                        return JSON.stringify({{ ok: false, error: "stale_ref", reason: refRegistry.reason(refId) }});
                    }}
                    const wanted = {wanted};
                    const values = {{}};
                    const missing = [];
                    for (const name of wanted) {{
                        let value;
                        try {{ value = el[name]; }} catch (_) {{ value = undefined; }}
                        if (typeof value === 'string') values[name] = value.slice(0, 500);
                        else if (typeof value === 'boolean' || value === null) values[name] = value;
                        else if (typeof value === 'number') values[name] = Number.isFinite(value) ? value : null;
                        else missing.push(name);
                    }}
                    return JSON.stringify({{ ok: true, values: values, missing: missing }});"#
                ),
            );
            let res = execute_ref_script(&webview, target.as_ref(), &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();
            if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(json!({
                    "tabId": tab_id,
                    "ref": ref_id,
                    "values": parsed.get("values").cloned().unwrap_or(json!({})),
                    "missing": parsed.get("missing").cloned().unwrap_or(json!([])),
                }))
            } else {
                let err = parsed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("stale_ref");
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!(
                        "get_property failed: {err} (reason: {})",
                        ref_failure_reason(&parsed)
                    ),
                ))
            }
        }

        "get_page_info" | "page_info" => {
            let tab_id = extract_tab_id(&params)?;
            let title_source = params
                .get("titleSource")
                .map(|value| serde_json::from_value::<TitleSource>(value.clone()))
                .transpose()
                .map_err(|_| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "titleSource must be native or document".to_string(),
                    )
                })?
                .unwrap_or(TitleSource::Native);
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let (native_title, url) = super::cdp::read_page_info(&webview, SCRIPT_POLL_TIMEOUT)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let title = if title_source == TitleSource::Document {
                let raw = execute_script_with_timeout(&webview, "document.title", Duration::from_millis(750))
                    .await
                    .map_err(|_| (error_codes::CDP_FAILED.to_string(), "document title unavailable; request titleSource native for non-blocking metadata".to_string()))?;
                serde_json::from_str::<String>(&raw).map_err(|_| {
                    (
                        error_codes::CDP_FAILED.to_string(),
                        "document title unavailable".to_string(),
                    )
                })?
            } else {
                native_title
            };
            Ok(
                json!({ "tabId": tab_id, "title": title, "titleSource": title_source, "url": url, "urlSource": "native", "loading": active_loading(tab_id), "pendingUrl": active_pending_url(tab_id) }),
            )
        }

        "console_logs" => {
            let tab_id = params
                .get("tabId")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "Missing tabId".into(),
                    )
                })?;

            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            // One advert iframe can spend the whole budget on a single 1,800
            // character tracking URL. This is the cheapest diagnostic tool
            // there is; it should not be the most expensive to read.
            let wanted: Option<Vec<String>> = match params.get("level") {
                None => None,
                Some(Value::String(one)) => Some(vec![one.to_ascii_lowercase()]),
                Some(Value::Array(many)) => Some(
                    many.iter()
                        .filter_map(|v| v.as_str().map(str::to_ascii_lowercase))
                        .collect(),
                ),
                Some(_) => {
                    return Err((
                        error_codes::INVALID_REQUEST.to_string(),
                        "level takes a console level or a list of them".to_string(),
                    ))
                }
            };
            let per_message = params
                .get("maxCharsPerMessage")
                .and_then(as_count)
                .map(|value| value.clamp(40, 4_000) as usize);
            let since = params.get("since").and_then(as_count);

            let (logs, included_frames, skipped_frames) = collect_console_logs(&webview).await;
            let total = logs.len();
            let mut clipped = 0usize;
            let logs: Vec<Value> = logs
                .into_iter()
                .filter(|entry| {
                    wanted.as_ref().is_none_or(|levels| {
                        entry
                            .get("level")
                            .and_then(Value::as_str)
                            .is_some_and(|level| {
                                levels.iter().any(|w| w == &level.to_ascii_lowercase())
                            })
                    })
                })
                .filter(|entry| {
                    since.is_none_or(|from| entry.get("ts").and_then(as_count).unwrap_or(0) >= from)
                })
                .map(|mut entry| {
                    if let (Some(max), Some(text)) = (
                        per_message,
                        entry
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    ) {
                        if text.chars().count() > max {
                            let short: String = text.chars().take(max).collect();
                            entry["text"] = json!(short);
                            entry["textTruncated"] = json!(true);
                            clipped += 1;
                        }
                    }
                    entry
                })
                .collect();
            Ok(json!({
                "logs": logs,
                "includedFrames": included_frames,
                "skippedFrames": skipped_frames,
                "totalBeforeFilter": total,
                "truncatedMessages": clipped
            }))
        }

        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unknown method '{method}'"),
        )),
    }
}

fn resolve_requested_workspace(params: &Value) -> Result<PathBuf, (String, String)> {
    let workspace = params
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "file automation requires an explicit workspace root".to_string(),
            )
        })?;
    ensure_bounded(workspace, MAX_WORKSPACE_BYTES, "workspace")?;
    let canonical = fs::canonicalize(workspace).map_err(|error| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            format!("workspace is not accessible: {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "workspace is not a directory".to_string(),
        ));
    }
    Ok(canonical)
}

fn resolve_tab_workspace(tab_id: i64, params: &Value) -> Result<PathBuf, (String, String)> {
    let requested = resolve_requested_workspace(params)?;
    let actual = active_local_root(tab_id).ok_or_else(|| {
        (
            error_codes::TAB_NOT_FOUND.to_string(),
            format!("tab {tab_id} has no active workspace root"),
        )
    })?;
    if requested != actual {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("tab {tab_id} belongs to a different workspace"),
        ));
    }
    Ok(actual)
}

fn resolve_upload_files(
    workspace_root: &Path,
    params: &Value,
) -> Result<Vec<PathBuf>, (String, String)> {
    let paths = params
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "browser_upload requires a non-empty 'paths' array".to_string(),
            )
        })?;
    if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("browser_upload accepts 1-{MAX_UPLOAD_FILES} files"),
        ));
    }
    let mut files = Vec::with_capacity(paths.len());
    for value in paths {
        let path = value.as_str().ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "every upload path must be a string".to_string(),
            )
        })?;
        ensure_bounded(path, MAX_FILE_PATH_BYTES, "paths[]")?;
        let requested = PathBuf::from(path);
        let requested = if requested.is_absolute() {
            requested
        } else {
            workspace_root.join(requested)
        };
        let canonical = fs::canonicalize(&requested).map_err(|error| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                format!("upload file is not accessible: {error}"),
            )
        })?;
        if !canonical.starts_with(workspace_root) {
            return Err((
                error_codes::INVALID_REQUEST.to_string(),
                format!(
                    "upload file is outside the selected workspace: {}",
                    canonical.display()
                ),
            ));
        }
        if !canonical.is_file() {
            return Err((
                error_codes::INVALID_REQUEST.to_string(),
                format!("upload path is not a file: {}", canonical.display()),
            ));
        }
        files.push(canonical);
    }
    Ok(files)
}

fn deep_ref_expression(ref_id: &str, body: &str) -> String {
    format!(
        r#"(function() {{
            const refId = {};
            {REF_REGISTRY_JS}
            const el = refRegistry.resolve(refId);
            {body}
        }})()"#,
        serde_json::to_string(ref_id).unwrap()
    )
}

/// Read the surface an action just opened, inside the call that opened it.
///
/// Refs for whatever it finds are registered on the spot, and the scan
/// generation is published only when something was registered: a reveal that
/// saw nothing has replaced nothing, so the refs the caller already holds stay
/// live. A failure here never fails the action, which has already happened.
/// What a reveal follows: a click, which waits only on a control that declares
/// a popup, or a fill, which knows its field's pre-fill baseline and the text
/// it put there.
enum RevealAfter<'a> {
    Click,
    Fill {
        before: Option<&'a Value>,
        query: &'a str,
    },
}

async fn run_reveal(
    webview: &Webview,
    tab_id: i64,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    budget_ms: u64,
    after: RevealAfter<'_>,
) -> Option<Value> {
    if budget_ms == 0 {
        return None;
    }
    let generation = peek_next_generation(tab_id);
    let (before, declared_only, query) = match after {
        RevealAfter::Click => (None, true, None),
        RevealAfter::Fill { before, query } => (before, false, Some(query)),
    };
    let script = build_reveal_js(ref_id, generation, budget_ms, before, declared_only, query);
    let frame_id = target
        .filter(|target| !target.is_main)
        .map(|target| target.frame_id.as_str());
    // A click that navigates destroys the context this promise lives in, and a
    // promise in a dead context never settles. The budget is what the caller
    // agreed to wait; nothing here may outlast it by more than a breath.
    let response = tokio::time::timeout(
        Duration::from_millis(budget_ms + REVEAL_GRACE_MS),
        ref_context::execute_awaited(webview, frame_id, &script),
    )
    .await
    .ok()?
    .ok()?;
    let reveal = parse_reveal(&response)?;
    if reveal.registered > 0 {
        commit_generation(tab_id, generation);
        if let Some(frame) = target.filter(|target| !target.is_main) {
            record_ref_frame_targets(
                tab_id,
                reveal
                    .refs
                    .iter()
                    .map(|ref_id| (ref_id.clone(), frame.clone()))
                    .collect(),
            );
        }
    }
    Some(reveal.value)
}

/// Split the reveal into what opened and what changed. The surface goes under
/// `revealed`; page effects sit at the top level because they describe the
/// action rather than the surface. A surface that never opened is left out
/// entirely: `count: 0` spends the caller's tokens to say nothing.
fn merge_reveal(result: &mut Value, mut revealed: Value) {
    if let Some(observed) = revealed
        .as_object_mut()
        .and_then(|surface| surface.remove("observed"))
    {
        result["observed"] = observed;
    }
    if revealed["count"].as_u64().unwrap_or(0) > 0 {
        result["revealed"] = revealed;
    }
}

/// The longest value retyped key by key. Past this the browser's bulk insert is
/// used instead; a field that long is not an autocomplete query.
const MAX_NATIVE_RETYPE_CHARS: usize = 64;

/// How far past its own budget a reveal may run before it is abandoned. Covers
/// the round trip to the page and back, not another wait.
const REVEAL_GRACE_MS: u64 = 300;

/// Finds the video or audio a key or click was aimed at: the target itself, one
/// inside it, or one in the player around it (eight composed levels up at most,
/// never the document), and reads its playback state.
const MEDIA_STATE_BODY: &str = r#"
    if (!el || !el.isConnected) return 'null';
    const pick = node => node?.matches?.('video,audio') ? node : (node?.querySelector?.('video,audio') || null);
    const parent = node => node.assignedSlot || node.parentElement || node.getRootNode?.().host || null;
    let media = pick(el);
    for (let node = parent(el), depth = 0; !media && node && depth < 8; node = parent(node), depth++) {
        if (node === document.body || node === document.documentElement) break;
        media = pick(node);
    }
    if (!media) return 'null';
    const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
    return JSON.stringify({ paused: media.paused, ended: media.ended, muted: media.muted, currentTime: round(media.currentTime), duration: round(media.duration) });
"#;

/// The page's main player: the largest visible video, else the first audio,
/// among the first sixteen media elements of the document.
const PAGE_MEDIA_JS: &str = r#"(() => {
    let best = null, area = -1, count = 0;
    for (const media of document.querySelectorAll('video,audio')) {
        if (++count > 16) break;
        const rect = media.getBoundingClientRect();
        const size = media.localName === 'video' ? rect.width * rect.height : 0;
        if (media.localName === 'video' && size <= 0) continue;
        if (size > area) { best = media; area = size; }
    }
    if (!best) return 'null';
    const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
    return JSON.stringify({ paused: best.paused, ended: best.ended, muted: best.muted, currentTime: round(best.currentTime), duration: round(best.duration) });
})()"#;

/// Keys a media player answers to: a single character, Space, the arrows or a
/// media key, pressed alone. Enter, Tab and Escape belong to forms and dialogs.
fn player_key(key: &str, action: &str, modifiers: u8) -> bool {
    action == "press"
        && modifiers == 0
        && (key.chars().count() == 1
            || matches!(
                key,
                "Space"
                    | "ArrowLeft"
                    | "ArrowRight"
                    | "ArrowUp"
                    | "ArrowDown"
                    | "MediaPlayPause"
                    | "MediaStop"
            ))
}

/// Playback state of the page's main player after an untargeted key, or None
/// when the page has no media.
async fn page_media_state(webview: &Webview) -> Option<Value> {
    let raw = execute_script_with_timeout(webview, PAGE_MEDIA_JS, Duration::from_millis(500))
        .await
        .ok()?;
    let decoded: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str::<Value>(&decoded)
        .ok()
        .filter(Value::is_object)
}

/// Playback state for the media a press or click was aimed at, or None when the
/// target has no media around it. Every YouTube play/pause toggle used to be
/// followed by a browser_get_property turn just to learn this.
async fn media_state(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
) -> Option<Value> {
    let script = deep_ref_expression(ref_id, MEDIA_STATE_BODY);
    let raw = tokio::time::timeout(
        Duration::from_millis(500),
        execute_ref_script(webview, target, &script),
    )
    .await
    .ok()?
    .ok()?;
    let decoded: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str::<Value>(&decoded)
        .ok()
        .filter(Value::is_object)
}

/// Replace the focused field's value through the browser's own input pipeline.
///
/// The ordinary path sets `value` and fires one `input` event, which is faster
/// and exact. Some autocompletes only open for real key events, so a field that
/// took the value but opened nothing gets one attempt with keystrokes rather
/// than leaving the caller to discover the silence in another turn.
async fn native_retype(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    text: &str,
) -> Result<bool, String> {
    ref_context::settle_before_keys(webview).await;
    let guard = |expected: &str| {
        let expected = serde_json::to_string(expected).unwrap();
        deep_ref_expression(
            ref_id,
            &format!(
                r#"
            {VISIBILITY_JS}
            {VALUE_ACTION_JS}
            if (valueActionGuard(el, refRegistry, refId, true)) return false;
            return !el.isContentEditable && el.getRootNode().activeElement === el && el.value === {expected};
        "#
            ),
        )
    };
    if execute_ref_script(webview, target, &guard(text))
        .await?
        .trim()
        != "true"
    {
        return Ok(false);
    }
    let modifiers = if cfg!(target_os = "macos") { 4 } else { 2 };
    for event in ["keyDown", "keyUp"] {
        let mut params = json!({
            "type": event, "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65,
            "nativeVirtualKeyCode": 65, "modifiers": modifiers
        });
        if event == "keyDown" {
            params["commands"] = json!(["selectAll"]);
        }
        call_devtools_protocol_method(
            webview,
            "Input.dispatchKeyEvent",
            &params.to_string(),
            SCRIPT_POLL_TIMEOUT,
        )
        .await?;
    }
    if text.chars().count() > MAX_NATIVE_RETYPE_CHARS {
        if execute_ref_script(webview, target, &guard(text))
            .await?
            .trim()
            != "true"
        {
            return Err("native input target changed".into());
        }
        call_devtools_protocol_method(
            webview,
            "Input.insertText",
            &json!({ "text": text }).to_string(),
            SCRIPT_POLL_TIMEOUT,
        )
        .await?;
        if execute_ref_script(webview, target, &guard(text))
            .await?
            .trim()
            != "true"
        {
            return Err("native input value changed".into());
        }
        return Ok(true);
    }
    let mut expected = text.to_string();
    let mut inserted = String::new();
    for character in text.chars() {
        if execute_ref_script(webview, target, &guard(&expected))
            .await?
            .trim()
            != "true"
        {
            return Err("native input target changed".into());
        }
        let as_text = character.to_string();
        // Only keyDown carries text: that is the event that produces the
        // character, and a keyUp with text is not a keystroke any page expects.
        for params in [
            json!({ "type": "keyDown", "key": as_text, "text": as_text }),
            json!({ "type": "keyUp", "key": as_text }),
        ] {
            call_devtools_protocol_method(
                webview,
                "Input.dispatchKeyEvent",
                &params.to_string(),
                SCRIPT_POLL_TIMEOUT,
            )
            .await?;
        }
        inserted.push(character);
        expected.clone_from(&inserted);
    }
    if execute_ref_script(webview, target, &guard(text))
        .await?
        .trim()
        != "true"
    {
        return Err("native input value changed".into());
    }
    Ok(true)
}

fn ref_failure_reason(value: &Value) -> &str {
    match value.get("reason").and_then(Value::as_str) {
        Some(
            reason @ ("destination_changed"
            | "context_changed"
            | "destination_limit"
            | "context_limit"
            | "node_detached"
            | "generation_changed"),
        ) => reason,
        _ => "ref_invalid",
    }
}

async fn inspect_file_input(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
) -> Result<Value, (String, String)> {
    let body = format!(
        r#"
            if (!el) {{
                return JSON.stringify({{ ok: false, error: "stale_ref" }});
            }}
            if (!(el instanceof HTMLInputElement) || String(el.type).toLowerCase() !== 'file') {{
                return JSON.stringify({{ ok: false, error: "not_a_file_input" }});
            }}
            return JSON.stringify({{
                ok: true,
                disabled: !!el.disabled,
                multiple: !!el.multiple,
                accept: String(el.accept || '').slice(0, 500),
                files: Array.from(el.files || []).slice(0, {MAX_UPLOAD_FILES}).map(file => ({{
                    name: String(file.name || '').slice(0, 255),
                    size: Number(file.size || 0),
                    type: String(file.type || '').slice(0, 200)
                }}))
            }});"#
    );
    let response = execute_ref_script(webview, target, &deep_ref_expression(ref_id, &body))
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(parsed);
    }
    let error = parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("stale_ref");
    if error == "stale_ref" {
        Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid"),
        ))
    } else {
        Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("element ref '{ref_id}' is not a file input"),
        ))
    }
}

async fn resolve_ref_object_id(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
) -> Result<String, String> {
    let expression = deep_ref_expression(ref_id, "return el;");
    let context_id = match target {
        Some(target) if !target.is_main => {
            create_frame_execution_context(webview, &target.frame_id).await?
        }
        _ => ref_context::main_context(webview).await?,
    };
    let params = json!({
        "expression": expression,
        "contextId": context_id,
        "returnByValue": false,
        "awaitPromise": false,
        "userGesture": true
    });
    let response = call_devtools_protocol_method(
        webview,
        "Runtime.evaluate",
        &params.to_string(),
        Duration::from_secs(5),
    )
    .await?;
    let payload: Value = serde_json::from_str(&response)
        .map_err(|error| format!("invalid Runtime.evaluate response: {error}"))?;
    if let Some(details) = payload.get("exceptionDetails") {
        return Err(format!("file input lookup failed: {details}"));
    }
    payload
        .get("result")
        .and_then(|result| result.get("objectId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("file input ref '{ref_id}' is stale or unavailable"))
}

async fn set_file_input_files(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    files: &[PathBuf],
) -> Result<(), String> {
    let object_id = resolve_ref_object_id(webview, target, ref_id).await?;
    let params = json!({
        "files": files
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        "objectId": object_id
    })
    .to_string();
    let result = call_devtools_protocol_method(
        webview,
        "DOM.setFileInputFiles",
        &params,
        Duration::from_secs(10),
    )
    .await;
    let release = json!({ "objectId": object_id }).to_string();
    let _ = call_devtools_protocol_method(
        webview,
        "Runtime.releaseObject",
        &release,
        SCRIPT_POLL_TIMEOUT,
    )
    .await;
    result.map(|_| ())
}

fn extract_download_id(params: &Value) -> Result<&str, (String, String)> {
    let download_id = params
        .get("downloadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "missing or invalid 'downloadId' parameter".to_string(),
            )
        })?;
    ensure_bounded(download_id, MAX_DOWNLOAD_ID_BYTES, "downloadId")?;
    Ok(download_id)
}

fn collect_frame_ids(frame_tree: &Value, output: &mut Vec<String>) {
    if output.len() >= MAX_SNAPSHOT_FRAMES {
        return;
    }
    if let Some(frame_id) = frame_tree
        .get("frame")
        .and_then(|frame| frame.get("id"))
        .and_then(Value::as_str)
    {
        output.push(frame_id.to_string());
    }
    if let Some(children) = frame_tree.get("childFrames").and_then(Value::as_array) {
        for child in children {
            collect_frame_ids(child, output);
            if output.len() >= MAX_SNAPSHOT_FRAMES {
                break;
            }
        }
    }
}

async fn get_frame_ids(webview: &Webview) -> Result<(Vec<String>, bool), String> {
    let raw =
        call_devtools_protocol_method(webview, "Page.getFrameTree", "{}", SCRIPT_POLL_TIMEOUT)
            .await?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid Page.getFrameTree response: {error}"))?;
    let frame_tree = payload
        .get("frameTree")
        .ok_or_else(|| "Page.getFrameTree response omitted frameTree".to_string())?;
    let mut frame_ids = Vec::new();
    collect_frame_ids(frame_tree, &mut frame_ids);
    let total_frames = count_frame_nodes(frame_tree);
    Ok((frame_ids, total_frames > MAX_SNAPSHOT_FRAMES))
}

fn count_frame_nodes(frame_tree: &Value) -> usize {
    1 + frame_tree
        .get("childFrames")
        .and_then(Value::as_array)
        .map(|children| children.iter().map(count_frame_nodes).sum::<usize>())
        .unwrap_or(0)
}

fn history_entry_id(payload: &Value, delta: i64) -> Option<i64> {
    let current = payload.get("currentIndex")?.as_i64()?;
    let target = current.checked_add(delta)?;
    let index = usize::try_from(target).ok()?;
    payload
        .get("entries")?
        .as_array()?
        .get(index)?
        .get("id")?
        .as_i64()
}

async fn dispatch_navigation_action(
    webview: &Webview,
    tab_id: i64,
    action: &str,
) -> Result<bool, String> {
    match action {
        "stop" => {
            call_devtools_protocol_method(webview, "Page.stopLoading", "{}", SCRIPT_POLL_TIMEOUT)
                .await?;
            set_active_loading(tab_id, false);
            Ok(false)
        }
        "reload" => {
            set_active_loading(tab_id, true);
            if let Err(error) =
                call_devtools_protocol_method(webview, "Page.reload", "{}", SCRIPT_POLL_TIMEOUT)
                    .await
            {
                set_active_loading(tab_id, false);
                return Err(error);
            }
            Ok(true)
        }
        "back" | "forward" => {
            let raw = call_devtools_protocol_method(
                webview,
                "Page.getNavigationHistory",
                "{}",
                SCRIPT_POLL_TIMEOUT,
            )
            .await?;
            let history: Value = serde_json::from_str(&raw)
                .map_err(|error| format!("invalid navigation history response: {error}"))?;
            let delta = if action == "back" { -1 } else { 1 };
            let Some(entry_id) = history_entry_id(&history, delta) else {
                return Ok(false);
            };
            set_active_loading(tab_id, true);
            let params = json!({ "entryId": entry_id }).to_string();
            if let Err(error) = call_devtools_protocol_method(
                webview,
                "Page.navigateToHistoryEntry",
                &params,
                SCRIPT_POLL_TIMEOUT,
            )
            .await
            {
                set_active_loading(tab_id, false);
                return Err(error);
            }
            Ok(true)
        }
        _ => Err(format!("unknown browser navigation action '{action}'")),
    }
}

fn parse_console_entries(raw: &str, frame: &str) -> Vec<Value> {
    let decoded = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string());
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&decoded) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let message = entry.get("msg")?.as_str()?;
            let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");
            let timestamp = entry.get("ts").and_then(as_count).unwrap_or(0);
            Some(json!({
                "level": level.chars().take(16).collect::<String>(),
                "msg": message.chars().take(4_000).collect::<String>(),
                "ts": timestamp,
                "frame": frame
            }))
        })
        .collect()
}

async fn collect_console_logs(webview: &Webview) -> (Vec<Value>, usize, usize) {
    if let Webview::External { target, .. } = webview {
        return (target.console_logs(), 1, 0);
    }
    const FRAME_LOG_EXPRESSION: &str =
        "document.documentElement?.getAttribute('data-anbo-console-logs') || '[]'";
    let (frame_ids, frame_limit_reached) = get_frame_ids(webview)
        .await
        .unwrap_or_else(|_| (Vec::new(), false));
    let mut logs = Vec::new();
    let mut included_frames = 0usize;
    let mut skipped_frames = usize::from(frame_limit_reached);

    let frame_results = stream::iter(frame_ids.into_iter().enumerate())
        .map(|(index, frame_id)| async move {
            let result = evaluate_in_frame(webview, &frame_id, FRAME_LOG_EXPRESSION).await;
            (index, result)
        })
        .buffered(FRAME_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for (index, result) in frame_results {
        match result {
            Ok(raw) => {
                included_frames += 1;
                let frame = if index == 0 {
                    "main".to_string()
                } else {
                    format!("frame-{index}")
                };
                logs.extend(parse_console_entries(&raw, &frame));
            }
            Err(_) => skipped_frames += 1,
        }
    }

    if included_frames == 0 {
        let raw = execute_script(webview, "JSON.stringify(window.__anboLogs || [])")
            .await
            .unwrap_or_else(|_| "[]".to_string());
        logs.extend(parse_console_entries(&raw, "main"));
        included_frames = usize::from(!logs.is_empty());
    }

    logs.sort_by_key(|entry| entry.get("ts").and_then(as_count).unwrap_or(0));
    if logs.len() > 50 {
        logs.drain(..logs.len() - 50);
    }
    (logs, included_frames, skipped_frames)
}

async fn create_frame_execution_context(webview: &Webview, frame_id: &str) -> Result<i64, String> {
    let params = json!({
        "frameId": frame_id,
        "worldName": "anbo-browser-automation"
    })
    .to_string();
    let raw = call_devtools_protocol_method(
        webview,
        "Page.createIsolatedWorld",
        &params,
        SCRIPT_POLL_TIMEOUT,
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid Page.createIsolatedWorld response: {error}"))?;
    payload
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Page.createIsolatedWorld response omitted executionContextId".to_string())
}

async fn evaluate_in_frame(
    webview: &Webview,
    frame_id: &str,
    expression: &str,
) -> Result<String, String> {
    let context_id = create_frame_execution_context(webview, frame_id).await?;
    let raw = ref_context::evaluate_context(webview, context_id, expression).await?;
    Ok(decode_frame_evaluation(raw))
}

fn decode_frame_evaluation(raw: String) -> String {
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

fn parse_snapshot_payload(raw: String) -> Result<SnapshotPayload, String> {
    let decoded: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str(&decoded)
        .map_err(|error| format!("failed to parse snapshot JSON: {error}"))
}

#[derive(Debug)]
struct LocatorRequest {
    by: String,
    value: String,
    name: Option<String>,
    exact: bool,
    include_hidden: bool,
    limit: usize,
    ancestors: Ancestors,
    /// Set by a read only; see LocatorQuery::screen_reader_text.
    screen_reader_text: bool,
}

struct CollectedLocatorMatches {
    matches: Vec<LocatorMatch>,
    scanned: usize,
    truncated: bool,
    node_limit_reached: bool,
    included_frames: usize,
    skipped_frames: usize,
    hidden: usize,
    name_misses: Vec<String>,
    candidates: Vec<super::locator::Candidate>,
    nearest: Option<super::locator::NearestCss>,
}

/// Name the elements that collided, so narrowing them does not cost another
/// round trip.
///
/// "matched multiple elements" tells the caller to narrow without telling them
/// what to narrow against; the two candidates are already in hand.
/// Read the page's change counter, installing it on first use.
///
/// A reading Anbo could not take is not evidence of quiet, so every failure
/// answers None and the caller scans as it always did.
async fn page_scan_state(webview: &Webview) -> Option<PageScanState> {
    let raw = ref_context::execute_main(webview, PAGE_SCAN_STATE_JS)
        .await
        .ok()?;
    let decoded: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str(&decoded).ok()
}

fn describe_ambiguity(error: (String, String), matches: &[LocatorMatch]) -> (String, String) {
    if error.0 != error_codes::AMBIGUOUS_TARGET || matches.is_empty() {
        return error;
    }
    let candidates = matches
        .iter()
        .map(|item| {
            let label = if item.name.is_empty() {
                item.text.as_str()
            } else {
                item.name.as_str()
            };
            let label: String = label.chars().take(60).collect();
            let position = item
                .bounds
                .as_ref()
                .map(|b| format!(" at {:.0},{:.0}", b.x, b.y))
                .unwrap_or_default();
            let hidden = if item.visible { "" } else { ", hidden" };
            let label = serde_json::to_string(&label).unwrap_or_default();
            format!("{} <{}> {label}{position}{hidden}", item.ref_id, item.tag)
        })
        .collect::<Vec<_>>()
        .join("; ");
    (error.0, format!("{}; candidates: {candidates}", error.1))
}

/// How long to wait before looking again, and the ceiling a run of
/// disappointments backs off to. Repeating a miss is cheap only in theory:
/// every retry is a full document walk on the page's own main thread.
const LOCATOR_RETRY_MS: u64 = 150;
const MAX_LOCATOR_RETRY_MS: u64 = 1_000;

fn locator_retry_at(
    now: tokio::time::Instant,
    scanned_at: tokio::time::Instant,
    backoff_ms: u64,
    deadline: tokio::time::Instant,
) -> tokio::time::Instant {
    (now + Duration::from_millis(backoff_ms))
        .min(scanned_at + MAX_CACHED_SCAN_AGE)
        .max(now + Duration::from_millis(LOCATOR_RETRY_MS))
        .min(deadline)
}

// A fresh complete scan must reconfirm absence after the settle window.
const ABSENCE_SETTLE: Duration = Duration::from_millis(1_500);

/// How long absence must hold before find gives up early. A page that went
/// quiet answers after the settle. A live page (TradingView rewrites its prices
/// many times a second) never goes quiet and used to hold every miss for the
/// whole timeout, 5 to 8 s each in the R35 run; it answers once absence has
/// held, shape unchanged, for half the caller's patience, so an element that
/// arrives late still has the other half.
fn absence_settle(timeout_ms: u64, live: bool) -> Duration {
    if live {
        Duration::from_millis((timeout_ms / 2).clamp(1_500, 5_000))
    } else {
        ABSENCE_SETTLE
    }
}

/// The one shape of empty scan that proves an element is absent rather than
/// merely not found yet: the whole page was read, no frame was skipped, the
/// node budget was not hit, and nothing matched at all -- not even a hidden
/// element that an animation could later reveal.
fn absence_conclusive(scan: &CollectedLocatorMatches) -> bool {
    scan.matches.is_empty()
        && scan.hidden == 0
        && !scan.truncated
        && !scan.node_limit_reached
        && scan.skipped_frames == 0
}

/// A miss whose only match(es) exist but are hidden (not rendered), with the rest of the page
/// fully read (no truncation, node limit or skipped frames — those could hide a visible match).
/// The elements are already in the DOM, so waiting rarely renders them; once the hidden-only
/// state has held for the settle, find can fail fast with the includeHidden hint instead of
/// burning the whole timeout. The agent recovers via includeHidden or a different target either way.
/// How many matches a text read inspects before calling a locator ambiguous.
const SAME_TEXT_READ_LIMIT: usize = 5;

/// Whether a text read may take the first of several matches: the scan saw
/// all of them and every one reads the same non-empty text, so any choice
/// returns the same answer. The YouTube title is an h1 around a
/// yt-formatted-string with identical text, and a css list naming both cost an
/// ambiguous_target plus a retry. Input still demands exactly one match.
fn same_text_matches(scan: &CollectedLocatorMatches) -> bool {
    let normalize = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(first) = scan.matches.first().map(|item| normalize(&item.text)) else {
        return false;
    };
    // A scan stops at its limit, so a full one may have left a different match unread.
    (2..SAME_TEXT_READ_LIMIT).contains(&scan.matches.len())
        && !first.is_empty()
        && !scan.truncated
        && !scan.node_limit_reached
        && scan.skipped_frames == 0
        && scan
            .matches
            .iter()
            .all(|item| normalize(&item.text) == first)
}

/// How many matches a text read collects, so the rule below can see them all.
const READ_SCAN_LIMIT: usize = MAX_LOCATOR_MATCHES;

/// The one match a text read may take when every other match is blank, text
/// and name alike, and the scan saw them all. TradingView paints its chart on
/// eleven canvases and names one; a read of `canvas` failed as ambiguous and
/// cost a retry, three times over two runs. Input still demands one match.
fn only_informative_match(scan: &CollectedLocatorMatches) -> Option<usize> {
    let blank = |item: &LocatorMatch| item.text.trim().is_empty() && item.name.trim().is_empty();
    if !(2..READ_SCAN_LIMIT).contains(&scan.matches.len())
        || scan.truncated
        || scan.node_limit_reached
        || scan.skipped_frames != 0
    {
        return None;
    }
    let mut informative = scan
        .matches
        .iter()
        .enumerate()
        .filter(|(_, item)| !blank(item));
    let (index, _) = informative.next()?;
    informative.next().is_none().then_some(index)
}

fn hidden_only_miss(scan: &CollectedLocatorMatches) -> bool {
    scan.matches.is_empty()
        && scan.hidden > 0
        && !scan.truncated
        && !scan.node_limit_reached
        && scan.skipped_frames == 0
}

/// How long a matched-but-hidden element must stay hidden before find gives up on it
/// rendering: a fifth of the caller's timeout, between 0.75 and 1.5 seconds. Menus and
/// suggestion lists reveal within a few hundred milliseconds of the action that opens them.
/// The old half-timeout window (up to 3 s) never paid off in the Sept 22 heavy run: all ten
/// hidden-only misses there were auto-hidden player controls and responsive-layout buttons
/// that stayed hidden, so each spent about 3 s before the same error.
fn hidden_only_settle(timeout_ms: u64) -> Duration {
    Duration::from_millis((timeout_ms / 5).clamp(750, 1_500))
}

/// When a lookup that keeps missing may stop before its timeout, shared by
/// browser_find and the locator of an action or read. Absence is final once it
/// has held for `absence_settle`, surviving page changes that keep the page's
/// shape; a miss with only hidden matches is final after `hidden_only_settle`,
/// whatever the page does. Neither is final while the tab is still loading.
#[derive(Default)]
struct MissClock {
    absent_since: Option<tokio::time::Instant>,
    // The page as it was when absence began, and whether it has kept changing
    // since without changing shape.
    absent_baseline: Option<PageScanState>,
    absent_live: bool,
    // Revision-independent on purpose: a page that mutates constantly (live
    // charts) would otherwise never let a genuinely not-rendered match settle.
    hidden_since: Option<tokio::time::Instant>,
    // The caller wrote its own timeout, which is a promise to wait: absence
    // then never ends early (a label that turned up at 1.8 s under a 4 s
    // timeout was given up on at 1.5 s). A hidden-only miss still does; the
    // default timeout keeps the early answer agents need for wrong guesses.
    patient: bool,
}

impl MissClock {
    fn reset_absence(&mut self) {
        self.absent_since = None;
        self.absent_baseline = None;
        self.absent_live = false;
    }

    /// The page as read before the next scan, against the one scanned last.
    fn page_read(&mut self, previous: &PageScanState, current: Option<&PageScanState>) {
        match current {
            Some(current) if previous.same_revision(current) => {}
            Some(current)
                if self.absent_since.is_some()
                    && self
                        .absent_baseline
                        .as_ref()
                        .is_some_and(|base| base.same_structure(current)) =>
            {
                self.absent_live = true;
            }
            _ => self.reset_absence(),
        }
    }

    fn absence_pending(&self) -> bool {
        self.absent_since.is_some()
    }

    fn absence_settled(&self, now: tokio::time::Instant, timeout_ms: u64) -> bool {
        !self.patient
            && self.absent_since.is_some_and(|since| {
                now.saturating_duration_since(since) >= absence_settle(timeout_ms, self.absent_live)
            })
    }

    /// Records a scan that matched nothing usable; true when the miss is final.
    fn missed(
        &mut self,
        scan: &CollectedLocatorMatches,
        state: Option<&PageScanState>,
        completed: tokio::time::Instant,
        timeout_ms: u64,
        loading: bool,
    ) -> bool {
        let readable = state.is_some_and(|state| state.mutations >= 0);
        let mut last = false;
        if readable && absence_conclusive(scan) {
            last = self.absence_settled(completed, timeout_ms) && !loading;
            if self.absent_since.is_none() {
                self.absent_since = Some(completed);
                self.absent_baseline = state.cloned();
                self.absent_live = false;
            }
        } else {
            self.reset_absence();
        }
        // Not while loading either: TradingView keeps its header hidden until
        // the chart has loaded, and a find asked to wait 15 s gave up after 3.
        if readable && hidden_only_miss(scan) {
            let since = *self.hidden_since.get_or_insert(completed);
            last |= completed.saturating_duration_since(since) >= hidden_only_settle(timeout_ms)
                && !loading;
        } else {
            self.hidden_since = None;
        }
        last
    }
}

/// browser_type's submit flag and the result it waits for. Type then Enter was
/// two calls in every search task; submit presses Enter through the same
/// guarded path as browser_press, on the field just filled. Without submit,
/// waitFor is the page state the fill should produce: a live filter showing a
/// row, which demoqa's book search asked for in every session.
fn type_submit(params: &Value) -> Result<(bool, Option<Value>), (String, String)> {
    let submit = match params.get("submit") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err((
                error_codes::INVALID_REQUEST.into(),
                "submit must be a boolean".into(),
            ))
        }
    };
    let expectation = params.get("waitFor").cloned();
    if let Some(expectation) = expectation.as_ref() {
        PageExpectation::parse(Some(expectation))?;
    }
    Ok((submit, expectation))
}

fn find_timeout(
    locator: &LocatorRequest,
    timeout_ms: u64,
    empty_scans: usize,
    scan_error: Option<&str>,
    last_empty_scan: Option<&CollectedLocatorMatches>,
    quiet_waits: usize,
) -> (String, String) {
    let diagnostics = locator_timeout_diagnostics(
        locator,
        empty_scans,
        scan_error,
        last_empty_scan,
        quiet_waits,
    );
    (
        error_codes::TIMEOUT.to_string(),
        format!(
            "timed out finding {} '{}' after {timeout_ms}ms: {diagnostics}",
            locator.by, locator.value,
        ),
    )
}

fn locator_timeout_diagnostics(
    locator: &LocatorRequest,
    completed_scans: usize,
    scan_error: Option<&str>,
    last_scan: Option<&CollectedLocatorMatches>,
    quiet_waits: usize,
) -> String {
    // What the caller needs is not how many scans ran, but whether this is a
    // verdict they can act on. A page scanned end to end with nothing matching
    // is a real absence; a truncated scan is not; and a locator that matched
    // elements nobody can see is neither -- it is a visibility filter the
    // caller can lift.
    let hidden = last_scan.map_or(0, |scan| scan.hidden);
    let detail = if completed_scans == 0 {
        "no scan completed".to_string()
    } else if scan_error.is_some() {
        // The last look was cut off by the deadline. Whatever the earlier ones
        // saw, this is not a page that was read to the end, and saying both in
        // one sentence left the caller unable to tell which half to believe.
        format!(
            "the last scan was cut short by the deadline after {completed_scans} completed scans; no conclusion about the element is available"
        )
    } else if let Some(scan) =
        last_scan.filter(|scan| scan.node_limit_reached || scan.skipped_frames > 0)
    {
        format!(
            "page coverage incomplete after {completed_scans} scans ({} nodes scanned{}); the element may exist in the unscanned part, so this is not a confirmed absence",
            scan.scanned,
            if scan.skipped_frames > 0 { format!(", {} frames skipped", scan.skipped_frames) } else { String::new() },
        )
    } else if let Some(scan) = last_scan.filter(|scan| !scan.matches.is_empty()) {
        format!(
            "{} element(s) matched in the last completed scan, but the requested state was not satisfied ({} rendered); this is not an absent target",
            scan.matches.len(),
            scan.matches.iter().filter(|item| item.visible).count(),
        )
    } else if hidden > 0 {
        format!(
            "{hidden} element(s) matched but are not rendered, so they were filtered out; includeHidden=true permits inspection, not input to a hidden control. Input still requires a rendered target"
        )
    } else if let Some(names) = last_scan
        .filter(|scan| !scan.name_misses.is_empty())
        .map(|scan| {
            scan.name_misses
                .iter()
                .take(5)
                .map(|name| json!(name.chars().take(80).collect::<String>()).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        })
    {
        let comparison = if locator.exact {
            "equaled"
        } else {
            "contained"
        };
        // Kimi read "the role matched" under a css lookup and had to guess
        // that its own name filter was what excluded every match.
        let matched = match locator.by.as_str() {
            "role" => "the role matched but",
            "css" => "the selector matched but the name filter excluded every match:",
            "name" => "elements with a role were found but",
            _ => "the locator matched but",
        };
        format!(
            "{matched} no accessible name {comparison} the requested one; names seen here: {names}; check the page's language and use its observed name, not a guessed translation. These are hints (up to 80 characters each), not verified unique targets"
        )
    } else {
        format!(
            "page fully scanned {completed_scans} time(s) ({} nodes); confirmed absence in the last completed scan, not a guarantee about later changes",
            last_scan.map_or(0, |scan| scan.scanned),
        )
    };
    let quiet = if quiet_waits > 0 {
        "; unchanged root-DOM samples skipped short retries; cached scans expire to recheck unobserved changes"
    } else {
        ""
    };
    // A confirmed absence is worth more with something to do next. The scan
    // already walked past the page's controls; naming a few of them, as role
    // locators, saves the snapshot an agent otherwise spends a turn on before
    // acting. Measured: Maps 3 of 3 sessions and Amazon 3 of 6 paid that turn.
    let seen = last_scan
        .filter(|scan| {
            scan_error.is_none()
                && completed_scans > 0
                && !scan.node_limit_reached
                && scan.skipped_frames == 0
                && scan.matches.is_empty()
                && (hidden > 0 || scan.name_misses.is_empty())
                && !scan.candidates.is_empty()
        })
        .map(|scan| {
            let list = scan
                .candidates
                .iter()
                .take(if hidden > 0 { 4 } else { 8 })
                .map(|candidate| {
                    format!(
                        "{} {}",
                        candidate.role,
                        json!(candidate.name.chars().take(60).collect::<String>())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "; interactive elements seen: {list}; observed alternatives, not equivalent or verified unique targets. Inspect before choosing a locator"
            )
        })
        .unwrap_or_default();
    // An over-specific css selector that misses is usually one rung above a
    // selector the page does have. Measured: every canvas miss on Maps and
    // TradingView was followed by find(css:canvas). Say so in this reply.
    let nearest = last_scan
        .filter(|scan| scan_error.is_none() && hidden == 0 && scan.matches.is_empty())
        .and_then(|scan| scan.nearest.as_ref())
        .map(|near| {
            let examples = near
                .examples
                .iter()
                .take(3)
                .map(|example| {
                    let label = if example.role.is_empty() { example.tag.as_str() } else { example.role.as_str() };
                    if example.name.is_empty() {
                        label.to_string()
                    } else {
                        format!("{label} \"{}\"", example.name)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "; nearest css match: '{}' matches {} ({} visible{}); use it with browser_find by css, or narrow it",
                near.selector,
                near.count,
                near.visible,
                if examples.is_empty() { String::new() } else { format!(": {examples}") }
            )
        })
        .unwrap_or_default();
    format!(
        "{detail}{quiet}{nearest}{seen}{}{}",
        scan_error
            .map(|error| format!("; latest scan: {error}"))
            .unwrap_or_default(),
        last_scan.map(|scan| format!("; last completed coverage: scanned={}, nodeLimitReached={}, includedFrames={}, skippedFrames={}", scan.scanned, scan.node_limit_reached, scan.included_frames, scan.skipped_frames)).unwrap_or_default()
    )
}

fn target_locator_timeout(
    locator: &LocatorRequest,
    state: Option<&str>,
    timeout_ms: u64,
    completed_scans: usize,
    scan_error: Option<&str>,
    last_scan: Option<&CollectedLocatorMatches>,
) -> (String, String) {
    let diagnostics =
        locator_timeout_diagnostics(locator, completed_scans, scan_error, last_scan, 0);
    (
        error_codes::TIMEOUT.into(),
        format!(
            "locator {} timed out after {timeout_ms}ms for {} '{}': {diagnostics}; no input dispatched",
            state.unwrap_or("lookup"), locator.by, locator.value,
        ),
    )
}

/// Roles an agent writes as the locator type itself, habits from other tools:
/// `{by:"combobox", name:"Search"}` means a role lookup, never a new strategy.
const ROLE_AS_BY: [&str; 24] = [
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "tab",
    "menuitem",
    "option",
    "listbox",
    "heading",
    "dialog",
    "img",
    "list",
    "listitem",
    "row",
    "cell",
    "navigation",
    "main",
    "region",
];

/// A locator type that is not one of the strategies but says plainly what it
/// means: `id` is an id selector, a role name is a role lookup whose value, if
/// any, is the name. Anything else stays unsupported.
fn alias_locator(
    by: &str,
    value: &str,
    name: Option<&str>,
) -> Option<(String, String, Option<String>)> {
    if by == "id" {
        let value = value.trim().trim_start_matches('#');
        if value.is_empty() {
            return None;
        }
        let plain = value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let selector = if plain {
            format!("#{value}")
        } else {
            format!(
                "[id=\"{}\"]",
                value.replace('\\', "\\\\").replace('"', "\\\"")
            )
        };
        return Some(("css".into(), selector, name.map(str::to_string)));
    }
    if ROLE_AS_BY.contains(&by) {
        let named = name
            .map(str::to_string)
            .or_else(|| Some(value.trim().to_string()).filter(|value| !value.is_empty()));
        return Some(("role".into(), by.to_string(), named));
    }
    // An accessible name asked for as the lookup itself: agents guessed
    // by:"name" on YouTube (R31, R36, R37), and Kimi twice wrote
    // {by:"role", value:"Cari di Wikipedia"}, each waiting out a confirmed
    // absence. Any element with a role answers to its name; an action still
    // refuses more than one.
    if by == "name" || (by == "role" && !names_a_role(value)) {
        let named = name
            .map(str::to_string)
            .or_else(|| Some(value.trim().to_string()).filter(|value| !value.is_empty()))?;
        return Some(("name".into(), named.clone(), Some(named)));
    }
    None
}

/// WAI-ARIA 1.2 roles. A role lookup matches when a role contains the value,
/// so a value that no role contains cannot be a role.
const ARIA_ROLES: &str = concat!(
    "alert alertdialog application article banner blockquote button caption cell checkbox ",
    "code columnheader combobox complementary contentinfo definition deletion dialog ",
    "directory document emphasis feed figure form generic grid gridcell group heading img ",
    "image insertion link list listbox listitem log main mark marquee math menu menubar ",
    "menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph ",
    "presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar ",
    "search searchbox separator slider spinbutton status strong subscript superscript ",
    "switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree ",
    "treegrid treeitem",
);

fn names_a_role(value: &str) -> bool {
    let value = value.trim().to_lowercase();
    value.is_empty()
        || value.starts_with("doc-")
        || value.starts_with("graphics-")
        || ARIA_ROLES
            .split(' ')
            .any(|role| role.contains(value.as_str()))
}

fn extract_locator(params: &Value) -> Result<LocatorRequest, (String, String)> {
    let by = params.get("by").and_then(Value::as_str).ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            "browser_find requires a 'by' locator type".to_string(),
        )
    })?;
    let raw_value = params.get("value").and_then(Value::as_str).unwrap_or("");
    let raw_name = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let aliased = if by == "role" && !names_a_role(raw_value) {
        alias_locator(by, raw_value, raw_name)
    } else if matches!(
        by,
        "role" | "text" | "label" | "placeholder" | "testId" | "title" | "alt" | "css"
    ) {
        None
    } else {
        Some(alias_locator(by, raw_value, raw_name).ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                // An agent that guessed by:"name" on YouTube spent a call to
                // learn the list; the accessible name is a filter, not a type.
                format!(
                    "unsupported locator type '{by}'; use role, text, label, placeholder, testId, title, alt or css, and pass an accessible name as name (by:'role', value:'combobox', name:'Search')"
                ),
            )
        })?)
    };
    let (by, value, name) = match aliased {
        Some((by, value, name)) => (by, value, name),
        None => (
            by.to_string(),
            raw_value.trim().to_string(),
            raw_name.map(str::to_string),
        ),
    };
    let by = by.as_str();
    let value = Some(value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "browser_find requires a non-empty 'value'".to_string(),
            )
        })?;
    ensure_bounded(value, MAX_LOCATOR_VALUE_BYTES, "value")?;
    if let Some(name) = name.as_deref() {
        ensure_bounded(name, MAX_LOCATOR_VALUE_BYTES, "name")?;
    }
    Ok(LocatorRequest {
        by: by.to_string(),
        value: value.to_string(),
        name,
        exact: params
            .get("exact")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        include_hidden: params
            .get("includeHidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        limit: params
            .get("limit")
            .and_then(as_count)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(10)
            .clamp(1, MAX_LOCATOR_MATCHES),
        // A match is a leaf. Reading the row, card or section it sits in used
        // to cost one call per fact in it.
        ancestors: Ancestors::parse(params.get("ancestors"))?,
        screen_reader_text: false,
    })
}

async fn resolve_target_locator(
    app: &AppHandle,
    params: &Value,
    waiting: bool,
    reading: bool,
) -> Result<Value, (String, String)> {
    let target = &params["locator"];
    let lookup_timeout = super::locator_target::validate_locator(target)?;
    let mut locator = extract_locator(target)?;
    // A read may settle an ambiguity by itself when every match says the same
    // thing, or only one says anything, so it looks at more of them than an
    // action does.
    locator.limit = if reading { READ_SCAN_LIMIT } else { 2 };
    locator.screen_reader_text = reading;
    let invalid = || {
        (error_codes::INVALID_REQUEST.into(), "locator wait accepts locator, state, minCount, and top-level timeout, not legacy conditions or waitFor".into())
    };
    // How many matches are enough. Absent means the old rule: exactly one, and
    // an ambiguous page is a failure.
    let min_count = match params.get("minCount") {
        None => None,
        Some(_) if !waiting => return Err(invalid()),
        Some(value) => Some(
            as_count(value)
                .filter(|n| (1..=MAX_LOCATOR_MATCHES as u64).contains(n))
                .ok_or_else(invalid)? as usize,
        ),
    };
    let state = if waiting {
        if ["text", "url", "loadState", "waitFor", "ref"]
            .iter()
            .any(|key| params.get(*key).is_some())
            || params
                .get("condition")
                .is_some_and(|v| v.as_str() != Some("locator"))
            || target.get("timeout").is_some()
            || target.get("includeHidden").is_some()
        {
            return Err(invalid());
        }
        locator.include_hidden = true;
        if let Some(wanted) = min_count {
            locator.limit = wanted.max(2);
        }
        let state = params
            .get("state")
            .map(|v| v.as_str().ok_or_else(invalid))
            .transpose()?
            .unwrap_or("visible");
        super::locator_target::wait_state(state, 0, false, false, false, None)?;
        Some(state)
    } else {
        None
    };
    let timeout_ms = if waiting {
        match params.get("timeout") {
            None => 10_000,
            Some(value) => as_count(value)
                .filter(|n| (100..=ACCEPTED_WAIT_TIMEOUT_MS).contains(n))
                .ok_or_else(invalid)?
                .min(MAX_WAIT_TIMEOUT_MS),
        }
    } else {
        lookup_timeout
    };
    let tab_id = extract_tab_id(params)?;
    let webview =
        get_embed_webview(app, tab_id).map_err(|e| (error_codes::TAB_NOT_FOUND.into(), e))?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_scan = None;
    let mut completed_scans = 0;
    let mut scanned_state: Option<PageScanState> = None;
    let mut scanned_at = tokio::time::Instant::now();
    let mut wait_backoff_ms = LOCATOR_RETRY_MS;
    // An action or read gives up on a settled miss as browser_find does: a
    // click on TradingView's hidden "BINANCE:BTCUSDT" label waited out 5 to
    // 8 s for the error find gives in one. A wait for a state is asked to
    // outlast exactly that, so it keeps its whole timeout.
    let settles = state.is_none();
    let mut clock = MissClock {
        patient: target.get("timeout").is_some(),
        ..MissClock::default()
    };
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(target_locator_timeout(
                &locator,
                state,
                timeout_ms,
                completed_scans,
                None,
                last_scan.as_ref(),
            ));
        }
        let current_state = page_scan_state(&webview).await;
        if let Some(previous) = &scanned_state {
            if settles {
                clock.page_read(previous, current_state.as_ref());
            }
            if current_state.as_ref().is_some_and(|current| {
                !clock.absence_settled(now, timeout_ms)
                    && previous.can_reuse(current, scanned_at.elapsed(), clock.absence_pending())
            }) {
                wait_backoff_ms = (wait_backoff_ms * 2).min(MAX_LOCATOR_RETRY_MS);
                tokio::time::sleep_until(locator_retry_at(
                    tokio::time::Instant::now(),
                    scanned_at,
                    wait_backoff_ms,
                    deadline,
                ))
                .await;
                continue;
            }
        }
        scanned_state = current_state;
        scanned_at = tokio::time::Instant::now();
        let (generation, result) = scan_with_fresh_refs(
            tab_id,
            deadline,
            |generation| collect_locator_matches(&webview, tab_id, generation, &locator),
            |result| !result.matches.is_empty(),
        )
        .await
        .map_err(|error| {
            if error.0 == error_codes::TIMEOUT {
                target_locator_timeout(
                    &locator,
                    state,
                    timeout_ms,
                    completed_scans,
                    Some(&error.1),
                    last_scan.as_ref(),
                )
            } else {
                error
            }
        })?;
        let complete = !result.node_limit_reached && result.skipped_frames == 0;
        let same_text = reading && state.is_none() && same_text_matches(&result);
        let informative = (reading && state.is_none() && !same_text)
            .then(|| only_informative_match(&result))
            .flatten();
        let first = match informative {
            Some(index) => result.matches.get(index),
            None => result.matches.first(),
        };
        let matched = if let (Some(state), Some(wanted)) = (state, min_count) {
            let visible = result.matches.iter().filter(|item| item.visible).count();
            super::locator_target::wait_count_state(
                state,
                wanted,
                result.matches.len(),
                visible,
                complete,
            )
        } else if let Some(state) = state {
            super::locator_target::wait_state(
                state,
                result.matches.len(),
                complete,
                first.is_some_and(|m| m.visible),
                first.is_some_and(|m| m.enabled),
                first.and_then(|m| m.checked),
            )
        } else if same_text || informative.is_some() {
            Ok(true)
        } else {
            super::locator_target::unique(result.matches.len(), complete)
        }
        .map_err(|error| describe_ambiguity(error, &result.matches))?;
        if matched {
            // Without includeHidden a read sees only rendered matches, so one
            // that saw none rendered took the page's screen-reader text.
            let spoken = locator.screen_reader_text && result.matches.iter().all(|m| !m.visible);
            let mut reply = if same_text {
                json!({
                    "ok":true, "tabId":tab_id, "generation":generation,
                    "ref":first.map(|m| &m.ref_id), "sameTextMatches":result.matches.len(),
                })
            } else if informative.is_some() {
                json!({
                    "ok":true, "tabId":tab_id, "generation":generation,
                    "ref":first.map(|m| &m.ref_id), "onlyInformativeOf":result.matches.len(),
                })
            } else {
                json!({
                    "ok":true, "tabId":tab_id, "generation":generation,
                    "ref":first.map(|m| &m.ref_id), "condition":"locator", "state":state,
                    "count":result.matches.len(), "coverageComplete":complete,
                    "scanned":result.scanned, "includedFrames":result.included_frames,
                    "skippedFrames":result.skipped_frames, "nodeLimitReached":result.node_limit_reached,
                })
            };
            if spoken {
                reply["screenReaderOnly"] = true.into();
            }
            return Ok(reply);
        }
        completed_scans += 1;
        let completed = tokio::time::Instant::now();
        if settles
            && clock.missed(
                &result,
                scanned_state.as_ref(),
                completed,
                timeout_ms,
                active_loading(tab_id) == Some(true),
            )
        {
            let elapsed = timeout_ms
                .saturating_sub(deadline.saturating_duration_since(completed).as_millis() as u64);
            return Err(target_locator_timeout(
                &locator,
                state,
                elapsed,
                completed_scans,
                None,
                Some(&result),
            ));
        }
        last_scan = Some(result);
        wait_backoff_ms = (wait_backoff_ms * 2).min(MAX_LOCATOR_RETRY_MS);
        tokio::time::sleep_until(locator_retry_at(
            tokio::time::Instant::now(),
            scanned_at,
            wait_backoff_ms,
            deadline,
        ))
        .await;
    }
}

fn parse_locator_payload(raw: String) -> Result<LocatorPayload, String> {
    let decoded: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str(&decoded).map_err(|error| format!("failed to parse locator JSON: {error}"))
}

async fn collect_locator_matches(
    webview: &Webview,
    tab_id: i64,
    generation: u64,
    locator: &LocatorRequest,
) -> Result<CollectedLocatorMatches, (String, String)> {
    let query = LocatorQuery {
        by: &locator.by,
        value: &locator.value,
        name: locator.name.as_deref(),
        exact: locator.exact,
        include_hidden: locator.include_hidden,
        limit: locator.limit,
        ancestors: locator.ancestors,
        screen_reader_text: locator.screen_reader_text,
    };
    let root_script = build_find_js(generation, &format!("g{generation}-e"), &query);
    let root_raw = ref_context::execute_main(webview, &root_script)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let mut root = parse_locator_payload(root_raw)
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    if let Some(error) = root.error.as_deref() {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("locator failed: {error}"),
        ));
    }
    if root.matches.len() >= locator.limit {
        if let Some(point) = &root.visual_point {
            super::activity::target(
                point.x,
                point.y,
                point.width.unwrap_or(0.0),
                point.height.unwrap_or(0.0),
            );
        }
        let targets = root
            .matches
            .iter()
            .map(|item| {
                (
                    item.ref_id.clone(),
                    RefFrameTarget {
                        frame_id: String::new(),
                        is_main: true,
                    },
                )
            })
            .collect();
        record_ref_frame_targets(tab_id, targets);
        return Ok(CollectedLocatorMatches {
            matches: root.matches,
            scanned: root.scanned,
            truncated: true,
            node_limit_reached: root.truncated,
            included_frames: 1,
            skipped_frames: 0,
            hidden: root.hidden,
            name_misses: std::mem::take(&mut root.name_misses),
            candidates: std::mem::take(&mut root.candidates),
            nearest: root.nearest.take(),
        });
    }
    let (frame_ids, frame_limit_reached) = get_frame_ids(webview)
        .await
        .unwrap_or_else(|_| (Vec::new(), true));
    if let Some(point) = &root.visual_point {
        super::activity::target(
            point.x,
            point.y,
            point.width.unwrap_or(0.0),
            point.height.unwrap_or(0.0),
        );
    }
    let root_frame_id = frame_ids.first().cloned().unwrap_or_default();
    let mut targets = HashMap::new();
    for item in &root.matches {
        targets.insert(
            item.ref_id.clone(),
            RefFrameTarget {
                frame_id: root_frame_id.clone(),
                is_main: true,
            },
        );
    }
    let mut matches = std::mem::take(&mut root.matches);
    let mut unseen: Vec<(LocatorMatch, RefFrameTarget)> = std::mem::take(&mut root.unseen)
        .into_iter()
        .map(|item| {
            let target = RefFrameTarget {
                frame_id: root_frame_id.clone(),
                is_main: true,
            };
            (item, target)
        })
        .collect();
    let mut scanned = root.scanned;
    let mut truncated = root.truncated;
    let mut node_limit_reached = root.truncated;
    let mut included_frames = 1usize;
    let mut skipped_frames = usize::from(frame_limit_reached);
    let mut hidden = root.hidden;
    let mut name_misses = std::mem::take(&mut root.name_misses);
    // Only the main document offers candidates; a frame's controls are a
    // different page and would send the agent to the wrong one.
    let candidates = std::mem::take(&mut root.candidates);
    let nearest = root.nearest.take();

    let frame_jobs = frame_ids
        .iter()
        .enumerate()
        .skip(1)
        .map(|(frame_index, frame_id)| {
            let frame_query = LocatorQuery {
                limit: locator.limit,
                ..query
            };
            (
                frame_index,
                frame_id.clone(),
                build_find_js(
                    generation,
                    &format!("g{generation}-f{frame_index}-e"),
                    &frame_query,
                ),
            )
        })
        .collect::<Vec<_>>();
    let mut frame_results = stream::iter(frame_jobs)
        .map(|(frame_index, frame_id, script)| async move {
            let result = evaluate_in_frame(webview, &frame_id, &script)
                .await
                .and_then(parse_locator_payload);
            (frame_index, frame_id, result)
        })
        .buffered(FRAME_CONCURRENCY);

    while let Some((_frame_index, frame_id, result)) = frame_results.next().await {
        if matches.len() >= locator.limit {
            truncated = true;
            break;
        }
        let remaining = locator.limit - matches.len();
        let payload = match result {
            Ok(payload) if payload.error.is_none() => payload,
            _ => {
                skipped_frames += 1;
                continue;
            }
        };
        included_frames += 1;
        scanned = scanned.saturating_add(payload.scanned);
        hidden = hidden.saturating_add(payload.hidden);
        for name in payload.name_misses {
            if name_misses.len() < 5 && !name_misses.contains(&name) {
                name_misses.push(name);
            }
        }
        truncated |= payload.truncated;
        node_limit_reached |= payload.truncated;
        for item in payload.unseen {
            if unseen.len() < locator.limit {
                let target = RefFrameTarget {
                    frame_id: frame_id.clone(),
                    is_main: false,
                };
                unseen.push((item, target));
            }
        }
        truncated |= payload.matches.len() > remaining;
        for item in payload.matches.into_iter().take(remaining) {
            targets.insert(
                item.ref_id.clone(),
                RefFrameTarget {
                    frame_id: frame_id.clone(),
                    is_main: false,
                },
            );
            matches.push(item);
        }
        if matches.len() >= locator.limit {
            truncated = true;
            break;
        }
    }
    // Screen-reader text answers a read only when no document had anything
    // visible; one visible match anywhere keeps the read on what is seen.
    if matches.is_empty() {
        for (item, target) in unseen {
            targets.insert(item.ref_id.clone(), target);
            matches.push(item);
        }
    }
    record_ref_frame_targets(tab_id, targets);
    Ok(CollectedLocatorMatches {
        matches,
        scanned,
        truncated,
        node_limit_reached,
        included_frames,
        skipped_frames,
        hidden,
        name_misses,
        candidates,
        nearest,
    })
}

async fn collect_snapshot_payload(
    webview: &Webview,
    tab_id: i64,
    generation: u64,
) -> Result<(SnapshotPayload, usize, usize), String> {
    let root_raw = ref_context::execute_main(webview, &build_snapshot_js(generation)).await?;
    let mut payload = parse_snapshot_payload(root_raw)?;
    let (frame_ids, frame_limit_reached) = get_frame_ids(webview)
        .await
        .unwrap_or_else(|_| (Vec::new(), false));
    let root_frame_id = frame_ids.first().cloned().unwrap_or_default();
    let mut targets = HashMap::new();
    for element in &payload.elements {
        if let Some(ref_id) = &element.ref_id {
            targets.insert(
                ref_id.clone(),
                RefFrameTarget {
                    frame_id: root_frame_id.clone(),
                    is_main: true,
                },
            );
        }
    }

    let mut included_frames = 1usize;
    let mut skipped_frames = usize::from(frame_limit_reached);
    let frame_jobs = frame_ids
        .iter()
        .enumerate()
        .skip(1)
        .map(|(frame_index, frame_id)| {
            (
                frame_id.clone(),
                build_frame_snapshot_js(generation, frame_index),
            )
        })
        .collect::<Vec<_>>();
    let frame_results = stream::iter(frame_jobs)
        .map(|(frame_id, script)| async move {
            let result = evaluate_in_frame(webview, &frame_id, &script)
                .await
                .and_then(parse_snapshot_payload);
            (frame_id, result)
        })
        .buffered(FRAME_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (frame_id, result) in frame_results {
        let frame_payload = match result {
            Ok(frame_payload) => frame_payload,
            Err(_) => {
                skipped_frames += 1;
                continue;
            }
        };
        included_frames += 1;
        payload.source_truncated |= frame_payload.source_truncated;
        for element in frame_payload.elements {
            if let Some(ref_id) = &element.ref_id {
                targets.insert(
                    ref_id.clone(),
                    RefFrameTarget {
                        frame_id: frame_id.clone(),
                        is_main: false,
                    },
                );
            }
            payload.elements.push(element);
        }
        payload.source_truncated |=
            prioritize_snapshot_elements(&mut payload.elements, MAX_SNAPSHOT_ELEMENTS);
    }
    let retained = payload
        .elements
        .iter()
        .filter_map(|element| element.ref_id.as_deref())
        .collect::<HashSet<_>>();
    targets.retain(|ref_id, _| retained.contains(ref_id.as_str()));
    record_ref_frame_targets(tab_id, targets);
    Ok((payload, included_frames, skipped_frames))
}

async fn execute_ref_script(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    script: &str,
) -> Result<String, String> {
    match target {
        Some(target) if !target.is_main => {
            evaluate_in_frame(webview, &target.frame_id, script).await
        }
        _ => ref_context::execute_main(webview, script).await,
    }
}

#[derive(Clone, Copy)]
enum ActionabilityRequirement {
    Click,
    Check(bool),
    /// A click aimed at a fraction of the box rather than its centre, which is
    /// how a drag inside one element picks its start and end.
    ClickAt(Option<(f64, f64)>),
    Hover(Option<(f64, f64)>),
    Focus,
    Editable,
    Select,
}

struct ActionableElement {
    x: f64,
    y: f64,
    tag: String,
    input_type: String,
    checked: Option<bool>,
    draggable: bool,
    popup_url: Option<String>,
    value_result: Option<Value>,
    /// Only an external tab reports these. The browser delivers no input to a
    /// hidden page, and a page shown in a window nobody sees draws no frames,
    /// so a pointer move waits for one that may never come.
    page_hidden: bool,
    no_frames: bool,
}

fn actionability_failure_reason(
    parsed: &Value,
    requirement: ActionabilityRequirement,
) -> &'static str {
    let flag = |key| parsed.get(key).and_then(Value::as_bool) == Some(true);
    if !flag("visible") {
        "not visible"
    } else if !flag("enabled") {
        "disabled"
    } else if matches!(requirement, ActionabilityRequirement::Editable) && !flag("editable") {
        "not editable"
    } else if matches!(
        requirement,
        ActionabilityRequirement::Click
            | ActionabilityRequirement::Check(_)
            | ActionabilityRequirement::ClickAt(_)
            | ActionabilityRequirement::Hover(_)
            | ActionabilityRequirement::Editable
    ) && !flag("receives")
    {
        if !flag("inViewport") {
            "outside the viewport after scrolling"
        } else {
            "covered by another element"
        }
    } else {
        "not stable"
    }
}

fn actionability_timeout_message(
    ref_id: &str,
    parsed: &Value,
    requirement: ActionabilityRequirement,
) -> String {
    let reason = actionability_failure_reason(parsed, requirement);
    let hint = if matches!(requirement, ActionabilityRequirement::ClickAt(_)) {
        "; requested drag position was not ready; no mouse button was pressed. Inspect the current bounds and visible page before retrying; do not repeat unchanged blocked positions"
    } else {
        ""
    };
    format!("element ref '{ref_id}' did not become actionable: {reason}{hint}")
}

fn extract_hover_position(params: &Value) -> Result<Option<(f64, f64)>, (String, String)> {
    extract_fraction_position(params, "position")
}

/// A point inside an element's box, given as fractions of its width and height.
fn extract_fraction_position(
    params: &Value,
    key: &str,
) -> Result<Option<(f64, f64)>, (String, String)> {
    let Some(position) = params.get(key) else {
        return Ok(None);
    };
    let valid = position
        .as_object()
        .filter(|object| object.len() == 2)
        .and_then(|object| {
            let x = object.get("x")?.as_f64()?;
            let y = object.get("y")?.as_f64()?;
            (x.is_finite() && y.is_finite() && x > 0.0 && x < 1.0 && y > 0.0 && y < 1.0)
                .then_some((x, y))
        });
    valid.map(Some).ok_or_else(|| (
        error_codes::INVALID_REQUEST.to_string(),
        format!("{key} requires only x and y, finite fractions strictly between 0 and 1 (0.5 is the center), not pixels"),
    ))
}

fn actionable_probe_script(ref_id: &str, scroll: &str, position: Option<(f64, f64)>) -> String {
    let action_rect = include_str!("actionRect.js");
    let position = position
        .map(|(x, y)| json!({"x": x, "y": y}))
        .unwrap_or(Value::Null);
    deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el) {{
                return JSON.stringify({{ ok: false, error: 'stale_ref', reason: refRegistry.reason(refId) }});
            }}
            {action_rect}
            const point = prepareActionPoint(el, {scroll}, {position});
            {VISIBILITY_JS}
            const visible = isRenderedElement(el);
            const enabled = !(el.disabled || el.getAttribute('aria-disabled') === 'true');
            const editable = enabled && !el.readOnly && (
                el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
            );
            const receives = visible && receivesActionPointer(el, point);
            let active = false;
            for (let node = document.activeElement, depth = 0; node && depth < 257; depth++) {{
                if (node === el) {{ active = true; break; }}
                node = node.shadowRoot ? node.shadowRoot.activeElement : null;
            }}
            const link = el.closest ? el.closest('a[href]') : null;
            const popupUrl = link && String(link.target || '').toLowerCase() === '_blank' ? String(link.href || '') : null;
            return JSON.stringify({{
                ok: true,
                visible,
                enabled,
                editable,
                receives,
                active,
                popupUrl,
                ...point,
                tag: el.tagName.toLowerCase(),
                inputType: el instanceof HTMLInputElement ? String(el.type || '').toLowerCase() : '',
                checked: typeof el.checked === 'boolean' ? el.checked : null,
                draggable: el.draggable === true
            }});"#
        ),
    )
}

fn actionability_wait_script(
    ref_id: &str,
    scroll: bool,
    position: Option<(f64, f64)>,
    requirement: ActionabilityRequirement,
) -> String {
    actionable_attempt_script(ref_id, scroll, position, requirement, None, false)
}

/// `external` lets a page that draws no frames answer from its first sample
/// and say so. Only an external browser tab asks for it: an occluded Chrome
/// window throttles its timers to once a second, which would hold every action
/// that long, and a pointer move on such a page waits for a frame.
fn actionable_attempt_script(
    ref_id: &str,
    scroll: bool,
    position: Option<(f64, f64)>,
    requirement: ActionabilityRequirement,
    value_script: Option<&str>,
    external: bool,
) -> String {
    let sampler = include_str!("actionabilityWait.js");
    let probe = actionable_probe_script(ref_id, "scroll", position);
    let on_ready = if matches!(requirement, ActionabilityRequirement::Hover(_)) {
        let observer = include_str!("hoverObservation.js");
        let install = deep_ref_expression(
            ref_id,
            &format!(
            "if (window === window.top) {{ {observer} beginHoverObservation(el, refId, point); }}"
        ),
        );
        format!("point => {install}")
    } else {
        "undefined".into()
    };
    let requirement = match requirement {
        ActionabilityRequirement::Check(true) => "check",
        ActionabilityRequirement::Check(false) => "uncheck",
        ActionabilityRequirement::Focus => "focus",
        ActionabilityRequirement::Editable => "editable",
        ActionabilityRequirement::Select => "select",
        _ => "pointer",
    };
    let value_action = value_script
        .map(|script| format!("() => JSON.parse({script})"))
        .unwrap_or_else(|| "undefined".into());
    let external = if external { ", true" } else { "" };
    format!(
        "(() => {{ {sampler}\nreturn waitForActionableSample((scroll) => JSON.parse({probe}), '{requirement}', {scroll}, {value_action}, {on_ready}{external}); }})()"
    )
}

fn drag_points_stable(previous: [f64; 4], current: [f64; 4]) -> bool {
    previous.iter().zip(current).all(|(before, after)| {
        before.is_finite() && after.is_finite() && (before - after).abs() <= 0.5
    })
}

type DragPositions = (Option<(f64, f64)>, Option<(f64, f64)>);

fn drag_position_literal(position: Option<(f64, f64)>) -> String {
    position.map_or("null".to_string(), |(x, y)| format!("[{x},{y}]"))
}

async fn read_drag_pair(
    webview: &Webview,
    source_ref: &str,
    target_ref: &str,
    scroll: bool,
    positions: DragPositions,
) -> Result<[f64; 4], String> {
    let source = deep_ref_expression(source_ref, "return el;");
    let destination = deep_ref_expression(target_ref, "return el;");
    let probe = include_str!("dragProbe.js");
    let source_position = drag_position_literal(positions.0);
    let target_position = drag_position_literal(positions.1);
    let script = format!(
        "(() => {{ const source = {source}; const destination = {destination}; const scroll = {scroll}; const sourcePosition = {source_position}; const targetPosition = {target_position}; {VISIBILITY_JS} {probe} }})()"
    );
    let response = ref_context::execute_main(webview, &script).await?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).map_err(|e| e.to_string())?;
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    let points: [f64; 4] =
        serde_json::from_value(parsed["points"].clone()).map_err(|e| e.to_string())?;
    if !points.iter().all(|point| point.is_finite()) {
        return Err("invalid drag coordinates".into());
    }
    Ok(points)
}

async fn wait_for_drag_pair(
    webview: &Webview,
    source_ref: &str,
    target_ref: &str,
    positions: DragPositions,
) -> Result<[f64; 4], (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut previous = None;
    let mut scroll = true;
    loop {
        let reason = match read_drag_pair(webview, source_ref, target_ref, scroll, positions).await
        {
            Ok(points) => {
                if previous.is_some_and(|before| drag_points_stable(before, points)) {
                    return Ok(points);
                }
                previous = Some(points);
                "drag endpoints are not stable".to_string()
            }
            Err(reason) => {
                if reason == "stale_ref" {
                    return Err((
                        error_codes::STALE_REF.to_string(),
                        "drag source or target is stale".into(),
                    ));
                }
                previous = None;
                reason
            }
        };
        scroll = false;
        if tokio::time::Instant::now() >= deadline {
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!("{reason}; no mouse button was pressed"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_actionable_ref(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    requirement: ActionabilityRequirement,
) -> Result<ActionableElement, (String, String)> {
    wait_for_actionable_attempt(webview, target, ref_id, requirement, None).await
}

async fn wait_for_value_action(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    requirement: ActionabilityRequirement,
    script: &str,
) -> Result<Value, (String, String)> {
    let result =
        wait_for_actionable_attempt(webview, target, ref_id, requirement, Some(script)).await?;
    result.value_result.ok_or_else(|| {
        (
            error_codes::CDP_FAILED.to_string(),
            "value action result unavailable; input is not retried".into(),
        )
    })
}

fn unchanged_check_sample(parsed: &Value, requirement: ActionabilityRequirement) -> bool {
    let ActionabilityRequirement::Check(requested) = requirement else {
        return false;
    };
    ["ok", "visible", "enabled", "receives"]
        .iter()
        .all(|key| parsed.get(key).and_then(Value::as_bool) == Some(true))
        && ["x", "y", "width", "height"].iter().all(|key| {
            parsed
                .get(key)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
        })
        && parsed.get("tag").and_then(Value::as_str) == Some("input")
        && matches!(parsed.get("inputType").and_then(Value::as_str), Some("checkbox") | Some("radio") if requested || parsed["inputType"] == "checkbox")
        && parsed.get("checked").and_then(Value::as_bool) == Some(requested)
}

async fn wait_for_actionable_attempt(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    requirement: ActionabilityRequirement,
    value_script: Option<&str>,
) -> Result<ActionableElement, (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let position = match requirement {
        ActionabilityRequirement::Hover(position) | ActionabilityRequirement::ClickAt(position) => {
            position
        }
        _ => None,
    };
    let external = matches!(webview, Webview::External { .. });
    let build = |scroll| match value_script {
        _ if external => {
            actionable_attempt_script(ref_id, scroll, position, requirement, value_script, true)
        }
        Some(value_script) => actionable_attempt_script(
            ref_id,
            scroll,
            position,
            requirement,
            Some(value_script),
            false,
        ),
        None => actionability_wait_script(ref_id, scroll, position, requirement),
    };
    let initial_script = build(true);
    let settled_script = build(false);
    let mut script = &initial_script;
    let frame_id = target
        .filter(|target| !target.is_main)
        .map(|target| target.frame_id.as_str());
    loop {
        let probe_started = tokio::time::Instant::now();
        let response = ref_context::execute_awaited(webview, frame_id, script)
            .await
            .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
        script = &settled_script;
        let decoded: String = serde_json::from_str(&response).unwrap_or(response);
        let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
        if parsed.get("error").and_then(Value::as_str) == Some("stale_ref") {
            return Err((
                error_codes::STALE_REF.to_string(),
                format!("element ref '{ref_id}' is stale or no longer valid (reason: {}); find the target again", ref_failure_reason(&parsed)),
            ));
        }
        let visible = parsed.get("visible").and_then(Value::as_bool) == Some(true);
        let enabled = parsed.get("enabled").and_then(Value::as_bool) == Some(true);
        let editable = parsed.get("editable").and_then(Value::as_bool) == Some(true);
        let receives = parsed.get("receives").and_then(Value::as_bool) == Some(true);
        // An already-focused editable element accepts typing even when it cannot be scrolled
        // into the viewport (canvas/terminal/remote-desktop hidden textareas); relax receives for it.
        let active = parsed.get("active").and_then(Value::as_bool) == Some(true);
        let rect = (
            parsed.get("x").and_then(Value::as_f64).unwrap_or_default(),
            parsed.get("y").and_then(Value::as_f64).unwrap_or_default(),
            parsed
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
            parsed
                .get("height")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
        );
        let stable = parsed.get("stable").and_then(Value::as_bool) == Some(true);
        let requirement_met = match requirement {
            ActionabilityRequirement::Click
            | ActionabilityRequirement::Check(_)
            | ActionabilityRequirement::ClickAt(_)
            | ActionabilityRequirement::Hover(_) => enabled && receives,
            ActionabilityRequirement::Focus | ActionabilityRequirement::Select => enabled,
            ActionabilityRequirement::Editable => editable && (receives || active),
        };
        let needs_stability = !matches!(
            requirement,
            ActionabilityRequirement::Editable | ActionabilityRequirement::Select
        ) && !unchanged_check_sample(&parsed, requirement);
        if visible && (stable || !needs_stability) && requirement_met {
            if target.is_none_or(|target| target.is_main) {
                super::activity::target(
                    parsed
                        .get("centerX")
                        .and_then(Value::as_f64)
                        .unwrap_or(rect.0),
                    parsed
                        .get("centerY")
                        .and_then(Value::as_f64)
                        .unwrap_or(rect.1),
                    rect.2,
                    rect.3,
                );
            } else {
                super::activity::stage("frame");
            }
            return Ok(ActionableElement {
                value_result: parsed.get("valueActionResult").cloned(),
                page_hidden: parsed.get("pageHidden").and_then(Value::as_bool) == Some(true),
                no_frames: parsed.get("noFrames").and_then(Value::as_bool) == Some(true),
                x: rect.0,
                y: rect.1,
                tag: parsed
                    .get("tag")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input_type: parsed
                    .get("inputType")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                checked: parsed.get("checked").and_then(Value::as_bool),
                draggable: parsed.get("draggable").and_then(Value::as_bool) == Some(true),
                popup_url: parsed["popupUrl"]
                    .as_str()
                    .filter(|url| {
                        url::Url::parse(url)
                            .ok()
                            .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
                    })
                    .map(str::to_owned),
            });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err((
                error_codes::TIMEOUT.to_string(),
                actionability_timeout_message(ref_id, &parsed, requirement),
            ));
        }
        tokio::time::sleep_until((probe_started + Duration::from_millis(100)).min(deadline)).await;
    }
}

async fn dom_click_ref(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    count: u8,
) -> Result<(), (String, String)> {
    super::activity::stage("frame");
    ref_context::ensure_focus(webview)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el) {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
            el.focus({{ preventScroll: true }});
            for (let index = 0; index < {count}; index++) {{
                if (refRegistry.resolve(refId) !== el) {{
                    return JSON.stringify({{ ok: false, error: 'stale_ref', reason: refRegistry.reason(refId), clicksDispatched: index }});
                }}
                el.click();
            }}
            if ({count} === 2) {{
                const rect = el.getBoundingClientRect();
                el.dispatchEvent(new MouseEvent('dblclick', {{
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    detail: 2,
                    view: window
                }}));
            }}
            return JSON.stringify({{ ok: true }});"#
        ),
    );
    let response = execute_ref_script(webview, target, &script)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        let dispatched = parsed
            .get("clicksDispatched")
            .and_then(as_count)
            .unwrap_or(0);
        Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid (reason: {}); {dispatched} click(s) already dispatched", ref_failure_reason(&parsed)),
        ))
    }
}

async fn wait_for_checked_state(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    expected: bool,
) -> Result<bool, (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let script = deep_ref_expression(
        ref_id,
        r#"
            if (!el) {
                return JSON.stringify({ ok: false, error: 'stale_ref' });
            }
            return JSON.stringify({ ok: true, checked: el.checked === true });"#,
    );
    loop {
        let response = execute_ref_script(webview, target, &script)
            .await
            .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
        let decoded: String = serde_json::from_str(&response).unwrap_or(response);
        let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
        if parsed.get("error").and_then(Value::as_str) == Some("stale_ref") {
            return Err((
                error_codes::STALE_REF.to_string(),
                format!("element ref '{ref_id}' changed before its checked state was verified"),
            ));
        }
        let checked = parsed
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if checked == expected {
            return Ok(checked);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!("element ref '{ref_id}' did not become checked={expected}"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn install_dialog_capture(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    accept: bool,
    prompt_text: &str,
) -> Result<(), (String, String)> {
    let script = format!(
        r#"(function() {{
            const key = '__anboDialogCapture';
            const previous = window[key];
            if (previous && previous.originals) {{
                window.alert = previous.originals.alert;
                window.confirm = previous.originals.confirm;
                window.prompt = previous.originals.prompt;
            }}
            const state = {{
                originals: {{
                    alert: window.alert,
                    confirm: window.confirm,
                    prompt: window.prompt
                }},
                result: null
            }};
            const record = (kind, message, defaultText) => {{
                state.result = {{
                    kind,
                    message: String(message == null ? '' : message).slice(0, 1000),
                    defaultText: String(defaultText == null ? '' : defaultText).slice(0, 500)
                }};
            }};
            window[key] = state;
            window.alert = message => {{ record('alert', message, ''); }};
            window.confirm = message => {{
                record('confirm', message, '');
                return {accept};
            }};
            window.prompt = (message, defaultText = '') => {{
                record('prompt', message, defaultText);
                return {prompt_result};
            }};
            return JSON.stringify({{ ok: true }});
            }})()"#,
        prompt_result = if accept {
            serde_json::to_string(prompt_text).unwrap()
        } else {
            "null".to_string()
        }
    );
    let response = execute_dialog_script(webview, target, &script)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err((
            error_codes::CDP_FAILED.to_string(),
            "could not prepare dialog capture".to_string(),
        ))
    }
}

async fn execute_dialog_script(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    script: &str,
) -> Result<String, String> {
    match target {
        Some(target) if !target.is_main => {
            evaluate_in_frame(webview, &target.frame_id, script).await
        }
        _ => execute_script(webview, script).await,
    }
}

async fn take_dialog_capture(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
) -> Result<Value, (String, String)> {
    let script = r#"(function() {
        const key = '__anboDialogCapture';
        const state = window[key];
        if (!state || !state.originals) {
            return JSON.stringify({ ok: false, error: 'capture_missing' });
        }
        window.alert = state.originals.alert;
        window.confirm = state.originals.confirm;
        window.prompt = state.originals.prompt;
        delete window[key];
        return JSON.stringify({ ok: true, dialog: state.result });
    })()"#;
    let response = execute_dialog_script(webview, target, script)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    parsed.get("dialog").cloned().ok_or_else(|| {
        (
            error_codes::CDP_FAILED.to_string(),
            "the triggered element did not open an alert, confirm, or prompt dialog".to_string(),
        )
    })
}

async fn dispatch_dom_drag(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    source_ref: &str,
    destination_ref: &str,
) -> Result<(), (String, String)> {
    let source_json = serde_json::to_string(source_ref).unwrap();
    let destination_json = serde_json::to_string(destination_ref).unwrap();
    let script = format!(
        r#"(function() {{
            {REF_REGISTRY_JS}
            const source = refRegistry.resolve({source_json});
            const destination = refRegistry.resolve({destination_json});
            if (!source || !destination) {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
            const dataTransfer = new DataTransfer();
            const fire = (element, type) => element.dispatchEvent(new DragEvent(type, {{
                bubbles: true,
                cancelable: true,
                dataTransfer
            }}));
            source.focus({{ preventScroll: true }});
            fire(source, 'dragstart');
            fire(destination, 'dragenter');
            fire(destination, 'dragover');
            fire(destination, 'drop');
            fire(source, 'dragend');
            return JSON.stringify({{ ok: true }});
        }})()"#
    );
    let response = execute_ref_script(webview, target, &script)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err((
            error_codes::STALE_REF.to_string(),
            "drag source or target is stale".to_string(),
        ))
    }
}

async fn click_ref(
    webview: &Webview,
    tab_id: i64,
    ref_id: &str,
) -> Result<&'static str, (String, String)> {
    click_ref_profiled(webview, tab_id, ref_id, 1, &mut ActionTimings::default())
        .await
        .map(|(dispatch, _)| dispatch)
}

async fn click_ref_profiled(
    webview: &Webview,
    tab_id: i64,
    ref_id: &str,
    count: u8,
    timings: &mut ActionTimings,
) -> Result<(&'static str, Option<String>), (String, String)> {
    let current_generation = get_current_generation(tab_id);
    ensure_current_ref(ref_id, current_generation)?;
    let target = get_ref_frame_target(tab_id, ref_id);
    let frame_dom_click = target.as_ref().is_some_and(|target| !target.is_main);
    let actionable = timings
        .measure(
            "actionability",
            wait_for_actionable_ref(
                webview,
                target.as_ref(),
                ref_id,
                ActionabilityRequirement::Click,
            ),
        )
        .await?;
    if frame_dom_click {
        timings
            .measure(
                "frameClick",
                dom_click_ref(webview, target.as_ref(), ref_id, count),
            )
            .await?;
        return Ok(("dom-frame", actionable.popup_url));
    }
    dispatch_mouse_click_profiled(webview, &actionable, ref_id, count, timings).await?;
    Ok(("devtools", actionable.popup_url))
}

/// browser_wait's own timeout next to waitFor fills in waitFor's when it has
/// none: that is where Kimi put it on every wait, and each was refused, which
/// cost a call to learn where it goes. waitFor's own timeout wins.
fn with_outer_timeout(wait_for: &Value, outer: Option<&Value>) -> Value {
    let mut wait_for = wait_for.clone();
    if let (Some(object), Some(outer)) = (wait_for.as_object_mut(), outer) {
        object.entry("timeout").or_insert_with(|| outer.clone());
    }
    wait_for
}

fn extract_click_count(params: &Value, double: bool) -> Result<u8, (String, String)> {
    match params.get("clickCount") {
        None => Ok(if double { 2 } else { 1 }),
        Some(value) => value
            .as_u64()
            .filter(|n| matches!(n, 1 | 2) && (!double || *n == 2))
            .map(|n| n as u8)
            .ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.into(),
                    "clickCount must be 1 or 2 (2 for the double-click alias)".into(),
                )
            }),
    }
}

fn build_wait_for_text_js(text: &str) -> String {
    format!(
        r#"(function() {{
            const needle = {};
            {READABLE_TEXT_JS}
            if (pageTextIncludes(needle)) return true;
            const wanted = normalizeLoose(needle);
            const candidates = document.querySelectorAll('[aria-label],[placeholder],[alt],[title]');
            const limit = Math.min(candidates.length, 2000);
            for (let i = 0; i < limit; i++) {{
                const el = candidates[i];
                const values = [
                    el.getAttribute('aria-label'),
                    el.getAttribute('placeholder'),
                    el.getAttribute('alt'),
                    el.getAttribute('title')
                ];
                if (values.some(value => value && normalizeLoose(value).includes(wanted))) return true;
            }}
            return false;
        }})()"#,
        serde_json::to_string(text).unwrap()
    )
}

async fn wait_for_page_state(
    webview: &Webview,
    tab_id: i64,
    expectation: &PageExpectation,
) -> Result<Value, (String, String)> {
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_millis(expectation.timeout);
    let script = expectation.script();
    let lock = get_tab_lock(tab_id);
    let mut stable = StableMatch::default();
    let mut first_match: Option<u64> = None;
    let mut navigation = active_navigation_generation(tab_id);
    while tokio::time::Instant::now() < deadline {
        let mut matched = tokio::time::timeout_at(deadline, async {
            let _guard = lock.lock().await;
            if expectation.uses_native_title() {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let native_matches =
                    super::cdp::read_page_info(webview, remaining.min(SCRIPT_POLL_TIMEOUT))
                        .await
                        .is_ok_and(|(title, _)| expectation.matches_native_title(&title));
                if !native_matches || !expectation.needs_document() {
                    return native_matches;
                }
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            execute_script_with_timeout(webview, &script, remaining.min(Duration::from_millis(750)))
                .await
                .is_ok_and(|value| value.trim() == "true")
        })
        .await
        .unwrap_or(false);
        let current_navigation = active_navigation_generation(tab_id);
        if current_navigation != navigation {
            stable.observe(false, started.elapsed(), Duration::ZERO);
            navigation = current_navigation;
            matched = false;
        }
        if matched {
            first_match.get_or_insert(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        }
        if stable.observe(
            matched,
            started.elapsed(),
            Duration::from_millis(expectation.stable_for),
        ) {
            return Ok(
                json!({"matched":true, "stable":true, "stableForMs":expectation.stable_for, "durationMs":started.elapsed().as_millis().min(u64::MAX as u128) as u64}),
            );
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(100)).min(deadline),
        )
        .await;
    }
    let duration = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if let Some(at) = first_match {
        // The condition did hold, so the action's effect was seen; only the
        // stability window never closed. On a live page -- a price in the
        // title, a ticker, an advert -- that is the page's nature, not a failed
        // action, and reporting it as a timeout sent agents back to repeat
        // clicks that had already worked. Nine of fifteen agent-driven tasks
        // paid that timeout before this was measured.
        return Ok(json!({
            "matched": true,
            "stable": false,
            "firstMatchedAtMs": at,
            "durationMs": duration,
            "note": "the condition matched but the page kept changing; the action was not repeated"
        }));
    }
    // Never matched: say what the page showed instead, so the next wait can
    // be aimed at the real title or URL rather than guessed again.
    let seen = observe_page_identity(webview).await;
    Err((
        error_codes::TIMEOUT.to_string(),
        format!(
            "expected page state never matched within {}ms{}; the action was not repeated",
            expectation.timeout,
            seen.map(|(title, url)| format!(" (page showed title {title:?} at {url})"))
                .unwrap_or_default()
        ),
    ))
}

/// The page's own title and URL, for an error message that says what was
/// there instead of what was expected. Best effort and bounded: a page that
/// cannot answer in half a second gets no detail rather than a slower error.
async fn observe_page_identity(webview: &Webview) -> Option<(String, String)> {
    let script = "JSON.stringify({title: String(document.title || '').slice(0, 200), url: String(location.href || '').slice(0, 500)})";
    let raw = execute_script_with_timeout(webview, script, Duration::from_millis(500))
        .await
        .ok()?;
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let value: Value = match value {
        Value::String(inner) => serde_json::from_str(&inner).ok()?,
        other => other,
    };
    Some((
        value.get("title")?.as_str()?.to_string(),
        value.get("url")?.as_str()?.to_string(),
    ))
}

enum WaitCondition {
    Text(String),
    Url(String),
    Load { state: String },
    Ref { ref_id: String, state: String },
}

impl WaitCondition {
    fn kind(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Url(_) => "url",
            Self::Load { .. } => "load",
            Self::Ref { .. } => "ref",
        }
    }

    fn state_label(&self) -> &str {
        match self {
            Self::Text(text) | Self::Url(text) => text,
            Self::Load { state } => state,
            Self::Ref { state, .. } => state,
        }
    }
}

fn extract_wait_condition(params: &Value) -> Result<WaitCondition, (String, String)> {
    let inferred = if params.get("text").is_some() {
        "text"
    } else if params.get("url").is_some() {
        "url"
    } else if params.get("ref").is_some() {
        "ref"
    } else if params.get("loadState").is_some() {
        "load"
    } else {
        ""
    };
    let condition = params
        .get("condition")
        .and_then(Value::as_str)
        .unwrap_or(inferred);
    match condition {
        "text" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "text wait requires a non-empty 'text'".to_string(),
                    )
                })?;
            ensure_bounded(text, MAX_WAIT_TEXT_BYTES, "text")?;
            Ok(WaitCondition::Text(text.to_string()))
        }
        "url" => {
            let url = params
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    (
                        error_codes::INVALID_REQUEST.to_string(),
                        "URL wait requires a non-empty 'url'".to_string(),
                    )
                })?;
            ensure_bounded(url, MAX_URL_BYTES, "url")?;
            Ok(WaitCondition::Url(url.to_string()))
        }
        "load" => {
            let state = params
                .get("loadState")
                .and_then(Value::as_str)
                .unwrap_or("complete");
            if !matches!(state, "interactive" | "complete" | "networkIdle") {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("unsupported load state '{state}'"),
                ));
            }
            Ok(WaitCondition::Load {
                state: state.to_string(),
            })
        }
        "ref" => {
            let ref_id = extract_ref(params)?;
            let state = params
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("visible");
            if !matches!(
                state,
                "attached"
                    | "detached"
                    | "visible"
                    | "hidden"
                    | "enabled"
                    | "disabled"
                    | "checked"
                    | "unchecked"
            ) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("unsupported ref state '{state}'"),
                ));
            }
            Ok(WaitCondition::Ref {
                ref_id,
                state: state.to_string(),
            })
        }
        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            "browser_wait requires text, url, loadState, or ref/state".to_string(),
        )),
    }
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == value;
    }
    let starts_anchored = !pattern.starts_with('*');
    let ends_anchored = !pattern.ends_with('*');
    let parts = pattern
        .split('*')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return true;
    }
    let mut offset = 0usize;
    for (index, part) in parts.iter().enumerate() {
        let Some(found) = value[offset..].find(part) else {
            return false;
        };
        if index == 0 && starts_anchored && found != 0 {
            return false;
        }
        offset += found + part.len();
    }
    !ends_anchored || value.ends_with(parts.last().copied().unwrap_or_default())
}

fn build_ref_state_js(ref_id: &str, state: &str) -> String {
    deep_ref_expression(
        ref_id,
        &format!(
            r#"
            const current = el || null;
            if ({state} === 'detached') return !current || !current.isConnected;
            {VISIBILITY_JS}
            if ({state} === 'hidden') return !isRenderedElement(current);
            if (!current || !current.isConnected) return false;
            const visible = isRenderedElement(current);
            const enabled = !(current.disabled || current.getAttribute('aria-disabled') === 'true');
            if ({state} === 'attached') return true;
            if ({state} === 'visible') return visible;
            if ({state} === 'enabled') return enabled;
            if ({state} === 'disabled') return !enabled;
            const nativeCheck = current.tagName === 'INPUT' && ['checkbox','radio'].includes(current.type);
            const checked = nativeCheck ? (current.indeterminate ? null : current.checked) : (current.getAttribute('aria-checked') === 'true' ? true : current.getAttribute('aria-checked') === 'false' ? false : null);
            if ({state} === 'checked') return checked === true;
            if ({state} === 'unchecked') return checked === false;
            return false;"#,
            state = serde_json::to_string(state).unwrap()
        ),
    )
}

async fn wait_condition_matches(
    webview: &Webview,
    tab_id: i64,
    condition: &WaitCondition,
    deadline: tokio::time::Instant,
    poll_timeout: Duration,
) -> Result<bool, (String, String)> {
    match condition {
        WaitCondition::Text(text) => {
            let script = build_wait_for_text_js(text);
            let main = execute_script_with_timeout(webview, &script, poll_timeout)
                .await
                .unwrap_or_default();
            if main.trim() == "true" {
                Ok(true)
            } else {
                Ok(wait_text_in_child_frames(webview, &script, deadline).await)
            }
        }
        WaitCondition::Url(pattern) => {
            let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
            Ok(glob_matches(pattern, &url))
        }
        WaitCondition::Load { state } => {
            if state == "networkIdle" {
                return super::network::is_idle(tab_id)
                    .map(|idle| idle && active_loading(tab_id) == Some(false))
                    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error));
            }
            let ready = execute_script_with_timeout(webview, "document.readyState", poll_timeout)
                .await
                .unwrap_or_default();
            let ready = ready.trim_matches('"');
            Ok(match state.as_str() {
                "interactive" => matches!(ready, "interactive" | "complete"),
                "complete" => ready == "complete",
                _ => false,
            })
        }
        WaitCondition::Ref { ref_id, state } => {
            let generation = get_current_generation(tab_id);
            ensure_current_ref(ref_id, generation)?;
            let target = get_ref_frame_target(tab_id, ref_id);
            let script = build_ref_state_js(ref_id, state);
            let result = execute_ref_script(webview, target.as_ref(), &script)
                .await
                .unwrap_or_default();
            Ok(result.trim() == "true")
        }
    }
}

async fn wait_text_in_child_frames(
    webview: &Webview,
    script: &str,
    deadline: tokio::time::Instant,
) -> bool {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let frame_tree_timeout = remaining.min(Duration::from_millis(750));
    let Ok(Ok((frame_ids, _))) =
        tokio::time::timeout(frame_tree_timeout, get_frame_ids(webview)).await
    else {
        return false;
    };
    stream::iter(frame_ids.into_iter().skip(1))
        .map(|frame_id| async move {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let frame_timeout = remaining.min(Duration::from_millis(750));
            tokio::time::timeout(frame_timeout, evaluate_in_frame(webview, &frame_id, script))
                .await
                .is_ok_and(|result| result.is_ok_and(|value| value.trim() == "true"))
        })
        .buffer_unordered(FRAME_CONCURRENCY)
        .any(|matched| async move { matched })
        .await
}

fn decode_screenshot_response(response: &str) -> Result<Vec<u8>, String> {
    if response.len() > MAX_SCREENSHOT_RESPONSE_BYTES {
        return Err("screenshot response exceeds 64 MiB".to_string());
    }
    let payload: Value = serde_json::from_str(response)
        .map_err(|error| format!("invalid screenshot response: {error}"))?;
    if let Some(error) = payload.get("error") {
        return Err(format!("screenshot protocol error: {error}"));
    }
    let data = payload
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "screenshot response omitted image data".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("invalid screenshot image data: {error}"))
}

fn key_event_params(event_type: &str, key: &str, modifiers: u8) -> Value {
    let shifted;
    let key = if modifiers & 8 != 0 && key.len() == 1 {
        let character = key.as_bytes()[0];
        let plain = b"`1234567890-=[]\\;',./";
        let upper = b"~!@#$%^&*()_+{}|:\"<>?";
        shifted = if character.is_ascii_lowercase() {
            (character.to_ascii_uppercase() as char).to_string()
        } else if let Some(index) = plain.iter().position(|value| *value == character) {
            (upper[index] as char).to_string()
        } else {
            key.to_string()
        };
        shifted.as_str()
    } else {
        key
    };
    let (key_name, code, virtual_key, text, shift) = match key {
        "Shift" => ("Shift".into(), "ShiftLeft".into(), 16, None, false),
        "Control" | "Ctrl" => ("Control".into(), "ControlLeft".into(), 17, None, false),
        "Alt" => ("Alt".into(), "AltLeft".into(), 18, None, false),
        "Meta" => ("Meta".into(), "MetaLeft".into(), 91, None, false),
        "Enter" => (
            "Enter".to_string(),
            "Enter".to_string(),
            13,
            Some("\r"),
            false,
        ),
        "Tab" => ("Tab".to_string(), "Tab".to_string(), 9, None, false),
        "Escape" | "Esc" => ("Escape".to_string(), "Escape".to_string(), 27, None, false),
        "Backspace" => (
            "Backspace".to_string(),
            "Backspace".to_string(),
            8,
            None,
            false,
        ),
        "Delete" => ("Delete".to_string(), "Delete".to_string(), 46, None, false),
        "ArrowLeft" => (
            "ArrowLeft".to_string(),
            "ArrowLeft".to_string(),
            37,
            None,
            false,
        ),
        "ArrowUp" => (
            "ArrowUp".to_string(),
            "ArrowUp".to_string(),
            38,
            None,
            false,
        ),
        "ArrowRight" => (
            "ArrowRight".to_string(),
            "ArrowRight".to_string(),
            39,
            None,
            false,
        ),
        "ArrowDown" => (
            "ArrowDown".to_string(),
            "ArrowDown".to_string(),
            40,
            None,
            false,
        ),
        "Home" => ("Home".to_string(), "Home".to_string(), 36, None, false),
        "End" => ("End".to_string(), "End".to_string(), 35, None, false),
        "PageUp" => ("PageUp".to_string(), "PageUp".to_string(), 33, None, false),
        "PageDown" => (
            "PageDown".to_string(),
            "PageDown".to_string(),
            34,
            None,
            false,
        ),
        "Space" | " " => (" ".to_string(), "Space".to_string(), 32, Some(" "), false),
        _ if key.chars().count() == 1 => {
            let character = key.chars().next().unwrap();
            let upper = character.to_ascii_uppercase();
            let (code, virtual_key, shift) = if upper.is_ascii_alphabetic() {
                (
                    format!("Key{upper}"),
                    i64::from(upper as u32),
                    character.is_ascii_uppercase(),
                )
            } else if upper.is_ascii_digit() {
                (format!("Digit{upper}"), i64::from(upper as u32), false)
            } else {
                match character {
                    '!' => ("Digit1".into(), 49, true),
                    '@' => ("Digit2".into(), 50, true),
                    '#' => ("Digit3".into(), 51, true),
                    '$' => ("Digit4".into(), 52, true),
                    '%' => ("Digit5".into(), 53, true),
                    '^' => ("Digit6".into(), 54, true),
                    '&' => ("Digit7".into(), 55, true),
                    '*' => ("Digit8".into(), 56, true),
                    '(' => ("Digit9".into(), 57, true),
                    ')' => ("Digit0".into(), 48, true),
                    '-' => ("Minus".into(), 189, false),
                    '_' => ("Minus".into(), 189, true),
                    '=' => ("Equal".into(), 187, false),
                    '+' => ("Equal".into(), 187, true),
                    '[' => ("BracketLeft".into(), 219, false),
                    '{' => ("BracketLeft".into(), 219, true),
                    ']' => ("BracketRight".into(), 221, false),
                    '}' => ("BracketRight".into(), 221, true),
                    '\\' => ("Backslash".into(), 220, false),
                    '|' => ("Backslash".into(), 220, true),
                    ';' => ("Semicolon".into(), 186, false),
                    ':' => ("Semicolon".into(), 186, true),
                    '\'' => ("Quote".into(), 222, false),
                    '"' => ("Quote".into(), 222, true),
                    ',' => ("Comma".into(), 188, false),
                    '<' => ("Comma".into(), 188, true),
                    '.' => ("Period".into(), 190, false),
                    '>' => ("Period".into(), 190, true),
                    '/' => ("Slash".into(), 191, false),
                    '?' => ("Slash".into(), 191, true),
                    '`' => ("Backquote".into(), 192, false),
                    '~' => ("Backquote".into(), 192, true),
                    _ => (String::new(), 0, false),
                }
            };
            (key.to_string(), code, virtual_key, Some(key), shift)
        }
        _ => (key.to_string(), key.to_string(), 0, None, false),
    };
    let mut params = json!({
        "type": event_type,
        "key": key_name,
        "code": code,
        "windowsVirtualKeyCode": virtual_key,
        "nativeVirtualKeyCode": virtual_key
    });
    let modifiers = modifiers | if shift { 8 } else { 0 };
    if modifiers != 0 {
        params["modifiers"] = Value::from(modifiers);
    }
    if event_type != "keyUp" && modifiers & 7 == 0 {
        if let Some(text) = text {
            params["text"] = Value::String(text.to_string());
            params["unmodifiedText"] = Value::String(text.to_string());
        }
    }
    params
}

fn mouse_event_params(event_type: &str, x: f64, y: f64, pressed: bool, click_count: u8) -> Value {
    json!({
        "type": event_type,
        "x": x,
        "y": y,
        "button": if event_type == "mouseMoved" { "none" } else { "left" },
        "buttons": if pressed { 1 } else { 0 },
        "clickCount": if event_type == "mouseMoved" { 0 } else { click_count },
        "pointerType": "mouse"
    })
}

async fn dispatch_mouse_click(
    webview: &Webview,
    actionable: &ActionableElement,
    ref_id: &str,
    click_count: u8,
) -> Result<(), (String, String)> {
    dispatch_mouse_click_profiled(
        webview,
        actionable,
        ref_id,
        click_count,
        &mut ActionTimings::default(),
    )
    .await
}

async fn dispatch_mouse_click_profiled(
    webview: &Webview,
    actionable: &ActionableElement,
    ref_id: &str,
    click_count: u8,
    timings: &mut ActionTimings,
) -> Result<(), (String, String)> {
    let (x, y) = (actionable.x, actionable.y);
    if actionable.page_hidden {
        return Err((
            error_codes::INPUT_NOT_READY.to_string(),
            format!("{HIDDEN_TAB} No input was sent."),
        ));
    }
    // A page that draws no frames answers a move only when it next draws, which
    // a covered or locked browser may not do before the command expires and the
    // tab is released. Mouse-down moves the pointer there itself.
    if !actionable.no_frames {
        dispatch_mouse_move_profiled(webview, x, y, timings)
            .await
            .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    }
    for count in 1..=click_count.max(1) {
        let script = deep_ref_expression(
            ref_id,
            &format!(
                "const x = {x}; const y = {y}; {} {VISIBILITY_JS} {}",
                include_str!("actionRect.js"),
                include_str!("pointerGuard.js"),
            ),
        );
        let response = timings
            .measure("pointerGuard", ref_context::execute_main(webview, &script))
            .await
            .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
        let guard: Value = serde_json::from_str(&response).unwrap_or_default();
        if guard.get("ok").and_then(Value::as_bool) != Some(true) {
            let stale = guard.get("error").and_then(Value::as_str) == Some("stale_ref");
            let reason = if stale {
                ref_failure_reason(&guard)
            } else {
                guard
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|reason| matches!(*reason, "hidden" | "disabled" | "moved" | "covered"))
                    .unwrap_or("unavailable")
            };
            return Err((
                if stale { error_codes::STALE_REF } else { error_codes::INPUT_NOT_READY }.to_string(),
                format!("element ref '{ref_id}' changed before mouse-down (reason: {reason}); {} click(s) already dispatched; inspect the target before retrying", count - 1),
            ));
        }
        for (event_type, pressed) in [("mousePressed", true), ("mouseReleased", false)] {
            let params = mouse_event_params(event_type, x, y, pressed, count).to_string();
            if let Err(error) = timings
                .measure(
                    if pressed { "mouseDown" } else { "mouseUp" },
                    call_devtools_protocol_method(
                        webview,
                        "Input.dispatchMouseEvent",
                        &params,
                        Duration::from_secs(5),
                    ),
                )
                .await
            {
                if event_type == "mousePressed" {
                    let release =
                        mouse_event_params("mouseReleased", x, y, false, count).to_string();
                    let _ = call_devtools_protocol_method(
                        webview,
                        "Input.dispatchMouseEvent",
                        &release,
                        SCRIPT_POLL_TIMEOUT,
                    )
                    .await;
                }
                return Err((error_codes::CDP_FAILED.to_string(), error));
            }
            if !pressed {
                super::activity::pointer("click", x, y);
            }
        }
    }
    Ok(())
}

async fn dispatch_mouse_move(webview: &Webview, x: f64, y: f64) -> Result<(), String> {
    super::activity::pointer("move", x, y);
    ref_context::ensure_focus(webview).await?;
    call_devtools_protocol_method(
        webview,
        "Input.dispatchMouseEvent",
        &mouse_event_params("mouseMoved", x, y, false, 0).to_string(),
        Duration::from_secs(5),
    )
    .await
    .map(|_| ())
}

async fn dispatch_mouse_move_profiled(
    webview: &Webview,
    x: f64,
    y: f64,
    timings: &mut ActionTimings,
) -> Result<(), String> {
    super::activity::pointer("move", x, y);
    timings
        .measure("focusEmulation", ref_context::ensure_focus(webview))
        .await?;
    let moved = mouse_event_params("mouseMoved", x, y, false, 0).to_string();
    timings
        .measure(
            "mouseMove",
            call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &moved, 2),
        )
        .await
        .map(|_| ())
}

async fn dispatch_mouse_drag(
    webview: &Webview,
    pair: [f64; 4],
    source_ref: &str,
    target_ref: &str,
    positions: DragPositions,
) -> Result<(), String> {
    let [source_x, source_y, target_x, target_y] = pair;
    ref_context::ensure_focus(webview).await?;
    let start = mouse_event_params("mouseMoved", source_x, source_y, false, 0).to_string();
    call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &start, 2).await?;
    let current = read_drag_pair(webview, source_ref, target_ref, false, positions).await?;
    if !drag_points_stable(pair, current) {
        return Err("drag geometry changed before press; no mouse button was pressed".into());
    }
    super::activity::pointer("move", source_x, source_y);
    let press = mouse_event_params("mousePressed", source_x, source_y, true, 1).to_string();
    call_devtools_protocol_method(
        webview,
        "Input.dispatchMouseEvent",
        &press,
        Duration::from_secs(5),
    )
    .await?;
    let result = async {
        for step in 1..=8 {
            let progress = f64::from(step) / 8.0;
            let x = source_x + (target_x - source_x) * progress;
            let y = source_y + (target_y - source_y) * progress;
            super::activity::pointer("move", x, y);
            let moved = mouse_event_params("mouseMoved", x, y, true, 0).to_string();
            call_devtools_protocol_method(
                webview,
                "Input.dispatchMouseEvent",
                &moved,
                SCRIPT_POLL_TIMEOUT,
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
        Ok::<(), String>(())
    }
    .await;
    let release = mouse_event_params("mouseReleased", target_x, target_y, false, 1).to_string();
    let release_result = call_devtools_protocol_method(
        webview,
        "Input.dispatchMouseEvent",
        &release,
        Duration::from_secs(5),
    )
    .await;
    result?;
    release_result.map(|_| ())
}

async fn call_devtools_with_retry(
    webview: &Webview,
    method: &str,
    params: &str,
    attempts: usize,
) -> Result<String, String> {
    let mut last_error = String::new();
    for attempt in 0..attempts.max(1) {
        match call_devtools_protocol_method(webview, method, params, SCRIPT_POLL_TIMEOUT).await {
            Ok(result) => return Ok(result),
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    Err(last_error)
}

async fn dispatch_key(
    webview: &Webview,
    key: &str,
    action: &str,
    modifiers: u8,
    timings: &mut ActionTimings,
) -> Result<(), String> {
    // The caller prepares focus and optionally verifies the input first.
    if matches!(action, "press" | "down") {
        let down = key_event_params("keyDown", key, modifiers).to_string();
        timings
            .measure(
                "keyDown",
                call_devtools_protocol_method(
                    webview,
                    "Input.dispatchKeyEvent",
                    &down,
                    SCRIPT_POLL_TIMEOUT,
                ),
            )
            .await?;
    }
    if matches!(action, "press" | "up") {
        let up = key_event_params("keyUp", key, modifiers).to_string();
        timings
            .measure(
                "keyUp",
                call_devtools_protocol_method(
                    webview,
                    "Input.dispatchKeyEvent",
                    &up,
                    SCRIPT_POLL_TIMEOUT,
                ),
            )
            .await?;
    }
    Ok(())
}

async fn dispatch_key_action(
    webview: &Webview,
    key: &str,
    action: &str,
    modifiers: u8,
) -> Result<(), String> {
    ref_context::settle_before_keys(webview).await;
    ref_context::ensure_focus(webview).await?;
    if matches!(action, "press" | "down") {
        let down = key_event_params("keyDown", key, modifiers).to_string();
        call_devtools_protocol_method(
            webview,
            "Input.dispatchKeyEvent",
            &down,
            SCRIPT_POLL_TIMEOUT,
        )
        .await?;
    }
    if matches!(action, "press" | "up") {
        let up = key_event_params("keyUp", key, modifiers).to_string();
        call_devtools_protocol_method(webview, "Input.dispatchKeyEvent", &up, SCRIPT_POLL_TIMEOUT)
            .await?;
    }
    Ok(())
}

fn extract_key_modifiers(params: &Value) -> Result<u8, (String, String)> {
    let Some(modifiers) = params.get("modifiers") else {
        return Ok(0);
    };
    let values = modifiers.as_array().ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            "'modifiers' must be an array".to_string(),
        )
    })?;
    if values.len() > 4 {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "'modifiers' accepts at most four values".to_string(),
        ));
    }
    let mut mask = 0u8;
    for value in values {
        let name = value.as_str().ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "every modifier must be a string".to_string(),
            )
        })?;
        mask |= match name {
            "Alt" => 1,
            "Control" => 2,
            "Meta" => 4,
            "Shift" => 8,
            _ => {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("unsupported keyboard modifier '{name}'"),
                ));
            }
        };
    }
    Ok(mask)
}

fn extract_key_action(params: &Value) -> Result<&str, (String, String)> {
    match params.get("keyAction") {
        None => Ok("press"),
        Some(value) => value
            .as_str()
            .filter(|action| matches!(*action, "press" | "down" | "up"))
            .ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.into(),
                    "keyAction must be press, down, or up".into(),
                )
            }),
    }
}

fn modifier_names(mask: u8) -> Vec<&'static str> {
    [(1, "Alt"), (2, "Control"), (4, "Meta"), (8, "Shift")]
        .into_iter()
        .filter_map(|(bit, name)| (mask & bit != 0).then_some(name))
        .collect()
}

async fn current_url(webview: &Webview) -> Result<String, String> {
    let raw =
        execute_script_with_timeout(webview, "window.location.href", SCRIPT_POLL_TIMEOUT).await?;
    serde_json::from_str::<String>(&raw).map_err(|error| format!("invalid URL result: {error}"))
}

#[derive(Default)]
struct SubmissionObservation {
    submit_event: bool,
    navigation: bool,
}

fn submission_observer_script(observation_id: u64, timeout_ms: u64) -> String {
    format!(
        r#"(() => {{
        const key = '{observation_id}';
        const observations = window.__anboSubmitObservations ||= {{}};
        const state = {{ submitted: false }};
        state.listener = () => {{ state.submitted = true; }};
        state.cleanup = () => {{
            document.removeEventListener('submit', state.listener, true);
            clearTimeout(state.timer);
            if (observations[key] === state) delete observations[key];
        }};
        observations[key] = state;
        document.addEventListener('submit', state.listener, {{ capture: true, once: true }});
        state.timer = setTimeout(state.cleanup, {lifetime_ms});
        return true;
    }})()"#,
        lifetime_ms = timeout_ms.saturating_add(10_000)
    )
}

fn submission_cleanup_script(observation_id: u64) -> String {
    format!("window.__anboSubmitObservations?.['{observation_id}']?.cleanup();true")
}

async fn cleanup_submission_observer(webview: &Webview, observation_id: u64) {
    let _ = execute_script_with_timeout(
        webview,
        &submission_cleanup_script(observation_id),
        Duration::from_millis(250),
    )
    .await;
}

async fn observe_submission(
    webview: &Webview,
    tab_id: i64,
    before_url: &str,
    before_navigation_generation: u64,
    observation_id: u64,
    timeout_ms: u64,
) -> SubmissionObservation {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut observation = SubmissionObservation::default();
    let marker = serde_json::to_string(&observation_id.to_string()).unwrap();
    let observed_script = format!("window.__anboSubmitObservations?.[{marker}]?.submitted===true");
    let mut submit_since: Option<tokio::time::Instant> = None;
    while tokio::time::Instant::now() < deadline {
        if active_navigation_generation(tab_id)
            .is_some_and(|generation| generation != before_navigation_generation)
        {
            observation.navigation = true;
            break;
        }
        if webview
            .url()
            .is_ok_and(|url| !before_url.is_empty() && url.as_str() != before_url)
        {
            observation.navigation = true;
            break;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if execute_script_with_timeout(
            webview,
            &observed_script,
            remaining.min(Duration::from_millis(500)),
        )
        .await
        .is_ok_and(|value| value.trim() == "true")
        {
            observation.submit_event = true;
        }
        if observation.submit_event {
            // A submit almost always navigates; the commit only lags the
            // event. Breaking on the event alone read the old document, and
            // every measured agent then waited by hand before reading
            // anything. Give the commit a moment before trusting the event.
            let since = *submit_since.get_or_insert(tokio::time::Instant::now());
            if tokio::time::Instant::now() - since >= Duration::from_millis(1_200) {
                break;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(100)).min(deadline),
        )
        .await;
    }
    cleanup_submission_observer(webview, observation_id).await;
    observation
}

async fn request_browser_tabs_metadata(app: &AppHandle) -> Option<BrowserTabsResponse> {
    let request_id = format!(
        "{}-{}",
        std::process::id(),
        OPEN_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let response_event = format!("{BROWSER_TABS_RESPONSE_EVENT}:{request_id}");
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let listener_id = app.once(response_event, move |event| {
        let _ = sender.send(event.payload().to_string());
    });
    if app
        .emit(
            BROWSER_TABS_REQUEST_EVENT,
            json!({ "requestId": request_id }),
        )
        .is_err()
    {
        app.unlisten(listener_id);
        return None;
    }
    let received = tokio::time::timeout(Duration::from_secs(2), receiver).await;
    app.unlisten(listener_id);
    let payload = received.ok()?.ok()?;
    serde_json::from_str(&payload).ok()
}

fn open_read_request(params: &Value) -> Result<Option<(&'static str, Value)>, (String, String)> {
    let invalid = || {
        (error_codes::INVALID_REQUEST.into(), "open accepts either find:{by,value,...} or snapshot:true; closeTab:true requires one and only closes the new tab after a successful read".into())
    };
    for key in ["snapshot", "closeTab"] {
        if params.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(invalid());
        }
    }
    let read = if let Some(find) = params.get("find") {
        let object = find.as_object().ok_or_else(invalid)?;
        if params["snapshot"] == true
            || object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "by" | "value"
                        | "name"
                        | "exact"
                        | "includeHidden"
                        | "limit"
                        | "ancestors"
                        | "timeout"
                )
            })
        {
            return Err(invalid());
        }
        extract_locator(find)?;
        let mut find = find.clone();
        // The read always hands its find a timeout, what is left of its own
        // budget, so it says whether the caller wrote one: only then does the
        // find wait out a settled absence.
        find["callerTimeout"] = json!(find.get("timeout").is_some());
        find["timeout"] = json!(find
            .get("timeout")
            .and_then(as_count)
            .unwrap_or(5000)
            .clamp(100, 10000));
        Some(("find", find))
    } else if params["snapshot"] == true {
        Some(("snapshot", json!({})))
    } else {
        None
    };
    if params["closeTab"] == true && read.is_none() {
        return Err(invalid());
    }
    Ok(read)
}

/// A snapshot that goes on past this read still holds what the caller came
/// for: agy's snapshot of a Wikipedia article stopped at item 254, closeTab
/// closed the tab with it, and the next read had to open the page again.
fn read_lets_tab_close(method: &str, read: &Value) -> bool {
    method != "snapshot" || read["nextOffset"].is_null()
}

async fn initial_document(
    webview: &Webview,
    tab_id: i64,
    deadline: tokio::time::Instant,
) -> Result<(u64, String), (String, String)> {
    use super::initial_read::{DocumentProbe, PROBE_JS};
    loop {
        let navigation = active_navigation_generation(tab_id).ok_or_else(|| {
            (
                error_codes::TAB_NOT_FOUND.into(),
                "initial read tab was closed".into(),
            )
        })?;
        if tokio::time::Instant::now() >= deadline {
            return Err(initial_read_timeout("document commit/readiness"));
        }
        if navigation > 0 {
            let native_url = read_url(webview, Duration::from_millis(300)).await;
            if let Ok(native_url) = native_url {
                let raw =
                    execute_script_with_timeout(webview, PROBE_JS, Duration::from_millis(300))
                        .await;
                let probe = raw
                    .ok()
                    .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
                    .and_then(|raw| serde_json::from_str::<DocumentProbe>(&raw).ok());
                if let Some(probe) = probe.filter(|probe| {
                    probe.is_committed(
                        &native_url,
                        navigation,
                        active_navigation_generation(tab_id),
                    )
                }) {
                    return Ok((navigation, probe.url));
                }
            }
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(50)).min(deadline),
        )
        .await;
    }
}

/// Single-page apps draw their content after the document is ready: an open
/// with snapshot:true read YouTube's results page with 6 items and Maps' place
/// page with 3, and the agent waited and took the snapshot again. The read
/// waits while the page is still growing, for up to LANDING_PATIENCE; a page
/// whose shape holds across one look answers after that look.
async fn settle_rendering(webview: &Webview, deadline: tokio::time::Instant) {
    const LOOK: Duration = Duration::from_millis(300);
    let cap = (tokio::time::Instant::now() + LANDING_PATIENCE).min(deadline);
    let mut previous = page_scan_state(webview).await;
    while tokio::time::Instant::now() < cap {
        tokio::time::sleep_until((tokio::time::Instant::now() + LOOK).min(cap)).await;
        let current = page_scan_state(webview).await;
        if previous
            .as_ref()
            .zip(current.as_ref())
            .is_some_and(|(before, now)| before.same_structure(now))
        {
            return;
        }
        previous = current;
    }
}

fn initial_read_timeout(phase: &str) -> (String, String) {
    (
        error_codes::TIMEOUT.into(),
        format!(
            "initial read deadline expired during {phase}; the new tab remains open for recovery"
        ),
    )
}

async fn read_initial_page(
    app: &AppHandle,
    method: &str,
    mut params: Value,
    timings: &mut ActionTimings,
    caller: &super::caller::Caller,
) -> Result<Value, (String, String)> {
    use super::initial_read::{retry_read_error, EMPTY_GRACE, MAX_RECOVERIES, SNAPSHOT_TIMEOUT};
    let tab_id = extract_tab_id(&params)?;
    let webview = get_embed_webview(app, tab_id)
        .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
    let budget = params
        .get("timeout")
        .and_then(as_count)
        .map(Duration::from_millis)
        .unwrap_or(SNAPSHOT_TIMEOUT);
    let deadline = tokio::time::Instant::now() + budget;
    let mut phase = "document commit/readiness";
    let result = tokio::time::timeout_at(deadline, async {
        let mut recoveries = 0;
        let mut empty_since = None;
        let mut empty_navigation = None;
        let mut settled = false;
        loop {
            phase = "document commit/readiness";
            let (navigation, url) = timings.measure("initialDocument", initial_document(&webview, tab_id, deadline)).await?;
            if empty_navigation != Some(navigation) {
                empty_since = None;
                empty_navigation = Some(navigation);
            }
            if method == "snapshot" && !settled {
                settled = true;
                phase = "rendering";
                timings.measure("rendering", settle_rendering(&webview, deadline)).await;
            }
            if method == "find" {
                params["timeout"] = json!(deadline.saturating_duration_since(tokio::time::Instant::now()).as_millis() as u64);
            }
            phase = "document read";
            let result = Box::pin(handle_action_inner(app, method, params.clone(), timings, caller)).await;
            let changed = active_navigation_generation(tab_id) != Some(navigation);
            match result {
                Ok(value) if changed || (method == "snapshot" && value["url"].as_str() != Some(url.as_str())) => {
                    if recoveries >= MAX_RECOVERIES {
                        return Err((error_codes::STALE_REF.into(), "initial read document kept changing; the new tab remains open for recovery".into()));
                    }
                    recoveries += 1;
                }
                Ok(value) => {
                    if method == "snapshot" && value["totalItems"] == 0 {
                        let since = empty_since.get_or_insert_with(tokio::time::Instant::now);
                        if since.elapsed() < EMPTY_GRACE {
                            phase = "initial content";
                            tokio::time::sleep_until((tokio::time::Instant::now() + Duration::from_millis(200)).min(deadline)).await;
                            continue;
                        }
                    }
                    return Ok(value);
                }
                Err((code, message)) if retry_read_error(&code, &message, changed, recoveries) => {
                    recoveries += 1;
                }
                Err(error) => return Err(error),
            }
            ref_context::remove(tab_id);
            tokio::time::sleep_until((tokio::time::Instant::now() + Duration::from_millis(50)).min(deadline)).await;
        }
    }).await;
    result.map_err(|_| initial_read_timeout(phase))?
}

async fn open_browser(
    app: &AppHandle,
    params: &Value,
    caller: &super::caller::Caller,
    timings: &mut ActionTimings,
) -> Result<Value, (String, String)> {
    let (url, workspace) = extract_browser_open_params(params)?;
    timings
        .measure(
            "admission",
            crate::modules::resource_guard::preflight_patiently(
                crate::modules::resource_guard::Workload::Browser,
                Duration::from_secs(5),
            ),
        )
        .await
        .map_err(|message| ("resource_exhausted".to_string(), message))?;

    let request_id = format!(
        "{}-{}",
        std::process::id(),
        OPEN_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let response_event = format!("{BROWSER_OPEN_RESPONSE_EVENT}:{request_id}");
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let listener_id = app.once(response_event, move |event| {
        let _ = sender.send(event.payload().to_string());
    });
    if let Err(error) = app.emit(
        BROWSER_OPEN_REQUEST_EVENT,
        json!({
            "requestId": request_id,
            "url": url,
            "workspace": workspace,
            // Identity travels with the request so the tab carries its
            // controller from the first frame it is drawn.
            "actor": caller,
        }),
    ) {
        app.unlisten(listener_id);
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to request browser tab: {error}"),
        ));
    }

    // A tab opened in a connected Chrome or Edge profile first waits for its
    // page to commit (up to the bridge's 10 s) and for its debugger; the
    // built-in browser answers in milliseconds either way.
    let received = timings
        .measure(
            "uiCreate",
            tokio::time::timeout(Duration::from_secs(25), receiver),
        )
        .await;
    app.unlisten(listener_id);
    let payload = received
        .map_err(|_| {
            (
                error_codes::TIMEOUT.to_string(),
                "Anbo UI did not create the browser tab in time".to_string(),
            )
        })?
        .map_err(|_| {
            (
                error_codes::APP_UNAVAILABLE.to_string(),
                "Anbo UI closed before creating the browser tab".to_string(),
            )
        })?;
    let response: BrowserOpenResponse = serde_json::from_str(&payload).map_err(|error| {
        (
            error_codes::INTERNAL.to_string(),
            format!("invalid browser-open response: {error}"),
        )
    })?;
    if let Some(error) = response.error {
        return Err((error_codes::INVALID_REQUEST.to_string(), error));
    }
    let tab_id = response.tab_id.ok_or_else(|| {
        (
            error_codes::INTERNAL.to_string(),
            "browser-open response omitted tabId".to_string(),
        )
    })?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let webview_wait = std::time::Instant::now();
    while get_embed_webview(app, tab_id).is_err() {
        if tokio::time::Instant::now() >= deadline {
            // The UI already created this tab. Returning without it would leave a
            // live browser the caller never learns about and can never close, and
            // a scraping run repeats that on every attempt.
            let _ = app.emit(
                BROWSER_CLOSE_REQUEST_EVENT,
                json!({
                    "requestId": format!(
                        "{}-{}",
                        std::process::id(),
                        OPEN_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
                    ),
                    "tabId": tab_id,
                    "workspace": response.workspace,
                }),
            );
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!(
                    "browser tab {tab_id} did not become ready in time; a close was requested for it"
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    timings.record("webview", webview_wait);

    Ok(json!({
        "tabId": tab_id,
        "spaceId": response.space_id,
        "workspace": response.workspace,
        "placement": response.placement,
        "url": url,
        "ok": true,
    }))
}

async fn close_browser(app: &AppHandle, params: &Value) -> Result<Value, (String, String)> {
    let (tab_id, workspace) = extract_browser_close_params(params)?;
    // No precheck here. A tab whose embed registration was already dropped is
    // exactly the tab that most needs closing, and rejecting it as not-found
    // left it running with nothing able to reach it.
    let request_id = format!(
        "{}-{}",
        std::process::id(),
        OPEN_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let response_event = format!("{BROWSER_CLOSE_RESPONSE_EVENT}:{request_id}");
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let listener_id = app.once(response_event, move |event| {
        let _ = sender.send(event.payload().to_string());
    });
    let had_browser = get_embed_webview(app, tab_id).is_ok();
    if let Err(error) = app.emit(
        BROWSER_CLOSE_REQUEST_EVENT,
        json!({
            "requestId": request_id,
            "tabId": tab_id,
            "workspace": workspace,
        }),
    ) {
        app.unlisten(listener_id);
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to request browser tab close: {error}"),
        ));
    }

    let mut receiver = receiver;
    let received = match tokio::time::timeout(Duration::from_secs(10), &mut receiver).await {
        Ok(received) => Some(received),
        // A saturated UI can answer late while the close itself goes through:
        // with eight agents at once the tab was gone and the agent was told the
        // close had failed. Wait as long again, and take the tab's browser
        // being gone for the answer.
        Err(_) => {
            let grace = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                if had_browser && get_embed_webview(app, tab_id).is_err() {
                    break None;
                }
                if tokio::time::Instant::now() >= grace {
                    app.unlisten(listener_id);
                    return Err((
                        error_codes::TIMEOUT.to_string(),
                        "Anbo UI did not close the browser tab in time".to_string(),
                    ));
                }
                if let Ok(received) =
                    tokio::time::timeout(Duration::from_millis(100), &mut receiver).await
                {
                    break Some(received);
                }
            }
        }
    };
    app.unlisten(listener_id);
    let Some(received) = received else {
        remove_tab_lock(tab_id);
        return Ok(json!({
            "tabId": tab_id,
            "workspace": workspace,
            "closed": true,
            "ok": true,
        }));
    };
    let payload = received.map_err(|_| {
        (
            error_codes::APP_UNAVAILABLE.to_string(),
            "Anbo UI closed before closing the browser tab".to_string(),
        )
    })?;
    let response: BrowserCloseResponse = serde_json::from_str(&payload).map_err(|error| {
        (
            error_codes::INTERNAL.to_string(),
            format!("invalid browser-close response: {error}"),
        )
    })?;
    if let Some(error) = response.error {
        return Err((error_codes::INVALID_REQUEST.to_string(), error));
    }
    if response.tab_id != Some(tab_id) {
        return Err((
            error_codes::INTERNAL.to_string(),
            "browser-close response did not match the requested tab".to_string(),
        ));
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while get_embed_webview(app, tab_id).is_ok() {
        if tokio::time::Instant::now() >= deadline {
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!("browser tab {tab_id} did not close in time"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    remove_tab_lock(tab_id);

    Ok(json!({
        "tabId": tab_id,
        "spaceId": response.space_id,
        "workspace": response.workspace,
        "closed": true,
        "ok": true,
    }))
}

fn extract_browser_open_params(params: &Value) -> Result<(&str, &str), (String, String)> {
    let url = params.get("url").and_then(Value::as_str).ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            "missing 'url' parameter".to_string(),
        )
    })?;
    ensure_bounded(url, MAX_URL_BYTES, "url")?;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err((
            error_codes::NAVIGATION_FAILED.to_string(),
            "only http:// and https:// URLs are allowed".to_string(),
        ));
    }
    let workspace = params
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "browser_open requires a workspace root or space id".to_string(),
            )
        })?;
    ensure_bounded(workspace, MAX_WORKSPACE_BYTES, "workspace")?;
    Ok((url, workspace))
}

fn extract_browser_close_params(params: &Value) -> Result<(i64, &str), (String, String)> {
    let tab_id = extract_tab_id(params)?;
    let workspace = params
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "browser_close requires a workspace root or space id".to_string(),
            )
        })?;
    ensure_bounded(workspace, MAX_WORKSPACE_BYTES, "workspace")?;
    Ok((tab_id, workspace))
}

fn ensure_bounded(value: &str, max_bytes: usize, field: &str) -> Result<(), (String, String)> {
    if value.len() > max_bytes {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("'{field}' exceeds {max_bytes} byte limit"),
        ));
    }
    Ok(())
}

/// Poll the embed webview until its document is interactive/complete with a
/// body, so reads (snapshot / get_text / get_page_info) issued right after a
/// `navigate` don't race the page load and return empty/no_body. Best-effort:
/// returns once ready or after `timeout_ms` — never errors, callers proceed.
async fn wait_for_ready(webview: &Webview, timeout_ms: u64) {
    let start = SystemTime::now();
    loop {
        let ready = execute_script_with_timeout(webview,
            "(document.readyState === 'interactive' || document.readyState === 'complete') && !!document.body",
            SCRIPT_POLL_TIMEOUT).await.unwrap_or_default();
        if ready.trim() == "true" {
            return;
        }
        let elapsed = start.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0);
        if elapsed >= timeout_ms {
            return;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
    }
}

fn extract_tab_id(params: &Value) -> Result<i64, (String, String)> {
    params
        .get("tabId")
        .or_else(|| params.get("tab"))
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "missing or invalid 'tabId' parameter".to_string(),
            )
        })
}

fn extract_ref(params: &Value) -> Result<String, (String, String)> {
    let ref_id = params
        .get("ref")
        .or_else(|| params.get("ref_id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "missing or invalid 'ref' parameter".to_string(),
            )
        })?;
    ensure_bounded(ref_id, MAX_REF_BYTES, "ref")?;
    parse_ref_generation(ref_id).map_err(|_| invalid_ref_error())?;
    Ok(ref_id.to_string())
}

fn extract_named_ref(params: &Value, field: &str) -> Result<String, (String, String)> {
    let ref_id = params.get(field).and_then(Value::as_str).ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            format!("missing or invalid '{field}' parameter"),
        )
    })?;
    ensure_bounded(ref_id, MAX_REF_BYTES, field)?;
    parse_ref_generation(ref_id).map_err(|_| invalid_ref_error())?;
    Ok(ref_id.to_string())
}

/// Fields per browser_fill_form call.
const MAX_FORM_FIELDS: usize = 20;

/// One form field becomes the single-target action it stands for: text types,
/// checked checks, option selects. The target is the field's own ref or
/// locator, and exactly one value kind is allowed.
fn form_field_action(
    field: &Value,
    tab_id: i64,
    number: usize,
) -> Result<(&'static str, Value), (String, String)> {
    let invalid = |message: String| (error_codes::INVALID_REQUEST.to_string(), message);
    let object = field
        .as_object()
        .ok_or_else(|| invalid(format!("field {number} is not an object")))?;
    let text = object.get("text").filter(|value| value.is_string());
    let checked = object.get("checked").filter(|value| value.is_boolean());
    let option = object.get("option").filter(|value| value.is_string());
    let (method, mut params) = match (text, checked, option) {
        (Some(text), None, None) => ("type_text", json!({ "tabId": tab_id, "text": text })),
        (None, Some(checked), None) => ("check", json!({ "tabId": tab_id, "checked": checked })),
        (None, None, Some(option)) => (
            "select_option",
            json!({ "tabId": tab_id, "value": option }),
        ),
        _ => {
            return Err(invalid(format!(
                "field {number}: give exactly one of text (string), checked (boolean) or option (string)"
            )))
        }
    };
    for key in ["ref", "locator"] {
        if let Some(value) = object.get(key) {
            params[key] = value.clone();
        }
    }
    if params.get("ref").is_none() && params.get("locator").is_none() {
        return Err(invalid(format!(
            "field {number}: name the target with ref or locator"
        )));
    }
    Ok((method, params))
}

fn parse_ref_generation(ref_id: &str) -> Result<u64, ()> {
    let rest = ref_id.strip_prefix('g').ok_or(())?;
    let (generation, suffix) = rest.split_once('-').ok_or(())?;
    if generation.is_empty() || !generation.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    let element = if let Some(element) = suffix.strip_prefix('e') {
        element
    } else if let Some(frame_and_element) = suffix.strip_prefix('f') {
        let (frame, element) = frame_and_element.split_once("-e").ok_or(())?;
        if frame.is_empty()
            || !frame.bytes().all(|byte| byte.is_ascii_digit())
            || frame.parse::<u64>().map_err(|_| ())? == 0
        {
            return Err(());
        }
        element
    } else {
        return Err(());
    };
    if element.is_empty() || !element.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(());
    }
    let generation = generation.parse::<u64>().map_err(|_| ())?;
    let element = element.parse::<u64>().map_err(|_| ())?;
    if generation == 0 || element == 0 {
        return Err(());
    }
    Ok(generation)
}

#[cfg(test)]
mod reveal_ref_tests {
    use super::*;
    use crate::modules::browser_automation::reveal::reveal_ref_prefix;

    #[test]
    fn a_revealed_ref_is_a_ref_the_caller_can_use() {
        // The point of handing back the surface is that its items can be acted
        // on. Naming them with a private letter made every one of them
        // unusable: the parser refused the ref before anything else ran.
        let ref_id = format!("{}1", reveal_ref_prefix(13));
        assert_eq!(parse_ref_generation(&ref_id), Ok(13));
        assert!(ensure_current_ref(&ref_id, 13).is_ok());
    }
}

fn invalid_ref_error() -> (String, String) {
    (
        error_codes::INVALID_REQUEST.to_string(),
        "invalid 'ref': expected g<generation>-e<index> or g<generation>-f<frame>-e<index>"
            .to_string(),
    )
}

/// A ref is usable while its scan is inside the retained window; whether the
/// node itself is still there is the page registry's call. Before this, any
/// find retired every earlier ref, so find A, find B, drag A onto B always
/// failed on A.
fn ensure_current_ref(ref_id: &str, current_generation: u64) -> Result<(), (String, String)> {
    let generation = parse_ref_generation(ref_id).map_err(|_| invalid_ref_error())?;
    if generation > current_generation {
        return Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid"),
        ));
    }
    if generation + REF_GENERATIONS_KEPT < current_generation {
        return Err((
            error_codes::STALE_REF.to_string(),
            format!(
                "element ref '{ref_id}' is from scan {generation}; only the last {REF_GENERATIONS_KEPT} finds or snapshots are kept (this tab is at {current_generation}), find it again"
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_retires_retained_refs_and_an_in_flight_scan() {
        let tab = -930002;
        super::super::snapshot::commit_generation(tab, 3);
        let pending = super::super::snapshot::peek_next_generation(tab);
        super::super::snapshot::record_ref_frame_targets(
            tab,
            HashMap::from([(
                "g3-f1-e1".to_string(),
                RefFrameTarget {
                    frame_id: "old-frame".into(),
                    is_main: false,
                },
            )]),
        );
        super::super::snapshot::invalidate_document(tab);
        super::super::snapshot::commit_generation(tab, pending);
        let current = get_current_generation(tab);
        assert!(ensure_current_ref("g3-f1-e1", current).is_err());
        assert!(ensure_current_ref(&format!("g{pending}-e1"), current).is_err());
        assert!(get_ref_frame_target(tab, "g3-f1-e1").is_none());
        let fresh = get_next_generation(tab);
        assert!(ensure_current_ref(&format!("g{fresh}-f1-e1"), fresh).is_ok());
        super::super::snapshot::remove_generation(tab);
    }

    #[test]
    fn frame_evaluation_decodes_exactly_one_string_layer() {
        for value in [
            json!("https://example.test/"),
            json!({"ok": true}),
            json!(42),
            Value::Null,
        ] {
            let encoded = value.to_string();
            let expected = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| encoded.clone());
            assert_eq!(decode_frame_evaluation(encoded), expected);
        }
        assert_eq!(
            decode_frame_evaluation(json!(r#"{"ok":true}"#).to_string()),
            r#"{"ok":true}"#
        );
        assert_eq!(decode_frame_evaluation("undefined".into()), "undefined");
    }

    #[test]
    fn merged_input_options_reject_invalid_values_before_dispatch() {
        assert_eq!(extract_click_count(&json!({}), false).unwrap(), 1);
        assert_eq!(extract_click_count(&json!({}), true).unwrap(), 2);
        assert_eq!(
            extract_click_count(&json!({"clickCount":2}), false).unwrap(),
            2
        );
        for value in [json!(0), json!(3), json!(1.5), json!("2"), Value::Null] {
            assert!(extract_click_count(&json!({"clickCount":value}), false).is_err());
        }
        assert!(extract_click_count(&json!({"clickCount":1}), true).is_err());
        for action in ["press", "down", "up"] {
            assert_eq!(
                extract_key_action(&json!({"keyAction":action})).unwrap(),
                action
            );
        }
        for value in [json!("hold"), json!(2), Value::Null] {
            assert!(extract_key_action(&json!({"keyAction":value})).is_err());
        }
    }

    #[test]
    fn a_ref_stays_usable_for_the_kept_scans_and_expires_after() {
        assert!(ensure_current_ref("g3-e1", 3).is_ok());
        assert!(ensure_current_ref("g3-e1", 3 + REF_GENERATIONS_KEPT).is_ok());
        assert!(ensure_current_ref("g3-f1-e2", 3 + REF_GENERATIONS_KEPT).is_ok());
        let expired = ensure_current_ref("g3-e1", 4 + REF_GENERATIONS_KEPT).unwrap_err();
        assert_eq!(expired.0, error_codes::STALE_REF);
        assert!(expired.1.contains("find it again"), "{}", expired.1);
        // A ref from a scan that has not happened is never valid.
        assert_eq!(
            ensure_current_ref("g5-e1", 4).unwrap_err().0,
            error_codes::STALE_REF
        );
        // The page registry must keep the same window.
        assert!(
            REF_REGISTRY_JS.contains(&format!("const KEEP = {REF_GENERATIONS_KEPT};")),
            "refRegistry.js KEEP differs from REF_GENERATIONS_KEPT"
        );
    }

    #[test]
    fn a_form_field_maps_to_the_single_target_action_it_stands_for() {
        let (method, params) = form_field_action(
            &json!({ "locator": { "by": "css", "value": "#firstName" }, "text": "Budi" }),
            7,
            1,
        )
        .unwrap();
        assert_eq!(method, "type_text");
        assert_eq!(params["tabId"], json!(7));
        assert_eq!(params["text"], json!("Budi"));
        assert_eq!(params["locator"]["value"], json!("#firstName"));
        let (method, params) =
            form_field_action(&json!({ "ref": "g2-e4", "checked": true }), 7, 2).unwrap();
        assert_eq!(method, "check");
        assert_eq!(params["ref"], json!("g2-e4"));
        assert_eq!(params["checked"], json!(true));
        let (method, params) =
            form_field_action(&json!({ "ref": "g2-e5", "option": "Yes" }), 7, 3).unwrap();
        assert_eq!(method, "select_option");
        assert_eq!(params["value"], json!("Yes"));
        // Exactly one value kind, and a target, or the field is refused up front.
        for field in [
            json!({ "ref": "g2-e4" }),
            json!({ "ref": "g2-e4", "text": "a", "checked": true }),
            json!({ "text": "a" }),
            json!("not an object"),
        ] {
            let (code, message) = form_field_action(&field, 7, 4).unwrap_err();
            assert_eq!(code, error_codes::INVALID_REQUEST);
            assert!(message.starts_with("field 4"), "{message}");
        }
    }

    #[test]
    fn ref_failure_diagnostics_allow_only_known_reasons() {
        for reason in [
            "destination_changed",
            "context_changed",
            "destination_limit",
            "context_limit",
            "node_detached",
            "generation_changed",
        ] {
            assert_eq!(ref_failure_reason(&json!({"reason": reason})), reason);
        }
        assert_eq!(
            ref_failure_reason(&json!({"reason": "private page content"})),
            "ref_invalid"
        );
        assert_eq!(ref_failure_reason(&Value::Null), "ref_invalid");
    }
    use serde_json::json;

    #[test]
    fn test_extract_tab_id() {
        let v1 = json!({ "tabId": 42 });
        assert_eq!(extract_tab_id(&v1).unwrap(), 42);

        let v2 = json!({ "tab": 99 });
        assert_eq!(extract_tab_id(&v2).unwrap(), 99);

        let v3 = json!({ "other": 1 });
        assert!(extract_tab_id(&v3).is_err());
    }

    #[test]
    fn test_extract_ref() {
        let v1 = json!({ "ref": "g1-e1" });
        assert_eq!(extract_ref(&v1).unwrap(), "g1-e1");

        let v2 = json!({ "ref_id": "g42-e999" });
        assert_eq!(extract_ref(&v2).unwrap(), "g42-e999");

        let frame_ref = json!({ "ref": "g7-f2-e31" });
        assert_eq!(extract_ref(&frame_ref).unwrap(), "g7-f2-e31");

        let v3 = json!({});
        assert!(extract_ref(&v3).is_err());

        for invalid in [
            "",
            "e1",
            "g-e1",
            "g1-e",
            "g0-e1",
            "g1-e0",
            "g1-e1\"]'); alert(1); //",
            "g1-e-1",
            "g1-f-e1",
            "g1-f0-e1",
            "g1-f1-e0",
            "g1-f1-x1",
        ] {
            assert!(extract_ref(&json!({ "ref": invalid })).is_err());
        }
    }

    #[test]
    fn refs_are_refused_only_outside_the_retained_window() {
        assert!(ensure_current_ref("g2-e1", 2).is_ok());
        assert!(ensure_current_ref("g2-f1-e1", 2).is_ok());
        // An older ref stays usable while the window keeps it...
        assert!(ensure_current_ref("g1-e1", 2).is_ok());
        assert!(ensure_current_ref("g1-e1", 1 + REF_GENERATIONS_KEPT).is_ok());
        // ...and is refused once the window has moved on.
        let error = ensure_current_ref("g1-e1", 2 + REF_GENERATIONS_KEPT).unwrap_err();
        assert_eq!(error.0, error_codes::STALE_REF);
        assert!(error.1.contains("g1-e1"));
    }

    #[test]
    fn frame_tree_collection_is_bounded_and_depth_first() {
        let tree = json!({
            "frame": { "id": "root" },
            "childFrames": [
                {
                    "frame": { "id": "first" },
                    "childFrames": [{ "frame": { "id": "nested" } }]
                },
                { "frame": { "id": "second" } }
            ]
        });
        let mut ids = Vec::new();
        collect_frame_ids(&tree, &mut ids);
        assert_eq!(ids, ["root", "first", "nested", "second"]);
        assert_eq!(count_frame_nodes(&tree), 4);
    }

    #[test]
    fn navigation_history_selects_only_an_existing_adjacent_entry() {
        let history = json!({
            "currentIndex": 1,
            "entries": [{ "id": 10 }, { "id": 11 }, { "id": 12 }]
        });
        assert_eq!(history_entry_id(&history, -1), Some(10));
        assert_eq!(history_entry_id(&history, 1), Some(12));
        assert_eq!(history_entry_id(&history, 2), None);
        assert_eq!(
            history_entry_id(&json!({ "currentIndex": 0, "entries": [] }), -1),
            None
        );
    }

    #[test]
    fn console_entries_are_bounded_and_annotated_with_their_frame() {
        let raw = serde_json::to_string(&json!([
            { "level": "info", "msg": "main ready", "ts": 11 },
            { "level": "error", "msg": "frame failed", "ts": 12 },
            { "level": "info", "other": "ignored" }
        ]))
        .unwrap();
        let encoded = serde_json::to_string(&raw).unwrap();
        let entries = parse_console_entries(&encoded, "frame-1");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["frame"], "frame-1");
        assert_eq!(entries[1]["level"], "error");
        assert_eq!(entries[1]["ts"], 12);
    }

    #[test]
    fn printable_punctuation_uses_windows_keyboard_codes_instead_of_control_keys() {
        let period = key_event_params("keyDown", ".", 0);
        assert_eq!(period["key"], ".");
        assert_eq!(period["code"], "Period");
        assert_eq!(period["windowsVirtualKeyCode"], 190);
        assert_eq!(period["text"], ".");
        assert_ne!(period["windowsVirtualKeyCode"], 46);

        let at = key_event_params("keyDown", "@", 0);
        assert_eq!(at["code"], "Digit2");
        assert_eq!(at["windowsVirtualKeyCode"], 50);
        assert_eq!(at["modifiers"], 8);
        assert_eq!(at["text"], "@");
    }

    #[test]
    fn shortcuts_never_include_text_and_shift_maps_printable_keys() {
        for modifiers in [1, 2, 4, 3, 5, 6, 7, 9, 10, 12, 15] {
            for key in ["q", "Q", "7", ".", "@", "Enter"] {
                let params = key_event_params("keyDown", key, modifiers);
                assert!(params.get("text").is_none(), "{modifiers}: {key}");
                assert!(params.get("unmodifiedText").is_none());
            }
        }
        for (key, expected) in [("q", "Q"), ("7", "&"), ("/", "?"), ("@", "@"), ("é", "é")] {
            let params = key_event_params("keyDown", key, 8);
            assert_eq!(params["key"], expected);
            assert_eq!(params["text"], expected);
            assert!(key_event_params("keyUp", key, 8).get("text").is_none());
        }
        assert_eq!(
            key_event_params("keyDown", "Control", 0)["code"],
            "ControlLeft"
        );
    }

    #[test]
    fn an_ambiguous_target_names_the_elements_that_collided() {
        let candidate = |tag: &str, name: &str, x: f64, visible: bool| LocatorMatch {
            ref_id: "g1-e1".into(),
            tag: tag.into(),
            role: "link".into(),
            name: name.into(),
            text: "fallback text".into(),
            value: None,
            visible,
            enabled: true,
            checked: None,
            editable: false,
            read_only: false,
            in_viewport: true,
            bounds: Some(super::super::locator::LocatorBounds {
                x,
                y: 400.0,
                width: 80.0,
                height: 20.0,
            }),
            block: None,
            block_ref: None,
        };
        let error = (
            error_codes::AMBIGUOUS_TARGET.to_string(),
            "locator matched multiple elements".to_string(),
        );
        let described = describe_ambiguity(
            error.clone(),
            &[
                candidate("a", "Manufacturers", 120.0, true),
                candidate("button", "", 640.0, false),
            ],
        );
        assert!(described.1.contains("<a> \"Manufacturers\" at 120,400"));
        // A nameless candidate falls back to its text, and being out of sight
        // is itself the thing that tells them apart.
        assert!(described
            .1
            .contains("<button> \"fallback text\" at 640,400, hidden"));

        // Every other failure is passed through untouched.
        let other = (error_codes::TIMEOUT.to_string(), "timed out".to_string());
        assert_eq!(
            describe_ambiguity(other.clone(), &[candidate("a", "x", 1.0, true)]),
            other
        );
        assert_eq!(describe_ambiguity(error.clone(), &[]), error);
    }

    #[test]
    fn find_timeout_says_what_the_caller_can_conclude() {
        let locator = extract_locator(&json!({"by":"css", "value":"#missing"})).unwrap();
        let scan = |hidden: usize, names: Vec<&str>| CollectedLocatorMatches {
            matches: vec![],
            scanned: 16_295,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden,
            name_misses: names.into_iter().map(str::to_string).collect(),
            candidates: vec![],
            nearest: None,
        };

        // A page read end to end with nothing matching is a verdict, and says so.
        let absent = find_timeout(&locator, 800, 3, None, Some(&scan(0, vec![])), 0);
        assert_eq!(absent.0, error_codes::TIMEOUT);
        assert!(absent.1.contains("#missing"));
        assert!(absent.1.contains("confirmed absence"));
        assert!(absent.1.contains("16295"));

        // An element behind a collapsed menu is not an absence, and the caller
        // is told the one thing that would reach it.
        let hidden = find_timeout(&locator, 800, 3, None, Some(&scan(2, vec![])), 0);
        assert!(hidden
            .1
            .contains("2 element(s) matched but are not rendered"));
        assert!(hidden.1.contains("includeHidden=true"));
        assert!(!hidden.1.contains("confirmed absence"));

        // A role that matched under a different accessible name reports the
        // names it saw rather than leaving the caller to guess.
        let named = find_timeout(
            &locator,
            800,
            3,
            None,
            Some(&scan(0, vec!["Download this page as a PDF file"])),
            0,
        );
        assert!(named.1.contains("Download this page as a PDF file"));
        assert!(!named.1.contains("confirmed absence"));

        // Truncated coverage must never read as a verdict.
        let capped = CollectedLocatorMatches {
            node_limit_reached: true,
            scanned: 50_000,
            ..scan(0, vec![])
        };
        let partial = find_timeout(&locator, 800, 2, None, Some(&capped), 0);
        assert!(partial.1.contains("page coverage incomplete"));
        assert!(partial.1.contains("not a confirmed absence"));
        let skipped = CollectedLocatorMatches {
            skipped_frames: 1,
            ..scan(0, vec![])
        };
        assert!(find_timeout(&locator, 800, 2, None, Some(&skipped), 0)
            .1
            .contains("1 frames skipped"));

        // No scan at all stays distinct from every reading above.
        let queued = find_timeout(&locator, 800, 0, Some("queue exceeded deadline"), None, 0);
        assert!(queued.1.contains("no scan completed"));
        assert!(queued.1.contains("queue exceeded deadline"));

        // A scan cut off by the deadline cannot support a verdict, even when
        // earlier scans read the whole page. Claiming both in one sentence left
        // the caller unable to tell which half to believe.
        let cut = find_timeout(
            &locator,
            800,
            26,
            Some("browser reference scan exceeded its deadline"),
            Some(&scan(0, vec![])),
            0,
        );
        assert!(cut.1.contains("cut short by the deadline"));
        assert!(!cut.1.contains("confirmed absence"));

        let quiet = find_timeout(&locator, 800, 1, None, Some(&scan(0, vec![])), 7);
        assert!(quiet.1.contains("cached scans expire"));
        assert!(!quiet.1.contains("could not have found anything new"));
        assert!(!absent.1.contains("cached scans expire"));
    }

    #[test]
    fn locator_retries_wake_at_cache_expiry_without_spinning_or_exceeding_the_deadline() {
        let start = tokio::time::Instant::now();
        let deadline = start + Duration::from_secs(5);
        assert_eq!(
            locator_retry_at(start + Duration::from_millis(300), start, 600, deadline),
            start + Duration::from_millis(750)
        );
        assert_eq!(
            locator_retry_at(start + Duration::from_secs(2), start, 1000, deadline),
            start + Duration::from_millis(2150)
        );
        assert_eq!(
            locator_retry_at(
                start + Duration::from_millis(300),
                start,
                600,
                start + Duration::from_millis(400)
            ),
            start + Duration::from_millis(400)
        );
    }

    fn diagnostic_scan(names: Vec<String>) -> CollectedLocatorMatches {
        CollectedLocatorMatches {
            matches: vec![],
            scanned: 643,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden: 0,
            name_misses: names,
            candidates: vec![],
            nearest: None,
        }
    }

    #[test]
    fn direct_locator_timeout_shares_find_diagnosis_without_changing_matching() {
        for exact in [false, true] {
            let locator = extract_locator(&json!({
                "by": "role", "value": "combobox", "name": "Search Google Maps", "exact": exact
            }))
            .unwrap();
            let scan = diagnostic_scan(vec!["Telusuri Google Maps".into()]);
            let action = target_locator_timeout(&locator, None, 15_000, 3, None, Some(&scan));
            let find = find_timeout(&locator, 15_000, 3, None, Some(&scan), 0);
            let diagnostics = locator_timeout_diagnostics(&locator, 3, None, Some(&scan), 0);
            assert!(action.1.contains(&diagnostics));
            assert!(find.1.contains(&diagnostics));
            assert_eq!(action.0, error_codes::TIMEOUT);
            assert!(action.1.contains("locator lookup timed out after 15000ms"));
            assert!(action.1.contains("Telusuri Google Maps"));
            assert!(action.1.contains("not a guessed translation"));
            assert!(action.1.contains("not verified unique targets"));
            assert!(action.1.ends_with("no input dispatched"));
            assert!(action
                .1
                .contains(if exact { "equaled" } else { "contained" }));
            assert!(!action.1.contains("confirmed absence"));
        }
    }

    #[test]
    fn locator_timeout_does_not_present_an_old_name_after_an_interrupted_scan() {
        let locator =
            extract_locator(&json!({"by":"role", "value":"combobox", "name":"Search"})).unwrap();
        let scan = diagnostic_scan(vec!["Old name".into()]);
        for previous in [None, Some(&scan)] {
            let count = usize::from(previous.is_some());
            let error =
                target_locator_timeout(&locator, None, 100, count, Some("scan deadline"), previous);
            assert!(error.1.contains(if count == 0 {
                "no scan completed"
            } else {
                "cut short by the deadline"
            }));
            assert!(error.1.contains("scan deadline"));
            assert!(!error.1.contains("Old name"));
            assert!(!error.1.contains("confirmed absence"));
            assert!(error.1.ends_with("no input dispatched"));
        }
    }

    #[test]
    fn locator_timeout_name_hints_are_bounded_and_escaped() {
        let locator =
            extract_locator(&json!({"by":"role", "value":"combobox", "name":"Search"})).unwrap();
        let scan = diagnostic_scan(vec![
            "Search \"quoted\"\nlabel".into(),
            "界".repeat(2000),
            "Third".into(),
            "Fourth".into(),
            "Fifth".into(),
            "Sixth must be omitted".into(),
        ]);
        let error = target_locator_timeout(&locator, None, 100, 1, None, Some(&scan));
        assert!(error.1.contains("Search \\\"quoted\\\"\\nlabel"));
        assert!(!error.1.contains('\n'));
        assert!(error.1.contains(&"界".repeat(80)));
        assert!(!error.1.contains(&"界".repeat(81)));
        assert!(!error.1.contains("Sixth must be omitted"));
        assert!(error.1.len() < 1200);
    }

    #[test]
    fn locator_timeout_prioritizes_coverage_and_visibility_over_near_names() {
        let locator =
            extract_locator(&json!({"by":"role", "value":"button", "name":"Search"})).unwrap();
        for (hidden, capped, skipped) in [(2, false, 0), (0, true, 0), (0, false, 1)] {
            let scan = CollectedLocatorMatches {
                hidden,
                node_limit_reached: capped,
                skipped_frames: skipped,
                ..diagnostic_scan(vec!["Near name".into()])
            };
            let error = target_locator_timeout(&locator, None, 900, 2, None, Some(&scan));
            assert!(error.1.contains(if hidden > 0 {
                "not rendered"
            } else {
                "coverage incomplete"
            }));
            assert!(!error.1.contains("names seen here"));
            assert!(error.1.ends_with("no input dispatched"));
        }
    }

    #[test]
    fn locator_wait_timeout_reports_existing_matches_without_values_or_false_absence() {
        let locator = extract_locator(&json!({"by":"css", "value":"input"})).unwrap();
        let item: LocatorMatch = serde_json::from_value(json!({
            "ref":"g1-e1", "tag":"input", "role":"textbox", "name":"Name", "text":"",
            "value":"private-value", "visible":true, "enabled":true, "checked":null
        }))
        .unwrap();
        let scan = CollectedLocatorMatches {
            matches: vec![item],
            ..diagnostic_scan(vec!["Other".into()])
        };
        let error = target_locator_timeout(&locator, Some("unchecked"), 500, 1, None, Some(&scan));
        assert!(error.1.contains("locator unchecked timed out"));
        assert!(error.1.contains("1 element(s) matched"));
        assert!(error.1.contains("requested state was not satisfied"));
        assert!(!error.1.contains("confirmed absence"));
        assert!(!error.1.contains("names seen here"));
        assert!(!error.1.contains("private-value"));
    }

    #[test]
    fn only_a_whole_page_with_nothing_on_it_counts_as_a_proven_absence() {
        // A fully-read, empty scan; each case tweaks one field from it.
        let empty = || CollectedLocatorMatches {
            matches: vec![],
            scanned: 642,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden: 0,
            name_misses: vec![],
            candidates: vec![],
            nearest: None,
        };
        // The Google Maps case: the whole page read, nothing there, so the
        // settle clock may start and a doomed lookup can stop early.
        assert!(absence_conclusive(&empty()));

        // A hidden match could still be revealed by an animation; a capped or
        // node-limited scan or a skipped frame leaves part of the page unread.
        // None of these prove absence, so none may cut the wait short.
        assert!(!absence_conclusive(&CollectedLocatorMatches {
            hidden: 1,
            ..empty()
        }));
        assert!(!absence_conclusive(&CollectedLocatorMatches {
            truncated: true,
            ..empty()
        }));
        assert!(!absence_conclusive(&CollectedLocatorMatches {
            node_limit_reached: true,
            ..empty()
        }));
        assert!(!absence_conclusive(&CollectedLocatorMatches {
            skipped_frames: 1,
            ..empty()
        }));

        // A matched-but-hidden element already exists, so a stable hidden-only miss may fail fast —
        // but only when the rest of the page was fully read (else a visible match may be unseen).
        assert!(hidden_only_miss(&CollectedLocatorMatches {
            hidden: 2,
            ..empty()
        }));
        assert!(!hidden_only_miss(&empty())); // nothing hidden: a plain absence, not this path
        assert!(!hidden_only_miss(&CollectedLocatorMatches {
            hidden: 1,
            truncated: true,
            ..empty()
        }));
        assert!(!hidden_only_miss(&CollectedLocatorMatches {
            hidden: 1,
            node_limit_reached: true,
            ..empty()
        }));
        assert!(!hidden_only_miss(&CollectedLocatorMatches {
            hidden: 1,
            skipped_frames: 1,
            ..empty()
        }));
    }

    #[test]
    fn media_state_reads_the_aimed_player_without_climbing_to_the_document() {
        let script = deep_ref_expression("g1-e1", MEDIA_STATE_BODY);
        assert!(script.contains("node?.matches?.('video,audio')"));
        assert!(script.contains("depth < 8"));
        assert!(script
            .contains("if (node === document.body || node === document.documentElement) break;"));
        assert!(script.contains("if (!media) return 'null';"));
        for field in ["paused:", "ended:", "muted:", "currentTime:", "duration:"] {
            assert!(script.contains(field), "{field}");
        }
    }

    #[test]
    fn habitual_locator_types_become_the_lookup_they_mean() {
        let id = extract_locator(&json!({ "by": "id", "value": "confirmButton" })).unwrap();
        assert_eq!(
            (id.by.as_str(), id.value.as_str()),
            ("css", "#confirmButton")
        );
        let hashed = extract_locator(&json!({ "by": "id", "value": "#submit" })).unwrap();
        assert_eq!(hashed.value, "#submit");
        // An id no plain selector can hold is quoted as data.
        let odd = extract_locator(&json!({ "by": "id", "value": "a b\"c" })).unwrap();
        assert_eq!(odd.value, r#"[id="a b\"c"]"#);
        let role =
            extract_locator(&json!({ "by": "combobox", "value": "", "name": "Search" })).unwrap();
        assert_eq!(
            (role.by.as_str(), role.value.as_str(), role.name.as_deref()),
            ("role", "combobox", Some("Search"))
        );
        let named = extract_locator(&json!({ "by": "button", "value": "Submit" })).unwrap();
        assert_eq!(
            (
                named.by.as_str(),
                named.value.as_str(),
                named.name.as_deref()
            ),
            ("role", "button", Some("Submit"))
        );
        for unsupported in [
            json!({ "by": "xpath", "value": "//a" }),
            json!({ "by": "id", "value": " " }),
        ] {
            assert_eq!(
                extract_locator(&unsupported).unwrap_err().0,
                error_codes::INVALID_REQUEST,
                "{unsupported}"
            );
        }
        // A type nobody means is refused with the list and where a name goes.
        let guessed = extract_locator(&json!({ "by": "xpath", "value": "//a" }))
            .unwrap_err()
            .1;
        assert!(guessed.contains("use role, text, label, placeholder, testId, title, alt or css"));
        assert!(guessed.contains("name:'Search'"));
    }

    #[test]
    fn a_wait_timeout_beside_wait_for_fills_in_its_own() {
        let timeout = |wait_for: Value, outer: Option<Value>| {
            let wait_for = with_outer_timeout(&wait_for, outer.as_ref());
            PageExpectation::parse(Some(&wait_for))
                .unwrap()
                .unwrap()
                .timeout
        };
        assert_eq!(
            timeout(json!({ "url": "https://a.test/*" }), Some(json!(15000))),
            15000
        );
        // Kimi's call carried both; waitFor's own is the one that counts.
        assert_eq!(
            timeout(
                json!({ "url": "https://a.test/*", "stableFor": 500, "timeout": 3000 }),
                Some(json!(15000))
            ),
            3000
        );
        assert_eq!(timeout(json!({ "text": "Ready" }), None), 10_000);
        let invalid = with_outer_timeout(&json!({ "text": "Ready" }), Some(json!(50)).as_ref());
        assert!(PageExpectation::parse(Some(&invalid)).is_err());
    }

    #[test]
    fn a_name_asked_for_as_the_lookup_matches_any_role_by_that_name() {
        let as_triple = |params: Value| {
            let locator = extract_locator(&params).unwrap();
            (locator.by, locator.value, locator.name)
        };
        let named = |value: &str| {
            (
                "name".to_string(),
                value.to_string(),
                Some(value.to_string()),
            )
        };
        assert_eq!(
            as_triple(json!({ "by": "name", "value": "Search" })),
            named("Search")
        );
        // Kimi's two Wikipedia calls, and a value that is prose next to a name.
        assert_eq!(
            as_triple(
                json!({ "by": "role", "value": "Cari di Wikipedia", "name": "Cari di Wikipedia" })
            ),
            named("Cari di Wikipedia")
        );
        assert_eq!(
            as_triple(json!({ "by": "role", "value": "Telusuri Wikipedia" })),
            named("Telusuri Wikipedia")
        );
        assert_eq!(
            as_triple(json!({ "by": "role", "value": "Search box", "name": "Search" })),
            named("Search")
        );
        // Anything a role contains stays a role lookup, as the page matches it.
        for role in [
            "button",
            "Search",
            "text",
            "searchbox",
            "doc-chapter",
            "treeitem",
        ] {
            let locator =
                extract_locator(&json!({ "by": "role", "value": role, "name": "Go" })).unwrap();
            assert_eq!(
                (locator.by.as_str(), locator.name.as_deref()),
                ("role", Some("Go")),
                "{role}"
            );
        }
    }

    #[test]
    fn a_text_read_settles_an_ambiguity_only_when_every_match_reads_the_same() {
        let item = |text: &str| LocatorMatch {
            ref_id: "g1-e1".into(),
            tag: "h1".into(),
            role: "heading".into(),
            name: text.into(),
            text: text.into(),
            value: None,
            visible: true,
            enabled: true,
            checked: None,
            editable: false,
            read_only: false,
            in_viewport: true,
            bounds: None,
            block: None,
            block_ref: None,
        };
        let scan = |texts: &[&str]| CollectedLocatorMatches {
            matches: texts.iter().map(|text| item(text)).collect(),
            scanned: 900,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden: 0,
            name_misses: vec![],
            candidates: vec![],
            nearest: None,
        };
        // The YouTube title: an h1 and the yt-formatted-string inside it.
        assert!(same_text_matches(&scan(&[
            "lofi hip hop radio",
            "lofi  hip hop\nradio"
        ])));
        // One match is not an ambiguity, different texts are a real one, and
        // two empty canvases say nothing worth returning.
        assert!(!same_text_matches(&scan(&["only one"])));
        assert!(!same_text_matches(&scan(&["ETHUSDT", "BTCUSDT"])));
        assert!(!same_text_matches(&scan(&["", ""])));
        // A scan that filled its limit may have stopped before a different match.
        let full = vec!["same"; SAME_TEXT_READ_LIMIT];
        assert!(!same_text_matches(&scan(&full)));
        // Unread parts of the page leave the question open.
        for incomplete in [
            CollectedLocatorMatches {
                truncated: true,
                ..scan(&["a", "a"])
            },
            CollectedLocatorMatches {
                node_limit_reached: true,
                ..scan(&["a", "a"])
            },
            CollectedLocatorMatches {
                skipped_frames: 1,
                ..scan(&["a", "a"])
            },
        ] {
            assert!(!same_text_matches(&incomplete));
        }

        // TradingView's chart canvases: eleven, one named. The named one is read.
        let mut canvases = vec![""; 11];
        canvases[1] = "Chart for BINANCE:ETHUSDT, 1 month";
        assert_eq!(only_informative_match(&scan(&canvases)), Some(1));
        // Two that say something, or none, stay ambiguous.
        assert_eq!(only_informative_match(&scan(&["", "a", "b"])), None);
        assert_eq!(only_informative_match(&scan(&["", ""])), None);
        assert_eq!(only_informative_match(&scan(&["only one"])), None);
        // A full scan may have stopped before a second informative match.
        let mut full = vec![""; READ_SCAN_LIMIT];
        full[0] = "named";
        assert_eq!(only_informative_match(&scan(&full)), None);
        assert_eq!(
            only_informative_match(&CollectedLocatorMatches {
                truncated: true,
                ..scan(&["", "a"])
            }),
            None
        );
    }

    #[test]
    fn untargeted_player_keys_report_the_main_player_but_form_keys_do_not() {
        for key in ["k", " ", "m", "Space", "ArrowRight", "MediaPlayPause"] {
            assert!(player_key(key, "press", 0), "{key}");
        }
        for key in ["Enter", "Tab", "Escape", "Backspace"] {
            assert!(!player_key(key, "press", 0), "{key}");
        }
        assert!(!player_key("k", "down", 0));
        assert!(!player_key("k", "press", 1));
        assert!(PAGE_MEDIA_JS.contains("++count > 16"));
        assert!(PAGE_MEDIA_JS.contains("rect.width * rect.height"));
    }

    #[test]
    fn a_result_list_is_compared_by_its_titles_in_order() {
        let hints = json!({ "results": [
            { "ref": "g7-e1", "name": "lofi hip hop radio" },
            { "ref": "g7-e2", "name": "lofi beats" }
        ] });
        assert_eq!(
            result_titles(&hints),
            vec!["lofi hip hop radio", "lofi beats"]
        );
        // Fresh refs for the same titles are the same list.
        let redrawn = json!({ "results": [
            { "ref": "g8-e1", "name": "lofi hip hop radio" },
            { "ref": "g8-e2", "name": "lofi beats" }
        ] });
        assert_eq!(result_titles(&hints), result_titles(&redrawn));
        assert!(result_titles(&json!({ "heading": "Monumen Nasional", "results": [] })).is_empty());
        assert!(result_titles(&json!({ "heading": "Monumen Nasional" })).is_empty());
    }

    #[test]
    fn a_search_names_its_words_and_hints_wait_for_a_result_naming_one() {
        assert_eq!(query_words("usb c hub"), vec!["usb", "hub"]);
        assert_eq!(
            query_words("Lofi  hip-hop radio lofi"),
            vec!["lofi", "hip", "hop", "radio"]
        );
        assert_eq!(query_words("Monas Jakarta"), vec!["monas", "jakarta"]);
        assert!(query_words("a b").is_empty());
        assert_eq!(query_words(&"word ".repeat(20)).len(), 1);
        let script =
            build_navigation_hints_js(7, "g7-e", &query_words("usb c hub"), HintsGate::Results);
        assert!(script.contains(r#"const queryWords = ["usb","hub"];"#));
        assert!(script.contains(r#"const gate = "results";"#));
        // Titles on screen before the search are never its results.
        assert!(script.contains("if (queryWords.length && globalThis.__anboBeforeSubmit?.get(el) === el.href) continue;"));
        assert!(PRE_SUBMIT_TITLES_JS.contains("globalThis.__anboBeforeSubmit = titles;"));
        assert!(PRE_SUBMIT_TITLES_JS.contains("++links > 3000"));
        // A place page answers with an h1 drawn since the submit.
        assert!(PRE_SUBMIT_TITLES_JS.contains("globalThis.__anboBeforeSubmitHeading = heading;"));
        assert!(script.contains("&& !newHeading) return null;"));
        // Nothing is registered before the answer is kept.
        let require = script
            .find("if (gate === 'results' && !found.length")
            .unwrap();
        let remember = script.find("refRegistry.remember(ref, el);").unwrap();
        assert!(require < remember);
    }

    #[test]
    fn a_route_change_waits_for_its_h1_before_registering_refs() {
        let script = build_navigation_hints_js(7, "g7-e", &[], HintsGate::Heading);
        assert!(script.contains(r#"const gate = "heading";"#));
        // The og:title a single-page app kept from its first page does not count.
        let wait = script
            .find("if (gate === 'heading' && !heading && siteName && clean(document.title) === siteName) return null;")
            .unwrap();
        let fallback = script.find("if (!heading) heading = ").unwrap();
        let remember = script.find("refRegistry.remember(ref, el);").unwrap();
        assert!(wait < fallback && wait < remember);
        assert!(build_navigation_hints_js(7, "g7-e", &[], HintsGate::Any)
            .contains(r#"const gate = "any";"#));
    }

    #[test]
    fn a_route_change_counts_as_landing_but_an_anchor_jump_does_not() {
        assert!(url_moved(
            "https://www.youtube.com/",
            "https://www.youtube.com/results?search_query=lofi"
        ));
        assert!(url_moved(
            "https://www.google.com/maps",
            "https://www.google.com/maps/search/Monas+Jakarta/@-6.29,106.92,12z"
        ));
        assert!(!url_moved(
            "https://en.wikipedia.org/wiki/Web_browser",
            "https://en.wikipedia.org/wiki/Web_browser#History"
        ));
        assert!(!url_moved("", "https://example.test/"));
        assert!(!url_moved("https://example.test/", ""));
        assert!(submits_type("type", &json!({ "submit": true })));
        assert!(!submits_type("type", &json!({ "submit": false })));
        assert!(!submits_type("click", &json!({ "submit": true })));
    }

    #[test]
    fn type_submit_accepts_a_wait_with_or_without_submit_but_refuses_a_malformed_one() {
        assert_eq!(type_submit(&json!({})).unwrap(), (false, None));
        let waited = json!({ "url": "*results*" });
        assert_eq!(
            type_submit(&json!({ "submit": true, "waitFor": waited })).unwrap(),
            (true, Some(waited.clone()))
        );
        // A fill may wait for what it produces without submitting.
        assert_eq!(
            type_submit(&json!({ "waitFor": waited })).unwrap(),
            (false, Some(waited.clone()))
        );
        for invalid in [
            json!({ "submit": "yes" }),
            json!({ "submit": true, "waitFor": { "typo": true } }),
            json!({ "waitFor": { "typo": true } }),
        ] {
            assert_eq!(
                type_submit(&invalid).unwrap_err().0,
                error_codes::INVALID_REQUEST,
                "{invalid}"
            );
        }
    }

    #[test]
    fn a_live_page_settles_absence_over_half_the_timeout_within_bounds() {
        assert_eq!(absence_settle(5_000, false), ABSENCE_SETTLE);
        assert_eq!(absence_settle(60_000, false), ABSENCE_SETTLE);
        assert_eq!(absence_settle(1_000, true), Duration::from_millis(1_500));
        assert_eq!(absence_settle(5_000, true), Duration::from_millis(2_500));
        assert_eq!(absence_settle(8_000, true), Duration::from_millis(4_000));
        assert_eq!(absence_settle(60_000, true), Duration::from_millis(5_000));
    }

    #[test]
    fn hidden_only_settle_is_a_fifth_of_the_timeout_within_bounds() {
        assert_eq!(hidden_only_settle(100), Duration::from_millis(750));
        assert_eq!(hidden_only_settle(3_000), Duration::from_millis(750));
        assert_eq!(hidden_only_settle(5_000), Duration::from_millis(1_000));
        assert_eq!(hidden_only_settle(10_000), Duration::from_millis(1_500));
        assert_eq!(hidden_only_settle(60_000), Duration::from_millis(1_500));
    }

    #[test]
    fn a_miss_ends_early_only_once_it_has_held_and_the_tab_has_loaded() {
        let page = |mutations: i64, elements: i64| PageScanState {
            id: "doc".into(),
            mutations,
            animating: false,
            elements,
        };
        let scan = |hidden: usize| CollectedLocatorMatches {
            matches: vec![],
            scanned: 3_000,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden,
            name_misses: vec![],
            candidates: vec![],
            nearest: None,
        };
        let start = tokio::time::Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);

        // A quiet page: absence holds for the fixed settle, never while loading.
        let mut clock = MissClock::default();
        assert!(!clock.missed(&scan(0), Some(&page(1, 1_000)), at(0), 5_000, false));
        assert!(!clock.missed(&scan(0), Some(&page(1, 1_000)), at(1_499), 5_000, false));
        assert!(!clock.missed(&scan(0), Some(&page(1, 1_000)), at(1_500), 5_000, true));
        assert!(clock.missed(&scan(0), Some(&page(1, 1_000)), at(1_500), 5_000, false));

        // A live page keeps its absence while its shape holds, over half the timeout.
        let mut clock = MissClock::default();
        assert!(!clock.missed(&scan(0), Some(&page(1, 1_000)), at(0), 8_000, false));
        clock.page_read(&page(1, 1_000), Some(&page(9, 1_004)));
        assert!(!clock.missed(&scan(0), Some(&page(9, 1_004)), at(1_500), 8_000, false));
        assert!(clock.missed(&scan(0), Some(&page(9, 1_004)), at(4_000), 8_000, false));

        // A page that changed shape starts absence over.
        clock.page_read(&page(9, 1_004), Some(&page(12, 1_200)));
        assert!(!clock.absence_pending());
        assert!(!clock.missed(&scan(0), Some(&page(12, 1_200)), at(6_000), 8_000, false));

        // Only hidden matches: a fifth of the timeout, however much the page churns.
        let mut clock = MissClock::default();
        assert!(!clock.missed(&scan(1), Some(&page(1, 1_000)), at(0), 5_000, false));
        clock.page_read(&page(1, 1_000), Some(&page(40, 1_300)));
        assert!(!clock.missed(&scan(1), Some(&page(40, 1_300)), at(999), 5_000, false));
        assert!(clock.missed(&scan(1), Some(&page(40, 1_300)), at(1_000), 5_000, false));
        // A scan without the hidden match restarts that clock.
        assert!(!clock.missed(&scan(0), Some(&page(40, 1_300)), at(1_100), 5_000, false));
        assert!(!clock.missed(&scan(1), Some(&page(40, 1_300)), at(1_200), 5_000, false));

        // A page whose revision cannot be read never ends a miss early.
        let mut clock = MissClock::default();
        for ms in [0, 2_000, 4_000] {
            assert!(!clock.missed(&scan(0), Some(&page(-1, 1_000)), at(ms), 5_000, false));
            assert!(!clock.missed(&scan(1), None, at(ms), 5_000, false));
        }

        // A timeout the caller wrote: absence waits it out, quiet page or
        // live, while a hidden-only miss still ends early.
        let mut clock = MissClock {
            patient: true,
            ..MissClock::default()
        };
        for ms in [0, 1_500, 3_000, 3_900] {
            assert!(!clock.missed(&scan(0), Some(&page(1, 1_000)), at(ms), 4_000, false));
            assert!(!clock.absence_settled(at(ms), 4_000));
        }
        let mut clock = MissClock {
            patient: true,
            ..MissClock::default()
        };
        assert!(!clock.missed(&scan(1), Some(&page(1, 1_000)), at(0), 5_000, false));
        assert!(clock.missed(&scan(1), Some(&page(1, 1_000)), at(1_000), 5_000, false));
    }

    #[test]
    fn close_tab_waits_for_a_snapshot_that_continues() {
        // agy's Wikipedia snapshot stopped at item 254 and closeTab closed the
        // tab with it; a complete snapshot or a find still closes it.
        assert!(!read_lets_tab_close(
            "snapshot",
            &json!({"nextOffset":254,"offset":0})
        ));
        assert!(read_lets_tab_close(
            "snapshot",
            &json!({"nextOffset":null,"totalItems":3})
        ));
        assert!(read_lets_tab_close("snapshot", &json!({"totalItems":0})));
        assert!(read_lets_tab_close(
            "find",
            &json!({"matches":[],"nextOffset":5})
        ));
    }

    #[test]
    fn open_read_validates_before_creating_a_tab_and_never_accepts_another_target() {
        assert!(open_read_request(&json!({})).unwrap().is_none());
        assert_eq!(
            open_read_request(&json!({"snapshot":true,"closeTab":true}))
                .unwrap()
                .unwrap()
                .0,
            "snapshot"
        );
        let (_, query) = open_read_request(
            &json!({"find":{"by":"text","value":"India","ancestors":"row","timeout":60000}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(query["timeout"], 10000);
        assert_eq!(query["callerTimeout"], true);
        let (_, query) = open_read_request(&json!({"find":{"by":"text","value":"India"}}))
            .unwrap()
            .unwrap();
        assert_eq!(query["timeout"], 5000);
        assert_eq!(query["callerTimeout"], false);
        for params in [
            json!({"closeTab":true}),
            json!({"snapshot":"true"}),
            json!({"closeTab":"true"}),
            json!({"find":{}}),
            json!({"snapshot":true,"find":{"by":"text","value":"x"}}),
            json!({"find":{"by":"text","value":"x","tabId":123}}),
        ] {
            assert!(open_read_request(&params).is_err(), "{params}");
        }
    }

    #[test]
    fn browser_open_requires_an_explicit_workspace() {
        for params in [
            json!({ "url": "https://example.com" }),
            json!({ "url": "https://example.com", "workspace": "" }),
            json!({ "url": "https://example.com", "workspace": "   " }),
        ] {
            let error = extract_browser_open_params(&params).unwrap_err();
            assert_eq!(error.0, error_codes::INVALID_REQUEST);
            assert!(error.1.contains("requires a workspace"));
        }
        assert_eq!(
            extract_browser_open_params(&json!({
                "url": "https://example.com",
                "workspace": " C:\\work\\alpha "
            }))
            .unwrap(),
            ("https://example.com", "C:\\work\\alpha")
        );
    }

    #[test]
    fn browser_close_requires_a_tab_and_explicit_workspace() {
        for params in [
            json!({ "tabId": 7 }),
            json!({ "tabId": 7, "workspace": "" }),
            json!({ "tabId": 7, "workspace": "   " }),
            json!({ "workspace": "C:\\work\\alpha" }),
        ] {
            let error = extract_browser_close_params(&params).unwrap_err();
            assert_eq!(error.0, error_codes::INVALID_REQUEST);
        }
        assert_eq!(
            extract_browser_close_params(&json!({
                "tabId": 7,
                "workspace": " C:\\work\\alpha "
            }))
            .unwrap(),
            (7, "C:\\work\\alpha")
        );
    }

    #[test]
    fn wait_script_checks_accessibility_names_without_interpolating_code() {
        let script = build_wait_for_text_js("Search Wikipedia');alert(1)//");
        assert!(script.contains("[aria-label],[placeholder],[alt],[title]"));
        assert!(script.contains("Search Wikipedia');alert(1)//"));
        assert!(!script.contains("const needle = Search Wikipedia"));
        assert!(script.contains("replace(/\\s+/g, ' ')"));
    }

    #[test]
    fn a_text_find_falls_back_to_the_attributes_a_text_wait_reads() {
        // Maps put "Alamat" only in an aria-label: wait saw the word while
        // find timed out beside it. Both now read the same attributes.
        let selector = "[aria-label],[placeholder],[alt],[title]";
        assert!(build_wait_for_text_js("Alamat").contains(selector));
        let find = build_find_js(
            1,
            "g1-e",
            &LocatorQuery {
                by: "text",
                value: "Alamat",
                name: None,
                exact: false,
                include_hidden: false,
                limit: 5,
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(find.contains(&format!("by === 'text' ? '{selector}' : '[title]'")));
    }

    #[test]
    fn only_a_read_may_take_screen_reader_text() {
        // Amazon's whole price sits in .a-offscreen (opacity 0): a read that
        // found nothing visible takes it, an action never does.
        let query = |screen_reader_text| LocatorQuery {
            by: "css",
            value: ".a-price .a-offscreen",
            name: None,
            exact: false,
            include_hidden: false,
            limit: 5,
            ancestors: Ancestors::Levels(0),
            screen_reader_text,
        };
        let read = build_find_js(1, "g1-e", &query(true));
        assert!(read.contains("const screenReaderText = true;"));
        assert!(read.contains("if (screenReaderText && unseen.length < collectLimit && keptForScreenReaders(el)) unseen.push(el);"));
        assert!(read.contains("!el.closest('[aria-hidden=\"true\"],[inert]')"));
        assert!(read.contains("el.checkVisibility({checkVisibilityCSS: true})"));
        // Every copy must carry words, or none is taken: Amazon's empty deal
        // price copy sat beside a filled list price copy.
        assert!(read.contains("if (screenReaderText && !matches.length && spokenCopies.every(el => normalize(readText(el)))) {"));
        assert!(read.contains("describe(el, unseenMatches)"));
        assert!(read.contains("matches, unseen: unseenMatches, scanned"));
        assert!(build_find_js(1, "g1-e", &query(false)).contains("const screenReaderText = false;"));
    }

    #[test]
    fn upload_files_are_confined_to_the_selected_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let inside = workspace.path().join("video.mp4");
        std::fs::write(&inside, b"video").unwrap();
        let canonical_workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let resolved =
            resolve_upload_files(&canonical_workspace, &json!({ "paths": ["video.mp4"] })).unwrap();
        assert_eq!(resolved, [std::fs::canonicalize(inside).unwrap()]);

        let outside = tempfile::NamedTempFile::new().unwrap();
        let error = resolve_upload_files(
            &canonical_workspace,
            &json!({ "paths": [outside.path().to_string_lossy()] }),
        )
        .unwrap_err();
        assert_eq!(error.0, error_codes::INVALID_REQUEST);
        assert!(error.1.contains("outside the selected workspace"));
    }

    #[test]
    fn upload_validation_rejects_empty_or_oversized_batches() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(resolve_upload_files(workspace.path(), &json!({ "paths": [] })).is_err());
        let too_many = (0..=MAX_UPLOAD_FILES)
            .map(|index| format!("file-{index}"))
            .collect::<Vec<_>>();
        assert!(resolve_upload_files(workspace.path(), &json!({ "paths": too_many })).is_err());
    }

    #[test]
    fn deep_ref_lookup_escapes_refs_and_uses_original_node_identity() {
        let expression = deep_ref_expression("g1-e1\";alert(1)//", "return el;");
        assert!(expression.contains("refRegistry.resolve(refId)"));
        assert!(!expression.contains("querySelector"));
        assert!(expression.contains(r#"const refId = "g1-e1\";alert(1)//""#));
        assert!(!expression.contains("const refId = g1-e1"));
    }

    #[test]
    fn unchanged_check_requires_exact_state_and_all_readiness_guards() {
        let sample = json!({"ok":true,"visible":true,"enabled":true,"receives":true,
            "x":1,"y":2,"width":20,"height":20,"tag":"input","inputType":"checkbox","checked":true});
        assert!(unchanged_check_sample(
            &sample,
            ActionabilityRequirement::Check(true)
        ));
        assert!(!unchanged_check_sample(
            &sample,
            ActionabilityRequirement::Check(false)
        ));
        assert!(!unchanged_check_sample(
            &sample,
            ActionabilityRequirement::Click
        ));
        for (key, invalid) in [
            ("ok", json!(false)),
            ("visible", json!(false)),
            ("enabled", json!(false)),
            ("receives", json!(false)),
            ("x", Value::Null),
            ("height", json!("20")),
            ("tag", json!("div")),
            ("inputType", json!("text")),
            ("checked", json!("true")),
            ("checked", Value::Null),
        ] {
            let mut bad = sample.clone();
            bad[key] = invalid;
            assert!(
                !unchanged_check_sample(&bad, ActionabilityRequirement::Check(true)),
                "{key}"
            );
        }
        for input_type in ["checkbox", "radio"] {
            for checked in [true, false] {
                let mut exact = sample.clone();
                exact["inputType"] = json!(input_type);
                exact["checked"] = json!(checked);
                assert_eq!(
                    unchanged_check_sample(&exact, ActionabilityRequirement::Check(checked)),
                    input_type == "checkbox" || checked
                );
            }
        }
        for (requested, mode) in [(true, "check"), (false, "uncheck")] {
            let script = actionability_wait_script(
                "g1-e1",
                true,
                None,
                ActionabilityRequirement::Check(requested),
            );
            assert!(script.contains(&format!("'{mode}', true")));
        }
    }

    #[test]
    fn drag_stability_checks_both_endpoints_and_finite_coordinates() {
        let points = [10.0, 20.0, 80.0, 90.0];
        assert!(drag_points_stable(points, [10.3, 20.0, 80.0, 90.4]));
        assert!(!drag_points_stable(points, [10.0, 21.0, 80.0, 90.0]));
        assert!(!drag_points_stable(points, [10.0, 20.0, 80.0, 91.0]));
        assert!(!drag_points_stable(points, [f64::NAN, 20.0, 80.0, 90.0]));
    }

    #[test]
    fn drag_actionability_distinguishes_blocked_points_from_unstable_geometry() {
        let requirement = ActionabilityRequirement::ClickAt(Some((0.6, 0.5)));
        let mut sample = json!({
            "visible": true, "enabled": true, "editable": true,
            "receives": false, "inViewport": true, "stable": false
        });
        assert_eq!(
            actionability_failure_reason(&sample, requirement),
            "covered by another element"
        );
        sample["inViewport"] = json!(false);
        assert_eq!(
            actionability_failure_reason(&sample, requirement),
            "outside the viewport after scrolling"
        );
        sample["receives"] = json!(true);
        sample["inViewport"] = json!(true);
        assert_eq!(
            actionability_failure_reason(&sample, requirement),
            "not stable"
        );
        sample["enabled"] = json!(false);
        assert_eq!(
            actionability_failure_reason(&sample, requirement),
            "disabled"
        );
        sample["visible"] = json!(false);
        assert_eq!(
            actionability_failure_reason(&sample, requirement),
            "not visible"
        );
    }

    #[test]
    fn drag_timeout_explains_no_dispatch_without_changing_other_actions() {
        let sample =
            json!({"visible": true, "enabled": true, "receives": false, "inViewport": true});
        let drag = actionability_timeout_message(
            "g1-e1",
            &sample,
            ActionabilityRequirement::ClickAt(None),
        );
        assert!(drag.contains("covered by another element"));
        assert!(drag.contains("no mouse button was pressed"));
        assert!(drag.contains("do not repeat unchanged blocked positions"));
        for requirement in [
            ActionabilityRequirement::Click,
            ActionabilityRequirement::Hover(None),
        ] {
            assert_eq!(
                actionability_timeout_message("g1-e1", &sample, requirement),
                "element ref 'g1-e1' did not become actionable: covered by another element"
            );
        }
        assert_eq!(
            actionability_failure_reason(&sample, ActionabilityRequirement::Editable),
            "not editable"
        );
        for requirement in [
            ActionabilityRequirement::Focus,
            ActionabilityRequirement::Select,
        ] {
            assert_eq!(
                actionability_failure_reason(&sample, requirement),
                "not stable"
            );
        }
    }

    #[test]
    fn screenshot_response_decodes_png_bytes() {
        let response = r#"{"data":"iVBORw0KGgo="}"#;
        assert_eq!(
            decode_screenshot_response(response).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(decode_screenshot_response(r#"{"error":{"message":"failed"}}"#).is_err());
    }

    #[test]
    fn key_event_uses_browser_virtual_key_metadata() {
        let enter = key_event_params("keyDown", "Enter", 0);
        assert_eq!(enter["windowsVirtualKeyCode"], 13);
        assert_eq!(enter["text"], "\r");
        let enter_up = key_event_params("keyUp", "Enter", 0);
        assert!(enter_up.get("text").is_none());
        let letter = key_event_params("keyDown", "a", 0);
        assert_eq!(letter["code"], "KeyA");
        assert_eq!(letter["text"], "a");
    }

    #[test]
    fn submission_observers_have_explicit_and_fallback_cleanup() {
        let script = submission_observer_script(42, 3000);
        assert!(script.contains("const key = '42'"));
        assert!(script.contains("document.removeEventListener('submit', state.listener, true)"));
        assert!(script.contains("clearTimeout(state.timer)"));
        assert!(script.contains("setTimeout(state.cleanup, 13000)"));
        assert!(submission_cleanup_script(42).contains("['42']?.cleanup()"));
    }

    #[test]
    fn mouse_click_uses_a_pressed_button_only_for_mouse_down() {
        let moved = mouse_event_params("mouseMoved", 12.5, 18.0, false, 0);
        assert_eq!(moved["button"], "none");
        assert_eq!(moved["buttons"], 0);
        assert_eq!(moved["clickCount"], 0);

        let pressed = mouse_event_params("mousePressed", 12.5, 18.0, true, 1);
        assert_eq!(pressed["button"], "left");
        assert_eq!(pressed["buttons"], 1);
        assert_eq!(pressed["clickCount"], 1);

        let released = mouse_event_params("mouseReleased", 12.5, 18.0, false, 1);
        assert_eq!(released["button"], "left");
        assert_eq!(released["buttons"], 0);
        assert_eq!(released["clickCount"], 1);
    }

    #[test]
    fn hover_position_is_optional_and_strictly_inside_the_target() {
        assert_eq!(extract_hover_position(&json!({})).unwrap(), None);
        assert_eq!(
            extract_hover_position(&json!({"position":{"x":0.6,"y":0.5}})).unwrap(),
            Some((0.6, 0.5))
        );
        for position in [
            Value::Null,
            json!({}),
            json!([0.6, 0.5]),
            json!({"x":0.5}),
            json!({"x":"0.5","y":0.5}),
            json!({"x":25,"y":0.5}),
            json!({"x":0,"y":0.5}),
            json!({"x":0.5,"y":1}),
            json!({"x":-0.1,"y":0.5}),
            json!({"x":0.5,"y":0.5,"extra":true}),
        ] {
            assert_eq!(
                extract_hover_position(&json!({"position":position}))
                    .unwrap_err()
                    .0,
                error_codes::INVALID_REQUEST
            );
        }
    }

    #[test]
    fn hover_probe_checks_requested_position_during_initial_and_settled_sampling() {
        for scroll in [true, false] {
            let script = actionable_probe_script("g1-e1", &scroll.to_string(), Some((0.6, 0.5)));
            assert!(script.contains(&format!(
                "prepareActionPoint(el, {scroll}, {{\"x\":0.6,\"y\":0.5}})"
            )));
            assert!(script.contains("receivesActionPointer(el, point)"));
        }
        assert!(actionable_probe_script("g1-e1", "false", None)
            .contains("prepareActionPoint(el, false, null)"));
    }

    #[test]
    fn a_hit_on_the_control_that_owns_the_target_is_the_target_receiving_it() {
        // YouTube's Skip button covers its own "Skip" text with a full-size
        // ::after; the click must reach the button, and a control stays strict.
        let script = actionable_probe_script("g1-e1", "true", None);
        assert!(script.contains("if (!first || element.matches?.(ACTION_CONTROL)) return false;"));
        assert!(script.contains("const owner = element.parentElement?.closest?.(ACTION_CONTROL);"));
        assert!(script.contains("return !!owner && owner.contains(first);"));
        assert!(script.contains("[role=\"button\"]"));
    }

    #[test]
    fn actionability_sampler_preserves_per_action_requirements_and_scroll_policy() {
        for (requirement, expected) in [
            (ActionabilityRequirement::Click, "pointer"),
            (ActionabilityRequirement::Hover(None), "pointer"),
            (ActionabilityRequirement::Focus, "focus"),
            (ActionabilityRequirement::Editable, "editable"),
            (ActionabilityRequirement::Select, "select"),
        ] {
            for scroll in [true, false] {
                let script = actionability_wait_script("g1-e1", scroll, None, requirement);
                assert!(script.contains("prepareActionPoint(el, scroll, null)"));
                assert!(script.contains(&format!("'{expected}', {scroll},")));
                assert!(script.contains("refRegistry.resolve(refId)"));
            }
        }
    }

    #[test]
    fn only_hover_installs_a_bounded_event_observer_in_the_existing_readiness_call() {
        let hover =
            actionability_wait_script("g1-e1", true, None, ActionabilityRequirement::Hover(None));
        assert!(hover.contains("beginHoverObservation(el, refId, point)"));
        assert!(hover.contains("window === window.top"));
        assert!(hover.contains("setTimeout(() => observation.stop(), 5000)"));
        for requirement in [
            ActionabilityRequirement::Click,
            ActionabilityRequirement::Check(true),
            ActionabilityRequirement::Editable,
            ActionabilityRequirement::Select,
            ActionabilityRequirement::Focus,
        ] {
            assert!(!actionability_wait_script("g1-e1", true, None, requirement)
                .contains("beginHoverObservation"));
        }
    }

    #[test]
    fn only_external_tabs_skip_waiting_for_frames_a_page_does_not_draw() {
        let requirement = ActionabilityRequirement::Click;
        let embedded = actionability_wait_script("g1-e1", true, None, requirement);
        assert!(embedded.ends_with("'pointer', true, undefined, undefined); })()"));
        let external = actionable_attempt_script("g1-e1", true, None, requirement, None, true);
        assert!(external.ends_with("'pointer', true, undefined, undefined, true); })()"));
    }

    #[test]
    fn value_attempt_defers_one_guarded_mutation_until_readiness() {
        let value_script = deep_ref_expression("g1-e1", "return JSON.stringify({ok: true});");
        for (requirement, expected) in [
            (ActionabilityRequirement::Editable, "editable"),
            (ActionabilityRequirement::Select, "select"),
        ] {
            for scroll in [true, false] {
                let script = actionable_attempt_script(
                    "g1-e1",
                    scroll,
                    None,
                    requirement,
                    Some(&value_script),
                    false,
                );
                let callback = format!(", () => JSON.parse({value_script})");
                assert_eq!(script.matches(&callback).count(), 1);
                assert!(script.contains(&format!("'{expected}', {scroll}{callback}, undefined)")));
                assert!(script.contains("prepareActionPoint(el, scroll, null)"));
                let readiness_only = actionability_wait_script("g1-e1", scroll, None, requirement);
                assert!(!readiness_only.contains(&callback));
            }
        }
    }

    #[test]
    fn semantic_locator_accepts_name_filters_for_every_strategy() {
        let locator = extract_locator(&json!({
            "by": "role",
            "value": "button",
            "name": "Save"
        }))
        .unwrap();
        assert_eq!(locator.by, "role");
        assert_eq!(locator.name.as_deref(), Some("Save"));

        // A css or text lookup narrowed by accessible name used to be refused,
        // which cost a turn to learn the rule and another to ask again.
        for by in ["css", "text", "label", "placeholder", "testId"] {
            let locator = extract_locator(&json!({
                "by": by,
                "value": "canvas",
                "name": "Chart for"
            }))
            .unwrap();
            assert_eq!(locator.name.as_deref(), Some("Chart for"), "{by}");
        }
        let error = extract_locator(&json!({
            "by": "css",
            "value": "canvas",
            "name": "x".repeat(MAX_LOCATOR_VALUE_BYTES + 1)
        }))
        .unwrap_err();
        assert_eq!(error.0, error_codes::INVALID_REQUEST);
    }

    #[test]
    fn navigation_hints_script_is_bounded_registers_refs_and_skips_page_chrome() {
        // The hints ride every navigated action's reply, so the script must
        // stay cheap: three controls at most, 60-character names, page chrome
        // and Anbo's own layers skipped. v2 registers each control as a live
        // ref under the scan's generation so the agent can act on it without
        // a snapshot, and the heading falls back to og:title for pages whose
        // title is not an h1.
        let script = build_navigation_hints_js(7, "g7-e", &[], HintsGate::Any);
        assert!(script.contains("refRegistry.begin(7);"));
        assert!(script.contains(r#"const refPrefix = "g7-e";"#));
        assert!(script.contains("const ref = refPrefix + (++registered);"));
        assert!(script.contains("refRegistry.remember(ref, el);"));
        assert!(script.contains("controls.push({ ref: remember(el), role, name });"));
        // Result titles: bounded, in or around an h2-h4, within two screens.
        assert!(script.contains("found.length >= 5 || ++links > 3000"));
        assert!(script.contains("el.closest('h2,h3,h4') || el.querySelector('h2,h3,h4')"));
        assert!(script.contains("rect.top < innerHeight * 2"));
        // A result title must be visible, not only laid out, and so must a
        // control: TradingView's hidden twin of its symbol button was handed out.
        assert!(script.matches("if (!shown(el)) continue;").count() >= 2);
        // The heading is the first line of the first h1 a reader can see.
        assert!(script.contains("checkVisibility"));
        assert!(script.contains(".slice(0, 120)"));
        assert!(script.contains("controls.length >= 3"));
        assert!(script.contains("el.tagName.startsWith('ANBO-')"));
        assert!(script.contains("closest('nav,header,aside,footer"));
        assert!(script.contains(".slice(0, 60)"));
        assert!(script.contains("document.readyState === 'loading'"));
        assert!(script.contains(r#"meta[property="og:title"]"#));
        // The built script must carry no unexpanded format placeholders.
        assert!(!script.contains("{{"));
        assert!(!script.contains("}}"));
    }

    #[test]
    fn wait_conditions_remain_backward_compatible_and_support_richer_states() {
        assert!(matches!(
            extract_wait_condition(&json!({ "text": "Dashboard" })).unwrap(),
            WaitCondition::Text(text) if text == "Dashboard"
        ));
        assert!(matches!(
            extract_wait_condition(&json!({
                "condition": "load",
                "loadState": "networkIdle"
            }))
            .unwrap(),
            WaitCondition::Load { state } if state == "networkIdle"
        ));
        assert!(matches!(
            extract_wait_condition(&json!({
                "condition": "ref",
                "ref": "g2-e4",
                "state": "checked"
            }))
            .unwrap(),
            WaitCondition::Ref { ref_id, state }
                if ref_id == "g2-e4" && state == "checked"
        ));
    }

    #[test]
    fn url_wait_globs_are_anchored_at_non_wildcard_edges() {
        assert!(glob_matches(
            "https://example.com/*/done",
            "https://example.com/jobs/42/done"
        ));
        assert!(!glob_matches(
            "https://example.com/*/done",
            "prefix/https://example.com/jobs/42/done"
        ));
        assert!(!glob_matches(
            "https://example.com/*/done",
            "https://example.com/jobs/42/done/extra"
        ));
    }

    #[test]
    fn keyboard_modifiers_are_deduplicated_and_bounded() {
        let modifiers = extract_key_modifiers(&json!({
            "modifiers": ["Control", "Shift", "Control"]
        }))
        .unwrap();
        assert_eq!(modifier_names(modifiers), ["Control", "Shift"]);
        assert!(extract_key_modifiers(&json!({ "modifiers": ["Hyper"] })).is_err());
    }

    #[test]
    fn a_confirmed_absence_names_the_controls_it_saw() {
        // Measured: when a first-choice selector missed (Maps 3 of 3 sessions,
        // Amazon 3 of 6), the agent spent its next turn on a snapshot before
        // acting. The scan had already walked past the controls it needed.
        let locator = extract_locator(&json!({"by":"css", "value":"#searchboxinput"})).unwrap();
        let candidate = |role: &str, name: &str| super::super::locator::Candidate {
            role: role.into(),
            name: name.into(),
            in_viewport: true,
        };
        let with = |hidden: usize, misses: Vec<&str>| CollectedLocatorMatches {
            matches: vec![],
            scanned: 642,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden,
            name_misses: misses.into_iter().map(str::to_string).collect(),
            candidates: vec![
                candidate("textbox", "Telusuri Google Maps"),
                candidate("button", "Telusuri"),
                candidate("button", "Rute"),
            ],
            nearest: None,
        };
        let absent = find_timeout(&locator, 1_900, 2, None, Some(&with(0, vec![])), 3);
        assert!(absent.1.contains("confirmed absence"), "{}", absent.1);
        assert!(
            absent.1.contains(
                "interactive elements seen: textbox \"Telusuri Google Maps\", button \"Telusuri\", button \"Rute\""
            ),
            "{}",
            absent.1
        );
        assert!(
            absent.1.contains("not equivalent or verified unique"),
            "{}",
            absent.1
        );

        let hidden = find_timeout(&locator, 1_900, 2, None, Some(&with(2, vec![])), 3);
        assert!(
            hidden.1.contains("interactive elements seen"),
            "{}",
            hidden.1
        );
        assert!(hidden.1.contains("inspection, not input"));
        let near = find_timeout(&locator, 1_900, 2, None, Some(&with(0, vec!["Search"])), 3);
        assert!(!near.1.contains("interactive elements seen"), "{}", near.1);
        // A scan cut off by the deadline proves nothing, so it offers nothing.
        let cut = find_timeout(
            &locator,
            1_900,
            2,
            Some("deadline"),
            Some(&with(0, vec![])),
            0,
        );
        assert!(!cut.1.contains("interactive elements seen"), "{}", cut.1);
        for skipped in [false, true] {
            let mut scan = with(2, vec![]);
            scan.node_limit_reached = !skipped;
            scan.skipped_frames = usize::from(skipped);
            let incomplete = find_timeout(&locator, 1_900, 2, None, Some(&scan), 0);
            assert!(!incomplete.1.contains("interactive elements seen"));
        }
        let mut scan = with(2, vec![]);
        scan.candidates = (0..8)
            .map(|_| candidate("button", "BTCUSDT\"\ncontrol"))
            .collect();
        let escaped = find_timeout(&locator, 1_900, 2, None, Some(&scan), 0).1;
        assert_eq!(escaped.matches("BTCUSDT").count(), 4);
        assert!(escaped.contains("BTCUSDT\\\"\\ncontrol"));
    }

    #[test]
    fn a_css_miss_names_the_nearest_selector_that_matches() {
        // Measured: every canvas miss on Maps and TradingView was followed by
        // find(css:canvas). The reply that reports the miss now says so.
        let locator =
            extract_locator(&json!({"by":"css", "value":"table.chart-markup-table.pane canvas"}))
                .unwrap();
        let scan = |nearest: Option<super::super::locator::NearestCss>| CollectedLocatorMatches {
            matches: vec![],
            scanned: 3_058,
            truncated: false,
            node_limit_reached: false,
            included_frames: 1,
            skipped_frames: 0,
            hidden: 0,
            name_misses: vec![],
            candidates: vec![],
            nearest,
        };
        let near = super::super::locator::NearestCss {
            selector: "canvas".into(),
            count: 3,
            visible: 1,
            examples: vec![super::super::locator::NearestExample {
                tag: "canvas".into(),
                role: String::new(),
                name: String::new(),
            }],
        };
        let absent = find_timeout(&locator, 1_900, 2, None, Some(&scan(Some(near.clone()))), 3);
        assert!(absent.1.contains("confirmed absence"), "{}", absent.1);
        assert!(
            absent.1.contains("nearest css match: 'canvas' matches 3 (1 visible: canvas); use it with browser_find by css"),
            "{}",
            absent.1
        );
        // Nothing to offer, nothing said; a scan cut short offers nothing either.
        assert!(
            !find_timeout(&locator, 1_900, 2, None, Some(&scan(None)), 3)
                .1
                .contains("nearest css match")
        );
        assert!(!find_timeout(
            &locator,
            1_900,
            2,
            Some("deadline"),
            Some(&scan(Some(near))),
            0
        )
        .1
        .contains("nearest css match"));
    }
}

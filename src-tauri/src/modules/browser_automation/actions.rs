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
use tauri::Webview;

use super::accessible_name::ACCESSIBLE_NAME_JS;
use crate::modules::app_data::local_data_root;
use crate::modules::browser::embed::{
    active_loading, active_local_root, active_navigation_generation, active_pending_url,
    set_active_loading, set_active_pending_url, BROWSER_POPUP_REQUEST_EVENT,
};
use crate::modules::browser_automation::cdp::{
    call_devtools_protocol_method, capture_screenshot, execute_script, execute_script_with_timeout,
    read_url,
};
use crate::modules::browser_automation::download;
use crate::modules::browser_automation::locator::{
    build_find_js, LocatorMatch, LocatorPayload, LocatorQuery, MAX_LOCATOR_MATCHES,
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
use crate::modules::browser_automation::snapshot::{
    build_frame_snapshot_js, build_snapshot_js, format_snapshot, get_current_generation,
    get_next_generation, get_ref_frame_target, prioritize_snapshot_elements,
    replace_ref_frame_targets, RefFrameTarget, SnapshotPayload, DEFAULT_SNAPSHOT_MAX_CHARS,
};
use crate::modules::browser_automation::timings::ActionTimings;
use crate::modules::browser_automation::visibility::VISIBILITY_JS;

/// Per-poll timeout for `execute_script` inside readiness/wait loops. Short on
/// purpose: while a tab is navigating, WebView2 drops the script callback, and a
/// single dropped callback must not be allowed to eat the whole wait budget.
const SCRIPT_POLL_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_TEXT_OUTPUT_CHARS: u64 = 16_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 60_000;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_INPUT_TEXT_BYTES: usize = 64 * 1024;
const MAX_WAIT_TEXT_BYTES: usize = 2 * 1024;
const MAX_LOCATOR_VALUE_BYTES: usize = 4 * 1024;
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

fn artifacts_dir() -> Result<PathBuf, String> {
    let root = local_data_root()?;
    let dir = root.join("browser").join("artifacts");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create artifacts dir: {e}"))?;
    cleanup_artifacts(&dir);
    Ok(dir)
}

fn cleanup_artifacts(dir: &PathBuf) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = Vec::new();
    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                let modified = meta.modified().unwrap_or(UNIX_EPOCH);
                let age_secs = now
                    .duration_since(modified)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if age_secs > 7 * 86400 {
                    let _ = fs::remove_file(&path);
                } else {
                    files.push((path, modified));
                }
            }
        }
    }

    if files.len() > 100 {
        files.sort_by_key(|(_, m)| *m);
        let remove_count = files.len() - 100;
        for (path, _) in files.into_iter().take(remove_count) {
            let _ = fs::remove_file(path);
        }
    }
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
            .and_then(Value::as_u64)
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
    let result = super::activity::track(
        app,
        method,
        params.get("tabId").and_then(Value::as_i64),
        caller,
        handle_action_inner(app, method, params, &mut timings, &actor),
    )
    .await;
    let result = timings.finish(result);
    if method.starts_with("agent_") || method.starts_with("terminal_") {
        return result;
    }
    result.map(|mut value| {
        if let Some(object) = value.as_object_mut() {
            let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            object.insert("durationMs".to_string(), Value::from(elapsed));
        }
        value
    })
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
        return Err((
            error_codes::INVALID_REQUEST.into(),
            "no browser session: call browser_start_session first, then run this action under the controlId it returns and close it with browser_end_session when the task is done".into(),
        ));
    }
    if params.get("locator").is_some() {
        if params.get("ref").is_some()
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
                resolve_target_locator(app, &params, method == "wait"),
            )
            .await?;
        if method == "wait" {
            return Ok(resolved);
        }
        params["ref"] = resolved["ref"].clone();
    }
    match method {
        "open" => {
            let mut result = open_browser(app, &params, caller).await?;
            // The tab an agent just opened is the tab it is about to work, and
            // the open response is the first thing it reads. Naming the session
            // here spares it hunting for the id in some later call's payload,
            // which is what agents were actually doing.
            if let Some(object) = result.as_object_mut() {
                let tab_id = object.get("tabId").and_then(Value::as_i64);
                if let Some(control_id) = super::activity::begin_session(app, tab_id, caller) {
                    object.insert("controlId".into(), control_id.into());
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
            Ok(json!({
                "tabs": result,
                "activeTabId": active_tab_id,
                "activeSpaceId": active_space_id,
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
            if let Err(error) = webview.navigate(target) {
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
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS);
            let formatted = format_snapshot(&payload, gen, requested_max_chars);

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
                "includedFrames": included_frames,
                "skippedFrames": skipped_frames
            }))
        }

        "find" => {
            let tab_id = extract_tab_id(&params)?;
            let locator = extract_locator(&params)?;
            let timeout_ms = params
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(5_000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

            let mut empty_scans = 0;
            let mut last_empty_scan = None;
            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(find_timeout(
                        &locator,
                        timeout_ms,
                        empty_scans,
                        None,
                        last_empty_scan.as_ref(),
                    ));
                }
                let (generation, result) = scan_with_fresh_refs(tab_id, deadline, |generation| {
                    collect_locator_matches(&webview, tab_id, generation, &locator)
                })
                .await
                .map_err(|error| {
                    if error.0 == error_codes::TIMEOUT {
                        find_timeout(
                            &locator,
                            timeout_ms,
                            empty_scans,
                            Some(&error.1),
                            last_empty_scan.as_ref(),
                        )
                    } else {
                        error
                    }
                })?;
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
                last_empty_scan = Some(result);
                tokio::time::sleep_until(
                    (tokio::time::Instant::now() + Duration::from_millis(150)).min(deadline),
                )
                .await;
            }
        }

        "click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let expectation = PageExpectation::parse(params.get("waitFor"))?;
            let tab_lock = get_tab_lock(tab_id);
            let (webview, dispatch) = {
                let _lock = timings.measure("queue", tab_lock.lock()).await;
                let webview = get_embed_webview(app, tab_id)
                    .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
                let generation = get_current_generation(tab_id);
                ensure_current_ref(&ref_id, generation)?;
                timings
                    .measure("ready", wait_for_ready(&webview, 3000))
                    .await;
                let target = get_ref_frame_target(tab_id, &ref_id);
                let popup_url = timings
                    .measure(
                        "popupLookup",
                        popup_url_for_ref(&webview, target.as_ref(), &ref_id, generation),
                    )
                    .await
                    .unwrap_or(None);
                let dispatch = click_ref_profiled(&webview, tab_id, &ref_id, timings).await?;
                if let Some(url) = popup_url {
                    let _ = app.emit(
                        BROWSER_POPUP_REQUEST_EVENT,
                        json!({ "sourceTabId": tab_id, "url": url }),
                    );
                }
                (webview, dispatch)
            };
            let mut result = json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "dispatch": dispatch
            });
            if let Some(expectation) = expectation {
                result["postcondition"] = timings.measure("postcondition", wait_for_page_state(&webview, tab_id, &expectation)).await
                    .map_err(|(code, message)| (code, format!("click was dispatched, but {message}; inspect the page before retrying the click")))?;
            }
            Ok(result)
        }

        "double_click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
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
                generation,
                ActionabilityRequirement::Click,
            )
            .await?;
            let dispatch = if target.as_ref().is_some_and(|target| !target.is_main) {
                dom_click_ref(&webview, target.as_ref(), &ref_id, generation, 2).await?;
                "dom-frame"
            } else {
                dispatch_mouse_click(&webview, &actionable, &ref_id, 2).await?;
                "devtools"
            };
            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "dispatch": dispatch,
                "clickCount": 2
            }))
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
                generation,
                ActionabilityRequirement::Focus,
            )
            .await?;
            let script = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                        return JSON.stringify({{ ok: false, error: 'stale_ref' }});
                    }}
                    el.focus({{ preventScroll: true }});
                    const root = el.getRootNode && el.getRootNode();
                    return JSON.stringify({{ ok: !!root && root.activeElement === el }});"#
                ),
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
                generation,
                ActionabilityRequirement::Click,
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
                    dom_click_ref(&webview, target.as_ref(), &ref_id, generation, 1).await?;
                } else {
                    dispatch_mouse_click(&webview, &actionable, &ref_id, 1).await?;
                }
            }
            let checked =
                wait_for_checked_state(&webview, target.as_ref(), &ref_id, generation, requested)
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
            if source_ref == target_ref {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "sourceRef and targetRef must be different".to_string(),
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
                generation,
                ActionabilityRequirement::Click,
            )
            .await?;
            let dispatch = if source.draggable
                || source_target.as_ref().is_some_and(|target| !target.is_main)
            {
                wait_for_actionable_ref(
                    &webview,
                    destination_target.as_ref(),
                    &target_ref,
                    generation,
                    ActionabilityRequirement::Click,
                )
                .await?;
                dispatch_dom_drag(
                    &webview,
                    source_target.as_ref(),
                    &source_ref,
                    &target_ref,
                    generation,
                )
                .await?;
                if source.draggable {
                    "dom-html5"
                } else {
                    "dom-frame"
                }
            } else {
                let pair =
                    wait_for_drag_pair(&webview, &source_ref, &target_ref, generation).await?;
                dispatch_mouse_drag(&webview, pair, &source_ref, &target_ref, generation)
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
            let append = params
                .get("append")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            ensure_current_ref(&ref_id, cur_gen)?;
            let target = get_ref_frame_target(tab_id, &ref_id);
            wait_for_actionable_ref(
                &webview,
                target.as_ref(),
                &ref_id,
                cur_gen,
                ActionabilityRequirement::Editable,
            )
            .await?;

            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if (!el || el.getAttribute('data-anbo-gen') !== "gen-{cur_gen}") {{
                        return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    }}
                    el.focus();
                    const text = {};
                    const currentValue = el.isContentEditable
                        ? (el.textContent || '')
                        : (el.value || '');
                    const nextValue = {} ? currentValue + text : text;
                    const prototype = el instanceof HTMLTextAreaElement
                        ? HTMLTextAreaElement.prototype
                        : el instanceof HTMLInputElement
                          ? HTMLInputElement.prototype
                          : null;
                    const setter = prototype
                        ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
                        : null;
                    if (setter) setter.call(el, nextValue);
                    else if (el.isContentEditable) el.textContent = nextValue;
                    else el.value = nextValue;
                    el.dispatchEvent(new InputEvent('input', {{
                        bubbles: true,
                        data: text,
                        inputType: 'insertText'
                    }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    const actual = el.isContentEditable ? (el.textContent || '') : el.value;
                    return JSON.stringify({{ ok: el.isConnected && actual === nextValue, error: 'input_mismatch' }});"#,
                    serde_json::to_string(text).unwrap(),
                    append
                ),
            );

            let res = execute_ref_script(&webview, target.as_ref(), &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();

            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                Ok(json!({ "tabId": tab_id, "ref": ref_id, "ok": true, "valueVerified": true }))
            } else {
                if parsed.get("error").and_then(Value::as_str) == Some("input_mismatch") {
                    return Err((error_codes::INPUT_MISMATCH.to_string(), "input did not retain the requested value; inspect the field before submitting".to_string()));
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
            let preflight =
                inspect_file_input(&webview, target.as_ref(), &ref_id, current_generation).await?;
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
            let selected =
                inspect_file_input(&webview, target.as_ref(), &ref_id, current_generation).await?;
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
            let expectation = PageExpectation::parse(params.get("waitFor"))?;
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
                .and_then(Value::as_u64)
                .unwrap_or(SUBMISSION_OBSERVATION_MS)
                .min(10_000);
            let should_observe =
                key == "Enter" && observation_timeout_ms > 0 && expectation.is_none();

            let tab_lock = get_tab_lock(tab_id);
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
                    // Focus emulation can run page focus handlers. Prepare it before
                    // checking the target, immediately ahead of native key dispatch.
                    timings.measure("focusEmulation", call_devtools_with_retry(
                        &webview, "Emulation.setFocusEmulationEnabled", r#"{"enabled":true}"#, 2,
                    )).await.map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
                    if let Some(ref_id) = input_ref.as_deref() {
                        let generation = get_current_generation(tab_id);
                        ensure_current_ref(ref_id, generation)?;
                        let target = get_ref_frame_target(tab_id, ref_id);
                        let script = deep_ref_expression(ref_id, &input_guard_body(generation, expected_value));
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
                    }
                    dispatch_key(&webview, key, timings).await.map_err(|error| (error_codes::CDP_FAILED.to_string(), error))
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

            let mut result = json!({
                "tabId": tab_id,
                "key": key,
                "ok": true,
                "dispatch": "devtools",
                "submissionObserved": observation.submit_event,
                "navigationObserved": observation.navigation,
                "observationPerformed": should_observe,
                "observationWindowMs": if should_observe { observation_timeout_ms } else { 0 }
            });
            if let Some(expectation) = expectation {
                result["postcondition"] = timings.measure("postcondition", wait_for_page_state(&webview, tab_id, &expectation)).await
                    .map_err(|(code, message)| (code, format!("key was dispatched, but {message}; inspect the page before resubmitting")))?;
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
            if let Some(expectation) = PageExpectation::parse(params.get("waitFor"))? {
                if [
                    "condition",
                    "text",
                    "url",
                    "ref",
                    "state",
                    "loadState",
                    "timeout",
                ]
                .iter()
                .any(|key| params.get(*key).is_some())
                {
                    return Err((error_codes::INVALID_REQUEST.to_string(), "waitFor cannot be combined with legacy wait conditions or timeout; put timeout inside waitFor".to_string()));
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
                .and_then(|v| v.as_u64())
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
                generation,
                ActionabilityRequirement::Click,
            )
            .await?;
            install_dialog_capture(&webview, target.as_ref(), action == "accept", prompt_text)
                .await?;
            let trigger_result = if target.as_ref().is_some_and(|target| !target.is_main) {
                dom_click_ref(&webview, target.as_ref(), &ref_id, generation, 1)
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
            let skill = crate::modules::skills::read_skill(&root, name)
                .map_err(|e| (error_codes::INVALID_REQUEST.to_string(), e))?;
            Ok(serde_json::to_value(skill).unwrap_or_default())
        }

        "emulate" => {
            let tab_id = extract_tab_id(&params)?;
            let width = params.get("width").and_then(Value::as_u64).unwrap_or(0);
            let height = params.get("height").and_then(Value::as_u64).unwrap_or(0);
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
            crate::modules::browser::embed::apply_viewport(
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

            let workspace = params.get("workspace").and_then(|v| v.as_str());
            let dir = if let Some(ws) = workspace {
                let ws_path = PathBuf::from(ws);
                let out_dir = ws_path.join(".anbo").join("artifacts");
                fs::create_dir_all(&out_dir)
                    .map_err(|e| (error_codes::INTERNAL.to_string(), e.to_string()))?;
                out_dir
            } else {
                artifacts_dir().map_err(|e| (error_codes::INTERNAL.to_string(), e))?
            };

            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let file_path = dir.join(format!("screenshot_{tab_id}_{ts}.png"));
            let response = capture_screenshot(&webview)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let bytes = decode_screenshot_response(&response)
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            fs::write(&file_path, &bytes).map_err(|e| {
                (
                    error_codes::INTERNAL.to_string(),
                    format!("failed to write screenshot: {e}"),
                )
            })?;
            Ok(json!({
                "tabId": tab_id,
                "path": file_path.to_string_lossy(),
                "size": bytes.len(),
                "format": "png"
            }))
        }

        "download" => {
            let tab_id = extract_tab_id(&params)?;
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
                .and_then(Value::as_u64)
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
                .and_then(Value::as_u64)
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
            wait_for_actionable_ref(
                &webview,
                target.as_ref(),
                &ref_id,
                cur_gen,
                ActionabilityRequirement::Focus,
            )
            .await?;
            let value_json = serde_json::to_string(value).unwrap();
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if (!el || el.getAttribute('data-anbo-gen') !== "gen-{cur_gen}") {{
                        return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    }}
                    if (el.tagName !== 'SELECT') return JSON.stringify({{ ok: false, error: "not_a_select" }});
                    const want = {value_json};
                    let matched = null;
                    for (const opt of el.options) {{
                        const label = (opt.textContent || '').trim();
                        if (opt.value === want || label === want) {{ matched = opt; break; }}
                    }}
                    if (!matched) return JSON.stringify({{ ok: false, error: "option_not_found", want: want }});
                    el.focus();
                    el.value = matched.value;
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return JSON.stringify({{ ok: true, value: matched.value, label: (matched.textContent || '').trim() }});"#
                ),
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
                    "value": parsed.get("value").cloned().unwrap_or(Value::Null),
                    "label": parsed.get("label").cloned().unwrap_or(Value::Null),
                    "ok": true
                }))
            } else {
                let err = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stale_ref");
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
                cur_gen,
                ActionabilityRequirement::Hover(position),
            )
            .await?;
            let main_document = target.as_ref().is_none_or(|target| target.is_main);
            if main_document {
                dispatch_mouse_move(&webview, actionable.x, actionable.y)
                    .await
                    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            }
            let js = deep_ref_expression(
                &ref_id,
                &format!(
                    r#"
                    if (!el || el.getAttribute('data-anbo-gen') !== "gen-{cur_gen}") {{
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
                if main_document && !css_hover {
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
                    "dispatch": if main_document { "devtools" } else { "dom-frame" }
                }))
            } else {
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
                &format!(
                    r#"
                    if (!el || el.getAttribute('data-anbo-gen') !== "gen-{cur_gen}") {{
                        return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    }}
                    el.scrollIntoView({{ block: 'center', inline: 'center' }});
                    const r = el.getBoundingClientRect();
                    return JSON.stringify({{ ok: true, rect: {{ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }} }});"#
                ),
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
                .and_then(|v| v.as_u64())
                .unwrap_or(8000)
                .clamp(1, MAX_TEXT_OUTPUT_CHARS);
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 5000).await;
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
                    const readable = readableText(el);
                    const domText = readable.text;
                    const accessibleText = domText ? '' : accessibleName(el);
                    const text = domText || accessibleText.trim();
                    const source = domText ? 'domText' : (text ? 'accessibleName' : 'empty');
                    const max = {max_length};
                    let truncated = readable.sourceTruncated;
                    let out = text;
                    if (text.length > max) {{ out = clipReadableText(text, max); truncated = true; }}
                    return JSON.stringify({{ ok: true, text: out, source: source, visible: isRenderedElement(el), truncated: truncated, totalLength: text.length, totalLengthIsLowerBound: readable.sourceTruncated }});"#
            );
            let js = if let Some(ref_id) = ref_id.as_deref() {
                let generation = get_current_generation(tab_id);
                deep_ref_expression(
                    ref_id,
                    &format!(
                        r#"
                        if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                            return JSON.stringify({{ ok: false, error: "stale_ref", reason: refRegistry.reason(refId) }});
                        }}
                        {text_body}"#
                    ),
                )
            } else {
                format!("(function() {{ const el = document.body; {text_body} }})()")
            };
            let res = execute_ref_script(&webview, target.as_ref(), &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                Ok(json!({
                    "tabId": tab_id,
                    "ref": ref_id,
                    "text": parsed.get("text").cloned().unwrap_or(Value::Null),
                    "source": parsed.get("source").cloned().unwrap_or(Value::Null),
                    "visible": parsed.get("visible").and_then(Value::as_bool).unwrap_or(false),
                    "truncated": parsed.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                    "totalLength": parsed.get("totalLength").and_then(|v| v.as_u64()).unwrap_or(0),
                    "totalLengthIsLowerBound": parsed.get("totalLengthIsLowerBound").and_then(Value::as_bool).unwrap_or(false)
                }))
            } else {
                let err = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stale_ref");
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!(
                        "get_text failed: {err} (reason: {})",
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
                json!({ "tabId": tab_id, "title": title, "titleSource": title_source, "url": url, "urlSource": "native" }),
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

            let (logs, included_frames, skipped_frames) = collect_console_logs(&webview).await;
            Ok(json!({
                "logs": logs,
                "includedFrames": included_frames,
                "skippedFrames": skipped_frames
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
    current_generation: u64,
) -> Result<Value, (String, String)> {
    let body = format!(
        r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{current_generation}") {{
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
            let timestamp = entry.get("ts").and_then(Value::as_u64).unwrap_or(0);
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

    logs.sort_by_key(|entry| entry.get("ts").and_then(Value::as_u64).unwrap_or(0));
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
    let params = json!({
        "expression": expression,
        "contextId": context_id,
        "returnByValue": true,
        "awaitPromise": false,
        "userGesture": true
    })
    .to_string();
    let raw =
        call_devtools_protocol_method(webview, "Runtime.evaluate", &params, Duration::from_secs(5))
            .await?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid Runtime.evaluate response: {error}"))?;
    if let Some(details) = payload.get("exceptionDetails") {
        return Err(format!("frame script failed: {details}"));
    }
    let result = payload
        .get("result")
        .ok_or_else(|| "Runtime.evaluate response omitted result".to_string())?;
    if let Some(value) = result.get("value") {
        return match value {
            Value::String(text) => Ok(text.clone()),
            other => Ok(other.to_string()),
        };
    }
    if result.get("subtype").and_then(Value::as_str) == Some("null") {
        return Ok("null".to_string());
    }
    Err("Runtime.evaluate result could not be returned by value".to_string())
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
}

/// Name the elements that collided, so narrowing them does not cost another
/// round trip.
///
/// "matched multiple elements" tells the caller to narrow without telling them
/// what to narrow against; the two candidates are already in hand.
fn describe_ambiguity(
    error: (String, String),
    matches: &[LocatorMatch],
) -> (String, String) {
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
            format!("<{}> \"{label}\"{position}{hidden}", item.tag)
        })
        .collect::<Vec<_>>()
        .join("; ");
    (error.0, format!("{}; candidates: {candidates}", error.1))
}

fn find_timeout(
    locator: &LocatorRequest,
    timeout_ms: u64,
    empty_scans: usize,
    scan_error: Option<&str>,
    last_empty_scan: Option<&CollectedLocatorMatches>,
) -> (String, String) {
    // What the caller needs is not how many scans ran, but whether this is a
    // verdict they can act on. A page scanned end to end with nothing matching
    // is a real absence; a truncated scan is not; and a locator that matched
    // elements nobody can see is neither -- it is a visibility filter the
    // caller can lift.
    let hidden = last_empty_scan.map_or(0, |scan| scan.hidden);
    let detail = if empty_scans == 0 {
        "no scan completed".to_string()
    } else if let Some(scan) =
        last_empty_scan.filter(|scan| scan.node_limit_reached || scan.skipped_frames > 0)
    {
        format!(
            "page coverage incomplete after {empty_scans} scans ({} nodes scanned{}); the element may exist in the unscanned part, so this is not a confirmed absence",
            scan.scanned,
            if scan.skipped_frames > 0 { format!(", {} frames skipped", scan.skipped_frames) } else { String::new() },
        )
    } else if hidden > 0 {
        format!(
            "{hidden} element(s) matched but are not rendered, so they were filtered out; retry with includeHidden=true to address them"
        )
    } else if let Some(names) = last_empty_scan
        .filter(|scan| !scan.name_misses.is_empty())
        .map(|scan| scan.name_misses.join("\", \""))
    {
        format!(
            "the role matched but no accessible name contained the requested one; names seen here: \"{names}\""
        )
    } else {
        format!(
            "page fully scanned {empty_scans} time(s) ({} nodes) and no element matched; this is a confirmed absence",
            last_empty_scan.map_or(0, |scan| scan.scanned),
        )
    };
    (
        error_codes::TIMEOUT.to_string(),
        format!(
            "timed out finding {} '{}' after {timeout_ms}ms: {detail}{}{}",
            locator.by,
            locator.value,
            scan_error
                .map(|error| format!("; latest scan: {error}"))
                .unwrap_or_default(),
            last_empty_scan.map(|scan| format!("; last completed coverage: scanned={}, nodeLimitReached={}, includedFrames={}, skippedFrames={}", scan.scanned, scan.node_limit_reached, scan.included_frames, scan.skipped_frames)).unwrap_or_default()
        ),
    )
}

fn extract_locator(params: &Value) -> Result<LocatorRequest, (String, String)> {
    let by = params.get("by").and_then(Value::as_str).ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            "browser_find requires a 'by' locator type".to_string(),
        )
    })?;
    if !matches!(
        by,
        "role" | "text" | "label" | "placeholder" | "testId" | "title" | "alt" | "css"
    ) {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unsupported locator type '{by}'"),
        ));
    }
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                "browser_find requires a non-empty 'value'".to_string(),
            )
        })?;
    ensure_bounded(value, MAX_LOCATOR_VALUE_BYTES, "value")?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    if let Some(name) = name.as_deref() {
        ensure_bounded(name, MAX_LOCATOR_VALUE_BYTES, "name")?;
        if by != "role" {
            return Err((
                error_codes::INVALID_REQUEST.to_string(),
                "locator 'name' is only supported with by='role'".to_string(),
            ));
        }
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
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(10)
            .clamp(1, MAX_LOCATOR_MATCHES),
    })
}

async fn resolve_target_locator(
    app: &AppHandle,
    params: &Value,
    waiting: bool,
) -> Result<Value, (String, String)> {
    let target = &params["locator"];
    let lookup_timeout = super::locator_target::validate_locator(target)?;
    let mut locator = extract_locator(target)?;
    locator.limit = 2;
    let invalid = || {
        (error_codes::INVALID_REQUEST.into(), "locator wait accepts locator, state, and top-level timeout, not legacy conditions or waitFor".into())
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
            Some(value) => value
                .as_u64()
                .filter(|n| (100..=MAX_WAIT_TIMEOUT_MS).contains(n))
                .ok_or_else(invalid)?,
        }
    } else {
        lookup_timeout
    };
    let tab_id = extract_tab_id(params)?;
    let webview =
        get_embed_webview(app, tab_id).map_err(|e| (error_codes::TAB_NOT_FOUND.into(), e))?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_coverage = String::from("no completed scan");
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err((error_codes::TIMEOUT.into(), format!("locator {} timed out after {timeout_ms}ms; {last_coverage}; no input dispatched", state.unwrap_or("lookup"))));
        }
        let (generation, result) = scan_with_fresh_refs(tab_id, deadline, |generation| {
            collect_locator_matches(&webview, tab_id, generation, &locator)
        })
        .await?;
        let complete = !result.node_limit_reached && result.skipped_frames == 0;
        last_coverage = format!(
            "scanned={}, nodeLimitReached={}, skippedFrames={}",
            result.scanned, result.node_limit_reached, result.skipped_frames
        );
        let first = result.matches.first();
        let matched = if let Some(state) = state {
            super::locator_target::wait_state(
                state,
                result.matches.len(),
                complete,
                first.is_some_and(|m| m.visible),
                first.is_some_and(|m| m.enabled),
                first.and_then(|m| m.checked),
            )
        } else {
            super::locator_target::unique(result.matches.len(), complete)
        }
        .map_err(|error| describe_ambiguity(error, &result.matches))?;
        if matched {
            return Ok(json!({
                "ok":true, "tabId":tab_id, "generation":generation,
                "ref":first.map(|m| &m.ref_id), "condition":"locator", "state":state,
                "count":result.matches.len(), "coverageComplete":complete,
                "scanned":result.scanned, "includedFrames":result.included_frames,
                "skippedFrames":result.skipped_frames, "nodeLimitReached":result.node_limit_reached,
            }));
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(150)).min(deadline),
        )
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
        replace_ref_frame_targets(tab_id, targets);
        return Ok(CollectedLocatorMatches {
            matches: root.matches,
            scanned: root.scanned,
            truncated: true,
            node_limit_reached: root.truncated,
            included_frames: 1,
            skipped_frames: 0,
            hidden: root.hidden,
            name_misses: std::mem::take(&mut root.name_misses),
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
    let mut scanned = root.scanned;
    let mut truncated = root.truncated;
    let mut node_limit_reached = root.truncated;
    let mut included_frames = 1usize;
    let mut skipped_frames = usize::from(frame_limit_reached);
    let mut hidden = root.hidden;
    let mut name_misses = std::mem::take(&mut root.name_misses);

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
    replace_ref_frame_targets(tab_id, targets);
    Ok(CollectedLocatorMatches {
        matches,
        scanned,
        truncated,
        node_limit_reached,
        included_frames,
        skipped_frames,
        hidden,
        name_misses,
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
    replace_ref_frame_targets(tab_id, targets);
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
    Hover(Option<(f64, f64)>),
    Focus,
    Editable,
}

struct ActionableElement {
    x: f64,
    y: f64,
    tag: String,
    input_type: String,
    checked: Option<bool>,
    draggable: bool,
}

fn extract_hover_position(params: &Value) -> Result<Option<(f64, f64)>, (String, String)> {
    let Some(position) = params.get("position") else {
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
        "hover position requires only x and y, finite fractions strictly between 0 and 1 (0.5 is the center), not pixels".to_string(),
    ))
}

fn actionable_probe_script(
    ref_id: &str,
    generation: u64,
    scroll: bool,
    position: Option<(f64, f64)>,
) -> String {
    let action_rect = include_str!("actionRect.js");
    let position = position
        .map(|(x, y)| json!({"x": x, "y": y}))
        .unwrap_or(Value::Null);
    deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
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
            return JSON.stringify({{
                ok: true,
                visible,
                enabled,
                editable,
                receives,
                ...point,
                tag: el.tagName.toLowerCase(),
                inputType: el instanceof HTMLInputElement ? String(el.type || '').toLowerCase() : '',
                checked: typeof el.checked === 'boolean' ? el.checked : null,
                draggable: el.draggable === true
            }});"#
        ),
    )
}

fn drag_points_stable(previous: [f64; 4], current: [f64; 4]) -> bool {
    previous.iter().zip(current).all(|(before, after)| {
        before.is_finite() && after.is_finite() && (before - after).abs() <= 0.5
    })
}

async fn read_drag_pair(
    webview: &Webview,
    source_ref: &str,
    target_ref: &str,
    generation: u64,
    scroll: bool,
) -> Result<[f64; 4], String> {
    let source = deep_ref_expression(source_ref, "return el;");
    let destination = deep_ref_expression(target_ref, "return el;");
    let probe = include_str!("dragProbe.js");
    let script = format!(
        "(() => {{ const source = {source}; const destination = {destination}; const generation = 'gen-{generation}'; const scroll = {scroll}; {VISIBILITY_JS} {probe} }})()"
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
    generation: u64,
) -> Result<[f64; 4], (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut previous = None;
    let mut scroll = true;
    loop {
        let reason = match read_drag_pair(webview, source_ref, target_ref, generation, scroll).await
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
    generation: u64,
    requirement: ActionabilityRequirement,
) -> Result<ActionableElement, (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let position = match requirement {
        ActionabilityRequirement::Hover(position) => position,
        _ => None,
    };
    let initial_script = actionable_probe_script(ref_id, generation, true, position);
    let settled_script = actionable_probe_script(ref_id, generation, false, position);
    let mut script = &initial_script;
    let mut previous_rect: Option<(f64, f64, f64, f64)> = None;
    loop {
        let response = execute_ref_script(webview, target, script)
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
        let stable = previous_rect.is_some_and(|previous| {
            (previous.0 - rect.0).abs() <= 0.5
                && (previous.1 - rect.1).abs() <= 0.5
                && (previous.2 - rect.2).abs() <= 0.5
                && (previous.3 - rect.3).abs() <= 0.5
        });
        previous_rect = Some(rect);
        let requirement_met = match requirement {
            ActionabilityRequirement::Click | ActionabilityRequirement::Hover(_) => {
                enabled && receives
            }
            ActionabilityRequirement::Focus => enabled,
            ActionabilityRequirement::Editable => editable && receives,
        };
        if visible && stable && requirement_met {
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
            });
        }
        let last_reason = if !visible {
            "not visible"
        } else if !enabled {
            "disabled"
        } else if matches!(requirement, ActionabilityRequirement::Editable) && !editable {
            "not editable"
        } else if matches!(
            requirement,
            ActionabilityRequirement::Click
                | ActionabilityRequirement::Hover(_)
                | ActionabilityRequirement::Editable
        ) && !receives
        {
            if parsed.get("inViewport").and_then(Value::as_bool) != Some(true) {
                "outside the viewport after scrolling"
            } else {
                "covered by another element"
            }
        } else {
            "not stable"
        };
        if tokio::time::Instant::now() >= deadline {
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!("element ref '{ref_id}' did not become actionable: {last_reason}"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn dom_click_ref(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    generation: u64,
    count: u8,
) -> Result<(), (String, String)> {
    super::activity::stage("frame");
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await
    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
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
            .and_then(Value::as_u64)
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
    generation: u64,
    expected: bool,
) -> Result<bool, (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
            return JSON.stringify({{ ok: true, checked: el.checked === true }});"#
        ),
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

async fn popup_url_for_ref(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    generation: u64,
) -> Result<Option<String>, String> {
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") return null;
            const link = el.closest ? el.closest('a[href]') : null;
            if (!link || String(link.target || '').toLowerCase() !== '_blank') return null;
            return String(link.href || '');"#
        ),
    );
    let response = execute_ref_script(webview, target, &script).await?;
    let popup_url = serde_json::from_str::<Option<String>>(&response).unwrap_or(None);
    Ok(popup_url.filter(|url| {
        url::Url::parse(url)
            .ok()
            .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
    }))
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
    generation: u64,
) -> Result<(), (String, String)> {
    let source_json = serde_json::to_string(source_ref).unwrap();
    let destination_json = serde_json::to_string(destination_ref).unwrap();
    let script = format!(
        r#"(function() {{
            const generation = "gen-{generation}";
            {REF_REGISTRY_JS}
            const source = refRegistry.resolve({source_json});
            const destination = refRegistry.resolve({destination_json});
            if (!source || !destination || source.getAttribute('data-anbo-gen') !== generation ||
                destination.getAttribute('data-anbo-gen') !== generation) {{
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
    click_ref_profiled(webview, tab_id, ref_id, &mut ActionTimings::default()).await
}

async fn click_ref_profiled(
    webview: &Webview,
    tab_id: i64,
    ref_id: &str,
    timings: &mut ActionTimings,
) -> Result<&'static str, (String, String)> {
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
                current_generation,
                ActionabilityRequirement::Click,
            ),
        )
        .await?;
    if frame_dom_click {
        timings
            .measure(
                "frameClick",
                dom_click_ref(webview, target.as_ref(), ref_id, current_generation, 1),
            )
            .await?;
        return Ok("dom-frame");
    }
    dispatch_mouse_click_profiled(webview, &actionable, ref_id, 1, timings).await?;
    Ok("devtools")
}

fn build_wait_for_text_js(text: &str) -> String {
    format!(
        r#"(function() {{
            const needle = {};
            {READABLE_TEXT_JS}
            const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
            const normalizedNeedle = normalize(needle);
            if (normalize(document.title).includes(normalizedNeedle)) return true;
            if (document.body && normalize(readableText(document.body).text).includes(normalizedNeedle)) return true;
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
                if (values.some(value => value && normalize(value).includes(normalizedNeedle))) return true;
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
        if stable.observe(
            matched,
            started.elapsed(),
            Duration::from_millis(expectation.stable_for),
        ) {
            return Ok(
                json!({"matched":true, "stableForMs":expectation.stable_for, "durationMs":started.elapsed().as_millis().min(u64::MAX as u128) as u64}),
            );
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(100)).min(deadline),
        )
        .await;
    }
    Err((
        error_codes::TIMEOUT.to_string(),
        format!(
            "expected page state was not stable within {}ms (titleSource: {})",
            expectation.timeout,
            if expectation.uses_native_title() {
                "native"
            } else {
                "document"
            }
        ),
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

fn build_ref_state_js(ref_id: &str, generation: u64, state: &str) -> String {
    deep_ref_expression(
        ref_id,
        &format!(
            r#"
            const current = el && el.getAttribute('data-anbo-gen') === "gen-{generation}" ? el : null;
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
            let script = build_ref_state_js(ref_id, generation, state);
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
    dispatch_mouse_move_profiled(webview, x, y, timings)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
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
    dispatch_mouse_move_profiled(webview, x, y, &mut ActionTimings::default()).await
}

async fn dispatch_mouse_move_profiled(
    webview: &Webview,
    x: f64,
    y: f64,
    timings: &mut ActionTimings,
) -> Result<(), String> {
    super::activity::pointer("move", x, y);
    timings
        .measure(
            "focusEmulation",
            call_devtools_with_retry(
                webview,
                "Emulation.setFocusEmulationEnabled",
                r#"{"enabled":true}"#,
                2,
            ),
        )
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
    generation: u64,
) -> Result<(), String> {
    let [source_x, source_y, target_x, target_y] = pair;
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
    let start = mouse_event_params("mouseMoved", source_x, source_y, false, 0).to_string();
    call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &start, 2).await?;
    let current = read_drag_pair(webview, source_ref, target_ref, generation, false).await?;
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
    timings: &mut ActionTimings,
) -> Result<(), String> {
    // The caller prepares focus and optionally verifies the input first.
    let down = key_event_params("keyDown", key, 0).to_string();
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
    let up = key_event_params("keyUp", key, 0).to_string();
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
    Ok(())
}

async fn dispatch_key_action(
    webview: &Webview,
    key: &str,
    action: &str,
    modifiers: u8,
) -> Result<(), String> {
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
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
        if observation.submit_event || observation.navigation {
            break;
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

async fn open_browser(
    app: &AppHandle,
    params: &Value,
    caller: &super::caller::Caller,
) -> Result<Value, (String, String)> {
    let (url, workspace) = extract_browser_open_params(params)?;
    crate::modules::resource_guard::preflight(crate::modules::resource_guard::Workload::Browser)
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

    let received = tokio::time::timeout(Duration::from_secs(10), receiver).await;
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

    let received = tokio::time::timeout(Duration::from_secs(10), receiver).await;
    app.unlisten(listener_id);
    let payload = received
        .map_err(|_| {
            (
                error_codes::TIMEOUT.to_string(),
                "Anbo UI did not close the browser tab in time".to_string(),
            )
        })?
        .map_err(|_| {
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
        let ready =
            execute_script_with_timeout(webview, "document.readyState", SCRIPT_POLL_TIMEOUT)
                .await
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
        if ready == "interactive" || ready == "complete" {
            let has_body =
                execute_script_with_timeout(webview, "!!document.body", SCRIPT_POLL_TIMEOUT)
                    .await
                    .unwrap_or_default();
            if has_body.trim() == "true" {
                return;
            }
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

fn invalid_ref_error() -> (String, String) {
    (
        error_codes::INVALID_REQUEST.to_string(),
        "invalid 'ref': expected g<generation>-e<index> or g<generation>-f<frame>-e<index>"
            .to_string(),
    )
}

fn ensure_current_ref(ref_id: &str, current_generation: u64) -> Result<(), (String, String)> {
    let generation = parse_ref_generation(ref_id).map_err(|_| invalid_ref_error())?;
    if generation != current_generation {
        return Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn refs_are_scoped_to_the_current_snapshot_generation() {
        assert!(ensure_current_ref("g2-e1", 2).is_ok());
        assert!(ensure_current_ref("g2-f1-e1", 2).is_ok());

        let error = ensure_current_ref("g1-e1", 2).unwrap_err();
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
        assert!(described.1.contains("<button> \"fallback text\" at 640,400, hidden"));

        // Every other failure is passed through untouched.
        let other = (
            error_codes::TIMEOUT.to_string(),
            "timed out".to_string(),
        );
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
        };

        // A page read end to end with nothing matching is a verdict, and says so.
        let absent = find_timeout(&locator, 800, 3, None, Some(&scan(0, vec![])));
        assert_eq!(absent.0, error_codes::TIMEOUT);
        assert!(absent.1.contains("#missing"));
        assert!(absent.1.contains("confirmed absence"));
        assert!(absent.1.contains("16295"));

        // An element behind a collapsed menu is not an absence, and the caller
        // is told the one thing that would reach it.
        let hidden = find_timeout(&locator, 800, 3, None, Some(&scan(2, vec![])));
        assert!(hidden.1.contains("2 element(s) matched but are not rendered"));
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
        );
        assert!(named.1.contains("Download this page as a PDF file"));
        assert!(!named.1.contains("confirmed absence"));

        // Truncated coverage must never read as a verdict.
        let capped = CollectedLocatorMatches {
            node_limit_reached: true,
            scanned: 50_000,
            ..scan(0, vec![])
        };
        let partial = find_timeout(&locator, 800, 2, None, Some(&capped));
        assert!(partial.1.contains("page coverage incomplete"));
        assert!(partial.1.contains("not a confirmed absence"));
        let skipped = CollectedLocatorMatches {
            skipped_frames: 1,
            ..scan(0, vec![])
        };
        assert!(find_timeout(&locator, 800, 2, None, Some(&skipped))
            .1
            .contains("1 frames skipped"));

        // No scan at all stays distinct from every reading above.
        let queued = find_timeout(&locator, 800, 0, Some("queue exceeded deadline"), None);
        assert!(queued.1.contains("no scan completed"));
        assert!(queued.1.contains("queue exceeded deadline"));
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
    fn drag_stability_checks_both_endpoints_and_finite_coordinates() {
        let points = [10.0, 20.0, 80.0, 90.0];
        assert!(drag_points_stable(points, [10.3, 20.0, 80.0, 90.4]));
        assert!(!drag_points_stable(points, [10.0, 21.0, 80.0, 90.0]));
        assert!(!drag_points_stable(points, [10.0, 20.0, 80.0, 91.0]));
        assert!(!drag_points_stable(points, [f64::NAN, 20.0, 80.0, 90.0]));
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
            let script = actionable_probe_script("g1-e1", 1, scroll, Some((0.6, 0.5)));
            assert!(script.contains(&format!(
                "prepareActionPoint(el, {scroll}, {{\"x\":0.6,\"y\":0.5}})"
            )));
            assert!(script.contains("receivesActionPointer(el, point)"));
        }
        assert!(actionable_probe_script("g1-e1", 1, false, None)
            .contains("prepareActionPoint(el, false, null)"));
    }

    #[test]
    fn semantic_locator_validates_role_name_filters() {
        let locator = extract_locator(&json!({
            "by": "role",
            "value": "button",
            "name": "Save"
        }))
        .unwrap();
        assert_eq!(locator.by, "role");
        assert_eq!(locator.name.as_deref(), Some("Save"));

        let error = extract_locator(&json!({
            "by": "text",
            "value": "Save",
            "name": "button"
        }))
        .unwrap_err();
        assert_eq!(error.0, error_codes::INVALID_REQUEST);
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
}

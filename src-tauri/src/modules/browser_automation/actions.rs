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

use crate::modules::app_data::local_data_root;
use crate::modules::browser::embed::{
    active_loading, active_local_root, active_navigation_generation, active_pending_url,
    set_active_loading, set_active_pending_url, BROWSER_POPUP_REQUEST_EVENT,
};
use crate::modules::browser_automation::cdp::{
    call_devtools_protocol_method, capture_screenshot, execute_script, execute_script_with_timeout,
};
use crate::modules::browser_automation::download;
use crate::modules::browser_automation::locator::{
    build_find_js, LocatorMatch, LocatorPayload, LocatorQuery, MAX_LOCATOR_MATCHES,
};
use crate::modules::browser_automation::protocol::error_codes;
use crate::modules::browser_automation::registry::{
    get_active_tabs, get_embed_webview, get_tab_lock, remove_tab_lock,
};
use crate::modules::browser_automation::snapshot::{
    build_frame_snapshot_js, build_snapshot_js, format_snapshot, get_current_generation,
    get_next_generation, get_ref_frame_target, replace_ref_frame_targets, RefFrameTarget,
    SnapshotPayload, DEFAULT_SNAPSHOT_MAX_CHARS,
};

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
    let started = Instant::now();
    let result = handle_action_inner(app, method, params).await;
    if method.starts_with("agent_") {
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
    params: Value,
) -> Result<Value, (String, String)> {
    if method.starts_with("agent_") {
        return crate::modules::browser_automation::agent_actions::handle_agent_action(
            app, method, params,
        )
        .await;
    }
    let _ = app.emit(
        "browser-automation-activity",
        json!({ "method": method, "params": params }),
    );

    match method {
        "open" => open_browser(app, &params).await,
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
                    result.push(serde_json::to_value(tab).unwrap_or_default());
                    continue;
                }
                if let Ok(webview) = get_embed_webview(app, tab_id) {
                    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
                    let title = read_script_with_retry(&webview, "document.title", 2)
                        .await
                        .ok()
                        .and_then(|value| serde_json::from_str::<String>(&value).ok())
                        .unwrap_or_default();

                    result.push(json!({
                        "tabId": tab_id,
                        "url": url,
                        "title": title,
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
            let res = execute_script(&webview, "window.location.href")
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let url = res.trim_matches('"').to_string();
            Ok(json!({ "tabId": tab_id, "url": url }))
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
            let navigated = dispatch_navigation_action(&webview, tab_id, method)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
            Ok(json!({
                "tabId": tab_id,
                "action": method,
                "ok": true,
                "navigated": navigated,
                "loading": active_loading(tab_id)
            }))
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
            let tab_lock = get_tab_lock(tab_id);
            let webview = get_embed_webview(app, tab_id)
                .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
            let generation = get_next_generation(tab_id);
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

            loop {
                let result = {
                    let _lock = tab_lock.lock().await;
                    collect_locator_matches(&webview, tab_id, generation, &locator).await
                }?;
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
                        "includedFrames": result.included_frames,
                        "skippedFrames": result.skipped_frames
                    }));
                }
                if tokio::time::Instant::now() >= deadline {
                    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
                    return Err((
                        error_codes::TIMEOUT.to_string(),
                        format!(
                            "timed out finding {} '{}' after {timeout_ms}ms at {url}",
                            locator.by, locator.value
                        ),
                    ));
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }

        "click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 3000).await;
            let generation = get_current_generation(tab_id);
            let target = get_ref_frame_target(tab_id, &ref_id);
            let popup_url = popup_url_for_ref(&webview, target.as_ref(), &ref_id, generation)
                .await
                .unwrap_or(None);
            let dispatch = click_ref(&webview, tab_id, &ref_id).await?;
            if let Some(url) = popup_url {
                let _ = app.emit(
                    BROWSER_POPUP_REQUEST_EVENT,
                    json!({ "sourceTabId": tab_id, "url": url }),
                );
            }

            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "dispatch": dispatch
            }))
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
                dispatch_mouse_click(&webview, actionable.x, actionable.y, 2)
                    .await
                    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
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
                    dispatch_mouse_click(&webview, actionable.x, actionable.y, 1)
                        .await
                        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
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
            let destination = wait_for_actionable_ref(
                &webview,
                destination_target.as_ref(),
                &target_ref,
                generation,
                ActionabilityRequirement::Click,
            )
            .await?;
            let dispatch = if source.draggable
                || source_target.as_ref().is_some_and(|target| !target.is_main)
            {
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
                dispatch_mouse_drag(&webview, source.x, source.y, destination.x, destination.y)
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
                    return JSON.stringify({{ ok: true }});"#,
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
                Ok(json!({ "tabId": tab_id, "ref": ref_id, "ok": true }))
            } else {
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
                "workspace": workspace_root.to_string_lossy()
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
            let observation_timeout_ms = params
                .get("observationTimeout")
                .and_then(Value::as_u64)
                .unwrap_or(SUBMISSION_OBSERVATION_MS)
                .min(10_000);

            let tab_lock = get_tab_lock(tab_id);
            let (webview, before_url, before_navigation_generation, observation_id) = {
                let _lock = tab_lock.lock().await;
                let webview = get_embed_webview(app, tab_id)
                    .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
                let before_url = current_url(&webview).await.unwrap_or_default();
                let before_navigation_generation =
                    active_navigation_generation(tab_id).unwrap_or(0);
                let observation_id = SUBMISSION_OBSERVATION_ID.fetch_add(1, Ordering::Relaxed);
                if key == "Enter" {
                    let marker = serde_json::to_string(&observation_id.to_string()).unwrap();
                    let script = format!(
                        "window.__anboSubmitObservations=window.__anboSubmitObservations||{{}};window.__anboSubmitObservations[{marker}]=false;document.addEventListener('submit',()=>{{if(window.__anboSubmitObservations)window.__anboSubmitObservations[{marker}]=true;}},{{capture:true,once:true}});true"
                    );
                    let _ =
                        execute_script_with_timeout(&webview, &script, SCRIPT_POLL_TIMEOUT).await;
                }
                dispatch_key(&webview, key)
                    .await
                    .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
                (
                    webview,
                    before_url,
                    before_navigation_generation,
                    observation_id,
                )
            };
            let observation = if key == "Enter" {
                observe_submission(
                    &webview,
                    tab_id,
                    &before_url,
                    before_navigation_generation,
                    observation_id,
                    observation_timeout_ms,
                )
                .await
            } else {
                SubmissionObservation::default()
            };

            Ok(json!({
                "tabId": tab_id,
                "key": key,
                "ok": true,
                "dispatch": "devtools",
                "submissionObserved": observation.submit_event,
                "navigationObserved": observation.navigation,
                "observationWindowMs": if key == "Enter" { observation_timeout_ms } else { 0 }
            }))
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
            let mut stable_since = None;
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let poll_timeout = remaining.min(Duration::from_millis(750));
                let matched = {
                    let _lock = tab_lock.lock().await;
                    wait_condition_matches(&webview, tab_id, &condition, deadline, poll_timeout)
                        .await?
                };
                let requires_stability = matches!(
                    &condition,
                    WaitCondition::Load {
                        state
                    } if state == "networkIdle"
                );
                if matched {
                    let since = stable_since.get_or_insert_with(tokio::time::Instant::now);
                    if !requires_stability || since.elapsed() >= Duration::from_millis(500) {
                        return Ok(json!({
                            "tabId": tab_id,
                            "found": true,
                            "condition": condition.kind(),
                            "state": condition.state_label()
                        }));
                    }
                } else {
                    stable_since = None;
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
            install_dialog_capture(
                &webview,
                target.as_ref(),
                &ref_id,
                generation,
                action == "accept",
                prompt_text,
            )
            .await?;
            let trigger_result = if target.as_ref().is_some_and(|target| !target.is_main) {
                dom_click_ref(&webview, target.as_ref(), &ref_id, generation, 1)
                    .await
                    .map(|_| "dom-frame")
            } else {
                dispatch_mouse_click(&webview, actionable.x, actionable.y, 1)
                    .await
                    .map(|_| "devtools")
                    .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))
            };
            let dialog_result = take_dialog_capture(&webview, target.as_ref()).await;
            let dispatch = trigger_result?;
            let dialog = dialog_result?;
            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "action": action,
                "ok": true,
                "dispatch": dispatch,
                "kind": dialog.get("kind").cloned().unwrap_or(Value::Null),
                "message": dialog.get("message").cloned().unwrap_or(Value::Null),
                "defaultText": dialog.get("defaultText").cloned().unwrap_or(Value::Null),
                "promptTextSet": action == "accept" && !prompt_text.is_empty()
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
                ActionabilityRequirement::Click,
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
                    el.scrollIntoView({{ block: 'center' }});
                    const r = el.getBoundingClientRect();
                    const x = r.left + r.width / 2;
                    const y = r.top + r.height / 2;
                    const opts = {{ bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }};
                    el.dispatchEvent(new MouseEvent('mouseover', opts));
                    el.dispatchEvent(new MouseEvent('mousemove', opts));
                    el.dispatchEvent(new MouseEvent('mouseenter', {{ bubbles: false, cancelable: false, clientX: x, clientY: y, view: window }}));
                    return JSON.stringify({{ ok: true, cssHover: el.matches(':hover') }});"#
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
                    "dispatch": if main_document { "devtools+dom" } else { "dom-frame" }
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
                    const domText = (el.innerText || el.textContent || '').trim();
                    const labelledBy = (el.getAttribute && el.getAttribute('aria-labelledby') || '')
                        .split(/\s+/)
                        .filter(Boolean)
                        .map(id => document.getElementById(id))
                        .filter(Boolean)
                        .map(node => (node.innerText || node.textContent || '').trim())
                        .filter(Boolean)
                        .join(' ');
                    const descendant = el.querySelector
                        ? el.querySelector('[aria-label], img[alt], [alt], [title]')
                        : null;
                    const labels = el.labels
                        ? Array.from(el.labels).map(label => (label.innerText || label.textContent || '').trim()).filter(Boolean).join(' ')
                        : '';
                    const accessibleText = (el.getAttribute && (
                        el.getAttribute('aria-label') ||
                        el.getAttribute('placeholder') ||
                        el.getAttribute('alt') ||
                        el.getAttribute('title')
                    )) || labelledBy || labels || (descendant && (
                        descendant.getAttribute('aria-label') ||
                        descendant.getAttribute('alt') ||
                        descendant.getAttribute('title')
                    )) || '';
                    const text = domText || accessibleText.trim();
                    const source = domText ? 'domText' : (text ? 'accessibleName' : 'empty');
                    const max = {max_length};
                    let truncated = false;
                    let out = text;
                    if (text.length > max) {{ out = text.slice(0, max); truncated = true; }}
                    return JSON.stringify({{ ok: true, text: out, source: source, truncated: truncated, totalLength: text.length }});"#
            );
            let js = if let Some(ref_id) = ref_id.as_deref() {
                let generation = get_current_generation(tab_id);
                deep_ref_expression(
                    ref_id,
                    &format!(
                        r#"
                        if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                            return JSON.stringify({{ ok: false, error: "stale_ref" }});
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
                    "truncated": parsed.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                    "totalLength": parsed.get("totalLength").and_then(|v| v.as_u64()).unwrap_or(0)
                }))
            } else {
                let err = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stale_ref");
                Err((
                    error_codes::STALE_REF.to_string(),
                    format!("get_text failed: {err}"),
                ))
            }
        }

        "get_page_info" | "page_info" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 3000).await;
            let title_res = read_script_with_retry(&webview, "document.title", 3)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let url = webview
                .url()
                .map(|url| url.to_string())
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e.to_string()))?;
            // execute_script returns the value as a JSON string (quoted + escaped);
            // decode it properly so titles/URLs containing quotes survive. Sibling
            // arms use the same serde_json::from_str pattern.
            let title =
                serde_json::from_str::<String>(&title_res).unwrap_or_else(|_| title_res.clone());
            Ok(json!({ "tabId": tab_id, "title": title, "url": url }))
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
            function findRef(root) {{
                if (!root) return null;
                if (root.querySelector) {{
                    const direct = root.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (direct) return direct;
                    const nodes = root.querySelectorAll('*');
                    const limit = Math.min(nodes.length, 50000);
                    for (let i = 0; i < limit; i++) {{
                        if (nodes[i].shadowRoot) {{
                            const nested = findRef(nodes[i].shadowRoot);
                            if (nested) return nested;
                        }}
                    }}
                }}
                return null;
            }}
            const el = findRef(document);
            {body}
        }})()"#,
        serde_json::to_string(ref_id).unwrap()
    )
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
        Some(target) if !target.frame_id.is_empty() => {
            Some(create_frame_execution_context(webview, &target.frame_id).await?)
        }
        _ => None,
    };
    let mut params = json!({
        "expression": expression,
        "returnByValue": false,
        "awaitPromise": false,
        "userGesture": true
    });
    if let Some(context_id) = context_id {
        params["contextId"] = Value::from(context_id);
    }
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
    included_frames: usize,
    skipped_frames: usize,
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
    let root_raw = execute_script(webview, &root_script)
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
    let (frame_ids, frame_limit_reached) = get_frame_ids(webview)
        .await
        .unwrap_or_else(|_| (Vec::new(), false));
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
    let mut included_frames = 1usize;
    let mut skipped_frames = usize::from(frame_limit_reached);

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
    let frame_results = stream::iter(frame_jobs)
        .map(|(frame_index, frame_id, script)| async move {
            let result = evaluate_in_frame(webview, &frame_id, &script)
                .await
                .and_then(parse_locator_payload);
            (frame_index, frame_id, result)
        })
        .buffered(FRAME_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (_frame_index, frame_id, result) in frame_results {
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
        truncated |= payload.truncated;
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
    }
    replace_ref_frame_targets(tab_id, targets);
    Ok(CollectedLocatorMatches {
        matches,
        scanned,
        truncated,
        included_frames,
        skipped_frames,
    })
}

async fn collect_snapshot_payload(
    webview: &Webview,
    tab_id: i64,
    generation: u64,
) -> Result<(SnapshotPayload, usize, usize), String> {
    let root_raw = execute_script(webview, &build_snapshot_js(generation)).await?;
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
            if payload.elements.len() >= MAX_SNAPSHOT_ELEMENTS {
                payload.source_truncated = true;
                break;
            }
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
    }
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
        _ => execute_script(webview, script).await,
    }
}

#[derive(Clone, Copy)]
enum ActionabilityRequirement {
    Click,
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

fn actionable_probe_script(ref_id: &str, generation: u64) -> String {
    deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible = el.isConnected && rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.visibility !== 'collapse' && Number(style.opacity || 1) > 0;
            const enabled = !(el.disabled || el.getAttribute('aria-disabled') === 'true');
            const editable = enabled && !el.readOnly && (
                el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
            );
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const root = el.getRootNode && el.getRootNode();
            const hitSource = root && typeof root.elementFromPoint === 'function' ? root : document;
            const hit = visible ? hitSource.elementFromPoint(x, y) : null;
            let receives = false;
            let cursor = hit;
            while (cursor) {{
                if (cursor === el) {{ receives = true; break; }}
                cursor = cursor.parentNode || cursor.host || null;
            }}
            if (!receives && hit && el.contains) receives = el.contains(hit);
            return JSON.stringify({{
                ok: true,
                visible,
                enabled,
                editable,
                receives,
                x,
                y,
                width: rect.width,
                height: rect.height,
                tag: el.tagName.toLowerCase(),
                inputType: el instanceof HTMLInputElement ? String(el.type || '').toLowerCase() : '',
                checked: typeof el.checked === 'boolean' ? el.checked : null,
                draggable: el.draggable === true
            }});"#
        ),
    )
}

async fn wait_for_actionable_ref(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    generation: u64,
    requirement: ActionabilityRequirement,
) -> Result<ActionableElement, (String, String)> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let script = actionable_probe_script(ref_id, generation);
    let mut previous_rect: Option<(f64, f64, f64, f64)> = None;
    loop {
        let response = execute_ref_script(webview, target, &script)
            .await
            .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
        let decoded: String = serde_json::from_str(&response).unwrap_or(response);
        let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
        if parsed.get("error").and_then(Value::as_str) == Some("stale_ref") {
            return Err((
                error_codes::STALE_REF.to_string(),
                format!("element ref '{ref_id}' is stale or no longer valid"),
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
            ActionabilityRequirement::Click => enabled && receives,
            ActionabilityRequirement::Focus => enabled,
            ActionabilityRequirement::Editable => editable && receives,
        };
        if visible && stable && requirement_met {
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
            ActionabilityRequirement::Click | ActionabilityRequirement::Editable
        ) && !receives
        {
            "covered by another element"
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
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
            el.focus({{ preventScroll: true }});
            for (let index = 0; index < {count}; index++) el.click();
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
        Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid"),
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
    ref_id: &str,
    generation: u64,
    accept: bool,
    prompt_text: &str,
) -> Result<(), (String, String)> {
    let script = deep_ref_expression(
        ref_id,
        &format!(
            r#"
            if (!el || el.getAttribute('data-anbo-gen') !== "gen-{generation}") {{
                return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            }}
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
            return JSON.stringify({{ ok: true }});"#,
            prompt_result = if accept {
                serde_json::to_string(prompt_text).unwrap()
            } else {
                "null".to_string()
            }
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
        Err((
            error_codes::STALE_REF.to_string(),
            format!("element ref '{ref_id}' is stale or no longer valid"),
        ))
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
    let response = execute_ref_script(webview, target, script)
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
            const findRef = refId => {{
                const visit = root => {{
                    if (!root || !root.querySelector) return null;
                    const direct = root.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (direct) return direct;
                    for (const element of root.querySelectorAll('*')) {{
                        if (element.shadowRoot) {{
                            const found = visit(element.shadowRoot);
                            if (found) return found;
                        }}
                    }}
                    return null;
                }};
                return visit(document);
            }};
            const source = findRef({source_json});
            const destination = findRef({destination_json});
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
    let current_generation = get_current_generation(tab_id);
    ensure_current_ref(ref_id, current_generation)?;
    let target = get_ref_frame_target(tab_id, ref_id);
    let frame_dom_click = target.as_ref().is_some_and(|target| !target.is_main);
    let actionable = wait_for_actionable_ref(
        webview,
        target.as_ref(),
        ref_id,
        current_generation,
        ActionabilityRequirement::Click,
    )
    .await?;
    if frame_dom_click {
        dom_click_ref(webview, target.as_ref(), ref_id, current_generation, 1).await?;
        return Ok("dom-frame");
    }
    dispatch_mouse_click(webview, actionable.x, actionable.y, 1)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    Ok("devtools")
}

fn build_wait_for_text_js(text: &str) -> String {
    format!(
        r#"(function() {{
            const needle = {};
            const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
            const normalizedNeedle = normalize(needle);
            if (normalize(document.title).includes(normalizedNeedle)) return true;
            if (document.body && normalize(document.body.innerText).includes(normalizedNeedle)) return true;
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
            if ({state} === 'hidden') {{
                if (!current || !current.isConnected) return true;
                const rect = current.getBoundingClientRect();
                const style = getComputedStyle(current);
                return rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
                    style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity || 1) <= 0;
            }}
            if (!current || !current.isConnected) return false;
            const rect = current.getBoundingClientRect();
            const style = getComputedStyle(current);
            const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
                style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity || 1) > 0;
            const enabled = !(current.disabled || current.getAttribute('aria-disabled') === 'true');
            if ({state} === 'attached') return true;
            if ({state} === 'visible') return visible;
            if ({state} === 'enabled') return enabled;
            if ({state} === 'disabled') return !enabled;
            if ({state} === 'checked') return current.checked === true || current.getAttribute('aria-checked') === 'true';
            if ({state} === 'unchecked') return current.checked === false || current.getAttribute('aria-checked') === 'false';
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
            let ready = execute_script_with_timeout(webview, "document.readyState", poll_timeout)
                .await
                .unwrap_or_default();
            let ready = ready.trim_matches('"');
            Ok(match state.as_str() {
                "interactive" => matches!(ready, "interactive" | "complete"),
                "complete" => ready == "complete",
                "networkIdle" => ready == "complete" && active_loading(tab_id) == Some(false),
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
    let (key_name, code, virtual_key, text, shift) = match key {
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
    if event_type != "keyUp" {
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
    x: f64,
    y: f64,
    click_count: u8,
) -> Result<(), String> {
    dispatch_mouse_move(webview, x, y).await?;
    for count in 1..=click_count.max(1) {
        for (event_type, pressed) in [("mousePressed", true), ("mouseReleased", false)] {
            let params = mouse_event_params(event_type, x, y, pressed, count).to_string();
            if let Err(error) = call_devtools_protocol_method(
                webview,
                "Input.dispatchMouseEvent",
                &params,
                Duration::from_secs(5),
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
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn dispatch_mouse_move(webview: &Webview, x: f64, y: f64) -> Result<(), String> {
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
    let moved = mouse_event_params("mouseMoved", x, y, false, 0).to_string();
    call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &moved, 2)
        .await
        .map(|_| ())
}

async fn dispatch_mouse_drag(
    webview: &Webview,
    source_x: f64,
    source_y: f64,
    target_x: f64,
    target_y: f64,
) -> Result<(), String> {
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
    let start = mouse_event_params("mouseMoved", source_x, source_y, false, 0).to_string();
    call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &start, 2).await?;
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

async fn dispatch_key(webview: &Webview, key: &str) -> Result<(), String> {
    // Native browser tabs are commonly automated while their workspace stays
    // in the background. Keep keyboard delivery attached to the DOM focus
    // established by browser_type without activating the user's window/tab.
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
    let down = key_event_params("keyDown", key, 0).to_string();
    call_devtools_protocol_method(
        webview,
        "Input.dispatchKeyEvent",
        &down,
        SCRIPT_POLL_TIMEOUT,
    )
    .await?;
    let up = key_event_params("keyUp", key, 0).to_string();
    call_devtools_protocol_method(webview, "Input.dispatchKeyEvent", &up, SCRIPT_POLL_TIMEOUT)
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
    let observed_script = format!("window.__anboSubmitObservations?.[{marker}]===true");
    loop {
        if active_navigation_generation(tab_id)
            .is_some_and(|generation| generation != before_navigation_generation)
        {
            observation.navigation = true;
            break;
        }
        if current_url(webview)
            .await
            .is_ok_and(|url| !before_url.is_empty() && url != before_url)
        {
            observation.navigation = true;
        }
        if execute_script_with_timeout(webview, &observed_script, Duration::from_millis(500))
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
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let cleanup_script = format!(
        "if(window.__anboSubmitObservations)delete window.__anboSubmitObservations[{marker}];true"
    );
    let _ = execute_script_with_timeout(webview, &cleanup_script, Duration::from_millis(250)).await;
    observation
}

async fn read_script_with_retry(
    webview: &Webview,
    script: &str,
    attempts: usize,
) -> Result<String, String> {
    let mut last_error = String::new();
    for attempt in 0..attempts.max(1) {
        match execute_script_with_timeout(webview, script, Duration::from_millis(1000)).await {
            Ok(value) => return Ok(value),
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    Err(last_error)
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

async fn open_browser(app: &AppHandle, params: &Value) -> Result<Value, (String, String)> {
    let (url, workspace) = extract_browser_open_params(params)?;

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
            return Err((
                error_codes::TIMEOUT.to_string(),
                format!("browser tab {tab_id} did not become ready in time"),
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
    get_embed_webview(app, tab_id)
        .map_err(|error| (error_codes::TAB_NOT_FOUND.to_string(), error))?;
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
    fn deep_ref_lookup_escapes_refs_and_searches_open_shadow_roots() {
        let expression = deep_ref_expression("g1-e1\";alert(1)//", "return el;");
        assert!(expression.contains("CSS.escape(refId)"));
        assert!(expression.contains("nodes[i].shadowRoot"));
        assert!(expression.contains(r#"const refId = "g1-e1\";alert(1)//""#));
        assert!(!expression.contains("const refId = g1-e1"));
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

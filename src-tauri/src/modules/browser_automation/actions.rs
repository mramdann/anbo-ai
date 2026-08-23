use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Listener;
use tauri::Webview;

use crate::modules::app_data::local_data_root;
use crate::modules::browser::embed::{active_loading, active_local_root, set_active_loading};
use crate::modules::browser_automation::cdp::{
    call_devtools_protocol_method, capture_screenshot, execute_script, execute_script_with_timeout,
};
use crate::modules::browser_automation::download;
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
const MAX_KEY_BYTES: usize = 64;
const MAX_WORKSPACE_BYTES: usize = 4 * 1024;
const MAX_REF_BYTES: usize = 32;
const MAX_FILE_PATH_BYTES: usize = 32 * 1024;
const MAX_UPLOAD_FILES: usize = 16;
const MAX_DOWNLOAD_ID_BYTES: usize = 128;
const MAX_SNAPSHOT_FRAMES: usize = 32;
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

        "click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 3000).await;
            let dispatch = click_ref(&webview, tab_id, &ref_id).await?;

            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
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
            let ref_json = serde_json::to_string(&ref_id).unwrap();

            let js = format!(
                r#"(function() {{
                    const refId = {};
                    const el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    const gen = el.getAttribute('data-anbo-gen');
                    if (gen !== "gen-{}") return JSON.stringify({{ ok: false, error: "stale_ref" }});
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
                    return JSON.stringify({{ ok: true }});
                }})();"#,
                ref_json,
                cur_gen,
                serde_json::to_string(text).unwrap(),
                append
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

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let before_url = current_url(&webview).await.unwrap_or_default();
            if key == "Enter" {
                let _ = execute_script_with_timeout(
                    &webview,
                    "window.__anboSubmitObserved=false;document.addEventListener('submit',()=>{window.__anboSubmitObserved=true},{capture:true,once:true});true",
                    SCRIPT_POLL_TIMEOUT,
                )
                .await;
            }
            dispatch_key(&webview, key)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let observation = if key == "Enter" {
                observe_submission(&webview, &before_url).await
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
                "observationWindowMs": if key == "Enter" { SUBMISSION_OBSERVATION_MS } else { 0 }
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
            let text = params.get("text").and_then(|v| v.as_str()).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'text' parameter".to_string(),
                )
            })?;
            ensure_bounded(text, MAX_WAIT_TEXT_BYTES, "text")?;
            let timeout_ms = params
                .get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(10000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);

            let tab_lock = get_tab_lock(tab_id);
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            let js = build_wait_for_text_js(text);
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                let poll_timeout = remaining.min(Duration::from_millis(750));
                let found = {
                    let _lock = tab_lock.lock().await;
                    let main = execute_script_with_timeout(&webview, &js, poll_timeout)
                        .await
                        .unwrap_or_default();
                    if main.trim() == "true" {
                        true
                    } else {
                        wait_text_in_child_frames(&webview, &js, deadline).await
                    }
                };
                if found {
                    return Ok(json!({ "tabId": tab_id, "found": true, "text": text }));
                }

                if tokio::time::Instant::now() >= deadline {
                    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
                    return Err((
                        error_codes::TIMEOUT.to_string(),
                        format!(
                            "timed out waiting for text '{text}' after {timeout_ms}ms at {url}"
                        ),
                    ));
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
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
            let ref_json = serde_json::to_string(&ref_id).unwrap();
            let value_json = serde_json::to_string(value).unwrap();
            let js = format!(
                r#"(function() {{
                    const refId = {};
                    const el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    const gen = el.getAttribute('data-anbo-gen');
                    if (gen !== "gen-{}") return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    if (el.tagName !== 'SELECT') return JSON.stringify({{ ok: false, error: "not_a_select" }});
                    const want = {};
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
                    return JSON.stringify({{ ok: true, value: matched.value, label: (matched.textContent || '').trim() }});
                }})();"#,
                ref_json, cur_gen, value_json
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
            let ref_json = serde_json::to_string(&ref_id).unwrap();
            let js = format!(
                r#"(function() {{
                    const refId = {};
                    const el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    const gen = el.getAttribute('data-anbo-gen');
                    if (gen !== "gen-{}") return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    el.scrollIntoView({{ block: 'center' }});
                    const r = el.getBoundingClientRect();
                    const x = r.left + r.width / 2;
                    const y = r.top + r.height / 2;
                    const opts = {{ bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }};
                    el.dispatchEvent(new MouseEvent('mouseover', opts));
                    el.dispatchEvent(new MouseEvent('mousemove', opts));
                    el.dispatchEvent(new MouseEvent('mouseenter', {{ bubbles: false, cancelable: false, clientX: x, clientY: y, view: window }}));
                    return JSON.stringify({{ ok: true }});
                }})();"#,
                ref_json, cur_gen
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
            let ref_json = serde_json::to_string(&ref_id).unwrap();
            let js = format!(
                r#"(function() {{
                    const refId = {};
                    const el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                    if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    const gen = el.getAttribute('data-anbo-gen');
                    if (gen !== "gen-{}") return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    el.scrollIntoView({{ block: 'center', inline: 'center' }});
                    const r = el.getBoundingClientRect();
                    return JSON.stringify({{ ok: true, rect: {{ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }} }});
                }})();"#,
                ref_json, cur_gen
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
            let ref_json = serde_json::to_string(ref_id.as_deref().unwrap_or("")).unwrap();
            let js = format!(
                r#"(function() {{
                    const refId = {};
                    let el = null;
                    if (refId) {{
                        el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
                        if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
                    }} else {{
                        el = document.body;
                    }}
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
                    const max = {};
                    let truncated = false;
                    let out = text;
                    if (text.length > max) {{ out = text.slice(0, max); truncated = true; }}
                    return JSON.stringify({{ ok: true, text: out, source: source, truncated: truncated, totalLength: text.length }});
                }})();"#,
                ref_json, max_length
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

    for (index, frame_id) in frame_ids.iter().enumerate() {
        match evaluate_in_frame(webview, frame_id, FRAME_LOG_EXPRESSION).await {
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
    for (frame_index, frame_id) in frame_ids.iter().enumerate().skip(1) {
        let frame_script = build_frame_snapshot_js(generation, frame_index);
        let frame_payload = match evaluate_in_frame(webview, frame_id, &frame_script)
            .await
            .and_then(parse_snapshot_payload)
        {
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

async fn click_ref(
    webview: &Webview,
    tab_id: i64,
    ref_id: &str,
) -> Result<&'static str, (String, String)> {
    let current_generation = get_current_generation(tab_id);
    ensure_current_ref(ref_id, current_generation)?;
    let target = get_ref_frame_target(tab_id, ref_id);
    let frame_dom_click = target.as_ref().is_some_and(|target| !target.is_main);
    let ref_json = serde_json::to_string(ref_id).unwrap();
    let js = format!(
        r#"(function() {{
            const refId = {};
            const el = document.querySelector(`[data-anbo-ref="${{CSS.escape(refId)}}"]`);
            if (!el) return JSON.stringify({{ ok: false, error: "stale_ref" }});
            const gen = el.getAttribute('data-anbo-gen');
            if (gen !== "gen-{}") return JSON.stringify({{ ok: false, error: "stale_ref" }});
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {{
                return JSON.stringify({{ ok: false, error: "not_visible" }});
            }}
            el.focus({{ preventScroll: true }});
            if ({}) {{
                el.click();
                return JSON.stringify({{ ok: true, domClick: true }});
            }}
            return JSON.stringify({{
                ok: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            }});
        }})();"#,
        ref_json, current_generation, frame_dom_click
    );
    let response = execute_ref_script(webview, target.as_ref(), &js)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = serde_json::from_str(&response).unwrap_or(response);
    let parsed: Value = serde_json::from_str(&decoded).unwrap_or_default();
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("stale_ref");
        return if error == "stale_ref" {
            Err((
                error_codes::STALE_REF.to_string(),
                format!("element ref '{ref_id}' is stale or no longer valid"),
            ))
        } else {
            Err((
                error_codes::INVALID_REQUEST.to_string(),
                format!("element ref '{ref_id}' is not visible"),
            ))
        };
    }
    if parsed.get("domClick").and_then(Value::as_bool) == Some(true) {
        return Ok("dom-frame");
    }
    let x = parsed.get("x").and_then(Value::as_f64).ok_or_else(|| {
        (
            error_codes::CDP_FAILED.to_string(),
            "click target omitted its horizontal coordinate".to_string(),
        )
    })?;
    let y = parsed.get("y").and_then(Value::as_f64).ok_or_else(|| {
        (
            error_codes::CDP_FAILED.to_string(),
            "click target omitted its vertical coordinate".to_string(),
        )
    })?;
    dispatch_mouse_click(webview, x, y)
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
    for frame_id in frame_ids.iter().skip(1) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let frame_timeout = remaining.min(Duration::from_millis(750));
        if tokio::time::timeout(frame_timeout, evaluate_in_frame(webview, frame_id, script))
            .await
            .is_ok_and(|result| result.is_ok_and(|value| value.trim() == "true"))
        {
            return true;
        }
    }
    false
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

fn key_event_params(event_type: &str, key: &str) -> Value {
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
    if shift {
        // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
        params["modifiers"] = Value::from(8);
    }
    if event_type != "keyUp" {
        if let Some(text) = text {
            params["text"] = Value::String(text.to_string());
            params["unmodifiedText"] = Value::String(text.to_string());
        }
    }
    params
}

fn mouse_event_params(event_type: &str, x: f64, y: f64, pressed: bool) -> Value {
    json!({
        "type": event_type,
        "x": x,
        "y": y,
        "button": if event_type == "mouseMoved" { "none" } else { "left" },
        "buttons": if pressed { 1 } else { 0 },
        "clickCount": if event_type == "mouseMoved" { 0 } else { 1 },
        "pointerType": "mouse"
    })
}

async fn dispatch_mouse_click(webview: &Webview, x: f64, y: f64) -> Result<(), String> {
    call_devtools_with_retry(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        2,
    )
    .await?;
    let moved = mouse_event_params("mouseMoved", x, y, false).to_string();
    call_devtools_with_retry(webview, "Input.dispatchMouseEvent", &moved, 2).await?;
    for (event_type, pressed) in [("mousePressed", true), ("mouseReleased", false)] {
        let params = mouse_event_params(event_type, x, y, pressed).to_string();
        if let Err(error) = call_devtools_protocol_method(
            webview,
            "Input.dispatchMouseEvent",
            &params,
            Duration::from_secs(5),
        )
        .await
        {
            if event_type == "mousePressed" {
                let release = mouse_event_params("mouseReleased", x, y, false).to_string();
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
    Ok(())
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
    let down = key_event_params("keyDown", key).to_string();
    call_devtools_protocol_method(
        webview,
        "Input.dispatchKeyEvent",
        &down,
        SCRIPT_POLL_TIMEOUT,
    )
    .await?;
    let up = key_event_params("keyUp", key).to_string();
    call_devtools_protocol_method(webview, "Input.dispatchKeyEvent", &up, SCRIPT_POLL_TIMEOUT)
        .await?;
    Ok(())
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

async fn observe_submission(webview: &Webview, before_url: &str) -> SubmissionObservation {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(SUBMISSION_OBSERVATION_MS);
    let mut observation = SubmissionObservation::default();
    loop {
        if current_url(webview)
            .await
            .is_ok_and(|url| !before_url.is_empty() && url != before_url)
        {
            observation.navigation = true;
        }
        if execute_script_with_timeout(
            webview,
            "window.__anboSubmitObserved===true",
            Duration::from_millis(500),
        )
        .await
        .is_ok_and(|value| value.trim() == "true")
        {
            observation.submit_event = true;
        }
        if observation.submit_event || observation.navigation {
            return observation;
        }
        if tokio::time::Instant::now() >= deadline {
            return observation;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
        let period = key_event_params("keyDown", ".");
        assert_eq!(period["key"], ".");
        assert_eq!(period["code"], "Period");
        assert_eq!(period["windowsVirtualKeyCode"], 190);
        assert_eq!(period["text"], ".");
        assert_ne!(period["windowsVirtualKeyCode"], 46);

        let at = key_event_params("keyDown", "@");
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
        let enter = key_event_params("keyDown", "Enter");
        assert_eq!(enter["windowsVirtualKeyCode"], 13);
        assert_eq!(enter["text"], "\r");
        let enter_up = key_event_params("keyUp", "Enter");
        assert!(enter_up.get("text").is_none());
        let letter = key_event_params("keyDown", "a");
        assert_eq!(letter["code"], "KeyA");
        assert_eq!(letter["text"], "a");
    }

    #[test]
    fn mouse_click_uses_a_pressed_button_only_for_mouse_down() {
        let moved = mouse_event_params("mouseMoved", 12.5, 18.0, false);
        assert_eq!(moved["button"], "none");
        assert_eq!(moved["buttons"], 0);
        assert_eq!(moved["clickCount"], 0);

        let pressed = mouse_event_params("mousePressed", 12.5, 18.0, true);
        assert_eq!(pressed["button"], "left");
        assert_eq!(pressed["buttons"], 1);
        assert_eq!(pressed["clickCount"], 1);

        let released = mouse_event_params("mouseReleased", 12.5, 18.0, false);
        assert_eq!(released["button"], "left");
        assert_eq!(released["buttons"], 0);
        assert_eq!(released["clickCount"], 1);
    }
}

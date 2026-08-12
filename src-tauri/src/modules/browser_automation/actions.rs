use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Listener;
use tauri::Webview;

use crate::modules::app_data::local_data_root;
use crate::modules::browser_automation::cdp::{
    call_devtools_protocol_method, capture_screenshot, execute_script, execute_script_with_timeout,
};
use crate::modules::browser_automation::protocol::error_codes;
use crate::modules::browser_automation::registry::{
    get_active_tabs, get_embed_webview, get_tab_lock, remove_tab_lock,
};
use crate::modules::browser_automation::snapshot::{
    build_snapshot_js, format_snapshot, get_current_generation, get_next_generation,
    SnapshotPayload, DEFAULT_SNAPSHOT_MAX_CHARS,
};

/// Per-poll timeout for `execute_script` inside readiness/wait loops. Short on
/// purpose: while a tab is navigating, WebView2 drops the script callback, and a
/// single dropped callback must not be allowed to eat the whole wait budget.
const SCRIPT_POLL_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_TEXT_OUTPUT_CHARS: u64 = 16_000;
const MAX_WAIT_TIMEOUT_MS: u64 = 60_000;
/// How long to wait for a page to become interactive after issuing a navigation
/// (navigate/back/forward/reload) before returning. Best-effort — the command
/// returns `ok` regardless once this elapses.
const NAVIGATE_READY_TIMEOUT_MS: u64 = 8000;
const BROWSER_OPEN_REQUEST_EVENT: &str = "anbo:browser-open-request";
const BROWSER_OPEN_RESPONSE_EVENT: &str = "anbo:browser-open-response";
const BROWSER_CLOSE_REQUEST_EVENT: &str = "anbo:browser-close-request";
const BROWSER_CLOSE_RESPONSE_EVENT: &str = "anbo:browser-close-response";
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
    let _ = app.emit(
        "browser-automation-activity",
        json!({ "method": method, "params": params }),
    );

    match method {
        "open" => open_browser(app, &params).await,
        "close" => close_browser(app, &params).await,
        "list_tabs" | "tabs" => {
            let tab_ids = get_active_tabs();
            let mut result = Vec::new();
            for tab_id in tab_ids {
                if let Ok(webview) = get_embed_webview(app, tab_id) {
                    let url_res = execute_script(&webview, "window.location.href").await;
                    let title_res = execute_script(&webview, "document.title").await;

                    let url = url_res.unwrap_or_default().trim_matches('"').to_string();
                    let title = title_res.unwrap_or_default().trim_matches('"').to_string();

                    result.push(json!({
                        "tabId": tab_id,
                        "url": url,
                        "title": title,
                    }));
                }
            }
            Ok(json!({ "tabs": result }))
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

            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err((
                    error_codes::NAVIGATION_FAILED.to_string(),
                    "only http:// and https:// URLs are allowed".to_string(),
                ));
            }

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let script = format!(
                "window.location.href = {};",
                serde_json::to_string(url).unwrap()
            );
            // Setting location.href unloads the current document, so the script
            // callback is routinely dropped mid-navigation — that's expected, not
            // an error. Use a short timeout and ignore the outcome; wait_for_ready
            // confirms the new page actually loaded before we return.
            let _ = execute_script_with_timeout(&webview, &script, SCRIPT_POLL_TIMEOUT).await;
            wait_for_ready(&webview, NAVIGATE_READY_TIMEOUT_MS).await;

            Ok(json!({ "tabId": tab_id, "url": url, "ok": true }))
        }

        "reload" | "back" | "forward" | "stop" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let js = match method {
                "reload" => "window.location.reload();",
                "back" => "window.history.back();",
                "forward" => "window.history.forward();",
                "stop" => "window.stop();",
                _ => unreachable!(),
            };
            // reload/back/forward kick off an async navigation, so the script
            // callback may be dropped as the document unloads — treat that as
            // expected and wait for the page to become interactive. `stop` halts
            // loading, so it needs no readiness gate.
            let _ = execute_script_with_timeout(&webview, js, SCRIPT_POLL_TIMEOUT).await;
            if method != "stop" {
                wait_for_ready(&webview, NAVIGATE_READY_TIMEOUT_MS).await;
            }
            Ok(json!({ "tabId": tab_id, "action": method, "ok": true }))
        }

        "snapshot" => {
            let tab_id = extract_tab_id(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            wait_for_ready(&webview, 5000).await;
            let gen = get_next_generation(tab_id);
            let js = build_snapshot_js(gen);

            let res_json = execute_script(&webview, &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            let raw_str: String = serde_json::from_str(&res_json).unwrap_or(res_json);

            let payload: SnapshotPayload = serde_json::from_str(&raw_str).map_err(|e| {
                (
                    error_codes::CDP_FAILED.to_string(),
                    format!("failed to parse snapshot JSON: {e}"),
                )
            })?;

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
                "maxChars": formatted.max_chars
            }))
        }

        "click" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
            let ref_json = serde_json::to_string(&ref_id).unwrap();

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
                    return JSON.stringify({{
                        ok: true,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    }});
                }})();"#,
                ref_json, cur_gen
            );

            let res = execute_script(&webview, &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let parsed: Value = serde_json::from_str(&unquoted).unwrap_or_default();

            if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
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
            dispatch_mouse_click(&webview, x, y)
                .await
                .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;

            Ok(json!({
                "tabId": tab_id,
                "ref": ref_id,
                "ok": true,
                "dispatch": "devtools"
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
            let append = params
                .get("append")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            let cur_gen = get_current_generation(tab_id);
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

            let res = execute_script(&webview, &js)
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

        "press_key" | "press" => {
            let tab_id = extract_tab_id(&params)?;
            let key = params.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                (
                    error_codes::INVALID_REQUEST.to_string(),
                    "missing 'key' parameter".to_string(),
                )
            })?;

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
            let submitted = if key == "Enter" {
                observe_submission(&webview, &before_url).await
            } else {
                false
            };

            Ok(json!({
                "tabId": tab_id,
                "key": key,
                "ok": true,
                "dispatch": "devtools",
                "submitted": submitted
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
            let timeout_ms = params
                .get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(10000)
                .clamp(100, MAX_WAIT_TIMEOUT_MS);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let start = SystemTime::now();
            loop {
                let js = build_wait_for_text_js(text);
                let res = execute_script_with_timeout(&webview, &js, SCRIPT_POLL_TIMEOUT)
                    .await
                    .unwrap_or_default();
                if res.trim() == "true" {
                    return Ok(json!({ "tabId": tab_id, "found": true, "text": text }));
                }

                let elapsed = start.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0);
                if elapsed >= timeout_ms {
                    return Err((
                        error_codes::TIMEOUT.to_string(),
                        format!("timed out waiting for text '{text}' after {timeout_ms}ms"),
                    ));
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
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
            let res = execute_script(&webview, &js)
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
            let res = execute_script(&webview, &js)
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
            let res = execute_script(&webview, &js)
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
            let ref_id = params.get("ref").and_then(|v| v.as_str());
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
            let ref_json = serde_json::to_string(ref_id.unwrap_or("")).unwrap();
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
            let res = execute_script(&webview, &js)
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
            wait_for_ready(&webview, 5000).await;
            let title_res = execute_script(&webview, "document.title")
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let url_res = execute_script(&webview, "window.location.href")
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            // execute_script returns the value as a JSON string (quoted + escaped);
            // decode it properly so titles/URLs containing quotes survive. Sibling
            // arms use the same serde_json::from_str pattern.
            let title =
                serde_json::from_str::<String>(&title_res).unwrap_or_else(|_| title_res.clone());
            let url = serde_json::from_str::<String>(&url_res).unwrap_or_else(|_| url_res.clone());
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

            let logs = execute_script(&webview, "JSON.stringify(window.__anboLogs || [])")
                .await
                .unwrap_or_else(|_| "[]".to_string());

            let logs = serde_json::from_str::<String>(&logs).unwrap_or(logs);
            Ok(json!({ "logs": serde_json::from_str::<Value>(&logs).unwrap_or(json!([])) }))
        }

        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unknown method '{method}'"),
        )),
    }
}

fn build_wait_for_text_js(text: &str) -> String {
    format!(
        r#"(function() {{
            const needle = {};
            if ((document.title || '').includes(needle)) return true;
            if (document.body && (document.body.innerText || '').includes(needle)) return true;
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
                if (values.some(value => value && value.includes(needle))) return true;
            }}
            return false;
        }})()"#,
        serde_json::to_string(text).unwrap()
    )
}

fn decode_screenshot_response(response: &str) -> Result<Vec<u8>, String> {
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
    let (key_name, code, virtual_key, text) = match key {
        "Enter" => ("Enter".to_string(), "Enter".to_string(), 13, Some("\r")),
        "Tab" => ("Tab".to_string(), "Tab".to_string(), 9, None),
        "Escape" | "Esc" => ("Escape".to_string(), "Escape".to_string(), 27, None),
        "Backspace" => ("Backspace".to_string(), "Backspace".to_string(), 8, None),
        "Delete" => ("Delete".to_string(), "Delete".to_string(), 46, None),
        "ArrowLeft" => ("ArrowLeft".to_string(), "ArrowLeft".to_string(), 37, None),
        "ArrowUp" => ("ArrowUp".to_string(), "ArrowUp".to_string(), 38, None),
        "ArrowRight" => ("ArrowRight".to_string(), "ArrowRight".to_string(), 39, None),
        "ArrowDown" => ("ArrowDown".to_string(), "ArrowDown".to_string(), 40, None),
        "Home" => ("Home".to_string(), "Home".to_string(), 36, None),
        "End" => ("End".to_string(), "End".to_string(), 35, None),
        "PageUp" => ("PageUp".to_string(), "PageUp".to_string(), 33, None),
        "PageDown" => ("PageDown".to_string(), "PageDown".to_string(), 34, None),
        "Space" | " " => (" ".to_string(), "Space".to_string(), 32, Some(" ")),
        _ if key.chars().count() == 1 => {
            let character = key.chars().next().unwrap();
            let upper = character.to_ascii_uppercase();
            let code = if upper.is_ascii_alphabetic() {
                format!("Key{upper}")
            } else if upper.is_ascii_digit() {
                format!("Digit{upper}")
            } else {
                String::new()
            };
            (key.to_string(), code, i64::from(upper as u32), Some(key))
        }
        _ => (key.to_string(), key.to_string(), 0, None),
    };
    let mut params = json!({
        "type": event_type,
        "key": key_name,
        "code": code,
        "windowsVirtualKeyCode": virtual_key,
        "nativeVirtualKeyCode": virtual_key
    });
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
    call_devtools_protocol_method(
        webview,
        "Emulation.setFocusEmulationEnabled",
        r#"{"enabled":true}"#,
        SCRIPT_POLL_TIMEOUT,
    )
    .await?;
    for (event_type, pressed) in [
        ("mouseMoved", false),
        ("mousePressed", true),
        ("mouseReleased", false),
    ] {
        let params = mouse_event_params(event_type, x, y, pressed).to_string();
        call_devtools_protocol_method(
            webview,
            "Input.dispatchMouseEvent",
            &params,
            SCRIPT_POLL_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

async fn dispatch_key(webview: &Webview, key: &str) -> Result<(), String> {
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

async fn observe_submission(webview: &Webview, before_url: &str) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    loop {
        if current_url(webview)
            .await
            .is_ok_and(|url| !before_url.is_empty() && url != before_url)
        {
            return true;
        }
        if execute_script_with_timeout(
            webview,
            "window.__anboSubmitObserved===true",
            Duration::from_millis(500),
        )
        .await
        .is_ok_and(|value| value.trim() == "true")
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
    Ok((tab_id, workspace))
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
    let Some(digits) = ref_id.strip_prefix('e') else {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "invalid 'ref': expected e followed by digits".to_string(),
        ));
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "invalid 'ref': expected e followed by digits".to_string(),
        ));
    }
    Ok(ref_id.to_string())
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
        let v1 = json!({ "ref": "e1" });
        assert_eq!(extract_ref(&v1).unwrap(), "e1");

        let v2 = json!({ "ref_id": "e42" });
        assert_eq!(extract_ref(&v2).unwrap(), "e42");

        let v3 = json!({});
        assert!(extract_ref(&v3).is_err());

        for invalid in ["", "e", "42", "e1\"]'); alert(1); //", "e-1"] {
            assert!(extract_ref(&json!({ "ref": invalid })).is_err());
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

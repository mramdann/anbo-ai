use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Webview;

use crate::modules::app_data::local_data_root;
use crate::modules::browser_automation::cdp::{execute_script, execute_script_with_timeout};
use crate::modules::browser_automation::protocol::error_codes;
use crate::modules::browser_automation::registry::{
    get_active_tabs, get_embed_webview, get_tab_lock,
};
use crate::modules::browser_automation::snapshot::{
    build_snapshot_js, format_snapshot, get_current_generation, get_next_generation,
    SnapshotPayload,
};

/// Per-poll timeout for `execute_script` inside readiness/wait loops. Short on
/// purpose: while a tab is navigating, WebView2 drops the script callback, and a
/// single dropped callback must not be allowed to eat the whole wait budget.
const SCRIPT_POLL_TIMEOUT: Duration = Duration::from_secs(2);
/// How long to wait for a page to become interactive after issuing a navigation
/// (navigate/back/forward/reload) before returning. Best-effort — the command
/// returns `ok` regardless once this elapses.
const NAVIGATE_READY_TIMEOUT_MS: u64 = 8000;

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
    let _ = app.emit("browser-automation-activity", json!({ "method": method, "params": params }));

    match method {
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

            let text_snapshot = format_snapshot(&payload, gen);

            Ok(json!({
                "tabId": tab_id,
                "generation": gen,
                "snapshot": text_snapshot,
                "title": payload.title,
                "url": payload.url
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
                    el.focus();
                    el.click();
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

            let js = format!(
                r#"(function() {{
                    const key = {};
                    const target = document.activeElement || document.body;
                    const opts = {{ key: key, bubbles: true, cancelable: true }};
                    target.dispatchEvent(new KeyboardEvent('keydown', opts));
                    target.dispatchEvent(new KeyboardEvent('keypress', opts));
                    target.dispatchEvent(new KeyboardEvent('keyup', opts));
                    // Synthetic key events don't trigger the browser's native
                    // form-submission on Enter, so submit the active form
                    // explicitly. requestSubmit() fires submit handlers and
                    // validation like a real submit. Skip <textarea>: there a
                    // real browser inserts a newline on Enter, not a submit.
                    let submitted = false;
                    if (key === 'Enter' && target && target.form && target.tagName !== 'TEXTAREA') {{
                        // requestSubmit() validates synchronously and, if it
                        // passes, dispatches `submit` synchronously (before any
                        // navigation). A validation failure does NOT throw, so
                        // track an actual submit via the event rather than
                        // assuming success after the call returns.
                        const form = target.form;
                        const onSubmit = () => {{ submitted = true; }};
                        form.addEventListener('submit', onSubmit, {{ once: true }});
                        try {{ form.requestSubmit(); }} catch (e) {{}}
                        form.removeEventListener('submit', onSubmit);
                    }}
                    return JSON.stringify({{ ok: true, submitted: submitted }});
                }})();"#,
                serde_json::to_string(key).unwrap()
            );

            let res = execute_script(&webview, &js)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;
            let unquoted: String = serde_json::from_str(&res).unwrap_or(res);
            let submitted = serde_json::from_str::<Value>(&unquoted)
                .ok()
                .and_then(|v| v.get("submitted").and_then(|s| s.as_bool()))
                .unwrap_or(false);

            Ok(json!({ "tabId": tab_id, "key": key, "ok": true, "submitted": submitted }))
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
                .unwrap_or(10000);

            let tab_lock = get_tab_lock(tab_id);
            let _lock = tab_lock.lock().await;
            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;

            let start = SystemTime::now();
            loop {
                let js = format!(
                    "document.body ? document.body.innerText.includes({}) : false",
                    serde_json::to_string(text).unwrap()
                );
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
                fs::create_dir_all(&out_dir).map_err(|e| (error_codes::INTERNAL.to_string(), e.to_string()))?;
                out_dir
            } else {
                artifacts_dir().map_err(|e| (error_codes::INTERNAL.to_string(), e))?
            };

            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let file_path = dir.join(format!("screenshot_{tab_id}_{ts}.jpg"));

            let data_url = crate::modules::browser::embed::capture_preview_artifact(webview)
                .await
                .map_err(|e| (error_codes::CDP_FAILED.to_string(), e))?;

            if let Some(base64_str) = data_url.split(',').nth(1) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64_str) {
                    fs::write(&file_path, &bytes).map_err(|e| {
                        (
                            error_codes::INTERNAL.to_string(),
                            format!("failed to write screenshot: {e}"),
                        )
                    })?;
                    return Ok(json!({
                        "tabId": tab_id,
                        "path": file_path.to_string_lossy(),
                        "size": bytes.len()
                    }));
                }
            }

            Err((
                error_codes::CDP_FAILED.to_string(),
                "failed to capture screenshot data".to_string(),
            ))
        }

        "select_option" | "select" => {
            let tab_id = extract_tab_id(&params)?;
            let ref_id = extract_ref(&params)?;
            let value = params.get("value").and_then(|v| v.as_str()).ok_or_else(|| {
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
                let err = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("stale_ref");
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
            let max_length = params.get("maxLength").and_then(|v| v.as_u64()).unwrap_or(8000);
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
                    const text = el.innerText || el.textContent || '';
                    const max = {};
                    let truncated = false;
                    let out = text;
                    if (text.length > max) {{ out = text.slice(0, max); truncated = true; }}
                    return JSON.stringify({{ ok: true, text: out, truncated: truncated, totalLength: text.length }});
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
                    "truncated": parsed.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                    "totalLength": parsed.get("totalLength").and_then(|v| v.as_u64()).unwrap_or(0)
                }))
            } else {
                let err = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("stale_ref");
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
            let url =
                serde_json::from_str::<String>(&url_res).unwrap_or_else(|_| url_res.clone());
            Ok(json!({ "tabId": tab_id, "title": title, "url": url }))
        }

        "console_logs" => {
            let tab_id = params
                .get("tabId")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| (error_codes::INVALID_REQUEST.to_string(), "Missing tabId".into()))?;

            let webview = get_embed_webview(app, tab_id)
                .map_err(|e| (error_codes::TAB_NOT_FOUND.to_string(), e))?;
            
            let logs = execute_script(&webview, "JSON.stringify(window.__anboLogs || [])")
                .await
                .unwrap_or_else(|_| "[]".to_string());
            
            let logs = serde_json::from_str::<String>(&logs).unwrap_or_else(|_| logs);
            Ok(json!({ "logs": serde_json::from_str::<Value>(&logs).unwrap_or(json!([])) }))
        }

        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unknown method '{method}'"),
        )),
    }
}

/// Poll the embed webview until its document is interactive/complete with a
/// body, so reads (snapshot / get_text / get_page_info) issued right after a
/// `navigate` don't race the page load and return empty/no_body. Best-effort:
/// returns once ready or after `timeout_ms` — never errors, callers proceed.
async fn wait_for_ready(webview: &Webview, timeout_ms: u64) {
    let start = SystemTime::now();
    loop {
        let ready = execute_script_with_timeout(webview, "document.readyState", SCRIPT_POLL_TIMEOUT)
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
}

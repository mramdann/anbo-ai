use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Webview;

use super::cdp::call_devtools_protocol_method;
use crate::modules::browser::embed::active_navigation_generation;

pub const REF_REGISTRY_JS: &str = include_str!("refRegistry.js");
const CONTEXT_TIMEOUT: Duration = Duration::from_secs(2);
static ROOT_CONTEXTS: Mutex<Option<HashMap<i64, (u64, i64)>>> = Mutex::new(None);

pub fn remove(tab_id: i64) {
    if let Ok(mut guard) = ROOT_CONTEXTS.lock() {
        if let Some(contexts) = guard.as_mut() {
            contexts.remove(&tab_id);
        }
    }
}

pub fn clear() {
    if let Ok(mut guard) = ROOT_CONTEXTS.lock() {
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
    let raw = call_devtools_protocol_method(
        webview,
        "Runtime.evaluate",
        &json!({"expression": expression, "contextId": context_id, "returnByValue": true,
            "awaitPromise": false, "userGesture": true})
        .to_string(),
        Duration::from_secs(5),
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if payload.get("exceptionDetails").is_some() {
        return Err("browser ref script failed".into());
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

#[cfg(test)]
mod tests {
    use super::*;

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

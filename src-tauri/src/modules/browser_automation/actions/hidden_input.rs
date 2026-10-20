//! Pointer actions on a Chrome or Edge page its browser is not showing, as one
//! in a workspace Anbo is not showing. The browser sends a hidden page no
//! pointer input, and refusing it left the agents of every other workspace
//! unable to click, check, hover or drag there until the user came by: 17 of
//! the 24-hour soak's 27 failures (Oct 19-20 2026).
//!
//! Keys do reach a hidden page. A native control (a button, a link, a summary,
//! a checkbox or radio) is focused and activated as a keyboard user would, with
//! Enter, or Space for a checkbox or radio. Anything else gets the page's own
//! pointer and mouse events at its middle, which its handlers act on, although
//! CSS :hover does not follow them and a drag that captures the real pointer
//! may not. Every answer says which input ran and that the page stayed hidden.

use super::{
    deep_ref_expression, dispatch_key_action, error_codes, execute_ref_script, page_json,
    ref_failure_reason, wait_for_checked_state, RefFrameTarget, Webview,
};
use serde_json::{json, Value};

/// Actions a hidden page can take without being shown.
pub(super) fn stands_in(method: &str) -> bool {
    matches!(
        method,
        "click" | "double_click" | "check" | "focus" | "hover" | "drag"
    )
}

const KEYBOARD_NOTE: &str = "the page is hidden in its browser (its workspace is not shown), so Anbo activated the control with the keyboard instead of a pointer click; check the result before relying on it";
const DOM_NOTE: &str = "the page is hidden in its browser (its workspace is not shown), so Anbo sent the page's own pointer and mouse events instead of real pointer input: page handlers act on them, CSS :hover does not follow them; check the result before relying on it";
const FOCUS_NOTE: &str = "the page stays hidden in its browser (its workspace is not shown); keys you send reach the focused element";

/// Event helpers every hidden-page script starts with.
const HIDDEN_INPUT_JS: &str = r#"
    const anboHidden = (() => {
        const center = (node, position) => {
            const rect = node.getBoundingClientRect();
            const fx = position ? position.x : 0.5;
            const fy = position ? position.y : 0.5;
            return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
        };
        const fire = (node, Kind, type, point, extra) => node.dispatchEvent(new Kind(type, Object.assign({
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y
        }, extra || {})));
        const pointer = (node, type, point, extra) => fire(node, PointerEvent, type, point,
            Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, extra || {}));
        const enter = (node, point) => {
            pointer(node, 'pointerover', point);
            pointer(node, 'pointerenter', point, { bubbles: false });
            fire(node, MouseEvent, 'mouseover', point);
            fire(node, MouseEvent, 'mouseenter', point, { bubbles: false });
            pointer(node, 'pointermove', point);
            fire(node, MouseEvent, 'mousemove', point);
        };
        const press = (node, point, detail) => {
            pointer(node, 'pointerdown', point, { button: 0, buttons: 1, detail, pressure: 0.5 });
            fire(node, MouseEvent, 'mousedown', point, { button: 0, buttons: 1, detail });
        };
        const release = (node, point, detail) => {
            pointer(node, 'pointerup', point, { button: 0, buttons: 0, detail });
            fire(node, MouseEvent, 'mouseup', point, { button: 0, buttons: 0, detail });
        };
        const focusOn = (node) => {
            try { node.focus({ preventScroll: true }); } catch (_) {}
            const root = node.getRootNode && node.getRootNode();
            return !!root && root.activeElement === node;
        };
        const kind = (node) => {
            const tag = node.tagName.toLowerCase();
            const type = (node.getAttribute('type') || '').toLowerCase();
            const toggles = tag === 'input' && (type === 'checkbox' || type === 'radio');
            const native = tag === 'button' || (tag === 'a' && node.hasAttribute('href')) ||
                tag === 'summary' ||
                (tag === 'input' && ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type));
            return { tag, type, toggles, native };
        };
        const disabled = (node) => node.disabled === true || node.getAttribute('aria-disabled') === 'true';
        const click = (node, count) => {
            const point = center(node, null);
            enter(node, point);
            for (let detail = 1; detail <= count; detail++) {
                if (refRegistry.resolve(refId) !== node) {
                    return { ok: false, error: 'stale_ref', reason: refRegistry.reason(refId), clicksDispatched: detail - 1 };
                }
                press(node, point, detail);
                if (detail === 1) focusOn(node);
                release(node, point, detail);
                fire(node, MouseEvent, 'click', point, { button: 0, detail });
            }
            if (count === 2) fire(node, MouseEvent, 'dblclick', point, { button: 0, detail: 2 });
            return { ok: true, input: 'dom-events' };
        };
        return { center, fire, pointer, enter, press, release, focusOn, kind, disabled, click };
    })();
"#;

fn script(ref_id: &str, body: &str) -> String {
    deep_ref_expression(ref_id, &format!("{HIDDEN_INPUT_JS}\n{body}"))
}

async fn run(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
    body: &str,
) -> Result<Value, (String, String)> {
    let response = execute_ref_script(webview, target, &script(ref_id, body))
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let decoded: String = page_json::from_str(&response).unwrap_or(response);
    let parsed: Value = page_json::from_str(&decoded).unwrap_or_default();
    if parsed["ok"].as_bool() == Some(true) {
        return Ok(parsed);
    }
    Err(refusal(ref_id, &parsed))
}

fn refusal(ref_id: &str, parsed: &Value) -> (String, String) {
    match parsed["error"].as_str() {
        Some("disabled") => (
            error_codes::INPUT_NOT_READY.to_string(),
            format!("element ref '{ref_id}' is disabled; no input was sent"),
        ),
        Some("not_checkable") => (
            error_codes::INVALID_REQUEST.to_string(),
            format!("element ref '{ref_id}' is not a checkbox or radio"),
        ),
        Some("radio_uncheck") => (
            error_codes::INVALID_REQUEST.to_string(),
            "radio inputs cannot be unchecked directly".to_string(),
        ),
        Some("unfocusable") => (
            error_codes::INPUT_NOT_READY.to_string(),
            format!("element ref '{ref_id}' could not be focused"),
        ),
        _ => (
            error_codes::STALE_REF.to_string(),
            format!(
                "element ref '{ref_id}' is stale or no longer valid (reason: {})",
                ref_failure_reason(parsed)
            ),
        ),
    }
}

fn answer(tab_id: i64, ref_id: &str, input: &str) -> Value {
    json!({
        "tabId": tab_id,
        "ref": ref_id,
        "ok": true,
        "dispatch": input,
        "pageHidden": true,
        "note": if input == "keyboard" { KEYBOARD_NOTE } else { DOM_NOTE },
    })
}

async fn press(webview: &Webview, key: &str) -> Result<(), (String, String)> {
    dispatch_key_action(webview, key, "press", 0)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))
}

/// A click or double click: Enter or Space on a native control, otherwise
/// the page's own events.
pub(super) async fn click(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    count: u8,
) -> Result<Value, (String, String)> {
    // The page counts as focused before its control takes focus.
    super::ref_context::ensure_focus(webview)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let prepared = run(
        webview,
        target,
        ref_id,
        &format!(
            r#"
            if (!el) return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            if (anboHidden.disabled(el)) return JSON.stringify({{ ok: false, error: 'disabled' }});
            const kind = anboHidden.kind(el);
            if ({count} === 1 && kind.native && anboHidden.focusOn(el)) {{
                return JSON.stringify({{ ok: true, input: 'keyboard', key: kind.toggles ? ' ' : 'Enter' }});
            }}
            return JSON.stringify(anboHidden.click(el, {count}));"#
        ),
    )
    .await?;
    let input = prepared["input"].as_str().unwrap_or("dom-events");
    if input == "keyboard" {
        press(webview, prepared["key"].as_str().unwrap_or("Enter")).await?;
    }
    let mut result = answer(tab_id, ref_id, input);
    if count == 2 {
        result["clickCount"] = json!(2);
    }
    Ok(result)
}

/// Sets a checkbox or radio: Space on it when it takes focus, else its own
/// click; the state is read back either way.
pub(super) async fn check(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    requested: bool,
) -> Result<Value, (String, String)> {
    super::ref_context::ensure_focus(webview)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    let prepared = run(
        webview,
        target,
        ref_id,
        &format!(
            r#"
            if (!el) return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            const kind = anboHidden.kind(el);
            if (!kind.toggles) return JSON.stringify({{ ok: false, error: 'not_checkable' }});
            if (kind.type === 'radio' && !{requested}) return JSON.stringify({{ ok: false, error: 'radio_uncheck' }});
            if (anboHidden.disabled(el)) return JSON.stringify({{ ok: false, error: 'disabled' }});
            if (el.checked === {requested}) return JSON.stringify({{ ok: true, input: 'none', checked: el.checked }});
            if (anboHidden.focusOn(el)) return JSON.stringify({{ ok: true, input: 'keyboard' }});
            return JSON.stringify(anboHidden.click(el, 1));"#
        ),
    )
    .await?;
    let mut input = prepared["input"]
        .as_str()
        .unwrap_or("dom-events")
        .to_string();
    if input == "none" {
        let mut result = answer(tab_id, ref_id, "none");
        result["checked"] = json!(requested);
        result["changed"] = json!(false);
        if let Some(object) = result.as_object_mut() {
            object.remove("note");
        }
        return Ok(result);
    }
    if input == "keyboard" {
        press(webview, " ").await?;
    }
    let mut checked = wait_for_checked_state(webview, target, ref_id, requested).await;
    // A page that handles the key itself can keep Space from toggling.
    if input == "keyboard"
        && checked
            .as_ref()
            .is_err_and(|error| error.0 == error_codes::TIMEOUT)
    {
        run(
            webview,
            target,
            ref_id,
            r#"
            if (!el) return JSON.stringify({ ok: false, error: 'stale_ref' });
            if (el.checked === WANTED) return JSON.stringify({ ok: true });
            return JSON.stringify(anboHidden.click(el, 1));"#
                .replace("WANTED", &requested.to_string())
                .as_str(),
        )
        .await?;
        input = "dom-events".to_string();
        checked = wait_for_checked_state(webview, target, ref_id, requested).await;
    }
    let mut result = answer(tab_id, ref_id, &input);
    result["checked"] = json!(checked?);
    result["changed"] = json!(true);
    Ok(result)
}

pub(super) async fn focus(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
) -> Result<Value, (String, String)> {
    super::ref_context::ensure_focus(webview)
        .await
        .map_err(|error| (error_codes::CDP_FAILED.to_string(), error))?;
    run(
        webview,
        target,
        ref_id,
        r#"
        if (!el) return JSON.stringify({ ok: false, error: 'stale_ref' });
        return JSON.stringify(anboHidden.focusOn(el) ? { ok: true } : { ok: false, error: 'unfocusable' });"#,
    )
    .await?;
    Ok(json!({
        "tabId": tab_id,
        "ref": ref_id,
        "ok": true,
        "focused": true,
        "pageHidden": true,
        "note": FOCUS_NOTE,
    }))
}

pub(super) async fn hover(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    position: Option<(f64, f64)>,
) -> Result<Value, (String, String)> {
    let position = position
        .map(|(x, y)| json!({ "x": x, "y": y }))
        .unwrap_or(Value::Null);
    run(
        webview,
        target,
        ref_id,
        &format!(
            r#"
            if (!el) return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            anboHidden.enter(el, anboHidden.center(el, {position}));
            return JSON.stringify({{ ok: true }});"#
        ),
    )
    .await?;
    Ok(answer(tab_id, ref_id, "dom-events"))
}

/// A drag from one element to another, or within one, in the same document:
/// HTML drag and drop events for a draggable source, otherwise a press, moves
/// over whatever lies on the way, and a release.
pub(super) async fn drag(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    source_ref: &str,
    target_ref: &str,
    source_position: Option<(f64, f64)>,
    target_position: Option<(f64, f64)>,
) -> Result<Value, (String, String)> {
    let at = |position: Option<(f64, f64)>| {
        position
            .map(|(x, y)| json!({ "x": x, "y": y }))
            .unwrap_or(Value::Null)
    };
    let (from, to) = (at(source_position), at(target_position));
    let target_ref_json = serde_json::to_string(target_ref).unwrap_or_default();
    let dragged = run(
        webview,
        target,
        source_ref,
        &format!(
            r#"
            if (!el) return JSON.stringify({{ ok: false, error: 'stale_ref' }});
            const dst = refRegistry.resolve({target_ref_json});
            if (!dst) return JSON.stringify({{ ok: false, error: 'stale_ref', reason: refRegistry.reason({target_ref_json}) }});
            const from = anboHidden.center(el, {from});
            const to = anboHidden.center(dst, {to});
            anboHidden.enter(el, from);
            anboHidden.press(el, from, 1);
            if (el.draggable) {{
                const data = new DataTransfer();
                const drag = (node, type, point) => node.dispatchEvent(new DragEvent(type, {{
                    bubbles: true, cancelable: true, composed: true, view: window,
                    clientX: point.x, clientY: point.y, dataTransfer: data
                }}));
                drag(el, 'dragstart', from);
                drag(el, 'drag', from);
                drag(dst, 'dragenter', to);
                drag(dst, 'dragover', to);
                drag(dst, 'drop', to);
                drag(el, 'dragend', to);
                return JSON.stringify({{ ok: true, kind: 'html' }});
            }}
            const steps = 8;
            for (let step = 1; step <= steps; step++) {{
                const point = {{
                    x: from.x + (to.x - from.x) * step / steps,
                    y: from.y + (to.y - from.y) * step / steps
                }};
                const over = document.elementFromPoint(point.x, point.y) || dst;
                anboHidden.pointer(over, 'pointermove', point, {{ buttons: 1 }});
                anboHidden.fire(over, MouseEvent, 'mousemove', point, {{ buttons: 1 }});
            }}
            anboHidden.release(document.elementFromPoint(to.x, to.y) || dst, to, 1);
            return JSON.stringify({{ ok: true, kind: 'pointer' }});"#
        ),
    )
    .await?;
    let mut result = answer(tab_id, source_ref, "dom-events");
    result["targetRef"] = json!(target_ref);
    result["dragKind"] = dragged["kind"].clone();
    Ok(result)
}

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
//! may not. Every answer says which input ran, that the page stayed hidden,
//! and why (`external_front::hidden_because`).

use super::{
    deep_ref_expression, dispatch_key_action, error_codes, execute_ref_script, page_json,
    ref_failure_reason, wait_for_checked_state, RefFrameTarget, Webview,
};
use serde_json::{json, Value};
use std::time::Duration;

/// How long a page's link waits for its tab to be made. The browser does it at
/// once; on a busy machine the extension's queue can take a moment.
const OPEN_LINK_PATIENCE: Duration = Duration::from_secs(5);
/// How long a look at a tab's window may take. Past that the input goes on as
/// it would have.
const TAB_STATE_PATIENCE: Duration = Duration::from_millis(600);

/// Actions a hidden page can take without being shown.
pub(super) fn stands_in(method: &str) -> bool {
    matches!(
        method,
        "click" | "double_click" | "check" | "focus" | "hover" | "drag" | "dialog"
    )
}

// `why` is the reason the page could not be shown, as "Anbo is not the window
// the user is in": an agent that read "its workspace is not shown" asked the
// user to show a workspace already on screen (round 72, R72-4).
fn keyboard_note(why: &str) -> String {
    format!("the page is hidden in its browser ({why}), so Anbo activated the control with the keyboard instead of a pointer click; check the result before relying on it")
}

fn dom_note(why: &str) -> String {
    format!("the page is hidden in its browser ({why}), so Anbo sent the page's own pointer and mouse events instead of real pointer input: page handlers act on them, CSS :hover does not follow them; check the result before relying on it")
}

fn focus_note(why: &str) -> String {
    format!("the page stays hidden in its browser ({why}); keys you send reach the focused element")
}

fn link_note(why: &str) -> String {
    format!("the page is hidden in its browser ({why}), so Anbo activated the link with Ctrl+Enter, which opens it in a new background tab; check the result before relying on it")
}

const LINK_GUARD_JS: &str = include_str!("../linkGuard.js");

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
            // A link that opens another tab or window, by its own target or the
            // page's base target.
            const base = node.ownerDocument.querySelector('base[target]');
            const target = (node.getAttribute('target') ?? (base ? base.getAttribute('target') : '') ?? '')
                .trim().toLowerCase();
            const opensTab = tag === 'a' && node.hasAttribute('href') && target !== '' &&
                !['_self', '_parent', '_top'].includes(target);
            return { tag, type, toggles, native, opensTab };
        };
        const disabled = (node) => node.disabled === true || node.getAttribute('aria-disabled') === 'true';
        const guardLink = (node, anyLink) =>
            anboGuardLink(node, (link) => anyLink || kind(link).opensTab);
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
        return { center, fire, pointer, enter, press, release, focusOn, kind, disabled, guardLink, click };
    })();
"#;

fn script(ref_id: &str, body: &str) -> String {
    deep_ref_expression(
        ref_id,
        &format!("{LINK_GUARD_JS}\n{HIDDEN_INPUT_JS}\n{body}"),
    )
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

fn answer(tab_id: i64, ref_id: &str, input: &str, why: &str) -> Value {
    json!({
        "tabId": tab_id,
        "ref": ref_id,
        "ok": true,
        "dispatch": input,
        "pageHidden": true,
        "note": if input == "keyboard" { keyboard_note(why) } else { dom_note(why) },
    })
}

/// The Ctrl bit of a CDP key event's modifiers.
pub(super) const CTRL: u8 = 2;

async fn press(webview: &Webview, key: &str, modifiers: u8) -> Result<(), (String, String)> {
    dispatch_key_action(webview, key, "press", modifiers)
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
    why: &str,
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
            const guarded = {count} === 1 && anboHidden.guardLink(el);
            if ({count} === 1 && kind.native && anboHidden.focusOn(el)) {{
                return JSON.stringify({{ ok: true, input: 'keyboard', key: kind.toggles ? ' ' : 'Enter', opensTab: kind.opensTab, guarded }});
            }}
            return JSON.stringify(Object.assign(anboHidden.click(el, {count}), {{ guarded }}));"#
        ),
    )
    .await?;
    let input = prepared["input"].as_str().unwrap_or("dom-events");
    // Enter on a link to another tab opened that tab in front, and its browser
    // window came over Anbo and took the user's focus (round 66, R66-3). With
    // Ctrl the browser opens it behind, as a middle click would.
    let background = input == "keyboard" && prepared["opensTab"].as_bool() == Some(true);
    if input == "keyboard" {
        press(
            webview,
            prepared["key"].as_str().unwrap_or("Enter"),
            if background { CTRL } else { 0 },
        )
        .await?;
    }
    let opened = if prepared["guarded"].as_bool() == Some(true) {
        open_held_link(webview, target, ref_id).await?
    } else {
        background
    };
    let mut result = answer(tab_id, ref_id, input, why);
    if opened {
        result["note"] = json!(link_note(why));
        result["newTab"] = json!("background");
    }
    if count == 2 {
        result["clickCount"] = json!(2);
    }
    Ok(result)
}

/// Whether a click or key on this page should have its link held back: its
/// window is not the one the user is in, and Anbo's dock does not hold the page.
/// A tab a page opens, even behind, brings its minimized window back and takes
/// the foreground from the window the user is in, 18 of 18 times in round 85
/// (R72-1). A window that is not minimized only asks for the foreground, which
/// Windows refuses until the user's last input is older than
/// ForegroundLockTimeout, so that one comes forward too on an idle machine.
pub(super) async fn window_is_away(webview: &Webview, tab_id: i64) -> bool {
    let Webview::External { target, .. } = webview else {
        return false;
    };
    if crate::modules::browser_external::dock::docked(tab_id).is_some() {
        return false;
    }
    target
        .call("anbo.tabState", json!({}), TAB_STATE_PATIENCE)
        .await
        .is_ok_and(|state| state["focused"].as_bool() == Some(false))
}

/// Before a pointer click on a page in a window away from the user: whether a
/// link it lands on is held back, for `open_held_link` after the click.
pub(super) async fn guard_click(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
) -> bool {
    run(
        webview,
        target,
        ref_id,
        "return JSON.stringify({ ok: true, guarded: !!el && anboHidden.guardLink(el) });",
    )
    .await
    .is_ok_and(|armed| armed["guarded"].as_bool() == Some(true))
}

/// Before Enter or Ctrl+Enter on such a page: the same for the link that has
/// the focus, which the key follows. Plain Enter stays in the tab on a link
/// with no target of its own, and Ctrl+Enter opens any link in another.
pub(super) async fn guard_key(webview: &Webview, modifiers: u8) -> bool {
    run(
        webview,
        None,
        "",
        &format!(
            r#"
            let node = document.activeElement;
            while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
            return JSON.stringify({{ ok: true, guarded: !!node && anboHidden.guardLink(node, {any_link}) }});"#,
            any_link = modifiers == CTRL,
        ),
    )
    .await
    .is_ok_and(|armed| armed["guarded"].as_bool() == Some(true))
}

/// After the key or click the page's handlers saw: a link they left alone opens
/// here, and its window stays as it is. Answers whether a tab is on its way,
/// which it is not for a page that took the click itself. A guard that saw no
/// click leaves that as it was: the page moved on, or a handler kept the click
/// from the guard and the browser opened the tab.
pub(super) async fn open_held_link(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    ref_id: &str,
) -> Result<bool, (String, String)> {
    let held = run(
        webview,
        target,
        ref_id,
        r#"
        const guard = window.__anboHeldLink;
        delete window.__anboHeldLink;
        if (!guard) return JSON.stringify({ ok: true });
        guard.disarm();
        return JSON.stringify(Object.assign({ ok: true }, guard.held));"#,
    )
    .await
    .unwrap_or_default();
    let Some(url) = held["url"].as_str() else {
        return Ok(held["pageTookIt"].as_bool() != Some(true));
    };
    let Webview::External { target: tab, .. } = webview else {
        return Ok(false);
    };
    match tab
        .call("anbo.openLink", json!({ "url": url }), OPEN_LINK_PATIENCE)
        .await
    {
        Ok(_) => Ok(true),
        // An extension from before 0.5.14: the browser's own way, now that
        // nothing holds the link back. Anbo has it reload soon after.
        Err(error) if error.contains("Unsupported browser command") => {
            press(webview, "Enter", CTRL).await?;
            Ok(true)
        }
        Err(error) => Err((
            error_codes::CDP_FAILED.to_string(),
            format!("the page took the click, but its link did not open: {error}"),
        )),
    }
}

/// Sets a checkbox or radio: Space on it when it takes focus, else its own
/// click; the state is read back either way.
pub(super) async fn check(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    requested: bool,
    why: &str,
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
        let mut result = answer(tab_id, ref_id, "none", why);
        result["checked"] = json!(requested);
        result["changed"] = json!(false);
        if let Some(object) = result.as_object_mut() {
            object.remove("note");
        }
        return Ok(result);
    }
    if input == "keyboard" {
        press(webview, " ", 0).await?;
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
    let mut result = answer(tab_id, ref_id, &input, why);
    result["checked"] = json!(checked?);
    result["changed"] = json!(true);
    Ok(result)
}

pub(super) async fn focus(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    why: &str,
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
        "note": focus_note(why),
    }))
}

pub(super) async fn hover(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    ref_id: &str,
    position: Option<(f64, f64)>,
    why: &str,
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
    Ok(answer(tab_id, ref_id, "dom-events", why))
}

/// A drag from one element to another, or within one, in the same document:
/// HTML drag and drop events for a draggable source, otherwise a press, moves
/// over whatever lies on the way, and a release.
#[allow(clippy::too_many_arguments)] // One call site; splitting it would only hide the wiring.
pub(super) async fn drag(
    webview: &Webview,
    target: Option<&RefFrameTarget>,
    tab_id: i64,
    source_ref: &str,
    target_ref: &str,
    source_position: Option<(f64, f64)>,
    target_position: Option<(f64, f64)>,
    why: &str,
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
    let mut result = answer(tab_id, source_ref, "dom-events", why);
    result["targetRef"] = json!(target_ref);
    result["dragKind"] = dragged["kind"].clone();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_note_says_why_the_page_stayed_hidden() {
        let why = "Anbo is not the window the user is in";
        for input in ["keyboard", "dom-events", "none"] {
            let note = answer(7, "g1-e1", input, why)["note"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            assert!(note.starts_with(&format!("the page is hidden in its browser ({why}), so ")));
        }
        assert!(focus_note(why).contains(&format!("({why});")));
        assert!(link_note(why).contains(&format!("({why}), so Anbo activated the link")));
        assert!(!keyboard_note(why).contains("workspace"));
    }
}

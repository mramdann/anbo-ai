//! A tab a page in Anbo's own browser opens (a `target=_blank` link,
//! `window.open`, a Ctrl or middle click) opens as an Anbo tab right after its
//! opener. WebView2 does not say how the page asked for it, so each page keeps
//! its last trusted left or middle click, with the modifier keys held, in
//! Anbo's own world of the page, which the page cannot see or change, and Anbo
//! reads it when the page asks for the tab. The user's own plain click shows
//! the new tab at once, as a browser does; a Ctrl or middle click, an agent's
//! input, or a page's script with no click leaves it behind. Only the main
//! frame keeps its clicks: a tab a frame inside the page opens stays behind.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// A click this recent opened the tab.
const CLICK_FRESH_MS: u64 = 1_000;
/// A tab opened this soon after Anbo sent the page input came from an agent's
/// click or key, as the Chrome/Edge extension counts it.
const AGENT_INPUT: Duration = Duration::from_millis(2_000);
/// Kept in Anbo's world of the page (`ref_context`), run once per document.
#[cfg(windows)]
const RECORDER_JS: &str = r#"(() => {
  if (globalThis.__anboNewTab) return true;
  const last = { at: 0, click: "" };
  globalThis.__anboNewTab = last;
  const note = (event) => {
    if (!event.isTrusted || event.button !== (event.type === "click" ? 0 : 1)) return;
    last.at = Date.now();
    last.click = `${event.button}${event.ctrlKey ? "c" : ""}${event.metaKey ? "m" : ""}${event.shiftKey ? "s" : ""}`;
  };
  addEventListener("click", note, true);
  addEventListener("auxclick", note, true);
  return true;
})()"#;
#[cfg(windows)]
const READ_JS: &str = r#"(() => { const last = globalThis.__anboNewTab; return last && last.at ? { age: Date.now() - last.at, click: last.click } : null; })()"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Click {
    button: u8,
    ctrl: bool,
    meta: bool,
    shift: bool,
}

/// When Anbo last sent each embedded tab's page input for an agent.
static AGENT_INPUT_AT: LazyLock<Mutex<HashMap<i64, Instant>>> = LazyLock::new(Default::default);

fn tab_of(label: &str) -> Option<i64> {
    label.strip_prefix("browser-embed-")?.parse().ok()
}

/// Anbo sent an embedded tab's page input for an agent (`Input.*`).
pub fn note_agent_input(label: &str) {
    let Some(tab_id) = tab_of(label) else {
        return;
    };
    if let Ok(mut seen) = AGENT_INPUT_AT.lock() {
        seen.insert(tab_id, Instant::now());
    }
}

fn agent_recently(tab_id: i64) -> bool {
    AGENT_INPUT_AT
        .lock()
        .ok()
        .and_then(|seen| seen.get(&tab_id).copied())
        .is_some_and(|at| at.elapsed() <= AGENT_INPUT)
}

/// The page's record: the button, then `c`, `m` and `s` for Ctrl, Meta and
/// Shift held.
fn parse_click(record: &str) -> Option<Click> {
    let mut chars = record.chars();
    let button = match chars.next()? {
        '0' => 0,
        '1' => 1,
        _ => return None,
    };
    let mut click = Click {
        button,
        ctrl: false,
        meta: false,
        shift: false,
    };
    for flag in chars {
        match flag {
            'c' if !click.ctrl => click.ctrl = true,
            'm' if !click.meta => click.meta = true,
            's' if !click.shift => click.shift = true,
            _ => return None,
        }
    }
    Some(click)
}

/// The page's last click from what `READ_JS` answered: how long ago, and how.
#[cfg_attr(not(windows), allow(dead_code))]
fn read_click(answer: &str) -> Option<(u64, Click)> {
    let value: serde_json::Value = serde_json::from_str(answer).ok()?;
    Some((
        value["age"].as_u64()?,
        parse_click(value["click"].as_str()?)?,
    ))
}

/// Whether the new tab opens behind its opener, from the page's last click and
/// whether an agent's input came just before.
fn behind(click: Option<(u64, Click)>, agent: bool) -> bool {
    if agent {
        return true;
    }
    match click {
        // As in a browser: Ctrl or Meta, or the middle button, opens it behind;
        // Shift with them brings it to the front.
        Some((age, click)) if age <= CLICK_FRESH_MS => {
            (click.ctrl || click.meta || click.button == 1) && !click.shift
        }
        // No click opened it: a page's own script.
        _ => true,
    }
}

/// Starts keeping a page's clicks once its document has loaded.
pub fn prepare(webview: tauri::Webview) {
    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        use crate::modules::browser_automation::{cdp, ref_context};
        let target = webview.into();
        let Ok(context) = ref_context::main_context(&target).await else {
            return;
        };
        // No user gesture: the page must not gain one from Anbo.
        let _ = cdp::call_devtools_protocol_method(
            &target,
            "Runtime.evaluate",
            &serde_json::json!({ "expression": RECORDER_JS, "contextId": context, "returnByValue": true })
                .to_string(),
            Duration::from_secs(2),
        )
        .await;
    });
    #[cfg(not(windows))]
    let _ = webview;
}

/// Whether a tab the page of `tab_id` just asked for opens behind it.
pub async fn opens_behind(app: &tauri::AppHandle, tab_id: i64) -> bool {
    if agent_recently(tab_id) {
        return true;
    }
    #[cfg(windows)]
    {
        use crate::modules::browser_automation::{cdp, ref_context};
        use tauri::Manager;
        let Some(webview) = app.get_webview(&format!("browser-embed-{tab_id}")) else {
            return true;
        };
        let target = webview.into();
        let Ok(context) = ref_context::main_context(&target).await else {
            return true;
        };
        let answer = cdp::call_devtools_protocol_method(
            &target,
            "Runtime.evaluate",
            &serde_json::json!({ "expression": READ_JS, "contextId": context, "returnByValue": true })
                .to_string(),
            Duration::from_millis(500),
        )
        .await;
        let click = answer.ok().and_then(|raw| {
            let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
            read_click(&value["result"].get("value")?.to_string())
        });
        behind(click, false)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        true
    }
}

/// Forgets a closed tab.
pub fn remove(tab_id: i64) {
    if let Ok(mut seen) = AGENT_INPUT_AT.lock() {
        seen.remove(&tab_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: Click = Click {
        button: 0,
        ctrl: false,
        meta: false,
        shift: false,
    };

    #[test]
    fn the_page_keeps_its_button_and_keys_in_a_few_letters() {
        assert_eq!(parse_click("0"), Some(PLAIN));
        assert_eq!(
            parse_click("0cs"),
            Some(Click {
                ctrl: true,
                shift: true,
                ..PLAIN
            })
        );
        assert_eq!(
            parse_click("1m"),
            Some(Click {
                button: 1,
                meta: true,
                ..PLAIN
            })
        );
        for wrong in ["", "2", "0x", "0cc", "c0", "00"] {
            assert_eq!(parse_click(wrong), None, "{wrong:?}");
        }
        assert_eq!(
            read_click(r#"{"age":40,"click":"1"}"#),
            Some((40, Click { button: 1, ..PLAIN }))
        );
        for wrong in [
            "null",
            r#"{"age":-1,"click":"0"}"#,
            r#"{"age":5,"click":"9"}"#,
            "{}",
        ] {
            assert_eq!(read_click(wrong), None, "{wrong:?}");
        }
    }

    #[test]
    fn only_the_users_own_plain_click_brings_the_new_tab_to_the_front() {
        let now = 30;
        assert!(!behind(Some((now, PLAIN)), false));
        for click in [
            Click {
                ctrl: true,
                ..PLAIN
            },
            Click {
                meta: true,
                ..PLAIN
            },
            Click { button: 1, ..PLAIN },
        ] {
            assert!(behind(Some((now, click)), false), "{click:?}");
            // Shift with them brings it to the front, as in a browser.
            assert!(!behind(
                Some((
                    now,
                    Click {
                        shift: true,
                        ..click
                    }
                )),
                false
            ));
        }
        // An agent's input right before, even with a plain click.
        assert!(behind(Some((now, PLAIN)), true));
        // A page's own script, long after any click.
        assert!(behind(None, false));
        assert!(behind(Some((2_000, PLAIN)), false));
    }

    #[test]
    fn an_agents_input_counts_for_two_seconds_and_goes_with_its_tab() {
        note_agent_input("browser-embed--7");
        assert!(agent_recently(-7));
        note_agent_input("main");
        remove(-7);
        assert!(!agent_recently(-7));
    }
}

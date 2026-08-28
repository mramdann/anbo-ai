//! MCP metadata for the in-app HTTP browser automation server: the canonical
//! tool list (one entry per `handle_action` method) and tool-name → method map.
//! The legacy standalone stdio binary remains intentionally decoupled.

use serde_json::{json, Value};

macro_rules! tool_array {
    ($($tool:tt),* $(,)?) => {
        Value::Array(vec![$(json!($tool)),*])
    };
}

/// MCP protocol version this server speaks (Streamable HTTP spec baseline).
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Server name reported in `initialize`.
pub const SERVER_NAME: &str = "anbo";

fn tab_id_prop() -> Value {
    json!({ "type": "integer", "description": "Active native browser tab id (from browser_tabs)." })
}
fn ref_prop() -> Value {
    json!({ "type": "string", "description": "Generation-scoped element ref from the latest snapshot, e.g. \"g3-e12\". A newer snapshot invalidates every older ref." })
}

fn workspace_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id. UI focus is never used as a fallback." })
}

fn file_workspace_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Required absolute workspace root. Upload sources and download destinations are confined to this tab's workspace." })
}

fn agent_id_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Workspace-scoped agent id returned by agent_list." })
}

fn terminal_id_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Workspace-scoped shared terminal id returned by terminal_open or terminal_list, such as terminal:12:12." })
}

/// The `tools` array returned by `tools/list`, grouped by capability prefix.
pub fn tool_definitions() -> Value {
    let tab = tab_id_prop();
    let refr = ref_prop();
    let workspace = workspace_prop();
    let file_workspace = file_workspace_prop();
    let agent_id = agent_id_prop();
    let terminal_id = terminal_id_prop();
    tool_array![
        { "name": "browser_open", "description": "Open a native browser tab without focusing it in an explicitly selected Anbo workspace. Pass the agent's workspace root or a space id; UI focus is never used as a fallback.", "inputSchema": { "type": "object", "properties": { "url": { "type": "string" }, "workspace": { "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id for agent isolation." } }, "required": ["url", "workspace"] } },
        { "name": "browser_close", "description": "Close a native browser tab in an explicitly selected Anbo workspace.", "annotations": { "destructiveHint": true, "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "workspace": { "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id for agent isolation." } }, "required": ["tabId", "workspace"] } },
        { "name": "browser_tabs", "description": "List active native browser tabs with foreground, workspace, space, loading, pendingUrl, automation-target, automation-activity, and durationMs metadata. While loading, url remains the last committed URL and pendingUrl identifies the target when known.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "browser_get_url", "description": "Get the current URL of a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_navigate", "description": "Start navigating a browser tab to an http(s) URL and return immediately. Use browser_wait or browser_tabs to observe completion; browser_stop can interrupt the active load.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "url": { "type": "string" } }, "required": ["tabId", "url"] } },
        { "name": "browser_reload", "description": "Start reloading a browser tab and return immediately. Use browser_wait or browser_tabs to observe completion.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_back", "description": "Start navigating a browser tab back in history and return immediately.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_forward", "description": "Start navigating a browser tab forward in history and return immediately.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_stop", "description": "Stop a browser tab's page load.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_snapshot", "description": "Get a token-bounded accessibility snapshot with viewport text and generation-scoped element refs. Output defaults to 8000 characters and never exceeds 16000; scroll and snapshot again for nearby content. Use only refs from the latest snapshot.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "maxChars": { "type": "integer", "minimum": 2000, "maximum": 16000, "default": 8000 } }, "required": ["tabId"] } },
        { "name": "browser_find", "description": "Find current page elements with a semantic locator and return fresh generation-scoped refs. Supports role, text, label, placeholder, testId, title, alt, and CSS across open Shadow DOM and child frames. For role locators, name is the computed accessible name, so aria-label, aria-labelledby, associated labels, alt, or title can take precedence over visible text.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "by": { "type": "string", "enum": ["role", "text", "label", "placeholder", "testId", "title", "alt", "css"] }, "value": { "type": "string", "minLength": 1, "maxLength": 4096 }, "name": { "type": "string", "minLength": 1, "maxLength": 4096, "description": "Optional computed accessible-name filter for a role locator. It may come from aria-label, aria-labelledby, an associated label, alt, title, or visible text." }, "exact": { "type": "boolean", "default": false }, "includeHidden": { "type": "boolean", "default": false }, "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 5000 } }, "required": ["tabId", "by", "value"] } },
        { "name": "browser_click", "description": "Click an element by ref after bounded visibility, stability, enabled, and hit-target checks.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_double_click", "description": "Double-click an actionable element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_focus", "description": "Focus a visible enabled element by ref without activating the user's workspace.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_check", "description": "Set a checkbox or radio ref to the requested checked state and verify the result.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "checked": { "type": "boolean", "default": true } }, "required": ["tabId", "ref"] } },
        { "name": "browser_drag", "description": "Drag one actionable ref onto another ref in the same document or frame.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "sourceRef": refr.clone(), "targetRef": refr.clone() }, "required": ["tabId", "sourceRef", "targetRef"] } },
        { "name": "browser_type", "description": "Type text into an input element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "text": { "type": "string" }, "append": { "type": "boolean", "description": "Append to existing value instead of replacing it." } }, "required": ["tabId", "ref", "text"] } },
        { "name": "browser_press", "description": "Press a keyboard key through the browser input pipeline (e.g. Enter, Tab). Key dispatch holds the tab lock, but Enter observation does not, so stop and navigation remain responsive. submissionObserved and navigationObserved report only effects seen within the bounded observation window; false does not mean dispatch failed.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "key": { "type": "string" }, "observationTimeout": { "type": "integer", "minimum": 0, "maximum": 10000, "default": 3000, "description": "Milliseconds to observe submit or navigation after Enter without holding the tab lock. Ignored for other keys." } }, "required": ["tabId", "key"] } },
        { "name": "browser_key", "description": "Dispatch a keyboard press, key-down, or key-up with optional Alt, Control, Meta, and Shift modifiers.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "key": { "type": "string", "minLength": 1, "maxLength": 64 }, "keyAction": { "type": "string", "enum": ["press", "down", "up"], "default": "press" }, "modifiers": { "type": "array", "maxItems": 4, "uniqueItems": true, "items": { "type": "string", "enum": ["Alt", "Control", "Meta", "Shift"] } } }, "required": ["tabId", "key"] } },
        { "name": "browser_scroll", "description": "Scroll the page by x/y pixels.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["tabId"] } },
        { "name": "browser_wait", "description": "Wait for text, URL, document load state, or a ref state. Backward-compatible text-only calls remain supported.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "condition": { "type": "string", "enum": ["text", "url", "load", "ref"] }, "text": { "type": "string" }, "url": { "type": "string", "description": "Exact URL or a glob containing * wildcards." }, "ref": refr.clone(), "state": { "type": "string", "enum": ["attached", "detached", "visible", "hidden", "enabled", "disabled", "checked", "unchecked"] }, "loadState": { "type": "string", "enum": ["interactive", "complete", "networkIdle"], "default": "complete" }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "description": "Timeout in milliseconds (default 10000, maximum 60000)." } }, "required": ["tabId"] } },
        { "name": "browser_dialog", "description": "Click a ref that opens a JavaScript alert, confirm, or prompt, then accept or dismiss it without leaving a blocking native dialog open.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "dialogAction": { "type": "string", "enum": ["accept", "dismiss"] }, "promptText": { "type": "string", "maxLength": 4096 } }, "required": ["tabId", "ref", "dialogAction"] } },
        { "name": "browser_screenshot", "description": "Capture a PNG screenshot of a browser tab to a disk artifact.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "workspace": { "type": "string", "description": "Optional workspace root; screenshot lands under <workspace>/.anbo/artifacts." } }, "required": ["tabId"] } },
        { "name": "browser_upload", "description": "Attach one or more workspace files to an <input type=file> ref without opening a native file chooser. Hidden file inputs and refs in open Shadow DOM or child frames are supported. This selects files only; use a separate click/press to submit the form.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "workspace": file_workspace.clone(), "paths": { "type": "array", "minItems": 1, "maxItems": 16, "items": { "type": "string", "minLength": 1 }, "description": "Absolute paths inside the workspace, or paths relative to the workspace root." } }, "required": ["tabId", "ref", "workspace", "paths"] } },
        { "name": "browser_download", "description": "Arm a workspace-scoped native download and click a ref. Returns a downloadId once the download starts; completed files land under <workspace>/.anbo/downloads. Use browser_download_wait for large files.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "workspace": file_workspace.clone(), "fileName": { "type": "string", "minLength": 1, "maxLength": 255, "description": "Optional safe destination file name. Existing files are never overwritten." }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000, "description": "How long to wait for the page to start the download." } }, "required": ["tabId", "ref", "workspace"] } },
        { "name": "browser_download_status", "description": "Read the current state and verified destination of a workspace-scoped browser download.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "downloadId": { "type": "string", "minLength": 1, "maxLength": 128 }, "workspace": file_workspace.clone() }, "required": ["downloadId", "workspace"] } },
        { "name": "browser_download_wait", "description": "Wait for a browser download to change state or finish. Normal timeout returns timedOut:true so large downloads can be polled without losing their downloadId.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "downloadId": { "type": "string", "minLength": 1, "maxLength": 128 }, "workspace": file_workspace, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 30000 } }, "required": ["downloadId", "workspace"] } },
        { "name": "browser_select_option", "description": "Select an option on a <select> element by ref (by value or label).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "value": { "type": "string" } }, "required": ["tabId", "ref", "value"] } },
        { "name": "browser_hover", "description": "Hover an actionable element by ref. Main-document targets use a real DevTools mouse move, verify the CSS :hover pseudo-state, and also dispatch DOM compatibility events.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_scroll_to_element", "description": "Scroll an element into view by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_get_text", "description": "Get DOM text or the accessibility name of an element, or body text when ref is omitted.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "maxLength": { "type": "integer", "minimum": 1, "maximum": 16000, "default": 8000 } }, "required": ["tabId"] } },
        { "name": "browser_page_info", "description": "Get the title and URL of a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_console_logs", "description": "Get up to 50 bounded recent console messages, uncaught runtime errors, and unhandled promise rejections from the main document and accessible child frames.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "agent_spawn", "description": "Spawn one configured built-in or custom CLI agent in an explicitly selected open Anbo workspace. Creates a background terminal tab without activating its workspace or changing UI focus. The stored command cannot be supplied or overridden by the caller.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agent": { "type": "string", "minLength": 1, "maxLength": 71, "description": "Built-in launcher id or label, or the display name or custom:<id> of an agent registered in Anbo Settings." }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 15000, "description": "How long to wait for live agent detection before returning pending: true." } }, "required": ["workspace", "agent"] } },
        { "name": "agent_list", "description": "List live non-private terminal agents in an explicitly selected Anbo workspace. Does not activate the workspace or move UI focus.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone() }, "required": ["workspace"] } },
        { "name": "agent_status", "description": "Get the callsign, CLI type, working or waiting state, tab, space, workspace, and discovered resume session for one live agent. Agent ids are readable and workspace-scoped, such as lucian-claude:14 or claude:14.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone() }, "required": ["workspace", "agentId"] } },
        { "name": "agent_read", "description": "Read a redacted, bounded increment of an agent terminal. Reuse the returned opaque cursor to receive only newer output; reset indicates that terminal history changed or the cursor expired.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone(), "cursor": { "type": "string", "description": "Opaque cursor returned by an earlier agent_read call." }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "agentId"] } },
        { "name": "agent_send", "description": "Send one bounded instruction to a live agent without activating its workspace. By default waits until the agent is ready, serializes concurrent sends, and rejects duplicate message ids. Set waitForReady to false to deliver immediately even while the reported state is working.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone(), "message": { "type": "string", "minLength": 1, "maxLength": 8000 }, "waitForReady": { "type": "boolean", "default": true }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 30000 }, "sourceAgentId": { "type": "string", "description": "Optional sender agent id. Sending to the same id is rejected." }, "messageId": { "type": "string", "maxLength": 128, "description": "Optional idempotency key scoped to the target agent." } }, "required": ["workspace", "agentId", "message"] } },
        { "name": "agent_wait", "description": "Wait for an agent to become working, waiting for input, or finished, or for its state to change when status is omitted. A normal timeout is returned as timedOut rather than a tool error.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id, "status": { "type": "string", "enum": ["working", "waiting", "finished"] }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000 } }, "required": ["workspace", "agentId"] } },
        { "name": "terminal_open", "description": "Open a normal shared Anbo terminal in an explicitly selected workspace without changing UI focus. A short purpose-specific tab title is required, such as Dev Server, Tests, or Build. The returned terminalId can be used after the shell becomes idle. Agent CLI and private terminals are never created by this tool.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "title": { "type": "string", "minLength": 1, "maxLength": 64, "description": "Required purpose-specific tab title." } }, "required": ["workspace", "title"] } },
        { "name": "terminal_close", "description": "Close an idle normal terminal previously created by terminal_open during the current Anbo application session. Refuses user-created terminals, agent CLI terminals, pending input, and foreground processes.", "annotations": { "readOnlyHint": false, "destructiveHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone() }, "required": ["workspace", "terminalId"] } },
        { "name": "terminal_list", "description": "List normal non-private Anbo shell terminals in an explicitly selected workspace. Agent CLI terminals are excluded. Does not activate the workspace or move UI focus.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone() }, "required": ["workspace"] } },
        { "name": "terminal_read", "description": "Read a redacted bounded increment from a shared normal terminal. Reuse the returned cursor to receive only newer output. hasMore reports unread output after this response; historyTruncated reports omitted older history; reset and replayed identify a terminal buffer repaint. Private and agent CLI terminals are never available.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "cursor": { "type": "string", "description": "Opaque cursor returned by an earlier terminal_read call." }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "terminalId"] } },
        { "name": "terminal_insert", "description": "Insert one bounded single-line string into an explicitly selected idle normal terminal without pressing Enter or changing UI focus. Waits briefly for visible terminal echo and returns inputVisible plus a cursor for terminal_read polling.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "text": { "type": "string", "minLength": 1, "maxLength": 8000 } }, "required": ["workspace", "terminalId", "text"] } },
        { "name": "terminal_execute", "description": "Queue one bounded single-line command for visible cancellable dispatch in an explicitly selected idle normal terminal. Returns an executionId in phase queued; call terminal_wait for the stable final result. Rejects private terminals, agent CLI terminals, foreground processes, and prompts containing unsubmitted input.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "text": { "type": "string", "minLength": 1, "maxLength": 8000 } }, "required": ["workspace", "terminalId", "text"] } },
        { "name": "terminal_wait", "description": "Wait for a command started by terminal_execute without holding the terminal lock. Returns stable phase, completionReason, interrupted, per-execution exitCode, and redacted bounded output. Completed results are idempotent.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "executionId": { "type": "string", "minLength": 1, "maxLength": 128 }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000 }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "terminalId", "executionId"] } },
        { "name": "terminal_interrupt", "description": "Cancel a specific queued, dispatched, or running execution by executionId. When executionId is omitted, send Ctrl+C to the terminal foreground command or safely clear unsubmitted prompt input.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace, "terminalId": terminal_id, "executionId": { "type": "string", "minLength": 1, "maxLength": 128 } }, "required": ["workspace", "terminalId"] } }
    ]
}

/// Map an MCP tool name to the `handle_action` method it dispatches to.
pub fn tool_name_to_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "browser_open" => "open",
        "browser_close" => "close",
        "browser_tabs" => "list_tabs",
        "browser_get_url" => "get_url",
        "browser_navigate" => "navigate",
        "browser_reload" => "reload",
        "browser_back" => "back",
        "browser_forward" => "forward",
        "browser_stop" => "stop",
        "browser_snapshot" => "snapshot",
        "browser_find" => "find",
        "browser_click" => "click",
        "browser_double_click" => "double_click",
        "browser_focus" => "focus",
        "browser_check" => "check",
        "browser_drag" => "drag",
        "browser_type" => "type_text",
        "browser_press" => "press_key",
        "browser_key" => "key",
        "browser_scroll" => "scroll",
        "browser_wait" => "wait",
        "browser_dialog" => "dialog",
        "browser_screenshot" => "screenshot",
        "browser_upload" => "upload_files",
        "browser_download" => "download",
        "browser_download_status" => "download_status",
        "browser_download_wait" => "download_wait",
        "browser_select_option" => "select_option",
        "browser_hover" => "hover",
        "browser_scroll_to_element" => "scroll_to_element",
        "browser_get_text" => "get_text",
        "browser_page_info" => "get_page_info",
        "browser_console_logs" => "console_logs",
        "agent_spawn" => "agent_spawn",
        "agent_list" => "agent_list",
        "agent_status" => "agent_status",
        "agent_read" => "agent_read",
        "agent_send" => "agent_send",
        "agent_wait" => "agent_wait",
        "terminal_open" => "terminal_open",
        "terminal_close" => "terminal_close",
        "terminal_list" => "terminal_list",
        "terminal_read" => "terminal_read",
        "terminal_insert" => "terminal_insert",
        "terminal_execute" => "terminal_execute",
        "terminal_wait" => "terminal_wait",
        "terminal_interrupt" => "terminal_interrupt",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_have_capability_prefixes_and_unique_names() {
        let tools = tool_definitions().as_array().unwrap().clone();
        assert_eq!(tools.len(), 47);
        let mut names = std::collections::HashSet::new();
        for t in &tools {
            let n = t.get("name").and_then(|v| v.as_str()).unwrap();
            assert!(
                n.starts_with("browser_") || n.starts_with("agent_") || n.starts_with("terminal_"),
                "{n} missing capability prefix"
            );
            assert!(names.insert(n), "duplicate tool name {n}");
            assert!(
                tool_name_to_method(n).is_some(),
                "no method mapping for {n}"
            );
        }
    }

    #[test]
    fn unknown_tool_maps_to_none() {
        assert!(tool_name_to_method("browser_nope").is_none());
        assert!(tool_name_to_method("navigate").is_none());
    }

    #[test]
    fn shared_terminal_tools_are_workspace_scoped() {
        let tools = tool_definitions();
        for (name, method) in [
            ("terminal_open", "terminal_open"),
            ("terminal_close", "terminal_close"),
            ("terminal_list", "terminal_list"),
            ("terminal_read", "terminal_read"),
            ("terminal_insert", "terminal_insert"),
            ("terminal_execute", "terminal_execute"),
            ("terminal_wait", "terminal_wait"),
            ("terminal_interrupt", "terminal_interrupt"),
        ] {
            let tool = tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            assert!(tool["inputSchema"]["required"]
                .as_array()
                .is_some_and(|required| required.contains(&json!("workspace"))));
            assert_eq!(tool_name_to_method(name), Some(method));
        }
    }

    #[test]
    fn browser_close_requires_tab_and_workspace() {
        let tools = tool_definitions();
        let close = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_close")
            .unwrap();
        assert_eq!(
            close["inputSchema"]["required"],
            json!(["tabId", "workspace"])
        );
        assert_eq!(close["annotations"]["destructiveHint"], true);
        assert_eq!(tool_name_to_method("browser_close"), Some("close"));
    }

    #[test]
    fn browser_file_tools_are_workspace_scoped() {
        let tools = tool_definitions();
        for name in [
            "browser_upload",
            "browser_download",
            "browser_download_status",
            "browser_download_wait",
        ] {
            let tool = tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            assert!(tool["inputSchema"]["required"]
                .as_array()
                .is_some_and(|required| required.contains(&json!("workspace"))));
        }
        assert_eq!(tool_name_to_method("browser_upload"), Some("upload_files"));
        assert_eq!(tool_name_to_method("browser_download"), Some("download"));
    }

    #[test]
    fn p0_browser_tools_have_public_contracts_and_dispatch_mappings() {
        let tools = tool_definitions();
        for (name, method) in [
            ("browser_find", "find"),
            ("browser_double_click", "double_click"),
            ("browser_focus", "focus"),
            ("browser_check", "check"),
            ("browser_drag", "drag"),
            ("browser_key", "key"),
            ("browser_dialog", "dialog"),
        ] {
            assert!(tools
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name));
            assert_eq!(tool_name_to_method(name), Some(method));
        }
        let find = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_find")
            .unwrap();
        assert_eq!(find["inputSchema"]["properties"]["limit"]["maximum"], 20);
        assert_eq!(
            find["inputSchema"]["properties"]["name"]["description"],
            "Optional computed accessible-name filter for a role locator. It may come from aria-label, aria-labelledby, an associated label, alt, title, or visible text."
        );
        let press = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_press")
            .unwrap();
        assert_eq!(
            press["inputSchema"]["properties"]["observationTimeout"]["default"],
            3_000
        );
        assert_eq!(
            press["inputSchema"]["properties"]["observationTimeout"]["maximum"],
            10_000
        );
    }

    #[test]
    fn agent_tools_require_explicit_workspace_and_use_agent_prefix() {
        let tools = tool_definitions();
        let agent_tools = tools
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.starts_with("agent_"))
            })
            .collect::<Vec<_>>();
        assert_eq!(agent_tools.len(), 6);
        for tool in agent_tools {
            assert!(tool["inputSchema"]["required"]
                .as_array()
                .is_some_and(|required| required.contains(&json!("workspace"))));
        }
    }
}

//! MCP metadata for the in-app HTTP browser automation server: the canonical
//! tool list (one entry per `handle_action` method) and tool-name → method map.
//! The legacy standalone stdio binary remains intentionally decoupled.

use serde_json::{json, Value};

/// MCP protocol version this server speaks (Streamable HTTP spec baseline).
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Server name reported in `initialize`.
pub const SERVER_NAME: &str = "anbo-browser";

fn tab_id_prop() -> Value {
    json!({ "type": "integer", "description": "Active native browser tab id (from browser_tabs)." })
}
fn ref_prop() -> Value {
    json!({ "type": "string", "description": "Stable element ref from a snapshot, e.g. \"e12\"." })
}

/// The `tools` array returned by `tools/list`. One tool per `handle_action`
/// method, named with a `browser_` prefix.
pub fn tool_definitions() -> Value {
    let tab = tab_id_prop();
    let refr = ref_prop();
    json!([
        { "name": "browser_tabs", "description": "List active native browser tabs in Anbo.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "browser_get_url", "description": "Get the current URL of a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_navigate", "description": "Navigate a browser tab to an http(s) URL.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "url": { "type": "string" } }, "required": ["tabId", "url"] } },
        { "name": "browser_reload", "description": "Reload a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_back", "description": "Navigate a browser tab back in history.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_forward", "description": "Navigate a browser tab forward in history.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_stop", "description": "Stop a browser tab's page load.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_snapshot", "description": "Get an accessibility text snapshot of a tab with stable element refs (e1, e2, ...).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_click", "description": "Click an element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_type", "description": "Type text into an input element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "text": { "type": "string" }, "append": { "type": "boolean", "description": "Append to existing value instead of replacing it." } }, "required": ["tabId", "ref", "text"] } },
        { "name": "browser_press", "description": "Press a keyboard key (e.g. Enter, Tab).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "key": { "type": "string" } }, "required": ["tabId", "key"] } },
        { "name": "browser_scroll", "description": "Scroll the page by x/y pixels.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["tabId"] } },
        { "name": "browser_wait", "description": "Wait until text content appears on the page.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "text": { "type": "string" }, "timeout": { "type": "integer", "description": "Timeout in milliseconds (default 10000)." } }, "required": ["tabId", "text"] } },
        { "name": "browser_screenshot", "description": "Capture a screenshot of a browser tab to a disk artifact.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "workspace": { "type": "string", "description": "Optional workspace root; screenshot lands under <workspace>/.anbo/artifacts." } }, "required": ["tabId"] } },
        { "name": "browser_select_option", "description": "Select an option on a <select> element by ref (by value or label).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "value": { "type": "string" } }, "required": ["tabId", "ref", "value"] } },
        { "name": "browser_hover", "description": "Hover an element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_scroll_to_element", "description": "Scroll an element into view by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_get_text", "description": "Get text content of an element (or the whole page body when ref is omitted).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "maxLength": { "type": "integer", "description": "Max chars to return (default 8000)." } }, "required": ["tabId"] } },
        { "name": "browser_page_info", "description": "Get the title and URL of a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_console_logs", "description": "Get captured console logs for a browser tab.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } }
    ])
}

/// Map an MCP tool name to the `handle_action` method it dispatches to.
pub fn tool_name_to_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "browser_tabs" => "list_tabs",
        "browser_get_url" => "get_url",
        "browser_navigate" => "navigate",
        "browser_reload" => "reload",
        "browser_back" => "back",
        "browser_forward" => "forward",
        "browser_stop" => "stop",
        "browser_snapshot" => "snapshot",
        "browser_click" => "click",
        "browser_type" => "type_text",
        "browser_press" => "press_key",
        "browser_scroll" => "scroll",
        "browser_wait" => "wait",
        "browser_screenshot" => "screenshot",
        "browser_select_option" => "select_option",
        "browser_hover" => "hover",
        "browser_scroll_to_element" => "scroll_to_element",
        "browser_get_text" => "get_text",
        "browser_page_info" => "get_page_info",
        "browser_console_logs" => "console_logs",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_have_browser_prefix_and_unique_names() {
        let tools = tool_definitions().as_array().unwrap().clone();
        assert_eq!(tools.len(), 20);
        let mut names = std::collections::HashSet::new();
        for t in &tools {
            let n = t.get("name").and_then(|v| v.as_str()).unwrap();
            assert!(n.starts_with("browser_"), "{n} missing prefix");
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
}

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

/// What every MCP client shows its model the moment it connects.
///
/// Kept here rather than in the transport so both the HTTP and the pipe path
/// say the same thing. The browser sentence is load-bearing: a CLI that has its
/// own web search will reach for that instead unless it is told what this
/// browser is. Measured with a plain request to open and explore three pages --
/// Claude and OpenCode used these tools, Codex answered from its own web search
/// and Antigravity from memory, and neither ever read the skill. Nothing here
/// describes a tool; it says what the tools are for, which is the part a model
/// weighs when it decides whether to bother.
pub const SERVER_INSTRUCTIONS: &str = concat!(
    "You are working inside Anbo, which is providing these tools. ",
    "The browser_ tools drive a real browser the user is watching in this app: ",
    "pages open as tabs on their screen, and your cursor and clicks are visible ",
    "to them as you work. When a task involves opening, reading, or interacting ",
    "with a web page, use these tools rather than fetching or searching the web ",
    "yourself. A page you read privately is not on the user's screen, cannot be ",
    "scrolled or clicked, and cannot be handed back to them. ",
    "The usual shape of a browser task: browser_open with your own workspace ",
    "root, browser_find (role plus accessible name, or css) or browser_snapshot ",
    "for a ref, one action with a waitFor describing the result you expect (every ",
    "action reply carries page.url and page.title, so no separate URL read), a ",
    "read of that result with browser_get_text or browser_get_property (live ",
    "state such as paused, currentTime, value, checked), then endSession: true ",
    "on your last call: browser_close if you close the tab, or that final read ",
    "if the page stays open for the user. ",
    "Tools that take a workspace argument need your own workspace root, ",
    "never the one currently on screen. ",
    "For files, downloads, dialogs, terminals or other agents, call skills_list ",
    "with your workspace root: it lists this project's own procedures and Anbo's ",
    "built-in skill, which skills_read returns section by section."
);

pub const BROWSER_SESSION_INSTRUCTIONS: &str = "Browser work runs in a session that names you as the tab's controller. The first browser tool you call opens it, and every browser result carries its controlId; there is nothing to start. When the task is finished or handed back to the user, put endSession: true on your last call: browser_close if you close the tab, or the final read (browser_get_text, browser_get_property, browser_screenshot, browser_snapshot), click, press, key or wait if the page stays open. The cursor and tab badge go at once, tabs and the MCP connection stay. Not between steps and not per tab. A session left alone is drawn as idle after a minute and a half and released after ten minutes of silence, or when your terminal turn ends, so forgetting costs nothing but a lingering badge.";

/// The calls a task can end on. Each takes endSession so the release rides the
/// last call instead of costing one more; browser_close carries it in its own
/// definition, since closing the last tab is the other way a task ends.
const LAST_CALL_TOOLS: [&str; 8] = [
    "browser_click",
    "browser_press",
    "browser_key",
    "browser_wait",
    "browser_get_text",
    "browser_get_property",
    "browser_screenshot",
    "browser_snapshot",
];

fn tab_id_prop() -> Value {
    json!({ "type": "integer", "description": "Active native browser tab id (from browser_tabs)." })
}
fn ref_prop() -> Value {
    json!({ "type": "string", "description": "Ref from this tab's latest snapshot or find, e.g. \"g3-e12\"; each new snapshot or find replaces older refs." })
}

fn fraction_point_prop(description: &str) -> Value {
    json!({
        "type": "object", "additionalProperties": false, "description": description,
        "properties": {
            "x": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1 },
            "y": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1 }
        },
        "required": ["x", "y"]
    })
}

fn workspace_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id. UI focus is never used as a fallback." })
}

fn file_workspace_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Required absolute workspace root. Upload sources and download destinations are confined to this tab's workspace." })
}

fn agent_id_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "The agent to address: its name from agent_list, such as Alnilam, or the id such as codex:11. Names are unique within a workspace." })
}

fn terminal_id_prop() -> Value {
    json!({ "type": "string", "minLength": 1, "description": "Workspace-scoped shared terminal id returned by terminal_open or terminal_list, such as terminal:12:12." })
}

fn page_expectation_prop() -> Value {
    json!({
        "type": "object", "additionalProperties": false,
        "description": "After dispatch, wait until every given condition holds for stableFor ms. A timeout never repeats the action; a match that kept changing comes back as matched:true, stable:false, not as an error.",
        "properties": {
            "url": {"type":"string", "minLength":1, "maxLength":8192, "description":"Exact URL or a glob with * wildcards."},
            "title": {"type":"string", "minLength":1, "maxLength":2048, "description":"Page title, whitespace and case normalized."},
            "titleSource": {"type":"string", "enum":["document","native"], "default":"document", "description":"Requires title; the source page_info returned."},
            "text": {"type":"string", "minLength":1, "maxLength":2048, "description":"Case-insensitive substring of visible text or title."},
            "timeout": {"type":"integer", "minimum":100, "maximum":60000, "default":10000},
            "stableFor": {"type":"integer", "minimum":0, "maximum":2000, "default":200, "description":"Continuous match window in ms."}
        },
        "anyOf": [{"required":["url"]}, {"required":["title"]}, {"required":["text"]}]
    })
}

/// The `tools` array returned by `tools/list`, grouped by capability prefix.
pub fn tool_definitions() -> Value {
    let tab = tab_id_prop();
    let refr = ref_prop();
    let workspace = workspace_prop();
    let file_workspace = file_workspace_prop();
    let agent_id = agent_id_prop();
    let terminal_id = terminal_id_prop();
    let mut definitions = tool_array![
        { "name": "skills_list", "description": "List the skills available in a workspace: project procedures kept in .anbo/skills, plus the skills Anbo ships. Returns names, one-line descriptions and, for skills read on demand, their section titles, so it stays cheap to scan. Check this before solving a task from first principles.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone() }, "required": ["workspace"] } },
        { "name": "skills_read", "description": "Read a skill and follow it. A skill read on demand returns its essentials plus a section index; pass section to read one section in full. Names come from skills_list.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "name": { "type": "string", "minLength": 1, "maxLength": 64, "description": "Skill name from skills_list." }, "section": { "type": "string", "minLength": 1, "maxLength": 120, "description": "A section title from the skill's index, matched case-insensitively." } }, "required": ["workspace", "name"] } },
        { "name": "browser_open", "description": "Open a page in the user's real browser: a visible tab in this app, not a private fetch. Use it whenever a task needs a web page opened, read, or interacted with. Pass your own workspace root or space id; UI focus is never a fallback. The first tab in an empty active workspace is shown, later tabs stay in the background. The reply carries the tabId and the controlId of your session.", "inputSchema": { "type": "object", "properties": { "url": { "type": "string" }, "workspace": { "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id for agent isolation." } }, "required": ["url", "workspace"] } },
        { "name": "browser_close", "description": "Close a native browser tab in an explicitly selected Anbo workspace. Pass endSession: true when this is the last tab of your task, so closing it and ending your session is one call instead of two.", "annotations": { "destructiveHint": true, "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "workspace": { "type": "string", "minLength": 1, "description": "Required Anbo workspace root or space id for agent isolation." }, "endSession": { "type": "boolean", "default": false, "description": "Also end your control session after the tab closes; the reply then carries sessionEnded: true." } }, "required": ["tabId", "workspace"] } },
        { "name": "browser_tabs", "description": "List active native browser tabs with foreground, workspace, space, loading, pendingUrl, automation-target, automation-activity, and durationMs metadata. While loading, url remains the last committed URL and pendingUrl identifies the target when known.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "browser_get_url", "description": "Get the last committed URL, loading state and pendingUrl of a browser tab without waiting for page JavaScript. While loading, pendingUrl is the requested target when known; it is not proof of a committed navigation.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_navigate", "description": "Start navigating a browser tab to an http(s) URL and return immediately. Use browser_wait or browser_tabs to observe completion; browser_stop can interrupt the active load.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "url": { "type": "string" } }, "required": ["tabId", "url"] } },
        { "name": "browser_emulate", "description": "Emulate a device viewport on a browser tab so the page lays out as it would on that device. Pass width 0 to clear the emulation. Sets the device pixel ratio and, for mobile, touch support. The emulation survives navigation until cleared.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "width": { "type": "integer", "minimum": 0, "maximum": 10000, "description": "CSS pixels wide. 0 clears the emulation." }, "height": { "type": "integer", "minimum": 0, "maximum": 10000 }, "scale": { "type": "number", "minimum": 0.1, "maximum": 4, "default": 1, "description": "Device pixel ratio." }, "mobile": { "type": "boolean", "default": false, "description": "Report a mobile device and enable touch." }, "fit": { "type": "number", "minimum": 0.05, "maximum": 1, "default": 1, "description": "Shrink the painted result so a viewport wider than the pane is shown whole instead of cropped." } }, "required": ["tabId", "width", "height"] } },
        { "name": "browser_reload", "description": "Start reloading a browser tab and return immediately. Use browser_wait or browser_tabs to observe completion.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_back", "description": "Start navigating a browser tab back in history and return immediately.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_forward", "description": "Start navigating a browser tab forward in history and return immediately.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_stop", "description": "Stop a browser tab's page load. Reports wasLoading, whether a load was actually in flight when the call arrived, and cancelledUrl, the target that was interrupted when one was known.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone() }, "required": ["tabId"] } },
        { "name": "browser_snapshot", "description": "Token-bounded accessibility snapshot: viewport text first, then interactive elements with refs; 8000 characters by default, 16000 at most, paged with offset and nextOffset. Snapshot and find both replace older refs; prefer find when the element is already known.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "offset": { "type": "integer", "minimum": 0, "description": "Skip this many items; the reply carries nextOffset while more of the page is waiting." }, "maxChars": { "type": "integer", "minimum": 2000, "maximum": 16000, "default": 8000 } }, "required": ["tabId"] } },
        { "name": "browser_find", "description": "Find elements by role (with the computed accessible name), text, label, placeholder, testId, title, alt, or CSS across open Shadow DOM and child frames, and return fresh refs. Implicit roles cover links, buttons, inputs (textbox, searchbox, combobox, checkbox...), headings, dialogs, lists, tables and landmarks. Elements that are not rendered are left out and counted as hiddenMatches; a timeout says whether the page was scanned end to end, and a confirmed absence returns once the page settles and stops changing rather than only at the timeout.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "by": { "type": "string", "enum": ["role", "text", "label", "placeholder", "testId", "title", "alt", "css"] }, "value": { "type": "string", "minLength": 1, "maxLength": 4096 }, "name": { "type": "string", "minLength": 1, "maxLength": 4096, "description": "Optional computed accessible-name filter for a role locator. It may come from aria-label, aria-labelledby, an associated label, alt, title, or visible text." }, "exact": { "type": "boolean", "default": false }, "includeHidden": { "type": "boolean", "default": false }, "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 10 }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 5000 } }, "required": ["tabId", "by", "value"] } },
        { "name": "browser_click", "description": "Click an element by ref after bounded visibility, stability, enabled, and hit-target checks.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_double_click", "description": "Double-click an actionable element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_focus", "description": "Focus a visible enabled element by ref without activating the user's workspace.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_check", "description": "Set a checkbox or radio ref to the requested checked state and verify the result.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "checked": { "type": "boolean", "default": true } }, "required": ["tabId", "ref"] } },
        { "name": "browser_drag", "description": "Native mouse drag from one ref to another, or inside one element by passing the same ref twice with sourcePosition and targetPosition (fractions of the element, e.g. {x:0.7,y:0.5} to {x:0.4,y:0.5} pans a chart left). Both points must be visible; nothing is retried automatically.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "sourceRef": refr.clone(), "targetRef": refr.clone(), "sourcePosition": fraction_point_prop("Where the press lands inside sourceRef, as fractions strictly between 0 and 1 (0.5 is the center), not pixels."), "targetPosition": fraction_point_prop("Where the release lands inside targetRef, as fractions strictly between 0 and 1, not pixels.") }, "required": ["tabId", "sourceRef", "targetRef"] } },
        { "name": "browser_type", "description": "Type text into an input element by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "text": { "type": "string" }, "append": { "type": "boolean", "description": "Append to existing value instead of replacing it." } }, "required": ["tabId", "ref", "text"] } },
        { "name": "browser_press", "description": "Press a keyboard key through the browser input pipeline (e.g. Enter, Tab). Key dispatch holds the tab lock, but Enter observation does not, so stop and navigation remain responsive. submissionObserved and navigationObserved report only effects seen within the bounded observation window; false does not mean dispatch failed.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "key": { "type": "string" }, "observationTimeout": { "type": "integer", "minimum": 0, "maximum": 10000, "default": 3000, "description": "Milliseconds to observe submit or navigation after Enter without holding the tab lock. Ignored for other keys." } }, "required": ["tabId", "key"] } },
        { "name": "browser_key", "description": "Dispatch a keyboard press, key-down, or key-up. Alt, Control, Meta, and Shift modifiers are per-call: pass them on each key event. Holding a modifier across tools or modifying mouse clicks is not supported.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "key": { "type": "string", "minLength": 1, "maxLength": 64 }, "keyAction": { "type": "string", "enum": ["press", "down", "up"], "default": "press" }, "modifiers": { "type": "array", "maxItems": 4, "uniqueItems": true, "items": { "type": "string", "enum": ["Alt", "Control", "Meta", "Shift"] } } }, "required": ["tabId", "key"] } },
        { "name": "browser_scroll", "description": "Scroll the page by x/y pixels.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["tabId"] } },
        { "name": "browser_wait", "description": "Wait for text, URL, document load state, or a ref state. networkIdle observes native page-target HTTP requests until completion or failure plus 500ms of quiet; it is not a guarantee of application readiness. Use explicit text or waitFor for streaming pages. Backward-compatible text-only calls remain supported.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "condition": { "type": "string", "enum": ["text", "url", "load", "ref"] }, "text": { "type": "string" }, "url": { "type": "string", "description": "Exact URL or a glob containing * wildcards." }, "ref": refr.clone(), "state": { "type": "string", "enum": ["attached", "detached", "visible", "hidden", "enabled", "disabled", "checked", "unchecked"] }, "loadState": { "type": "string", "enum": ["interactive", "complete", "networkIdle"], "default": "complete" }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "description": "Timeout in milliseconds (default 10000). Values above 50000 are accepted but run to 50000, so the tool always reports what it saw instead of losing the answer to the transport timeout." } }, "required": ["tabId"] } },
        { "name": "browser_dialog", "description": "Click a ref and handle its alert, confirm, or prompt. Returns clickDispatched and dialogOpened separately. If no dialog opens, ok is false but the click already happened; do not blindly retry it.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "dialogAction": { "type": "string", "enum": ["accept", "dismiss"] }, "promptText": { "type": "string", "maxLength": 4096 } }, "required": ["tabId", "ref", "dialogAction"] } },
        { "name": "browser_screenshot", "description": "Capture the viewport (not the full page) to a file under <workspace>/.anbo/artifacts and, unless inline is false, also return the image in the reply so no separate read is needed. Automation cursor effects are excluded.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "format": { "type": "string", "enum": ["png", "jpeg", "webp"], "default": "png", "description": "PNG keeps every pixel; jpeg or webp cost a fraction of it when the capture is only being read for layout." }, "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Encoder quality for jpeg and webp." }, "inline": { "type": "boolean", "default": true, "description": "Return the image in the reply as well as writing the file. Captures above 600 KB are only written to disk." }, "workspace": { "type": "string", "description": "Optional workspace root; screenshot lands under <workspace>/.anbo/artifacts." } }, "required": ["tabId"] } },
        { "name": "browser_upload", "description": "Attach one or more workspace files to an <input type=file> ref without opening a native file chooser. Hidden file inputs and refs in open Shadow DOM or child frames are supported. This selects files only; use a separate click/press to submit the form.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "workspace": file_workspace.clone(), "paths": { "type": "array", "minItems": 1, "maxItems": 16, "items": { "type": "string", "minLength": 1 }, "description": "Absolute paths inside the workspace, or paths relative to the workspace root." } }, "required": ["tabId", "ref", "workspace", "paths"] } },
        { "name": "browser_download", "description": "Arm a workspace-scoped native download and click a ref. Returns a downloadId once the download starts; completed files land under <workspace>/.anbo/downloads. Use browser_download_wait for large files.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "workspace": file_workspace.clone(), "fileName": { "type": "string", "minLength": 1, "maxLength": 255, "description": "Optional safe destination file name. Existing files are never overwritten." }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000, "description": "How long to wait for the page to start the download." } }, "required": ["tabId", "ref", "workspace"] } },
        { "name": "browser_download_status", "description": "Read the current state and verified destination of a workspace-scoped browser download.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "downloadId": { "type": "string", "minLength": 1, "maxLength": 128 }, "workspace": file_workspace.clone() }, "required": ["downloadId", "workspace"] } },
        { "name": "browser_download_wait", "description": "Wait for a browser download to change state or finish. Normal timeout returns timedOut:true so large downloads can be polled without losing their downloadId.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "downloadId": { "type": "string", "minLength": 1, "maxLength": 128 }, "workspace": file_workspace, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 30000 } }, "required": ["downloadId", "workspace"] } },
        { "name": "browser_select_option", "description": "Select an option on a <select> element by ref (by value or label).", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "value": { "type": "string" } }, "required": ["tabId", "ref", "value"] } },
        { "name": "browser_hover", "description": "Hover a ref with one native mouse move and CSS :hover verification. position picks a point inside the same target, e.g. to reveal auto-hiding media controls; CSS hover does not prove controls are visible. Child-frame targets fall back to a DOM-only hover.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "position": fraction_point_prop("Fractions strictly between 0 and 1 inside the painted target, not pixels; defaults to the center {x:0.5,y:0.5}. The point must be visible and unobscured.") }, "required": ["tabId", "ref"] } },
        { "name": "browser_scroll_to_element", "description": "Scroll an element into view by ref.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone() }, "required": ["tabId", "ref"] } },
        { "name": "browser_get_text", "description": "Get DOM text or the accessibility name of an element, or body text when ref is omitted. Returns visible and source; hidden accessible labels may be outdated. Reveal controls and read again before treating labels as live state.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "maxLength": { "type": "integer", "minimum": 1, "maximum": 16000, "default": 8000 } }, "required": ["tabId"] } },
        { "name": "browser_get_property", "description": "Read live properties of an element by ref without page JavaScript: value, checked, disabled, readOnly, selected, paused, ended, muted, currentTime, duration, volume, playbackRate, scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth, href, src, title, placeholder, open, hidden, tagName. One call answers whether a video is paused or what an input holds now.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "ref": refr.clone(), "properties": { "type": "array", "minItems": 1, "maxItems": 8, "uniqueItems": true, "items": { "type": "string", "enum": super::actions::ELEMENT_PROPERTIES } } }, "required": ["tabId", "ref", "properties"] } },
        { "name": "browser_page_info", "description": "Get native title and URL without waiting for page JavaScript. titleSource document opts into a bounded DOM-title read. When waiting for this title, pass the returned titleSource to waitFor; native and DOM titles can differ after SPA back/forward.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "titleSource": {"type":"string", "enum":["native","document"], "default":"native"} }, "required": ["tabId"] } },
        { "name": "browser_console_logs", "description": "Get up to 50 bounded recent console messages, uncaught runtime errors, and unhandled promise rejections from the main document and accessible child frames.", "inputSchema": { "type": "object", "properties": { "tabId": tab.clone(), "level": { "description": "Keep only these console levels, as one name or a list.", "anyOf": [ { "type": "string" }, { "type": "array", "items": { "type": "string" }, "maxItems": 8 } ] }, "maxCharsPerMessage": { "type": "integer", "minimum": 40, "maximum": 4000, "description": "Clip each message; one advert frame can otherwise spend the whole budget on a single tracking URL." }, "since": { "type": "integer", "minimum": 0, "description": "Only entries at or after this timestamp." } }, "required": ["tabId"] } },
        { "name": "agent_spawn", "description": "Spawn one configured built-in or custom CLI agent in an explicitly selected open Anbo workspace. Displays its first tab only in an empty active workspace; later spawns stay in the background and inactive workspaces never activate. The stored command cannot be supplied or overridden by the caller.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agent": { "type": "string", "minLength": 1, "maxLength": 71, "description": "Built-in launcher id or label, or the display name or custom:<id> of an agent registered in Anbo Settings." }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 15000, "description": "How long to wait for live agent detection before returning pending: true." } }, "required": ["workspace", "agent"] } },
        { "name": "agent_list", "description": "List live non-private terminal agents in an explicitly selected Anbo workspace. Each carries the name it goes by, such as Alnilam, alongside its cli and id. Use the name when addressing it. Does not activate the workspace or move UI focus.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone() }, "required": ["workspace"] } },
        { "name": "agent_status", "description": "Get the callsign, CLI type, working or waiting state, tab, space, workspace, and discovered resume session for one live agent. Agent ids are readable and workspace-scoped, such as lucian-claude:14 or claude:14.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone() }, "required": ["workspace", "agentId"] } },
        { "name": "agent_read", "description": "Read a redacted, bounded increment of an agent terminal. Reuse the returned opaque cursor to receive only newer output; reset indicates that terminal history changed or the cursor expired.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone(), "cursor": { "type": "string", "description": "Opaque cursor returned by an earlier agent_read call." }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "agentId"] } },
        { "name": "agent_send", "description": "Send one bounded instruction to a live agent without activating its workspace. By default waits until the agent is ready, serializes concurrent sends, and rejects duplicate message ids. Set waitForReady to false to deliver immediately even while the reported state is working.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id.clone(), "message": { "type": "string", "minLength": 1, "maxLength": 8000 }, "waitForReady": { "type": "boolean", "default": true }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 30000 }, "sourceAgentId": { "type": "string", "description": "Optional sender agent id. Sending to the same id is rejected." }, "messageId": { "type": "string", "maxLength": 128, "description": "Optional idempotency key scoped to the target agent." } }, "required": ["workspace", "agentId", "message"] } },
        { "name": "agent_wait", "description": "Wait for an agent to become working, waiting for input, or finished, or for its state to change when status is omitted. A normal timeout is returned as timedOut rather than a tool error.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "agentId": agent_id, "status": { "type": "string", "enum": ["working", "waiting", "finished"] }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000 } }, "required": ["workspace", "agentId"] } },
        { "name": "terminal_open", "description": "Open a shared terminal in an explicit workspace. Displays the first tab only in an empty active workspace; later opens stay in the background and inactive workspaces never activate.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "title": { "type": "string", "minLength": 1, "maxLength": 64, "description": "Required purpose-specific tab title." } }, "required": ["workspace", "title"] } },
        { "name": "terminal_close", "description": "Close an idle normal terminal previously created by terminal_open during the current Anbo application session. Refuses user-created terminals, agent CLI terminals, pending input, and foreground processes.", "annotations": { "readOnlyHint": false, "destructiveHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone() }, "required": ["workspace", "terminalId"] } },
        { "name": "terminal_list", "description": "List normal non-private Anbo shell terminals in an explicitly selected workspace. Agent CLI terminals are excluded. Does not activate the workspace or move UI focus.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone() }, "required": ["workspace"] } },
        { "name": "terminal_read", "description": "Read a redacted bounded increment from a shared normal terminal. Reuse the returned cursor to receive only newer output. hasMore reports unread output after this response; historyTruncated reports omitted older history; reset and replayed identify a terminal buffer repaint. Private and agent CLI terminals are never available.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "cursor": { "type": "string", "description": "Opaque cursor returned by an earlier terminal_read call." }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "terminalId"] } },
        { "name": "terminal_insert", "description": "Insert one bounded single-line string into an explicitly selected idle normal terminal without pressing Enter or changing UI focus. Waits briefly for visible terminal echo and returns inputVisible plus a cursor for terminal_read polling.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "text": { "type": "string", "minLength": 1, "maxLength": 8000 } }, "required": ["workspace", "terminalId", "text"] } },
        { "name": "terminal_execute", "description": "Queue one bounded single-line command for visible cancellable dispatch in an explicitly selected idle normal terminal. Returns an executionId in phase queued; call terminal_wait for the stable final result. Rejects private terminals, agent CLI terminals, foreground processes, and prompts containing unsubmitted input.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "text": { "type": "string", "minLength": 1, "maxLength": 8000 } }, "required": ["workspace", "terminalId", "text"] } },
        { "name": "terminal_wait", "description": "Wait for a command started by terminal_execute without holding the terminal lock. Returns stable phase, completionReason, interrupted, per-execution exitCode, and redacted bounded output. Completed results are idempotent.", "annotations": { "readOnlyHint": true }, "inputSchema": { "type": "object", "properties": { "workspace": workspace.clone(), "terminalId": terminal_id.clone(), "executionId": { "type": "string", "minLength": 1, "maxLength": 128 }, "timeout": { "type": "integer", "minimum": 100, "maximum": 60000, "default": 10000 }, "maxChars": { "type": "integer", "minimum": 1, "maximum": 12000, "default": 4000 } }, "required": ["workspace", "terminalId", "executionId"] } },
        { "name": "terminal_interrupt", "description": "Cancel a specific queued, dispatched, or running execution by executionId. When executionId is omitted, send Ctrl+C to the terminal foreground command or safely clear unsubmitted prompt input.", "annotations": { "readOnlyHint": false }, "inputSchema": { "type": "object", "properties": { "workspace": workspace, "terminalId": terminal_id, "executionId": { "type": "string", "minLength": 1, "maxLength": 128 } }, "required": ["workspace", "terminalId"] } }
    ];
    let find_schema = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "browser_find")
        .unwrap()["inputSchema"]["properties"]
        .clone();
    for tool in definitions.as_array_mut().unwrap() {
        let name = tool["name"].as_str().unwrap().to_string();
        if matches!(
            name.as_str(),
            "browser_click" | "browser_press" | "browser_wait"
        ) {
            tool["inputSchema"]["properties"]["waitFor"] = page_expectation_prop();
            tool["inputSchema"]["properties"]["diagnostics"] = json!({"type":"boolean", "default":false, "description":"Opt-in phase timings in the reply; no input values are included."});
        }
        if name == "browser_press" {
            tool["inputSchema"]["properties"]["ref"] = ref_prop();
            tool["inputSchema"]["properties"]["expectedValue"] = json!({"type":"string", "maxLength":65536, "description":"Requires ref. Verify the input's current value before the key is sent; a mismatch sends nothing. Values are not echoed in errors."});
            tool["description"] = json!("Press a keyboard key through native input. For forms pass the input ref and expectedValue to guard against a replaced or reset input, plus waitFor to verify the result; waitFor replaces Enter's default observation window. Never blindly resubmit after a postcondition timeout.");
        } else if name == "browser_click" {
            tool["description"] = json!("Click a ref after visibility, stability, enabled and hit-target checks. Optional waitFor verifies the resulting page state; a timed-out wait never repeats the click.");
        } else if name == "browser_wait" {
            tool["description"] = json!("Wait for text, URL, load state, or a ref state; or pass waitFor alone for a stable url, title and visible-text combination (put timeout inside it). A load event alone does not prove SPA readiness.");
        }
        let method = tool_name_to_method(&name).unwrap_or("");
        if super::locator_target::supports_locator(method) || name == "browser_wait" {
            let waiting = name == "browser_wait";
            let fields = if waiting {
                vec!["by", "value", "name", "exact"]
            } else {
                vec!["by", "value", "name", "exact", "includeHidden", "timeout"]
            };
            // The embedded copy keeps the shapes and enums but not the prose:
            // browser_find already carries every description once, and this
            // object rides along in fourteen tools. Measured: 763 characters
            // per tool with the prose, a third of that without.
            let props: serde_json::Map<String, Value> = fields
                .into_iter()
                .map(|key| {
                    let mut prop = find_schema[key].clone();
                    if let Some(object) = prop.as_object_mut() {
                        object.remove("description");
                    }
                    (key.into(), prop)
                })
                .collect();
            tool["inputSchema"]["properties"]["locator"] = json!({
                "type":"object", "properties":props, "required":["by","value"], "additionalProperties":false,
                "description": if waiting { "Locator (browser_find fields, hidden included); unique unless minCount. Uses the top-level timeout." } else { "Instead of ref: browser_find fields naming one unique element." }
            });
            if waiting {
                tool["inputSchema"]["properties"]["condition"]["enum"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("locator"));
                tool["inputSchema"]["properties"]["state"]["enum"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("absent"));
                tool["inputSchema"]["properties"]["minCount"] = json!({
                    "type": "integer", "minimum": 1, "maximum": 20,
                    "description": "Wait for at least this many matches instead of exactly one, for lazily loaded feeds, results or rows (attached, visible, hidden, absent, detached)."
                });
                tool["description"] = json!(format!("{} Or pass locator + state (including absent/hidden) with top-level timeout, without other conditions.", tool["description"].as_str().unwrap()));
            } else {
                let required = tool["inputSchema"]["required"].as_array_mut().unwrap();
                if required.iter().any(|field| field == "ref") {
                    required.retain(|field| field != "ref");
                }
                tool["description"] = json!(format!("{} Accepts exactly one ref or unique locator.", tool["description"].as_str().unwrap()));
            }
        }
        if name == "browser_find" {
            tool["description"] = json!(format!("{} Matches also carry editable, readOnly, inViewport and bounds as metadata.", tool["description"].as_str().unwrap()));
        }
        if LAST_CALL_TOOLS.iter().any(|last| *last == name) {
            tool["inputSchema"]["properties"]["endSession"] = json!({
                "type": "boolean", "default": false,
                "description": "End your session after this call succeeds: cursor and badge go, tabs stay open."
            });
        }
    }
    definitions
}

/// Map an MCP tool name to the `handle_action` method it dispatches to.
pub fn tool_name_to_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "skills_list" => "skills_list",
        "skills_read" => "skills_read",
        "browser_open" => "open",
        "browser_close" => "close",
        "browser_tabs" => "list_tabs",
        "browser_get_url" => "get_url",
        "browser_navigate" => "navigate",
        "browser_emulate" => "emulate",
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
        "browser_get_property" => "get_property",
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
        assert_eq!(tools.len(), 51);
        let mut names = std::collections::HashSet::new();
        for t in &tools {
            let n = t.get("name").and_then(|v| v.as_str()).unwrap();
            assert!(
                n.starts_with("browser_")
                    || n.starts_with("agent_")
                    || n.starts_with("terminal_")
                    || n.starts_with("skills_"),
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
    fn the_session_tools_are_gone_and_the_flag_rides_the_last_call() {
        // Measured over forty-five agent-driven tasks: browser_start_session
        // was never called once the first action opened the session itself,
        // and browser_end_session was only ever the call after the last real
        // one. Both are gone; endSession on that last call does the ending,
        // and a session left alone is parked and then released by the sweep.
        let tools = tool_definitions().as_array().unwrap().clone();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(!names.contains(&"browser_start_session"));
        assert!(!names.contains(&"browser_end_session"));
        assert_eq!(tool_name_to_method("browser_start_session"), None);
        assert_eq!(tool_name_to_method("browser_end_session"), None);
        for last in LAST_CALL_TOOLS.iter().chain(["browser_close"].iter()) {
            let tool = tools
                .iter()
                .find(|tool| tool["name"] == *last)
                .unwrap_or_else(|| panic!("{last} is a tool"));
            assert_eq!(
                tool["inputSchema"]["properties"]["endSession"]["type"], "boolean",
                "{last} takes endSession"
            );
        }
        // No tool text sends the agent to a tool that no longer exists.
        for tool in &tools {
            let description = tool["description"].as_str().unwrap_or_default();
            assert!(!description.contains("browser_end_session"), "{description}");
            assert!(!description.contains("browser_start_session"), "{description}");
        }
    }

    #[test]
    fn the_first_browser_tool_opens_the_session_and_the_text_says_so() {
        // The gate used to refuse any action without an explicit
        // browser_start_session; the first action opens the session itself
        // now, and the connect message has to say so, or an agent keeps
        // looking for a start call out of habit. It also has to say how a
        // task ends without an end tool, and what happens if it never does.
        assert!(BROWSER_SESSION_INSTRUCTIONS.contains("first browser tool"));
        assert!(BROWSER_SESSION_INSTRUCTIONS.contains("nothing to start"));
        assert!(BROWSER_SESSION_INSTRUCTIONS.contains("endSession: true on your last call"));
        assert!(BROWSER_SESSION_INSTRUCTIONS.contains("released after ten minutes"));
        assert!(!BROWSER_SESSION_INSTRUCTIONS.contains("browser_end_session"));
        assert!(!BROWSER_SESSION_INSTRUCTIONS.contains("browser_start_session"));
        assert!(!SERVER_INSTRUCTIONS.contains("browser_end_session"));
    }

    #[test]
    fn browser_drag_positions_are_typed_fractions() {
        // The backend accepted sourcePosition and targetPosition long before the
        // schema advertised them: they sat next to `properties` instead of inside
        // it, so a model that wanted to pan a chart had nothing to follow, sent
        // the fractions as a JSON string, and was refused twice per attempt.
        let tools = tool_definitions();
        let drag = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_drag")
            .unwrap();
        for key in ["sourcePosition", "targetPosition"] {
            let position = &drag["inputSchema"]["properties"][key];
            assert_eq!(position["type"], "object", "{key}");
            assert_eq!(position["required"], json!(["x", "y"]), "{key}");
            assert_eq!(position["additionalProperties"], false, "{key}");
            for axis in ["x", "y"] {
                assert_eq!(position["properties"][axis]["exclusiveMinimum"], 0);
                assert_eq!(position["properties"][axis]["exclusiveMaximum"], 1);
            }
        }
        assert!(drag["inputSchema"].get("sourcePosition").is_none());
        assert_eq!(drag["inputSchema"]["required"], json!(["tabId", "sourceRef", "targetRef"]));
    }

    #[test]
    fn browser_tool_schemas_fit_the_token_budget() {
        // Every schema an agent loads is prompt it pays for on each turn. The
        // browser tools measured 44,792 characters before the trim, most of it
        // the locator object repeated with its prose in fourteen tools; the
        // budget keeps a future description from quietly growing them back.
        let tools = tool_definitions();
        let browser: Vec<&Value> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool["name"].as_str().unwrap().starts_with("browser_"))
            .collect();
        let size = serde_json::to_string(&browser).unwrap().len();
        assert!(size <= 38_000, "browser tool schemas are {size} characters");
    }

    #[test]
    fn get_property_reads_a_closed_list_and_takes_a_locator() {
        // The list is the safety argument: the agent names a DOM property,
        // never code. Measured on YouTube before this tool existed, "is the
        // video paused" cost 12 finds, 3 focuses and 6 key presses per task.
        let tools = tool_definitions();
        let tool = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_get_property")
            .expect("browser_get_property");
        let items = &tool["inputSchema"]["properties"]["properties"]["items"];
        let allowed = items["enum"].as_array().expect("enum");
        assert!(allowed.iter().any(|v| v == "paused"));
        assert!(allowed.iter().any(|v| v == "value"));
        assert!(!allowed.iter().any(|v| v == "innerHTML"));
        assert_eq!(
            allowed.len(),
            super::super::actions::ELEMENT_PROPERTIES.len()
        );
        assert!(tool["inputSchema"]["properties"].get("locator").is_some());
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool_name_to_method("browser_get_property"), Some("get_property"));
    }

    #[test]
    fn closing_the_last_tab_can_end_the_session_in_the_same_call() {
        // browser_close followed by browser_end_session was the last two calls
        // of every one of fifteen measured tasks; the flag folds them.
        let tools = tool_definitions();
        let close = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_close")
            .unwrap();
        assert_eq!(close["inputSchema"]["properties"]["endSession"]["type"], "boolean");
        assert!(close["description"].as_str().unwrap().contains("endSession"));
        assert!(SERVER_INSTRUCTIONS.contains("endSession: true"));
        assert!(SERVER_INSTRUCTIONS.contains("page.url"));
        assert!(BROWSER_SESSION_INSTRUCTIONS.contains("endSession: true"));
    }

    #[test]
    fn opening_a_tab_tells_the_agent_which_session_it_is_in() {
        // An agent that opens three tabs and then has to end the session needs
        // the id. Leaving it out of the open response sent them digging through
        // a later call's payload for it, or guessing.
        let definitions = tool_definitions();
        let open = definitions
            .as_array()
            .expect("tools")
            .iter()
            .find(|tool| tool["name"] == "browser_open")
            .expect("browser_open");
        let description = open["description"].as_str().unwrap_or_default();
        assert!(description.contains("controlId"), "{description}");
    }

    #[test]
    fn the_connect_message_says_what_the_browser_tools_are_for() {
        // A CLI with its own web search will use that instead unless it is told
        // what this browser is. Measured with a plain "open and explore three
        // pages" request: Claude and OpenCode drove these tools, Codex answered
        // from its own web search and Antigravity from memory, and neither of
        // those two ever read the skill. Pointing at the skills is not enough --
        // the model decides whether to bother before it reads anything.
        let text = SERVER_INSTRUCTIONS.to_ascii_lowercase();
        assert!(text.contains("real browser"), "say the browser is real");
        assert!(
            text.contains("watching") || text.contains("screen"),
            "say the user can see it"
        );
        assert!(
            text.contains("rather than fetching or searching the web yourself"),
            "steer off the model's own web tools"
        );
        assert!(text.contains("skills_list"), "still point at the skills");

        // browser_open carries it too, for clients that weigh tool descriptions
        // more heavily than the connect message.
        let tools = tool_definitions();
        let open = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t.get("name").and_then(|v| v.as_str()) == Some("browser_open"))
            .expect("browser_open");
        let description = open
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_ascii_lowercase();
        assert!(description.contains("real browser"));
        assert!(description.contains("not a private fetch"));
    }

    #[test]
    fn unknown_tool_maps_to_none() {
        assert!(tool_name_to_method("browser_nope").is_none());
        assert!(tool_name_to_method("navigate").is_none());
    }

    #[test]
    fn hover_position_schema_is_explicit_bounded_and_optional() {
        let tools = tool_definitions();
        let hover = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "browser_hover")
            .unwrap();
        let schema = &hover["inputSchema"];
        assert_eq!(schema["required"], json!(["tabId"]));
        assert!(schema.get("anyOf").is_none());
        assert!(schema.get("not").is_none());
        assert!(schema["properties"].get("ref").is_some());
        assert!(schema["properties"].get("locator").is_some());
        let position = &schema["properties"]["position"];
        assert_eq!(position["additionalProperties"], false);
        assert_eq!(position["required"], json!(["x", "y"]));
        for axis in ["x", "y"] {
            assert_eq!(position["properties"][axis]["exclusiveMinimum"], 0);
            assert_eq!(position["properties"][axis]["exclusiveMaximum"], 1);
        }
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
        assert_eq!(
            press["inputSchema"]["properties"]["expectedValue"]["maxLength"],
            65536
        );
        for name in ["browser_press", "browser_click", "browser_wait"] {
            let tool = tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            let properties = &tool["inputSchema"]["properties"];
            assert_eq!(properties["diagnostics"]["default"], false);
            assert_eq!(properties["waitFor"]["additionalProperties"], false);
            assert_eq!(
                properties["waitFor"]["properties"]["stableFor"]["maximum"],
                2000
            );
        }
    }

    #[test]
    fn locator_contracts_preserve_target_choice_and_workspace_requirements() {
        for tool in tool_definitions().as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let method = tool_name_to_method(name).unwrap();
            let schema = &tool["inputSchema"];
            if super::super::locator_target::supports_locator(method) {
                assert_eq!(
                    schema["properties"]["locator"]["additionalProperties"], false,
                    "{name}"
                );
                assert!(schema.get("not").is_none(), "{name}");
                assert!(
                    !schema["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("ref")),
                    "{name}"
                );
                assert!(schema.get("anyOf").is_none(), "{name}");
                assert!(tool["description"]
                    .as_str()
                    .unwrap()
                    .contains("exactly one ref or unique locator"));
            } else if name == "browser_drag" {
                assert!(schema["properties"].get("locator").is_none());
            } else if name == "browser_wait" {
                let props = &schema["properties"]["locator"]["properties"];
                assert!(props.get("timeout").is_none());
                assert!(props.get("includeHidden").is_none());
                assert!(schema["properties"]["state"]["enum"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("absent")));
            }
        }
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

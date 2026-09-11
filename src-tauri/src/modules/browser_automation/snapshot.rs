use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::ref_context::REF_REGISTRY_JS;
use super::visibility::VISIBILITY_JS;

static SNAPSHOT_GENERATIONS: Mutex<Option<HashMap<i64, u64>>> = Mutex::new(None);
static REF_FRAME_TARGETS: Mutex<Option<HashMap<i64, HashMap<String, RefFrameTarget>>>> =
    Mutex::new(None);

pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 8_000;
pub const MIN_SNAPSHOT_MAX_CHARS: usize = 2_000;
pub const MAX_SNAPSHOT_MAX_CHARS: usize = 16_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefFrameTarget {
    pub frame_id: String,
    pub is_main: bool,
}

fn generations() -> &'static Mutex<Option<HashMap<i64, u64>>> {
    &SNAPSHOT_GENERATIONS
}

pub fn get_next_generation(tab_id: i64) -> u64 {
    let mut guard = generations().lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let next = map.get(&tab_id).copied().unwrap_or(0) + 1;
    map.insert(tab_id, next);
    next
}

/// The number a scan would take if it earns one, without spending it.
///
/// A lookup that matches nothing registers no refs, and the page keeps the
/// ones it already had. Committing the number up front instead retired every
/// live ref the moment a search began, so one selector that missed cost the
/// caller every target it was holding.
pub fn peek_next_generation(tab_id: i64) -> u64 {
    get_current_generation(tab_id) + 1
}

/// Publish a generation a scan actually used. Never moves backwards.
pub fn commit_generation(tab_id: i64, generation: u64) {
    let mut guard = generations().lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    let entry = map.entry(tab_id).or_insert(0);
    if generation > *entry {
        *entry = generation;
    }
}

pub fn get_current_generation(tab_id: i64) -> u64 {
    let mut guard = generations().lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.get(&tab_id).copied().unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotElement {
    #[serde(rename = "type")]
    pub element_type: String,
    pub ref_id: Option<String>,
    pub tag: Option<String>,
    pub role: Option<String>,
    pub label: Option<String>,
    pub value: Option<String>,
    pub checked: Option<bool>,
    pub disabled: Option<bool>,
    pub text: Option<String>,
    #[serde(default)]
    pub in_viewport: bool,
}

pub fn remove_generation(tab_id: i64) {
    super::ref_context::remove(tab_id);
    if let Ok(mut guard) = generations().lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&tab_id);
        }
    }
    if let Ok(mut guard) = REF_FRAME_TARGETS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&tab_id);
        }
    }
}

pub fn clear_generations() {
    super::ref_context::clear();
    if let Ok(mut guard) = generations().lock() {
        if let Some(map) = guard.as_mut() {
            map.clear();
        }
    }
    if let Ok(mut guard) = REF_FRAME_TARGETS.lock() {
        if let Some(map) = guard.as_mut() {
            map.clear();
        }
    }
}

pub fn replace_ref_frame_targets(tab_id: i64, targets: HashMap<String, RefFrameTarget>) {
    let mut guard = REF_FRAME_TARGETS.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(tab_id, targets);
}

pub fn get_ref_frame_target(tab_id: i64, ref_id: &str) -> Option<RefFrameTarget> {
    REF_FRAME_TARGETS
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref()?.get(&tab_id)?.get(ref_id).cloned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPayload {
    pub title: String,
    pub url: String,
    pub elements: Vec<SnapshotElement>,
    #[serde(default)]
    pub source_truncated: bool,
}

pub fn build_snapshot_js(generation_id: u64) -> String {
    build_snapshot_js_with_prefix(generation_id, &format!("g{generation_id}-e"))
}

pub fn build_frame_snapshot_js(generation_id: u64, frame_index: usize) -> String {
    build_snapshot_js_with_prefix(generation_id, &format!("g{generation_id}-f{frame_index}-e"))
}

fn build_snapshot_js_with_prefix(generation_id: u64, ref_prefix: &str) -> String {
    format!(
        r#"(function() {{
            const gen = "gen-{generation_id}";
            const refPrefix = {ref_prefix_json};
            {REF_REGISTRY_JS}
            refRegistry.begin({generation_id});
            let refIdx = 1;
            const elements = [];
            const viewportElements = [];
            const referenceNodes = new Map();
            const maxItems = 1000;
            const maxNodes = 50000;
            let scannedNodes = 0;
            let sourceTruncated = false;

            function add(item) {{
                const bucket = item.in_viewport ? viewportElements : elements;
                if (bucket.length >= maxItems) {{
                    sourceTruncated = true;
                    return false;
                }}
                bucket.push(item);
                return true;
            }}

            {VISIBILITY_JS}
            {ACCESSIBLE_NAME_JS}
            const isVisible = isRenderedElement;

            function isInViewport(el) {{
                const rect = el.getBoundingClientRect();
                return rect.bottom >= 0 && rect.right >= 0 &&
                       rect.top <= window.innerHeight && rect.left <= window.innerWidth;
            }}

            function processShadow(el, depth) {{
                if (!el || !el.shadowRoot) return;
                for (let i = 0; i < el.shadowRoot.childNodes.length; i++) {{
                    process(el.shadowRoot.childNodes[i], depth + 1);
                    if (scannedNodes >= maxNodes) {{ sourceTruncated = true; break; }}
                }}
            }}

            // A run of text is whatever sits on one line of layout: inline
            // boxes, however many elements the page split them across. The
            // nearest ancestor that is not inline is where that run lives.
            const emittedRuns = new Set();
            const isInlineBox = el => {{
                try {{
                    return /^(inline|contents)/.test(String(getComputedStyle(el).display || ''));
                }} catch (error) {{
                    return false;
                }}
            }};
            function nearestBlock(el) {{
                for (let depth = 0; el && depth <= 32; el = el.parentElement, depth++) {{
                    if (!isInlineBox(el)) return el;
                }}
                return el || null;
            }}
            function inlineRunText(host) {{
                let out = '';
                const walk = (node, depth) => {{
                    if (!node || depth > 32 || out.length > 4096) return;
                    if (node.nodeType === 3) {{ out += node.textContent || ''; return; }}
                    if (node.nodeType !== 1) return;
                    const tag = node.tagName.toLowerCase();
                    if (['script', 'style', 'noscript', 'template'].includes(tag)) return;
                    if (node !== host && !isInlineBox(node)) return;
                    for (const child of node.childNodes) walk(child, depth + 1);
                }};
                walk(host, 0);
                return out.replace(/\s+/g, ' ').trim();
            }}

            function process(node, depth = 0) {{
                if (!node) return;
                if (scannedNodes >= maxNodes || depth > 256) {{
                    sourceTruncated = true;
                    return;
                }}
                scannedNodes++;
                if (node.nodeType === 3) {{
                    // Emit the whole inline run at once, not one item per text
                    // node. A ticker that redraws a changing digit as its own
                    // span was reported as "99.02" and "8" on two lines, which
                    // reads as two numbers and is neither of them.
                    const host = nearestBlock(node.parentElement);
                    if (host && !emittedRuns.has(host) &&
                        isVisible(host) && isInViewport(host)) {{
                        emittedRuns.add(host);
                        const tag = host.tagName.toLowerCase();
                        if (!['button', 'a', 'option', 'script', 'style'].includes(tag)) {{
                            const t = inlineRunText(host);
                            if (t.length > 0) {{
                                add({{
                                    type: 'text',
                                    text: t.substring(0, 300),
                                    in_viewport: true
                                }});
                            }}
                        }}
                    }}
                    return;
                }}
                if (node.nodeType !== 1) return;
                const el = node;
                const tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

                const roleAttr = el.getAttribute('role') || '';
                const inputType = tag === 'input'
                    ? (el.getAttribute('type') || 'text').toLowerCase()
                    : '';
                const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
                                      el.hasAttribute('onclick') ||
                                      roleAttr === 'button' || roleAttr === 'checkbox' || roleAttr === 'link' ||
                                      el.getAttribute('contenteditable') === 'true';
                // File inputs are commonly intentionally hidden behind an
                // upload button (including YouTube Studio). CDP can safely set
                // them without opening a native file chooser, so retain a ref.
                const isHiddenFileInput = tag === 'input' && inputType === 'file';

                if (isInteractive && (isVisible(el) || isHiddenFileInput)) {{
                    const inViewport = isInViewport(el);
                    if ((inViewport ? viewportElements : elements).length >= maxItems) {{
                        sourceTruncated = true;
                        processShadow(el, depth);
                        return;
                    }}
                    const ref = refPrefix + (refIdx++);
                    referenceNodes.set(ref, el);

                    let role = roleAttr || tag;
                    if (tag === 'input') {{
                        role = 'input[' + inputType + ']';
                    }}

                    const isPassword = tag === 'input' && inputType === 'password';
                    let val = el.value == null ? null : String(el.value).substring(0, 300);
                    if (isPassword) {{
                        val = '[REDACTED]';
                    }}

                    const label = accessibleName(el).substring(0, 100);

                    add({{
                        type: 'element',
                        ref_id: ref,
                        tag: tag,
                        role: role,
                        label: label,
                        value: val,
                        checked: typeof el.checked === 'boolean' ? el.checked : null,
                        disabled: el.disabled || false,
                        in_viewport: inViewport
                    }});
                    processShadow(el, depth);
                    return;
                }}

                for (let i = 0; i < el.childNodes.length; i++) {{
                    process(el.childNodes[i], depth + 1);
                    if (scannedNodes >= maxNodes) {{ sourceTruncated = true; break; }}
                }}
                // Traverse open Shadow DOM roots used by modern upload UIs.
                // Closed roots remain inaccessible by browser design.
                processShadow(el, depth);
            }}

            if (document.body) {{
                process(document.body);
            }}

            const prioritized = viewportElements.concat(elements);
            sourceTruncated ||= prioritized.length > maxItems;
            const selected = prioritized.slice(0, maxItems);
            for (const item of selected) {{
                const el = referenceNodes.get(item.ref_id);
                if (el) {{
                    refRegistry.remember(item.ref_id, el);
                }}
            }}
            return JSON.stringify({{
                title: (document.title || "").substring(0, 500),
                url: (window.location.href || "").substring(0, 2000),
                elements: selected,
                source_truncated: sourceTruncated
            }});
        }})();"#,
        ref_prefix_json = serde_json::to_string(ref_prefix).unwrap()
    )
}

pub struct FormattedSnapshot {
    pub text: String,
    pub truncated: bool,
    pub included_items: usize,
    pub total_items: usize,
    pub max_chars: usize,
    pub offset: usize,
    /// Where to continue, when there is more of the same page to read.
    pub next_offset: Option<usize>,
}

pub fn prioritize_snapshot_elements(elements: &mut Vec<SnapshotElement>, limit: usize) -> bool {
    elements.sort_by_key(|element| !element.in_viewport);
    let truncated = elements.len() > limit;
    elements.truncate(limit);
    truncated
}

fn format_item(item: &SnapshotElement) -> Option<String> {
    if item.element_type == "text" {
        return item.text.as_ref().map(|text| format!("  Text: {text}"));
    }
    let ref_id = item.ref_id.as_ref()?;
    let role = item.role.as_deref().unwrap_or("element");
    let label = item.label.as_deref().unwrap_or("");
    // A link with no name, no text and no value cannot be described to anyone,
    // and cannot be chosen from a list of its identical siblings either. A feed
    // page produced dozens of them, each spending budget that a usable element
    // could have had.
    if label.trim().is_empty()
        && item.value.as_deref().unwrap_or("").trim().is_empty()
        && item.checked.is_none()
        && matches!(role, "link" | "element" | "img" | "generic")
    {
        return None;
    }
    let mut extra = String::new();
    if let Some(value) = &item.value {
        if !value.is_empty() && role.starts_with("input") {
            extra.push_str(&format!(" [value=\"{value}\"]"));
        }
    }
    if let Some(true) = item.checked {
        extra.push_str(" [checked]");
    }
    if let Some(true) = item.disabled {
        extra.push_str(" [disabled]");
    }
    Some(format!("[{ref_id}] <{role}> {label}{extra}"))
}

pub fn format_snapshot(
    payload: &SnapshotPayload,
    generation_id: u64,
    requested_max_chars: usize,
    offset: usize,
) -> FormattedSnapshot {
    let max_chars = requested_max_chars.clamp(MIN_SNAPSHOT_MAX_CHARS, MAX_SNAPSHOT_MAX_CHARS);
    let title = payload.title.chars().take(200).collect::<String>();
    let url = payload.url.chars().take(max_chars / 4).collect::<String>();
    let metadata_truncated = title != payload.title || url != payload.url;
    let mut lines = Vec::new();
    lines.push(format!("Title: {title}"));
    lines.push(format!("URL: {url}"));
    lines.push(format!("Generation: {generation_id}"));
    lines.push(format!(
        "Scope: viewport text first, then interactive elements; limit {max_chars} characters"
    ));
    lines.push("---".to_string());

    let mut candidates: Vec<String> = payload
        .elements
        .iter()
        .filter(|item| item.in_viewport)
        .filter_map(format_item)
        .collect::<Vec<_>>();
    candidates.extend(
        payload
            .elements
            .iter()
            .filter(|item| !item.in_viewport && item.element_type != "text")
            .filter_map(format_item),
    );

    let total_items = candidates.len();
    // Scrolling was the only way past the first screenful, though the rest was
    // already in the DOM and already measured: gathering 617 elements costs the
    // same however much of it is read back.
    let offset = offset.min(total_items);
    let candidates = candidates.split_off(offset);
    let content_limit = max_chars.saturating_sub(160);
    let mut current_chars = lines
        .iter()
        .map(|line| line.chars().count() + 1)
        .sum::<usize>();
    let mut included_items = 0;
    let mut truncated = payload.source_truncated || metadata_truncated;

    for line in candidates {
        if current_chars + line.chars().count() + 1 > content_limit {
            truncated = true;
            break;
        }
        current_chars += line.chars().count() + 1;
        lines.push(line);
        included_items += 1;
    }

    let next_offset = offset + included_items;
    if truncated {
        let more = total_items.saturating_sub(next_offset);
        lines.push(if more > 0 {
            format!(
                "[truncated: showing items {}-{next_offset} of {total_items}; call again with offset={next_offset} for the next {more}]",
                offset + 1
            )
        } else {
            format!(
                "[truncated: showing items {}-{next_offset} of {total_items}]",
                offset + 1
            )
        });
    }

    FormattedSnapshot {
        text: lines.join("\n"),
        truncated,
        included_items,
        total_items,
        max_chars,
        offset,
        next_offset: (next_offset < total_items).then_some(next_offset),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_snapshot() {
        let payload = SnapshotPayload {
            title: "Test Page".to_string(),
            url: "http://localhost:5173".to_string(),
            elements: vec![
                SnapshotElement {
                    element_type: "text".to_string(),
                    ref_id: None,
                    tag: None,
                    role: None,
                    label: None,
                    value: None,
                    checked: None,
                    disabled: None,
                    text: Some("Welcome to Test Page".to_string()),
                    in_viewport: true,
                },
                SnapshotElement {
                    element_type: "element".to_string(),
                    ref_id: Some("g1-e1".to_string()),
                    tag: Some("button".to_string()),
                    role: Some("button".to_string()),
                    label: Some("Click Me".to_string()),
                    value: None,
                    checked: None,
                    disabled: Some(false),
                    text: None,
                    in_viewport: true,
                },
            ],
            source_truncated: false,
        };

        let formatted = format_snapshot(&payload, 1, DEFAULT_SNAPSHOT_MAX_CHARS, 0);
        assert!(formatted.text.contains("Title: Test Page"));
        assert!(formatted.text.contains("Generation: 1"));
        assert!(formatted.text.contains("[g1-e1] <button> Click Me"));
        assert!(!formatted.truncated);
    }

    #[test]
    fn test_generation_counter() {
        let tab_id = 999;
        let gen1 = get_next_generation(tab_id);
        let cur = get_current_generation(tab_id);
        assert_eq!(gen1, cur);
        let gen2 = get_next_generation(tab_id);
        assert_eq!(gen2, gen1 + 1);
    }

    #[test]
    fn test_password_redaction_format() {
        let payload = SnapshotPayload {
            title: "Login".to_string(),
            url: "http://localhost/login".to_string(),
            elements: vec![SnapshotElement {
                element_type: "element".to_string(),
                ref_id: Some("g1-e1".to_string()),
                tag: Some("input".to_string()),
                role: Some("input[password]".to_string()),
                label: Some("Password".to_string()),
                value: Some("[REDACTED]".to_string()),
                checked: None,
                disabled: Some(false),
                text: None,
                in_viewport: true,
            }],
            source_truncated: false,
        };

        let formatted = format_snapshot(&payload, 1, DEFAULT_SNAPSHOT_MAX_CHARS, 0);
        assert!(formatted.text.contains("[value=\"[REDACTED]\"]"));
    }

    #[test]
    fn child_frame_snapshot_uses_namespaced_refs() {
        let script = build_frame_snapshot_js(4, 2);
        assert!(script.contains(r#"const refPrefix = "g4-f2-e""#));
        assert!(script.contains("const gen = \"gen-4\""));
    }

    #[test]
    fn snapshot_keeps_hidden_file_inputs_and_open_shadow_roots() {
        let script = build_snapshot_js(8);
        assert!(
            script.contains("const isHiddenFileInput = tag === 'input' && inputType === 'file'")
        );
        assert!(script.contains("isVisible(el) || isHiddenFileInput"));
        assert!(script.contains("el.shadowRoot.childNodes"));
    }

    #[test]
    fn ref_frame_targets_are_replaced_per_snapshot() {
        let tab_id = 98_765;
        replace_ref_frame_targets(
            tab_id,
            HashMap::from([(
                "g1-f1-e1".to_string(),
                RefFrameTarget {
                    frame_id: "child-a".to_string(),
                    is_main: false,
                },
            )]),
        );
        assert_eq!(
            get_ref_frame_target(tab_id, "g1-f1-e1"),
            Some(RefFrameTarget {
                frame_id: "child-a".to_string(),
                is_main: false,
            })
        );
        replace_ref_frame_targets(tab_id, HashMap::new());
        assert!(get_ref_frame_target(tab_id, "g1-f1-e1").is_none());
        remove_generation(tab_id);
    }

    #[test]
    fn snapshot_output_is_hard_capped_and_reports_truncation() {
        let payload = SnapshotPayload {
            title: "Large".to_string(),
            url: "https://example.com".to_string(),
            elements: (1..500)
                .map(|index| SnapshotElement {
                    element_type: "element".to_string(),
                    ref_id: Some(format!("g1-e{index}")),
                    tag: Some("a".to_string()),
                    role: Some("a".to_string()),
                    label: Some("x".repeat(100)),
                    value: None,
                    checked: None,
                    disabled: Some(false),
                    text: None,
                    in_viewport: false,
                })
                .collect(),
            source_truncated: false,
        };

        let formatted = format_snapshot(&payload, 1, usize::MAX, 0);
        assert!(formatted.truncated);
        assert_eq!(formatted.max_chars, MAX_SNAPSHOT_MAX_CHARS);
        assert!(formatted.text.chars().count() <= MAX_SNAPSHOT_MAX_CHARS);
        assert!(formatted.text.contains("[truncated: showing"));
    }

    #[test]
    fn snapshot_refs_include_the_generation() {
        let script = build_snapshot_js(42);
        assert!(script.contains(r#"const refPrefix = "g42-e""#));
        assert!(script.contains("const ref = refPrefix + (refIdx++);"));
        assert!(script.contains("const gen = \"gen-42\";"));
    }

    #[test]
    fn long_unicode_metadata_cannot_exceed_the_smallest_snapshot_budget() {
        let payload = SnapshotPayload {
            title: "界".repeat(500),
            url: format!("https://example.test/?{}", "界".repeat(2000)),
            elements: Vec::new(),
            source_truncated: false,
        };
        let formatted = format_snapshot(&payload, u64::MAX, 2000, 0);
        assert!(formatted.truncated);
        assert!(formatted.text.chars().count() <= 2000);
        assert!(formatted.text.contains("[truncated: showing"));
    }

    #[test]
    fn visible_child_frame_items_displace_offscreen_root_items_stably() {
        let mut elements = (0..4)
            .map(|index| SnapshotElement {
                element_type: "element".to_string(),
                ref_id: Some(format!("g1-e{index}")),
                tag: Some("button".to_string()),
                role: Some("button".to_string()),
                label: None,
                value: None,
                checked: None,
                disabled: None,
                text: None,
                in_viewport: index >= 2,
            })
            .collect::<Vec<_>>();
        assert!(prioritize_snapshot_elements(&mut elements, 3));
        assert_eq!(
            elements
                .iter()
                .map(|item| item.ref_id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["g1-e2", "g1-e3", "g1-e0"]
        );
        assert!(!prioritize_snapshot_elements(&mut elements, 3));
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

static SNAPSHOT_GENERATIONS: Mutex<Option<HashMap<i64, u64>>> = Mutex::new(None);

pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 8_000;
pub const MIN_SNAPSHOT_MAX_CHARS: usize = 2_000;
pub const MAX_SNAPSHOT_MAX_CHARS: usize = 16_000;

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
    if let Ok(mut guard) = generations().lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&tab_id);
        }
    }
}

pub fn clear_generations() {
    if let Ok(mut guard) = generations().lock() {
        if let Some(map) = guard.as_mut() {
            map.clear();
        }
    }
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
    format!(
        r#"(function() {{
            const gen = "gen-{generation_id}";
            let refIdx = 1;
            const elements = [];
            const maxItems = 1000;
            let sourceTruncated = false;

            function add(item) {{
                if (elements.length >= maxItems) {{
                    sourceTruncated = true;
                    return false;
                }}
                elements.push(item);
                return true;
            }}

            try {{
                document.querySelectorAll('[data-anbo-ref]').forEach(el => {{
                    el.removeAttribute('data-anbo-ref');
                    el.removeAttribute('data-anbo-gen');
                }});
            }} catch(e) {{}}

            function isVisible(el) {{
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }}

            function isInViewport(el) {{
                const rect = el.getBoundingClientRect();
                return rect.bottom >= 0 && rect.right >= 0 &&
                       rect.top <= window.innerHeight && rect.left <= window.innerWidth;
            }}

            function process(node) {{
                if (!node) return;
                if (elements.length >= maxItems) {{
                    sourceTruncated = true;
                    return;
                }}
                if (node.nodeType === 3) {{
                    const t = (node.textContent || "").trim();
                    if (t.length > 0 && node.parentElement &&
                        isVisible(node.parentElement) && isInViewport(node.parentElement)) {{
                        const tag = node.parentElement.tagName.toLowerCase();
                        if (!['button', 'a', 'option', 'script', 'style'].includes(tag)) {{
                            add({{
                                type: 'text',
                                text: t.substring(0, 300),
                                in_viewport: true
                            }});
                        }}
                    }}
                    return;
                }}
                if (node.nodeType !== 1) return;
                const el = node;
                const tag = el.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

                const roleAttr = el.getAttribute('role') || '';
                const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
                                      el.hasAttribute('onclick') ||
                                      roleAttr === 'button' || roleAttr === 'checkbox' || roleAttr === 'link' ||
                                      el.getAttribute('contenteditable') === 'true';

                if (isInteractive && isVisible(el)) {{
                    const ref = 'g{generation_id}-e' + (refIdx++);
                    el.setAttribute('data-anbo-ref', ref);
                    el.setAttribute('data-anbo-gen', gen);

                    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
                    let role = roleAttr || tag;
                    if (tag === 'input') {{
                        role = 'input[' + inputType + ']';
                    }}

                    const isPassword = tag === 'input' && inputType === 'password';
                    let val = el.value == null ? null : String(el.value).substring(0, 300);
                    if (isPassword) {{
                        val = '[REDACTED]';
                    }}

                    const labelledBy = (el.getAttribute('aria-labelledby') || '')
                        .split(/\s+/)
                        .filter(Boolean)
                        .map(id => document.getElementById(id))
                        .filter(Boolean)
                        .map(node => (node.innerText || node.textContent || '').trim())
                        .filter(Boolean)
                        .join(' ');
                    const labels = el.labels
                        ? Array.from(el.labels).map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean).join(' ')
                        : '';
                    const descendant = el.querySelector('[aria-label], img[alt], [alt], [title]');
                    let label = el.getAttribute('aria-label') ||
                                el.getAttribute('placeholder') ||
                                el.getAttribute('alt') ||
                                el.getAttribute('title') ||
                                labelledBy ||
                                labels ||
                                (descendant && (descendant.getAttribute('aria-label') || descendant.getAttribute('alt') || descendant.getAttribute('title'))) ||
                                (isPassword ? '' : (el.innerText || '')) ||
                                '';
                    label = label.trim().replace(/\s+/g, ' ').substring(0, 100);

                    add({{
                        type: 'element',
                        ref_id: ref,
                        tag: tag,
                        role: role,
                        label: label,
                        value: val,
                        checked: typeof el.checked === 'boolean' ? el.checked : null,
                        disabled: el.disabled || false,
                        in_viewport: isInViewport(el)
                    }});
                    return;
                }}

                for (let i = 0; i < el.childNodes.length; i++) {{
                    process(el.childNodes[i]);
                    if (elements.length >= maxItems) break;
                }}
            }}

            if (document.body) {{
                process(document.body);
            }}

            return JSON.stringify({{
                title: (document.title || "").substring(0, 500),
                url: (window.location.href || "").substring(0, 2000),
                elements: elements,
                source_truncated: sourceTruncated
            }});
        }})();"#
    )
}

pub struct FormattedSnapshot {
    pub text: String,
    pub truncated: bool,
    pub included_items: usize,
    pub total_items: usize,
    pub max_chars: usize,
}

fn format_item(item: &SnapshotElement) -> Option<String> {
    if item.element_type == "text" {
        return item.text.as_ref().map(|text| format!("  Text: {text}"));
    }
    let ref_id = item.ref_id.as_ref()?;
    let role = item.role.as_deref().unwrap_or("element");
    let label = item.label.as_deref().unwrap_or("");
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
) -> FormattedSnapshot {
    let max_chars = requested_max_chars.clamp(MIN_SNAPSHOT_MAX_CHARS, MAX_SNAPSHOT_MAX_CHARS);
    let mut lines = Vec::new();
    lines.push(format!("Title: {}", payload.title));
    lines.push(format!("URL: {}", payload.url));
    lines.push(format!("Generation: {generation_id}"));
    lines.push(format!(
        "Scope: viewport text first, then interactive elements; limit {max_chars} characters"
    ));
    lines.push("---".to_string());

    let mut candidates = payload
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
    let content_limit = max_chars.saturating_sub(160);
    let mut current_chars = lines
        .iter()
        .map(|line| line.chars().count() + 1)
        .sum::<usize>();
    let mut included_items = 0;
    let mut truncated = payload.source_truncated;

    for line in candidates {
        if current_chars + line.chars().count() + 1 > content_limit {
            truncated = true;
            break;
        }
        current_chars += line.chars().count() + 1;
        lines.push(line);
        included_items += 1;
    }

    if truncated {
        lines.push(format!(
            "[truncated: showing {included_items} of {total_items} items; scroll and snapshot again for nearby content]"
        ));
    }

    FormattedSnapshot {
        text: lines.join("\n"),
        truncated,
        included_items,
        total_items,
        max_chars,
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

        let formatted = format_snapshot(&payload, 1, DEFAULT_SNAPSHOT_MAX_CHARS);
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

        let formatted = format_snapshot(&payload, 1, DEFAULT_SNAPSHOT_MAX_CHARS);
        assert!(formatted.text.contains("[value=\"[REDACTED]\"]"));
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

        let formatted = format_snapshot(&payload, 1, usize::MAX);
        assert!(formatted.truncated);
        assert_eq!(formatted.max_chars, MAX_SNAPSHOT_MAX_CHARS);
        assert!(formatted.text.chars().count() <= MAX_SNAPSHOT_MAX_CHARS);
        assert!(formatted.text.contains("[truncated: showing"));
    }

    #[test]
    fn snapshot_refs_include_the_generation() {
        let script = build_snapshot_js(42);
        assert!(script.contains("const ref = 'g42-e' + (refIdx++);"));
        assert!(script.contains("const gen = \"gen-42\";"));
    }
}

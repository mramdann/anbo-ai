use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

static SNAPSHOT_GENERATIONS: Mutex<Option<HashMap<i64, u64>>> = Mutex::new(None);

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPayload {
    pub title: String,
    pub url: String,
    pub elements: Vec<SnapshotElement>,
}

pub fn build_snapshot_js(generation_id: u64) -> String {
    format!(
        r#"(function() {{
            const gen = "gen-{generation_id}";
            let refIdx = 1;
            const elements = [];

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

            function process(node) {{
                if (!node) return;
                if (node.nodeType === 3) {{
                    const t = (node.textContent || "").trim();
                    if (t.length > 0 && node.parentElement && isVisible(node.parentElement)) {{
                        const tag = node.parentElement.tagName.toLowerCase();
                        if (!['button', 'a', 'option', 'script', 'style'].includes(tag)) {{
                            elements.push({{ type: 'text', text: t.substring(0, 300) }});
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
                    const ref = 'e' + (refIdx++);
                    el.setAttribute('data-anbo-ref', ref);
                    el.setAttribute('data-anbo-gen', gen);

                    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
                    let role = roleAttr || tag;
                    if (tag === 'input') {{
                        role = 'input[' + inputType + ']';
                    }}

                    const isPassword = tag === 'input' && inputType === 'password';
                    let val = el.value || null;
                    if (isPassword) {{
                        val = '[REDACTED]';
                    }}

                    let label = el.getAttribute('aria-label') ||
                                el.getAttribute('placeholder') ||
                                el.getAttribute('title') ||
                                (isPassword ? '' : (el.innerText || '')) ||
                                '';
                    label = label.trim().replace(/\s+/g, ' ').substring(0, 100);

                    elements.push({{
                        type: 'element',
                        ref_id: ref,
                        tag: tag,
                        role: role,
                        label: label,
                        value: val,
                        checked: typeof el.checked === 'boolean' ? el.checked : null,
                        disabled: el.disabled || false
                    }});
                    return;
                }}

                for (let i = 0; i < el.childNodes.length; i++) {{
                    process(el.childNodes[i]);
                }}
            }}

            if (document.body) {{
                process(document.body);
            }}

            return JSON.stringify({{
                title: document.title || "",
                url: window.location.href || "",
                elements: elements
            }});
        }})();"#
    )
}

pub fn format_snapshot(payload: &SnapshotPayload, generation_id: u64) -> String {
    let mut lines = Vec::new();
    lines.push(format!("Title: {}", payload.title));
    lines.push(format!("URL: {}", payload.url));
    lines.push(format!("Generation: {generation_id}"));
    lines.push("---".to_string());

    let max_bytes = 256 * 1024;
    let mut current_bytes = lines.iter().map(|l| l.len() + 1).sum::<usize>();
    let mut truncated = false;

    for item in &payload.elements {
        let line = if item.element_type == "text" {
            item.text.as_ref().map(|t| format!("  Text: {t}"))
        } else if let Some(ref_id) = &item.ref_id {
            let role = item.role.as_deref().unwrap_or("element");
            let label = item.label.as_deref().unwrap_or("");
            let mut extra = String::new();
            if let Some(v) = &item.value {
                if !v.is_empty() && role.starts_with("input") {
                    extra.push_str(&format!(" [value=\"{v}\"]"));
                }
            }
            if let Some(true) = item.checked {
                extra.push_str(" [checked]");
            }
            if let Some(true) = item.disabled {
                extra.push_str(" [disabled]");
            }

            Some(format!("[{ref_id}] <{role}> {label}{extra}"))
        } else {
            None
        };

        if let Some(line) = line {
            if current_bytes + line.len() + 1 > max_bytes {
                lines.push("[truncated: true]".to_string());
                truncated = true;
                break;
            }
            current_bytes += line.len() + 1;
            lines.push(line);
        }
    }

    let _ = truncated;
    lines.join("\n")
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
                },
                SnapshotElement {
                    element_type: "element".to_string(),
                    ref_id: Some("e1".to_string()),
                    tag: Some("button".to_string()),
                    role: Some("button".to_string()),
                    label: Some("Click Me".to_string()),
                    value: None,
                    checked: None,
                    disabled: Some(false),
                    text: None,
                },
            ],
        };

        let formatted = format_snapshot(&payload, 1);
        assert!(formatted.contains("Title: Test Page"));
        assert!(formatted.contains("Generation: 1"));
        assert!(formatted.contains("[e1] <button> Click Me"));
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
                ref_id: Some("e1".to_string()),
                tag: Some("input".to_string()),
                role: Some("input[password]".to_string()),
                label: Some("Password".to_string()),
                value: Some("[REDACTED]".to_string()),
                checked: None,
                disabled: Some(false),
                text: None,
            }],
        };

        let formatted = format_snapshot(&payload, 1);
        assert!(formatted.contains("[value=\"[REDACTED]\"]"));
    }
}

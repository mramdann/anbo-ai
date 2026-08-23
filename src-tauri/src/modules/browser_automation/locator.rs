use serde::{Deserialize, Serialize};

pub const MAX_LOCATOR_MATCHES: usize = 20;

#[derive(Clone, Copy)]
pub struct LocatorQuery<'a> {
    pub by: &'a str,
    pub value: &'a str,
    pub name: Option<&'a str>,
    pub exact: bool,
    pub include_hidden: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatorMatch {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub tag: String,
    pub role: String,
    pub name: String,
    pub text: String,
    pub value: Option<String>,
    pub visible: bool,
    pub enabled: bool,
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatorPayload {
    pub matches: Vec<LocatorMatch>,
    #[serde(default)]
    pub scanned: usize,
    #[serde(default)]
    pub truncated: bool,
    pub error: Option<String>,
}

pub fn build_find_js(generation: u64, ref_prefix: &str, query: &LocatorQuery<'_>) -> String {
    let limit = query.limit.clamp(1, MAX_LOCATOR_MATCHES);
    format!(
        r#"(function() {{
            const generation = "gen-{generation}";
            const refPrefix = {ref_prefix};
            const by = {by};
            const wanted = {value};
            const wantedName = {name};
            const exact = {exact};
            const includeHidden = {include_hidden};
            const limit = {limit};
            const maxScanned = 50000;
            const matches = [];
            let scanned = 0;
            let truncated = false;

            const normalize = input => String(input || '').replace(/\s+/g, ' ').trim();
            const compareValue = (input, expected) => {{
                const left = normalize(input).toLocaleLowerCase();
                const right = normalize(expected).toLocaleLowerCase();
                return exact ? left === right : left.includes(right);
            }};
            const compare = input => compareValue(input, wanted);
            const implicitRole = el => {{
                const explicit = normalize(el.getAttribute('role')).split(' ')[0];
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'a' && el.hasAttribute('href')) return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
                if (tag === 'option') return 'option';
                if (tag === 'img') return 'img';
                if (tag === 'input') {{
                    const type = String(el.type || 'text').toLowerCase();
                    if (type === 'checkbox') return 'checkbox';
                    if (type === 'radio') return 'radio';
                    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
                    if (type === 'range') return 'slider';
                    if (type === 'number') return 'spinbutton';
                    if (type !== 'hidden') return 'textbox';
                }}
                return '';
            }};
            const labelName = el => {{
                const labelledBy = normalize(el.getAttribute('aria-labelledby'))
                    .split(/\s+/)
                    .filter(Boolean)
                    .map(id => document.getElementById(id))
                    .filter(Boolean)
                    .map(node => normalize(node.innerText || node.textContent))
                    .filter(Boolean)
                    .join(' ');
                const labels = el.labels
                    ? Array.from(el.labels).map(node => normalize(node.innerText || node.textContent)).filter(Boolean).join(' ')
                    : '';
                return normalize(el.getAttribute('aria-label') || labelledBy || labels);
            }};
            const accessibleName = el => {{
                return normalize(
                    labelName(el) ||
                    el.getAttribute('alt') || el.getAttribute('title') ||
                    el.getAttribute('placeholder') || el.innerText || el.textContent
                );
            }};
            const visible = el => {{
                if (!el.isConnected) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.visibility !== 'collapse' && Number(style.opacity || 1) > 0;
            }};
            const isMatch = el => {{
                if (by === 'css') {{
                    try {{ return el.matches(wanted); }} catch (_) {{ throw new Error('invalid_selector'); }}
                }}
                if (by === 'role') {{
                    return compare(implicitRole(el)) &&
                        (!wantedName || compareValue(accessibleName(el), wantedName));
                }}
                if (by === 'text') {{
                    if (!compare(el.innerText || el.textContent)) return false;
                    if (implicitRole(el)) return true;
                    return !Array.from(el.children || []).some(child =>
                        compare(child.innerText || child.textContent)
                    );
                }}
                if (by === 'label') {{
                    const label = labelName(el);
                    return !!label && compare(label);
                }}
                if (by === 'placeholder') return compare(el.getAttribute('placeholder'));
                if (by === 'testId') return compare(el.getAttribute('data-testid'));
                if (by === 'title') return compare(el.getAttribute('title'));
                if (by === 'alt') return compare(el.getAttribute('alt'));
                return false;
            }};
            const clearRefs = root => {{
                if (!root || !root.querySelectorAll) return;
                for (const el of root.querySelectorAll('[data-anbo-ref]')) {{
                    el.removeAttribute('data-anbo-ref');
                    el.removeAttribute('data-anbo-gen');
                }}
                for (const el of root.querySelectorAll('*')) {{
                    if (el.shadowRoot) clearRefs(el.shadowRoot);
                }}
            }};
            const visit = root => {{
                if (!root || !root.querySelectorAll || matches.length >= limit) return;
                const elements = root.querySelectorAll('*');
                for (let index = 0; index < elements.length; index++) {{
                    if (matches.length >= limit) break;
                    if (scanned >= maxScanned) {{ truncated = true; break; }}
                    const el = elements[index];
                    scanned += 1;
                    const isVisible = visible(el);
                    if ((includeHidden || isVisible) && isMatch(el)) {{
                        const ref = refPrefix + (matches.length + 1);
                        el.setAttribute('data-anbo-ref', ref);
                        el.setAttribute('data-anbo-gen', generation);
                        const type = el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '';
                        const password = type === 'password';
                        matches.push({{
                            ref,
                            tag: el.tagName.toLowerCase(),
                            role: implicitRole(el),
                            name: accessibleName(el).slice(0, 300),
                            text: normalize(el.innerText || el.textContent).slice(0, 500),
                            value: password ? '[REDACTED]' : (el.value == null ? null : String(el.value).slice(0, 500)),
                            visible: isVisible,
                            enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
                            checked: typeof el.checked === 'boolean' ? el.checked : null
                        }});
                    }}
                    if (el.shadowRoot) visit(el.shadowRoot);
                }}
            }};

            try {{
                clearRefs(document);
                visit(document);
                return JSON.stringify({{ matches, scanned, truncated, error: null }});
            }} catch (error) {{
                return JSON.stringify({{
                    matches: [],
                    scanned,
                    truncated,
                    error: error && error.message === 'invalid_selector' ? 'invalid_selector' : 'locator_failed'
                }});
            }}
        }})()"#,
        ref_prefix = serde_json::to_string(ref_prefix).unwrap(),
        by = serde_json::to_string(query.by).unwrap(),
        value = serde_json::to_string(query.value).unwrap(),
        name = serde_json::to_string(&query.name).unwrap(),
        exact = query.exact,
        include_hidden = query.include_hidden,
        limit = limit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_script_keeps_queries_as_json_data() {
        let script = build_find_js(
            4,
            "g4-e",
            &LocatorQuery {
                by: "text",
                value: "a\"b",
                name: None,
                exact: true,
                include_hidden: false,
                limit: 100,
            },
        );
        assert!(script.contains(r#"const wanted = "a\"b";"#));
        assert!(script.contains("const limit = 20;"));
        assert!(script.contains("data-anbo-ref"));
    }

    #[test]
    fn role_locator_can_filter_by_accessible_name() {
        let script = build_find_js(
            2,
            "g2-e",
            &LocatorQuery {
                by: "role",
                value: "button",
                name: Some("Save changes"),
                exact: false,
                include_hidden: false,
                limit: 10,
            },
        );
        assert!(script.contains(r#"const wantedName = "Save changes";"#));
        assert!(script.contains("compareValue(accessibleName(el), wantedName)"));
    }
}

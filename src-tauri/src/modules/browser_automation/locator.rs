use serde::{Deserialize, Serialize};

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::ref_context::REF_REGISTRY_JS;
use super::visibility::VISIBILITY_JS;

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
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub in_viewport: bool,
    #[serde(default)]
    pub bounds: Option<LocatorBounds>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocatorBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatorPayload {
    pub matches: Vec<LocatorMatch>,
    #[serde(default)]
    pub visual_point: Option<super::activity::Point>,
    #[serde(default)]
    pub scanned: usize,
    #[serde(default)]
    pub truncated: bool,
    /// Elements that matched the locator but were dropped as not rendered.
    ///
    /// Without this a caller cannot tell "this page has no such element" from
    /// "it is there, behind a collapsed menu" -- the two readings lead to
    /// opposite next steps.
    #[serde(default)]
    pub hidden: usize,
    /// A few accessible names that carried the wanted role but not the wanted
    /// name, so a near miss can say what it saw instead.
    #[serde(default)]
    pub name_misses: Vec<String>,
    pub error: Option<String>,
}

/// A page that cannot have changed cannot produce a different answer.
///
/// Retrying a locator re-walked the whole document every 150ms -- 141 full
/// scans inside a 30-second lookup on a 16,000-node article, each one running
/// on the page's own main thread for nothing. This installs one counter so a
/// retry can ask the cheap question first: has anything moved since the scan
/// that already said no?
///
/// A page with a running animation is never called quiet: appearance can
/// change there without a mutation to observe. Neither is a page whose
/// observer could not be installed, which reports -1 and keeps the old
/// behaviour of scanning every time.
pub const PAGE_SCAN_STATE_JS: &str = r#"(function() {
    const state = (() => {
        if (window.__anboScanState) return window.__anboScanState;
        const created = { id: Math.random().toString(36).slice(2), mutations: 0 };
        try {
            const observer = new MutationObserver(records => {
                created.mutations += records.length;
            });
            observer.observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
            });
            created.observer = observer;
        } catch (error) {
            created.mutations = -1;
        }
        window.__anboScanState = created;
        return created;
    })();
    let animating = true;
    try {
        animating = typeof document.getAnimations === 'function'
            ? document.getAnimations().some(animation => animation.playState === 'running')
            : false;
    } catch (error) {
        animating = true;
    }
    return JSON.stringify({ id: state.id, mutations: state.mutations, animating });
})()"#;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PageScanState {
    pub id: String,
    pub mutations: i64,
    pub animating: bool,
}

impl PageScanState {
    /// Whether a fresh reading proves nothing could have changed since this one.
    ///
    /// A different id is a new document, a negative count is a page Anbo cannot
    /// watch, and a running animation can repaint without mutating anything.
    pub fn still_matches(&self, current: &PageScanState) -> bool {
        self.mutations >= 0
            && !current.animating
            && current.id == self.id
            && current.mutations == self.mutations
    }
}

pub fn build_find_js(generation: u64, ref_prefix: &str, query: &LocatorQuery<'_>) -> String {
    let limit = query.limit.clamp(1, MAX_LOCATOR_MATCHES);
    format!(
        r#"(function() {{
            const generation = "gen-{generation}";
            const refPrefix = {ref_prefix};
            {REF_REGISTRY_JS}
            refRegistry.begin({generation});
            const by = {by};
            const wanted = {value};
            const wantedName = {name};
            const exact = {exact};
            const includeHidden = {include_hidden};
            const limit = {limit};
            const maxScanned = 50000;
            const matches = [];
            let visualPoint = null;
            let scanned = 0;
            let truncated = false;
            let hidden = 0;
            // Two buckets: names that share a word with the one asked for, and
            // whatever else carried the role. The first bucket is the one that
            // actually helps -- "Download this page as a PDF file" answers a
            // search for "Download as PDF", the page's first five links do not.
            const nameNear = [];
            const nameAny = [];

            const normalize = input => String(input || '').replace(/\s+/g, ' ').trim();
            const expectedValue = normalize(wanted).toLocaleLowerCase();
            const expectedName = normalize(wantedName).toLocaleLowerCase();
            const compareValue = (input, expected) => {{
                const left = normalize(input).toLocaleLowerCase();
                return exact ? left === expected : left.includes(expected);
            }};
            const compare = input => compareValue(input, expectedValue);
            const nameWords = expectedName.split(' ').filter(word => word.length > 2);
            const rememberMiss = actual => {{
                const seen = normalize(actual).slice(0, 80);
                if (!seen) return;
                const lower = seen.toLocaleLowerCase();
                const bucket = nameWords.some(word => lower.includes(word)) ? nameNear : nameAny;
                if (bucket.length < 5 && !bucket.includes(seen)) bucket.push(seen);
            }};
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
            {ACCESSIBLE_NAME_JS}
            {VISIBILITY_JS}
            const isMatch = el => {{
                if (by === 'css') {{
                    try {{ return el.matches(wanted); }} catch (_) {{ throw new Error('invalid_selector'); }}
                }}
                if (by === 'role') {{
                    const role = implicitRole(el);
                    if (!role || !compare(role)) return false;
                    if (!wantedName) return true;
                    const actual = accessibleName(el);
                    if (compareValue(actual, expectedName)) return true;
                    rememberMiss(actual);
                    return false;
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
            // A text search wants the thing that says the words, not every
            // ancestor that contains it. Ancestors come first in document
            // order, so taking the first `limit` handed back the page shell and
            // left the button itself off the list: collect wider, then keep the
            // tightest match of each nest.
            const hits = [];
            const collectLimit = by === 'text' ? Math.min(limit * 5, 50) : limit;
            const visit = root => {{
                if (!root || !root.querySelectorAll || hits.length >= collectLimit) return;
                const elements = root.querySelectorAll('*');
                for (let index = 0; index < elements.length; index++) {{
                    if (hits.length >= collectLimit) break;
                    if (scanned >= maxScanned) {{ truncated = true; break; }}
                    const el = elements[index];
                    if (el.tagName === 'ANBO-AUTOMATION-VISUAL') continue;
                    scanned += 1;
                    const matched = isMatch(el);
                    const isVisible = matched && isRenderedElement(el);
                    if (matched && !includeHidden && !isVisible) hidden += 1;
                    if (matched && (includeHidden || isVisible)) {{
                        hits.push(el);
                    }}
                    if (el.shadowRoot) visit(el.shadowRoot);
                }}
            }};

            const describe = el => {{
                        const isVisible = isRenderedElement(el);
                        const ref = refPrefix + (matches.length + 1);
                        refRegistry.remember(ref, el);
                        const type = el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '';
                        const password = type === 'password';
                        const r = el.getBoundingClientRect();
                        const readOnly = !!el.readOnly || el.getAttribute('aria-readonly') === 'true';
                        const enabled = !(el.disabled || el.getAttribute('aria-disabled') === 'true');
                        const textInput = el.tagName === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(type);
                        if (!visualPoint && isVisible) {{
                            const x = r.x + r.width / 2, y = r.y + r.height / 2;
                            if (r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight) {{
                                visualPoint = {{x, y, width:r.width, height:r.height}};
                            }}
                        }}
                        matches.push({{
                            ref,
                            tag: el.tagName.toLowerCase(),
                            role: implicitRole(el),
                            name: accessibleName(el).slice(0, 300),
                            text: normalize(el.innerText || el.textContent).slice(0, 500),
                            value: password ? '[REDACTED]' : (el.value == null ? null : String(el.value).slice(0, 500)),
                            visible: isVisible,
                            enabled,
                            readOnly,
                            editable: enabled && !readOnly && (textInput || el.tagName === 'TEXTAREA' || !!el.isContentEditable),
                            inViewport: isVisible && r.width > 0 && r.height > 0 && r.left < innerWidth && r.top < innerHeight && r.right > 0 && r.bottom > 0,
                            bounds: {{x:r.x,y:r.y,width:r.width,height:r.height}},
                            checked: ['checkbox','radio'].includes(type) ? (el.indeterminate ? null : el.checked) : (el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : null)
                        }});
            }};

            try {{
                visit(document);
                let chosen = hits;
                if (by === 'text' && hits.length > 1) {{
                    chosen = hits.filter(el => !hits.some(other =>
                        other !== el && el.contains(other)
                    ));
                    if (!chosen.length) chosen = hits;
                }}
                for (const el of chosen.slice(0, limit)) describe(el);
                return JSON.stringify({{ matches, scanned, truncated, hidden, nameMisses: (nameNear.length ? nameNear : nameAny), visualPoint, error: null }});
            }} catch (error) {{
                return JSON.stringify({{
                    matches: [],
                    scanned,
                    truncated,
                    hidden,
                    nameMisses: nameNear.length ? nameNear : nameAny,
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
    fn a_rescan_is_skipped_only_when_nothing_could_have_changed() {
        let state = |id: &str, mutations: i64, animating: bool| PageScanState {
            id: id.to_string(),
            mutations,
            animating,
        };
        let scanned = state("abc", 42, false);

        // The same document, the same mutation count, nothing animating: the
        // walk would read exactly what the last one read.
        assert!(scanned.still_matches(&state("abc", 42, false)));

        // Anything that moved, a reload that reset the counter, or an
        // animation that can repaint without mutating, all earn a fresh scan.
        assert!(!scanned.still_matches(&state("abc", 43, false)));
        assert!(!scanned.still_matches(&state("xyz", 42, false)));
        assert!(!scanned.still_matches(&state("abc", 42, true)));

        // A page whose observer could not be installed reports -1 and is never
        // called quiet, in either direction.
        let unwatchable = state("abc", -1, false);
        assert!(!unwatchable.still_matches(&state("abc", -1, false)));
        assert!(!scanned.still_matches(&unwatchable));
    }

    #[test]
    fn the_page_probe_installs_one_observer_and_reads_it() {
        assert!(PAGE_SCAN_STATE_JS.contains("window.__anboScanState"));
        assert!(PAGE_SCAN_STATE_JS.contains("new MutationObserver"));
        // Every failure path has to answer "not quiet" rather than guess.
        assert!(PAGE_SCAN_STATE_JS.contains("created.mutations = -1"));
        assert!(PAGE_SCAN_STATE_JS.contains("animating = true"));
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
        assert!(script.contains("compareValue(actual, expectedName)"));
        assert!(script.contains("const expectedName = normalize(wantedName).toLocaleLowerCase()"));
        assert!(script.contains("if (!role || !compare(role)) return false;"));
        // A near miss keeps a few of the names it saw, so the caller is told
        // what the page calls the thing instead of guessing again.
        assert!(script.contains("bucket.push(seen)"));
        // The payload is read as camelCase, so the script must emit it that way.
        assert!(script.contains("nameMisses: (nameNear.length ? nameNear : nameAny)"));
        assert!(script.contains("bucket.length < 5"));
        assert!(script.contains("nameWords.some(word => lower.includes(word))"));
        // Matches dropped for being out of sight are counted, never silent.
        assert!(script.contains("if (matched && !includeHidden && !isVisible) hidden += 1;"));
    }
}

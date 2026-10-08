use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::context_block::{Ancestors, CONTEXT_BLOCK_JS};
use super::ref_context::REF_REGISTRY_JS;
use super::visibility::VISIBILITY_JS;

pub const MAX_LOCATOR_MATCHES: usize = 20;
pub const MAX_CACHED_SCAN_AGE: Duration = Duration::from_millis(750);

#[derive(Clone, Copy)]
pub struct LocatorQuery<'a> {
    pub by: &'a str,
    pub value: &'a str,
    pub name: Option<&'a str>,
    pub exact: bool,
    pub include_hidden: bool,
    pub limit: usize,
    /// Climb this many ancestors from each match and carry that block's text
    /// back with it. A match is a leaf; the facts around it are the block.
    pub ancestors: Ancestors,
    /// A read, when nothing visible matched, may take an element the page
    /// hides from sight but keeps for screen readers. Never set for input.
    pub screen_reader_text: bool,
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
    /// The enclosing block's text, when `ancestors` asked for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// The earlier match whose `block` this one shares, so one row's text is
    /// never paid for once per cell in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_ref: Option<String>,
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
    /// The first visible interactive controls the scan walked past, filled
    /// only when nothing matched: a miss answered with something to act on,
    /// as a role locator, instead of a request for a snapshot.
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    /// For a css miss: the first simpler selector on the relaxation ladder
    /// that does match something, with how much and what it looks like.
    #[serde(default)]
    pub nearest: Option<NearestCss>,
    /// Matches hidden from sight but kept for screen readers, described only
    /// for a read that found nothing visible in this document.
    #[serde(default)]
    pub unseen: Vec<LocatorMatch>,
    pub error: Option<String>,
}

/// What an over-specific css selector could have meant, as the page has it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NearestCss {
    pub selector: String,
    pub count: usize,
    pub visible: usize,
    #[serde(default)]
    pub examples: Vec<NearestExample>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct NearestExample {
    pub tag: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub name: String,
}

/// Simpler selectors an over-specific css lookup could have meant, most
/// specific first, at most twelve. Built here, pure and tested; the page only
/// evaluates them, and only after a miss. Measured on canvas misses (Maps
/// `#scene canvas, canvas.widget-scene-canvas`, TradingView
/// `table.chart-markup-table.pane canvas`): the agent's next call used what
/// the reply offered, so the rung closest to its intent comes first and the
/// bare tag last. Nothing generic enough to match the whole page is offered.
pub fn css_relaxations(selector: &str) -> Vec<String> {
    const TOO_GENERIC: &[&str] = &[
        "*", "div", "span", "p", "li", "ul", "ol", "a", "section", "article", "header", "footer",
        "nav", "main", "i", "b", "em", "strong", "td", "tr", "th", "tbody", "thead", "label",
    ];
    let original = selector.trim();
    let mut out: Vec<String> = Vec::new();
    fn offer(out: &mut Vec<String>, original: &str, candidate: String) {
        const TOO_GENERIC: &[&str] = &[
            "*", "div", "span", "p", "li", "ul", "ol", "a", "section", "article", "header",
            "footer", "nav", "main", "i", "b", "em", "strong", "td", "tr", "th", "tbody", "thead",
            "label",
        ];
        let candidate = candidate.trim().to_string();
        if candidate.is_empty()
            || candidate == original
            || TOO_GENERIC.contains(&candidate.as_str())
            || out.contains(&candidate)
            || out.len() >= 12
        {
            return;
        }
        out.push(candidate);
    }
    let _ = TOO_GENERIC;
    for alternative in split_top_level(original, ',').into_iter().take(3) {
        let compounds = split_compounds(&alternative);
        if compounds.is_empty() {
            continue;
        }
        let valueless: Vec<String> = compounds.iter().map(|c| drop_attr_values(c)).collect();
        if valueless != compounds {
            offer(&mut out, original, valueless.join(" "));
        }
        // A tag written in front of a class or id is the part most often
        // wrong, so it goes first: TradingView's `.chart-markup-table.pane` is
        // not a table, and the bare `canvas` offered instead matched eleven.
        let tagless: Vec<String> = valueless.iter().map(|c| drop_qualified_tag(c)).collect();
        if tagless != valueless {
            offer(&mut out, original, tagless.join(" "));
        }
        for start in 1..compounds.len() {
            offer(&mut out, original, compounds[start..].join(" "));
        }
        let (tag, qualifiers) = split_compound(compounds.last().map(String::as_str).unwrap_or(""));
        for keep in (0..qualifiers.len()).rev() {
            offer(
                &mut out,
                original,
                format!("{tag}{}", qualifiers[..keep].concat()),
            );
        }
    }
    out
}

/// The compound without its tag when a class or id still pins it down.
fn drop_qualified_tag(compound: &str) -> String {
    let (tag, qualifiers) = split_compound(compound);
    let pinned = qualifiers
        .iter()
        .any(|qualifier| qualifier.starts_with('.') || qualifier.starts_with('#'));
    if tag.is_empty() || tag == "*" || !pinned {
        return compound.to_string();
    }
    qualifiers.concat()
}

/// Split on a separator at bracket and paren depth zero, outside quotes.
fn split_top_level(input: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in input.chars() {
        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                current.push(ch);
            }
            '[' | '(' => {
                depth += 1;
                current.push(ch);
            }
            ']' | ')' => {
                depth -= 1;
                current.push(ch);
            }
            c if c == separator && depth <= 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    parts.push(current.trim().to_string());
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

/// The compound selectors of one alternative, combinators dropped.
fn split_compounds(alternative: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in alternative.chars() {
        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                current.push(ch);
            }
            '[' | '(' => {
                depth += 1;
                current.push(ch);
            }
            ']' | ')' => {
                depth -= 1;
                current.push(ch);
            }
            ' ' | '\t' | '>' | '+' | '~' if depth <= 0 => {
                let piece = current.trim().to_string();
                if !piece.is_empty() {
                    parts.push(piece);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let piece = current.trim().to_string();
    if !piece.is_empty() {
        parts.push(piece);
    }
    parts
}

/// `[name="value"]` becomes `[name]`: the attribute the author meant, without
/// the value the page may spell differently.
fn drop_attr_values(compound: &str) -> String {
    let mut out = String::new();
    let mut rest = compound;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = attr_close(after) else {
            out.push_str(&rest[open..]);
            return out;
        };
        let inner = &after[..close];
        let name_end = inner
            .find(['=', '~', '|', '^', '$', '*', ']'])
            .unwrap_or(inner.len());
        out.push('[');
        out.push_str(inner[..name_end].trim());
        out.push(']');
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn attr_close(after: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (index, ch) in after.char_indices() {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            ']' => return Some(index),
            _ => {}
        }
    }
    None
}

/// A compound selector as its tag plus its qualifiers, in order.
fn split_compound(compound: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = compound.chars().collect();
    let mut index = 0;
    let mut tag = String::new();
    while index < chars.len()
        && (chars[index].is_alphanumeric() || matches!(chars[index], '-' | '_' | '*'))
    {
        tag.push(chars[index]);
        index += 1;
    }
    let mut qualifiers = Vec::new();
    while index < chars.len() {
        let start = index;
        match chars[index] {
            '#' | '.' => {
                index += 1;
                while index < chars.len()
                    && (chars[index].is_alphanumeric() || matches!(chars[index], '-' | '_'))
                {
                    index += 1;
                }
            }
            '[' => {
                let mut depth = 0i32;
                let mut quote: Option<char> = None;
                while index < chars.len() {
                    let ch = chars[index];
                    index += 1;
                    if let Some(open) = quote {
                        if ch == open {
                            quote = None;
                        }
                        continue;
                    }
                    match ch {
                        '"' | '\'' => quote = Some(ch),
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            ':' => {
                index += 1;
                while index < chars.len()
                    && (chars[index].is_alphanumeric() || matches!(chars[index], '-' | '_' | ':'))
                {
                    index += 1;
                }
                if index < chars.len() && chars[index] == '(' {
                    let mut depth = 0i32;
                    while index < chars.len() {
                        let ch = chars[index];
                        index += 1;
                        match ch {
                            '(' => depth += 1,
                            ')' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => index += 1,
        }
        let piece: String = chars[start..index].iter().collect();
        if !piece.trim().is_empty() {
            qualifiers.push(piece);
        }
    }
    (tag, qualifiers)
}

/// One control a failed lookup can offer instead: enough to build a locator.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub role: String,
    pub name: String,
    #[serde(default)]
    pub in_viewport: bool,
}

/// A page that cannot have changed cannot produce a different answer.
///
// The root counter is a hint: shadow roots, child frames and live properties
// can change without a root mutation. Cached scans always expire.
pub const PAGE_SCAN_STATE_JS: &str = r#"(function() {
    const state = (() => {
        if (window.__anboScanState) return window.__anboScanState;
        const created = { id: Math.random().toString(36).slice(2), mutations: 0, usedAt: performance.now() };
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
            const expire = () => {
                if (window.__anboScanState !== created) return;
                const remaining = 2000 - (performance.now() - created.usedAt);
                if (remaining > 0) {
                    created.timer = setTimeout(expire, remaining);
                    return;
                }
                observer.disconnect();
                delete window.__anboScanState;
            };
            created.timer = setTimeout(expire, 2000);
        } catch (error) {
            if (created.observer) created.observer.disconnect();
            created.mutations = -1;
        }
        window.__anboScanState = created;
        return created;
    })();
    state.usedAt = performance.now();
    let animating = true;
    try {
        animating = typeof document.getAnimations === 'function'
            ? document.getAnimations().some(animation => animation.playState === 'running')
            : false;
    } catch (error) {
        animating = true;
    }
    let elements = -1;
    try {
        elements = document.getElementsByTagName('*').length;
    } catch (error) {
        elements = -1;
    }
    return JSON.stringify({ id: state.id, mutations: state.mutations, animating, elements });
})()"#;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PageScanState {
    pub id: String,
    pub mutations: i64,
    pub animating: bool,
    /// Elements in the main document, or -1 when unknown.
    #[serde(default = "unknown_count")]
    pub elements: i64,
}

fn unknown_count() -> i64 {
    -1
}

impl PageScanState {
    /// The same document with roughly the same number of elements: a page
    /// that rewrites text and attributes all the time (TradingView's prices,
    /// a clock) without building anything new. A page still rendering adds
    /// elements by the dozen and fails this.
    pub fn same_structure(&self, current: &PageScanState) -> bool {
        self.mutations >= 0
            && current.mutations >= 0
            && current.id == self.id
            && self.elements >= 0
            && current.elements >= 0
            && (current.elements - self.elements).abs() <= (self.elements / 100).max(8)
    }

    pub fn same_revision(&self, current: &PageScanState) -> bool {
        self.mutations >= 0 && current.id == self.id && current.mutations == self.mutations
    }

    pub fn can_reuse(
        &self,
        current: &PageScanState,
        age: Duration,
        confirmed_absence: bool,
    ) -> bool {
        age < MAX_CACHED_SCAN_AGE
            && self.same_revision(current)
            && (confirmed_absence || (!self.animating && !current.animating))
    }
}

pub fn build_find_js(generation: u64, ref_prefix: &str, query: &LocatorQuery<'_>) -> String {
    let limit = query.limit.clamp(1, MAX_LOCATOR_MATCHES);
    let ancestors = query.ancestors.value();
    let context_block = if query.ancestors == Ancestors::Levels(0) {
        ""
    } else {
        CONTEXT_BLOCK_JS
    };
    let cache = include_str!("locatorCache.js");
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
            const screenReaderText = {screen_reader_text};
            const limit = {limit};
            const climbCount = {ancestors};
            {context_block}
            const blockLimit = 1000;
            const blockRefs = new Map();
            const relaxations = {relaxations};
            const maxScanned = 50000;
            const matches = [];
            const unseen = [];
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
            const roleTags = new Set(['A','BUTTON','TEXTAREA','SELECT','OPTION','IMG','INPUT','H1','H2','H3','H4','H5','H6','DIALOG','UL','OL','LI','TABLE','TR','TH','TD','NAV','MAIN','ARTICLE','FORM','PROGRESS','HR','HEADER','FOOTER']);
            const AUTHOR_NAMED = new Set(['banner','main','navigation','contentinfo','complementary','region','search','form','application','document','generic','group','list','table','grid','treegrid','tablist','toolbar','menu','menubar','tree','radiogroup','listbox','rowgroup','feed','log','status','dialog','alertdialog','article','figure','note','tabpanel','none','presentation']);
            const implicitRole = el => {{
                const explicit = normalize(el.getAttribute('role')).split(' ')[0];
                if (explicit) return explicit;
                if (el.namespaceURI === 'http://www.w3.org/1999/xhtml' && !roleTags.has(el.tagName)) return '';
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
                    if (type === 'search') return 'searchbox';
                    if (type !== 'hidden') return 'textbox';
                }}
                // Structural roles agents ask for by habit from other tools.
                // Measured: a heading lookup on every Wikipedia step and a
                // searchbox on TradingView fell through to css because none
                // of these existed here.
                if (/^h[1-6]$/.test(tag)) return 'heading';
                if (tag === 'dialog') return 'dialog';
                if (tag === 'ul' || tag === 'ol') return 'list';
                if (tag === 'li') return 'listitem';
                if (tag === 'table') return 'table';
                if (tag === 'tr') return 'row';
                if (tag === 'th') return 'columnheader';
                if (tag === 'td') return 'cell';
                if (tag === 'nav') return 'navigation';
                if (tag === 'main') return 'main';
                if (tag === 'article') return 'article';
                if (tag === 'form') return 'form';
                if (tag === 'progress') return 'progressbar';
                if (tag === 'hr') return 'separator';
                if (tag === 'header' || tag === 'footer') {{
                    const nested = el.closest ? el.closest('article,aside,main,nav,section') : null;
                    return nested ? '' : (tag === 'header' ? 'banner' : 'contentinfo');
                }}
                return '';
            }};
            // A search field is a textbox to most callers; let either name reach it.
            const roleMatches = role => compare(role) || (role === 'searchbox' && compare('textbox'));
            // ...but a modern search box is usually a combobox (autocomplete) or a
            // plain textbox, not role=searchbox -- Google Maps, MDN and Bing all use
            // combobox. Let a searchbox lookup reach any editable text entry so the
            // common case is found in one call instead of burning the full timeout.
            // Kept to genuine text entry so a <select> (also role=combobox) never matches.
            const isTextEntry = el => {{
                const t = el.tagName;
                if (t === 'TEXTAREA') return true;
                if (t === 'INPUT') {{ const ty = String(el.type || 'text').toLowerCase(); return !['checkbox','radio','button','submit','reset','image','range','hidden','color','file'].includes(ty); }}
                return el.isContentEditable === true;
            }};
            {ACCESSIBLE_NAME_JS}
            {VISIBILITY_JS}
            {cache}
            const readName = memoizeElement(accessibleName);
            const readVisible = memoizeElement(isRenderedElement);
            const readText = memoizeElement(el => el.innerText || el.textContent);
            // name narrows any strategy by accessible name. Rejecting it outside
            // role cost the caller a whole turn to learn a rule, then a second
            // lookup that asked for the same element.
            const isMatch = el => {{
                if (!matchesBy(el)) return false;
                if (by === 'role' || !wantedName) return true;
                const actual = readName(el);
                if (compareValue(actual, expectedName)) return true;
                rememberMiss(actual);
                return false;
            }};
            const matchesBy = el => {{
                if (by === 'css') {{
                    try {{ return el.matches(wanted); }} catch (_) {{ throw new Error('invalid_selector'); }}
                }}
                if (by === 'role') {{
                    const role = implicitRole(el);
                    // Short-circuits on expectedValue first: zero cost for any non-searchbox lookup.
                    const searchReachesEntry = expectedValue === 'searchbox' && (role === 'textbox' || role === 'combobox') && isTextEntry(el);
                    if (!role || (!roleMatches(role) && !searchReachesEntry)) return false;
                    if (!wantedName) return true;
                    const actual = readName(el);
                    if (compareValue(actual, expectedName)) return true;
                    rememberMiss(actual);
                    return false;
                }}
                if (by === 'text') {{
                    if (!compare(readText(el))) return false;
                    if (implicitRole(el)) return true;
                    return !Array.from(el.children || []).some(child =>
                        compare(readText(child))
                    );
                }}
                if (by === 'label') {{
                    const label = labelName(el);
                    return !!label && compare(label);
                }}
                // Any role, the name check that follows does the matching. A
                // landmark or container is named by its author, never by its
                // content: YouTube's masthead otherwise answered to "Search".
                if (by === 'name') {{
                    const role = implicitRole(el);
                    return !!role && (!AUTHOR_NAMED.has(role)
                        || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'));
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
            // Stop collecting suggestions after a hit. Names and visibility
            // are read only on a miss, without a second DOM walk.
            const candidatePool = [];
            const pocketCandidate = el => {{
                if (candidatePool.length >= 200) return;
                const tag = el.tagName;
                const control = tag === 'A' ? el.hasAttribute('href')
                    : tag === 'INPUT' ? String(el.type || '').toLowerCase() !== 'hidden'
                    : tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY'
                      || el.hasAttribute('role') || el.isContentEditable || el.hasAttribute('tabindex');
                if (control) candidatePool.push(el);
            }};
            const CONTROL_ROLES = new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','switch','slider','spinbutton','menuitem','menuitemcheckbox','menuitemradio','tab','option','treeitem']);
            // A control whose name shares a word with the lookup goes first. On
            // Maps the button named "Alamat: Merdeka Square, ..." sat past the
            // first eight controls, and a miss for "Alamat" offered eight
            // category buttons instead.
            const lookupWords = normalize([by === 'role' || by === 'name' || by === 'css' ? '' : wanted, wantedName].join(' '))
                .toLocaleLowerCase().split(' ').filter(word => word.length > 2);
            const pickCandidates = () => {{
                const near = [];
                const rest = [];
                for (const el of candidatePool) {{
                    if (near.length >= 8 || (rest.length >= 12 && !lookupWords.length)) break;
                    if (!readVisible(el)) continue;
                    const role = implicitRole(el);
                    if (!CONTROL_ROLES.has(role)) continue;
                    const full = normalize(readName(el));
                    if (!full) continue;
                    const r = el.getBoundingClientRect();
                    const inViewport = r.width > 0 && r.height > 0 && r.left < innerWidth && r.top < innerHeight && r.right > 0 && r.bottom > 0;
                    const candidate = {{role, name: full.slice(0, 60), inViewport}};
                    const lower = full.toLocaleLowerCase();
                    if (lookupWords.some(word => lower.includes(word))) near.push(candidate);
                    else if (rest.length < 12) rest.push(candidate);
                }}
                // The viewport first: that is where the agent is looking.
                const viewportFirst = list => list.filter(c => c.inViewport).concat(list.filter(c => !c.inViewport));
                return viewportFirst(near).concat(viewportFirst(rest)).slice(0, 8);
            }};
            // The first rung of the relaxation ladder the page actually has,
            // with a count and a few visible examples. Only on a css miss.
            const nearestCss = () => {{
                for (const sel of relaxations) {{
                    let list;
                    try {{ list = document.querySelectorAll(sel); }} catch (_) {{ continue; }}
                    if (!list.length) continue;
                    let visible = 0;
                    const examples = [];
                    for (let i = 0; i < list.length && i < 50; i++) {{
                        const el = list[i];
                        if (!readVisible(el)) continue;
                        visible += 1;
                        if (examples.length < 3) examples.push({{tag: el.tagName.toLowerCase(), role: implicitRole(el) || '', name: normalize(readName(el)).slice(0, 40)}});
                    }}
                    return {{selector: sel, count: list.length, visible, examples}};
                }}
                return null;
            }};
            const visit = root => {{
                if (!root || !root.querySelectorAll || hits.length >= collectLimit) return;
                const elements = root.querySelectorAll('*');
                for (let index = 0; index < elements.length; index++) {{
                    if (hits.length >= collectLimit) break;
                    if (scanned >= maxScanned) {{ truncated = true; break; }}
                    const el = elements[index];
                    if (el.tagName === 'ANBO-AUTOMATION-VISUAL' || el.tagName === 'ANBO-DESIGN-LAYER') continue;
                    scanned += 1;
                    if (!hits.length) pocketCandidate(el);
                    const matched = isMatch(el);
                    const isVisible = matched && readVisible(el);
                    if (matched && !includeHidden && !isVisible) {{
                        hidden += 1;
                        if (screenReaderText && unseen.length < collectLimit && keptForScreenReaders(el)) unseen.push(el);
                    }}
                    if (matched && (includeHidden || isVisible)) {{
                        hits.push(el);
                    }}
                    if (el.shadowRoot) visit(el.shadowRoot);
                }}
            }};

            // Hidden from sight only, by opacity, clipping or position, and
            // not from assistive technology: Amazon writes each price once for
            // sight, split into whole and fraction, and once whole for screen
            // readers in .a-offscreen (opacity 0), the copy agents ask for.
            const keptForScreenReaders = el =>
                !el.closest('[aria-hidden="true"],[inert]') &&
                typeof el.checkVisibility === 'function' && el.checkVisibility({{checkVisibilityCSS: true}});
            const describe = (el, into = matches) => {{
                        const isVisible = readVisible(el);
                        const ref = refPrefix + (into.length + 1);
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
                        into.push({{
                            ref,
                            tag: el.tagName.toLowerCase(),
                            role: implicitRole(el),
                            name: readName(el).slice(0, 300),
                            text: normalize(readText(el)).slice(0, 500),
                            value: password ? '[REDACTED]' : (el.value == null ? null : String(el.value).slice(0, 500)),
                            visible: isVisible,
                            enabled,
                            readOnly,
                            editable: enabled && !readOnly && (textInput || el.tagName === 'TEXTAREA' || !!el.isContentEditable),
                            inViewport: isVisible && r.width > 0 && r.height > 0 && r.left < innerWidth && r.top < innerHeight && r.right > 0 && r.bottom > 0,
                            bounds: {{x:r.x,y:r.y,width:r.width,height:r.height}},
                            checked: ['checkbox','radio'].includes(type) ? (el.indeterminate ? null : el.checked) : (el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : null)
                        }});
                        // Siblings of one row climb to the same block. Emitting
                        // that text once per match would spend the reply on the
                        // same paragraph ten times over.
                        if (climbCount !== 0) {{
                            const block = contextBlock(el, climbCount);
                            if (!block) return;
                            const seen = blockRefs.get(block);
                            if (seen) into[into.length - 1].blockRef = seen;
                            else {{
                                blockRefs.set(block, ref);
                                into[into.length - 1].block = normalize(readText(block)).slice(0, blockLimit);
                            }}
                        }}
            }};

            try {{
                visit(document);
                // Icon buttons are named by their tooltip: TradingView's symbol
                // button reads "BTCUSDT" and its title says "Symbol search", and
                // agents asked for it by role name and by text alike. Only when no
                // visible element answered the lookup itself does a visible element
                // with a role answer to its title, so a real match is never widened
                // into an ambiguity. The page's titled elements are read directly:
                // the controls a scan pockets stop at 200, which a busy chart passes.
                // A text lookup reads every attribute a text wait counts as the
                // page's words: Maps writes "Alamat" only in the aria-label of the
                // address button, whose text is the address, so wait saw it and
                // find timed out.
                const byTitle = !hits.length && !includeHidden &&
                    (((by === 'role' || by === 'name') && wantedName) || by === 'text');
                if (byTitle) {{
                    const attributes = by === 'text' ? ['aria-label', 'placeholder', 'alt', 'title'] : ['title'];
                    let titled = 0;
                    for (const el of document.querySelectorAll(by === 'text' ? '[aria-label],[placeholder],[alt],[title]' : '[title]')) {{
                        if (hits.length >= collectLimit || ++titled > 2000) break;
                        const said = attributes.some(attribute => by === 'text'
                            ? compare(el.getAttribute(attribute))
                            : compareValue(el.getAttribute(attribute), expectedName));
                        if (!said) continue;
                        const role = implicitRole(el);
                        // A drawing has no role and no words of its own: TradingView's
                        // chart is a canvas whose aria-label "Chart for BINANCE:BTCUSDT,
                        // 1D" is the only place those words exist, and agents asked
                        // for it by text in R26, R35 and the moment of truth.
                        const drawing = !role && by === 'text' && compare(el.getAttribute('aria-label')) && !normalize(readText(el));
                        if ((!role && !drawing) || (by === 'role' && !roleMatches(role)) || !readVisible(el)) continue;
                        hits.push(el);
                    }}
                }}
                let chosen = hits;
                if (by === 'text' && hits.length > 1) {{
                    chosen = hits.filter(el => !hits.some(other =>
                        other !== el && el.contains(other)
                    ));
                    if (!chosen.length) chosen = hits;
                }}
                for (const el of chosen.slice(0, limit)) describe(el);
                // Only for a read that found nothing visible here, and each nest
                // is read at its tightest, as a text match is. A copy with no
                // words means the page stopped filling them: Amazon left its
                // deal price's copy empty and filled the list price's, and
                // reading the rest would have answered with the wrong price.
                const unseenMatches = [];
                const spokenCopies = unseen.filter(el => !unseen.some(other => other !== el && el.contains(other)));
                if (screenReaderText && !matches.length && spokenCopies.every(el => normalize(readText(el)))) {{
                    for (const el of spokenCopies.slice(0, limit)) describe(el, unseenMatches);
                }}
                const candidates = matches.length ? [] : pickCandidates();
                const nearest = (by === 'css' && !matches.length) ? nearestCss() : null;
                return JSON.stringify({{ matches, unseen: unseenMatches, scanned, truncated, hidden, nameMisses: (nameNear.length ? nameNear : nameAny), candidates, nearest, visualPoint, error: null }});
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
        screen_reader_text = query.screen_reader_text,
        limit = limit,
        ancestors = ancestors,
        relaxations = serde_json::to_string(&if query.by == "css" {
            css_relaxations(query.value)
        } else {
            Vec::new()
        })
        .unwrap(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_find_without_ancestors_does_no_block_work() {
        let script = build_find_js(
            1,
            "g1-e",
            &LocatorQuery {
                by: "role",
                value: "link",
                name: None,
                exact: false,
                include_hidden: false,
                limit: 10,
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(script.contains("const climbCount = 0;"));
        assert!(script.contains("if (climbCount !== 0)"));
        assert!(!script.contains("function contextBlock("));
    }

    #[test]
    fn ancestors_climb_is_bounded_and_shared_between_siblings() {
        let script = build_find_js(
            4,
            "g4-e",
            &LocatorQuery {
                by: "text",
                value: "Python",
                name: None,
                exact: false,
                include_hidden: false,
                limit: 10,
                // Ten is the ceiling; a caller asking for more gets ten.
                ancestors: Ancestors::Levels(99),
                screen_reader_text: false,
            },
        );
        assert!(script.contains("const climbCount = 10;"));
        // Two cells of one row climb to the same block: the text is carried
        // once and the second match points at the first.
        assert!(script.contains("blockRefs.get(block)"));
        assert!(script.contains("into[into.length - 1].blockRef = seen;"));
        assert!(script.contains("blockRefs.set(block, ref);"));
    }

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
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(script.contains(r#"const wanted = "a\"b";"#));
        assert!(script.contains("const limit = 20;"));
        assert!(script.contains("data-anbo-ref"));
    }

    #[test]
    fn scan_reuse_requires_an_observed_revision_within_its_age_limit() {
        let state = |id: &str, mutations: i64, animating: bool| PageScanState {
            id: id.to_string(),
            mutations,
            animating,
            elements: 3_000,
        };
        let scanned = state("abc", 42, false);

        // The same document, the same mutation count, nothing animating: the
        // walk would read exactly what the last one read.
        assert!(scanned.can_reuse(&state("abc", 42, false), Duration::ZERO, false));

        // Anything that moved, a reload that reset the counter, or an
        // animation that can repaint without mutating, all earn a fresh scan.
        assert!(!scanned.can_reuse(&state("abc", 43, false), Duration::ZERO, false));
        assert!(!scanned.can_reuse(&state("xyz", 42, false), Duration::ZERO, false));
        assert!(!scanned.can_reuse(&state("abc", 42, true), Duration::ZERO, false));

        // A page whose observer could not be installed reports -1 and is never
        // called quiet, in either direction.
        let unwatchable = state("abc", -1, false);
        assert!(!unwatchable.can_reuse(&unwatchable, Duration::ZERO, true));
        assert!(!scanned.can_reuse(&unwatchable, Duration::ZERO, true));
    }

    #[test]
    fn unobserved_changes_force_a_rescan_even_for_a_cached_absence() {
        let state = |id: &str, mutations: i64, animating: bool| PageScanState {
            id: id.to_string(),
            mutations,
            animating,
            elements: 3_000,
        };
        let scanned = state("abc", 42, false);

        for absent in [false, true] {
            assert!(scanned.can_reuse(&scanned, Duration::from_millis(749), absent));
            assert!(!scanned.can_reuse(&scanned, Duration::from_millis(750), absent));
            assert!(!scanned.can_reuse(&scanned, Duration::from_secs(2), absent));
        }
        assert!(scanned.can_reuse(&state("abc", 42, true), Duration::ZERO, true));
        assert!(!scanned.can_reuse(&state("abc", 42, true), Duration::from_millis(750), true));

        // A mutation, or a fresh document, could have introduced the element:
        // the absence is no longer proven.
        assert!(!scanned.same_revision(&state("abc", 43, false)));
        assert!(!scanned.same_revision(&state("xyz", 42, false)));

        // An uninstallable observer (-1) is never trusted to prove absence.
        assert!(!state("abc", -1, false).same_revision(&state("abc", -1, false)));
    }

    #[test]
    fn a_live_page_keeps_its_shape_while_a_page_still_rendering_does_not() {
        let state = |id: &str, mutations: i64, elements: i64| PageScanState {
            id: id.to_string(),
            mutations,
            animating: false,
            elements,
        };
        // TradingView between two scans: thousands of price mutations, the
        // element count within two of where it was.
        let chart = state("abc", 10, 3_030);
        assert!(chart.same_structure(&state("abc", 4_812, 3_028)));
        assert!(chart.same_structure(&state("abc", 4_812, 3_060)));
        // A result list arriving, a new document, or a page nobody can watch
        // is not the same page.
        assert!(!chart.same_structure(&state("abc", 4_812, 3_061)));
        assert!(!chart.same_structure(&state("abc", 4_812, 2_990)));
        assert!(!chart.same_structure(&state("xyz", 4_812, 3_030)));
        assert!(!chart.same_structure(&state("abc", -1, 3_030)));
        assert!(!chart.same_structure(&state("abc", 4_812, -1)));
        // A small page still needs more than a handful of new elements.
        let small = state("abc", 1, 40);
        assert!(small.same_structure(&state("abc", 9, 48)));
        assert!(!small.same_structure(&state("abc", 9, 49)));
    }

    #[test]
    fn the_page_probe_counts_the_elements_it_sees() {
        assert!(PAGE_SCAN_STATE_JS.contains("document.getElementsByTagName('*').length"));
        let legacy: PageScanState =
            serde_json::from_str(r#"{"id":"a","mutations":1,"animating":false}"#).unwrap();
        assert_eq!(legacy.elements, -1);
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
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(script.contains(r#"const wantedName = "Save changes";"#));
        assert!(script.contains("compareValue(actual, expectedName)"));
        // name narrows every strategy, not only role.
        assert!(script.contains("if (!matchesBy(el)) return false;"));
        assert!(script.contains("if (by === 'role' || !wantedName) return true;"));
        // A title answers only when no visible element matched the lookup,
        // for role + name, a bare name and text, over a bounded read of
        // titled elements.
        assert!(
            script.contains("(((by === 'role' || by === 'name') && wantedName) || by === 'text')")
        );
        // A text lookup also reads the attributes a text wait counts.
        assert!(script.contains(
            "document.querySelectorAll(by === 'text' ? '[aria-label],[placeholder],[alt],[title]' : '[title]')"
        ));
        assert!(script.contains(
            "const attributes = by === 'text' ? ['aria-label', 'placeholder', 'alt', 'title'] : ['title'];"
        ));
        assert!(script.contains("++titled > 2000"));
        assert!(script.contains("? compare(el.getAttribute(attribute))"));
        assert!(script.contains(": compareValue(el.getAttribute(attribute), expectedName))"));
        // Without a role, only a drawing answers: its aria-label holds the
        // words and it has none of its own, so a labelled container never does.
        assert!(script.contains(
            "const drawing = !role && by === 'text' && compare(el.getAttribute('aria-label')) && !normalize(readText(el));"
        ));
        assert!(script.contains(
            "if ((!role && !drawing) || (by === 'role' && !roleMatches(role)) || !readVisible(el)) continue;"
        ));
        // A bare name lookup takes any element with a role, and the name check
        // after it does the matching; a container answers only to its author's name.
        assert!(script.contains("if (by === 'name') {"));
        assert!(script.contains("!AUTHOR_NAMED.has(role)"));
        assert!(
            script.contains("el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')")
        );
        assert!(script.contains("const expectedName = normalize(wantedName).toLocaleLowerCase()"));
        assert!(script
            .contains("if (!role || (!roleMatches(role) && !searchReachesEntry)) return false;"));
        // A searchbox lookup also reaches editable comboboxes/textboxes (Maps/MDN/Bing
        // search boxes are comboboxes), scoped to real text entry so a <select> never matches.
        assert!(script.contains("expectedValue === 'searchbox' && (role === 'textbox' || role === 'combobox') && isTextEntry(el)"));
        assert!(script.contains("const isTextEntry = el =>"));
        // A search field answers to textbox as well, and the structural roles
        // agents ask for by habit exist: both were measured as css fallbacks.
        assert!(script.contains("role === 'searchbox' && compare('textbox')"));
        assert!(script.contains("if (/^h[1-6]$/.test(tag)) return 'heading';"));
        assert!(script.contains("if (type === 'search') return 'searchbox';"));
        // A near miss keeps a few of the names it saw, so the caller is told
        // what the page calls the thing instead of guessing again.
        assert!(script.contains("bucket.push(seen)"));
        // The payload is read as camelCase, so the script must emit it that way.
        assert!(script.contains("nameMisses: (nameNear.length ? nameNear : nameAny)"));
        assert!(script.contains("bucket.length < 5"));
        assert!(script.contains("nameWords.some(word => lower.includes(word))"));
        // Matches dropped for being out of sight are counted, never silent.
        assert!(script.contains("if (matched && !includeHidden && !isVisible) {"));
        assert!(script.contains("                        hidden += 1;"));
    }

    #[test]
    fn a_miss_pockets_controls_during_the_walk_and_resolves_them_only_then() {
        let script = build_find_js(
            2,
            "g2-e",
            &LocatorQuery {
                by: "css",
                value: "#searchboxinput",
                name: None,
                exact: false,
                include_hidden: false,
                limit: 10,
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        // Pocketed by tag on every element the walk visits, resolved (render,
        // role, name) only when nothing matched, and reported without refs.
        assert!(script.contains("pocketCandidate(el);"));
        assert!(script.contains("const candidates = matches.length ? [] : pickCandidates();"));
        assert!(script.contains("candidates, nearest, visualPoint"));
        // Landmarks carry names too, but nothing to act on; only controls are offered.
        assert!(script.contains("if (!CONTROL_ROLES.has(role)) continue;"));
        // Controls named with a word of the lookup come first, each group
        // viewport first; without words the first twelve are kept as before.
        assert!(script
            .contains("if (lookupWords.some(word => lower.includes(word))) near.push(candidate);"));
        assert!(script.contains("else if (rest.length < 12) rest.push(candidate);"));
        assert!(
            script.contains("return viewportFirst(near).concat(viewportFirst(rest)).slice(0, 8);")
        );
        assert!(script
            .contains("by === 'role' || by === 'name' || by === 'css' ? '' : wanted, wantedName"));
        assert!(!script.contains(
            "refRegistry.remember(ref, el);
                    candidates"
        ));
    }

    #[test]
    fn an_over_specific_css_selector_relaxes_toward_what_the_page_has() {
        // A tag in front of a class or id goes first; the bare tag, which the
        // agents used to fall back to, is still on the ladder.
        assert_eq!(
            css_relaxations("table.chart-markup-table.pane canvas"),
            vec![".chart-markup-table.pane canvas", "canvas"]
        );
        assert_eq!(
            css_relaxations("#scene canvas, canvas.widget-scene-canvas"),
            vec!["canvas", ".widget-scene-canvas"]
        );
        assert_eq!(
            css_relaxations("div[data-component-type=\"s-search-result\"] h2 a"),
            vec!["div[data-component-type] h2 a", "h2 a"]
        );
        assert_eq!(
            css_relaxations("input#search, input[name=\"search_query\"]"),
            vec!["#search", "input", "input[name]"]
        );
        assert_eq!(
            css_relaxations(
                "table.chart-markup-table td.chart-markup-table .chart-gui-wrapper canvas"
            ),
            vec![
                ".chart-markup-table .chart-markup-table .chart-gui-wrapper canvas",
                "td.chart-markup-table .chart-gui-wrapper canvas",
                ".chart-gui-wrapper canvas",
                "canvas"
            ]
        );
        // Nothing generic enough to match the whole page is ever offered, and
        // the selector itself is not its own relaxation.
        // An attribute alone never loses its tag: `[name]` would match every
        // named field on the page.
        assert_eq!(css_relaxations("div.foo span"), vec![".foo span"]);
        assert_eq!(
            css_relaxations("input[name=\"q\"]"),
            vec!["input[name]", "input"]
        );
        assert!(css_relaxations("canvas").is_empty());
        // Values inside :not() are dropped too, and a quoted comma does not split.
        assert_eq!(
            css_relaxations("div.s-main-slot > div[data-asin]:not([data-asin=\"\"]) h2 a")[0],
            "div.s-main-slot div[data-asin]:not([data-asin]) h2 a"
        );
        assert_eq!(
            css_relaxations("a[title=\"x, y\"] img"),
            vec!["a[title] img", "img"]
        );
    }

    #[test]
    fn a_css_miss_evaluates_the_ladder_in_the_page_and_a_role_lookup_does_not() {
        let css = build_find_js(
            3,
            "g3-e",
            &LocatorQuery {
                by: "css",
                value: "table.chart-markup-table.pane canvas",
                name: None,
                exact: false,
                include_hidden: false,
                limit: 10,
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(
            css.contains("const relaxations = [\".chart-markup-table.pane canvas\",\"canvas\"];"),
            "{css}"
        );
        assert!(css
            .contains("const nearest = (by === 'css' && !matches.length) ? nearestCss() : null;"));
        let role = build_find_js(
            3,
            "g3-e",
            &LocatorQuery {
                by: "role",
                value: "button",
                name: Some("Search"),
                exact: false,
                include_hidden: false,
                limit: 10,
                ancestors: Ancestors::Levels(0),
                screen_reader_text: false,
            },
        );
        assert!(
            role.contains("const relaxations = [];"),
            "a role lookup ships no ladder"
        );
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::protocol::error_codes;
use super::readable_text::READABLE_TEXT_JS;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleSource {
    Document,
    Native,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageExpectation {
    pub url: Option<String>,
    pub title: Option<String>,
    pub title_source: Option<TitleSource>,
    pub text: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    #[serde(default = "default_stability")]
    pub stable_for: u64,
}

fn default_timeout() -> u64 {
    10_000
}
fn default_stability() -> u64 {
    200
}

impl PageExpectation {
    pub fn parse(value: Option<&Value>) -> Result<Option<Self>, (String, String)> {
        let Some(value) = value else {
            return Ok(None);
        };
        let error = || {
            (error_codes::INVALID_REQUEST.to_string(), "waitFor requires url, title, or text; timeout 100-60000ms and stableFor 0-2000ms not exceeding timeout".to_string())
        };
        let expectation: Self = serde_json::from_value(value.clone()).map_err(|_| error())?;
        if expectation.url.is_none() && expectation.title.is_none() && expectation.text.is_none() {
            return Err(error());
        }
        if expectation.title_source.is_some() && expectation.title.is_none() {
            return Err(error());
        }
        for (value, limit) in [
            (&expectation.url, 8192),
            (&expectation.title, 2048),
            (&expectation.text, 2048),
        ] {
            if value
                .as_ref()
                .is_some_and(|value| value.trim().is_empty() || value.len() > limit)
            {
                return Err(error());
            }
        }
        if !(100..=60_000).contains(&expectation.timeout)
            || expectation.stable_for > 2000
            || expectation.stable_for > expectation.timeout
        {
            return Err(error());
        }
        Ok(Some(expectation))
    }

    pub fn script(&self) -> String {
        let expected = json!({"url": self.url, "title": self.title, "text": self.text, "titleSource": self.title_source});
        format!(
            r#"(() => {{
            {READABLE_TEXT_JS}
            const expected = {expected};
            const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
            const glob = (value, pattern) => {{
                const parts = pattern.split('*');
                let offset = 0;
                for (let index = 0; index < parts.length; index++) {{
                    const part = parts[index];
                    const found = value.indexOf(part, offset);
                    if (found < 0 || (index === 0 && found !== 0)) return false;
                    if (index === parts.length - 1 && part && !value.endsWith(part)) return false;
                    offset = found + part.length;
                }}
                return parts.length > 1 || value === pattern;
            }};
            if (!document.body || document.readyState === 'loading') return false;
            return (!expected.url || glob(location.href, expected.url)) &&
                (!expected.title || expected.titleSource === 'native' || normalizeLoose(document.title) === normalizeLoose(expected.title)) &&
                (!expected.text || pageTextIncludes(expected.text));
        }})()"#
        )
    }

    pub fn uses_native_title(&self) -> bool {
        self.title_source == Some(TitleSource::Native)
    }

    pub fn needs_document(&self) -> bool {
        !self.uses_native_title() || self.url.is_some() || self.text.is_some()
    }

    pub fn matches_native_title(&self, title: &str) -> bool {
        let normalize = |value: &str| {
            value
                .split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        };
        self.title
            .as_ref()
            .is_some_and(|expected| normalize(title) == normalize(expected))
    }
}

#[derive(Default)]
pub struct StableMatch(Option<std::time::Duration>);

impl StableMatch {
    pub fn observe(
        &mut self,
        matched: bool,
        elapsed: std::time::Duration,
        stable_for: std::time::Duration,
    ) -> bool {
        if !matched {
            self.0 = None;
            return false;
        }
        elapsed.saturating_sub(*self.0.get_or_insert(elapsed)) >= stable_for
    }
}

pub fn input_guard_body(generation: u64, expected_value: Option<&str>) -> String {
    let expected = json!(expected_value);
    format!(
        r#"
        if (!el || !el.isConnected || el.getAttribute('data-anbo-gen') !== 'gen-{generation}') return JSON.stringify({{ok:false,error:'stale_ref'}});
        const expected = {expected};
        const value = el.isContentEditable ? (el.textContent || '') : el.value;
        if (expected !== null && value !== expected) return JSON.stringify({{ok:false,error:'input_mismatch'}});
        if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return JSON.stringify({{ok:false,error:'input_not_ready'}});
        el.focus({{preventScroll:true}});
        const root = el.getRootNode();
        if (root.activeElement !== el && !el.contains(root.activeElement)) return JSON.stringify({{ok:false,error:'input_not_ready'}});
        const focusedValue = el.isContentEditable ? (el.textContent || '') : el.value;
        if (!el.isConnected || (expected !== null && focusedValue !== expected)) return JSON.stringify({{ok:false,error:'input_mismatch'}});
        return JSON.stringify({{ok:true}});
    "#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rejects_empty_unbounded_and_unknown_expectations() {
        for invalid in [
            json!({}),
            json!({"title":""}),
            json!({"url":"*", "timeout":60_001}),
            json!({"text":"ok", "stableFor":2001}),
            json!({"title":"ok", "timeout":100, "stableFor":200}),
            json!({"title":"ok", "typo":true}),
            json!({"title":"ok", "titleSource":"unknown"}),
            json!({"text":"ok", "titleSource":"native"}),
            json!({"text":"x".repeat(2049)}),
        ] {
            assert!(PageExpectation::parse(Some(&invalid)).is_err());
        }
        assert!(PageExpectation::parse(None).unwrap().is_none());
        assert!(
            PageExpectation::parse(Some(&json!({"url":"*results*", "title":"Results"}))).is_ok()
        );
    }

    #[test]
    fn transient_match_must_start_its_stability_window_again() {
        let mut state = StableMatch::default();
        let stability = Duration::from_millis(200);
        assert!(!state.observe(true, Duration::ZERO, stability));
        assert!(!state.observe(false, Duration::from_millis(150), stability));
        assert!(!state.observe(true, Duration::from_millis(200), stability));
        assert!(!state.observe(true, Duration::from_millis(399), stability));
        assert!(state.observe(true, Duration::from_millis(400), stability));
    }

    #[test]
    fn expectation_and_input_are_encoded_as_data_not_script() {
        let value = "\"; throw new Error('injection'); //";
        let expectation = PageExpectation::parse(Some(&json!({"title":value})))
            .unwrap()
            .unwrap();
        assert!(expectation
            .script()
            .contains(&serde_json::to_string(value).unwrap()));
        assert!(input_guard_body(4, Some(value)).contains(&serde_json::to_string(value).unwrap()));
    }

    #[test]
    fn native_title_is_explicit_and_does_not_require_document_javascript_alone() {
        let mut expectation =
            PageExpectation::parse(Some(&json!({"title":"Ready now", "titleSource":"native"})))
                .unwrap()
                .unwrap();
        assert!(expectation.uses_native_title());
        assert!(!expectation.needs_document());
        assert!(expectation.matches_native_title("\u{feff} Ready\n now "));
        assert!(!expectation.matches_native_title("Not ready"));
        expectation.text = Some("Ready".into());
        assert!(expectation.needs_document());
        let default = PageExpectation::parse(Some(&json!({"title":"Ready"})))
            .unwrap()
            .unwrap();
        assert!(!default.uses_native_title());
        assert!(default.needs_document());
    }
}

//! The surface an action opens, read in the same call that opened it.
//!
//! Typing into an autocomplete or clicking a menu button used to end the call
//! with nothing but "dispatched". Finding out what appeared cost another round
//! trip, and for an LLM-driven caller a round trip is a whole turn: seconds and
//! tokens, against a bounded wait measured in animation frames.

use serde_json::{json, Value};

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::ref_context::REF_REGISTRY_JS;
use super::visibility::VISIBILITY_JS;

const REVEAL_JS: &str = include_str!("reveal.js");
pub const REVEAL_BASELINE_JS: &str = include_str!("revealBaseline.js");
/// Live-region text before a press and the change after it; the pointer guard
/// takes the baseline, the reveal reads it.
pub const ANNOUNCE_JS: &str = include_str!("announce.js");
/// Live-region messages handed back per click.
const ANNOUNCED_LIMIT: usize = 3;

/// Waiting this long is worth it because the alternative is another turn.
pub const DEFAULT_REVEAL_MS: u64 = 400;
pub const MAX_REVEAL_MS: u64 = 2000;
/// Items handed back per surface. The reply stays small enough to be free.
pub const REVEAL_ITEM_LIMIT: usize = 10;

/// A reveal takes its own scan generation, so its refs are named exactly like
/// any other scan's. A private letter here looked tidier and was rejected by
/// the ref parser the moment a caller tried to use one.
pub fn reveal_ref_prefix(generation: u64) -> String {
    format!("g{generation}-e")
}

/// The caller's `reveal` budget in milliseconds, or the default. 0 disables.
pub fn reveal_budget(params: &Value, default_ms: u64) -> u64 {
    match params.get("reveal") {
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_f64().filter(|ms| *ms >= 0.0).map(|ms| ms as u64))
            .unwrap_or(default_ms)
            .min(MAX_REVEAL_MS),
        None => default_ms.min(MAX_REVEAL_MS),
    }
}

pub fn build_reveal_js(
    ref_id: &str,
    generation: u64,
    budget_ms: u64,
    before: Option<&Value>,
    declared_only: bool,
    query: Option<&str>,
) -> String {
    let baseline_js = if before
        .and_then(|value| value["revealToken"].as_u64())
        .is_some()
    {
        REVEAL_BASELINE_JS
    } else {
        "const readRevealBaseline = () => null;"
    };
    let options = json!({
        "budgetMs": budget_ms,
        "refPrefix": reveal_ref_prefix(generation),
        "limit": REVEAL_ITEM_LIMIT,
        "generation": generation,
        "declaredOnly": declared_only,
        "query": query,
        "before": before.cloned().unwrap_or(Value::Null),
        "announcedLimit": ANNOUNCED_LIMIT,
    });
    format!(
        r#"(function() {{
            const refId = {ref_json};
            {REF_REGISTRY_JS}
            const el = refRegistry.resolve(refId);
            {VISIBILITY_JS}
            {ACCESSIBLE_NAME_JS}
            {baseline_js}
            {ANNOUNCE_JS}
            {REVEAL_JS}
            return revealAfterAction(el, {options}, refRegistry);
        }})()"#,
        ref_json = serde_json::to_string(ref_id).unwrap(),
    )
}

/// The reply block plus how many refs the page actually registered. A reveal
/// that registered nothing has replaced nothing, so its generation is never
/// published and the refs the caller already holds stay live.
pub struct Reveal {
    pub value: Value,
    pub registered: usize,
    pub refs: Vec<String>,
}

pub fn parse_reveal(response: &str) -> Option<Reveal> {
    let decoded: String = serde_json::from_str(response).unwrap_or_else(|_| response.to_string());
    let parsed: Value = serde_json::from_str(&decoded).ok()?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let items = parsed
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let refs = items
        .iter()
        .filter_map(|item| item.get("ref").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut value = json!({
        "surface": parsed.get("surface").cloned().unwrap_or(Value::Null),
        "count": refs.len(),
        "items": items,
    });
    if parsed.get("truncated").and_then(Value::as_bool) == Some(true) {
        value["truncated"] = json!(true);
    }
    if parsed.get("expanded").and_then(Value::as_bool) == Some(true) {
        value["expanded"] = json!(true);
    }
    if let Some(announced) = parsed
        .get("announced")
        .filter(|announced| announced.as_array().is_some_and(|items| !items.is_empty()))
    {
        value["announced"] = announced.clone();
    }
    // An empty effects object says nothing, so it is not spent on the reply.
    if let Some(observed) = parsed
        .get("observed")
        .filter(|observed| observed.as_object().is_some_and(|map| !map.is_empty()))
    {
        value["observed"] = observed.clone();
    }
    Some(Reveal {
        value,
        registered: refs.len(),
        refs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_region_message_rides_along_and_an_empty_list_does_not() {
        let posted = parse_reveal(
            &serde_json::to_string(
                &json!({
                    "ok": true, "surface": null, "count": 0, "items": [], "observed": {},
                    "announced": [{"role": "status", "text": "Terdaftar: Rina"}]
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(posted.value["announced"][0]["text"], "Terdaftar: Rina");
        let quiet = parse_reveal(&serde_json::to_string(&json!({
            "ok": true, "surface": null, "count": 0, "items": [], "observed": {}, "announced": []
        }).to_string()).unwrap())
        .unwrap();
        assert!(quiet.value.get("announced").is_none());
        let script = build_reveal_js("g1-e1", 2, 400, None, true, None);
        assert!(script.contains("function readAnnounced"));
        assert!(script.contains("\"announcedLimit\":3"));
    }

    #[test]
    fn baseline_lookup_is_only_included_for_a_captured_input() {
        let captured = build_reveal_js(
            "g1-e1",
            2,
            400,
            Some(&json!({"revealToken": 1})),
            false,
            None,
        );
        assert!(captured.contains("function readRevealBaseline"));
        let click = build_reveal_js("g1-e1", 2, 400, None, true, None);
        assert!(!click.contains("function readRevealBaseline"));
        assert!(click.contains("const readRevealBaseline = () => null;"));
    }

    #[test]
    fn budget_defaults_and_clamps() {
        assert_eq!(
            reveal_budget(&json!({}), DEFAULT_REVEAL_MS),
            DEFAULT_REVEAL_MS
        );
        assert_eq!(reveal_budget(&json!({ "reveal": 0 }), DEFAULT_REVEAL_MS), 0);
        assert_eq!(
            reveal_budget(&json!({ "reveal": 120 }), DEFAULT_REVEAL_MS),
            120
        );
        assert_eq!(
            reveal_budget(&json!({ "reveal": 99_000 }), DEFAULT_REVEAL_MS),
            MAX_REVEAL_MS
        );
        // A caller that sends nonsense gets the default, never an unbounded wait.
        assert_eq!(
            reveal_budget(&json!({ "reveal": "soon" }), DEFAULT_REVEAL_MS),
            DEFAULT_REVEAL_MS
        );
        assert_eq!(
            reveal_budget(&json!({ "reveal": -5 }), DEFAULT_REVEAL_MS),
            DEFAULT_REVEAL_MS
        );
    }

    #[test]
    fn reveal_refs_carry_their_generation() {
        assert_eq!(reveal_ref_prefix(12), "g12-e");
        let script = build_reveal_js("g12-e3", 13, 250, None, false, Some("ETHUSDT"));
        assert!(script.contains("\"refPrefix\":\"g13-e\""));
        assert!(script.contains("\"budgetMs\":250"));
        // The typed text travels as data, never as script.
        assert!(script.contains("\"query\":\"ETHUSDT\""));
        assert!(script.contains("revealAfterAction(el,"));
        assert!(script.contains("refRegistry.resolve(refId)"));
    }

    #[test]
    fn a_click_waits_only_on_a_control_that_declares_a_popup() {
        assert!(
            build_reveal_js("g1-e1", 2, 400, None, true, None).contains("\"declaredOnly\":true")
        );
        assert!(
            build_reveal_js("g1-e1", 2, 400, None, false, None).contains("\"declaredOnly\":false")
        );
    }

    #[test]
    fn a_reveal_without_items_registers_nothing() {
        let reveal = parse_reveal(
            &serde_json::to_string(&json!({
                "ok": true, "surface": Value::Null, "count": 0, "items": [], "observed": {}
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(reveal.registered, 0);
        assert!(reveal.refs.is_empty());
        assert_eq!(reveal.value["surface"], Value::Null);
        assert!(reveal.value.get("observed").is_none());
    }

    #[test]
    fn items_and_observed_effects_survive_parsing() {
        let reveal = parse_reveal(
            &serde_json::to_string(&json!({
                "ok": true,
                "surface": "listbox",
                "expanded": true,
                "truncated": true,
                "items": [
                    { "ref": "g13-e1", "role": "option", "name": "Zürich, Switzerland" },
                    { "ref": "g13-e2", "role": "option", "name": "Zurich Airport" }
                ],
                "observed": { "dialogOpened": true }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(reveal.registered, 2);
        assert_eq!(reveal.refs, vec!["g13-e1", "g13-e2"]);
        assert_eq!(reveal.value["surface"], "listbox");
        assert_eq!(reveal.value["count"], 2);
        assert_eq!(reveal.value["truncated"], true);
        assert_eq!(reveal.value["expanded"], true);
        assert_eq!(reveal.value["observed"]["dialogOpened"], true);
    }

    #[test]
    fn a_failed_reveal_is_dropped_rather_than_reported() {
        assert!(parse_reveal("not json").is_none());
        assert!(parse_reveal(r#""{\"ok\":false,\"error\":\"boom\"}""#).is_none());
    }
}

use serde_json::Value;

use super::protocol::error_codes;

type TargetError = (String, String);

pub fn supports_locator(method: &str) -> bool {
    matches!(
        method,
        "click"
            | "double_click"
            | "focus"
            | "check"
            | "type"
            | "type_text"
            | "hover"
            | "select_option"
            | "scroll_to_element"
            | "get_text"
            | "dialog"
            | "upload_files"
            | "download"
            | "press_key"
    )
}

pub fn validate_locator(value: &Value) -> Result<u64, TargetError> {
    let invalid = || {
        (error_codes::INVALID_REQUEST.into(), "locator requires by/value, optional name/exact/includeHidden/timeout, and no unknown fields".into())
    };
    let object = value.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "by" | "value" | "name" | "exact" | "includeHidden" | "timeout"
        )
    }) || !object.get("by").is_some_and(Value::is_string)
        || !object.get("value").is_some_and(Value::is_string)
        || object.get("name").is_some_and(|v| !v.is_string())
        || ["exact", "includeHidden"]
            .iter()
            .any(|key| object.get(*key).is_some_and(|v| !v.is_boolean()))
    {
        return Err(invalid());
    }
    match object.get("timeout") {
        None => Ok(5_000),
        Some(value) => value
            .as_u64()
            .filter(|n| (100..=60_000).contains(n))
            .ok_or_else(invalid),
    }
}

pub fn unique(count: usize, complete: bool) -> Result<bool, TargetError> {
    if count > 1 {
        return Err((
            error_codes::AMBIGUOUS_TARGET.into(),
            "locator matched multiple elements; narrow it before acting, no input dispatched"
                .into(),
        ));
    }
    Ok(count == 1 && complete)
}

pub fn wait_state(
    state: &str,
    count: usize,
    complete: bool,
    visible: bool,
    enabled: bool,
    checked: Option<bool>,
) -> Result<bool, TargetError> {
    if !matches!(
        state,
        "attached"
            | "absent"
            | "detached"
            | "visible"
            | "hidden"
            | "enabled"
            | "disabled"
            | "checked"
            | "unchecked"
    ) {
        return Err((
            error_codes::INVALID_REQUEST.into(),
            "unsupported locator wait state".into(),
        ));
    }
    unique(count, complete)?;
    if !complete {
        return Ok(false);
    }
    Ok(match state {
        "absent" | "detached" => count == 0,
        "hidden" => count == 0 || !visible,
        "attached" => count == 1,
        "visible" => count == 1 && visible,
        "enabled" => count == 1 && enabled,
        "disabled" => count == 1 && !enabled,
        "checked" => count == 1 && checked == Some(true),
        "unchecked" => count == 1 && checked == Some(false),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_bounded_locator_fields_without_coercion() {
        assert_eq!(
            validate_locator(&json!({"by":"role","value":"button","exact":true})).unwrap(),
            5000
        );
        for bad in [
            Value::Null,
            json!([]),
            json!({"by":"css","value":"button","limit":1}),
            json!({"by":"css","value":"button","exact":"true"}),
            json!({"by":"css","value":"button","timeout":0}),
            json!({"by":"css","value":"button","timeout":60001}),
        ] {
            assert!(validate_locator(&bad).is_err());
        }
    }

    #[test]
    fn only_a_unique_fully_scanned_target_can_be_selected() {
        assert!(unique(1, true).unwrap());
        assert!(!unique(1, false).unwrap());
        assert!(!unique(0, true).unwrap());
        assert_eq!(
            unique(2, false).unwrap_err().0,
            error_codes::AMBIGUOUS_TARGET
        );
    }

    #[test]
    fn incomplete_coverage_cannot_prove_absence_or_hidden_state() {
        for state in ["absent", "detached", "hidden", "visible"] {
            assert!(!wait_state(state, 0, false, false, false, None).unwrap());
        }
        assert!(wait_state("absent", 0, true, false, false, None).unwrap());
        assert!(wait_state("hidden", 1, true, false, true, None).unwrap());
        assert!(!wait_state("absent", 1, true, false, true, None).unwrap());
        assert!(!wait_state("disabled", 0, true, false, false, None).unwrap());
        assert!(!wait_state("unchecked", 1, true, true, true, None).unwrap());
        assert!(wait_state("unchecked", 1, true, true, true, Some(false)).unwrap());
        assert!(wait_state("hidden", 2, true, false, false, None).is_err());
    }
}

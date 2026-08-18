use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener};

use crate::modules::browser_automation::protocol::error_codes;

const AGENT_REQUEST_EVENT: &str = "anbo:agent-request";
const AGENT_RESPONSE_EVENT: &str = "anbo:agent-response";
const MAX_WORKSPACE_BYTES: usize = 4 * 1024;
const MAX_AGENT_ID_BYTES: usize = 512;
const MAX_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_ID_BYTES: usize = 128;
const MAX_CURSOR_BYTES: usize = 128;
const MAX_READ_CHARS: u64 = 12_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
static AGENT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
struct AgentAutomationError {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct AgentAutomationResponse {
    result: Option<Value>,
    error: Option<AgentAutomationError>,
}

fn required_bounded_string<'a>(
    params: &'a Value,
    key: &str,
    max_bytes: usize,
) -> Result<&'a str, (String, String)> {
    let value = params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                error_codes::INVALID_REQUEST.to_string(),
                format!("{key} is required"),
            )
        })?;
    if value.len() > max_bytes {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} exceeds {max_bytes} bytes"),
        ));
    }
    Ok(value)
}

fn optional_bounded_string(
    params: &Value,
    key: &str,
    max_bytes: usize,
) -> Result<(), (String, String)> {
    let Some(value) = params.get(key) else {
        return Ok(());
    };
    let value = value.as_str().ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} must be a string"),
        )
    })?;
    if value.len() > max_bytes {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} exceeds {max_bytes} bytes"),
        ));
    }
    Ok(())
}

fn bounded_integer(
    params: &Value,
    key: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, (String, String)> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    let value = value.as_u64().ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} must be a positive integer"),
        )
    })?;
    if !(minimum..=maximum).contains(&value) {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(Some(value))
}

fn validate_params(method: &str, params: &Value) -> Result<u64, (String, String)> {
    if !params.is_object() {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "agent tool arguments must be an object".to_string(),
        ));
    }
    required_bounded_string(params, "workspace", MAX_WORKSPACE_BYTES)?;
    if !matches!(method, "agent_list" | "agent_spawn") {
        required_bounded_string(params, "agentId", MAX_AGENT_ID_BYTES)?;
    }
    match method {
        "agent_list" | "agent_status" => Ok(5_000),
        "agent_spawn" => {
            let agent = required_bounded_string(params, "agent", 71)?;
            if agent.chars().any(char::is_control) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "agent contains control characters".to_string(),
                ));
            }
            let timeout =
                bounded_integer(params, "timeout", 100, MAX_TIMEOUT_MS)?.unwrap_or(15_000);
            Ok(timeout + 2_000)
        }
        "agent_read" => {
            optional_bounded_string(params, "cursor", MAX_CURSOR_BYTES)?;
            bounded_integer(params, "maxChars", 1, MAX_READ_CHARS)?;
            Ok(5_000)
        }
        "agent_send" => {
            let message = required_bounded_string(params, "message", MAX_MESSAGE_BYTES)?;
            if message
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\r' | '\n'))
            {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "message contains control characters".to_string(),
                ));
            }
            optional_bounded_string(params, "sourceAgentId", MAX_AGENT_ID_BYTES)?;
            optional_bounded_string(params, "messageId", MAX_MESSAGE_ID_BYTES)?;
            let timeout =
                bounded_integer(params, "timeout", 100, MAX_TIMEOUT_MS)?.unwrap_or(30_000);
            Ok(timeout + 2_000)
        }
        "agent_wait" => {
            if let Some(status) = params.get("status") {
                if !matches!(status.as_str(), Some("working" | "waiting" | "finished")) {
                    return Err((
                        error_codes::INVALID_REQUEST.to_string(),
                        "status must be 'working', 'waiting', or 'finished'".to_string(),
                    ));
                }
            }
            let timeout =
                bounded_integer(params, "timeout", 100, MAX_TIMEOUT_MS)?.unwrap_or(10_000);
            Ok(timeout + 2_000)
        }
        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unsupported agent method: {method}"),
        )),
    }
}

pub async fn handle_agent_action(
    app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, (String, String)> {
    let timeout_ms = validate_params(method, &params)?;
    let request_id = format!(
        "{}-{}",
        std::process::id(),
        AGENT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let response_event = format!("{AGENT_RESPONSE_EVENT}:{request_id}");
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let listener_id = app.once(response_event, move |event| {
        let _ = sender.send(event.payload().to_string());
    });
    if let Err(error) = app.emit(
        AGENT_REQUEST_EVENT,
        json!({
            "requestId": request_id,
            "method": method,
            "params": params,
        }),
    ) {
        app.unlisten(listener_id);
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to request agent operation: {error}"),
        ));
    }

    let received = tokio::time::timeout(Duration::from_millis(timeout_ms), receiver).await;
    app.unlisten(listener_id);
    let payload = received
        .map_err(|_| {
            (
                error_codes::TIMEOUT.to_string(),
                "Anbo UI did not complete the agent operation in time".to_string(),
            )
        })?
        .map_err(|_| {
            (
                error_codes::APP_UNAVAILABLE.to_string(),
                "Anbo UI closed before completing the agent operation".to_string(),
            )
        })?;
    let response: AgentAutomationResponse = serde_json::from_str(&payload).map_err(|error| {
        (
            error_codes::INTERNAL.to_string(),
            format!("invalid agent response: {error}"),
        )
    })?;
    if let Some(error) = response.error {
        return Err((error.code, error.message));
    }
    response.result.ok_or_else(|| {
        (
            error_codes::INTERNAL.to_string(),
            "agent response omitted result".to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_requires_explicit_workspace_and_agent() {
        let missing_workspace = validate_params("agent_list", &json!({})).unwrap_err();
        assert_eq!(missing_workspace.0, error_codes::INVALID_REQUEST);
        let missing_agent =
            validate_params("agent_status", &json!({ "workspace": "C:/repo" })).unwrap_err();
        assert_eq!(missing_agent.0, error_codes::INVALID_REQUEST);
        let missing_spawn_agent =
            validate_params("agent_spawn", &json!({ "workspace": "C:/repo" })).unwrap_err();
        assert_eq!(missing_spawn_agent.0, error_codes::INVALID_REQUEST);
    }

    #[test]
    fn validation_bounds_read_send_and_wait_inputs() {
        assert!(validate_params(
            "agent_spawn",
            &json!({ "workspace": "C:/repo", "agent": "Sample CLI" })
        )
        .is_ok());
        assert!(validate_params(
            "agent_spawn",
            &json!({ "workspace": "C:/repo", "agent": "custom:sample-cli" })
        )
        .is_ok());
        assert!(validate_params(
            "agent_read",
            &json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "maxChars": 12_001 })
        )
        .is_err());
        assert!(validate_params(
            "agent_send",
            &json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "message": "bad\u{0007}" })
        )
        .is_err());
        assert!(validate_params(
            "agent_wait",
            &json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "status": "done" })
        )
        .is_err());
    }
}

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::modules::browser_automation::protocol::error_codes;
use crate::modules::browser_automation::ui_answer::Answer;

const AGENT_REQUEST_EVENT: &str = "anbo:agent-request";
const MAX_WORKSPACE_BYTES: usize = 4 * 1024;
const MAX_AGENT_ID_BYTES: usize = 512;
const MAX_TERMINAL_ID_BYTES: usize = 128;
const MAX_TERMINAL_TITLE_BYTES: usize = 256;
const MAX_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_ID_BYTES: usize = 128;
const MAX_CURSOR_BYTES: usize = 128;
const MAX_READ_CHARS: u64 = 12_000;
/// terminal_insert and terminal_execute text, counted as the schema's
/// maxLength and the UI's check count it (UTF-16 units): in bytes, text
/// outside ASCII was refused well short of it (round 66, R66-5).
const MAX_TERMINAL_TEXT_CHARS: usize = 8_000;
/// The longest a call holds its answer: as browser waits do (actions.rs), it
/// ends before the MCP client's own 60 s request limit, which a wait asked for
/// 60 s had crossed and come back as a bare "The operation timed out.".
const MAX_HELD_MS: u64 = 50_000;
/// Anbo listens this much past the deadline it gives the UI. The UI may start
/// an operation just before it while it is busy for seconds (20 terminals
/// opened at once right after a start), and its answer then still arrives.
const UI_GRACE_MS: u64 = 5_000;

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

/// A whole-number argument brought into its range and written back for the
/// UI. maxChars 20000 was an error that cost an agent a turn, and a number sent
/// as a string ("8000") was taken as no value at all.
fn clamped_integer(
    params: &mut Value,
    key: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, (String, String)> {
    let Some(raw) = params.get(key) else {
        return Ok(None);
    };
    let value = match raw {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite() && value.fract() == 0.0)
    .ok_or_else(|| {
        (
            error_codes::INVALID_REQUEST.to_string(),
            format!("{key} must be a whole number"),
        )
    })?;
    let value = value.clamp(minimum as f64, maximum as f64) as u64;
    params[key] = json!(value);
    Ok(Some(value))
}

fn validate_params(method: &str, params: &mut Value) -> Result<u64, (String, String)> {
    if !params.is_object() {
        return Err((
            error_codes::INVALID_REQUEST.to_string(),
            "agent and terminal tool arguments must be an object".to_string(),
        ));
    }
    required_bounded_string(params, "workspace", MAX_WORKSPACE_BYTES)?;
    if method == "terminal_open" {
        let title = required_bounded_string(params, "title", MAX_TERMINAL_TITLE_BYTES)?;
        if title.chars().any(char::is_control) || title.chars().count() > 64 {
            return Err((
                error_codes::INVALID_REQUEST.to_string(),
                "title must be one line with at most 64 characters".to_string(),
            ));
        }
    } else if matches!(
        method,
        "terminal_read"
            | "terminal_insert"
            | "terminal_execute"
            | "terminal_wait"
            | "terminal_interrupt"
            | "terminal_close"
    ) {
        required_bounded_string(params, "terminalId", MAX_TERMINAL_ID_BYTES)?;
    } else if !matches!(method, "agent_list" | "agent_spawn" | "terminal_list") {
        required_bounded_string(params, "agentId", MAX_AGENT_ID_BYTES)?;
    }
    // How long the UI has, from the request to its answer. A burst of opens
    // and commands makes it busy for seconds (20 terminals at once), and it
    // starts nothing after this deadline, so an agent told an operation timed
    // out never has it happen later.
    match method {
        "agent_list" | "agent_status" | "terminal_list" => Ok(10_000),
        "terminal_open" => Ok(15_000),
        "agent_spawn" => {
            let agent = required_bounded_string(params, "agent", 71)?;
            if agent.chars().any(char::is_control) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "agent contains control characters".to_string(),
                ));
            }
            let timeout = clamped_integer(params, "timeout", 100, MAX_HELD_MS)?.unwrap_or(15_000);
            Ok(timeout + 2_000)
        }
        "agent_read" | "terminal_read" => {
            optional_bounded_string(params, "cursor", MAX_CURSOR_BYTES)?;
            clamped_integer(params, "maxChars", 1, MAX_READ_CHARS)?;
            Ok(10_000)
        }
        "terminal_insert" | "terminal_execute" => {
            let text = required_bounded_string(params, "text", 4 * MAX_TERMINAL_TEXT_CHARS)?;
            if text.encode_utf16().count() > MAX_TERMINAL_TEXT_CHARS {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    format!("text exceeds {MAX_TERMINAL_TEXT_CHARS} characters"),
                ));
            }
            if text.chars().any(char::is_control) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "text must be one line and cannot contain control characters".to_string(),
                ));
            }
            Ok(15_000)
        }
        "terminal_wait" => {
            required_bounded_string(params, "executionId", MAX_TERMINAL_ID_BYTES)?;
            clamped_integer(params, "maxChars", 1, MAX_READ_CHARS)?;
            let timeout = clamped_integer(params, "timeout", 100, MAX_HELD_MS)?.unwrap_or(10_000);
            Ok(timeout + 2_000)
        }
        "terminal_interrupt" => {
            optional_bounded_string(params, "executionId", MAX_TERMINAL_ID_BYTES)?;
            Ok(10_000)
        }
        "terminal_close" => {
            if params.get("force").is_some_and(|force| !force.is_boolean()) {
                return Err((
                    error_codes::INVALID_REQUEST.to_string(),
                    "force must be true or false".to_string(),
                ));
            }
            Ok(10_000)
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
            let timeout = clamped_integer(params, "timeout", 100, MAX_HELD_MS)?.unwrap_or(30_000);
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
            let timeout = clamped_integer(params, "timeout", 100, MAX_HELD_MS)?.unwrap_or(10_000);
            Ok(timeout + 2_000)
        }
        _ => Err((
            error_codes::INVALID_REQUEST.to_string(),
            format!("unsupported agent or terminal method: {method}"),
        )),
    }
}

pub async fn handle_agent_action(
    app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, (String, String)> {
    let mut params = params;
    let timeout_ms = validate_params(method, &mut params)?;
    let mut answer = Answer::expect();
    let deadline = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + timeout_ms;
    if let Err(error) = app.emit(
        AGENT_REQUEST_EVENT,
        json!({
            "requestId": answer.request_id(),
            "method": method,
            "params": params,
            "deadline": deadline,
        }),
    ) {
        return Err((
            error_codes::INTERNAL.to_string(),
            format!("failed to request agent operation: {error}"),
        ));
    }

    let received = tokio::time::timeout(
        Duration::from_millis(timeout_ms + UI_GRACE_MS),
        answer.receiver(),
    )
    .await;
    let payload = received
        .map_err(|_| {
            (
                error_codes::TIMEOUT.to_string(),
                "Anbo UI did not complete the agent operation in time; it starts nothing after the request's deadline".to_string(),
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

    fn check(method: &str, params: Value) -> Result<u64, (String, String)> {
        let mut params = params;
        validate_params(method, &mut params)
    }

    #[test]
    fn validation_requires_explicit_workspace_and_agent() {
        let missing_workspace = check("agent_list", json!({})).unwrap_err();
        assert_eq!(missing_workspace.0, error_codes::INVALID_REQUEST);
        let missing_agent = check("agent_status", json!({ "workspace": "C:/repo" })).unwrap_err();
        assert_eq!(missing_agent.0, error_codes::INVALID_REQUEST);
        let missing_spawn_agent =
            check("agent_spawn", json!({ "workspace": "C:/repo" })).unwrap_err();
        assert_eq!(missing_spawn_agent.0, error_codes::INVALID_REQUEST);
    }

    #[test]
    fn validation_bounds_read_send_and_wait_inputs() {
        assert!(check(
            "agent_spawn",
            json!({ "workspace": "C:/repo", "agent": "Sample CLI" })
        )
        .is_ok());
        assert!(check(
            "agent_spawn",
            json!({ "workspace": "C:/repo", "agent": "custom:sample-cli" })
        )
        .is_ok());
        assert!(check(
            "agent_send",
            json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "message": "bad\u{0007}" })
        )
        .is_err());
        assert!(check(
            "agent_wait",
            json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "status": "done" })
        )
        .is_err());
        assert_eq!(
            check("terminal_list", json!({ "workspace": "C:/repo" })),
            Ok(10_000)
        );
        assert_eq!(
            check(
                "terminal_execute",
                json!({ "workspace": "C:/repo", "terminalId": "terminal:1:1", "text": "dir" })
            ),
            Ok(15_000)
        );
        assert_eq!(
            check(
                "terminal_open",
                json!({ "workspace": "C:/repo", "title": "Dev Server" })
            ),
            Ok(15_000)
        );
        assert!(check(
            "terminal_open",
            json!({ "workspace": "C:/repo", "title": "" })
        )
        .is_err());
        assert!(check(
            "terminal_execute",
            json!({ "workspace": "C:/repo", "terminalId": "terminal:1:1", "text": "one\ntwo" })
        )
        .is_err());
        assert!(check(
            "terminal_interrupt",
            json!({
                "workspace": "C:/repo",
                "terminalId": "terminal:1:1",
                "executionId": "terminal-execution:1:1:1"
            })
        )
        .is_ok());
        assert!(check(
            "terminal_interrupt",
            json!({
                "workspace": "C:/repo",
                "terminalId": "terminal:1:1",
                "executionId": "x".repeat(MAX_TERMINAL_ID_BYTES + 1)
            })
        )
        .is_err());
        assert!(check(
            "terminal_close",
            json!({ "workspace": "C:/repo", "terminalId": "terminal:1:1", "force": true })
        )
        .is_ok());
        assert!(check(
            "terminal_close",
            json!({ "workspace": "C:/repo", "terminalId": "terminal:1:1", "force": "yes" })
        )
        .is_err());
    }

    #[test]
    fn terminal_text_is_counted_in_characters_as_its_schema_says() {
        // Round 66 (R66-5): the schema and the UI allow 8,000 characters, but
        // this side counted bytes, so 4,000 accented letters were refused.
        let params = |text: String| {
            json!({ "workspace": "C:/repo", "terminalId": "terminal:1:1", "text": text })
        };
        for method in ["terminal_execute", "terminal_insert"] {
            assert!(validate_params(method, &mut params("é".repeat(8_000))).is_ok());
            assert!(validate_params(method, &mut params("a".repeat(8_000))).is_ok());
            let error = validate_params(method, &mut params("é".repeat(8_001))).unwrap_err();
            assert_eq!(error.1, "text exceeds 8000 characters");
            assert!(validate_params(method, &mut params("a".repeat(8_001))).is_err());
        }
    }

    #[test]
    fn numbers_out_of_range_or_written_as_strings_are_brought_into_range() {
        // Measured: maxChars 20000 and timeout 60000 cost agents a turn (an
        // error, and a bare client timeout); "8000" was read as no value.
        let mut params = json!({
            "workspace": "C:/repo",
            "terminalId": "terminal:1:1",
            "executionId": "terminal-execution:1:1:1",
            "maxChars": 20_000,
            "timeout": 60_000
        });
        assert_eq!(validate_params("terminal_wait", &mut params), Ok(52_000));
        assert_eq!(params["maxChars"], json!(12_000));
        assert_eq!(params["timeout"], json!(50_000));
        let mut params =
            json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "maxChars": "8000" });
        assert!(validate_params("agent_read", &mut params).is_ok());
        assert_eq!(params["maxChars"], json!(8_000));
        let mut params = json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "maxChars": 0 });
        assert!(validate_params("agent_read", &mut params).is_ok());
        assert_eq!(params["maxChars"], json!(1));
        for bad in [json!("many"), json!(12.5), json!(true)] {
            let mut params =
                json!({ "workspace": "C:/repo", "agentId": "agent:one:1", "maxChars": bad });
            assert!(validate_params("agent_read", &mut params).is_err());
        }
    }
}

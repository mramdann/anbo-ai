use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_SIZE: usize = 1024 * 1024; // 1 MiB

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstanceDescriptor {
    pub version: u32,
    pub pid: u32,
    pub pipe: String,
    pub token: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserRequest {
    pub version: u32,
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserResponse {
    pub version: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserError {
    pub code: String,
    pub message: String,
}

impl BrowserResponse {
    pub fn success(id: impl Into<String>, result: serde_json::Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: impl Into<String>, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(BrowserError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

pub mod error_codes {
    pub const APP_UNAVAILABLE: &str = "app_unavailable";
    pub const AUTOMATION_DISABLED: &str = "automation_disabled";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const UNSUPPORTED_PLATFORM: &str = "unsupported_platform";
    pub const TAB_NOT_FOUND: &str = "tab_not_found";
    pub const STALE_REF: &str = "stale_ref";
    pub const NAVIGATION_FAILED: &str = "navigation_failed";
    pub const CDP_FAILED: &str = "cdp_failed";
    pub const TIMEOUT: &str = "timeout";
    pub const RESPONSE_TOO_LARGE: &str = "response_too_large";
    pub const INTERNAL: &str = "internal";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_serialization() {
        let req = BrowserRequest {
            version: 1,
            id: "req-1".into(),
            token: "secret".into(),
            method: "snapshot".into(),
            params: serde_json::json!({ "tabId": 123 }),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: BrowserRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "req-1");
        assert_eq!(parsed.method, "snapshot");

        let resp =
            BrowserResponse::success("req-1", serde_json::json!({ "url": "http://localhost" }));
        let resp_json = serde_json::to_string(&resp).unwrap();
        assert!(resp_json.contains("\"ok\":true"));

        let err_resp =
            BrowserResponse::err("req-2", error_codes::STALE_REF, "Stale element reference");
        let err_json = serde_json::to_string(&err_resp).unwrap();
        assert!(err_json.contains("\"code\":\"stale_ref\""));
    }

    #[test]
    fn test_instance_descriptor_serialization() {
        let desc = InstanceDescriptor {
            version: 1,
            pid: 1234,
            pipe: r"\\.\pipe\anbo-test".into(),
            token: "tok123".into(),
            started_at: 1700000000,
        };
        let json = serde_json::to_string(&desc).unwrap();
        assert!(json.contains("\"startedAt\":1700000000"));
        let parsed: InstanceDescriptor = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, desc);
    }
}

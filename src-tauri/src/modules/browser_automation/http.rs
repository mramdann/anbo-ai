//! Streamable HTTP MCP server (single `/mcp` endpoint), hosted inside the app.
//! Lets external clients (e.g. Claude Code) drive browser automation with a
//! static URL config, with no external binary. Calls `handle_action` in-process.
//!
//! Spec: one MCP endpoint supporting POST (+ optional GET); a JSON-RPC *request*
//! may be answered with a plain `application/json` object (no SSE needed for our
//! non-streaming tools). Stateless (no `Mcp-Session-Id`). Bound to 127.0.0.1 with
//! Origin validation to prevent DNS rebinding. GET/DELETE → 405.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::net::TcpListener;

use crate::modules::browser_automation::actions::handle_action;
use crate::modules::browser_automation::mcp::{self, PROTOCOL_VERSION, SERVER_NAME};
use crate::modules::browser_automation::protocol::MAX_REQUEST_SIZE;

const BIND_ADDR: &str = "127.0.0.1:7331";
pub const MCP_URL: &str = "http://127.0.0.1:7331/mcp";

static HTTP_RUNNING: AtomicBool = AtomicBool::new(false);
static HTTP_CANCEL_TX: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);

pub fn is_running() -> bool {
    HTTP_RUNNING.load(Ordering::SeqCst)
}

/// Start the HTTP MCP server alongside the named-pipe server. Failure to bind
/// is logged but does not disable the named-pipe path.
pub fn start(app: AppHandle) -> Result<(), String> {
    if is_running() {
        return Ok(());
    }
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
        *guard = Some(cancel_tx);
    }
    HTTP_RUNNING.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(BIND_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("[browser_automation] http: failed to bind {BIND_ADDR}: {e}");
                HTTP_RUNNING.store(false, Ordering::SeqCst);
                if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
                    *guard = None;
                }
                return;
            }
        };
        log::info!("[browser_automation] http: MCP endpoint listening at {MCP_URL}");

        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    log::info!("[browser_automation] http: received stop signal");
                    break;
                }
                accept = listener.accept() => {
                    let (stream, _) = match accept {
                        Ok(s) => s,
                        Err(e) => {
                            log::warn!("[browser_automation] http: accept failed: {e}");
                            continue;
                        }
                    };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let svc = hyper::service::service_fn(move |req| {
                            let app = app.clone();
                            async move { handle(req, app).await }
                        });
                        if let Err(e) = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, svc)
                            .await
                        {
                            log::warn!("[browser_automation] http: connection error: {e}");
                        }
                    });
                }
            }
        }

        HTTP_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

pub fn stop() {
    if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    HTTP_RUNNING.store(false, Ordering::SeqCst);
}

/// Reject foreign `Origin` (DNS-rebinding guard). Absent Origin (CLI clients
/// like Claude Code) and localhost/127.0.0.1 origins are allowed.
fn origin_ok(headers: &hyper::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(hyper::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }

    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

async fn handle(
    req: hyper::Request<hyper::body::Incoming>,
    app: AppHandle,
) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path();
    if path != "/mcp" {
        return Ok(empty(404));
    }
    if req.method() != hyper::Method::POST {
        // GET/DELETE/etc. on /mcp → 405 (we don't offer an SSE stream).
        return Ok(empty(405));
    }
    if !origin_ok(req.headers()) {
        return Ok(empty(403));
    }

    // Cap the body via Content-Length up front, then read it.
    if let Some(cl) = content_length(req.headers()) {
        if cl > MAX_REQUEST_SIZE {
            return Ok(empty(413));
        }
    }
    let body_bytes = match Limited::new(req.into_body(), MAX_REQUEST_SIZE)
        .collect()
        .await
    {
        Ok(b) => b.to_bytes(),
        Err(_) => return Ok(empty(413)),
    };
    if body_bytes.len() > MAX_REQUEST_SIZE {
        return Ok(empty(413));
    }

    let req_obj: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => {
            return Ok(json_ok(rpc_error(
                Value::Null,
                -32700,
                &format!("Parse error: {e}"),
            )))
        }
    };

    // Notifications have no `id` → 202 Accepted, no body.
    let id = req_obj.get("id").cloned();
    if id.is_none() {
        return Ok(empty(202));
    }
    let id = id.unwrap_or(Value::Null);

    let method = req_obj.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = req_obj.get("params").cloned().unwrap_or(json!({}));
    let outcome = dispatch(&app, method, &params).await;
    let resp = match outcome {
        Ok(result) => rpc_success(id, result),
        Err((code, msg)) => rpc_error(id, code, &msg),
    };
    Ok(json_ok(resp))
}

/// Resolve a JSON-RPC method to its MCP result. Tool execution errors come back
/// as an `isError` result (per MCP), not a JSON-RPC error.
async fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, (i32, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": mcp::tool_definitions() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or((-32602, "tools/call requires a 'name'".to_string()))?;
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            let action_method = mcp::tool_name_to_method(name)
                .ok_or_else(|| (-32601, format!("unknown tool '{name}'")))?;
            match handle_action(app, action_method, arguments).await {
                Ok(val) => Ok(json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }]
                })),
                Err((code, msg)) => Ok(json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: [{code}] {msg}") }]
                })),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn rpc_success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn content_length(headers: &hyper::HeaderMap) -> Option<usize> {
    headers
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
}

fn json_ok(body: Value) -> hyper::Response<Full<Bytes>> {
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    hyper::Response::builder()
        .status(200)
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", bytes.len().to_string())
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}

fn empty(status: u16) -> hyper::Response<Full<Bytes>> {
    hyper::Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allows_cli_and_loopback_hosts() {
        let mut h = hyper::HeaderMap::new();
        assert!(origin_ok(&h)); // no Origin (CLI)

        for origin in [
            "http://localhost:5173",
            "https://127.0.0.1",
            "http://[::1]:7331",
        ] {
            h.insert("origin", origin.parse().unwrap());
            assert!(origin_ok(&h), "expected loopback origin: {origin}");
        }
    }

    #[test]
    fn origin_rejects_foreign_and_deceptive_hosts() {
        let mut h = hyper::HeaderMap::new();
        for origin in [
            "https://evil.example",
            "https://localhost.evil.example",
            "https://127.0.0.1.evil.example",
            "not a url",
        ] {
            h.insert("origin", origin.parse().unwrap());
            assert!(!origin_ok(&h), "expected foreign origin: {origin}");
        }
    }
}

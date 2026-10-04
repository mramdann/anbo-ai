//! Streamable HTTP MCP server (single `/mcp` endpoint), hosted inside the app.
//! Lets external clients (e.g. Claude Code) drive browser automation with a
//! static URL config, with no external binary. Calls `handle_action` in-process.
//!
//! Spec: one MCP endpoint supporting POST (+ optional GET); a JSON-RPC *request*
//! may be answered with a plain `application/json` object (no SSE needed for our
//! non-streaming tools). Bounded sessions retain display-only client identity;
//! legacy sessionless calls remain supported. Bound to loopback with Origin validation.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;

use super::caller::{self, Caller};
use crate::modules::browser_automation::actions::handle_action_as;
use crate::modules::browser_automation::mcp::{self, PROTOCOL_VERSION, SERVER_NAME};
use crate::modules::browser_automation::protocol::MAX_REQUEST_SIZE;

const BIND_ADDR: &str = "127.0.0.1:7331";
pub const MCP_URL: &str = "http://127.0.0.1:7331/mcp";
/// Raised each time the endpoint takes its port or fails to.
pub const STATUS_EVENT: &str = "anbo://mcp-status";

static HTTP_RUNNING: AtomicBool = AtomicBool::new(false);
static HTTP_CANCEL_TX: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);
static HTTP_STATE: Mutex<(McpState, Option<BindFailure>)> = Mutex::new((McpState::Off, None));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpState {
    Off,
    Starting,
    Listening,
    Failed,
}

/// The process holding the port the endpoint could not take.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PortHolder {
    pub pid: u32,
    pub name: Option<String>,
}

#[derive(Clone, Debug)]
struct BindFailure {
    error: String,
    in_use: bool,
    holder: Option<PortHolder>,
}

/// What the UI is told. Every agent Anbo sets up is configured with this exact
/// URL, so while another app holds the port the agents talk to that app, and
/// the log used to be the only place that said so.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub state: McpState,
    pub url: &'static str,
    pub error: Option<String>,
    pub in_use: bool,
    pub holder: Option<PortHolder>,
}

pub fn is_running() -> bool {
    HTTP_RUNNING.load(Ordering::SeqCst)
}

pub fn status() -> McpStatus {
    let guard = HTTP_STATE.lock().unwrap_or_else(|error| error.into_inner());
    status_of(guard.0, guard.1.as_ref())
}

fn status_of(state: McpState, failure: Option<&BindFailure>) -> McpStatus {
    McpStatus {
        state,
        url: MCP_URL,
        error: failure.map(|failure| failure.error.clone()),
        in_use: failure.is_some_and(|failure| failure.in_use),
        holder: failure.and_then(|failure| failure.holder.clone()),
    }
}

fn set_state(state: McpState, failure: Option<BindFailure>) {
    *HTTP_STATE.lock().unwrap_or_else(|error| error.into_inner()) = (state, failure);
}

pub fn announce(app: &AppHandle) {
    if let Err(error) = app.emit(STATUS_EVENT, status()) {
        log::warn!("[browser_automation] http: could not announce the endpoint state: {error}");
    }
}

/// Who holds the port: pid and executable name, where the platform says.
async fn port_holder() -> Option<PortHolder> {
    #[cfg(windows)]
    {
        let addr = BIND_ADDR.parse::<std::net::SocketAddrV4>().ok()?;
        tauri::async_runtime::spawn_blocking(move || {
            let pid = super::peer::listener_pid(addr)?;
            let name = crate::modules::browser_external::browser_process::image_path(pid)
                .and_then(|path| Some(path.file_name()?.to_string_lossy().into_owned()));
            Some(PortHolder { pid, name })
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Try the port again, for after the user closed whatever held it. Only a
/// failed endpoint restarts: one that is off was turned off on purpose.
pub async fn retry(app: AppHandle) -> McpStatus {
    if status().state == McpState::Failed {
        let _ = start(app);
    }
    // A bind resolves in milliseconds; the deadline only bounds a stuck runtime.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while status().state == McpState::Starting && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    status()
}

/// Start the HTTP MCP server alongside the named-pipe server. Failure to bind
/// does not disable the named-pipe path; it is logged and announced, naming
/// the process that holds the port.
pub fn start(app: AppHandle) -> Result<(), String> {
    if is_running() {
        return Ok(());
    }
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
        *guard = Some(cancel_tx);
    }
    HTTP_RUNNING.store(true, Ordering::SeqCst);
    set_state(McpState::Starting, None);

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(BIND_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("[browser_automation] http: failed to bind {BIND_ADDR}: {e}");
                HTTP_RUNNING.store(false, Ordering::SeqCst);
                if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
                    *guard = None;
                }
                let in_use = e.kind() == std::io::ErrorKind::AddrInUse;
                let holder = if in_use { port_holder().await } else { None };
                if let Some(holder) = &holder {
                    log::error!(
                        "[browser_automation] http: {BIND_ADDR} is held by pid {} ({})",
                        holder.pid,
                        holder.name.as_deref().unwrap_or("image unknown")
                    );
                }
                set_state(
                    McpState::Failed,
                    Some(BindFailure {
                        error: e.to_string(),
                        in_use,
                        holder,
                    }),
                );
                announce(&app);
                return;
            }
        };
        log::info!("[browser_automation] http: MCP endpoint listening at {MCP_URL}");
        set_state(McpState::Listening, None);
        announce(&app);

        // Every open connection watches this, so a stop reaches the agents
        // already connected and not only the next ones.
        let (closing_tx, closing_rx) = tokio::sync::watch::channel(false);
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    log::info!("[browser_automation] http: received stop signal");
                    let _ = closing_tx.send(true);
                    break;
                }
                accept = listener.accept() => {
                    let (stream, peer) = match accept {
                        Ok(s) => s,
                        Err(e) => {
                            log::warn!("[browser_automation] http: accept failed: {e}");
                            continue;
                        }
                    };
                    let app = app.clone();
                    let closing = closing_rx.clone();
                    tauri::async_runtime::spawn(async move {
                        let local = stream.local_addr().ok();
                        let owner = std::sync::Arc::new(tokio::sync::OnceCell::new());
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let svc = hyper::service::service_fn(move |req| {
                            let app = app.clone();
                            let owner = owner.clone();
                            async move { handle(req, app, peer, local, owner).await }
                        });
                        if let Err(e) = serve_until_closed(io, svc, closing).await {
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

/// Serves one connection until the client leaves or the endpoint stops. On a
/// stop the request in flight finishes and the connection closes: turning
/// browser automation off used to leave a kept-alive client free to initialize
/// again on its open socket and go on driving the browser.
async fn serve_until_closed<S>(
    io: hyper_util::rt::TokioIo<tokio::net::TcpStream>,
    service: S,
    mut closing: tokio::sync::watch::Receiver<bool>,
) -> Result<(), hyper::Error>
where
    S: hyper::service::HttpService<hyper::body::Incoming>,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    S::ResBody: 'static,
    <S::ResBody as hyper::body::Body>::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let connection = hyper::server::conn::http1::Builder::new().serve_connection(io, service);
    tokio::pin!(connection);
    tokio::select! {
        result = connection.as_mut() => result,
        // A dropped sender means the endpoint is gone as well.
        _ = closing.changed() => {
            connection.as_mut().graceful_shutdown();
            connection.await
        }
    }
}

pub fn stop() {
    caller::clear_sessions();
    if let Ok(mut guard) = HTTP_CANCEL_TX.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    HTTP_RUNNING.store(false, Ordering::SeqCst);
    set_state(McpState::Off, None);
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
    peer: std::net::SocketAddr,
    local: Option<std::net::SocketAddr>,
    owner: std::sync::Arc<tokio::sync::OnceCell<Option<u32>>>,
) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
    let path = req.uri().path();
    if path != "/mcp" {
        return Ok(empty(404));
    }
    if !origin_ok(req.headers()) {
        return Ok(empty(403));
    }
    let session_id = req
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if req.method() == hyper::Method::DELETE {
        if let Some(id) = session_id {
            if let Some(caller) = caller::remove_session(&id) {
                super::activity::end_owner(&app, &caller);
            }
        }
        return Ok(empty(204));
    }
    if req.method() != hyper::Method::POST {
        return Ok(empty(405));
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
    let mut new_session = None;
    let actor = if method == "initialize" {
        let pty_id = owner
            .get_or_init(|| async {
                match local {
                    Some(local) => super::peer::http_owner(app.clone(), peer, local).await,
                    None => None,
                }
            })
            .await;
        match caller::create_session(&params["clientInfo"], *pty_id) {
            Ok(id) => new_session = Some(id),
            Err(_) => return Ok(empty(503)),
        }
        Caller::default()
    } else if let Some(id) = session_id {
        match caller::session_caller(&id) {
            Some(actor) => actor,
            None => return Ok(empty(404)),
        }
    } else if method == "tools/call" {
        // A tool call is an action on the user's screen, so it has to say who
        // is acting. Serving one without the session id from initialize meant
        // Anbo drove a real browser for a caller it could not name, and the tab
        // it opened then showed that anonymity as if it were an identity.
        // Discovery stays open: initialize, ping and tools/list need no session.
        return Ok(json_ok(rpc_error(
            id,
            -32600,
            "missing Mcp-Session-Id: send the session id returned by initialize on every tools/call",
        )));
    } else {
        Caller::default()
    };
    let outcome = dispatch(&app, method, &params, actor).await;
    let resp = match outcome {
        Ok(result) => rpc_success(id, result),
        Err((code, msg)) => rpc_error(id, code, &msg),
    };
    let mut response = json_ok(resp);
    if let Some(id) = new_session {
        if let Ok(value) = id.parse() {
            response.headers_mut().insert("mcp-session-id", value);
        }
    }
    Ok(response)
}

/// Resolve a JSON-RPC method to its MCP result. Tool execution errors come back
/// as an `isError` result (per MCP), not a JSON-RPC error.
async fn dispatch(
    app: &AppHandle,
    method: &str,
    params: &Value,
    caller: Caller,
) -> Result<Value, (i32, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            // Every MCP client shows this to its model on connect, whichever
            // CLI it is. Without it the skills sit there unread: a tool nothing
            // points at is a tool nobody calls. Kept short, because it is
            // prepended to a context window that has work to do.
            "instructions": format!("{} {}", mcp::SERVER_INSTRUCTIONS, mcp::BROWSER_SESSION_INSTRUCTIONS)
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
            match handle_action_as(app, action_method, arguments, caller).await {
                Ok(val) => Ok(tool_result(val)),
                Err((code, msg)) => Ok(json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Error: [{code}] {msg}") }]
                })),
            }
        }
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

/// One tool reply: the JSON as compact text, plus an image block when the
/// action produced one.
///
/// Compact rather than pretty: the indentation of a pretty-printed reply is
/// tokens the model pays for on every later turn and reads nothing from.
/// Measured over fifteen agent-driven tasks, tool replies were a third of the
/// text the model read. A screenshot travels as MCP image content so the agent
/// sees it in the same turn instead of spending another call reading the file.
fn tool_result(mut value: Value) -> Value {
    let image = value
        .as_object_mut()
        .and_then(|object| object.remove("inlineImage"));
    let mut content =
        vec![json!({ "type": "text", "text": serde_json::to_string(&value).unwrap_or_default() })];
    if let Some(image) = image {
        if let (Some(data), Some(mime)) = (
            image.get("data").and_then(Value::as_str),
            image.get("mimeType").and_then(Value::as_str),
        ) {
            content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
        }
    }
    json!({ "content": content })
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

    #[tokio::test]
    async fn a_stop_closes_a_kept_alive_connection_after_its_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (closing_tx, closing_rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = hyper::service::service_fn(|_request| async {
                Ok::<_, Infallible>(hyper::Response::new(Full::new(Bytes::from_static(b"ok"))))
            });
            serve_until_closed(hyper_util::rt::TokioIo::new(stream), service, closing_rx).await
        });

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = b"POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\n\r\n";
        let mut reply = [0u8; 512];
        client.write_all(request).await.unwrap();
        let read = client.read(&mut reply).await.unwrap();
        assert!(
            reply[..read].starts_with(b"HTTP/1.1 200"),
            "the open connection is served"
        );

        closing_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("the connection ends once the endpoint stops")
            .unwrap()
            .unwrap();
        // Nothing answers on that socket any more, so a client can no longer
        // initialize again on it and go on.
        let _ = client.write_all(request).await;
        assert_eq!(client.read(&mut reply).await.unwrap_or(0), 0);
    }

    #[test]
    fn a_failed_bind_tells_the_ui_who_holds_the_port() {
        let failure = BindFailure {
            error: "Only one usage of each socket address is normally permitted.".into(),
            in_use: true,
            holder: Some(PortHolder {
                pid: 5688,
                name: Some("zeron.exe".into()),
            }),
        };
        assert_eq!(
            serde_json::to_value(status_of(McpState::Failed, Some(&failure))).unwrap(),
            json!({
                "state": "failed",
                "url": MCP_URL,
                "error": "Only one usage of each socket address is normally permitted.",
                "inUse": true,
                "holder": { "pid": 5688, "name": "zeron.exe" },
            })
        );
        assert_eq!(
            serde_json::to_value(status_of(McpState::Listening, None)).unwrap(),
            json!({
                "state": "listening",
                "url": MCP_URL,
                "error": null,
                "inUse": false,
                "holder": null,
            })
        );
    }

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

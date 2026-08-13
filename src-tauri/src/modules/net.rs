use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, COOKIE, LOCATION,
    PROXY_AUTHORIZATION,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const HEADER_BLOCKLIST: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
];
const MAX_REDIRECTS: usize = 10;

fn normalize_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn is_blocked_host_name(host: &str) -> bool {
    let host = normalize_host(host).to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata.google.internal" | "metadata" | "metadata.azure.com"
    )
}

fn ip_kind(ip: IpAddr) -> IpKind {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            // Cloud metadata IPv4: 169.254.169.254
            if v.is_link_local() {
                return IpKind::BlockedMetadata;
            }
            if v.is_loopback() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // RFC1918 + CGNAT + benchmarking + IETF
            if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            {
                return IpKind::Private;
            }
            IpKind::Public
        }
        IpAddr::V6(v) => {
            if let Some(mapped) = v.to_ipv4_mapped() {
                return ip_kind(IpAddr::V4(mapped));
            }
            if v.is_loopback() || v.is_unspecified() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // Cloud metadata IPv6 (AWS): fd00:ec2::254
            let segs = v.segments();
            if segs[0] == 0xfd00 && segs[1] == 0xec2 {
                return IpKind::BlockedMetadata;
            }
            // fe80::/10 link-local
            if segs[0] & 0xffc0 == 0xfe80 {
                return IpKind::BlockedMetadata;
            }
            // fc00::/7 unique-local (private)
            if segs[0] & 0xfe00 == 0xfc00 {
                return IpKind::Private;
            }
            IpKind::Public
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpKind {
    Public,
    Private,
    Loopback,
    BlockedMetadata,
}

/// Resolve `host` once and return both its safety classification and the
/// concrete IPs we resolved. Callers can pin reqwest to these IPs to defeat
/// DNS rebinding (where a second lookup returns a different address).
async fn resolve_and_classify(host: &str) -> Result<(IpKind, Vec<IpAddr>), String> {
    let host = normalize_host(host);
    // Direct literal? Skip DNS.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok((ip_kind(ip), vec![ip]));
    }
    let host_owned = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || {
        (host_owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|a| a.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("dns: {e}"))?;
    if lookup.is_empty() {
        return Err("dns: no addresses".into());
    }
    let mut worst = IpKind::Public;
    for ip in &lookup {
        let k = ip_kind(*ip);
        worst = match (worst, k) {
            (_, IpKind::BlockedMetadata) => IpKind::BlockedMetadata,
            (IpKind::BlockedMetadata, _) => IpKind::BlockedMetadata,
            (IpKind::Public, x) => x,
            (x, IpKind::Public) => x,
            (a, _) => a,
        };
    }
    Ok((worst, lookup))
}

use std::net::ToSocketAddrs;

fn validate_url(url: &str, allow_private: bool) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host_name(host) {
        return Err(format!("host not allowed: {host}"));
    }
    // The actual IP classification has to be async — caller does it.
    let _ = allow_private;
    Ok(parsed)
}

/// Classify the host AND return safe IPs to pin reqwest's resolver to.
/// Defeats DNS rebinding (second-lookup-returns-different-IP) by reusing
/// exactly the addresses that passed `ip_kind`.
async fn classify_and_collect_safe_ips(
    host: &str,
    allow_private: bool,
) -> Result<Vec<IpAddr>, String> {
    let (worst, ips) = resolve_and_classify(host).await?;
    match worst {
        IpKind::BlockedMetadata => return Err(format!("host not allowed: {host}")),
        IpKind::Loopback | IpKind::Private if !allow_private => {
            return Err(format!(
                "host {host} resolves to a private/loopback address; this endpoint requires explicit opt-in",
            ));
        }
        _ => {}
    }
    let safe: Vec<IpAddr> = ips
        .into_iter()
        .filter(|ip| match ip_kind(*ip) {
            IpKind::BlockedMetadata => false,
            IpKind::Loopback | IpKind::Private => allow_private,
            IpKind::Public => true,
        })
        .collect();
    if safe.is_empty() {
        return Err(format!("host {host}: no safe IPs"));
    }
    Ok(safe)
}

fn sanitize_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(h) = headers else { return Ok(map) };
    for (k, v) in h {
        let lower = k.to_ascii_lowercase();
        if HEADER_BLOCKLIST.contains(&lower.as_str()) {
            return Err(format!("header not allowed: {k}"));
        }
        // CRLF injection: header value must not contain CR / LF / NUL.
        if v.as_bytes().iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(format!("header value contains control bytes: {k}"));
        }
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

#[tauri::command]
pub async fn lm_ping(base_url: String) -> Result<u16, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty base url".into());
    }
    let probe = format!("{trimmed}/models");
    let parsed = validate_url(&probe, true)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let safe_ips = classify_and_collect_safe_ips(&host, true).await?;

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
    builder = builder.resolve_to_addrs(&host, &addrs);
    let client = builder.build().map_err(|e| e.to_string())?;
    client
        .get(parsed)
        .send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}
// AI HTTP proxy — bypasses webview CORS / Mixed-Content / PNA so local-network
// model servers (LM Studio, Ollama, vLLM) work in the production bundle.

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

fn build_request(
    client: &reqwest::Client,
    method: Method,
    url: reqwest::Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
) -> reqwest::RequestBuilder {
    let mut request = client.request(method, url).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    request
}

fn build_safe_client(
    _allow_private: bool,
    pinned: &[(String, Vec<IpAddr>)],
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(10));
    // Pin reqwest's resolver to the IPs we just classified. Without this,
    // reqwest's own DNS lookup could return a different (private/metadata) IP
    // for the same hostname between classify and connect — classic DNS
    // rebinding attack. We pin port 0 because reqwest fills in the actual
    // port from the URL when wiring up the override map.
    for (host, ips) in pinned {
        let addrs: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
        if !addrs.is_empty() {
            builder = builder.resolve_to_addrs(host, &addrs);
        }
    }
    builder
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn same_origin(left: &reqwest::Url, right: &reqwest::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn apply_redirect_semantics(
    status: reqwest::StatusCode,
    method: &mut Method,
    headers: &mut HeaderMap,
    body: &mut Option<Vec<u8>>,
) {
    let switch_to_get = status == reqwest::StatusCode::SEE_OTHER && *method != Method::HEAD
        || matches!(
            status,
            reqwest::StatusCode::MOVED_PERMANENTLY | reqwest::StatusCode::FOUND
        ) && *method == Method::POST;
    if switch_to_get {
        *method = Method::GET;
        *body = None;
        headers.remove(CONTENT_TYPE);
    }
}

async fn send_protected_request(
    initial_url: reqwest::Url,
    initial_method: Method,
    initial_headers: HeaderMap,
    initial_body: Option<Vec<u8>>,
    allow_private: bool,
) -> Result<reqwest::Response, String> {
    let mut url = initial_url;
    let mut method = initial_method;
    let mut headers = initial_headers;
    let mut body = initial_body;

    for redirect_count in 0..=MAX_REDIRECTS {
        let validated = validate_url(url.as_str(), allow_private)?;
        let host = validated
            .host_str()
            .ok_or_else(|| "missing host".to_string())?
            .to_string();
        let safe_ips = classify_and_collect_safe_ips(&host, allow_private).await?;
        let client = build_safe_client(allow_private, &[(host, safe_ips)])?;
        let response = build_request(
            &client,
            method.clone(),
            validated.clone(),
            headers.clone(),
            body.clone(),
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

        if !response.status().is_redirection() {
            return Ok(response);
        }
        let Some(location) = response.headers().get(LOCATION) else {
            return Ok(response);
        };
        if redirect_count == MAX_REDIRECTS {
            return Err(format!("too many redirects; maximum is {MAX_REDIRECTS}"));
        }
        let location = location
            .to_str()
            .map_err(|_| "redirect location is not valid text".to_string())?;
        let next = validated
            .join(location)
            .map_err(|e| format!("invalid redirect location: {e}"))?;
        validate_url(next.as_str(), allow_private)?;
        if !same_origin(&validated, &next) {
            headers.remove(AUTHORIZATION);
            headers.remove(COOKIE);
            headers.remove(PROXY_AUTHORIZATION);
        }
        apply_redirect_semantics(response.status(), &mut method, &mut headers, &mut body);
        url = next;
    }

    Err("redirect processing failed".into())
}

fn header_map_to_strings(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

#[tauri::command]
pub async fn ai_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
) -> Result<HttpResponse, String> {
    let allow_private = allow_private_network.unwrap_or(false);
    let parsed = validate_url(&url, allow_private)?;
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let headers = sanitize_headers(headers)?;
    let resp = send_protected_request(parsed, method, headers, body, allow_private).await?;

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

#[derive(Default)]
struct StreamCancellationState {
    active: HashMap<String, tokio::sync::watch::Sender<bool>>,
    pending: HashMap<String, Instant>,
}

fn stream_cancellations() -> &'static std::sync::Mutex<StreamCancellationState> {
    static STATE: OnceLock<std::sync::Mutex<StreamCancellationState>> = OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(StreamCancellationState::default()))
}

struct StreamCancellationGuard(String);

impl Drop for StreamCancellationGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = stream_cancellations().lock() {
            streams.active.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn ai_http_cancel(request_id: String) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid AI HTTP request id".into());
    }
    let mut streams = stream_cancellations()
        .lock()
        .map_err(|_| "AI HTTP cancellation state unavailable".to_string())?;
    streams
        .pending
        .retain(|_, created| created.elapsed() < Duration::from_secs(60));
    if let Some(cancel) = streams.active.remove(&request_id) {
        let _ = cancel.send(true);
    } else if streams.pending.len() < 256 {
        streams.pending.insert(request_id, Instant::now());
    }
    Ok(())
}

pub fn cancel_all_streams() {
    if let Ok(mut streams) = stream_cancellations().lock() {
        for (_, cancel) in streams.active.drain() {
            let _ = cancel.send(true);
        }
        streams.pending.clear();
    }
}

#[tauri::command]
pub async fn ai_http_stream(
    request_id: String,
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    allow_private_network: Option<bool>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid AI HTTP request id".into());
    }
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut streams = stream_cancellations()
            .lock()
            .map_err(|_| "AI HTTP cancellation state unavailable".to_string())?;
        streams
            .pending
            .retain(|_, created| created.elapsed() < Duration::from_secs(60));
        if streams.pending.remove(&request_id).is_some() {
            return Ok(());
        }
        if streams.active.len() >= 64 {
            return Err("too many active AI HTTP streams".into());
        }
        if let Some(previous) = streams.active.insert(request_id.clone(), cancel_tx) {
            let _ = previous.send(true);
        }
    }
    let _cancel_guard = StreamCancellationGuard(request_id);
    let allow_private = allow_private_network.unwrap_or(false);
    let parsed = match validate_url(&url, allow_private) {
        Ok(p) => p,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let method = match Method::from_bytes(method.as_bytes()) {
        Ok(method) => method,
        Err(e) => {
            let message = e.to_string();
            let _ = on_event.send(AiStreamEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };
    let headers = match sanitize_headers(headers) {
        Ok(headers) => headers,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let resp = match tokio::select! {
        result = send_protected_request(parsed, method, headers, body, allow_private) => Some(result),
        _ = cancel_rx.changed() => None,
    } {
        Some(Ok(response)) => response,
        Some(Err(e)) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
        None => return Ok(()),
    };

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let _ = on_event.send(AiStreamEvent::Headers { status, headers });

    let mut stream = resp.bytes_stream();
    loop {
        let item = tokio::select! {
            item = stream.next() => item,
            _ = cancel_rx.changed() => return Ok(()),
        };
        let Some(item) = item else { break };
        match item {
            Ok(chunk) => {
                let bytes: Bytes = chunk;
                if on_event
                    .send(AiStreamEvent::Chunk {
                        bytes: bytes.to_vec(),
                    })
                    .is_err()
                {
                    // Channel dropped (frontend aborted) — stop streaming.
                    return Ok(());
                }
            }
            Err(e) => {
                let _ = on_event.send(AiStreamEvent::Error {
                    message: e.to_string(),
                });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn metadata_ips_classified_as_blocked() {
        // AWS / Google / Azure all share the IPv4 169.254.169.254 link-local.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
            IpKind::BlockedMetadata
        );
        // AWS IPv6 metadata
        assert_eq!(
            ip_kind("fd00:ec2::254".parse().unwrap()),
            IpKind::BlockedMetadata
        );
        // Any link-local IPv4 (169.254/16) — same network range, still blocked.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))),
            IpKind::BlockedMetadata
        );
        // IPv6 link-local fe80::/10
        assert_eq!(ip_kind("fe80::1".parse().unwrap()), IpKind::BlockedMetadata);
    }

    #[test]
    fn private_ips_classified_correctly() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
            IpKind::Private
        );
        // CGNAT 100.64/10
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            IpKind::Private
        );
    }

    #[test]
    fn loopback_classified_as_loopback() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            IpKind::Loopback
        );
        assert_eq!(ip_kind("::1".parse().unwrap()), IpKind::Loopback);
        assert_eq!(
            ip_kind("::ffff:127.0.0.1".parse().unwrap()),
            IpKind::Loopback
        );
    }

    #[test]
    fn mapped_metadata_is_blocked() {
        assert_eq!(
            ip_kind("::ffff:169.254.169.254".parse().unwrap()),
            IpKind::BlockedMetadata
        );
    }

    #[tokio::test]
    async fn bracketed_mapped_metadata_is_blocked_without_dns() {
        let result = classify_and_collect_safe_ips("[::ffff:169.254.169.254]", true).await;
        assert!(result.unwrap_err().contains("not allowed"));
    }

    #[tokio::test]
    async fn redirect_destination_to_private_network_requires_opt_in() {
        let private = "::ffff:127.0.0.1";
        let result = classify_and_collect_safe_ips(private, false).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn redirect_destination_to_metadata_is_always_blocked() {
        let metadata = "::ffff:169.254.169.254";
        let result = classify_and_collect_safe_ips(metadata, true).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn manual_redirect_revalidates_mapped_metadata_destination() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://[::ffff:169.254.169.254]/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write redirect");
        });

        let url = reqwest::Url::parse(&format!("http://{address}/start")).unwrap();
        let result = send_protected_request(url, Method::GET, HeaderMap::new(), None, true).await;
        server.await.expect("server task");
        let error = result.expect_err("metadata redirect must be blocked");
        assert!(error.contains("not allowed"), "got: {error}");
    }

    #[test]
    fn public_ips_classified_as_public() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            IpKind::Public
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))),
            IpKind::Public
        );
    }

    #[test]
    fn validate_url_blocks_userinfo_and_metadata_hostnames() {
        // URLs with userinfo can confuse browsers / leak creds in redirects.
        assert!(validate_url("http://user:pass@example.com/", true).is_err());
        // Cloud metadata-by-name.
        assert!(validate_url("http://metadata.google.internal/", true).is_err());
        assert!(validate_url("http://metadata/", true).is_err());
        assert!(validate_url("http://metadata.azure.com/", true).is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        assert!(validate_url("ftp://example.com/", true).is_err());
        assert!(validate_url("file:///etc/passwd", true).is_err());
        assert!(validate_url("javascript:alert(1)", true).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_crlf_injection() {
        let mut h = HashMap::new();
        h.insert("X-Foo".to_string(), "bar\r\nX-Evil: yes".to_string());
        assert!(sanitize_headers(Some(h)).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_hop_by_hop_headers() {
        for hop in [
            "host",
            "content-length",
            "connection",
            "proxy-authorization",
        ] {
            let mut h = HashMap::new();
            h.insert(hop.to_string(), "value".to_string());
            assert!(
                sanitize_headers(Some(h)).is_err(),
                "expected {hop} to be rejected"
            );
        }
    }
}

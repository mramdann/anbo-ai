use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[cfg(windows)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::modules::app_data::local_data_root;
#[cfg(windows)]
use crate::modules::browser_automation::actions::handle_action;
#[cfg(windows)]
use crate::modules::browser_automation::protocol::{
    error_codes, BrowserRequest, BrowserResponse, InstanceDescriptor, MAX_REQUEST_SIZE,
    PROTOCOL_VERSION,
};

static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
static SERVER_CANCEL_TX: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

pub fn is_running() -> bool {
    SERVER_RUNNING.load(Ordering::SeqCst)
}

fn descriptor_path() -> Result<PathBuf, String> {
    let root = local_data_root()?;
    let dir = root.join("runtime").join("browser");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create runtime browser dir: {e}"))?;
    Ok(dir.join("instance.json"))
}

pub fn remove_descriptor() {
    if let Ok(path) = descriptor_path() {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn cleanup_stale_descriptor() {
    if let Ok(path) = descriptor_path() {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                #[cfg(windows)]
                if let Ok(desc) = serde_json::from_str::<InstanceDescriptor>(&content) {
                    {
                        use windows_sys::Win32::System::Threading::OpenProcess;
                        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
                        let handle =
                            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, desc.pid) };
                        if handle.is_null() {
                            let _ = fs::remove_file(&path);
                            return;
                        } else {
                            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                        }
                    }
                }
                #[cfg(not(windows))]
                let _ = content;
            }
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
pub fn start_server(app: AppHandle) -> Result<(), String> {
    if is_running() {
        return Ok(());
    }

    cleanup_stale_descriptor();

    let pid = std::process::id();
    let token = generate_random_token()?;
    let pipe_name = format!(r"\\.\pipe\anbo-browser-{pid}-{token}");

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let desc = InstanceDescriptor {
        version: PROTOCOL_VERSION,
        pid,
        pipe: pipe_name.clone(),
        token: token.clone(),
        started_at,
    };

    let desc_path = descriptor_path()?;
    let tmp_path = desc_path.with_extension(format!("tmp.{}", pid));
    let desc_json = serde_json::to_string_pretty(&desc).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, desc_json).map_err(|e| format!("failed to write tmp descriptor: {e}"))?;
    fs::rename(&tmp_path, &desc_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("failed to move descriptor atomically: {e}")
    })?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut guard) = SERVER_CANCEL_TX.lock() {
        *guard = Some(cancel_tx);
    }

    SERVER_RUNNING.store(true, Ordering::SeqCst);
    let expected_token = token;

    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;

            let mut first = true;
            loop {
                let server_res = if first {
                    first = false;
                    ServerOptions::new()
                        .first_pipe_instance(true)
                        .create(&pipe_name)
                } else {
                    ServerOptions::new().create(&pipe_name)
                };

                let server = match server_res {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("[browser_automation] failed to create named pipe server: {e}");
                        break;
                    }
                };

                tokio::select! {
                    _ = &mut cancel_rx => {
                        log::info!("[browser_automation] server received stop signal");
                        break;
                    }
                    connect_res = server.connect() => {
                        if connect_res.is_ok() {
                            let app_clone = app.clone();
                            let token_clone = expected_token.clone();
                            tokio::spawn(async move {
                                handle_client(server, app_clone, token_clone).await;
                            });
                        }
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            let _ = cancel_rx.await;
        }

        SERVER_RUNNING.store(false, Ordering::SeqCst);
        remove_descriptor();
    });

    Ok(())
}

#[cfg(not(windows))]
pub fn start_server(_app: AppHandle) -> Result<(), String> {
    Err("browser automation is only available on Windows".to_string())
}

pub fn stop_server() {
    if let Ok(mut guard) = SERVER_CANCEL_TX.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    remove_descriptor();
}

#[cfg(windows)]
async fn handle_client(
    stream: tokio::net::windows::named_pipe::NamedPipeServer,
    app: AppHandle,
    expected_token: String,
) {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    while let Ok(n) = buf_reader.read_line(&mut line).await {
        if n == 0 {
            break;
        }

        if line.len() > MAX_REQUEST_SIZE {
            let resp = BrowserResponse::err(
                "unknown",
                error_codes::RESPONSE_TOO_LARGE,
                "request size exceeds 1 MiB limit",
            );
            let _ = send_response(&mut writer, &resp).await;
            line.clear();
            continue;
        }

        let parsed: Result<BrowserRequest, _> = serde_json::from_str(&line);
        line.clear();

        let req = match parsed {
            Ok(r) => r,
            Err(e) => {
                let resp = BrowserResponse::err(
                    "unknown",
                    error_codes::INVALID_REQUEST,
                    format!("invalid JSON request: {e}"),
                );
                let _ = send_response(&mut writer, &resp).await;
                continue;
            }
        };

        if req.version != PROTOCOL_VERSION {
            let resp = BrowserResponse::err(
                req.id,
                error_codes::INVALID_REQUEST,
                format!("unsupported protocol version: {}", req.version),
            );
            let _ = send_response(&mut writer, &resp).await;
            continue;
        }

        if !constant_time_compare(&req.token, &expected_token) {
            let resp = BrowserResponse::err(
                req.id,
                error_codes::UNAUTHORIZED,
                "invalid authentication token",
            );
            let _ = send_response(&mut writer, &resp).await;
            continue;
        }

        match handle_action(&app, &req.method, req.params).await {
            Ok(result) => {
                let resp = BrowserResponse::success(req.id, result);
                let _ = send_response(&mut writer, &resp).await;
            }
            Err((code, message)) => {
                let resp = BrowserResponse::err(req.id, code, message);
                let _ = send_response(&mut writer, &resp).await;
            }
        }
    }
}

#[cfg(windows)]
async fn send_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    resp: &BrowserResponse,
) -> Result<(), std::io::Error> {
    let json = serde_json::to_string(resp)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(any(windows, test))]
fn constant_time_compare(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(any(windows, test))]
fn generate_random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("failed to generate auth token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_time_compare() {
        assert!(constant_time_compare("token123", "token123"));
        assert!(!constant_time_compare("token123", "token124"));
        assert!(!constant_time_compare("token123", "token12"));
    }

    #[test]
    fn random_token_has_256_bits_of_encoded_data() {
        let token = generate_random_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}

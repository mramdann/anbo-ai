#[path = "../modules/browser_external/wire.rs"]
mod wire;

#[cfg(windows)]
#[path = "../modules/browser_external/dock_window.rs"]
mod dock_window;

#[cfg(windows)]
#[allow(dead_code)]
#[path = "../modules/browser_external/browser_process.rs"]
mod browser_process;

#[cfg(windows)]
#[path = "../modules/browser_external/extension_priority.rs"]
mod extension_priority;

#[cfg(windows)]
#[derive(Default)]
struct DockGuards(Vec<dock_window::Lease>);

#[cfg(windows)]
impl Drop for DockGuards {
    fn drop(&mut self) {
        for lease in &self.0 {
            lease.restore();
        }
    }
}

use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostConfig {
    descriptor_path: std::path::PathBuf,
    allowed_origins: Vec<String>,
}

fn valid_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
}

pub async fn run(origin: &str) {
    if let Err(error) = connect(origin).await {
        let bytes =
            serde_json::to_vec(&json!({"type":"error", "message":error})).unwrap_or_default();
        let _ = wire::write_frame(&mut tokio::io::stdout(), &bytes, wire::TO_BROWSER_LIMIT).await;
    }
}

#[cfg(windows)]
async fn connect(origin: &str) -> Result<(), String> {
    if !valid_origin(origin) {
        return Err("invalid extension origin".into());
    }
    // Started first, while the popup that asked for this connection is open.
    let _priority = extension_priority::keep();
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let config_path = executable.with_file_name("anbo-browser-native-host.json");
    let read_bounded = |path: &std::path::Path| -> Result<String, String> {
        if std::fs::metadata(path)
            .map_err(|error| error.to_string())?
            .len()
            > 16 * 1024
        {
            return Err("native host configuration is too large".into());
        }
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    };
    let config: HostConfig =
        serde_json::from_str(&read_bounded(&config_path)?).map_err(|error| error.to_string())?;
    if !config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
        || !config.descriptor_path.is_absolute()
    {
        return Err("extension is not authorized for this Anbo instance".into());
    }
    let descriptor: super::InstanceDescriptor =
        serde_json::from_str(&read_bounded(&config.descriptor_path)?)
            .map_err(|error| error.to_string())?;
    if descriptor.version != 1
        || !descriptor.pipe.starts_with(r"\\.\pipe\anbo-browser-")
        || descriptor.token.len() != 64
        || !descriptor
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid Anbo instance descriptor".into());
    }
    let mut input = tokio::io::stdin();
    let hello = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        wire::read_frame(&mut input, 8192),
    )
    .await
    .map_err(|_| "browser handshake timed out")??
    .ok_or("missing browser handshake")?;
    let profile: serde_json::Value =
        serde_json::from_slice(&hello).map_err(|error| error.to_string())?;
    let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&descriptor.pipe)
        .map_err(|error| error.to_string())?;
    let handshake = super::BrowserRequest {
        version: 1,
        id: "external-browser".into(),
        token: descriptor.token,
        method: "external_browser_connect".into(),
        params: profile,
        client_info: None,
    };
    let mut encoded = serde_json::to_vec(&handshake).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    pipe.write_all(&encoded)
        .await
        .map_err(|error| error.to_string())?;
    pipe.flush().await.map_err(|error| error.to_string())?;
    let (mut reader, writer) = tokio::io::split(pipe);
    let writer = tokio::sync::Mutex::new(writer);
    let mut guards = DockGuards::default();
    let mut output = tokio::io::stdout();
    let incoming = async {
        while let Some(bytes) = wire::read_frame(&mut input, wire::FROM_BROWSER_LIMIT).await? {
            wire::write_frame(&mut *writer.lock().await, &bytes, wire::FROM_BROWSER_LIMIT).await?;
        }
        Err::<(), String>("browser disconnected".into())
    };
    let outgoing = async {
        while let Some(bytes) = wire::read_frame(&mut reader, wire::TO_BROWSER_LIMIT).await? {
            let command: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if command["type"] == "command" && command["method"] == "anbo.guardDock" {
                let guarded = (|| -> Result<(), String> {
                    let lease: dock_window::Lease =
                        serde_json::from_value(command["params"]["window"].clone())
                            .map_err(|error| error.to_string())?;
                    guards.0.retain(|previous| previous.live());
                    if command["params"]["action"] == "arm" {
                        if guards.0.len() >= 4 {
                            return Err("Native dock recovery limit reached".into());
                        }
                        if dock_window::window_bounds(lease.hwnd())? != lease.original {
                            return Err("Dock window moved before recovery was armed".into());
                        }
                        lease.arm()?;
                        guards.0.push(lease);
                    } else if command["params"]["action"] == "restore" {
                        if let Some(index) = guards.0.iter().position(|previous| {
                            previous.token == lease.token && previous.handle == lease.handle
                        }) {
                            guards.0.remove(index).restore();
                        }
                    } else {
                        return Err("Unknown native dock recovery action".into());
                    }
                    Ok(())
                })();
                let reply = match guarded {
                    Ok(()) => json!({"type":"reply","id":command["id"],"result":{}}),
                    Err(error) => json!({"type":"reply","id":command["id"],"error":error}),
                };
                wire::write_frame(
                    &mut *writer.lock().await,
                    &serde_json::to_vec(&reply).map_err(|error| error.to_string())?,
                    wire::FROM_BROWSER_LIMIT,
                )
                .await?;
                continue;
            }
            wire::write_frame(&mut output, &bytes, wire::TO_BROWSER_LIMIT).await?;
        }
        Err::<(), String>("Anbo disconnected".into())
    };
    tokio::try_join!(incoming, outgoing).map(|_| ())
}

#[cfg(not(windows))]
async fn connect(_origin: &str) -> Result<(), String> {
    Err("external browser preview currently requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::valid_origin;

    #[test]
    fn origin_requires_an_exact_extension_id_not_a_web_origin() {
        assert!(valid_origin(&format!(
            "chrome-extension://{}/",
            "a".repeat(32)
        )));
        for origin in [
            "https://example.com/",
            "chrome-extension://short/",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra",
        ] {
            assert!(!valid_origin(origin));
        }
    }
}

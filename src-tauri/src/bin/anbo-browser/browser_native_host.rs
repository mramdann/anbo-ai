#[path = "../../modules/browser_external/wire.rs"]
mod wire;

#[cfg(windows)]
#[path = "../../modules/browser_external/dock_window.rs"]
mod dock_window;

#[cfg(windows)]
#[allow(dead_code)]
#[path = "../../modules/browser_external/browser_process.rs"]
mod browser_process;

#[cfg(windows)]
#[path = "../../modules/browser_external/extension_priority.rs"]
mod extension_priority;

#[cfg(windows)]
#[path = "../../modules/browser_external/host_log.rs"]
mod host_log;

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

/// Frames for the host itself are small; larger ones go to Anbo unread.
const HOST_FRAME_LIMIT: usize = 16 * 1024;

/// What the extension asked of the host itself, which Anbo never sees: its
/// bridge closes on a message it does not know.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum HostFrame {
    /// The renderers of the tabs Anbo drives, to keep scheduled.
    KeepRenderers(Vec<u32>),
    /// When the extension's worker started, in ms since 1970, and whether
    /// the extension shows its process when the host asks (0.5.19 on).
    Worker { started: u64, marks: bool },
    /// The extension holds the memory the host asked it for in this round,
    /// so that its process shows (extension_priority.rs `Ask`).
    Marked(u32),
    /// A word this host does not know, which goes nowhere.
    Unknown,
}

/// A question of the host's own for the extension, as the frame it goes out
/// in. The extension answers with a `host` frame too (`marked`); one older
/// than 0.5.19 does not know the type and says nothing.
#[cfg_attr(not(windows), allow(dead_code))]
fn ask_frame(method: &str, round: u32, megabytes: Option<u32>) -> Vec<u8> {
    let mut params = json!({ "round": round });
    if let Some(megabytes) = megabytes {
        params["megabytes"] = json!(megabytes);
    }
    serde_json::to_vec(&json!({ "type": "host", "method": method, "params": params }))
        .unwrap_or_default()
}

/// A frame the extension sent the host itself, or None for one on its way to
/// Anbo. Most frames carry page data, so only a small one that says it is for
/// the host is read.
#[cfg_attr(not(windows), allow(dead_code))]
fn host_frame(bytes: &[u8]) -> Option<HostFrame> {
    const MARK: &[u8] = br#""type":"host""#;
    if bytes.len() > HOST_FRAME_LIMIT || !bytes.windows(MARK.len()).any(|window| window == MARK) {
        return None;
    }
    let frame: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if frame["type"] != "host" {
        return None;
    }
    if frame["method"] == "worker" {
        let marks = frame["params"]["marks"] == true;
        return Some(
            frame["params"]["started"]
                .as_u64()
                .filter(|started| *started > 0)
                .map_or(HostFrame::Unknown, |started| HostFrame::Worker {
                    started,
                    marks,
                }),
        );
    }
    if frame["method"] == "marked" {
        return Some(
            frame["params"]["round"]
                .as_u64()
                .and_then(|round| u32::try_from(round).ok())
                .filter(|round| *round > 0)
                .map_or(HostFrame::Unknown, HostFrame::Marked),
        );
    }
    if frame["method"] != "keepRenderers" {
        return Some(HostFrame::Unknown);
    }
    let ids = frame["params"]["ids"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_u64)
                .filter_map(|id| u32::try_from(id).ok())
                .filter(|id| *id > 0)
                .collect()
        })
        .unwrap_or_default();
    Some(HostFrame::KeepRenderers(ids))
}

fn valid_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
}

pub async fn run(origin: &str) {
    if let Err(error) = connect(origin).await {
        #[cfg(windows)]
        host_log::line(&format!("ended: {error}"));
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
    // What the keeper asks the extension itself goes out with the frames from
    // Anbo, once the connection stands.
    let (asks, mut asked) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    // Started first, while the popup that asked for this connection is open.
    let priority = extension_priority::keep(move |ask| {
        let frame = match ask {
            extension_priority::Ask::Mark { round, megabytes } => {
                ask_frame("mark", round, Some(megabytes))
            }
            extension_priority::Ask::Unmark { round } => ask_frame("unmark", round, None),
        };
        let _ = asks.send(frame);
    });
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
    if let Some(id) = profile["profileId"].as_str() {
        priority.profile(id);
    }
    let mut pipe = super::open_instance_pipe(&descriptor)?;
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
    let output = tokio::sync::Mutex::new(tokio::io::stdout());
    let incoming = async {
        while let Some(bytes) = wire::read_frame(&mut input, wire::FROM_BROWSER_LIMIT).await? {
            match host_frame(&bytes) {
                Some(HostFrame::KeepRenderers(ids)) => priority.renderers(ids),
                Some(HostFrame::Worker { started, marks }) => {
                    priority.worker_started(started, marks);
                }
                Some(HostFrame::Marked(round)) => priority.marked(round),
                Some(HostFrame::Unknown) => {}
                None => {
                    wire::write_frame(&mut *writer.lock().await, &bytes, wire::FROM_BROWSER_LIMIT)
                        .await?
                }
            }
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
            wire::write_frame(&mut *output.lock().await, &bytes, wire::TO_BROWSER_LIMIT).await?;
        }
        Err::<(), String>("Anbo disconnected".into())
    };
    let asking = async {
        while let Some(bytes) = asked.recv().await {
            wire::write_frame(&mut *output.lock().await, &bytes, wire::TO_BROWSER_LIMIT).await?;
        }
        Ok::<(), String>(())
    };
    tokio::try_join!(incoming, outgoing, asking).map(|_| ())
}

#[cfg(not(windows))]
async fn connect(_origin: &str) -> Result<(), String> {
    Err("external browser preview currently requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{ask_frame, host_frame, valid_origin, HostFrame};

    #[test]
    fn the_host_keeps_its_own_frames_and_passes_every_other_one_on() {
        // As the browser writes it: keys in order, no spaces.
        let keep = br#"{"method":"keepRenderers","params":{"ids":[11,14,0,-3,4294967296,"7"]},"type":"host"}"#;
        assert_eq!(
            host_frame(keep),
            Some(HostFrame::KeepRenderers(vec![11, 14]))
        );
        assert_eq!(
            host_frame(br#"{"method":"keepRenderers","params":{"ids":[]},"type":"host"}"#),
            Some(HostFrame::KeepRenderers(Vec::new()))
        );
        // An extension before 0.5.19 names only its worker's start.
        assert_eq!(
            host_frame(br#"{"method":"worker","params":{"started":1791972000000},"type":"host"}"#),
            Some(HostFrame::Worker {
                started: 1_791_972_000_000,
                marks: false
            })
        );
        assert_eq!(
            host_frame(
                br#"{"method":"worker","params":{"marks":true,"started":1791972000000},"type":"host"}"#
            ),
            Some(HostFrame::Worker {
                started: 1_791_972_000_000,
                marks: true
            })
        );
        for unsure in [
            &br#"{"method":"worker","params":{"marks":"yes","started":7},"type":"host"}"#[..],
            br#"{"method":"worker","params":{"marks":1,"started":7},"type":"host"}"#,
        ] {
            assert_eq!(
                host_frame(unsure),
                Some(HostFrame::Worker {
                    started: 7,
                    marks: false
                })
            );
        }
        for odd in [
            &br#"{"method":"worker","params":{"started":-5},"type":"host"}"#[..],
            br#"{"method":"worker","params":{"started":"soon"},"type":"host"}"#,
            br#"{"method":"worker","params":{},"type":"host"}"#,
        ] {
            assert_eq!(host_frame(odd), Some(HostFrame::Unknown));
        }
        assert_eq!(
            host_frame(br#"{"method":"later","params":{},"type":"host"}"#),
            Some(HostFrame::Unknown)
        );
        for passed in [
            &br#"{"tabs":[],"type":"tabs"}"#[..],
            br#"{"id":4,"result":{"text":""type":"host""},"type":"reply"}"#,
            br#"{"type":"host""#,
        ] {
            assert_eq!(host_frame(passed), None);
        }
        let mut large =
            br#"{"method":"keepRenderers","params":{"ids":[1]},"type":"host","pad":""#.to_vec();
        large.extend(std::iter::repeat_n(b'x', 20 * 1024));
        large.extend(br#""}"#);
        assert_eq!(host_frame(&large), None);
    }

    #[test]
    fn the_host_asks_the_extension_to_show_its_process_and_reads_the_answer() {
        // What the host asks goes out as a frame of its own kind, which an
        // extension before 0.5.19 does not know and leaves alone.
        let asked: serde_json::Value =
            serde_json::from_slice(&ask_frame("mark", 3, Some(32))).unwrap();
        assert_eq!(
            asked,
            serde_json::json!({ "type": "host", "method": "mark", "params": { "round": 3, "megabytes": 32 } })
        );
        let let_go: serde_json::Value =
            serde_json::from_slice(&ask_frame("unmark", 3, None)).unwrap();
        assert_eq!(
            let_go,
            serde_json::json!({ "type": "host", "method": "unmark", "params": { "round": 3 } })
        );
        // The answer stays with the host: Anbo's bridge closes on a message
        // it does not know.
        assert_eq!(
            host_frame(br#"{"method":"marked","params":{"round":3},"type":"host"}"#),
            Some(HostFrame::Marked(3))
        );
        for odd in [
            &br#"{"method":"marked","params":{"round":0},"type":"host"}"#[..],
            br#"{"method":"marked","params":{"round":-1},"type":"host"}"#,
            br#"{"method":"marked","params":{"round":4294967296},"type":"host"}"#,
            br#"{"method":"marked","params":{"round":"3"},"type":"host"}"#,
            br#"{"method":"marked","params":{},"type":"host"}"#,
            br#"{"method":"unmarked","params":{"round":3},"type":"host"}"#,
        ] {
            assert_eq!(host_frame(odd), Some(HostFrame::Unknown));
        }
    }

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

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{ipc::Channel, Manager};

use crate::modules::{
    pty::PtyState,
    workspace::{authorize_existing_path, WorkspaceEnv, WorkspaceRegistry},
};

const TAIL_LIMIT: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    turn_id: String,
    started_at: String,
    finished_at: Option<String>,
}

#[derive(Default)]
struct Reader {
    offset: u64,
    turn: Option<Turn>,
}

impl Reader {
    fn line(&mut self, line: &[u8]) {
        if !line.windows(9).any(|w| w == b"event_msg") {
            return;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            return;
        };
        if value["type"] != "event_msg" {
            return;
        }
        let payload = &value["payload"];
        let (Some(id), Some(at)) = (payload["turn_id"].as_str(), value["timestamp"].as_str())
        else {
            return;
        };
        if id.is_empty() || id.len() > 128 || at.len() > 40 {
            return;
        }
        match payload["type"].as_str() {
            Some("task_started") => {
                self.turn = Some(Turn {
                    turn_id: id.into(),
                    started_at: at.into(),
                    finished_at: None,
                })
            }
            Some("task_complete") if self.turn.as_ref().is_some_and(|turn| turn.turn_id == id) => {
                self.turn.as_mut().unwrap().finished_at = Some(at.into());
            }
            Some("turn_aborted" | "task_aborted") => self.turn = None,
            _ => {}
        }
    }

    fn read(&mut self, path: &Path) -> std::io::Result<()> {
        let mut file = std::fs::File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            self.offset = 0;
            self.turn = None;
        }
        let start = self.offset.max(len.saturating_sub(TAIL_LIMIT));
        let skipped = start > self.offset;
        if skipped {
            self.turn = None;
        }
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.take(TAIL_LIMIT).read_to_end(&mut bytes)?;
        let mut cursor = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            if !(skipped && cursor == 0) {
                self.line(&bytes[cursor..index]);
            }
            cursor = index + 1;
        }
        // A partial final record is read again on the next file event.
        self.offset = start + cursor as u64;
        Ok(())
    }
}

struct Subscription {
    pty_id: u32,
    _watcher: RecommendedWatcher,
}
static WATCHES: LazyLock<Mutex<HashMap<String, Subscription>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn stop_pty(pty_id: u32) {
    WATCHES
        .lock()
        .unwrap()
        .retain(|_, watch| watch.pty_id != pty_id);
}

#[tauri::command]
pub fn anbo_unwatch_codex_turn(key: String) {
    WATCHES.lock().unwrap().remove(&key);
}

#[tauri::command]
pub async fn anbo_watch_codex_turn(
    app: tauri::AppHandle,
    key: String,
    pty_id: u32,
    cwd: String,
    session_id: String,
    on_change: Channel<Option<Turn>>,
) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err("invalid subscription key".into());
    }
    let cwd = authorize_existing_path(
        &app.state::<WorkspaceRegistry>(),
        &cwd,
        &WorkspaceEnv::Local,
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        if !app.state::<PtyState>().is_live(pty_id) {
            return Err("PTY is closed".into());
        }
        let path = super::resume::exact_codex_rollout(&cwd.to_string_lossy(), &session_id)
            .ok_or("exact workspace session not found")?;
        let reader = Arc::new(Mutex::new(Reader::default()));
        let callback_reader = Arc::clone(&reader);
        let callback_path = path.clone();
        let callback_channel = on_change.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.as_ref().is_ok_and(|e| {
                    !matches!(
                        e.kind,
                        notify::EventKind::Modify(_)
                            | notify::EventKind::Create(_)
                            | notify::EventKind::Remove(_)
                    )
                }) {
                    return;
                }
                let mut reader = callback_reader.lock().unwrap();
                let before = reader.turn.clone();
                if event.is_err() || reader.read(&callback_path).is_err() {
                    reader.turn = None;
                }
                if before != reader.turn {
                    let _ = callback_channel.send(reader.turn.clone());
                }
            })
            .map_err(|e| e.to_string())?;
        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        {
            let mut reader = reader.lock().unwrap();
            reader.read(&path).map_err(|e| e.to_string())?;
            on_change
                .send(reader.turn.clone())
                .map_err(|e| e.to_string())?;
        }
        let mut watches = WATCHES.lock().unwrap();
        if watches.len() >= 64
            || watches.contains_key(&key)
            || !app.state::<PtyState>().is_live(pty_id)
        {
            return Err("subscription unavailable".into());
        }
        watches.insert(
            key,
            Subscription {
                pty_id,
                _watcher: watcher,
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: &str, id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"type":"event_msg","timestamp":"2026-09-09T01:00:00Z","payload":{"type":kind,"turn_id":id}})).unwrap()
    }
    #[test]
    fn completion_requires_the_current_started_turn() {
        let mut reader = Reader::default();
        reader.line(&event("task_complete", "old"));
        assert!(reader.turn.is_none());
        reader.line(&event("task_started", "new"));
        reader.line(&event("task_complete", "old"));
        assert!(reader.turn.as_ref().unwrap().finished_at.is_none());
        reader.line(&event("task_complete", "new"));
        assert!(reader.turn.as_ref().unwrap().finished_at.is_some());
        reader.line(&event("task_started", "next"));
        assert!(reader.turn.as_ref().unwrap().finished_at.is_none());
    }
    #[test]
    fn quoted_tool_output_cannot_finish_a_turn() {
        let mut reader = Reader::default();
        reader.line(&event("task_started", "one"));
        reader.line(br#"{"type":"response_item","payload":{"type":"task_complete","turn_id":"one"},"text":"event_msg"}"#);
        assert!(reader.turn.unwrap().finished_at.is_none());
    }
    #[test]
    fn partial_records_and_truncation_fail_closed() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let mut reader = Reader::default();
        file.write_all(&event("task_started", "one")).unwrap();
        reader.read(file.path()).unwrap();
        assert!(reader.turn.is_none());
        file.write_all(b"\n").unwrap();
        reader.read(file.path()).unwrap();
        assert_eq!(reader.turn.as_ref().unwrap().turn_id, "one");
        file.as_file().set_len(0).unwrap();
        reader.read(file.path()).unwrap();
        assert!(reader.turn.is_none());
    }
}

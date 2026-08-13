use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, Response};
use tauri::Manager;

use super::framing::{encode_frame, FrameDecoder};
use crate::modules::proc::ManagedChild;

const READ_BUF: usize = 32 * 1024;
const STDERR_LINE_CAP: usize = 512;
const STDERR_TAIL_LINES: usize = 8;
const MEM_POLL_INTERVAL: Duration = Duration::from_secs(30);
// Workspace loading transiently peaks far above steady state; only police
// steady state.
const MEM_STARTUP_GRACE: Duration = Duration::from_secs(120);
const DEFAULT_MAX_RSS_MB: u64 = 4096;
const WRITER_QUEUE_CAPACITY: usize = 64;
const MAX_OUTBOUND_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExit {
    pub code: Option<i32>,
    pub stderr_tail: String,
    pub reason: Option<String>,
}

pub struct LspSession {
    child: Arc<ManagedChild>,
    writer: Mutex<Option<SyncSender<Vec<u8>>>>,
    pub(super) exited: Arc<AtomicBool>,
}

impl LspSession {
    pub fn write_message(&self, payload: &str) -> Result<(), String> {
        if payload.len() > MAX_OUTBOUND_MESSAGE_BYTES {
            return Err("lsp message exceeds 8 MiB limit".into());
        }
        let writer = self
            .writer
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("lsp session stdin closed")?;
        match writer.try_send(encode_frame(payload)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err("lsp writer queue is full".into()),
            Err(TrySendError::Disconnected(_)) => Err("lsp session stdin closed".into()),
        }
    }

    // Servers fork helpers (cargo check, rustc, proc-macro hosts); killing
    // only the leader leaves them burning CPU. Unix: signal the process
    // group. Windows: the Job Object covers the tree.
    pub fn kill(&self) {
        *self.writer.lock().unwrap() = None;
        self.child.kill_tree();
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        self.kill();
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: tauri::AppHandle,
    binary: &std::path::Path,
    args: &[String],
    extra_env: &std::collections::HashMap<String, String>,
    root: &std::path::Path,
    max_rss_mb: Option<u64>,
    on_message: Channel<Response>,
    on_exit: Channel<LspExit>,
) -> Result<Arc<LspSession>, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(root)
        .envs(super::env::server_env_overlay())
        .envs(extra_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    let child = ManagedChild::spawn(&mut cmd)
        .map_err(|e| format!("lsp spawn failed for {}: {e}", binary.display()))?;
    let kill_on_fail = || {
        child.kill_tree();
    };
    let stdin = child.take_stdin().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stdin pipe".to_string()
    })?;
    let mut stdout = child.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stdout pipe".to_string()
    })?;
    let mut stderr = child.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stderr pipe".to_string()
    })?;

    let (writer_tx, writer_rx) = mpsc::sync_channel::<Vec<u8>>(WRITER_QUEUE_CAPACITY);
    let exited = Arc::new(AtomicBool::new(false));
    let session = Arc::new(LspSession {
        child: child.clone(),
        writer: Mutex::new(Some(writer_tx)),
        exited: exited.clone(),
    });

    let writer_child = child.clone();
    thread::Builder::new()
        .name(format!("anbo-lsp-writer-{id}"))
        .spawn(move || {
            let mut stdin = stdin;
            while let Ok(frame) = writer_rx.recv() {
                if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                    writer_child.kill_tree();
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let session_reader = session.clone();
    let reader_thread = thread::Builder::new()
        .name(format!("anbo-lsp-reader-{id}"))
        .spawn(move || {
            let mut decoder = FrameDecoder::default();
            let mut buf = [0u8; READ_BUF];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => match decoder.push(&buf[..n]) {
                        Ok(messages) => {
                            for msg in messages {
                                if on_message.send(Response::new(msg.into_bytes())).is_err() {
                                    log::info!("lsp id={id}: channel closed; killing server");
                                    session_reader.kill();
                                    return;
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("lsp id={id}: {e}; killing server");
                            session_reader.kill();
                            return;
                        }
                    },
                    Err(e) => {
                        log::debug!("lsp id={id} stdout ended: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let stderr_tail: Arc<Mutex<std::collections::VecDeque<String>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::new()));
    let stderr_tail_w = stderr_tail.clone();
    thread::Builder::new()
        .name(format!("anbo-lsp-stderr-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            let mut line: Vec<u8> = Vec::new();
            let push_line = |line: &mut Vec<u8>| {
                if line.is_empty() {
                    return;
                }
                let text = String::from_utf8_lossy(line).into_owned();
                log::debug!("lsp id={id} stderr: {text}");
                let mut tail = stderr_tail_w.lock().unwrap();
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(text);
                line.clear();
            };
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                for &b in &buf[..n] {
                    if b == b'\n' {
                        push_line(&mut line);
                    } else if line.len() < STDERR_LINE_CAP {
                        line.push(b);
                    }
                }
            }
            push_line(&mut line);
        })
        .map_err(|e| e.to_string())?;

    let kill_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    {
        let cap_mb = max_rss_mb.unwrap_or(DEFAULT_MAX_RSS_MB);
        let pid = child.id();
        let session_w = session.clone();
        let exited_m = exited.clone();
        let reason_w = kill_reason.clone();
        thread::Builder::new()
            .name(format!("anbo-lsp-memwatch-{id}"))
            .spawn(move || {
                let grace_deadline = Instant::now() + MEM_STARTUP_GRACE;
                while Instant::now() < grace_deadline {
                    if exited_m.load(Ordering::Acquire) {
                        return;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
                loop {
                    if exited_m.load(Ordering::Acquire) {
                        return;
                    }
                    if let Some(rss) = super::rss::rss_bytes(pid) {
                        let rss_mb = rss / (1024 * 1024);
                        if rss_mb > cap_mb {
                            log::warn!(
                                "lsp id={id} rss {rss_mb} MB over budget {cap_mb} MB; killing"
                            );
                            *reason_w.lock().unwrap() = Some(format!(
                                "Killed after exceeding the {cap_mb} MB memory budget ({rss_mb} MB resident)."
                            ));
                            session_w.kill();
                            return;
                        }
                    }
                    thread::sleep(MEM_POLL_INTERVAL);
                }
            })
            .map_err(|e| e.to_string())?;
    }

    let child_waiter = child;
    let exited_w = exited;
    thread::Builder::new()
        .name(format!("anbo-lsp-waiter-{id}"))
        .spawn(move || {
            let code = match child_waiter.wait() {
                Ok(status) => status.code(),
                Err(e) => {
                    log::warn!("lsp id={id} wait failed: {e}");
                    None
                }
            };
            exited_w.store(true, Ordering::Release);
            // Bounded, not join: a grandchild inheriting stdout keeps the
            // pipe open past child exit and would hang us.
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline && !reader_thread.is_finished() {
                thread::sleep(Duration::from_millis(10));
            }
            if let Some(state) = app.try_state::<super::LspState>() {
                state.take(id);
            }
            log::info!("lsp id={id} exited code={code:?}");
            let tail: Vec<String> = stderr_tail.lock().unwrap().iter().cloned().collect();
            let exit = LspExit {
                code,
                stderr_tail: tail.join("\n"),
                reason: kill_reason.lock().unwrap().take(),
            };
            if on_exit.send(exit).is_err() {
                log::debug!("lsp id={id} exit send failed (channel closed)");
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(session)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dummy_session(child: Arc<ManagedChild>, writer: Option<SyncSender<Vec<u8>>>) -> LspSession {
        LspSession {
            child,
            writer: Mutex::new(writer),
            exited: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn drop_kills_child() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]).stdin(Stdio::piped());
        let child = ManagedChild::spawn(&mut cmd).expect("spawn");
        let session = dummy_session(child.clone(), None);

        assert!(child.try_wait().expect("try_wait").is_none());
        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child.try_wait().expect("try_wait").is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "child alive 2s after drop");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_takes_down_process_group() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let child = ManagedChild::spawn(&mut cmd).expect("spawn");
        let _stdin = child.take_stdin();
        let mut stdout = child.take_stdout().expect("stdout");

        let mut buf = [0u8; 32];
        let n = stdout.read(&mut buf).expect("read grandchild pid");
        let grandchild: i32 = String::from_utf8_lossy(&buf[..n])
            .trim()
            .parse()
            .expect("pid");

        let session = dummy_session(child.clone(), None);
        session.kill();
        let _ = child.wait();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let alive = unsafe { libc::kill(grandchild, 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "grandchild survived group kill",);
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn write_after_kill_errors() {
        let mut cmd = Command::new("/bin/cat");
        cmd.stdin(Stdio::piped()).stdout(Stdio::null());
        let child = ManagedChild::spawn(&mut cmd).expect("spawn");
        let (writer, _reader) = mpsc::sync_channel(1);
        let session = dummy_session(child, Some(writer));

        session.kill();
        assert!(session.write_message("{}").is_err());
    }

    #[test]
    fn kill_does_not_wait_for_a_blocked_writer() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]).stdin(Stdio::piped());
        let child = ManagedChild::spawn(&mut cmd).expect("spawn");
        let mut stdin = child.take_stdin().expect("stdin");
        let (writer, reader) = mpsc::sync_channel::<Vec<u8>>(1);
        let session = Arc::new(dummy_session(child.clone(), Some(writer)));
        thread::spawn(move || {
            while let Ok(frame) = reader.recv() {
                let _ = stdin.write_all(&frame);
            }
        });
        session
            .write_message(&"x".repeat(1024 * 1024))
            .expect("queue first write");
        thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        session.kill();
        assert!(started.elapsed() < Duration::from_millis(500));
        let _ = child.wait();
    }
}

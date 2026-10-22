mod agent_detect;
mod da_filter;
mod output;
mod session;
pub(crate) mod shell_init;

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, InvokeBody, Response};

use crate::modules::workspace::{user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry};
use session::{OutputStatus, Session};

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyState {
    pub(crate) fn is_live(&self, id: u32) -> bool {
        self.sessions
            .read()
            .unwrap()
            .get(&id)
            .is_some_and(|session| !session.exited.load(Ordering::Acquire))
    }
    #[cfg(windows)]
    pub(crate) fn owner_of_process(&self, pid: u32) -> Option<u32> {
        let sessions = self.sessions.read().ok()?;
        if pid == 0 || sessions.len() > 512 {
            return None;
        }
        let mut owners = sessions.iter().filter_map(|(id, session)| {
            (!session.exited.load(Ordering::Acquire)
                && session._job.as_ref().is_some_and(|job| job.contains(pid)))
            .then_some(*id)
        });
        let owner = owners.next()?;
        // Ambiguous nested ownership is not safe to attribute automatically.
        owners.next().is_none().then_some(owner)
    }

    pub(super) fn take(&self, id: u32) -> Option<Arc<Session>> {
        let session = self.sessions.write().unwrap().remove(&id);
        crate::modules::anbo::codex_turn::stop_pty(id);
        session
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    on_data: Channel<Response>,
) -> Result<u32, String> {
    crate::modules::resource_guard::admit(crate::modules::resource_guard::Workload::Terminal)?;
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    let cwd = user_spawn_cwd_or_home(&registry, cwd.as_deref(), &workspace);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, app, cols, rows, cwd, workspace, blocks, shell, on_data).map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("anbo-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<PtyState>,
    request: tauri::ipc::Request,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let bytes = input_bytes(request.body())?;
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(&bytes)
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

/// The bytes a pty_write carries. One failed custom-protocol request moves the
/// page's IPC to postMessage for good, which sends them as a JSON array; read
/// that too, or every terminal stops taking input.
fn input_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned)
            .ok_or_else(|| "pty_write: expected bytes".to_string()),
        InvokeBody::Json(_) => Err("pty_write: expected bytes".to_string()),
    }
}

/// A new channel for a session's output, from the UI that holds everything
/// before `received`: a channel that lost one message waits for it forever, so
/// the stream goes on through this one from there. False when the session is
/// gone.
#[tauri::command]
pub fn pty_attach(
    state: tauri::State<PtyState>,
    id: u32,
    on_data: Channel<Response>,
    received: u64,
) -> bool {
    let Some(session) = state.sessions.read().unwrap().get(&id).cloned() else {
        log::info!("pty_attach: unknown id={id}");
        return false;
    };
    log::warn!("pty {id}: output stalled in the UI; resending from offset {received}");
    session.output.attach(on_data, received);
    true
}

/// Each session's output progress, for the UI to find a stream that stopped
/// reaching it.
#[tauri::command]
pub fn pty_output_status(state: tauri::State<PtyState>) -> Vec<OutputStatus> {
    state
        .sessions
        .read()
        .unwrap()
        .iter()
        .map(|(id, session)| session.output.status(*id))
        .collect()
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    id: u32,
) -> Result<(), String> {
    crate::modules::browser_automation::activity::end_pty(&app, id);
    let session = state.take(id);
    if let Some(s) = session {
        s.output.close();
        if let Err(e) = s.killer.lock().unwrap().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        thread::Builder::new()
            .name(format!("anbo-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let session = session_for(&state, id, "pty_has_foreground_process")?;
    if session.shell_pid == 0 {
        return Ok(false);
    }
    Ok(!shell_children(&session).is_empty())
}

/// A process the shell runs, as the terminal tools name it to an agent.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct ShellChild {
    pub pid: u32,
    pub name: String,
}

/// The programs a session's shell runs: its own child processes.
#[tauri::command]
pub fn pty_foreground_processes(
    state: tauri::State<PtyState>,
    id: u32,
) -> Result<Vec<ShellChild>, String> {
    let session = session_for(&state, id, "pty_foreground_processes")?;
    if session.shell_pid == 0 {
        return Ok(Vec::new());
    }
    Ok(shell_children(&session))
}

// Foreground-only check for the renderer hibernation path: true while a job
// owns the tty (tcgetpgrp != shell pgid). Stricter and cheaper than
// pty_has_foreground_process, which counts background children too.
#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let session = session_for(&state, id, "pty_has_foreground_job")?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = session.master.lock().unwrap().process_group_leader();
        Ok(matches!(leader, Some(pid) if pid > 0 && pid as u32 != shell_pid))
    }
    #[cfg(windows)]
    {
        Ok(!shell_children(&session).is_empty())
    }
}

fn session_for(state: &PtyState, id: u32, command: &str) -> Result<Arc<Session>, String> {
    state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("{command}: unknown session id={id}");
            "no session".to_string()
        })
}

// pgrep -l -P lists the shell's children as "pid name" lines; it exits 1 when
// there are none.
#[cfg(unix)]
fn shell_children(session: &Session) -> Vec<ShellChild> {
    let Ok(listed) = std::process::Command::new("pgrep")
        .args(["-l", "-P", &session.shell_pid.to_string()])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&listed.stdout)
        .lines()
        .filter_map(|line| {
            let (pid, name) = line.trim().split_once(' ')?;
            Some(ShellChild {
                pid: pid.parse().ok()?,
                name: name.trim().to_string(),
            })
        })
        .collect()
}

#[cfg(windows)]
fn shell_children(session: &Session) -> Vec<ShellChild> {
    own_children(session.shell_pid, process_snapshot(), |pid| {
        session.job_holds(pid)
    })
}

/// The shell's own children among `processes` (pid, parent pid, name). A
/// process keeps naming its parent's PID after that parent exits, and Windows
/// hands the PID out again: an older program whose dead parent had a new
/// shell's PID made that idle shell read busy for good. Every process the shell
/// really starts is in its session's job.
#[cfg(any(windows, test))]
fn own_children(
    shell_pid: u32,
    processes: impl IntoIterator<Item = (u32, u32, String)>,
    in_job: impl Fn(u32) -> bool,
) -> Vec<ShellChild> {
    processes
        .into_iter()
        .filter(|(pid, parent, _)| *parent == shell_pid && *pid != shell_pid && in_job(*pid))
        .map(|(pid, _, name)| ShellChild { pid, name })
        .collect()
}

#[cfg(windows)]
fn process_snapshot() -> Vec<(u32, u32, String)> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut processes = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return processes;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                processes.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..name_len]),
                ));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    processes
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock().unwrap().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        thread::Builder::new()
            .name(format!("anbo-pty-drop-{id}"))
            .spawn(move || session::drop_session(s))
            .expect("spawn pty drop thread");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_children_the_shell_started() {
        // Measured (round 61): an idle new shell read busy for minutes; a
        // process whose dead parent had had the shell's PID matched by PID.
        let processes = vec![
            (40, 7, "node.exe".to_string()),
            (41, 7, "chrome.exe".to_string()),
            (42, 9, "git.exe".to_string()),
            (7, 7, "powershell.exe".to_string()),
        ];
        let in_job = |pid: u32| pid == 40 || pid == 42;
        assert_eq!(
            own_children(7, processes, in_job),
            vec![ShellChild {
                pid: 40,
                name: "node.exe".to_string()
            }]
        );
    }

    #[test]
    fn takes_input_bytes_raw_or_as_the_json_array_post_message_sends() {
        let raw = InvokeBody::Raw(vec![104, 105]);
        assert_eq!(input_bytes(&raw).unwrap().as_ref(), b"hi");
        let json = InvokeBody::Json(serde_json::json!([27, 91, 65]));
        assert_eq!(input_bytes(&json).unwrap().as_ref(), b"\x1b[A");
        for bad in [
            serde_json::json!([256]),
            serde_json::json!(["a"]),
            serde_json::json!({ "bytes": [1] }),
        ] {
            assert!(input_bytes(&InvokeBody::Json(bad)).is_err());
        }
    }
}

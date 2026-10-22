use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_detect::AgentDetector;
use super::da_filter::DaFilter;
use super::output::{self, OutputLog, MAX_UNSENT};
use super::shell_init;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "anbo:agent-signal";

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. MAX_IDLE is only a safety net: output is pushed and
// signalled under the lock, so it never waits for it. At 50 ms every idle
// terminal woke its flusher twenty times a second.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
// While output keeps coming, at most one message per frame: each one is a post
// to the UI thread, and a full queue there (10000 posts) fails the send.
const MIN_SEND_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_MAX_IDLE: Duration = Duration::from_secs(1);
const READ_BUF: usize = 16 * 1024;
// How long an exited shell waits for the UI to take its last output and exit
// code, through a new channel when the current one failed.
const EXIT_DELIVERY_GRACE: Duration = Duration::from_secs(60);

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    pub(super) _job: Option<crate::modules::proc::job::ProcessJob>,
    /// PID of the shell process. 0 means unknown; callers must skip checks when 0.
    pub shell_pid: u32,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    // Set by the waiter once the child exits, so pty_open can reap a shell
    // that died before it was registered.
    pub(super) exited: Arc<AtomicBool>,
    pub(super) output: Arc<Output>,
}

#[cfg(windows)]
impl Session {
    /// Whether `pid` is in this session's job; without one, any process naming
    /// the shell as its parent counts.
    pub(super) fn job_holds(&self, pid: u32) -> bool {
        self._job.as_ref().is_none_or(|job| job.contains(pid))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
        self.output.close();
    }
}

/// The session's output stream to the UI and the channel it currently goes
/// through. A failed send leaves that channel waiting forever for the message,
/// so the stream holds still until the UI attaches a new channel.
pub(super) struct Output {
    state: Mutex<OutputState>,
    wake: Condvar,
}

struct OutputState {
    log: OutputLog,
    channel: Channel<Response>,
    epoch: u64,
    broken: bool,
    exit: Option<i32>,
    exit_delivered: bool,
    closed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    pub id: u32,
    /// The current channel was handed everything before this stream offset.
    pub sent: u64,
    /// Stream offset after the newest output.
    pub end: u64,
    /// A send failed; nothing more goes out until a new channel is attached.
    pub broken: bool,
    /// The shell exited and the UI has not been handed its exit code yet.
    pub exit_pending: bool,
}

impl Output {
    pub(super) fn new(channel: Channel<Response>) -> Self {
        Self {
            state: Mutex::new(OutputState {
                log: OutputLog::default(),
                channel,
                epoch: 0,
                broken: false,
                exit: None,
                exit_delivered: false,
                closed: false,
            }),
            wake: Condvar::new(),
        }
    }

    fn push(&self, bytes: &[u8]) {
        let mut state = self.state.lock().unwrap();
        state.log.push(bytes, Instant::now());
        self.wake.notify_all();
    }

    fn finish(&self, code: i32) {
        let mut state = self.state.lock().unwrap();
        state.exit = Some(code);
        self.wake.notify_all();
    }

    fn wait_delivered(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        let mut state = self.state.lock().unwrap();
        while !state.exit_delivered && !state.closed {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return;
            };
            state = self.wake.wait_timeout(state, left).unwrap().0;
        }
    }

    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.wake.notify_all();
    }

    /// The UI's new channel for this stream, which has everything before
    /// `received`; what came after goes out again on it.
    pub(super) fn attach(&self, channel: Channel<Response>, received: u64) {
        let mut state = self.state.lock().unwrap();
        state.channel = channel;
        state.epoch += 1;
        state.broken = false;
        state.log.resend_from(received);
        self.wake.notify_all();
    }

    pub(super) fn status(&self, id: u32) -> OutputStatus {
        let state = self.state.lock().unwrap();
        OutputStatus {
            id,
            sent: state.log.sent(),
            end: state.log.end(),
            broken: state.broken,
            exit_pending: state.exit.is_some() && !state.exit_delivered,
        }
    }
}

enum Next {
    Data { upto: u64 },
    Exit,
}

fn flush_output(id: u32, output: &Output) {
    let mut last_send: Option<Instant> = None;
    loop {
        {
            let mut state = output.state.lock().unwrap();
            loop {
                if state.closed || state.exit_delivered {
                    return;
                }
                let exit_pending = state.exit.is_some();
                if !state.broken && (state.log.has_unsent() || exit_pending) {
                    break;
                }
                state = output.wake.wait_timeout(state, FLUSH_MAX_IDLE).unwrap().0;
                state.log.expire(Instant::now());
            }
        }
        // Coalesce a short window so a burst flushes as one chunk.
        let since = last_send.map_or(MIN_SEND_INTERVAL, |at| at.elapsed());
        thread::sleep(FLUSH_COALESCE.max(MIN_SEND_INTERVAL.saturating_sub(since)));
        let (channel, epoch, message, next) = {
            let mut state = output.state.lock().unwrap();
            if state.closed || state.broken {
                continue;
            }
            if let Some((offset, bytes)) = state.log.unsent() {
                let dropped = state.log.take_dropped();
                if dropped > 0 {
                    log::warn!(
                        "pty {id}: dropped {dropped} bytes of output the UI had not taken (cap {MAX_UNSENT})"
                    );
                }
                let upto = offset + bytes.len() as u64;
                (
                    state.channel.clone(),
                    state.epoch,
                    output::data_message(offset, &bytes),
                    Next::Data { upto },
                )
            } else if let Some(code) = state.exit {
                (
                    state.channel.clone(),
                    state.epoch,
                    output::exit_message(code),
                    Next::Exit,
                )
            } else {
                continue;
            }
        };
        last_send = Some(Instant::now());
        let sent = channel.send(Response::new(message));
        let mut state = output.state.lock().unwrap();
        // A channel attached meanwhile sends again from what the UI has.
        if state.epoch != epoch {
            continue;
        }
        match sent {
            Ok(()) => match next {
                Next::Data { upto } => state.log.mark_sent(upto, Instant::now()),
                Next::Exit => {
                    state.exit_delivered = true;
                    output.wake.notify_all();
                }
            },
            Err(e) => {
                state.broken = true;
                log::warn!(
                    "pty {id}: output send failed ({e}); waiting for the UI to attach a new channel"
                );
            }
        }
    }
}

// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();
    drop(session);
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Some(killer),
        }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    on_data: Channel<Response>,
) -> Result<(Arc<Session>, PtySize), String> {
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd, workspace, blocks, shell)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    guard.disarm();

    let shell_pid = child.process_id().unwrap_or(0);

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match crate::modules::proc::job::ProcessJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let exited = Arc::new(AtomicBool::new(false));
    let output = Arc::new(Output::new(on_data));

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        shell_pid,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
        exited: exited.clone(),
        output: output.clone(),
    });

    let spawn_at = Instant::now();

    let first_byte = Arc::new(AtomicBool::new(false));

    let output_r = output.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let first_byte_r = first_byte;
    let reader_thread = thread::Builder::new()
        .name("anbo-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !first_byte_r.load(Ordering::Relaxed) {
                            first_byte_r.store(true, Ordering::Release);
                            log::debug!(
                                "pty first byte after {}ms",
                                spawn_at.elapsed().as_millis()
                            );
                        }
                        agent_detect.process(&buf[..n], |t| {
                            if matches!(t, super::agent_detect::Transition::Exited) {
                                crate::modules::browser_automation::activity::end_pty(
                                    &app_reader,
                                    id,
                                );
                            }
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if !filtered.is_empty() {
                            output_r.push(&filtered);
                        }
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
        })
        .expect("spawn pty reader thread");

    let output_f = output.clone();
    thread::Builder::new()
        .name("anbo-pty-flusher".into())
        .spawn(move || flush_output(id, &output_f))
        .expect("spawn pty flusher thread");

    let app_waiter = app;
    let exited_w = exited;
    thread::Builder::new()
        .name("anbo-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            exited_w.store(true, Ordering::Release);
            crate::modules::browser_automation::activity::end_pty(&app_waiter, id);
            // Wait for the reader to hit EOF before the exit code joins the
            // stream, so the last line of output never races it.
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(50);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            output.finish(code);
            output.wait_delivered(EXIT_DELIVERY_GRACE);
            if let Some(state) = app_waiter.try_state::<super::PtyState>() {
                if let Some(s) = state.take(id) {
                    drop_session(s);
                }
            }
            output.close();
        })
        .expect("spawn pty waiter thread");

    Ok((session, size))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    fn quiet_output() -> Arc<Output> {
        Arc::new(Output::new(Channel::new(|_| Ok(()))))
    }

    #[test]
    fn drop_kills_child_process() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: child.process_id().unwrap_or(0),
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            exited: Arc::new(AtomicBool::new(false)),
            output: quiet_output(),
        });

        assert!(
            child.try_wait().unwrap().is_none(),
            "child must be alive before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(exited, "child still running 2s after Session drop");
    }

    #[test]
    fn drop_session_succeeds_after_child_already_exited() {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let _ = child.wait();

        let killer = child.clone_killer();
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));

        let session = Arc::new(Session {
            shell_pid: 0,
            killer: Mutex::new(killer),
            writer,
            master: Mutex::new(pair.master),
            exited: Arc::new(AtomicBool::new(false)),
            output: quiet_output(),
        });

        drop_session(session);
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    type Seen = Arc<Mutex<Vec<Vec<u8>>>>;

    // A channel standing in for the UI's: it records each message, and fails
    // the sends listed in `fail` (by order), as a full UI-thread queue does.
    fn recording_channel(fail: &'static [usize]) -> (Channel<Response>, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            if fail.contains(&call) {
                return Err(tauri::Error::FailedToReceiveMessage);
            }
            if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        (channel, seen)
    }

    fn wait_for(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn data_of(message: &[u8]) -> (u64, Vec<u8>) {
        assert_eq!(message[0], 0, "data message");
        let offset = u64::from_le_bytes(message[1..9].try_into().unwrap());
        (offset, message[9..].to_vec())
    }

    #[test]
    fn a_failed_send_holds_the_stream_until_a_new_channel_takes_it_again() {
        // Measured (round 61): with Dev's UI-thread queue full, one failed
        // send ended the flusher; the terminal never showed output again while
        // its shell kept running.
        let (first, first_seen) = recording_channel(&[1]);
        let output = Arc::new(Output::new(first));
        let flusher = output.clone();
        let handle = thread::spawn(move || flush_output(7, &flusher));

        output.push(b"before ");
        wait_for("the first message", || {
            first_seen.lock().unwrap().len() == 1
        });
        output.push(b"lost ");
        wait_for("the failed send", || output.status(7).broken);
        output.push(b"after");
        thread::sleep(Duration::from_millis(60));
        assert_eq!(
            first_seen.lock().unwrap().len(),
            1,
            "nothing goes out on a broken channel"
        );
        let status = output.status(7);
        assert_eq!((status.sent, status.end), (7, 17));

        let (second, second_seen) = recording_channel(&[]);
        output.attach(second, 7);
        wait_for("the resend", || {
            second_seen
                .lock()
                .unwrap()
                .iter()
                .map(|m| data_of(m).1.len())
                .sum::<usize>()
                == 10
        });
        let resent: Vec<(u64, Vec<u8>)> = second_seen
            .lock()
            .unwrap()
            .iter()
            .map(|m| data_of(m))
            .collect();
        assert_eq!(resent[0].0, 7);
        assert_eq!(
            resent
                .into_iter()
                .flat_map(|(_, bytes)| bytes)
                .collect::<Vec<u8>>(),
            b"lost after".to_vec()
        );
        assert!(!output.status(7).broken);

        output.close();
        handle.join().unwrap();
    }

    #[test]
    fn the_exit_code_follows_the_last_output_and_ends_the_stream() {
        let (channel, seen) = recording_channel(&[]);
        let output = Arc::new(Output::new(channel));
        let flusher = output.clone();
        let handle = thread::spawn(move || flush_output(8, &flusher));
        output.push(b"bye\r\n");
        output.finish(3);
        output.wait_delivered(Duration::from_secs(5));
        handle.join().unwrap();
        let messages = seen.lock().unwrap();
        assert_eq!(data_of(messages.first().unwrap()), (0, b"bye\r\n".to_vec()));
        assert_eq!(messages.last().unwrap(), &vec![1, 3, 0, 0, 0]);
        assert!(!output.status(8).exit_pending);
    }

    #[test]
    fn an_exit_whose_send_failed_waits_for_a_new_channel() {
        let (first, _) = recording_channel(&[0]);
        let output = Arc::new(Output::new(first));
        let flusher = output.clone();
        let handle = thread::spawn(move || flush_output(9, &flusher));
        output.finish(0);
        wait_for("the failed exit", || output.status(9).broken);
        assert!(output.status(9).exit_pending);
        let (second, seen) = recording_channel(&[]);
        output.attach(second, 0);
        output.wait_delivered(Duration::from_secs(5));
        handle.join().unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), &[vec![1, 0, 0, 0, 0]]);
    }
}

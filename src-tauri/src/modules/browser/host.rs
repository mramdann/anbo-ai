//! The WebView2 process that hosts every browser tab is not ours to reap.
//! Nothing ties it to anbo.exe, so force quitting Anbo leaves it running with
//! its renderer, GPU and utility children, all still holding composited
//! surfaces. Days of force quits pile those up until the desktop compositor
//! itself is the bottleneck and the whole machine crawls.
//!
//! Both halves of the guard live here: the running host joins a job object that
//! dies with us, and a host recorded by an older build gets reaped at startup.
//!
//! The host's own children need a hand as well, once they are told to go. A
//! tab's renderer keeps one worker thread at background priority (4). When
//! the tab closes the host ends the renderer, and every thread of a process
//! that was ended has to run once more to leave. While every core is taken by
//! work at normal priority (8) that one thread gets no turn, and the process
//! stays, with about 20 MB of commit and its handles, until Windows' own
//! starvation boost reaches it seconds later, one process at a time. Sixty
//! tabs closed back to back on a busy machine left 43 such processes; in the
//! 0.39.1 release test 124 of them took the machine's commit down to where
//! the resource guard refused every new tab (round 98, R98-1). So after a tab
//! closes or moves to another page, the host's children are watched for a
//! while. Where a core is free an ended one is gone within tens of
//! milliseconds (705 of 711 in under 200 ms, the slowest in 424 ms). One that
//! is still there half a second after it was first seen ended gets its
//! priority class raised: on the busy machine every such process was then
//! gone 0.5 to 1.1 s after it was ended, where the ones left alone took 20 s
//! and longer (round 99).

#![cfg(windows)]

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;
use windows_sys::Win32::Foundation::{CloseHandle, FALSE, FILETIME, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetPriorityClass, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    SetPriorityClass, WaitForSingleObject, HIGH_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE, SYNCHRONIZATION_SYNCHRONIZE,
};

use crate::modules::proc::job::ProcessJob;

const HOST_PID_FILE: &str = "browser-host.pid";
const HOST_IMAGE: &str = "msedgewebview2.exe";
/// GetExitCodeProcess's answer for a process that still runs.
const STILL_ACTIVE: u32 = 259;
/// How long after a tab's page ended its process is looked for: the host ends
/// the process itself, on a busy machine seconds after the tab went.
const LEAVING_WATCH: Duration = Duration::from_secs(10);
/// How often meanwhile.
const LEAVING_STEP: Duration = Duration::from_millis(500);
/// How long after a look first found a process ended it counts as stuck: just
/// under a step, so the next look decides, half a second on. A process that
/// leaves by itself is long gone by then (see the top of this file).
const LEAVING_GRACE: Duration = Duration::from_millis(400);
/// How often at most the log says how many processes were helped out.
const LEAVING_LOG_EVERY: Duration = Duration::from_secs(30);

/// A process handle that closes itself.
struct Process(HANDLE);

impl Process {
    fn open(pid: u32, access: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(access, FALSE, pid) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn image(&self) -> Option<String> {
        let mut buffer = [0_u16; 512];
        let mut length = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut length) };
        (ok != 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    /// When the process started, in 100 ns ticks. Together with the pid it
    /// names one process; the pid alone does not, because Windows reuses pids.
    fn created(&self) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let ok =
            unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) };
        (ok != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    /// The exit code of a process that was ended, whether or not it is gone
    /// yet; `None` while it runs.
    fn exit_code(&self) -> Option<u32> {
        let mut code = 0_u32;
        let read = unsafe { GetExitCodeProcess(self.0, &mut code) } != 0;
        (read && code != STILL_ACTIVE).then_some(code)
    }

    /// Whether the process is gone for good, its last thread too.
    fn gone(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
    }

    /// Raises the priority class to high, once. Whether this call did.
    fn raise(&self) -> bool {
        unsafe {
            GetPriorityClass(self.0) != HIGH_PRIORITY_CLASS
                && SetPriorityClass(self.0, HIGH_PRIORITY_CLASS) != 0
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

// A process handle belongs to the process, not to the thread that opened it.
unsafe impl Send for Process {}

/// The host a run leaves in `browser-host.pid`: its pid and the moment it
/// started. Builds before this one wrote the pid alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HostRecord {
    pid: u32,
    created: Option<u64>,
}

impl HostRecord {
    fn parse(text: &str) -> Option<Self> {
        let mut fields = text.split_whitespace();
        let pid = fields.next()?.parse().ok()?;
        let created = match fields.next() {
            None => None,
            Some(field) => Some(field.parse().ok()?),
        };
        if fields.next().is_some() {
            return None;
        }
        Some(Self { pid, created })
    }
}

impl fmt::Display for HostRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.created {
            Some(created) => write!(f, "{} {created}", self.pid),
            None => write!(f, "{}", self.pid),
        }
    }
}

/// What became of a recorded host at startup.
#[derive(Debug, PartialEq, Eq)]
enum Reap {
    /// No record, or one that does not parse.
    Nothing,
    /// Nothing runs at that pid any more.
    Gone,
    /// The pid belongs to something other than a WebView2 host.
    NotAHost,
    /// A WebView2 process holds the pid but started at another moment: the pid
    /// was reused, possibly by this run's own webview.
    Reused,
    /// An older build's record carries no start time to tell the two apart.
    Legacy,
    Reaped,
    Failed(String),
}

/// Only the recorded process itself may be killed: a WebView2 host that
/// started at the recorded moment. The pid alone was not enough. This run's
/// own main webview is also msedgewebview2.exe and is already starting when
/// setup runs, and once it got the recorded pid the reaper killed it, leaving
/// a blank window with no webview and no MCP until Anbo was killed.
fn reap_decision(record: &HostRecord, image: Option<&str>, created: Option<u64>) -> Reap {
    let Some(image) = image else {
        return Reap::Gone;
    };
    if !image.to_ascii_lowercase().ends_with(HOST_IMAGE) {
        return Reap::NotAHost;
    }
    match record.created {
        None => Reap::Legacy,
        Some(recorded) if Some(recorded) == created => Reap::Reaped,
        Some(_) => Reap::Reused,
    }
}

/// Read and remove the record at `path`, and kill the recorded host's tree
/// only if it is still the process that was recorded.
fn reap_record(path: &Path) -> (Option<HostRecord>, Reap) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, Reap::Nothing);
    };
    let _ = fs::remove_file(path);
    let Some(record) = HostRecord::parse(&text) else {
        return (None, Reap::Nothing);
    };
    // One handle for the checks and the kill, so the process checked is the
    // process killed even if the pid changes hands in between.
    let process = Process::open(
        record.pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SET_QUOTA,
    )
    .or_else(|| Process::open(record.pid, PROCESS_QUERY_LIMITED_INFORMATION));
    let Some(process) = process else {
        return (Some(record), Reap::Gone);
    };
    let decision = reap_decision(&record, process.image().as_deref(), process.created());
    if decision != Reap::Reaped {
        return (Some(record), decision);
    }
    let outcome = match unsafe { ProcessJob::create_for_process(process.0) } {
        Ok(job) => match job.terminate() {
            Ok(()) => Reap::Reaped,
            Err(error) => Reap::Failed(format!("could not terminate it: {error}")),
        },
        Err(error) => Reap::Failed(format!("could not claim it: {error}")),
    };
    (Some(record), outcome)
}

// WebView2 shuts its host down once the last tab goes away and starts a fresh
// one for the next tab, so a single adopt-once slot would only ever protect the
// first generation. Scraping, which closes every tab and opens more, is exactly
// the workload that produces new generations.
static HOST_JOBS: OnceLock<Mutex<Vec<Adopted>>> = OnceLock::new();

/// A host this run adopted, and the job that ends it with Anbo. Every
/// process the host starts from then on is in that job too.
struct Adopted {
    pid: u32,
    job: ProcessJob,
}

fn host_jobs() -> &'static Mutex<Vec<Adopted>> {
    HOST_JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn pid_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(HOST_PID_FILE))
        .map_err(|error| error.to_string())
}

/// Whether a live pid currently belongs to a WebView2 host. Good enough for
/// releasing jobs whose host is gone; never enough to kill one.
fn is_webview_host(pid: u32) -> bool {
    Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
        .and_then(|process| process.image())
        .map(|path| path.to_ascii_lowercase().ends_with(HOST_IMAGE))
        .unwrap_or(false)
}

/// Kill the browser host a previous run left behind. Windows reuses pids, and
/// terminating a stranger, or this run's own webview, would be far worse than
/// leaving one orphan behind, so a record is acted on only while the pid still
/// names the very process that was recorded.
pub fn reap_orphaned_host(app: &tauri::AppHandle) {
    let Ok(path) = pid_path(app) else {
        return;
    };
    match reap_record(&path) {
        (Some(record), Reap::Reaped) => {
            log::info!("reaped orphaned browser host tree pid={}", record.pid)
        }
        (Some(record), Reap::Reused) => log::info!(
            "left pid {} alone: a newer WebView2 process holds the recorded browser host's pid",
            record.pid
        ),
        (Some(record), Reap::Legacy) => log::info!(
            "left pid {} alone: the browser host record from an older build has no start time",
            record.pid
        ),
        (Some(record), Reap::Failed(error)) => {
            log::warn!("orphaned browser host {}: {error}", record.pid)
        }
        _ => {}
    }
}

/// Put the live browser host in a job that dies with this process. One call is
/// enough: every tab shares a data directory and therefore a single host.
pub fn adopt_host(app: &tauri::AppHandle, pid: u32) {
    let Ok(mut jobs) = host_jobs().lock() else {
        return;
    };
    // Dropping a job terminates its tree, so only release the ones whose host is
    // already gone. That is also what clears the handles a long session leaks.
    jobs.retain(|adopted| is_webview_host(adopted.pid));
    if jobs.iter().any(|adopted| adopted.pid == pid) {
        return;
    }
    match ProcessJob::create_for(pid) {
        Ok(job) => {
            // The start time is what lets the next run tell this host from a
            // newer process that reuses its pid; without it, no record.
            let created = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
                .and_then(|process| process.created());
            jobs.push(Adopted { pid, job });
            match (pid_path(app), created) {
                (Ok(path), Some(created)) => {
                    let record = HostRecord {
                        pid,
                        created: Some(created),
                    };
                    if let Err(error) = fs::write(&path, record.to_string()) {
                        log::warn!("could not record browser host pid: {error}");
                    }
                }
                (Ok(_), None) => log::warn!("could not read browser host {pid} start time"),
                (Err(error), _) => log::warn!("could not resolve browser host pid file: {error}"),
            }
            log::info!("browser host pid={pid} now terminates with Anbo");
        }
        // Worth knowing about but never worth blocking a tab over.
        Err(error) => log::warn!("could not put browser host {pid} in a job: {error}"),
    }
}

/// Read the host pid straight from the freshly created webview and adopt it.
pub fn adopt_from_webview(webview: &tauri::Webview) {
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let mut pid = 0_u32;
        if unsafe { core.BrowserProcessId(&mut pid) }.is_err() || pid == 0 {
            return;
        }
        adopt_host(&app, pid);
    });
}

/// What one look at the hosts' children found.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Leaving {
    /// Processes that were ended and are still there.
    pub seen: usize,
    /// Those first seen ended a moment ago: the next look decides.
    pub fresh: usize,
    /// Those whose priority this look raised.
    pub helped: usize,
}

/// A process of an adopted host's job, held open while pages end.
struct Held {
    pid: u32,
    process: Process,
    /// When a look first found it ended.
    ended: Option<Instant>,
}

/// The hosts' children while pages end. The job a host was put in names
/// them, and nothing else: no pid or name is guessed. A child the host
/// started before it joined the job is not in it (its GPU and service
/// processes, which go with the host, and the renderer of the first tab), so
/// that one renderer gets no help.
#[derive(Default)]
struct LeavingWatch {
    held: Vec<Held>,
}

impl LeavingWatch {
    /// Takes in the processes of `job` that are not held yet, `host` itself
    /// left out.
    fn refresh(&mut self, host: u32, job: &ProcessJob) {
        for pid in job.process_ids() {
            // A pid that is held cannot have changed hands.
            if pid == host || self.held.iter().any(|held| held.pid == pid) {
                continue;
            }
            let Some(process) = Process::open(
                pid,
                PROCESS_QUERY_LIMITED_INFORMATION
                    | PROCESS_SET_INFORMATION
                    | SYNCHRONIZATION_SYNCHRONIZE,
            ) else {
                continue;
            };
            // One that is not: the job listed it a moment before it was opened.
            if unsafe { job.contains_process(process.0) } {
                self.held.push(Held {
                    pid,
                    process,
                    ended: None,
                });
            }
        }
    }

    /// Raises the priority of a child that an earlier look found ended `grace`
    /// ago or longer and that is still there, so its last threads get the
    /// turn they need to leave. A process that runs is never touched: only
    /// one with an exit code is, and all that is left of it is its way out.
    /// The children that are gone are handed back, for `close_elsewhere`.
    fn look(&mut self, now: Instant, grace: Duration) -> (Leaving, Vec<Held>) {
        let mut found = Leaving::default();
        let mut gone = Vec::new();
        let mut index = 0;
        while index < self.held.len() {
            if self.held[index].process.gone() {
                gone.push(self.held.swap_remove(index));
                continue;
            }
            let child = &mut self.held[index];
            index += 1;
            if child.process.exit_code().is_none() {
                continue;
            }
            found.seen += 1;
            let ended = *child.ended.get_or_insert(now);
            if now.saturating_duration_since(ended) < grace {
                found.fresh += 1;
            } else if child.process.raise() {
                found.helped += 1;
            }
        }
        (found, gone)
    }
}

/// Closes the handles on a thread of their own. The last handle of a process
/// that is gone takes what is left of the process with it, and on a busy
/// machine that close took 5.8 and 6.5 s (twice in 2,400 tabs, round 99): the
/// watch stood still meanwhile, and up to 26 ended processes waited for it.
fn close_elsewhere(handles: Vec<Held>) {
    if handles.is_empty() {
        return;
    }
    // Should no thread start, they close right here instead.
    let _ = std::thread::Builder::new()
        .name("anbo-browser-leaving-close".into())
        .spawn(move || drop(handles));
}

static LEAVING: Mutex<LeavingWatch> = Mutex::new(LeavingWatch { held: Vec::new() });

/// One look at the children of the hosts this run adopted.
fn look_leaving() -> Leaving {
    let (found, gone) = {
        let Ok(mut watch) = LEAVING.lock() else {
            return Leaving::default();
        };
        if let Ok(jobs) = host_jobs().lock() {
            for adopted in jobs.iter() {
                watch.refresh(adopted.pid, &adopted.job);
            }
        }
        watch.look(Instant::now(), LEAVING_GRACE)
    };
    close_elsewhere(gone);
    found
}

/// For a start that found memory short: whether closed pages' processes are
/// still on their way out. The watch is woken to see them out, so what they
/// hold is on its way back.
pub fn help_leaving() -> Leaving {
    note_leaving();
    look_leaving()
}

static LEAVING_NOTES: OnceLock<Option<mpsc::Sender<()>>> = OnceLock::new();

/// A tab's page just ended (the tab closed, was suspended, or moved to
/// another page), so the host is about to end a process: look for it for a
/// while. Costs a channel send; the looking happens on a thread of its own
/// that sleeps whenever no page ended lately.
pub fn note_leaving() {
    let notes = LEAVING_NOTES.get_or_init(|| {
        let (sender, notes) = mpsc::channel();
        std::thread::Builder::new()
            .name("anbo-browser-leaving".into())
            .spawn(move || watch_leaving(notes))
            .map_err(|error| log::warn!("closed browser tabs get no help to exit: {error}"))
            .ok()
            .map(|_| sender)
    });
    if let Some(notes) = notes {
        let _ = notes.send(());
    }
}

fn watch_leaving(notes: mpsc::Receiver<()>) {
    // Asleep until a page ends.
    while notes.recv().is_ok() {
        let mut until = Instant::now() + LEAVING_WATCH;
        let mut helped = 0_usize;
        let mut log_at = Instant::now() + LEAVING_LOG_EVERY;
        loop {
            // A whole step between two looks, however many pages end
            // meanwhile: each of those only keeps the watch up longer.
            let step_ends = Instant::now() + LEAVING_STEP;
            loop {
                let left = step_ends.saturating_duration_since(Instant::now());
                match notes.recv_timeout(left) {
                    Ok(()) => until = Instant::now() + LEAVING_WATCH,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let found = look_leaving();
            helped += found.helped;
            let now = Instant::now();
            // One that was only just seen ended gets its second look, also
            // when no page ended since.
            if found.fresh > 0 {
                until = until.max(now + LEAVING_STEP);
            }
            if helped > 0 && (now >= log_at || now >= until) {
                log::info!(
                    "{helped} process(es) of closed browser pages had no CPU to exit on this busy machine; raised their priority so they could"
                );
                helped = 0;
                log_at = now + LEAVING_LOG_EVERY;
            }
            if now >= until {
                break;
            }
        }
        // Nothing is held while no page ends.
        let held = LEAVING
            .lock()
            .map(|mut watch| std::mem::take(&mut watch.held))
            .unwrap_or_default();
        close_elsewhere(held);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows_sys::Win32::System::Threading::IDLE_PRIORITY_CLASS;

    #[test]
    fn host_record_reads_both_formats_and_rejects_the_rest() {
        assert_eq!(
            HostRecord::parse("268"),
            Some(HostRecord {
                pid: 268,
                created: None
            })
        );
        assert_eq!(
            HostRecord::parse(" 268 133950123456789 \n"),
            Some(HostRecord {
                pid: 268,
                created: Some(133950123456789)
            })
        );
        for text in ["", "abc", "268 x", "268 1 2", "-1"] {
            assert_eq!(HostRecord::parse(text), None, "{text:?}");
        }
        let record = HostRecord {
            pid: 268,
            created: Some(42),
        };
        assert_eq!(HostRecord::parse(&record.to_string()), Some(record));
    }

    #[test]
    fn only_the_recorded_process_itself_is_reaped() {
        let record = HostRecord {
            pid: 268,
            created: Some(42),
        };
        let host = Some(
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\155.0.0.0\msedgewebview2.exe",
        );
        assert_eq!(reap_decision(&record, host, Some(42)), Reap::Reaped);
        // A newer WebView2 on the recorded pid, this run's own among them.
        assert_eq!(reap_decision(&record, host, Some(43)), Reap::Reused);
        assert_eq!(reap_decision(&record, host, None), Reap::Reused);
        let legacy = HostRecord {
            pid: 268,
            created: None,
        };
        assert_eq!(reap_decision(&legacy, host, Some(42)), Reap::Legacy);
        let notepad = Some(r"C:\Windows\System32\notepad.exe");
        assert_eq!(reap_decision(&record, notepad, Some(42)), Reap::NotAHost);
        assert_eq!(reap_decision(&record, None, None), Reap::Gone);
    }

    /// A stand-in browser host: ping.exe copied under the WebView2 host's name.
    struct FakeHost {
        child: Child,
        dir: PathBuf,
    }

    impl FakeHost {
        fn start() -> Self {
            let dir = std::env::temp_dir().join(format!("anbo-host-reap-{}", std::process::id()));
            fs::create_dir_all(&dir).expect("temp dir");
            let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            let image = dir.join(HOST_IMAGE);
            fs::copy(Path::new(&system).join(r"System32\PING.EXE"), &image).expect("copy ping");
            let child = Command::new(&image)
                .args(["-n", "60", "127.0.0.1"])
                .stdout(Stdio::null())
                .spawn()
                .expect("start the stand-in host");
            Self { child, dir }
        }

        fn alive(&mut self) -> bool {
            self.child.try_wait().expect("try_wait").is_none()
        }

        fn created(&self) -> u64 {
            Process::open(self.child.id(), PROCESS_QUERY_LIMITED_INFORMATION)
                .and_then(|process| process.created())
                .expect("start time")
        }
    }

    impl Drop for FakeHost {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn reaping_spares_a_reused_pid_and_kills_the_recorded_host() {
        let mut host = FakeHost::start();
        let pid = host.child.id();
        let created = host.created();
        let path = host.dir.join(HOST_PID_FILE);
        let write = |created: Option<u64>| {
            fs::write(&path, HostRecord { pid, created }.to_string()).expect("write record")
        };

        // The pid now names a process that started at another moment.
        write(Some(created + 1));
        assert_eq!(reap_record(&path).1, Reap::Reused);
        assert!(!path.exists(), "a record is used up either way");
        std::thread::sleep(Duration::from_millis(200));
        assert!(host.alive(), "a reused pid must be left alone");

        // An older build's pid-only record cannot prove which process it meant.
        write(None);
        assert_eq!(reap_record(&path).1, Reap::Legacy);
        assert!(host.alive());

        // The recorded process itself goes.
        write(Some(created));
        assert_eq!(reap_record(&path).1, Reap::Reaped);
        let deadline = Instant::now() + Duration::from_secs(3);
        while host.alive() {
            assert!(
                Instant::now() < deadline,
                "the recorded host survived reaping"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A child of this test at idle priority, as a hidden tab's renderer runs.
    fn idle_ping() -> Child {
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        Command::new(Path::new(&system).join(r"System32\PING.EXE"))
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .creation_flags(IDLE_PRIORITY_CLASS)
            .spawn()
            .expect("start ping")
    }

    fn class_of(child: &Child) -> u32 {
        unsafe { GetPriorityClass(child.as_raw_handle() as HANDLE) }
    }

    #[test]
    fn a_process_that_runs_is_never_raised() {
        let mut child = idle_ping();
        let job = ProcessJob::create_for(child.id()).expect("a job for the child");
        let mut watch = LeavingWatch::default();
        watch.refresh(0, &job);
        assert_eq!(watch.held.len(), 1);
        assert_eq!(watch.held[0].pid, child.id());
        let (found, gone) = watch.look(Instant::now(), Duration::ZERO);
        assert_eq!(found, Leaving::default());
        assert!(gone.is_empty());
        assert_eq!(class_of(&child), IDLE_PRIORITY_CLASS);
        // The host itself is left out, and nothing is taken in twice.
        let mut other = LeavingWatch::default();
        other.refresh(child.id(), &job);
        assert!(other.held.is_empty());
        watch.refresh(0, &job);
        assert_eq!(watch.held.len(), 1);
        // Gone: handed back at the next look, to be closed elsewhere.
        let _ = child.kill();
        let _ = child.wait();
        let (found, gone) = watch.look(Instant::now(), Duration::ZERO);
        assert_eq!(found, Leaving::default());
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].pid, child.id());
        assert!(watch.held.is_empty());
    }

    /// Work at normal priority on every core, for as long as this lives and
    /// `limit` at most.
    struct BusyCores {
        stop: Arc<AtomicBool>,
        threads: Vec<std::thread::JoinHandle<()>>,
    }

    impl BusyCores {
        fn start(limit: Duration) -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let until = Instant::now() + limit;
            let cores = std::thread::available_parallelism().map_or(4, |cores| cores.get());
            let threads = (0..cores)
                .map(|_| {
                    let stop = stop.clone();
                    std::thread::spawn(move || {
                        while !stop.load(Ordering::Relaxed) && Instant::now() < until {
                            std::hint::spin_loop();
                        }
                    })
                })
                .collect();
            Self { stop, threads }
        }
    }

    impl Drop for BusyCores {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            for thread in self.threads.drain(..) {
                let _ = thread.join();
            }
        }
    }

    /// R98-1 itself: a process that was ended stays while its threads get no
    /// CPU, and leaves at once when its priority is raised, the cores still
    /// busy. The first look only notes it; the one a grace later raises it.
    #[test]
    #[ignore = "Keeps every core busy for a moment; run it alone"]
    fn an_ended_child_with_no_cpu_leaves_once_its_priority_is_raised() {
        let grace = Duration::from_millis(100);
        for _ in 0..5 {
            let mut child = idle_ping();
            let job = ProcessJob::create_for(child.id()).expect("a job for the child");
            // Into its wait between two pings.
            std::thread::sleep(Duration::from_millis(300));
            let busy = BusyCores::start(Duration::from_secs(8));
            std::thread::sleep(Duration::from_millis(30));
            child.kill().expect("end the child");
            // Ended, and its job still lists it: found although nobody held
            // it while it ran.
            let mut watch = LeavingWatch::default();
            watch.refresh(0, &job);
            let (first, _) = watch.look(Instant::now(), grace);
            std::thread::sleep(Duration::from_millis(150));
            if first.seen == 0 || child.try_wait().expect("try_wait").is_some() {
                // It got a turn all the same: nothing to show this time.
                drop(busy);
                continue;
            }
            assert_eq!((first.fresh, first.helped), (first.seen, 0), "{first:?}");
            assert_eq!(class_of(&child), IDLE_PRIORITY_CLASS);
            let (second, _) = watch.look(Instant::now(), grace);
            assert!(second.helped >= 1 && second.fresh == 0, "{second:?}");
            assert_eq!(class_of(&child), HIGH_PRIORITY_CLASS);
            let raised = Instant::now();
            while child.try_wait().expect("try_wait").is_none() {
                assert!(
                    raised.elapsed() < Duration::from_secs(3),
                    "the ended child stayed although its priority was raised"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            // Gone: nothing is left to see or to raise, and its handle comes
            // back to be closed.
            let (third, gone) = watch.look(Instant::now(), grace);
            assert_eq!(third, Leaving::default());
            assert!(gone.iter().any(|held| held.pid == child.id()));
            assert!(watch.held.is_empty());
            drop(busy);
            return;
        }
        panic!("the ended child left by itself five times: the cores were not kept busy");
    }
}

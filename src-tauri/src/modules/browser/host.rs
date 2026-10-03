//! The WebView2 process that hosts every browser tab is not ours to reap.
//! Nothing ties it to anbo.exe, so force quitting Anbo leaves it running with
//! its renderer, GPU and utility children, all still holding composited
//! surfaces. Days of force quits pile those up until the desktop compositor
//! itself is the bottleneck and the whole machine crawls.
//!
//! Both halves of the guard live here: the running host joins a job object that
//! dies with us, and a host recorded by an older build gets reaped at startup.

#![cfg(windows)]

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::Manager;
use windows_sys::Win32::Foundation::{CloseHandle, FALSE, FILETIME, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

use crate::modules::proc::job::ProcessJob;

const HOST_PID_FILE: &str = "browser-host.pid";
const HOST_IMAGE: &str = "msedgewebview2.exe";

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
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

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
static HOST_JOBS: OnceLock<Mutex<Vec<(u32, ProcessJob)>>> = OnceLock::new();

fn host_jobs() -> &'static Mutex<Vec<(u32, ProcessJob)>> {
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
    jobs.retain(|(adopted, _)| is_webview_host(*adopted));
    if jobs.iter().any(|(adopted, _)| *adopted == pid) {
        return;
    }
    match ProcessJob::create_for(pid) {
        Ok(job) => {
            jobs.push((pid, job));
            // The start time is what lets the next run tell this host from a
            // newer process that reuses its pid; without it, no record.
            let created = Process::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
                .and_then(|process| process.created());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

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
}

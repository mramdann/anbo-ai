//! Chrome and Edge run an extension's service worker in a background process,
//! at idle priority and with EcoQoS on Windows 11, whenever none of its pages
//! is visible. On a busy machine that process waits seconds for the CPU, every
//! bridge command waits with it, and a command that outlives its deadline
//! costs the tab. The native host lives exactly as long as the connection, so
//! it keeps that one process at normal priority meanwhile.
//!
//! A tab the browser does not show runs the same way, and an agent's tab is
//! shown only while Anbo docks it: an open's setup, which the new tab's
//! renderer answers, waited 6.7 s on a busy machine (Oct 14 2026). The
//! extension names the renderers of the tabs Anbo drives by the id the browser
//! gave each (`--renderer-client-id`), and the host keeps those at normal
//! priority too, until the extension names them no more.
//!
//! Every profile of a browser runs the extension in a process of its own, and
//! a process another profile's host keeps reads as foreground. Until Oct 15
//! 2026 that made the host of a second or third connected profile find two
//! foreground processes and keep none: its opens took 5 s idle and timed out
//! on a busy machine, while the first profile's took under 1 s.

use super::browser_process;
use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, FILETIME, HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetExitCodeProcess, GetPriorityClass, GetProcessInformation, GetProcessTimes,
    OpenMutexW, OpenProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
    BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    SYNCHRONIZATION_SYNCHRONIZE,
};

/// How soon a demotion by the browser is undone.
const INTERVAL: Duration = Duration::from_millis(250);
/// How many times, one interval apart, the host looks for the extension's
/// process after it starts, and again after the extension says when its
/// worker started.
const SEARCH_ATTEMPTS: u32 = 8;
/// The most renderers kept at once, as many as the tabs the extension drives.
const MAX_RENDERERS: usize = 128;
/// How soon a named renderer not found yet is looked for again.
const RESCAN: Duration = Duration::from_millis(500);
/// GetExitCodeProcess's answer for a process that still runs.
const STILL_ACTIVE: u32 = 259;
/// How long before its worker an extension's process may have started: a
/// reload starts both within a few seconds (0 to 3 s measured).
const WORKER_EARLY_MS: u64 = 15_000;
/// The worker's clock and the process's are read apart: slack the other way.
const WORKER_LATE_MS: u64 = 2_000;
/// 1970-01-01 in FILETIME units (100 ns since 1601-01-01).
const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

/// A renderer of the browser that hosts extensions: whether the browser runs
/// it in the foreground right now, and when it started (FILETIME units).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Candidate {
    pid: u32,
    foreground: bool,
    started: u64,
}

impl Candidate {
    fn started_ms(&self) -> u64 {
        self.started.saturating_sub(UNIX_EPOCH_FILETIME) / 10_000
    }
}

enum Order {
    /// The renderers of the tabs Anbo drives.
    Renderers(Vec<u32>),
    /// When the extension's worker started, in ms since 1970.
    Worker(u64),
    /// The id of the profile that connected.
    Profile(String),
}

/// Stops keeping the processes scheduled when dropped.
pub struct Keeper {
    orders: mpsc::Sender<Order>,
}

impl Keeper {
    /// The renderers of the tabs Anbo drives, by the id the browser gave each.
    /// The list replaces the one before.
    pub fn renderers(&self, ids: Vec<u32>) {
        let _ = self.orders.send(Order::Renderers(ids));
    }

    /// When the extension's worker started, in ms since 1970, which tells its
    /// process apart from the profile's others when no popup is open, as when
    /// a reload connects again on its own.
    pub fn worker_started(&self, started: u64) {
        let _ = self.orders.send(Order::Worker(started));
    }

    /// The profile that connected, whose last host may have noted the process
    /// it kept: an extension that reloads mostly does so in the same process.
    pub fn profile(&self, id: &str) {
        let _ = self.orders.send(Order::Profile(id.to_owned()));
    }
}

pub fn keep() -> Keeper {
    let (orders, received) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("extension-priority".into())
        .spawn(move || run(&received));
    Keeper { orders }
}

fn run(orders: &mpsc::Receiver<Order>) {
    let Some(browser) = browser_process::browser_ancestor(std::process::id()) else {
        return;
    };
    // The popup that asked for this connection is still open for a moment,
    // which is what tells this extension's process apart from the others.
    let mut search_until = Instant::now() + INTERVAL * SEARCH_ATTEMPTS;
    let mut worker = None;
    let mut profile: Option<String> = None;
    let mut noted = None;
    let mut extension: Option<(Process, Claim)> = None;
    let mut renderers = Renderers::default();
    loop {
        if extension.is_none() && Instant::now() < search_until {
            extension = find_extension(browser, worker, noted);
            if let (Some((_, claim)), Some(id)) = (&extension, &profile) {
                note(id, claim.process);
            }
        }
        if let Some((process, _)) = &extension {
            process.keep_normal();
        }
        renderers.keep(browser);
        match orders.recv_timeout(INTERVAL) {
            Ok(Order::Renderers(ids)) => renderers.want(ids),
            Ok(Order::Worker(started)) => {
                worker = Some(started);
                search_until = search_until.max(Instant::now() + INTERVAL * SEARCH_ATTEMPTS);
            }
            Ok(Order::Profile(id)) => {
                noted = recall(&id);
                if let Some((_, claim)) = &extension {
                    note(&id, claim.process);
                }
                profile = Some(id);
                search_until = search_until.max(Instant::now() + INTERVAL * SEARCH_ATTEMPTS);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// This extension's process, opened and marked as kept by this host.
fn find_extension(
    browser: u32,
    worker: Option<u64>,
    noted: Option<(u32, u64)>,
) -> Option<(Process, Claim)> {
    let candidates: Vec<Candidate> = candidates(browser)
        .into_iter()
        .filter(|candidate| !Claim::held(candidate))
        .collect();
    let chosen = choose(&candidates, worker, noted)?;
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.pid == chosen)?;
    let process = Process::open(chosen)?;
    // Another host may have marked it in the meantime; then it is not ours.
    let claim = Claim::take(candidate)?;
    Some((process, claim))
}

/// The page renderers kept scheduled, by the id the browser gave each.
#[derive(Default)]
struct Renderers {
    wanted: BTreeSet<u32>,
    open: HashMap<u32, Process>,
    scanned: Option<Instant>,
}

impl Renderers {
    fn want(&mut self, ids: Vec<u32>) {
        self.wanted = ids.into_iter().take(MAX_RENDERERS).collect();
        let wanted = &self.wanted;
        self.open.retain(|id, _| wanted.contains(id));
        // A renderer named just now is looked for at once.
        self.scanned = None;
    }

    fn keep(&mut self, browser: u32) {
        self.open.retain(|_, process| process.running());
        let missing = self.wanted.iter().any(|id| !self.open.contains_key(id));
        if missing && self.scanned.is_none_or(|at| at.elapsed() >= RESCAN) {
            self.scanned = Some(Instant::now());
            for (id, pid) in renderers(browser) {
                if self.wanted.contains(&id) && !self.open.contains_key(&id) {
                    if let Some(process) = Process::open(pid) {
                        self.open.insert(id, process);
                    }
                }
            }
        }
        for process in self.open.values() {
            process.keep_normal();
        }
    }
}

/// The browser's renderers by the id it gave each, with their process ids.
fn renderers(browser: u32) -> Vec<(u32, u32)> {
    let Some(processes) = browser_process::processes() else {
        return Vec::new();
    };
    processes
        .iter()
        .filter(|(_, (parent, _))| *parent == browser)
        .filter_map(|(pid, _)| Some((renderer_id(&browser_process::command_line(*pid)?)?, *pid)))
        .collect()
}

/// The id the browser gave a renderer, from the renderer's command line.
fn renderer_id(command: &str) -> Option<u32> {
    if !command.contains("--type=renderer") {
        return None;
    }
    let digits = command.split("--renderer-client-id=").nth(1)?;
    let end = digits
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse().ok()
}

/// The browser's renderers that host extensions.
fn candidates(browser: u32) -> Vec<Candidate> {
    let Some(processes) = browser_process::processes() else {
        return Vec::new();
    };
    processes
        .iter()
        .filter(|(_, (parent, _))| *parent == browser)
        .filter_map(|(pid, _)| {
            let command = browser_process::command_line(*pid)?;
            if !command.contains("--type=renderer") || !command.contains("--extension-process") {
                return None;
            }
            let process = Process::query(*pid)?;
            Some(Candidate {
                pid: *pid,
                foreground: !process.demoted().0,
                started: process.started()?,
            })
        })
        .collect()
}

/// This extension's process among those no other host keeps: the one this
/// profile's last host kept, the only one, the one in the foreground while the
/// Connect popup is open, or the one that started with the extension's worker.
/// A reload connects with no popup, in the same process or a new one. Where
/// the popup and the worker point at different processes, or neither at one
/// alone, it is left to the browser.
fn choose(candidates: &[Candidate], worker: Option<u64>, noted: Option<(u32, u64)>) -> Option<u32> {
    if let Some(known) = noted.and_then(|(pid, started)| {
        candidates
            .iter()
            .find(|candidate| candidate.pid == pid && candidate.started == started)
    }) {
        return Some(known.pid);
    }
    if let [only] = candidates {
        return Some(only.pid);
    }
    let foreground: Vec<&Candidate> = candidates.iter().filter(|c| c.foreground).collect();
    let with_worker: Vec<&Candidate> = worker.map_or_else(Vec::new, |started| {
        candidates
            .iter()
            .filter(|candidate| started_with_worker(candidate.started_ms(), started))
            .collect()
    });
    let both: Vec<&&Candidate> = foreground
        .iter()
        .filter(|candidate| with_worker.contains(candidate))
        .collect();
    match (&foreground[..], &with_worker[..], &both[..]) {
        (_, _, [only]) => Some(only.pid),
        ([only], other, _) | (other, [only], _) if other.len() != 1 => Some(only.pid),
        _ => None,
    }
}

/// Whether a process that started at `process` (ms since 1970) started with
/// a worker that started at `worker`.
fn started_with_worker(process: u64, worker: u64) -> bool {
    process <= worker.saturating_add(WORKER_LATE_MS)
        && worker.saturating_sub(process) <= WORKER_EARLY_MS
}

/// Where a profile's host notes the process it keeps (its id and start time),
/// for the profile's next host. The id is the extension's random UUID.
fn note_path(profile: &str) -> Option<std::path::PathBuf> {
    let uuid = profile.len() == 36
        && profile
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    if !uuid {
        return None;
    }
    Some(
        std::env::current_exe()
            .ok()?
            .with_file_name("kept")
            .join(format!("{profile}.txt")),
    )
}

fn note(profile: &str, (pid, started): (u32, u64)) {
    let Some(path) = note_path(profile) else {
        return;
    };
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    let _ = std::fs::write(path, format!("{pid} {started}"));
}

fn recall(profile: &str) -> Option<(u32, u64)> {
    let path = note_path(profile)?;
    if std::fs::metadata(&path).ok()?.len() > 64 {
        return None;
    }
    read_note(&std::fs::read_to_string(path).ok()?)
}

fn read_note(text: &str) -> Option<(u32, u64)> {
    let mut parts = text.split_whitespace();
    let pid = parts.next()?.parse().ok()?;
    let started = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((pid, started))
}

/// Marks a process this host keeps, for as long as the host runs. To the host
/// of another profile it reads as foreground, and without the mark that host
/// could take it for its own.
struct Claim {
    handle: HANDLE,
    /// The marked process: its id and start time.
    process: (u32, u64),
}

impl Drop for Claim {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

impl Claim {
    fn name(candidate: &Candidate) -> Vec<u16> {
        // The start time tells a reused process id apart.
        format!(
            "Local\\anbo-browser-extension-{}-{}",
            candidate.pid, candidate.started
        )
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
    }

    fn held(candidate: &Candidate) -> bool {
        let name = Self::name(candidate);
        let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        unsafe {
            CloseHandle(handle);
        }
        true
    }

    /// None when another host marked the process first.
    fn take(candidate: &Candidate) -> Option<Self> {
        let name = Self::name(candidate);
        let handle = unsafe {
            SetLastError(0);
            CreateMutexW(std::ptr::null(), 0, name.as_ptr())
        };
        if handle.is_null() {
            return None;
        }
        let claim = Self {
            handle,
            process: (candidate.pid, candidate.started),
        };
        (unsafe { GetLastError() } != ERROR_ALREADY_EXISTS).then_some(claim)
    }
}

struct Process(HANDLE);

impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl Process {
    fn query(pid: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn running(&self) -> bool {
        let mut code = 0_u32;
        unsafe { GetExitCodeProcess(self.0, &mut code) != 0 && code == STILL_ACTIVE }
    }

    /// When the process started, in FILETIME units.
    fn started(&self) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let read =
            unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) };
        (read != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn open(pid: u32) -> Option<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                0,
                pid,
            )
        };
        (!handle.is_null()).then_some(Self(handle))
    }

    /// Whether the browser lowered the priority class, and whether it turned
    /// EcoQoS on.
    fn demoted(&self) -> (bool, bool) {
        let class = unsafe { GetPriorityClass(self.0) };
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        let read = unsafe {
            GetProcessInformation(
                self.0,
                ProcessPowerThrottling,
                (&raw mut state).cast(),
                size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        } != 0;
        let throttled = read
            && state.ControlMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED != 0
            && state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED != 0;
        (
            matches!(class, IDLE_PRIORITY_CLASS | BELOW_NORMAL_PRIORITY_CLASS),
            throttled,
        )
    }

    /// Undoes a demotion: normal priority, EcoQoS explicitly off.
    fn keep_normal(&self) {
        let (lowered, throttled) = self.demoted();
        if lowered {
            unsafe {
                SetPriorityClass(self.0, NORMAL_PRIORITY_CLASS);
            }
        }
        if throttled {
            let state = PROCESS_POWER_THROTTLING_STATE {
                Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                StateMask: 0,
            };
            unsafe {
                SetProcessInformation(
                    self.0,
                    ProcessPowerThrottling,
                    (&raw const state).cast(),
                    size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-14 10:00:00 UTC.
    const NOW_MS: u64 = 1_791_972_000_000;

    /// A process that started `ago_ms` before NOW_MS.
    fn candidate(pid: u32, foreground: bool, ago_ms: u64) -> Candidate {
        Candidate {
            pid,
            foreground,
            started: UNIX_EPOCH_FILETIME + (NOW_MS - ago_ms) * 10_000,
        }
    }

    #[test]
    fn the_only_extension_process_is_this_extension() {
        assert_eq!(choose(&[candidate(7, false, 60_000)], None, None), Some(7));
        assert_eq!(choose(&[], Some(NOW_MS), None), None);
    }

    #[test]
    fn a_renderer_is_known_by_the_id_the_browser_gave_it() {
        let renderer = r#""C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --user-data-dir="C:\Users\a\Profile" --lang=en-US --renderer-client-id=14 --time-ticks-at-unix-epoch=-1760000000 --launch-time-ticks=5 --field-trial-handle=1,i,2"#;
        assert_eq!(renderer_id(renderer), Some(14));
        assert_eq!(
            renderer_id("chrome.exe --type=renderer --extension-process --renderer-client-id=83"),
            Some(83)
        );
        assert_eq!(
            renderer_id("chrome.exe --type=gpu-process --renderer-client-id=3"),
            None
        );
        assert_eq!(renderer_id("chrome.exe --type=renderer --lang=en-US"), None);
        assert_eq!(
            renderer_id("chrome.exe --type=renderer --renderer-client-id=x"),
            None
        );
    }

    #[test]
    fn the_newest_list_of_renderers_replaces_the_one_before() {
        let mut renderers = Renderers::default();
        renderers.want(vec![14, 11, 14]);
        assert_eq!(renderers.wanted, BTreeSet::from([11, 14]));
        renderers.want((1..=500).collect());
        assert_eq!(renderers.wanted.len(), MAX_RENDERERS);
        renderers.want(Vec::new());
        assert!(renderers.wanted.is_empty());
        assert!(renderers.scanned.is_none());
    }

    #[test]
    fn among_several_only_a_single_foreground_one_is_chosen() {
        let old = 3_600_000;
        assert_eq!(
            choose(
                &[
                    candidate(7, false, old),
                    candidate(8, true, old),
                    candidate(9, false, old)
                ],
                None,
                None
            ),
            Some(8)
        );
        assert_eq!(
            choose(
                &[candidate(7, false, old), candidate(8, false, old)],
                None,
                None
            ),
            None
        );
        assert_eq!(
            choose(
                &[candidate(7, true, old), candidate(8, true, old)],
                None,
                None
            ),
            None
        );
    }

    #[test]
    fn after_a_reload_the_process_that_started_with_the_worker_is_chosen() {
        // No popup: the other profile's process, kept by its own host, was
        // left out before; another extension's process started long ago.
        let reloaded = [candidate(7, false, 3_600_000), candidate(8, false, 2_500)];
        assert_eq!(choose(&reloaded, Some(NOW_MS), None), Some(8));
        // A side panel of another extension in the foreground does not win
        // over the process that started with the worker.
        let panel = [candidate(7, true, 3_600_000), candidate(8, false, 2_500)];
        assert_eq!(choose(&panel, Some(NOW_MS), None), None);
        let panels = [
            candidate(6, true, 3_600_000),
            candidate(7, true, 3_600_000),
            candidate(8, false, 2_500),
        ];
        assert_eq!(choose(&panels, Some(NOW_MS), None), Some(8));
    }

    #[test]
    fn the_popup_and_the_worker_agree_or_the_popup_decides_alone() {
        // Two processes started with the worker; the popup shows one of them.
        let both = [candidate(7, true, 1_000), candidate(8, false, 1_500)];
        assert_eq!(choose(&both, Some(NOW_MS), None), Some(7));
        // A worker that started long after its process (the popup was open a
        // while before Connect) leaves the popup to decide.
        let late = [candidate(7, true, 600_000), candidate(8, false, 3_600_000)];
        assert_eq!(choose(&late, Some(NOW_MS), None), Some(7));
        // Nothing tells two background processes started together apart.
        let twins = [candidate(7, false, 1_000), candidate(8, false, 1_200)];
        assert_eq!(choose(&twins, Some(NOW_MS), None), None);
    }

    #[test]
    fn a_reload_in_the_same_process_finds_the_process_kept_before() {
        // The worker started just now, in a process an hour old that this
        // profile's last host noted; the other one is another extension's.
        let reused = [
            candidate(7, false, 3_600_000),
            candidate(8, false, 3_700_000),
        ];
        let noted = (7, reused[0].started);
        assert_eq!(choose(&reused, Some(NOW_MS), Some(noted)), Some(7));
        assert_eq!(choose(&reused, Some(NOW_MS), None), None);
        // A process id used again by a later process is not the noted one.
        let stale = (7, reused[0].started - 1);
        assert_eq!(choose(&reused, Some(NOW_MS), Some(stale)), None);
    }

    #[test]
    fn a_note_holds_a_process_id_and_its_start_time() {
        assert_eq!(read_note("7 133456"), Some((7, 133_456)));
        assert_eq!(read_note(" 7 133456\n"), Some((7, 133_456)));
        for odd in ["", "7", "7 x", "-7 1", "7 1 2"] {
            assert_eq!(read_note(odd), None, "{odd}");
        }
        assert!(note_path("0f3b0e1c-6c6f-4f2a-9a43-2a5b8c1d7e90").is_some());
        for odd in [
            "../../x",
            "",
            "0f3b0e1c-6c6f-4f2a-9a43-2a5b8c1d7e9",
            "0f3b0e1c/6c6f-4f2a-9a43-2a5b8c1d7e90",
        ] {
            assert!(note_path(odd).is_none(), "{odd}");
        }
    }

    #[test]
    fn a_process_started_with_its_worker_within_seconds() {
        assert!(started_with_worker(NOW_MS - 3_000, NOW_MS));
        assert!(started_with_worker(NOW_MS + 1_500, NOW_MS));
        assert!(!started_with_worker(NOW_MS + 2_500, NOW_MS));
        assert!(!started_with_worker(NOW_MS - 20_000, NOW_MS));
        assert_eq!(candidate(1, false, 0).started_ms(), NOW_MS);
    }
}

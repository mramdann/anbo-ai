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
//!
//! Once, on Oct 17 2026, one of five profiles' processes still went unkept,
//! and nothing told why. So the host now logs (host_log.rs) what each look
//! for the process saw while it kept none, which one it kept and why, and how
//! long the connection lasted.

use super::{browser_process, host_log};
use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
        filetime_ms(self.started)
    }
}

/// A FILETIME in ms since 1970.
fn filetime_ms(filetime: u64) -> u64 {
    filetime.saturating_sub(UNIX_EPOCH_FILETIME) / 10_000
}

/// Now, in ms since 1970.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
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
    orders: Option<mpsc::Sender<Order>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Keeper {
    fn drop(&mut self) {
        // The keeper stops as soon as its orders do, and logs how the
        // connection went; the host exits right after, which would cut that.
        self.orders.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Keeper {
    fn send(&self, order: Order) {
        if let Some(orders) = &self.orders {
            let _ = orders.send(order);
        }
    }

    /// The renderers of the tabs Anbo drives, by the id the browser gave each.
    /// The list replaces the one before.
    pub fn renderers(&self, ids: Vec<u32>) {
        self.send(Order::Renderers(ids));
    }

    /// When the extension's worker started, in ms since 1970, which tells its
    /// process apart from the profile's others when no popup is open, as when
    /// a reload connects again on its own.
    pub fn worker_started(&self, started: u64) {
        self.send(Order::Worker(started));
    }

    /// The profile that connected, whose last host may have noted the process
    /// it kept: an extension that reloads mostly does so in the same process.
    pub fn profile(&self, id: &str) {
        self.send(Order::Profile(id.to_owned()));
    }
}

pub fn keep() -> Keeper {
    let (orders, received) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("extension-priority".into())
        .spawn(move || run(&received))
        .ok();
    Keeper {
        orders: Some(orders),
        thread,
    }
}

fn run(orders: &mpsc::Receiver<Order>) {
    let began = Instant::now();
    let Some(browser) = browser_process::browser_ancestor(std::process::id()) else {
        host_log::line("found no Chrome or Edge among this host's parents, so it keeps no process");
        return;
    };
    host_log::line(&format!("started by browser process {browser}"));
    // The popup that asked for this connection is still open for a moment,
    // which is what tells this extension's process apart from the others.
    let mut search_until = Instant::now() + INTERVAL * SEARCH_ATTEMPTS;
    let mut worker = None;
    let mut profile: Option<String> = None;
    let mut noted = None;
    let mut extension: Option<(Process, Claim)> = None;
    let mut renderers = Renderers::default();
    let mut log = Log::default();
    loop {
        if extension.is_none() {
            if Instant::now() < search_until {
                let (look, found) = find_extension(browser, worker, noted);
                match found {
                    Ok((process, claim, why)) => {
                        host_log::line(&look.kept(claim.process, why, now_ms()));
                        if let Some(id) = &profile {
                            note(id, claim.process);
                        }
                        extension = Some((process, claim));
                    }
                    Err(miss) => log.missed(&look, &miss, worker, noted),
                }
            } else {
                log.stopped();
            }
        }
        if let Some((process, claim)) = &extension {
            log.kept(claim.process.0, process.keep_normal());
        }
        renderers.keep(browser);
        match orders.recv_timeout(INTERVAL) {
            Ok(Order::Renderers(ids)) => renderers.want(ids),
            Ok(Order::Worker(started)) => {
                host_log::line(&format!(
                    "the extension's worker started {} ago",
                    ago(now_ms().saturating_sub(started))
                ));
                worker = Some(started);
                search_until = search_until.max(Instant::now() + INTERVAL * SEARCH_ATTEMPTS);
                log.searching();
            }
            Ok(Order::Profile(id)) => {
                noted = recall(&id);
                host_log::line(&profile_line(&id, noted, now_ms()));
                if let Some((_, claim)) = &extension {
                    note(&id, claim.process);
                }
                profile = Some(id);
                search_until = search_until.max(Instant::now() + INTERVAL * SEARCH_ATTEMPTS);
                log.searching();
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                let kept = extension.as_ref().map(|(_, claim)| claim.process.0);
                host_log::line(&log.ended(began.elapsed(), kept));
                return;
            }
        }
    }
}

/// This extension's process, opened and marked as kept by this host, with
/// why it is this one; and what the look found.
fn find_extension(
    browser: u32,
    worker: Option<u64>,
    noted: Option<(u32, u64)>,
) -> (Look, Result<(Process, Claim, Why), Miss>) {
    let (held, mut free): (Vec<Candidate>, Vec<Candidate>) =
        candidates(browser).into_iter().partition(Claim::held);
    // In one order every time, so that the log tells looks apart only by
    // what changed; the choice does not depend on it.
    free.sort_unstable_by_key(|candidate| candidate.pid);
    let mut held: Vec<u32> = held.iter().map(|candidate| candidate.pid).collect();
    held.sort_unstable();
    let look = Look { free, held };
    let found = decide(&look.free, worker, noted)
        .map_err(Miss::Undecided)
        .and_then(|(candidate, why)| {
            let pid = candidate.pid;
            let process = Process::open(pid).map_err(|error| Miss::Unopened { pid, error })?;
            // Another host may have marked it in the meantime; then it is not ours.
            let claim = Claim::take(candidate).map_err(|error| Miss::Unmarked { pid, error })?;
            Ok((process, claim, why))
        });
    (look, found)
}

/// What one look for the extension's process found, for the log.
struct Look {
    /// The browser's extension processes no other host keeps.
    free: Vec<Candidate>,
    /// The ones other hosts keep.
    held: Vec<u32>,
}

impl Look {
    /// The processes as the log tells looks apart: without their ages.
    fn shape(&self) -> Vec<(u32, bool)> {
        self.free
            .iter()
            .map(|candidate| (candidate.pid, candidate.foreground))
            .collect()
    }

    fn processes(&self, now: u64) -> String {
        let free: Vec<String> = self
            .free
            .iter()
            .map(|candidate| {
                format!(
                    "{} ({}, started {} ago)",
                    candidate.pid,
                    if candidate.foreground {
                        "foreground"
                    } else {
                        "background"
                    },
                    ago(now.saturating_sub(candidate.started_ms()))
                )
            })
            .collect();
        let held: Vec<String> = self.held.iter().map(u32::to_string).collect();
        let listed = |items: &[String]| {
            if items.is_empty() {
                "none".to_owned()
            } else {
                items.join(", ")
            }
        };
        format!(
            "free: {}; other hosts keep: {}",
            listed(&free),
            listed(&held)
        )
    }

    fn kept(&self, (pid, started): (u32, u64), why: Why, now: u64) -> String {
        format!(
            "keeping process {pid} (started {} ago): {}; {}",
            ago(now.saturating_sub(filetime_ms(started))),
            why.words(),
            self.processes(now)
        )
    }

    fn missed(&self, miss: &Miss, now: u64) -> String {
        format!(
            "no process kept yet: {}; {}",
            miss.words(),
            self.processes(now)
        )
    }
}

/// Why no process was kept after a look.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Miss {
    /// None was clearly this extension's.
    Undecided(Undecided),
    /// The chosen one could not be opened to set its priority.
    Unopened { pid: u32, error: u32 },
    /// The chosen one could not be marked as kept: another host marked it
    /// first (ERROR_ALREADY_EXISTS), or Windows refused.
    Unmarked { pid: u32, error: u32 },
}

impl Miss {
    fn words(&self) -> String {
        match *self {
            Self::Undecided(undecided) => undecided.words(),
            Self::Unopened { pid, error } => {
                format!("process {pid} was chosen but could not be opened (error {error})")
            }
            Self::Unmarked { pid, error } if error == ERROR_ALREADY_EXISTS => {
                format!("process {pid} was chosen but another host marked it first")
            }
            Self::Unmarked { pid, error } => {
                format!("process {pid} was chosen but could not be marked as kept (error {error})")
            }
        }
    }
}

/// What the keeper logged, so that it logs each change once.
#[derive(Default)]
struct Log {
    /// The last look that kept nothing, as `Look::shape` and the rest.
    missed: Option<String>,
    stopped: bool,
    /// How often the host undid the browser's demotion of the kept process.
    restored: u32,
    refused: bool,
}

impl Log {
    fn missed(&mut self, look: &Look, miss: &Miss, worker: Option<u64>, noted: Option<(u32, u64)>) {
        let seen = format!(
            "{:?} {:?} {miss:?} {} {noted:?}",
            look.shape(),
            look.held,
            worker.is_some()
        );
        if self.missed.as_ref() != Some(&seen) {
            host_log::line(&look.missed(miss, now_ms()));
            self.missed = Some(seen);
        }
    }

    /// The search goes on, with more to go by.
    fn searching(&mut self) {
        self.stopped = false;
    }

    fn stopped(&mut self) {
        if !self.stopped {
            self.stopped = true;
            host_log::line("stopped looking: no extension process was clearly this one, so the browser schedules it");
        }
    }

    fn kept(&mut self, pid: u32, kept: Result<bool, u32>) {
        match kept {
            Ok(restored) => self.restored += u32::from(restored),
            Err(error) if !self.refused => {
                self.refused = true;
                host_log::line(&format!(
                    "Windows refused to keep process {pid} at normal priority (error {error})"
                ));
            }
            Err(_) => {}
        }
    }

    fn ended(&self, lasted: Duration, kept: Option<u32>) -> String {
        let seconds = lasted.as_secs();
        let Some(pid) = kept else {
            return format!("connection ended after {seconds} s; kept no extension process");
        };
        let undone = match self.restored {
            0 => "the browser never demoted it".to_owned(),
            1 => "the browser demoted it once, and the host undid that".to_owned(),
            times => format!("the browser demoted it {times} times, and the host undid each"),
        };
        format!("connection ended after {seconds} s; kept process {pid}: {undone}")
    }
}

/// A span in ms as the log writes it: tenths of a second below 100 s.
fn ago(ms: u64) -> String {
    if ms < 100_000 {
        format!("{}.{} s", ms / 1000, ms % 1000 / 100)
    } else {
        format!("{} s", ms / 1000)
    }
}

fn profile_line(id: &str, noted: Option<(u32, u64)>, now: u64) -> String {
    let id = if uuid_shaped(id) { id } else { "(not an id)" };
    match noted {
        Some((pid, started)) => format!(
            "profile {id}: its last host kept process {pid} (started {} ago)",
            ago(now.saturating_sub(filetime_ms(started)))
        ),
        None => format!("profile {id}: no earlier host noted a process"),
    }
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
                    if let Ok(process) = Process::open(pid) {
                        self.open.insert(id, process);
                    }
                }
            }
        }
        for process in self.open.values() {
            let _ = process.keep_normal();
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

/// Why a process was taken for this extension's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Why {
    Noted,
    Only,
    Popup,
    Worker,
    PopupAndWorker,
}

impl Why {
    fn words(self) -> &'static str {
        match self {
            Self::Noted => "the one this profile's last host kept",
            Self::Only => "the only extension process no other host keeps",
            Self::Popup => "the only one in the foreground, where the Connect popup runs",
            Self::Worker => "the only one that started with the extension's worker",
            Self::PopupAndWorker => "the only one in the foreground that started with the worker",
        }
    }
}

/// How the free processes looked when none was clearly this extension's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Undecided {
    free: usize,
    foreground: usize,
    /// How many started with the worker; None while its start is unknown.
    with_worker: Option<usize>,
}

impl Undecided {
    fn words(self) -> String {
        if self.free == 0 {
            return "no extension process of the browser is free".to_owned();
        }
        let worker = self.with_worker.map_or_else(
            || "the worker's start not known yet".to_owned(),
            |count| format!("{count} started with the worker"),
        );
        format!(
            "none of {} free extension processes is clearly this one ({} in the foreground, {worker})",
            self.free, self.foreground
        )
    }
}

/// This extension's process among those no other host keeps: the one this
/// profile's last host kept, the only one, the one in the foreground while the
/// Connect popup is open, or the one that started with the extension's worker.
/// A reload connects with no popup, in the same process or a new one. Where
/// the popup and the worker point at different processes, or neither at one
/// alone, it is left to the browser.
fn decide(
    candidates: &[Candidate],
    worker: Option<u64>,
    noted: Option<(u32, u64)>,
) -> Result<(&Candidate, Why), Undecided> {
    if let Some(known) = noted.and_then(|(pid, started)| {
        candidates
            .iter()
            .find(|candidate| candidate.pid == pid && candidate.started == started)
    }) {
        return Ok((known, Why::Noted));
    }
    if let [only] = candidates {
        return Ok((only, Why::Only));
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
        (_, _, [only]) => Ok((**only, Why::PopupAndWorker)),
        ([only], other, _) if other.len() != 1 => Ok((*only, Why::Popup)),
        (other, [only], _) if other.len() != 1 => Ok((*only, Why::Worker)),
        _ => Err(Undecided {
            free: candidates.len(),
            foreground: foreground.len(),
            with_worker: worker.map(|_| with_worker.len()),
        }),
    }
}

/// Whether a process that started at `process` (ms since 1970) started with
/// a worker that started at `worker`.
fn started_with_worker(process: u64, worker: u64) -> bool {
    process <= worker.saturating_add(WORKER_LATE_MS)
        && worker.saturating_sub(process) <= WORKER_EARLY_MS
}

/// The extension names its profile by a random UUID.
fn uuid_shaped(profile: &str) -> bool {
    profile.len() == 36
        && profile
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// Where a profile's host notes the process it keeps (its id and start time),
/// for the profile's next host.
fn note_path(profile: &str) -> Option<std::path::PathBuf> {
    if !uuid_shaped(profile) {
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

    /// Fails with ERROR_ALREADY_EXISTS when another host marked the process
    /// first, or with the error Windows gave.
    fn take(candidate: &Candidate) -> Result<Self, u32> {
        let name = Self::name(candidate);
        let handle = unsafe {
            SetLastError(0);
            CreateMutexW(std::ptr::null(), 0, name.as_ptr())
        };
        if handle.is_null() {
            return Err(unsafe { GetLastError() });
        }
        let claim = Self {
            handle,
            process: (candidate.pid, candidate.started),
        };
        match unsafe { GetLastError() } {
            ERROR_ALREADY_EXISTS => Err(ERROR_ALREADY_EXISTS),
            _ => Ok(claim),
        }
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

    fn open(pid: u32) -> Result<Self, u32> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(unsafe { GetLastError() });
        }
        Ok(Self(handle))
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

    /// Undoes a demotion: normal priority, EcoQoS explicitly off. Whether
    /// there was one, or the error of the first call Windows refused.
    fn keep_normal(&self) -> Result<bool, u32> {
        let (lowered, throttled) = self.demoted();
        let mut refused = None;
        if lowered && unsafe { SetPriorityClass(self.0, NORMAL_PRIORITY_CLASS) } == 0 {
            refused = Some(unsafe { GetLastError() });
        }
        if throttled {
            let state = PROCESS_POWER_THROTTLING_STATE {
                Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                StateMask: 0,
            };
            let set = unsafe {
                SetProcessInformation(
                    self.0,
                    ProcessPowerThrottling,
                    (&raw const state).cast(),
                    size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
                )
            };
            if set == 0 {
                refused = refused.or(Some(unsafe { GetLastError() }));
            }
        }
        refused.map_or(Ok(lowered || throttled), Err)
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

    fn choose(
        candidates: &[Candidate],
        worker: Option<u64>,
        noted: Option<(u32, u64)>,
    ) -> Option<u32> {
        decide(candidates, worker, noted)
            .ok()
            .map(|(candidate, _)| candidate.pid)
    }

    fn why(
        candidates: &[Candidate],
        worker: Option<u64>,
        noted: Option<(u32, u64)>,
    ) -> Result<(u32, Why), Undecided> {
        decide(candidates, worker, noted).map(|(candidate, why)| (candidate.pid, why))
    }

    #[test]
    fn the_host_says_why_a_process_is_this_extensions_or_why_none_is() {
        let old = 3_600_000;
        let noted = [candidate(7, false, old), candidate(8, false, old)];
        assert_eq!(
            why(&noted, None, Some((7, noted[0].started))),
            Ok((7, Why::Noted))
        );
        assert_eq!(
            why(&[candidate(7, false, old)], None, None),
            Ok((7, Why::Only))
        );
        assert_eq!(
            why(
                &[candidate(7, false, old), candidate(8, true, old)],
                None,
                None
            ),
            Ok((8, Why::Popup))
        );
        assert_eq!(
            why(
                &[candidate(7, false, old), candidate(8, false, 2_500)],
                Some(NOW_MS),
                None
            ),
            Ok((8, Why::Worker))
        );
        assert_eq!(
            why(
                &[candidate(7, true, 1_000), candidate(8, false, 1_500)],
                Some(NOW_MS),
                None
            ),
            Ok((7, Why::PopupAndWorker))
        );
        assert_eq!(
            why(
                &[candidate(7, true, old), candidate(8, true, old)],
                None,
                None
            ),
            Err(Undecided {
                free: 2,
                foreground: 2,
                with_worker: None
            })
        );
        assert_eq!(
            why(
                &[candidate(7, false, 1_000), candidate(8, false, 1_200)],
                Some(NOW_MS),
                None
            ),
            Err(Undecided {
                free: 2,
                foreground: 0,
                with_worker: Some(2)
            })
        );
        assert_eq!(
            why(&[], Some(NOW_MS), None),
            Err(Undecided {
                free: 0,
                foreground: 0,
                with_worker: Some(0)
            })
        );
    }

    #[test]
    fn the_log_tells_what_a_look_found_and_what_was_kept() {
        let look = Look {
            free: vec![
                candidate(15208, true, 3_149),
                candidate(9999, false, 3_600_000),
            ],
            held: vec![14968, 856],
        };
        assert_eq!(
            look.missed(
                &Miss::Undecided(Undecided {
                    free: 2,
                    foreground: 1,
                    with_worker: None
                }),
                NOW_MS
            ),
            "no process kept yet: none of 2 free extension processes is clearly this one (1 in the foreground, the worker's start not known yet); free: 15208 (foreground, started 3.1 s ago), 9999 (background, started 3600 s ago); other hosts keep: 14968, 856"
        );
        let alone = Look {
            free: vec![candidate(15208, false, 99_999)],
            held: Vec::new(),
        };
        assert_eq!(
            alone.kept((15208, alone.free[0].started), Why::Only, NOW_MS),
            "keeping process 15208 (started 99.9 s ago): the only extension process no other host keeps; free: 15208 (background, started 99.9 s ago); other hosts keep: none"
        );
        let empty = Look {
            free: Vec::new(),
            held: vec![14968],
        };
        assert_eq!(
            empty.missed(
                &Miss::Undecided(Undecided {
                    free: 0,
                    foreground: 0,
                    with_worker: Some(0)
                }),
                NOW_MS
            ),
            "no process kept yet: no extension process of the browser is free; free: none; other hosts keep: 14968"
        );
        assert_eq!(
            Miss::Unmarked {
                pid: 7,
                error: ERROR_ALREADY_EXISTS
            }
            .words(),
            "process 7 was chosen but another host marked it first"
        );
        assert_eq!(
            Miss::Unopened { pid: 7, error: 5 }.words(),
            "process 7 was chosen but could not be opened (error 5)"
        );
        assert_eq!(ago(0), "0.0 s");
        assert_eq!(ago(100_000), "100 s");
    }

    #[test]
    fn the_log_names_the_profile_only_by_its_id_and_tells_how_long_it_lasted() {
        let id = "0f3b0e1c-6c6f-4f2a-9a43-2a5b8c1d7e90";
        let started = candidate(7, false, 60_000).started;
        assert_eq!(
            profile_line(id, Some((7, started)), NOW_MS),
            format!("profile {id}: its last host kept process 7 (started 60.0 s ago)")
        );
        assert_eq!(
            profile_line("evil\nline", None, NOW_MS),
            "profile (not an id): no earlier host noted a process"
        );
        let mut log = Log::default();
        assert_eq!(
            log.ended(Duration::from_secs(9), Some(7)),
            "connection ended after 9 s; kept process 7: the browser never demoted it"
        );
        log.kept(7, Ok(true));
        log.kept(7, Ok(false));
        assert_eq!(
            log.ended(Duration::from_secs(9), Some(7)),
            "connection ended after 9 s; kept process 7: the browser demoted it once, and the host undid that"
        );
        log.kept(7, Ok(true));
        assert_eq!(
            log.ended(Duration::from_millis(312_400), Some(7)),
            "connection ended after 312 s; kept process 7: the browser demoted it 2 times, and the host undid each"
        );
        assert_eq!(
            Log::default().ended(Duration::from_secs(4), None),
            "connection ended after 4 s; kept no extension process"
        );
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

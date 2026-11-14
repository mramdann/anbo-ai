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
//!
//! That log told the next one. A browser that has just started runs several
//! extension processes at once: a fresh Edge four to eight of its own for its
//! first seconds, two or more of them still in the foreground. A profile that
//! connected then met "none of 4 free extension processes is clearly this
//! one", the host stopped looking two seconds later, and the extension stayed
//! at idle priority for the whole connection, an hour in the test that found
//! it (Nov 14 2026, R101-1). Real agents in that Edge lost 8 of 109 page
//! commands to their deadlines while the same agents in Chrome lost none of
//! 121, and under a full CPU load a scripted login failed 10 times of 10
//! there and passed 10 of 10 once the process was kept by hand. The other
//! processes are gone a little later, so the host no longer stops: it looks
//! again at a slower pace until one process is clearly this extension's.
//!
//! Where the other processes stay (other extensions the user runs) nothing a
//! look can see tells them apart, and the extension went unkept for as long
//! as no Connect popup was opened. So the host asks the extension itself
//! (`Ask`): hold this many megabytes for a moment. The one process whose
//! private bytes grow by that much, and shrink again when the extension lets
//! go, is this extension's (measured Nov 14 2026: 32 MB held read as +31.6 MB
//! from outside, 48 MB as +48.1 MB, and both as gone 0.3 s after the let-go).
//! It costs the worker a few milliseconds of CPU, so an extension that waits
//! seconds for the CPU still answers, which a burst of work to be measured
//! from outside would not: with all four cores busy from before its worker
//! started, it was kept 5.9 s after the host asked (Nov 15 2026). Only an
//! extension that says it knows the question is asked (0.5.19 on, with its
//! worker's start).
//!
//! The same answer settles what a look can only guess. "The only one in the
//! foreground" is this extension's while its Connect popup is open, and
//! another extension's whenever that one shows a page of its own: with one
//! shown in a window and this extension reconnecting by itself, the host
//! kept the other extension's process (Edge, Nov 15 2026), as it had since
//! the looks began. So a process a look took is kept for the time being, the
//! extension is asked all the same, and the process that shows itself is kept
//! from then on: the same one in nearly every case, this extension's own in
//! the others. It is looked for among every renderer of the browser, not only
//! the ones the looks list (those the browser started with
//! `--extension-process`): which process answers does not depend on what the
//! browser wrote on its command line.

use super::{browser_process, host_log};
use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, FILETIME, HANDLE,
};
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
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
/// How long after those looks the host looks again while it keeps no process,
/// and the longest it then waits between two looks: each wait is twice the
/// one before. A look lists every process and reads the command lines of the
/// browser's own, a few milliseconds of CPU.
const SLOW_LOOK_FIRST: Duration = Duration::from_secs(2);
const SLOW_LOOK_MAX: Duration = Duration::from_secs(30);
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
/// The megabytes the extension is asked to hold so that its process shows:
/// one of these each time, so that two profiles' hosts that ask in the same
/// moment mostly ask for different amounts.
const MARK_SIZES: [u32; 5] = [16, 24, 32, 40, 48];
/// How far from the amount asked for a process's growth may be, in megabytes:
/// less than half the step between two amounts.
const MARK_SLACK_MB: u64 = 3;
/// How long the extension has to say that it holds them. Its worker may be
/// waiting seconds for the CPU, which is what the host is there to end.
const MARK_PATIENCE: Duration = Duration::from_secs(30);
/// How long its process then has to shrink again: the extension lets go by
/// itself 10 s after it took hold, should it never hear that it may.
const UNMARK_PATIENCE: Duration = Duration::from_secs(20);
/// How long after a round that showed nothing the next one begins, and the
/// longest between two: each wait is twice the one before.
const MARK_AGAIN_FIRST: Duration = Duration::from_secs(2);
const MARK_AGAIN_MAX: Duration = Duration::from_secs(30);
/// An answer this soon comes from an extension that is not waiting for the
/// CPU: measured, it comes within a few milliseconds.
const MARK_QUICK: Duration = Duration::from_secs(5);
/// After this many quick answers that showed no process, or more than one,
/// the host stops asking: this browser does not count the memory the way it
/// was measured.
const MARK_UNCLEAR: u32 = 8;
const MEGABYTE: u64 = 1_048_576;

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
    /// When the extension's worker started, in ms since 1970, and whether
    /// the extension shows its process when asked (`Ask`).
    Worker(u64, bool),
    /// The id of the profile that connected.
    Profile(String),
    /// The extension holds the memory it was asked for in this round.
    Marked(u32),
}

/// What the host asks the extension itself, to tell its process from the
/// profile's other extension processes. `round` comes back in the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    /// Hold this many megabytes, and say so.
    Mark { round: u32, megabytes: u32 },
    /// Let them go.
    Unmark { round: u32 },
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
    /// a reload connects again on its own. `marks`: the extension shows its
    /// process when asked (`Ask`), for where that start tells nothing.
    pub fn worker_started(&self, started: u64, marks: bool) {
        self.send(Order::Worker(started, marks));
    }

    /// The profile that connected, whose last host may have noted the process
    /// it kept: an extension that reloads mostly does so in the same process.
    pub fn profile(&self, id: &str) {
        self.send(Order::Profile(id.to_owned()));
    }

    /// The extension answered `Ask::Mark`: it holds that round's memory.
    pub fn marked(&self, round: u32) {
        self.send(Order::Marked(round));
    }
}

/// `ask` sends a question to the extension itself, which answers through
/// `Keeper::marked`.
pub fn keep(ask: impl Fn(Ask) + Send + 'static) -> Keeper {
    let (orders, received) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("extension-priority".into())
        .spawn(move || run(&received, &ask))
        .ok();
    Keeper {
        orders: Some(orders),
        thread,
    }
}

fn run(orders: &mpsc::Receiver<Order>, ask: &dyn Fn(Ask)) {
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
    let mut slow = SlowLooks::default();
    let mut marking = Marking::default();
    loop {
        if extension.is_none() {
            let now = Instant::now();
            let first_looks = now < search_until;
            if first_looks {
                slow = SlowLooks::default();
            } else {
                log.slowed();
            }
            if first_looks || slow.due(now) {
                let (look, found) = find_extension(browser, worker, noted);
                match found {
                    Ok((process, claim, why)) => {
                        host_log::line(&look.kept(claim.process, why, now_ms()));
                        if let Some(id) = &profile {
                            note(id, claim.process);
                        }
                        // What a look could tell: the extension says below
                        // whether it is right, when it can.
                        extension = Some((process, claim));
                    }
                    Err(miss) => log.missed(&look, &miss, worker, noted),
                }
            }
        }
        let now = Instant::now();
        if marking.due(now) {
            let kept = extension.as_ref().map(|(_, claim)| claim.process);
            let own = own_candidates(browser, kept);
            if alone(&own, kept) {
                marking.sure = true;
            } else {
                // Another amount each time, and mostly another than a second
                // profile's host asks for in the same moment.
                let pick = now_ms().wrapping_add(u64::from(std::process::id()).wrapping_mul(7919));
                if let Some(line) = marking.begin(&own, now, pick, &held_bytes, ask) {
                    host_log::line(&line);
                }
            }
        }
        let (shown, line) = marking.tick(Instant::now(), &held_bytes, ask);
        if let Some(line) = line {
            host_log::line(&line);
        }
        if let Some((candidate, megabytes)) = shown {
            let kept = extension.as_ref().map(|(_, claim)| claim.process);
            let shown = shown_as(kept, &candidate);
            if shown == Shown::Kept {
                marking.sure = true;
                host_log::line(&shown_line(&candidate, megabytes, shown, now_ms()));
            } else {
                // The one a look took, if any, was another extension's. Its
                // mark goes with it; its priority is the browser's again from
                // the next time the browser sets it.
                match keep_shown(&candidate) {
                    Ok((process, claim)) => {
                        host_log::line(&shown_line(&candidate, megabytes, shown, now_ms()));
                        if let Some(id) = &profile {
                            note(id, claim.process);
                        }
                        marking.sure = true;
                        extension = Some((process, claim));
                    }
                    Err(miss) => {
                        let line = format!(
                            "process {} showed itself to be this extension's, but: {}",
                            candidate.pid,
                            miss.words()
                        );
                        let turn = format!("unkept {}", candidate.pid);
                        if let Some(line) = marking.say(turn, line) {
                            host_log::line(&line);
                        }
                    }
                }
            }
        }
        if let Some((process, claim)) = &extension {
            log.kept(claim.process.0, process.keep_normal());
        }
        renderers.keep(browser);
        match orders.recv_timeout(INTERVAL) {
            Ok(Order::Renderers(ids)) => renderers.want(ids),
            Ok(Order::Worker(started, marks)) => {
                host_log::line(&format!(
                    "the extension's worker started {} ago",
                    ago(now_ms().saturating_sub(started))
                ));
                worker = Some(started);
                marking.known = marks;
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
            Ok(Order::Marked(round)) => {
                if let Some(line) = marking.marked(round, Instant::now(), &held_bytes, ask) {
                    host_log::line(&line);
                }
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

/// The browser's renderers that can be this extension's process when it is
/// asked to show itself: those no host keeps, and the one this host keeps.
/// Every renderer, not only the ones the browser started as extension
/// processes: the process that grows by what was asked is the extension's,
/// whatever its command line says.
fn own_candidates(browser: u32, kept: Option<(u32, u64)>) -> Vec<Candidate> {
    let mut own: Vec<Candidate> = renderer_candidates(browser, true)
        .into_iter()
        .filter(|candidate| {
            kept == Some((candidate.pid, candidate.started)) || !Claim::held(candidate)
        })
        .collect();
    own.sort_unstable_by_key(|candidate| candidate.pid);
    own
}

/// Whether the kept process is the only one that can be this extension's,
/// which leaves nothing to ask.
fn alone(own: &[Candidate], kept: Option<(u32, u64)>) -> bool {
    matches!((own, kept), ([only], Some(kept)) if (only.pid, only.started) == kept)
}

/// The private bytes a process holds now, when it is still the same process.
fn held_bytes(candidate: &Candidate) -> Option<u64> {
    let process = Process::query(candidate.pid)?;
    (process.started()? == candidate.started)
        .then(|| process.private_bytes())
        .flatten()
}

/// Opens and marks the process that showed itself to be this extension's.
fn keep_shown(candidate: &Candidate) -> Result<(Process, Claim), Miss> {
    let pid = candidate.pid;
    let process = Process::open(pid).map_err(|error| Miss::Unopened { pid, error })?;
    let claim = Claim::take(candidate).map_err(|error| Miss::Unmarked { pid, error })?;
    Ok((process, claim))
}

/// What the host kept when a process showed itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shown {
    /// That very process: a look had taken the right one.
    Kept,
    /// None: no look could tell.
    New,
    /// Another extension's, which a look had taken for this one.
    Instead(u32),
}

/// What a process that showed itself means for the one kept so far.
fn shown_as(kept: Option<(u32, u64)>, candidate: &Candidate) -> Shown {
    match kept {
        Some(kept) if kept == (candidate.pid, candidate.started) => Shown::Kept,
        Some((other, _)) => Shown::Instead(other),
        None => Shown::New,
    }
}

fn shown_line(candidate: &Candidate, megabytes: u32, shown: Shown, now: u64) -> String {
    let pid = candidate.pid;
    let how = format!(
        "it grew by {megabytes} MB when the host asked this extension to hold that much, and shrank when it let go"
    );
    let started = ago(now.saturating_sub(candidate.started_ms()));
    match shown {
        Shown::Kept => format!("process {pid} is this extension's for sure: {how}"),
        Shown::New => format!("keeping process {pid} (started {started} ago): {how}"),
        Shown::Instead(other) => format!(
            "keeping process {pid} (started {started} ago) and no longer process {other}, which is another extension's: {how}"
        ),
    }
}

/// The megabytes to ask for in a round: one of `MARK_SIZES`, by `pick`.
fn mark_megabytes(pick: u64) -> u32 {
    MARK_SIZES[(pick % MARK_SIZES.len() as u64) as usize]
}

/// The processes that hold `megabytes` more than they did before, give or
/// take `MARK_SLACK_MB`. Measured: 32 MB held read as 31.6 MB more, 48 MB as
/// 48.1 MB more.
fn grew(
    before: &[(Candidate, u64)],
    held: &dyn Fn(&Candidate) -> Option<u64>,
    megabytes: u32,
) -> Vec<Candidate> {
    let wanted = u64::from(megabytes) * MEGABYTE;
    let slack = MARK_SLACK_MB * MEGABYTE;
    before
        .iter()
        .filter(|(candidate, earlier)| {
            held(candidate).is_some_and(|now| {
                let more = now.saturating_sub(*earlier);
                more + slack >= wanted && more <= wanted + slack
            })
        })
        .map(|(candidate, _)| *candidate)
        .collect()
}

/// Whether a process that held `with_mark` bytes let most of `megabytes` go.
fn shrank(with_mark: u64, now: u64, megabytes: u32) -> bool {
    with_mark.saturating_sub(now) * 100 >= u64::from(megabytes) * MEGABYTE * 70
}

/// The asking of the extension to show its process (`Ask`), one round at a
/// time, until the kept process is this extension's for sure. A round ends
/// with one process that grew by what was asked and shrank again, or with
/// nothing, and then the next round asks again.
#[derive(Default)]
struct Marking {
    /// The extension said that it answers (0.5.19 on).
    known: bool,
    /// The kept process is this extension's for sure: it showed itself, or
    /// no other can be it.
    sure: bool,
    state: MarkState,
    /// When the next round may begin, and how long after that the one after
    /// it: `due`.
    next: Option<Instant>,
    wait: Duration,
    rounds: u32,
    /// Quick answers that showed no process: see `MARK_UNCLEAR`.
    unclear: u32,
    /// The host stopped asking.
    over: bool,
    /// What the log last said of a round, so that it says each turn once: an
    /// extension that waits for the CPU may leave many rounds unanswered.
    said: Option<String>,
}

#[derive(Default)]
enum MarkState {
    #[default]
    Idle,
    /// The extension was asked to hold `megabytes`; what each renderer that
    /// can be its process held before.
    Asked {
        round: u32,
        megabytes: u32,
        before: Vec<(Candidate, u64)>,
        at: Instant,
    },
    /// One process grew by that much, and has to shrink again. `quick`: the
    /// extension answered at once, so it is not waiting for the CPU.
    LettingGo {
        megabytes: u32,
        candidate: Candidate,
        with_mark: u64,
        at: Instant,
        quick: bool,
    },
}

impl Marking {
    /// Whether a round is to begin at `now`: the extension answers such
    /// questions, its process is not known for sure, and no round is under
    /// way. The first is due at once, each one after it twice as long after
    /// the one before, from `MARK_AGAIN_FIRST` up to `MARK_AGAIN_MAX`.
    fn due(&mut self, now: Instant) -> bool {
        if !self.known || self.sure || self.over || !matches!(self.state, MarkState::Idle) {
            return false;
        }
        if self.next.is_some_and(|at| now < at) {
            return false;
        }
        self.wait = match self.next {
            None => MARK_AGAIN_FIRST,
            Some(_) => (self.wait * 2).min(MARK_AGAIN_MAX),
        };
        self.next = Some(now + self.wait);
        true
    }

    /// Asks the extension to show which of `own` is its process, when it
    /// answers such questions, no round is under way and more than one can
    /// be it. The line is for the log.
    fn begin(
        &mut self,
        own: &[Candidate],
        now: Instant,
        pick: u64,
        held: &dyn Fn(&Candidate) -> Option<u64>,
        ask: &dyn Fn(Ask),
    ) -> Option<String> {
        if !self.known || self.sure || self.over || !matches!(self.state, MarkState::Idle) {
            return None;
        }
        let before: Vec<(Candidate, u64)> = own
            .iter()
            .filter_map(|candidate| Some((*candidate, held(candidate)?)))
            .collect();
        if before.len() < 2 {
            return None;
        }
        self.rounds = self.rounds.wrapping_add(1).max(1);
        let (round, megabytes) = (self.rounds, mark_megabytes(pick));
        ask(Ask::Mark { round, megabytes });
        let count = before.len();
        self.state = MarkState::Asked {
            round,
            megabytes,
            before,
            at: now,
        };
        // Said for the first round; the rounds after it say how they ended.
        (round == 1).then(|| {
            format!(
                "asked the extension to hold {megabytes} MB for a moment, which shows its process among the browser's {count} renderers"
            )
        })
    }

    /// The extension says that it holds the memory of round `answered`.
    fn marked(
        &mut self,
        answered: u32,
        now: Instant,
        held: &dyn Fn(&Candidate) -> Option<u64>,
        ask: &dyn Fn(Ask),
    ) -> Option<String> {
        if !matches!(&self.state, MarkState::Asked { round, .. } if *round == answered) {
            return None;
        }
        let MarkState::Asked {
            round,
            megabytes,
            before,
            at,
        } = std::mem::take(&mut self.state)
        else {
            return None;
        };
        let quick = now.saturating_duration_since(at) < MARK_QUICK;
        let grown = grew(&before, held, megabytes);
        // Whatever showed, the memory goes back.
        ask(Ask::Unmark { round });
        if let [candidate] = grown[..] {
            if let Some(with_mark) = held(&candidate) {
                self.state = MarkState::LettingGo {
                    megabytes,
                    candidate,
                    with_mark,
                    at: now,
                    quick,
                };
                return None;
            }
        }
        self.showed_nothing(
            quick,
            format!("grew {}", grown.len()),
            format!(
                "the extension held {megabytes} MB and {} of the browser's {} renderers grew by that much: none is clearly this one yet",
                grown.len(),
                before.len()
            ),
        )
    }

    /// What became of the round under way: the process that showed itself,
    /// with the megabytes it held, and a line for the log.
    fn tick(
        &mut self,
        now: Instant,
        held: &dyn Fn(&Candidate) -> Option<u64>,
        ask: &dyn Fn(Ask),
    ) -> (Option<(Candidate, u32)>, Option<String>) {
        match &self.state {
            MarkState::Idle => (None, None),
            MarkState::Asked { round, at, .. } => {
                if now.saturating_duration_since(*at) < MARK_PATIENCE {
                    return (None, None);
                }
                // An answer that comes after all holds nothing for long.
                ask(Ask::Unmark { round: *round });
                self.state = MarkState::Idle;
                if self.sure {
                    // A look settled it meanwhile: nothing was left to answer.
                    return (None, None);
                }
                let line = self.say(
                    "unanswered".to_owned(),
                    format!(
                        "the extension did not say within {} s that it holds the memory; the host goes on asking",
                        MARK_PATIENCE.as_secs()
                    ),
                );
                (None, line)
            }
            MarkState::LettingGo {
                megabytes,
                candidate,
                with_mark,
                at,
                quick,
            } => {
                let (megabytes, candidate, quick) = (*megabytes, *candidate, *quick);
                let (turn, line) = match held(&candidate) {
                    Some(bytes) if shrank(*with_mark, bytes, megabytes) => {
                        self.state = MarkState::Idle;
                        return (Some((candidate, megabytes)), None);
                    }
                    Some(_) if now.saturating_duration_since(*at) < UNMARK_PATIENCE => {
                        return (None, None);
                    }
                    Some(_) => (
                        "kept its size",
                        format!(
                            "process {} grew by {megabytes} MB but did not shrink again within {} s: not taken for this extension's",
                            candidate.pid,
                            UNMARK_PATIENCE.as_secs()
                        ),
                    ),
                    None => (
                        "gone",
                        format!(
                            "process {} grew by {megabytes} MB and was gone before it shrank again",
                            candidate.pid
                        ),
                    ),
                };
                self.state = MarkState::Idle;
                (None, self.showed_nothing(quick, turn.to_owned(), line))
            }
        }
    }

    /// A round the extension answered ended with no process shown. One it
    /// answered at once counts: after `MARK_UNCLEAR` of those the host stops
    /// asking. A slow answer is a busy machine's, and says nothing of the
    /// measure.
    fn showed_nothing(&mut self, quick: bool, turn: String, line: String) -> Option<String> {
        if quick {
            self.unclear += 1;
        }
        if self.unclear >= MARK_UNCLEAR {
            self.over = true;
            return Some(format!(
                "{line}; {MARK_UNCLEAR} quick answers showed no process, so the host stops asking"
            ));
        }
        self.say(turn, line)
    }

    /// A line the log did not just say.
    fn say(&mut self, turn: String, line: String) -> Option<String> {
        if self.said.as_ref() == Some(&turn) {
            return None;
        }
        self.said = Some(turn);
        Some(line)
    }
}

/// The pace of the looks that follow the first ones while no process is kept.
struct SlowLooks {
    wait: Duration,
    next: Option<Instant>,
}

impl Default for SlowLooks {
    fn default() -> Self {
        Self {
            wait: SLOW_LOOK_FIRST,
            next: None,
        }
    }
}

impl SlowLooks {
    /// Whether a look is due at `now`. The first call only sets the first
    /// look's time; each look that comes due sets the next twice as far off,
    /// up to `SLOW_LOOK_MAX`.
    fn due(&mut self, now: Instant) -> bool {
        match self.next {
            None => {
                self.next = Some(now + self.wait);
                false
            }
            Some(at) if now >= at => {
                self.wait = (self.wait * 2).min(SLOW_LOOK_MAX);
                self.next = Some(now + self.wait);
                true
            }
            Some(_) => false,
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
    slowed: bool,
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
        self.slowed = false;
    }

    /// The first looks kept nothing: said once for each search.
    fn slowed(&mut self) {
        if !self.slowed {
            self.slowed = true;
            host_log::line(&format!(
                "no extension process is clearly this one yet, so the browser schedules it for now; the host looks again in {} s and then at up to {} s apart",
                SLOW_LOOK_FIRST.as_secs(),
                SLOW_LOOK_MAX.as_secs()
            ));
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

/// The browser's renderers that host extensions, by the browser's own word.
fn candidates(browser: u32) -> Vec<Candidate> {
    renderer_candidates(browser, false)
}

/// The browser's renderers: the ones it started as extension processes
/// (`--extension-process` on the command line), which is what a look goes by,
/// or `every` one, for the extension's own answer, which needs no such word.
fn renderer_candidates(browser: u32, every: bool) -> Vec<Candidate> {
    let Some(processes) = browser_process::processes() else {
        return Vec::new();
    };
    processes
        .iter()
        .filter(|(_, (parent, _))| *parent == browser)
        .filter_map(|(pid, _)| {
            let command = browser_process::command_line(*pid)?;
            if !command.contains("--type=renderer")
                || !(every || command.contains("--extension-process"))
            {
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

    /// The private bytes (commit) the process holds.
    fn private_bytes(&self) -> Option<u64> {
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let read =
            unsafe { K32GetProcessMemoryInfo(self.0, (&raw mut counters).cast(), counters.cb) };
        (read != 0).then_some(counters.PrivateUsage as u64)
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
    fn the_host_goes_on_looking_at_a_slower_pace() {
        // R101-1: a freshly started Edge ran four extension processes, the
        // host stopped looking after two seconds, and three of them were gone
        // a little later, leaving this extension's alone and unkept.
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut slow = SlowLooks::default();
        // The first call only sets the time of the first slow look.
        assert!(!slow.due(at(0)));
        assert!(!slow.due(at(1_999)));
        assert!(slow.due(at(2_000)));
        // Then twice as far off each time: 4 s, 8 s, 16 s after the look before.
        assert!(!slow.due(at(5_999)));
        assert!(slow.due(at(6_000)));
        assert!(!slow.due(at(13_999)));
        assert!(slow.due(at(14_000)));
        assert!(slow.due(at(30_000)));
        // And never more than SLOW_LOOK_MAX apart.
        assert!(!slow.due(at(59_999)));
        assert!(slow.due(at(60_000)));
        assert!(!slow.due(at(89_999)));
        assert!(slow.due(at(90_000)));
        assert_eq!(slow.wait, SLOW_LOOK_MAX);
        // A new search starts the pace over.
        let mut again = SlowLooks::default();
        assert!(!again.due(at(100_000)));
        assert!(again.due(at(102_000)));
    }

    /// What the processes hold, in bytes by process id, and what the
    /// extension was asked.
    struct Marks {
        held: std::cell::RefCell<HashMap<u32, u64>>,
        asked: std::cell::RefCell<Vec<Ask>>,
        free: Vec<Candidate>,
        start: Instant,
    }

    const MB: u64 = MEGABYTE;

    impl Marks {
        /// Three free processes, as other extensions of the user's leave them:
        /// all in the background, none started with the worker.
        fn new() -> Self {
            Self {
                held: std::cell::RefCell::new(HashMap::from([
                    (7, 20 * MB),
                    (8, 60 * MB),
                    (9, 35 * MB),
                ])),
                asked: std::cell::RefCell::default(),
                free: vec![
                    candidate(7, false, 3_600_000),
                    candidate(8, false, 3_600_000),
                    candidate(9, false, 3_600_000),
                ],
                start: Instant::now(),
            }
        }

        fn at(&self, ms: u64) -> Instant {
            self.start + Duration::from_millis(ms)
        }

        fn hold(&self, pid: u32, bytes: u64) {
            self.held.borrow_mut().insert(pid, bytes);
        }

        fn begin(&self, marking: &mut Marking, ms: u64, pick: u64) -> Option<String> {
            marking.begin(
                &self.free,
                self.at(ms),
                pick,
                &|candidate| self.held.borrow().get(&candidate.pid).copied(),
                &|ask| self.asked.borrow_mut().push(ask),
            )
        }

        fn marked(&self, marking: &mut Marking, round: u32, ms: u64) -> Option<String> {
            marking.marked(
                round,
                self.at(ms),
                &|candidate| self.held.borrow().get(&candidate.pid).copied(),
                &|ask| self.asked.borrow_mut().push(ask),
            )
        }

        fn tick(&self, marking: &mut Marking, ms: u64) -> (Option<(u32, u32)>, Option<String>) {
            let (shown, line) = marking.tick(
                self.at(ms),
                &|candidate| self.held.borrow().get(&candidate.pid).copied(),
                &|ask| self.asked.borrow_mut().push(ask),
            );
            (
                shown.map(|(candidate, megabytes)| (candidate.pid, megabytes)),
                line,
            )
        }

        fn asked(&self) -> Vec<Ask> {
            self.asked.borrow().clone()
        }
    }

    fn knowing() -> Marking {
        Marking {
            known: true,
            ..Marking::default()
        }
    }

    #[test]
    fn the_extension_shows_its_process_by_holding_memory_for_a_moment() {
        // R101-1's rest: with other extensions' processes around and no popup
        // open, nothing a look sees tells this extension's process apart.
        let marks = Marks::new();
        assert!(decide(&marks.free, Some(NOW_MS), None).is_err());
        let mut marking = knowing();
        // pick 2 is the third amount, 32 MB.
        let line = marks.begin(&mut marking, 0, 2).unwrap();
        assert_eq!(
            line,
            "asked the extension to hold 32 MB for a moment, which shows its process among the browser's 3 renderers"
        );
        assert_eq!(
            marks.asked(),
            [Ask::Mark {
                round: 1,
                megabytes: 32
            }]
        );
        // A round under way is not asked over, and nothing shows yet.
        assert_eq!(marks.begin(&mut marking, 100, 4), None);
        assert_eq!(marks.tick(&mut marking, 200), (None, None));
        // As measured: 32 MB held read as 31.6 MB more from outside.
        marks.hold(8, 60 * MB + 316 * MB / 10);
        assert_eq!(marks.marked(&mut marking, 1, 300), None);
        assert_eq!(marks.asked().last(), Some(&Ask::Unmark { round: 1 }));
        // It has to shrink again before it is taken.
        assert_eq!(marks.tick(&mut marking, 400), (None, None));
        marks.hold(8, 60 * MB + MB / 5);
        assert_eq!(marks.tick(&mut marking, 600), (Some((8, 32)), None));
        assert!(matches!(marking.state, MarkState::Idle));
        assert_eq!(marks.asked().len(), 2);
        // The log says what that meant for the process kept so far: none, as
        // here; the very one; or another extension's that a look had taken,
        // as the page of another extension open in a tab is "the only one in
        // the foreground" to every look.
        let shown = |kept| shown_line(&marks.free[1], 32, kept, NOW_MS);
        assert_eq!(
            shown(Shown::New),
            "keeping process 8 (started 3600 s ago): it grew by 32 MB when the host asked this extension to hold that much, and shrank when it let go"
        );
        assert_eq!(
            shown(Shown::Kept),
            "process 8 is this extension's for sure: it grew by 32 MB when the host asked this extension to hold that much, and shrank when it let go"
        );
        assert_eq!(
            shown(Shown::Instead(9)),
            "keeping process 8 (started 3600 s ago) and no longer process 9, which is another extension's: it grew by 32 MB when the host asked this extension to hold that much, and shrank when it let go"
        );
    }

    #[test]
    fn the_host_asks_until_the_kept_process_is_this_extensions_for_sure() {
        let marks = Marks::new();
        let at = |ms: u64| marks.at(ms);
        // An extension before 0.5.19 is never asked.
        assert!(!Marking::default().due(at(0)));
        let mut marking = knowing();
        // The first round is due at once, whether a look kept a process or
        // none: what a look took is a guess until the extension answers.
        assert!(marking.due(at(0)));
        // Then 2 s, 4 s, 8 s after the round before, as long as none shows.
        assert!(!marking.due(at(1_999)));
        assert!(marking.due(at(2_000)));
        assert!(!marking.due(at(5_999)));
        assert!(marking.due(at(6_000)));
        assert!(marking.due(at(14_000)));
        assert!(marking.due(at(30_000)));
        // And never more than MARK_AGAIN_MAX apart.
        assert!(!marking.due(at(59_999)));
        assert!(marking.due(at(60_000)));
        assert!(!marking.due(at(89_999)));
        assert!(marking.due(at(90_000)));
        // No round begins while one is under way.
        marks.begin(&mut marking, 120_000, 2);
        assert!(!marking.due(at(200_000)));
        marking.state = MarkState::Idle;
        assert!(marking.due(at(200_000)));
        // Nor once the process is known for sure, or the host stopped asking.
        marking.sure = true;
        assert!(!marking.due(at(300_000)));
        assert_eq!(marks.begin(&mut marking, 300_000, 2), None);
        marking.sure = false;
        marking.over = true;
        assert!(!marking.due(at(300_000)));
        // The browser's only renderer, kept already, needs no asking.
        let kept = Some((8, marks.free[1].started));
        assert!(alone(&marks.free[1..2], kept));
        assert!(!alone(&marks.free, kept));
        assert!(!alone(&marks.free[1..2], None));
        assert!(!alone(&marks.free[..1], kept));
        assert!(!alone(&[], kept));
        // A reused process id is another process.
        assert!(!alone(&[candidate(8, false, 5)], kept));
    }

    #[test]
    fn only_an_extension_that_knows_the_question_is_asked() {
        let marks = Marks::new();
        // One before 0.5.19 says nothing of marks with its worker's start.
        let mut old = Marking::default();
        assert_eq!(marks.begin(&mut old, 0, 2), None);
        assert!(marks.asked().is_empty());
        // One renderer alone leaves nothing to tell apart, and one whose
        // memory cannot be read cannot show.
        let mut marking = knowing();
        let one = Marks {
            free: vec![candidate(7, false, 60_000)],
            ..Marks::new()
        };
        assert_eq!(one.begin(&mut marking, 0, 2), None);
        let unread = Marks::new();
        unread.held.borrow_mut().remove(&8);
        unread.held.borrow_mut().remove(&9);
        assert_eq!(unread.begin(&mut marking, 0, 2), None);
        assert!(one.asked().is_empty() && unread.asked().is_empty());
        assert_eq!(marking.rounds, 0);
    }

    #[test]
    fn the_amounts_asked_for_cannot_be_taken_for_one_another() {
        let picked: BTreeSet<u32> = (0..50).map(mark_megabytes).collect();
        assert_eq!(picked, BTreeSet::from(MARK_SIZES));
        for pair in MARK_SIZES.windows(2) {
            assert!(u64::from(pair[0]) + MARK_SLACK_MB < u64::from(pair[1]) - MARK_SLACK_MB);
        }
        // What the extension may hold at most (mark.js MARK_MAX_MB).
        assert!(MARK_SIZES
            .iter()
            .all(|megabytes| (1..=64).contains(megabytes)));
        let before = [(candidate(7, false, 60_000), 50 * MB)];
        let grown = |more: u64, megabytes: u32| {
            grew(&before, &|_| Some(50 * MB + more), megabytes).len() == 1
        };
        assert!(grown(32 * MB, 32) && grown(29 * MB, 32) && grown(35 * MB, 32));
        assert!(!grown(29 * MB - 1, 32) && !grown(35 * MB + 1, 32));
        // Another profile's host asked for the next amount in the same moment.
        assert!(!grown(24 * MB, 32) && !grown(40 * MB, 32) && !grown(0, 32));
        // A process that shrank meanwhile grew by nothing.
        assert!(grew(&before, &|_| Some(10 * MB), 16).is_empty());
        assert!(grew(&before, &|_| None, 16).is_empty());
        assert!(shrank(92 * MB, 60 * MB, 32) && shrank(92 * MB, 69 * MB, 32));
        assert!(!shrank(92 * MB, 71 * MB, 32) && !shrank(92 * MB, 99 * MB, 32));
    }

    #[test]
    fn an_answer_that_shows_no_process_or_two_keeps_none() {
        let marks = Marks::new();
        let mut marking = knowing();
        marks.begin(&mut marking, 0, 2);
        // Two profiles' hosts asked for the same amount in the same moment.
        marks.hold(8, 92 * MB);
        marks.hold(9, 67 * MB);
        assert_eq!(
            marks.marked(&mut marking, 1, 50).unwrap(),
            "the extension held 32 MB and 2 of the browser's 3 renderers grew by that much: none is clearly this one yet"
        );
        assert!(matches!(marking.state, MarkState::Idle));
        assert_eq!(marks.asked().last(), Some(&Ask::Unmark { round: 1 }));
        assert_eq!(marking.unclear, 1);
        // The next look asks again, with another round's number.
        marks.hold(8, 60 * MB);
        marks.hold(9, 35 * MB);
        assert_eq!(marks.begin(&mut marking, 2_000, 0), None);
        assert_eq!(
            marks.asked().last(),
            Some(&Ask::Mark {
                round: 2,
                megabytes: 16
            })
        );
        // An answer to the round before is not this round's.
        assert_eq!(marks.marked(&mut marking, 1, 2_050), None);
        assert!(matches!(marking.state, MarkState::Asked { round: 2, .. }));
        // No process grew: said, as it differs from the last line.
        assert_eq!(
            marks.marked(&mut marking, 2, 2_100).unwrap(),
            "the extension held 16 MB and 0 of the browser's 3 renderers grew by that much: none is clearly this one yet"
        );
        // The same again is not said twice.
        marks.begin(&mut marking, 4_000, 0);
        assert_eq!(marks.marked(&mut marking, 3, 4_100), None);
        assert_eq!(marking.unclear, 3);
    }

    #[test]
    fn a_process_that_does_not_shrink_again_is_not_taken() {
        let marks = Marks::new();
        let mut marking = knowing();
        marks.begin(&mut marking, 0, 2);
        marks.hold(9, 67 * MB);
        assert_eq!(marks.marked(&mut marking, 1, 100), None);
        assert_eq!(marks.tick(&mut marking, 20_099), (None, None));
        assert_eq!(
            marks.tick(&mut marking, 20_100),
            (
                None,
                Some("process 9 grew by 32 MB but did not shrink again within 20 s: not taken for this extension's".to_owned())
            )
        );
        assert!(matches!(marking.state, MarkState::Idle));
        // Or it is gone, or another process by then.
        marks.hold(9, 35 * MB);
        marks.begin(&mut marking, 30_000, 2);
        marks.hold(9, 67 * MB);
        assert_eq!(marks.marked(&mut marking, 2, 30_100), None);
        marks.held.borrow_mut().remove(&9);
        assert_eq!(
            marks.tick(&mut marking, 30_400),
            (
                None,
                Some("process 9 grew by 32 MB and was gone before it shrank again".to_owned())
            )
        );
        assert_eq!(marking.unclear, 2);
    }

    #[test]
    fn a_busy_extension_is_asked_again_for_as_long_as_it_takes() {
        // The extension this is for waits seconds for the CPU: an answer that
        // is late, or none within the time, says nothing against asking.
        let marks = Marks::new();
        let mut marking = knowing();
        marks.begin(&mut marking, 0, 2);
        assert_eq!(marks.tick(&mut marking, 29_999), (None, None));
        assert_eq!(
            marks.tick(&mut marking, 30_000),
            (
                None,
                Some("the extension did not say within 30 s that it holds the memory; the host goes on asking".to_owned())
            )
        );
        // Told to let go all the same: a late answer holds nothing for long.
        assert_eq!(marks.asked().last(), Some(&Ask::Unmark { round: 1 }));
        for round in 2..40_u32 {
            let ms = u64::from(round) * 60_000;
            assert_eq!(marks.begin(&mut marking, ms, 2), None);
            // Said once, not at every round.
            assert_eq!(marks.tick(&mut marking, ms + 30_000), (None, None));
        }
        assert!(!marking.over);
        // A late answer that shows nothing does not count against asking.
        for round in 40..60 {
            let ms = u64::from(round) * 60_000;
            marks.begin(&mut marking, ms, 2);
            marks.marked(&mut marking, round, ms + 5_000);
        }
        assert_eq!(marking.unclear, 0);
        assert!(!marking.over);
        // And when it answers in time, its process shows.
        marks.begin(&mut marking, 4_000_000, 2);
        marks.hold(7, 52 * MB);
        assert_eq!(marks.marked(&mut marking, 60, 4_012_000), None);
        marks.hold(7, 20 * MB);
        assert_eq!(marks.tick(&mut marking, 4_024_000), (Some((7, 32)), None));
    }

    #[test]
    fn quick_answers_that_show_nothing_end_the_asking() {
        // A browser that does not count the memory as measured: the host
        // does not go on asking for nothing.
        let marks = Marks::new();
        let mut marking = knowing();
        let mut last = None;
        for round in 1..=MARK_UNCLEAR {
            let ms = u64::from(round) * 60_000;
            marks.begin(&mut marking, ms, 2);
            assert!(!marking.over);
            last = marks.marked(&mut marking, round, ms + 20);
        }
        assert!(marking.over);
        assert_eq!(
            last.unwrap(),
            "the extension held 32 MB and 0 of the browser's 3 renderers grew by that much: none is clearly this one yet; 8 quick answers showed no process, so the host stops asking"
        );
        let asked = marks.asked().len();
        assert_eq!(marks.begin(&mut marking, 900_000, 2), None);
        assert_eq!(marks.asked().len(), asked);
    }

    #[test]
    fn a_process_that_shows_itself_confirms_or_corrects_what_a_look_took() {
        let marks = Marks::new();
        let shown = &marks.free[1];
        // No look could tell: the one that showed is kept.
        assert_eq!(shown_as(None, shown), Shown::New);
        // A look took that very process, by the popup or the worker's start.
        assert_eq!(shown_as(Some((8, shown.started)), shown), Shown::Kept);
        // A look took another extension's process: one with a page open in
        // a tab is "the only one in the foreground" to every look, while this
        // extension's worker runs in the background.
        assert_eq!(
            shown_as(Some((9, marks.free[2].started)), shown),
            Shown::Instead(9)
        );
        // A reused process id is another process.
        assert_eq!(
            shown_as(Some((8, shown.started + 1)), shown),
            Shown::Instead(8)
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

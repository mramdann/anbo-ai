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

use super::browser_process;
use std::collections::{BTreeSet, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetPriorityClass, GetProcessInformation, OpenProcess,
    ProcessPowerThrottling, SetPriorityClass, SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
};

/// How soon a demotion by the browser is undone.
const INTERVAL: Duration = Duration::from_millis(250);
/// How many times, one interval apart, the host looks for the extension's
/// process after it starts.
const SEARCH_ATTEMPTS: u32 = 8;
/// The most renderers kept at once, as many as the tabs the extension drives.
const MAX_RENDERERS: usize = 128;
/// How soon a named renderer not found yet is looked for again.
const RESCAN: Duration = Duration::from_millis(500);
/// GetExitCodeProcess's answer for a process that still runs.
const STILL_ACTIVE: u32 = 259;

/// A renderer of the browser that hosts extensions, and whether the browser
/// runs it in the foreground right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Candidate {
    pid: u32,
    foreground: bool,
}

/// Stops keeping the processes scheduled when dropped.
pub struct Keeper {
    renderers: mpsc::Sender<Vec<u32>>,
}

impl Keeper {
    /// The renderers of the tabs Anbo drives, by the id the browser gave each.
    /// The list replaces the one before.
    pub fn renderers(&self, ids: Vec<u32>) {
        let _ = self.renderers.send(ids);
    }
}

pub fn keep() -> Keeper {
    let (renderers, named) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("extension-priority".into())
        .spawn(move || run(&named));
    Keeper { renderers }
}

fn run(named: &mpsc::Receiver<Vec<u32>>) {
    let Some(browser) = browser_process::browser_ancestor(std::process::id()) else {
        return;
    };
    // The popup that asked for this connection is still open for a moment,
    // which is what tells this extension's process apart from the others.
    let search_until = Instant::now() + INTERVAL * SEARCH_ATTEMPTS;
    let mut extension = None;
    let mut renderers = Renderers::default();
    loop {
        if extension.is_none() && Instant::now() < search_until {
            extension = choose(&candidates(browser)).and_then(Process::open);
        }
        if let Some(process) = &extension {
            process.keep_normal();
        }
        renderers.keep(browser);
        match named.recv_timeout(INTERVAL) {
            Ok(ids) => renderers.want(ids),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
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
            })
        })
        .collect()
}

/// This extension's process: the only extension process, or the only one in
/// the foreground. Anything else is left to the browser.
fn choose(candidates: &[Candidate]) -> Option<u32> {
    if let [only] = candidates {
        return Some(only.pid);
    }
    let mut foreground = candidates.iter().filter(|candidate| candidate.foreground);
    match (foreground.next(), foreground.next()) {
        (Some(candidate), None) => Some(candidate.pid),
        _ => None,
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

    fn candidate(pid: u32, foreground: bool) -> Candidate {
        Candidate { pid, foreground }
    }

    #[test]
    fn the_only_extension_process_is_this_extension() {
        assert_eq!(choose(&[candidate(7, false)]), Some(7));
        assert_eq!(choose(&[]), None);
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
        assert_eq!(
            choose(&[candidate(7, false), candidate(8, true), candidate(9, false)]),
            Some(8)
        );
        assert_eq!(choose(&[candidate(7, false), candidate(8, false)]), None);
        assert_eq!(choose(&[candidate(7, true), candidate(8, true)]), None);
    }
}

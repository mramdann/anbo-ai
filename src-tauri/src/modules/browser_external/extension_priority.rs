//! Chrome and Edge run an extension's service worker in a background process,
//! at idle priority and with EcoQoS on Windows 11, whenever none of its pages
//! is visible. On a busy machine that process waits seconds for the CPU, every
//! bridge command waits with it, and a command that outlives its deadline
//! costs the tab. The native host lives exactly as long as the connection, so
//! it keeps that one process at normal priority meanwhile.

use super::browser_process;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetPriorityClass, GetProcessInformation, OpenProcess, ProcessPowerThrottling, SetPriorityClass,
    SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
};

/// How soon a demotion by the browser is undone.
const INTERVAL: Duration = Duration::from_millis(250);
/// How many times, one interval apart, the host looks for the extension's
/// process after it starts.
const SEARCH_ATTEMPTS: usize = 8;

/// A renderer of the browser that hosts extensions, and whether the browser
/// runs it in the foreground right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Candidate {
    pid: u32,
    foreground: bool,
}

/// Stops keeping the process scheduled when dropped.
pub struct Keeper {
    _stop: mpsc::Sender<()>,
}

pub fn keep() -> Keeper {
    let (stop, stopped) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("extension-priority".into())
        .spawn(move || run(&stopped));
    Keeper { _stop: stop }
}

/// Waits one interval; false once the keeper was dropped.
fn wait(stopped: &mpsc::Receiver<()>) -> bool {
    matches!(
        stopped.recv_timeout(INTERVAL),
        Err(RecvTimeoutError::Timeout)
    )
}

fn run(stopped: &mpsc::Receiver<()>) {
    let Some(browser) = browser_process::browser_ancestor(std::process::id()) else {
        return;
    };
    // The popup that asked for this connection is still open for a moment,
    // which is what tells this extension's process apart from the others.
    let mut process = None;
    for _ in 0..SEARCH_ATTEMPTS {
        process = choose(&candidates(browser)).and_then(Process::open);
        if process.is_some() || !wait(stopped) {
            break;
        }
    }
    let Some(process) = process else {
        return;
    };
    loop {
        process.keep_normal();
        if !wait(stopped) {
            return;
        }
    }
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
    fn among_several_only_a_single_foreground_one_is_chosen() {
        assert_eq!(
            choose(&[candidate(7, false), candidate(8, true), candidate(9, false)]),
            Some(8)
        );
        assert_eq!(choose(&[candidate(7, false), candidate(8, false)]), None);
        assert_eq!(choose(&[candidate(7, true), candidate(8, true)]), None);
    }
}

//! What Anbo's own processes use, for the usage view: a task manager of
//! Anbo's own, by workspace. Windows' Task Manager groups an app's processes
//! under the app, and on the newest Windows it shows Anbo as one process, so
//! the agents, terminals and browser tabs of every workspace are out of sight.
//! Anbo knows them itself: one snapshot of the machine's processes, the job of
//! each terminal and each language server (everything they started), and the
//! renderers WebView2 names for each tab of Anbo's own browser. The UI maps
//! terminals, tabs and servers to its workspaces.
//!
//! Read only while the usage view or the spaces menu is open, every couple of
//! seconds; nothing is sampled otherwise.

use serde::Serialize;

use crate::modules::browser::usage::{EngineProcess, TabProcesses};
use crate::modules::lsp::{LspProcesses, LspState};
use crate::modules::pty::{PtyState, TerminalProcesses};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// False where Anbo does not read this (systems other than Windows).
    pub supported: bool,
    /// When it was read, in ms since 1970.
    pub at: u64,
    /// Logical processors: a process's cpu is its share of all of them.
    pub cores: u32,
    pub app_pid: u32,
    pub machine: MachineUsage,
    /// Anbo's processes: its own and everything it started.
    pub processes: Vec<ProcessUsage>,
    pub terminals: Vec<TerminalProcesses>,
    pub browser_tabs: Vec<TabProcesses>,
    pub browser_engine: Vec<EngineProcess>,
    pub language_servers: Vec<LspProcesses>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineUsage {
    pub memory_total: u64,
    pub memory_used: u64,
    /// Percent of all processors since the previous read; none on the first.
    pub cpu: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    /// The private working set in bytes: the "Memory" Task Manager shows.
    pub memory: u64,
    /// Percent of all processors since the previous read; none on the first.
    pub cpu: Option<f32>,
}

/// One read of what Anbo's processes use. The main window only.
#[tauri::command]
pub async fn usage_snapshot(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    pty: tauri::State<'_, PtyState>,
    lsp: tauri::State<'_, LspState>,
) -> Result<UsageSnapshot, String> {
    if webview.label() != "main" {
        return Err("only Anbo's main window reads its usage".into());
    }
    let terminals = pty.usage_terminals();
    let language_servers = lsp.usage_servers();
    #[cfg(windows)]
    {
        let browser = sample::browser_usage(&app).await;
        tauri::async_runtime::spawn_blocking(move || {
            sample::snapshot(terminals, language_servers, browser)
        })
        .await
        .map_err(|error| error.to_string())
    }
    // Elsewhere the processes are not read: the terminals and servers come
    // back as they are, and the view says it reads on Windows only.
    #[cfg(not(windows))]
    {
        let _ = &app;
        Ok(UsageSnapshot {
            terminals,
            language_servers,
            ..UsageSnapshot::default()
        })
    }
}

/// Anbo's processes among `processes` (pid, parent pid): the root and every
/// descendant, a child counting only when it did not start before its parent
/// (Windows hands PIDs out again, and a process keeps naming a parent that is
/// gone), and every `known` one (a terminal's or a server's job holds a
/// process even when the parent in between exited).
#[cfg(any(windows, test))]
fn anbo_processes(
    root: u32,
    processes: &[(u32, u32)],
    started: impl Fn(u32) -> Option<u64>,
    known: &std::collections::HashSet<u32>,
) -> Vec<u32> {
    use std::collections::{HashMap, HashSet};
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let present: HashSet<u32> = processes.iter().map(|(pid, _)| *pid).collect();
    for (pid, parent) in processes {
        if pid != parent {
            children.entry(*parent).or_default().push(*pid);
        }
    }
    let mut seen = HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(parent) = queue.pop() {
        let parent_started = started(parent);
        for child in children.get(&parent).into_iter().flatten() {
            if seen.contains(child) {
                continue;
            }
            let older = matches!((parent_started, started(*child)), (Some(p), Some(c)) if c < p);
            if older {
                continue;
            }
            seen.insert(*child);
            queue.push(*child);
        }
    }
    for pid in known {
        if present.contains(pid) {
            seen.insert(*pid);
        }
    }
    let mut out: Vec<u32> = seen
        .into_iter()
        .filter(|pid| present.contains(pid))
        .collect();
    out.sort_unstable();
    out
}

/// A process's share of all processors between two reads, in percent.
#[cfg(any(windows, test))]
fn cpu_percent(cpu_then: u64, cpu_now: u64, elapsed_100ns: u64, cores: u32) -> Option<f32> {
    if elapsed_100ns == 0 || cores == 0 || cpu_now < cpu_then {
        return None;
    }
    let share = (cpu_now - cpu_then) as f64 / (elapsed_100ns as f64 * f64::from(cores)) * 100.0;
    Some(share.clamp(0.0, 100.0) as f32)
}

#[cfg(windows)]
mod sample {
    use super::{
        anbo_processes, cpu_percent, LspProcesses, MachineUsage, ProcessUsage, TerminalProcesses,
        UsageSnapshot,
    };
    use crate::modules::browser::usage::BrowserUsage;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, FILETIME, HANDLE};
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetActiveProcessorCount, GetProcessTimes, GetSystemTimes, OpenProcess,
        ALL_PROCESSOR_GROUPS, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// How long the browser's process list is kept: renderers change with a
    /// navigation, not between two reads.
    const BROWSER_TTL: Duration = Duration::from_secs(4);
    /// A previous read older than this gives no CPU figure.
    const STALE_AFTER: Duration = Duration::from_secs(10);
    /// ProcessConsoleHostProcess: the console host (conhost or OpenConsole)
    /// a console process is attached to. Each terminal has its own.
    const PROCESS_CONSOLE_HOST_PROCESS: u32 = 49;

    #[link(name = "ntdll", kind = "raw-dylib")]
    extern "system" {
        fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            information: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    struct Read {
        started: u64,
        cpu: u64,
        memory: u64,
    }

    struct Previous {
        at: Instant,
        system: Option<(u64, u64, u64)>,
        cpu: HashMap<u32, (u64, u64)>,
    }

    static PREVIOUS: Mutex<Option<Previous>> = Mutex::new(None);
    static BROWSER: Mutex<Option<(Instant, BrowserUsage)>> = Mutex::new(None);

    fn ticks(time: FILETIME) -> u64 {
        (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
    }

    fn read(pid: u32) -> Option<Read> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut started, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if process.is_null() {
                return None;
            }
            let timed =
                GetProcessTimes(process, &mut started, &mut exited, &mut kernel, &mut user) != 0;
            let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
            let measured = K32GetProcessMemoryInfo(
                process,
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            ) != 0;
            CloseHandle(process);
            timed.then(|| Read {
                started: ticks(started),
                cpu: ticks(kernel) + ticks(user),
                memory: if measured {
                    counters.PrivateWorkingSetSize as u64
                } else {
                    0
                },
            })
        }
    }

    /// The console host a terminal's shell is attached to.
    pub(super) fn console_host(shell_pid: u32) -> Option<u32> {
        let mut host: usize = 0;
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, shell_pid);
            if process.is_null() {
                return None;
            }
            let status = NtQueryInformationProcess(
                process,
                PROCESS_CONSOLE_HOST_PROCESS,
                (&mut host as *mut usize).cast(),
                std::mem::size_of::<usize>() as u32,
                std::ptr::null_mut(),
            );
            CloseHandle(process);
            // The low two bits are flags, not part of the id.
            let pid = (host & !3) as u32;
            (status >= 0 && pid != 0).then_some(pid)
        }
    }

    fn machine_memory() -> (u64, u64) {
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) == 0 {
                return (0, 0);
            }
            (
                status.ullTotalPhys,
                status.ullTotalPhys.saturating_sub(status.ullAvailPhys),
            )
        }
    }

    fn system_times() -> Option<(u64, u64, u64)> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut idle, mut kernel, mut user) = (zero, zero, zero);
        (unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0)
            .then(|| (ticks(idle), ticks(kernel), ticks(user)))
    }

    /// The browser's processes by tab, kept a few seconds.
    pub(super) async fn browser_usage(app: &tauri::AppHandle) -> BrowserUsage {
        if let Some(kept) = BROWSER
            .lock()
            .ok()
            .and_then(|kept| kept.clone())
            .filter(|(at, _)| at.elapsed() < BROWSER_TTL)
            .map(|(_, usage)| usage)
        {
            return kept;
        }
        let usage = crate::modules::browser::usage::usage(app).await;
        if let Ok(mut kept) = BROWSER.lock() {
            *kept = Some((Instant::now(), usage.clone()));
        }
        usage
    }

    pub(super) fn snapshot(
        mut terminals: Vec<TerminalProcesses>,
        language_servers: Vec<LspProcesses>,
        browser: BrowserUsage,
    ) -> UsageSnapshot {
        let now = Instant::now();
        let root = std::process::id();
        let cores = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1);
        let all = crate::modules::pty::process_snapshot();
        let names: HashMap<u32, (u32, String)> = all
            .iter()
            .map(|(pid, parent, name)| (*pid, (*parent, name.clone())))
            .collect();
        // Each process is opened once; its start time decides whether a child
        // is really one.
        let reads: std::cell::RefCell<HashMap<u32, Option<Read>>> =
            std::cell::RefCell::new(HashMap::new());
        let started = |pid: u32| -> Option<u64> {
            reads
                .borrow_mut()
                .entry(pid)
                .or_insert_with(|| read(pid))
                .as_ref()
                .map(|read| read.started)
        };
        let known: HashSet<u32> = terminals
            .iter()
            .flat_map(|terminal| terminal.pids.iter().copied())
            .chain(
                language_servers
                    .iter()
                    .flat_map(|server| server.pids.iter().copied()),
            )
            .chain(browser.tabs.iter().flat_map(|tab| tab.pids.iter().copied()))
            .chain(browser.engine.iter().map(|process| process.pid))
            .collect();
        let pairs: Vec<(u32, u32)> = all.iter().map(|(pid, parent, _)| (*pid, *parent)).collect();
        let mut pids = anbo_processes(root, &pairs, started, &known);
        let mut reads = reads.into_inner();
        let ours: HashSet<u32> = pids.iter().copied().collect();
        // Each terminal's console host, when it is one of Anbo's processes.
        for terminal in &mut terminals {
            if let Some(host) = console_host(terminal.shell_pid).filter(|host| ours.contains(host))
            {
                if !terminal.pids.contains(&host) {
                    terminal.pids.push(host);
                }
            }
        }
        pids.sort_unstable();
        // A read from long ago (the view was closed meanwhile) would average
        // the CPU over that whole time: the first read of an opening has none.
        let previous = PREVIOUS
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .filter(|previous| now.duration_since(previous.at) < STALE_AFTER);
        let elapsed = previous.as_ref().map_or(0, |previous| {
            u64::try_from(now.duration_since(previous.at).as_nanos() / 100).unwrap_or(u64::MAX)
        });
        let mut cpu_now: HashMap<u32, (u64, u64)> = HashMap::new();
        let processes: Vec<ProcessUsage> = pids
            .iter()
            .filter_map(|pid| {
                let read = reads.entry(*pid).or_insert_with(|| read(*pid)).as_ref()?;
                cpu_now.insert(*pid, (read.started, read.cpu));
                let cpu = previous
                    .as_ref()
                    .and_then(|previous| previous.cpu.get(pid))
                    .filter(|(started, _)| *started == read.started)
                    .and_then(|(_, then)| cpu_percent(*then, read.cpu, elapsed, cores));
                let (parent_pid, name) = names.get(pid).cloned().unwrap_or_default();
                Some(ProcessUsage {
                    pid: *pid,
                    parent_pid,
                    name,
                    memory: read.memory,
                    cpu,
                })
            })
            .collect();
        let system = system_times();
        let machine_cpu = match (previous.as_ref().and_then(|p| p.system), system) {
            (Some((idle0, kernel0, user0)), Some((idle1, kernel1, user1))) => {
                // Kernel time includes idle time.
                let total = (kernel1 + user1).saturating_sub(kernel0 + user0);
                let idle = idle1.saturating_sub(idle0);
                (total > 0)
                    .then(|| ((total.saturating_sub(idle)) as f64 / total as f64 * 100.0) as f32)
            }
            _ => None,
        };
        if let Ok(mut slot) = PREVIOUS.lock() {
            *slot = Some(Previous {
                at: now,
                system,
                cpu: cpu_now,
            });
        }
        let (memory_total, memory_used) = machine_memory();
        UsageSnapshot {
            supported: true,
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| {
                    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
                }),
            cores,
            app_pid: root,
            machine: MachineUsage {
                memory_total,
                memory_used,
                cpu: machine_cpu,
            },
            processes,
            terminals,
            browser_tabs: browser.tabs,
            browser_engine: browser.engine,
            language_servers,
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    #[test]
    fn a_read_of_this_process_and_its_console_host_works() {
        let snapshot = super::sample::snapshot(Vec::new(), Vec::new(), Default::default());
        assert!(snapshot.supported);
        assert!(snapshot
            .processes
            .iter()
            .any(|process| process.pid == std::process::id()));
        // A second read gives CPU figures.
        let again = super::sample::snapshot(Vec::new(), Vec::new(), Default::default());
        assert!(again.processes.iter().any(|process| process.cpu.is_some()));
        let _ = super::sample::console_host(std::process::id());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn anbos_processes_are_its_tree_and_what_its_jobs_hold() {
        let processes = [
            (1, 0),   // Anbo
            (2, 1),   // WebView2
            (3, 2),   // a renderer
            (4, 1),   // a shell
            (5, 4),   // an agent the shell started
            (6, 99),  // an agent whose shell exited, still in the terminal's job
            (7, 4),   // an older process naming a pid the shell got again
            (8, 500), // another program
        ];
        let started = |pid: u32| {
            Some(match pid {
                7 => 5,
                _ => 100 + u64::from(pid),
            })
        };
        let known = HashSet::from([6, 42]);
        assert_eq!(
            anbo_processes(1, &processes, started, &known),
            vec![1, 2, 3, 4, 5, 6]
        );
        // A start time it cannot read counts the child in.
        assert_eq!(
            anbo_processes(1, &[(1, 0), (2, 1)], |_| None, &HashSet::new()),
            vec![1, 2]
        );
    }

    #[test]
    fn a_process_cpu_is_its_share_of_every_processor() {
        // 0.5 s of CPU in 1 s on 4 processors: 12.5 %.
        assert_eq!(cpu_percent(0, 5_000_000, 10_000_000, 4), Some(12.5));
        assert_eq!(cpu_percent(5, 5, 10_000_000, 4), Some(0.0));
        assert_eq!(cpu_percent(10, 5, 10_000_000, 4), None);
        assert_eq!(cpu_percent(0, 5, 0, 4), None);
        assert_eq!(cpu_percent(0, 50_000_000, 10_000_000, 4), Some(100.0));
    }
}

//! Admission control, not an OOM cure: leave commit headroom before starting
//! more work. Existing processes are never killed and closing remains allowed.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;
const STARTUP_GRACE: Duration = Duration::from_secs(30);
/// A Chrome or Edge renderer has its memory by the time its page loads.
const EXTERNAL_TAB_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug)]
pub(crate) enum Workload {
    Terminal,
    Browser,
    /// A tab an agent opens in Chrome or Edge: no process of Anbo's, and
    /// 50-100 MB of the browser's, which discards its own tabs under pressure.
    ExternalTab,
    Agent,
    OpenCode,
}

impl Workload {
    fn bytes(self) -> u64 {
        match self {
            Self::Terminal => 32 * MIB,
            Self::Browser => 256 * MIB,
            Self::ExternalTab => 128 * MIB,
            Self::Agent => 512 * MIB,
            Self::OpenCode => 1536 * MIB,
        }
    }

    /// The commit a start must leave free. Anbo's own starts keep Windows'
    /// headroom; a Chrome or Edge tab half of it, since on an 8 GB machine the
    /// 871 MiB asked of every agent's open refused most of them for hours.
    fn reserve(self, limit: u64) -> u64 {
        match self {
            Self::ExternalTab => (limit / 40).max(256 * MIB),
            _ => headroom(limit),
        }
    }

    fn grace(self) -> Duration {
        match self {
            Self::ExternalTab => EXTERNAL_TAB_GRACE,
            _ => STARTUP_GRACE,
        }
    }
}

fn headroom(limit: u64) -> u64 {
    (limit / 20).max(512 * MIB)
}

#[derive(Clone, Copy)]
struct Memory {
    limit: u64,
    available: u64,
}

#[derive(Default)]
struct Admissions(Vec<(Instant, u64, Option<u64>)>);

impl Admissions {
    fn check(&mut self, memory: Memory, bytes: u64, now: Instant) -> Result<(), String> {
        self.check_above(memory, headroom(memory.limit), bytes, now)
    }

    fn check_above(
        &mut self,
        memory: Memory,
        reserve: u64,
        bytes: u64,
        now: Instant,
    ) -> Result<(), String> {
        self.0.retain(|(until, _, _)| *until > now);
        let pending = self
            .0
            .iter()
            .fold(0_u64, |sum, (_, n, _)| sum.saturating_add(*n));
        // Commit (RAM + pagefile), not free RAM: Windows may have reclaimable
        // cache while allocations are already failing at the commit limit.
        let needed = reserve.saturating_add(pending).saturating_add(bytes);
        if memory.available < needed {
            return Err(format!(
                "resource_exhausted: Not enough system memory to start more work ({} MiB commit available; {} MiB required including startup headroom). Close unused browser tabs or agents and retry. Existing sessions were not stopped.",
                memory.available / MIB, needed.div_ceil(MIB)
            ));
        }
        Ok(())
    }

    fn release(&mut self, id: u64) {
        self.0.retain(|(_, _, ticket)| *ticket != Some(id));
    }

    /// Whether a refused start would fit once the pending startups hand their
    /// headroom back, by closing or by their grace running out.
    fn fits_without_pending(&self, memory: Memory, reserve: u64, bytes: u64) -> bool {
        !self.0.is_empty() && memory.available >= reserve.saturating_add(bytes)
    }
}

#[cfg(windows)]
fn memory() -> Result<Option<Memory>, String> {
    use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
    let mut info: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
    info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    if unsafe { GetPerformanceInfo(&mut info, info.cb) } == 0 {
        return Err(
            "resource_unavailable: Could not check system memory; retry before starting more work"
                .into(),
        );
    }
    Ok(Some(Memory {
        limit: (info.CommitLimit as u64).saturating_mul(info.PageSize as u64),
        available: (info.CommitLimit.saturating_sub(info.CommitTotal) as u64)
            .saturating_mul(info.PageSize as u64),
    }))
}

#[cfg(not(windows))]
fn memory() -> Result<Option<Memory>, String> {
    // Do not pretend a Windows commit metric is portable.
    Ok(None)
}

static ADMISSIONS: OnceLock<Mutex<Admissions>> = OnceLock::new();
static NEXT_RESERVATION: AtomicU64 = AtomicU64::new(1);

/// A startup reservation owned by a native child, released only after verified
/// close (or a creation failure), and otherwise conservatively expiring at 30s.
pub(crate) struct Reservation(Option<u64>);

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            if let Ok(mut admissions) = ADMISSIONS.get_or_init(Default::default).lock() {
                admissions.release(id);
            }
        }
    }
}

pub(crate) fn reserve(workload: Workload) -> Result<Reservation, String> {
    let mut admissions = ADMISSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "resource guard unavailable".to_string())?;
    let Some(memory) = memory()? else {
        return Ok(Reservation(None));
    };
    let now = Instant::now();
    admissions.check(memory, workload.bytes(), now)?;
    let id = NEXT_RESERVATION
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| "resource reservation ids exhausted".to_string())?;
    admissions
        .0
        .push((now + STARTUP_GRACE, workload.bytes(), Some(id)));
    Ok(Reservation(Some(id)))
}

fn check(workload: Workload, count: u32, admit: bool) -> Result<(), String> {
    if !(1..=4).contains(&count) {
        return Err("invalid resource request count".into());
    }
    let mut admissions = ADMISSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "resource guard unavailable".to_string())?;
    let Some(memory) = memory()? else {
        return Ok(());
    };
    let now = Instant::now();
    let bytes = workload.bytes() * u64::from(count);
    admissions.check(memory, bytes, now)?;
    if admit {
        // Conservative for 30s: concurrent opens cannot all spend the same
        // headroom before their child processes have allocated their heaps.
        admissions.0.push((now + STARTUP_GRACE, bytes, None));
    }
    Ok(())
}

pub(crate) fn admit(workload: Workload) -> Result<(), String> {
    check(workload, 1, true)
}

/// Checks, without reserving, that a start would be admitted, and waits up to
/// `patience` while the only shortfall is headroom other startups still hold.
/// Eight agents opening tabs side by side refused the eighth on reservations
/// the first seven returned seconds later; a real shortage is refused at once.
/// A Chrome or Edge tab, which no child of Anbo's reserves for later, is
/// admitted here, its headroom held while its renderer starts.
/// A shortage also waits while tabs that were closed are still on their way
/// out: on a busy machine their processes kept their memory until the guard
/// refused every new tab (R98-1), and it is back moments after they are
/// helped out.
pub(crate) async fn preflight_patiently(
    workload: Workload,
    patience: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + patience;
    loop {
        let (waiting, for_pending) = {
            let mut admissions = ADMISSIONS
                .get_or_init(Default::default)
                .lock()
                .map_err(|_| "resource guard unavailable".to_string())?;
            let Some(memory) = memory()? else {
                return Ok(());
            };
            let now = Instant::now();
            let reserve = workload.reserve(memory.limit);
            match admissions.check_above(memory, reserve, workload.bytes(), now) {
                Ok(()) => {
                    if matches!(workload, Workload::ExternalTab) {
                        admissions
                            .0
                            .push((now + workload.grace(), workload.bytes(), None));
                    }
                    return Ok(());
                }
                Err(message) => (
                    message,
                    admissions.fits_without_pending(memory, reserve, workload.bytes()),
                ),
            }
        };
        if !for_pending && !closed_tabs_leaving() {
            return Err(waiting);
        }
        if Instant::now() >= deadline {
            return Err(waiting);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Whether processes of closed browser tabs are still on their way out. The
/// look wakes the watch that sees them out, so what they hold is about to
/// come back.
fn closed_tabs_leaving() -> bool {
    #[cfg(windows)]
    {
        crate::modules::browser::host::help_leaving().seen > 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn resource_admit_agent(
    window: tauri::Window,
    agent: String,
    count: u32,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main window may admit agent launches".into());
    }
    check(
        if agent == "opencode" {
            Workload::OpenCode
        } else {
            Workload::Agent
        },
        count,
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_the_recorded_windows_exhaustion_without_allocating_memory() {
        let mut guard = Admissions::default();
        let recorded = Memory {
            limit: 12_883_906_560,
            available: 8_323_072,
        };
        for workload in [
            Workload::Terminal,
            Workload::Browser,
            Workload::ExternalTab,
            Workload::Agent,
            Workload::OpenCode,
        ] {
            assert!(guard
                .check_above(
                    recorded,
                    workload.reserve(recorded.limit),
                    workload.bytes(),
                    Instant::now()
                )
                .unwrap_err()
                .starts_with("resource_exhausted:"));
        }
    }

    #[test]
    fn concurrent_startups_cannot_spend_the_same_headroom() {
        let now = Instant::now();
        let mut guard = Admissions::default();
        let memory = Memory {
            limit: 12 * 1024 * MIB,
            available: 3 * 1024 * MIB,
        };
        assert!(guard.check(memory, Workload::OpenCode.bytes(), now).is_ok());
        guard
            .0
            .push((now + STARTUP_GRACE, Workload::OpenCode.bytes(), None));
        assert!(guard
            .check(memory, Workload::OpenCode.bytes(), now)
            .is_err());
        assert!(guard
            .check(memory, Workload::OpenCode.bytes(), now + STARTUP_GRACE)
            .is_ok());
    }

    #[test]
    fn allows_light_work_but_not_a_heavy_launch_near_the_limit() {
        let mut guard = Admissions::default();
        let memory = Memory {
            limit: 8 * 1024 * MIB,
            available: 1024 * MIB,
        };
        assert!(guard
            .check(memory, Workload::Terminal.bytes(), Instant::now())
            .is_ok());
        assert!(guard
            .check(memory, Workload::OpenCode.bytes(), Instant::now())
            .is_err());
    }

    #[test]
    fn closed_children_release_only_their_own_pending_reservation() {
        let now = Instant::now();
        let memory = Memory {
            limit: 8 * 1024 * MIB,
            available: 1024 * MIB,
        };
        let bytes = Workload::Browser.bytes();
        let mut guard = Admissions::default();
        for id in 1..100 {
            assert!(guard.check(memory, bytes, now).is_ok());
            guard.0.push((now + STARTUP_GRACE, bytes, Some(id)));
            guard.release(id + 1);
            assert_eq!(guard.0.len(), 1);
            guard.release(id);
            guard.release(id);
            assert!(guard.0.is_empty());
        }
        guard
            .0
            .push((now + STARTUP_GRACE, Workload::Agent.bytes(), None));
        guard.release(99);
        assert!(guard.check(memory, bytes, now).is_err());
    }

    #[test]
    fn a_start_waits_only_for_headroom_other_startups_will_return() {
        let now = Instant::now();
        let bytes = Workload::Browser.bytes();
        let memory = Memory {
            limit: 16 * 1024 * MIB,
            available: 2718 * MIB,
        };
        let mut guard = Admissions::default();
        for id in 1..=7 {
            guard.0.push((now + STARTUP_GRACE, bytes, Some(id)));
        }
        assert!(guard.check(memory, bytes, now).is_err());
        assert!(guard.fits_without_pending(memory, headroom(memory.limit), bytes));
        // Short of memory with nothing pending: waiting would not help.
        let short = Memory {
            limit: 16 * 1024 * MIB,
            available: 900 * MIB,
        };
        assert!(!guard.fits_without_pending(short, headroom(short.limit), bytes));
        assert!(!Admissions::default().fits_without_pending(memory, headroom(memory.limit), bytes));
    }

    #[test]
    fn a_chrome_or_edge_tab_clears_a_lower_bar_than_anbos_own_starts() {
        // Recorded on the r57 soak's 8 GB machine: "810 MiB commit available;
        // 1127 MiB required" for an agent, 871 MiB asked for any tab.
        let memory = Memory {
            limit: 12_883_906_560,
            available: 810 * MIB,
        };
        let now = Instant::now();
        let mut guard = Admissions::default();
        let tab = Workload::ExternalTab;
        assert!(guard
            .check_above(memory, tab.reserve(memory.limit), tab.bytes(), now)
            .is_ok());
        for workload in [Workload::Browser, Workload::Agent] {
            assert!(guard
                .check_above(
                    memory,
                    workload.reserve(memory.limit),
                    workload.bytes(),
                    now
                )
                .is_err());
        }
        // Tabs opened together share the headroom until their renderers start.
        for _ in 0..3 {
            guard.0.push((now + tab.grace(), tab.bytes(), None));
        }
        assert!(guard
            .check_above(memory, tab.reserve(memory.limit), tab.bytes(), now)
            .is_err());
        assert!(guard
            .check_above(
                memory,
                tab.reserve(memory.limit),
                tab.bytes(),
                now + tab.grace()
            )
            .is_ok());
    }

    #[test]
    fn count_is_bounded_before_sampling_or_reserving() {
        assert!(check(Workload::Agent, 0, true).is_err());
        assert!(check(Workload::Agent, u32::MAX, true).is_err());
    }
}

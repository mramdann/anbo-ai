//! Keeps WebView2's message pump on the UI thread from missing its wake-up.
//!
//! WebView2 runs a Chromium message pump on the thread that hosts its
//! webviews, and work for it is announced with `WM_USER + 1` (Chromium's
//! `kMsgHaveWork`) posted to its `Chrome_MessageWindow`. That post fails
//! while the thread's posted-message queue is full (10,000 messages), and
//! the pump then sleeps through the work it was given. Every request the page
//! sent afterwards stayed in WebView2 and none reached Rust, so invokes and
//! the agent tools' replies waited until a WebView2 timer ran the pump about
//! five minutes later (round 63, Dev: 4 of 10 floods of the UI thread's
//! queue; posting that message released all 4 at once, a WM_NULL none).
//!
//! A thread looks at the queue once a second, and every 50 ms while it stays
//! full, by posting a `WM_NULL` to a message-only window of Anbo's own on the
//! UI thread. A refused post opens an episode, and so does a PTY output send
//! that failed: from then on the thread posts the wake-up to WebView2's pump
//! windows every 250 ms, and ends the episode once the queue has taken every
//! post for 2 s and the last wake-up got in. One wake per refusal was not
//! enough: posted while the flood still ran, it was refused too, and 1 of 4
//! floods stayed jammed (round 65). Outside an episode the pump never hears
//! from Anbo: round 64's soak died of heap corruption after this keeper had
//! posted the wake-up every second, 42,000 times in 11.7 hours, and those
//! unasked wake-ups were the first suspect. Each episode is logged when it
//! ends, with how long the queue refused posts.

/// Chromium's `kMsgHaveWork`: `WM_USER + 1`, posted to the pump's window.
#[cfg(any(windows, test))]
const HAVE_WORK: u32 = 0x0400 + 1;

#[cfg(windows)]
const PERIOD: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(windows)]
const FULL_RETRY: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(windows)]
const EPISODE_RETRY: std::time::Duration = std::time::Duration::from_millis(250);
/// How long the queue must take every post before an episode ends.
#[cfg(any(windows, test))]
const CALM: std::time::Duration = std::time::Duration::from_secs(2);

/// A post to the UI thread was refused somewhere else since the last look.
#[cfg(windows)]
static REFUSED_ELSEWHERE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tells the keeper that a post to the UI thread failed (a PTY output send),
/// so WebView2's pump gets its wake-up once the queue takes posts again.
pub fn note_refused_post() {
    #[cfg(windows)]
    REFUSED_ELSEWHERE.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// What one post to the probe window found.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Probe {
    Took,
    Full,
    /// The probe window cannot take posts at all.
    Gone,
}

/// What the keeper does after a look.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Wait,
    Retry,
    Wake,
}

/// Refused posts and the wake-ups after them.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy)]
struct Episode {
    since: std::time::Instant,
    last_refusal: std::time::Instant,
    wakes: u32,
}

/// An episode that ended, for the log.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
struct Ended {
    /// From the first refusal to the last.
    refused_ms: u128,
    wakes: u32,
}

#[cfg(any(windows, test))]
#[derive(Debug, Default)]
struct Keeper {
    episode: Option<Episode>,
}

#[cfg(any(windows, test))]
impl Keeper {
    /// One look at the queue; a refusal there or elsewhere opens an episode
    /// or makes it last.
    fn look(&mut self, probe: Probe, refused_elsewhere: bool, now: std::time::Instant) -> Step {
        if probe == Probe::Full || refused_elsewhere {
            self.refused(now);
        }
        match (probe, self.episode) {
            (Probe::Full, _) => Step::Retry,
            (_, Some(_)) => Step::Wake,
            (_, None) => Step::Wait,
        }
    }

    fn refused(&mut self, now: std::time::Instant) {
        let episode = self.episode.get_or_insert(Episode {
            since: now,
            last_refusal: now,
            wakes: 0,
        });
        episode.last_refusal = now;
    }

    /// After a wake-up that `woken` of the `found` pump windows took. The
    /// episode ends once the queue has taken every post for `CALM`.
    fn woke(&mut self, found: usize, woken: usize, now: std::time::Instant) -> Option<Ended> {
        if woken < found {
            self.refused(now);
        }
        let episode = self.episode.as_mut()?;
        episode.wakes += 1;
        if now.saturating_duration_since(episode.last_refusal) < CALM {
            return None;
        }
        let ended = Ended {
            refused_ms: episode
                .last_refusal
                .saturating_duration_since(episode.since)
                .as_millis(),
            wakes: episode.wakes,
        };
        self.episode = None;
        Some(ended)
    }

    fn in_episode(&self) -> bool {
        self.episode.is_some()
    }
}

/// Starts the keeper for the calling thread, which must be the UI thread.
#[cfg(windows)]
pub fn keep_awake() {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HWND;

    let thread = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    let process = std::process::id();
    let probe = match probe_window() {
        Ok(window) => window.0 as isize,
        Err(error) => {
            log::warn!("could not make the UI thread's queue probe: {error}");
            return;
        }
    };
    let spawned = std::thread::Builder::new()
        .name("anbo-webview-pump".into())
        .spawn(move || {
            let window = HWND(probe as *mut core::ffi::c_void);
            let mut keeper = Keeper::default();
            loop {
                let looked = probe_queue(window);
                let refused = REFUSED_ELSEWHERE.swap(false, Ordering::Relaxed);
                let pause = match keeper.look(looked, refused, std::time::Instant::now()) {
                    Step::Wait => PERIOD,
                    Step::Retry => FULL_RETRY,
                    Step::Wake => {
                        let (found, woken) = wake_pumps(process, thread);
                        if let Some(ended) = keeper.woke(found, woken, std::time::Instant::now()) {
                            log::warn!(
                                "the UI thread's message queue refused posts for {} ms; woke WebView2's pump {} times",
                                ended.refused_ms,
                                ended.wakes
                            );
                        }
                        if keeper.in_episode() {
                            EPISODE_RETRY
                        } else {
                            PERIOD
                        }
                    }
                };
                std::thread::sleep(pause);
            }
        });
    if let Err(error) = spawned {
        log::warn!("could not start the WebView2 pump keeper: {error}");
    }
}

#[cfg(windows)]
unsafe extern "system" fn probe_procedure(
    window: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(window, message, wparam, lparam)
    }
}

/// A message-only window on the calling thread that ignores what it gets: a
/// post to it fails exactly when that thread's queue is full.
#[cfg(windows)]
fn probe_window() -> windows::core::Result<windows::Win32::Foundation::HWND> {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, RegisterClassW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };

    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(probe_procedure),
            hInstance: instance.into(),
            lpszClassName: windows::core::w!("AnboUiQueueProbe"),
            ..Default::default()
        };
        // A second registration in the process fails; it has the same procedure.
        let _ = RegisterClassW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::w!("AnboUiQueueProbe"),
            windows::core::w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        )
    }
}

/// Posts a `WM_NULL` to `window` to see whether its thread's queue takes it.
#[cfg(windows)]
fn probe_queue(window: windows::Win32::Foundation::HWND) -> Probe {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{ERROR_NOT_ENOUGH_QUOTA, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_NULL};

    match unsafe { PostMessageW(Some(window), WM_NULL, WPARAM(0), LPARAM(0)) } {
        Ok(()) => Probe::Took,
        Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_ENOUGH_QUOTA.0) => Probe::Full,
        Err(_) => Probe::Gone,
    }
}

/// Posts the wake-up to the WebView2 pumps of `thread` in `process`: how many
/// there are, and how many took it.
#[cfg(windows)]
fn wake_pumps(process: u32, thread: u32) -> (usize, usize) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

    let pumps = host_pumps(process, thread);
    let woken = pumps
        .iter()
        .filter(|pump| {
            unsafe { PostMessageW(Some(**pump), HAVE_WORK, WPARAM(0), LPARAM(0)) }.is_ok()
        })
        .count();
    (pumps.len(), woken)
}

/// The message-only windows of Chromium's pump class that `thread` of
/// `process` owns.
#[cfg(windows)]
fn host_pumps(process: u32, thread: u32) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::core::{w, HRESULT, PCWSTR};
    use windows::Win32::Foundation::ERROR_INVALID_WINDOW_HANDLE;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetWindowThreadProcessId, HWND_MESSAGE,
    };

    let mut pumps = Vec::new();
    let mut after = None;
    let mut restarts = 0;
    // Every Chromium-based app in the session has some; the bound only
    // guards against a walk that never ends.
    for _ in 0..4096 {
        let found = unsafe {
            FindWindowExW(
                Some(HWND_MESSAGE),
                after,
                w!("Chrome_MessageWindow"),
                PCWSTR::null(),
            )
        };
        let next = match found {
            Ok(next) if !next.is_invalid() => next,
            // The window to go on from was destroyed during the walk (one of
            // another app's), so walk again from the start.
            Err(error)
                if restarts < 3
                    && error.code() == HRESULT::from_win32(ERROR_INVALID_WINDOW_HANDLE.0) =>
            {
                restarts += 1;
                pumps.clear();
                after = None;
                continue;
            }
            _ => break,
        };
        let mut owner = 0u32;
        let owner_thread = unsafe { GetWindowThreadProcessId(next, Some(&mut owner)) };
        if owner == process && owner_thread == thread {
            pumps.push(next);
        }
        after = Some(next);
    }
    pumps
}

#[cfg(test)]
mod tests {
    use super::{Ended, Keeper, Probe, Step, CALM};
    use std::time::{Duration, Instant};

    #[test]
    fn wakes_the_pump_with_chromiums_have_work_message() {
        assert_eq!(super::HAVE_WORK, 0x0401);
    }

    #[test]
    fn a_queue_that_takes_posts_wakes_nothing() {
        let mut keeper = Keeper::default();
        let now = Instant::now();
        for _ in 0..5 {
            assert_eq!(keeper.look(Probe::Took, false, now), Step::Wait);
        }
        assert!(!keeper.in_episode());
    }

    #[test]
    fn a_refusal_wakes_the_pump_until_the_queue_has_been_calm() {
        let mut keeper = Keeper::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert_eq!(keeper.look(Probe::Full, false, at(0)), Step::Retry);
        assert_eq!(keeper.look(Probe::Full, false, at(50)), Step::Retry);
        // Posts get through again, but the flood may still be running.
        assert_eq!(keeper.look(Probe::Took, false, at(100)), Step::Wake);
        assert_eq!(keeper.woke(1, 1, at(100)), None);
        assert_eq!(keeper.look(Probe::Took, false, at(1_000)), Step::Wake);
        assert_eq!(keeper.woke(1, 1, at(1_000)), None);
        let calm = 50 + CALM.as_millis() as u64;
        assert_eq!(keeper.look(Probe::Took, false, at(calm)), Step::Wake);
        assert_eq!(
            keeper.woke(1, 1, at(calm)),
            Some(Ended {
                refused_ms: 50,
                wakes: 3
            })
        );
        assert_eq!(
            keeper.look(Probe::Took, false, at(calm + 1_000)),
            Step::Wait
        );
    }

    #[test]
    fn a_wake_up_the_queue_refuses_makes_the_episode_last() {
        // Round 65: posted while the flood still ran, a wake-up was refused
        // too ("woke WebView2's pump (0 windows)") and the page stayed jammed.
        let mut keeper = Keeper::default();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert_eq!(keeper.look(Probe::Full, false, at(0)), Step::Retry);
        assert_eq!(keeper.look(Probe::Took, false, at(2_500)), Step::Wake);
        assert_eq!(keeper.woke(1, 0, at(2_500)), None);
        assert_eq!(keeper.look(Probe::Took, false, at(3_000)), Step::Wake);
        assert_eq!(keeper.woke(1, 1, at(3_000)), None);
        assert_eq!(keeper.look(Probe::Took, false, at(4_600)), Step::Wake);
        assert_eq!(
            keeper.woke(1, 1, at(4_600)),
            Some(Ended {
                refused_ms: 2_500,
                wakes: 3
            })
        );
    }

    #[test]
    fn a_send_refused_elsewhere_opens_an_episode() {
        let mut keeper = Keeper::default();
        let start = Instant::now();
        assert_eq!(keeper.look(Probe::Took, true, start), Step::Wake);
        assert_eq!(keeper.woke(1, 1, start), None);
        let calm = start + CALM;
        assert_eq!(keeper.look(Probe::Took, false, calm), Step::Wake);
        assert_eq!(
            keeper.woke(1, 1, calm),
            Some(Ended {
                refused_ms: 0,
                wakes: 2
            })
        );
    }

    #[test]
    fn a_probe_that_cannot_post_wakes_only_in_an_episode() {
        let mut keeper = Keeper::default();
        let now = Instant::now();
        assert_eq!(keeper.look(Probe::Gone, false, now), Step::Wait);
        assert_eq!(keeper.look(Probe::Gone, true, now), Step::Wake);
    }

    #[test]
    fn an_episode_without_pump_windows_still_ends() {
        let mut keeper = Keeper::default();
        let start = Instant::now();
        assert_eq!(keeper.look(Probe::Full, false, start), Step::Retry);
        assert_eq!(keeper.look(Probe::Took, false, start + CALM), Step::Wake);
        assert_eq!(
            keeper.woke(0, 0, start + CALM),
            Some(Ended {
                refused_ms: 0,
                wakes: 1
            })
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        PostThreadMessageW, RegisterClassW, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
        WM_NULL, WM_QUIT, WNDCLASSW,
    };

    /// The windows that got the wake-up, by handle.
    static WOKEN: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    unsafe extern "system" fn note_wakes(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == HAVE_WORK {
            WOKEN.lock().unwrap().push(hwnd.0 as isize);
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    struct PumpWindow {
        thread: u32,
        hwnd: isize,
        stop: Option<mpsc::Sender<()>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl PumpWindow {
        /// A window of WebView2's pump class on a thread of its own, which
        /// dispatches its messages only with `pump`.
        fn start(pump: bool) -> Self {
            Self::start_with(pump, || unsafe {
                let instance = GetModuleHandleW(None).unwrap();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(note_wakes),
                    hInstance: instance.into(),
                    lpszClassName: w!("Chrome_MessageWindow"),
                    ..Default::default()
                };
                // A second registration in the process fails; the first
                // one uses the same window procedure.
                let _ = RegisterClassW(&class);
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("Chrome_MessageWindow"),
                    w!(""),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(instance.into()),
                    None,
                )
                .unwrap()
            })
        }

        /// The keeper's own probe window on a thread of its own.
        fn probe(pump: bool) -> Self {
            Self::start_with(pump, || probe_window().unwrap())
        }

        fn start_with(pump: bool, make: fn() -> HWND) -> Self {
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let worker = std::thread::spawn(move || unsafe {
                let hwnd = make();
                ready_tx
                    .send((GetCurrentThreadId(), hwnd.0 as isize))
                    .unwrap();
                if pump {
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        DispatchMessageW(&message);
                    }
                } else {
                    let _ = stop_rx.recv();
                }
            });
            let (thread, hwnd) = ready_rx.recv().unwrap();
            Self {
                thread,
                hwnd,
                stop: (!pump).then_some(stop_tx),
                worker: Some(worker),
            }
        }

        fn handle(&self) -> HWND {
            HWND(self.hwnd as *mut core::ffi::c_void)
        }

        /// Posts to its window until its thread's queue refuses more.
        fn fill_queue(&self) {
            let mut queued = 0;
            while unsafe { PostMessageW(Some(self.handle()), WM_NULL, WPARAM(0), LPARAM(0)) }
                .is_ok()
            {
                queued += 1;
                assert!(queued <= 100_000, "the queue never filled");
            }
        }
    }

    impl Drop for PumpWindow {
        fn drop(&mut self) {
            match self.stop.take() {
                Some(stop) => {
                    let _ = stop.send(());
                }
                None => unsafe {
                    let _ = PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0));
                },
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[test]
    fn finds_only_the_pumps_of_the_given_thread() {
        let one = PumpWindow::start(true);
        let other = PumpWindow::start(true);
        let found = host_pumps(std::process::id(), one.thread);
        assert_eq!(found, vec![one.handle()]);
        assert!(!found.contains(&other.handle()));
        assert!(host_pumps(std::process::id() + 1, one.thread).is_empty());
    }

    #[test]
    fn wakes_the_pumps_of_the_thread() {
        let window = PumpWindow::start(true);
        assert_eq!(wake_pumps(std::process::id(), window.thread), (1, 1));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !WOKEN.lock().unwrap().contains(&window.hwnd) {
            assert!(Instant::now() < deadline, "the pump never got the wake-up");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn finds_no_pump_on_a_thread_without_one() {
        let thread = unsafe { GetCurrentThreadId() };
        assert_eq!(wake_pumps(std::process::id(), thread), (0, 0));
    }

    #[test]
    fn the_probe_window_takes_posts_on_a_thread_that_pumps() {
        let probe = PumpWindow::probe(true);
        for _ in 0..3 {
            assert_eq!(probe_queue(probe.handle()), Probe::Took);
        }
        // The probe is not one of Chromium's pumps, so it is never woken.
        assert!(host_pumps(std::process::id(), probe.thread).is_empty());
    }

    #[test]
    fn the_probe_says_when_its_threads_queue_is_full() {
        // Measured (round 63): posts to Dev's UI thread failed after 10,000
        // queued messages, and the WebView2 pump lost its wake-up.
        let probe = PumpWindow::probe(false);
        probe.fill_queue();
        assert_eq!(probe_queue(probe.handle()), Probe::Full);
    }

    #[test]
    fn a_destroyed_probe_window_reads_gone() {
        let probe = PumpWindow::probe(true);
        let handle = probe.handle();
        drop(probe);
        // The thread ended, and its windows with it.
        assert_eq!(probe_queue(handle), Probe::Gone);
    }
}

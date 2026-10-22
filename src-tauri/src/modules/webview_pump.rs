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
//! A thread posts the wake-up once a second, and every 50 ms while the queue
//! stays full, so a lost one holds the page's IPC for a second at most. The
//! message only makes the pump look for work it already has. A full queue is
//! logged once it takes posts again, with how long it refused them.

/// Chromium's `kMsgHaveWork`: `WM_USER + 1`, posted to the pump's window.
#[cfg(any(windows, test))]
const HAVE_WORK: u32 = 0x0400 + 1;

#[cfg(windows)]
const PERIOD: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(windows)]
const FULL_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Starts the keeper for the calling thread, which must be the UI thread.
#[cfg(windows)]
pub fn keep_awake() {
    let thread = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    let process = std::process::id();
    let spawned = std::thread::Builder::new()
        .name("anbo-webview-pump".into())
        .spawn(move || {
            let mut full_since: Option<std::time::Instant> = None;
            loop {
                let full = wake(process, thread) == Wake::QueueFull;
                match (full, full_since) {
                    (true, None) => full_since = Some(std::time::Instant::now()),
                    (false, Some(since)) => {
                        log::warn!(
                            "the UI thread's message queue refused posts for {} ms; woke WebView2's pump",
                            since.elapsed().as_millis()
                        );
                        full_since = None;
                    }
                    _ => {}
                }
                std::thread::sleep(if full { FULL_RETRY } else { PERIOD });
            }
        });
    if let Err(error) = spawned {
        log::warn!("could not start the WebView2 pump keeper: {error}");
    }
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
enum Wake {
    Posted,
    QueueFull,
    NoPump,
}

/// Posts the wake-up to the WebView2 pumps of `thread` in `process`.
#[cfg(windows)]
fn wake(process: u32, thread: u32) -> Wake {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{ERROR_NOT_ENOUGH_QUOTA, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

    let mut result = Wake::NoPump;
    for pump in host_pumps(process, thread) {
        match unsafe { PostMessageW(Some(pump), HAVE_WORK, WPARAM(0), LPARAM(0)) } {
            Ok(()) if result == Wake::NoPump => result = Wake::Posted,
            Ok(()) => {}
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_ENOUGH_QUOTA.0) => {
                result = Wake::QueueFull;
            }
            // The window went away in between.
            Err(_) => {}
        }
    }
    result
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
    #[test]
    fn wakes_the_pump_with_chromiums_have_work_message() {
        assert_eq!(super::HAVE_WORK, 0x0401);
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
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let worker = std::thread::spawn(move || unsafe {
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
                let hwnd = CreateWindowExW(
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
                .unwrap();
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
    fn wakes_the_pump_of_the_thread() {
        let window = PumpWindow::start(true);
        assert_eq!(wake(std::process::id(), window.thread), Wake::Posted);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !WOKEN.lock().unwrap().contains(&window.hwnd) {
            assert!(Instant::now() < deadline, "the pump never got the wake-up");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn says_when_the_queue_is_full() {
        // Measured (round 63): posts to Dev's UI thread failed after 10,000
        // queued messages, and the WebView2 pump lost its wake-up.
        let window = PumpWindow::start(false);
        let mut queued = 0;
        while unsafe { PostMessageW(Some(window.handle()), WM_NULL, WPARAM(0), LPARAM(0)) }.is_ok()
        {
            queued += 1;
            assert!(queued <= 100_000, "the queue never filled");
        }
        assert_eq!(wake(std::process::id(), window.thread), Wake::QueueFull);
    }

    #[test]
    fn finds_no_pump_on_a_thread_without_one() {
        let thread = unsafe { GetCurrentThreadId() };
        assert_eq!(wake(std::process::id(), thread), Wake::NoPump);
    }
}

//! Opening the top-level windows a user asks for: Settings and the AnboVoice
//! orb. When one does not appear, the user sees nothing happen and no error,
//! so each step leaves a line in the log: how long a window took to create, a
//! creation that has not returned after a few seconds, and a window Anbo still
//! lists that stays out of sight when shown.

use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Runtime, WebviewWindow};

/// How long creating a window may take before the log says it is stuck. The
/// shell creates windows on its main thread, and a creation that hangs there
/// never returns an error.
const SLOW_BUILD: Duration = Duration::from_secs(5);

/// Creates a window with `build`, noting how long it took, or that it is
/// still running after `SLOW_BUILD`. The caller logs an error in its own
/// words.
pub fn build<R: Runtime>(
    what: &str,
    build: impl FnOnce() -> tauri::Result<WebviewWindow<R>>,
) -> Result<WebviewWindow<R>, String> {
    let name = what.to_owned();
    let watch = watch_slow(SLOW_BUILD, move || {
        log::warn!(
            "[windows] {name} is still being created after {} s",
            SLOW_BUILD.as_secs()
        );
    });
    let started = Instant::now();
    let result = build();
    watch.finish();
    if result.is_ok() {
        log::info!(
            "[windows] {what} created in {} ms",
            started.elapsed().as_millis()
        );
    }
    result.map_err(|error| error.to_string())
}

/// Shows a window Anbo already has. One the shell still lists after its
/// native window went away shows nothing and reports no error, so its
/// visibility is read back.
pub fn show<R: Runtime>(what: &str, window: &WebviewWindow<R>) -> Result<(), String> {
    let shown = window.show().map_err(|error| error.to_string());
    let visible = window.is_visible().map_err(|error| error.to_string());
    if let Some(note) = shown_note(what, &shown, visible) {
        log::warn!("[windows] {note}");
    }
    shown
}

fn shown_note(
    what: &str,
    shown: &Result<(), String>,
    visible: Result<bool, String>,
) -> Option<String> {
    match (shown, visible) {
        (Err(error), _) => Some(format!("{what} would not show: {error}")),
        (Ok(()), Ok(true)) => None,
        (Ok(()), Ok(false)) => Some(format!("{what} is listed but stayed hidden after show")),
        (Ok(()), Err(error)) => Some(format!(
            "{what} is listed but its state cannot be read: {error}"
        )),
    }
}

/// Runs `report` unless the watch is finished within `patience`.
fn watch_slow(patience: Duration, report: impl FnOnce() + Send + 'static) -> SlowWatch {
    let (done, waiting) = mpsc::channel::<()>();
    let thread = std::thread::spawn(move || {
        if matches!(
            waiting.recv_timeout(patience),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            report();
        }
    });
    SlowWatch { done, thread }
}

struct SlowWatch {
    done: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl SlowWatch {
    /// Ends the watch. A report already under way is written first.
    fn finish(self) {
        drop(self.done);
        let _ = self.thread.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_window_listed_but_out_of_sight_is_noted() {
        assert_eq!(shown_note("Settings", &Ok(()), Ok(true)), None);
        assert_eq!(
            shown_note("Settings", &Ok(()), Ok(false)).as_deref(),
            Some("Settings is listed but stayed hidden after show")
        );
        assert!(shown_note("Settings", &Ok(()), Err("gone".into()))
            .is_some_and(|note| note.ends_with("cannot be read: gone")));
        assert_eq!(
            shown_note("Settings", &Err("no window".into()), Ok(false)).as_deref(),
            Some("Settings would not show: no window")
        );
    }

    #[test]
    fn a_creation_that_returns_in_time_reports_nothing() {
        let reported = Arc::new(AtomicBool::new(false));
        let flag = reported.clone();
        watch_slow(Duration::from_secs(30), move || {
            flag.store(true, Ordering::SeqCst)
        })
        .finish();
        assert!(!reported.load(Ordering::SeqCst));
    }

    #[test]
    fn a_creation_still_running_after_its_patience_is_reported() {
        let (sender, receiver) = mpsc::channel();
        let watch = watch_slow(Duration::from_millis(20), move || {
            let _ = sender.send(());
        });
        assert!(receiver.recv_timeout(Duration::from_secs(10)).is_ok());
        watch.finish();
    }
}

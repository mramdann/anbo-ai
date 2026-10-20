//! Tells every webview of a window that the window moved.
//!
//! WebView2 places its own popups (a select's list, tooltips, IME and autofill
//! windows) from the screen position it was last told. wry tells only a
//! webview that fills its window, from a subclass of that window; with several
//! webviews per window (Tauri's `unstable` feature) every webview is a child
//! and none hears of a move. Measured on the orb: its webview put itself at
//! 1780,886 with the window at 1442,842, and a 40,30 move left
//! `window.screenX/Y` where they were.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// How often a drag, which moves the window on every mouse move, tells the
/// webviews at most.
#[cfg(windows)]
const COALESCE: std::time::Duration = std::time::Duration::from_millis(50);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webview-position")
        .on_window_ready(|window| {
            #[cfg(windows)]
            watch(&window);
            #[cfg(not(windows))]
            let _ = window;
        })
        .build()
}

#[cfg(windows)]
fn watch<R: Runtime>(window: &tauri::Window<R>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::{Manager, WindowEvent};

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let pending = Arc::new(AtomicBool::new(false));
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_)) || pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let (app, label, pending) = (app.clone(), label.clone(), pending.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(COALESCE).await;
            pending.store(false, Ordering::Release);
            let Some(window) = app.get_window(&label) else {
                return;
            };
            for webview in window.webviews() {
                let _ = webview.with_webview(|platform| {
                    // SAFETY: the closure runs on the main thread, which owns
                    // the controller, while its webview lives.
                    let _ = unsafe { platform.controller().NotifyParentWindowPositionChanged() };
                });
            }
        });
    });
}

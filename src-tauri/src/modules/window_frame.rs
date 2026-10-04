//! Recomputes each new window's frame before its saved size comes back.
//!
//! On Windows a new window starts with the default, captioned non-client
//! frame: tao answers only a later `WM_NCCALCSIZE` with the thin insets of an
//! undecorated window. The window-state plugin restores the saved size before
//! that happens, and for an undecorated window with a shadow tao's
//! `set_inner_size` adds the frame it measures at that moment. Settings
//! therefore opened one caption height taller than it was saved (30 px at
//! 100%), every time it opened. Forcing the frame change first makes the
//! restore measure the frame the window keeps.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Register before the window-state plugin: plugins see a new window in the
/// order they were registered.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-frame")
        .on_window_ready(|window| {
            #[cfg(windows)]
            refresh_frame(&window);
            #[cfg(not(windows))]
            let _ = window;
        })
        .build()
}

#[cfg(windows)]
fn refresh_frame<R: Runtime>(window: &tauri::Window<R>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
        SWP_NOZORDER,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0 as usize as *mut std::ffi::c_void);
    // The hook runs on the main thread, so the frame is final once this returns.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED
                | SWP_NOACTIVATE
                | SWP_NOMOVE
                | SWP_NOOWNERZORDER
                | SWP_NOSIZE
                | SWP_NOZORDER,
        )
    };
}

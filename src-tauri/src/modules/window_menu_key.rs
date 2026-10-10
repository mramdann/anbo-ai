//! Keeps Alt from putting an Anbo window into Windows' menu loop.
//!
//! Alt pressed and let go on its own (in any webview, which hands the key to
//! its window) makes Windows send `SC_KEYMENU`, and the default answer enters
//! the loop of the window's system menu: nothing shows, yet the shell's event
//! loop stops until the next key, so IPC replies, events and every agent tool
//! that goes through the frontend wait (an MCP call timed out after 5 s).
//! Anbo has no menu bar for Alt to reach, so that keystroke is dropped;
//! Alt+Space still opens the window menu.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// `WM_SYSCOMMAND` and `SC_KEYMENU`, kept here so the rule is testable
/// everywhere.
#[cfg(any(windows, test))]
const WM_SYSCOMMAND: u32 = 0x0112;
#[cfg(any(windows, test))]
const SC_KEYMENU: usize = 0xF100;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-menu-key")
        .on_window_ready(|window| {
            #[cfg(windows)]
            ignore_bare_menu_key(&window);
            #[cfg(not(windows))]
            let _ = window;
        })
        .build()
}

/// A menu key that names no character: Alt alone (or F10). Alt+Space names a
/// space and still opens the window menu.
#[cfg(any(windows, test))]
fn is_bare_menu_key(message: u32, wparam: usize, lparam: isize) -> bool {
    message == WM_SYSCOMMAND && wparam & 0xFFF0 == SC_KEYMENU && lparam == 0
}

#[cfg(windows)]
const SUBCLASS_ID: usize = 0x414E_424F; // "ANBO"

#[cfg(windows)]
fn ignore_bare_menu_key<R: Runtime>(window: &tauri::Window<R>) {
    let Ok(handle) = window.hwnd() else {
        return;
    };
    let raw = handle.0 as isize;
    // A window can only be subclassed from the thread that owns it.
    let _ = window.run_on_main_thread(move || {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::SetWindowSubclass;
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        if !unsafe { SetWindowSubclass(hwnd, Some(menu_key_proc), SUBCLASS_ID, 0) }.as_bool() {
            log::warn!("[windows] Alt could not be kept out of the menu loop of a window");
        }
    });
}

#[cfg(windows)]
unsafe extern "system" fn menu_key_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::WM_NCDESTROY;
    if is_bare_menu_key(message, wparam.0, lparam.0) {
        return LRESULT(0);
    }
    if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(menu_key_proc), SUBCLASS_ID) };
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alt_alone_is_kept_out_of_the_menu_loop() {
        assert!(is_bare_menu_key(WM_SYSCOMMAND, SC_KEYMENU, 0));
        // The low four bits of the command are the system's own.
        assert!(is_bare_menu_key(WM_SYSCOMMAND, SC_KEYMENU | 0x2, 0));
    }

    #[test]
    fn other_menu_keys_and_commands_go_on() {
        // Alt+Space opens the window menu.
        assert!(!is_bare_menu_key(WM_SYSCOMMAND, SC_KEYMENU, 0x20));
        // Close, minimize, restore.
        assert!(!is_bare_menu_key(WM_SYSCOMMAND, 0xF060, 0));
        assert!(!is_bare_menu_key(WM_SYSCOMMAND, 0xF020, 0));
        assert!(!is_bare_menu_key(WM_SYSCOMMAND, 0xF120, 0));
        // WM_KEYDOWN.
        assert!(!is_bare_menu_key(0x0100, SC_KEYMENU, 0));
    }
}

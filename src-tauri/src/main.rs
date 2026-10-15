// Anbo is a desktop GUI; diagnostics are available through the log plugin.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        // Disable macOS press-and-hold character popup, so key repeat works in terminal.
        use objc2::msg_send;
        use objc2_foundation::{ns_string, NSUserDefaults};
        unsafe {
            let defaults = NSUserDefaults::standardUserDefaults();
            let key = ns_string!("ApplePressAndHoldEnabled");
            let _: () = msg_send![&defaults, setBool: false, forKey: key];
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Restore normal Ctrl+C handling, so Ctrl+C stops commands in terminal.
        // Windows passes "ignore Ctrl+C" from parent to child, and Git Bash
        // starts programs with it set, so every shell Anbo opened inherited it.
        use windows_sys::Win32::{Foundation::FALSE, System::Console::SetConsoleCtrlHandler};
        unsafe {
            SetConsoleCtrlHandler(None, FALSE);
        }
    }

    anbo_lib::run()
}

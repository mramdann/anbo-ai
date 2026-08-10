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

    anbo_lib::run()
}

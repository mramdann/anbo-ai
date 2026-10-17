//! A short log of what the native host did, in `host.log` beside it in the
//! bridge's native-host folder. The host has no window, and the browser shows
//! nothing it writes to stderr, so when one of five profiles' extension
//! processes went unkept once (Oct 17 2026), nothing told why. A connection
//! writes about a dozen lines, each appended whole, so the hosts of several
//! profiles share the file. Past LIMIT it moves to host.old.log, which keeps
//! the two newest files.

use std::io::Write;
use std::path::Path;
use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetLocalTime;

/// Where the log moves aside: some hundreds of connections.
const LIMIT: u64 = 256 * 1024;

/// Appends one line, stamped with the local time and this host's process id.
/// A log that cannot be written is left alone: it must never stop the host.
pub(super) fn line(message: &str) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let mut time: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut time) };
    let text = format!("{} host {}: {message}\n", stamp(&time), std::process::id());
    let _ = append(&executable.with_file_name("host.log"), &text);
}

/// The time as Anbo's own log writes it, with milliseconds.
fn stamp(time: &SYSTEMTIME) -> String {
    format!(
        "[{:04}-{:02}-{:02}][{:02}:{:02}:{:02}.{:03}]",
        time.wYear,
        time.wMonth,
        time.wDay,
        time.wHour,
        time.wMinute,
        time.wSecond,
        time.wMilliseconds
    )
}

fn append(path: &Path, text: &str) -> std::io::Result<()> {
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() >= LIMIT) {
        let _ = std::fs::rename(path, path.with_file_name("host.old.log"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_stamped_the_way_anbo_stamps_its_own_log() {
        let time = SYSTEMTIME {
            wYear: 2026,
            wMonth: 10,
            wDayOfWeek: 6,
            wDay: 18,
            wHour: 1,
            wMinute: 2,
            wSecond: 3,
            wMilliseconds: 45,
        };
        assert_eq!(stamp(&time), "[2026-10-18][01:02:03.045]");
    }

    #[test]
    fn the_log_moves_aside_past_its_limit_and_two_files_stay() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("host.log");
        let old = directory.path().join("host.old.log");
        append(&log, "one\n").unwrap();
        append(&log, "two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "one\ntwo\n");
        assert!(!old.exists());

        std::fs::write(&log, vec![b'a'; LIMIT as usize]).unwrap();
        append(&log, "three\n").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "three\n");
        assert_eq!(std::fs::metadata(&old).unwrap().len(), LIMIT);

        std::fs::write(&log, vec![b'b'; LIMIT as usize]).unwrap();
        append(&log, "four\n").unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "four\n");
        assert_eq!(std::fs::read(&old).unwrap(), vec![b'b'; LIMIT as usize]);
    }
}

//! Writes every Rust panic to `panic.log` in Anbo's log folder.
//!
//! A release build aborts on any panic, and a debug build aborts on a failed
//! unsafe-precondition check. Either way Anbo's log just stops: Dev's abort on
//! Oct 20 ("invalid value for `char`") left a message on the dev runner's
//! stderr without a backtrace, and a release build would have left nothing.
//! The default report still goes to stderr first; the hook then appends the
//! time, version, thread, location, message and backtrace to its own file.
//! It writes the file directly instead of through the log plugin: a panic
//! raised while the logger holds its lock would otherwise hang Anbo instead of
//! letting it end.

use std::any::Any;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The file keeps the latest reports; a longer one moves aside once.
const PANIC_LOG_LIMIT: u64 = 1024 * 1024;

pub fn install(log_dir: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let thread = std::thread::current();
        let location = info
            .location()
            .map(ToString::to_string)
            .unwrap_or_else(|| "an unknown location".to_string());
        let report = format_report(
            &utc_timestamp(SystemTime::now()),
            thread.name().unwrap_or("unnamed"),
            &location,
            payload_text(info.payload()),
            &std::backtrace::Backtrace::force_capture().to_string(),
        );
        let _ = std::fs::create_dir_all(&log_dir);
        let _ = append_bounded(&log_dir.join("panic.log"), &report, PANIC_LOG_LIMIT);
    }));
}

fn payload_text(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(a panic payload that is not text)")
}

fn format_report(
    when: &str,
    thread: &str,
    location: &str,
    message: &str,
    backtrace: &str,
) -> String {
    format!(
        "{when} Anbo {}: thread '{thread}' panicked at {location}:\n{message}\nbacktrace:\n{backtrace}\n\n",
        env!("CARGO_PKG_VERSION")
    )
}

fn append_bounded(path: &Path, text: &str, limit: u64) -> std::io::Result<()> {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > limit) {
        let _ = std::fs::rename(path, path.with_extension("old.log"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(text.as_bytes())
}

/// `2026-10-20T02:43:07Z`: Howard Hinnant's civil_from_days on the Unix day.
fn utc_timestamp(now: SystemTime) -> String {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_report_names_the_thread_place_message_and_backtrace() {
        let report = format_report(
            "2026-10-20T02:43:07Z",
            "main",
            "library/core/src/char/methods.rs:243:18",
            "unsafe precondition(s) violated: invalid value for `char`",
            "   0: anbo_lib::run",
        );
        assert!(report.starts_with("2026-10-20T02:43:07Z Anbo "));
        assert!(
            report.contains("thread 'main' panicked at library/core/src/char/methods.rs:243:18:\n")
        );
        assert!(report.contains("invalid value for `char`\nbacktrace:\n   0: anbo_lib::run"));
    }

    #[test]
    fn a_payload_reads_as_text_whether_static_or_owned() {
        let fixed: Box<dyn Any + Send> = Box::new("fixed");
        let owned: Box<dyn Any + Send> = Box::new(String::from("owned"));
        let other: Box<dyn Any + Send> = Box::new(7_u32);
        assert_eq!(payload_text(fixed.as_ref()), "fixed");
        assert_eq!(payload_text(owned.as_ref()), "owned");
        assert_eq!(
            payload_text(other.as_ref()),
            "(a panic payload that is not text)"
        );
    }

    #[test]
    fn utc_timestamps_follow_the_calendar() {
        let at = |seconds: u64| utc_timestamp(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_792_464_187), "2026-10-20T02:43:07Z");
        assert_eq!(at(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn the_panic_log_moves_aside_once_it_is_full() {
        let dir = std::env::temp_dir().join(format!("anbo-panic-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("panic.log");
        append_bounded(&path, "first report\n", 8).unwrap();
        append_bounded(&path, "second report\n", 8).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second report\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("panic.old.log")).unwrap(),
            "first report\n"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

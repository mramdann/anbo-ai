use serde::Deserialize;
use std::time::Duration;

use super::protocol::error_codes;

pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
pub const EMPTY_GRACE: Duration = Duration::from_millis(1_000);
/// How long an initial snapshot waits for a loading indicator to go.
pub const LOADING_PATIENCE: Duration = Duration::from_secs(3);
pub const MAX_RECOVERIES: usize = 3;
pub const PROBE_JS: &str = r#"JSON.stringify({url:location.href,ready:document.readyState === 'interactive' || document.readyState === 'complete',body:!!document.body})"#;

#[derive(Deserialize)]
pub struct DocumentProbe {
    pub url: String,
    ready: bool,
    body: bool,
}

impl DocumentProbe {
    pub fn is_committed(&self, native_url: &str, before: u64, after: Option<u64>) -> bool {
        before > 0
            && after == Some(before)
            && self.ready
            && self.body
            && self.url == native_url
            && url::Url::parse(native_url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
    }
}

pub fn retry_read_error(code: &str, message: &str, changed: bool, recoveries: usize) -> bool {
    if recoveries >= MAX_RECOVERIES {
        return false;
    }
    if !matches!(code, error_codes::CDP_FAILED | error_codes::STALE_REF) {
        return false;
    }
    changed
        || (code == error_codes::CDP_FAILED
            && (message.contains("browser document changed while preparing refs")
                || message.contains("Cannot find context with specified id")
                || message.contains("Execution context was destroyed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(url: &str, ready: bool, body: bool) -> DocumentProbe {
        DocumentProbe {
            url: url.into(),
            ready,
            body,
        }
    }

    #[test]
    fn blank_and_uncommitted_documents_are_never_ready() {
        assert!(!probe("about:blank", true, true).is_committed("about:blank", 1, Some(1)));
        assert!(!probe("https://target.test/", true, true).is_committed(
            "https://target.test/",
            0,
            Some(0)
        ));
    }

    #[test]
    fn native_and_script_documents_must_agree_across_the_probe() {
        let ready = probe("https://target.test/", true, true);
        assert!(ready.is_committed("https://target.test/", 1, Some(1)));
        assert!(!ready.is_committed("https://old.test/", 1, Some(1)));
        assert!(!ready.is_committed("https://target.test/", 1, Some(2)));
        assert!(!ready.is_committed("https://target.test/", 1, None));
        assert!(!probe("https://target.test/", false, true).is_committed(
            "https://target.test/",
            1,
            Some(1)
        ));
        assert!(!probe("https://target.test/", true, false).is_committed(
            "https://target.test/",
            1,
            Some(1)
        ));
    }

    #[test]
    fn redirects_are_checked_against_the_committed_url_not_the_requested_url() {
        let redirected = probe("https://redirect.test/final", true, true);
        assert!(redirected.is_committed("https://redirect.test/final", 2, Some(2)));
    }

    #[test]
    fn access_denial_needs_independent_navigation_evidence() {
        assert!(!retry_read_error(
            error_codes::CDP_FAILED,
            "Access is denied",
            false,
            0
        ));
        assert!(retry_read_error(
            error_codes::CDP_FAILED,
            "Access is denied",
            true,
            0
        ));
        assert!(!retry_read_error(
            error_codes::INVALID_REQUEST,
            "invalid locator",
            true,
            0
        ));
        assert!(!retry_read_error(
            error_codes::TAB_NOT_FOUND,
            "closed",
            true,
            0
        ));
        assert!(!retry_read_error(error_codes::TIMEOUT, "deadline", true, 0));
        assert!(!retry_read_error(
            error_codes::CDP_FAILED,
            "script exception",
            false,
            0
        ));
        assert!(!retry_read_error(
            error_codes::STALE_REF,
            "scan superseded",
            false,
            0
        ));
    }

    #[test]
    fn known_context_transitions_have_a_strict_recovery_limit() {
        for message in [
            "browser document changed while preparing refs",
            "Cannot find context with specified id",
            "Execution context was destroyed",
        ] {
            assert!(retry_read_error(error_codes::CDP_FAILED, message, false, 0));
            assert!(!retry_read_error(
                error_codes::CDP_FAILED,
                message,
                true,
                MAX_RECOVERIES
            ));
        }
    }
}

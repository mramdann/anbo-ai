#[cfg(any(windows, test))]
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};

#[cfg(any(windows, test))]
const QUIET_WINDOW: Duration = Duration::from_millis(500);
#[cfg(any(windows, test))]
const MAX_PENDING: usize = 2048;

#[cfg(any(windows, test))]
pub struct NetworkState(Mutex<Tracker>);

#[cfg(any(windows, test))]
struct Tracker {
    pending: HashSet<String>,
    last_activity: Instant,
    enabled: bool,
    failure: Option<&'static str>,
}

#[cfg(any(windows, test))]
impl Default for NetworkState {
    fn default() -> Self {
        Self(Mutex::new(Tracker {
            pending: HashSet::new(),
            last_activity: Instant::now(),
            enabled: false,
            failure: None,
        }))
    }
}

#[cfg(any(windows, test))]
impl Tracker {
    fn event(&mut self, started: bool, json: &str, now: Instant) {
        if self.failure.is_some() {
            return;
        }
        #[derive(serde::Deserialize)]
        struct Request<'a> {
            #[serde(rename = "requestId", borrow)]
            id: std::borrow::Cow<'a, str>,
        }
        if json.len() > 64 * 1024 {
            self.failure = Some("network event exceeded its size limit");
            self.pending.clear();
            return;
        }
        let Ok(request) = serde_json::from_str::<Request<'_>>(json) else {
            self.failure = Some("network event could not be decoded");
            self.pending.clear();
            return;
        };
        if request.id.is_empty() || request.id.len() > 256 {
            self.failure = Some("network request identifier exceeded its limit");
            self.pending.clear();
            return;
        }
        self.last_activity = now;
        if started {
            if self.pending.len() >= MAX_PENDING && !self.pending.contains(request.id.as_ref()) {
                self.failure = Some("too many concurrent network requests to verify idle");
                self.pending.clear();
            } else {
                self.pending.insert(request.id.into_owned());
            }
        } else {
            self.pending.remove(request.id.as_ref());
        }
    }

    fn idle(&self, now: Instant) -> Result<bool, String> {
        if let Some(reason) = self.failure {
            return Err(reason.to_string());
        }
        if !self.enabled {
            return Err("native network observation is unavailable; reopen the tab".into());
        }
        Ok(self.pending.is_empty()
            && now.saturating_duration_since(self.last_activity) >= QUIET_WINDOW)
    }
}

pub fn is_idle(tab_id: i64) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let state = crate::modules::browser::embed::active_network(tab_id)
            .ok_or_else(|| "browser network state is unavailable".to_string())?;
        let tracker = state
            .0
            .lock()
            .map_err(|_| "browser network state is unavailable".to_string())?;
        tracker.idle(Instant::now())
    }
    #[cfg(not(windows))]
    {
        let _ = tab_id;
        Err("native network observation is only supported on Windows".into())
    }
}

#[cfg(windows)]
pub async fn install(webview: &tauri::Webview, state: std::sync::Arc<NetworkState>) {
    use webview2_com::{take_pwstr, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{PCWSTR, PWSTR};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let callback_state = state.clone();
    let registration = webview.with_webview(move |platform| {
        if sender.is_closed() {
            return;
        }
        let result = (|| -> Result<(), String> {
            let core =
                unsafe { platform.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
            for (name, started) in [
                ("Network.requestWillBeSent", true),
                ("Network.loadingFinished", false),
                ("Network.loadingFailed", false),
            ] {
                let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                let receiver =
                    unsafe { core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr())) }
                        .map_err(|e| e.to_string())?;
                let event_state = callback_state.clone();
                let handler =
                    DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Ok(mut tracker) = event_state.0.lock() else {
                            return Ok(());
                        };
                        if tracker.failure.is_some() {
                            return Ok(());
                        }
                        let Some(args) = args else {
                            tracker.failure = Some("network event was missing");
                            return Ok(());
                        };
                        let mut payload = PWSTR::null();
                        if unsafe { args.ParameterObjectAsJson(&mut payload) }.is_err() {
                            tracker.failure = Some("network event was unavailable");
                            return Ok(());
                        }
                        tracker.event(started, &take_pwstr(payload), Instant::now());
                        Ok(())
                    }));
                let mut token = 0;
                unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        let _ = sender.send(result);
    });
    let registered = registration.is_ok()
        && matches!(
            tokio::time::timeout(Duration::from_secs(2), receiver).await,
            Ok(Ok(Ok(())))
        );
    let enabled = registered
        && super::cdp::call_devtools_protocol_method(
            webview,
            "Network.enable",
            r#"{"maxTotalBufferSize":1,"maxResourceBufferSize":1,"maxPostDataSize":0}"#,
            Duration::from_secs(2),
        )
        .await
        .is_ok();
    if let Ok(mut tracker) = state.0.lock() {
        tracker.enabled = enabled;
        if !enabled {
            tracker.failure =
                Some("native network observer could not be installed; reopen the tab");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_requires_complete_requests_and_a_continuous_quiet_window() {
        let state = NetworkState::default();
        let mut tracker = state.0.lock().unwrap();
        let start = tracker.last_activity;
        assert!(tracker.idle(start + QUIET_WINDOW).is_err());
        tracker.enabled = true;
        tracker.event(true, r#"{"requestId":"fetch"}"#, start);
        assert!(!tracker.idle(start + Duration::from_secs(10)).unwrap());
        tracker.event(
            true,
            r#"{"requestId":"fetch","redirectResponse":{}}"#,
            start,
        );
        assert_eq!(tracker.pending.len(), 1);
        tracker.event(
            false,
            r#"{"requestId":"fetch"}"#,
            start + Duration::from_secs(10),
        );
        assert!(!tracker.idle(start + Duration::from_millis(10499)).unwrap());
        assert!(tracker.idle(start + Duration::from_millis(10500)).unwrap());
        tracker.event(
            true,
            r#"{"requestId":"xhr"}"#,
            start + Duration::from_secs(11),
        );
        assert!(!tracker.idle(start + Duration::from_secs(12)).unwrap());
        tracker.event(
            false,
            r#"{"requestId":"xhr","canceled":true}"#,
            start + Duration::from_secs(12),
        );
        assert!(tracker.idle(start + Duration::from_millis(12500)).unwrap());
    }

    #[test]
    fn overflow_and_malformed_events_fail_closed_without_retaining_payloads() {
        for payload in [
            "invalid".to_string(),
            " ".repeat(65537),
            format!(r#"{{"requestId":"{}"}}"#, "x".repeat(257)),
        ] {
            let state = NetworkState::default();
            let mut tracker = state.0.lock().unwrap();
            tracker.enabled = true;
            tracker.event(true, &payload, Instant::now());
            assert!(tracker.idle(Instant::now() + QUIET_WINDOW).is_err());
            assert!(tracker.pending.is_empty());
        }
        let state = NetworkState::default();
        let mut tracker = state.0.lock().unwrap();
        tracker.enabled = true;
        for id in 0..=MAX_PENDING {
            tracker.event(true, &format!(r#"{{"requestId":"{id}"}}"#), Instant::now());
        }
        assert!(tracker.failure.is_some());
        assert!(tracker.pending.is_empty());
    }
}

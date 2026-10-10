#[cfg(any(windows, test))]
use std::{
    borrow::Cow,
    collections::{HashSet, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

#[cfg(any(windows, test))]
const QUIET_WINDOW: Duration = Duration::from_millis(500);
#[cfg(any(windows, test))]
const MAX_PENDING: usize = 2048;
/// The most requests a tab keeps for browser_network_requests, and the
/// longest URL kept for one (a data: URL can run to megabytes).
#[cfg(any(windows, test))]
const MAX_RECORDS: usize = 200;
#[cfg(any(windows, test))]
const MAX_URL_CHARS: usize = 512;
/// A larger event is not read for the list: an initiator's stack trace can
/// make a request's event that big, and the idle tracker has its own limit.
#[cfg(any(windows, test))]
const MAX_RECORD_EVENT: usize = 256 * 1024;

/// The network events the observer takes.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkEvent {
    Started,
    Response,
    Finished,
    Failed,
}

#[cfg(any(windows, test))]
impl NetworkEvent {
    /// The idle tracker's view: a request began or ended. A response does
    /// neither, so taking it for the list leaves idle detection as it was.
    fn started(self) -> Option<bool> {
        match self {
            Self::Started => Some(true),
            Self::Finished | Self::Failed => Some(false),
            Self::Response => None,
        }
    }
}

/// One request a tab made, for browser_network_requests.
#[cfg(any(windows, test))]
#[derive(Clone, Debug, serde::Serialize)]
struct RequestRecord {
    #[serde(skip)]
    id: String,
    method: String,
    url: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip)]
    started: Instant,
    /// The browser's clock when the request was sent (CDP seconds).
    #[serde(skip)]
    sent: Option<f64>,
}

#[cfg(any(windows, test))]
pub struct NetworkState(Mutex<Tracker>);

#[cfg(windows)]
impl NetworkState {
    pub fn external_enabled(&self, enabled: bool) {
        if let Ok(mut tracker) = self.0.lock() {
            tracker.enabled = enabled;
            tracker.external = true;
        }
    }

    /// An external tab's main frame navigated: its list now holds a page
    /// load of its own.
    pub fn external_navigated(&self) {
        if let Ok(mut tracker) = self.0.lock() {
            tracker.navigated = true;
        }
    }

    /// One network event an external tab's extension passed on; from
    /// extension 0.5.4 it says what the request was, for the list as well.
    pub fn external_event(&self, method: &str, payload: &str) {
        let kind = match method {
            "Network.requestWillBeSent" => NetworkEvent::Started,
            "Network.responseReceived" => NetworkEvent::Response,
            "Network.loadingFinished" => NetworkEvent::Finished,
            "Network.loadingFailed" => NetworkEvent::Failed,
            _ => return,
        };
        if let Ok(mut tracker) = self.0.lock() {
            let now = Instant::now();
            tracker.record(kind, payload, now);
            if let Some(started) = kind.started() {
                tracker.event(started, payload, now);
            }
        }
    }
}

#[cfg(any(windows, test))]
struct Tracker {
    pending: HashSet<String>,
    last_activity: Instant,
    enabled: bool,
    failure: Option<&'static str>,
    records: VecDeque<RequestRecord>,
    dropped: usize,
    /// Requests that started without saying what they were.
    unlisted: usize,
    /// A Chrome or Edge tab: Anbo connects to it once its page committed, so
    /// its list starts after that load unless the page navigates again.
    external: bool,
    navigated: bool,
}

#[cfg(any(windows, test))]
impl Default for NetworkState {
    fn default() -> Self {
        Self(Mutex::new(Tracker {
            pending: HashSet::new(),
            last_activity: Instant::now(),
            enabled: false,
            failure: None,
            records: VecDeque::new(),
            dropped: 0,
            unlisted: 0,
            external: false,
            navigated: false,
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

    /// Keeps a request for the list. Kept apart from the idle tracking: a
    /// request this cannot read is left out of the list, never a reason to
    /// stop telling when the network is quiet, and the list goes on after
    /// that tracking gave up.
    fn record(&mut self, kind: NetworkEvent, json: &str, now: Instant) {
        #[derive(serde::Deserialize)]
        struct Event<'a> {
            #[serde(rename = "requestId", borrow)]
            id: Cow<'a, str>,
            #[serde(default, borrow)]
            request: Option<Request<'a>>,
            #[serde(default)]
            response: Option<Response>,
            #[serde(rename = "redirectResponse", default)]
            redirect: Option<Response>,
            #[serde(rename = "type", default, borrow)]
            kind: Option<Cow<'a, str>>,
            #[serde(rename = "encodedDataLength", default)]
            size: Option<f64>,
            #[serde(rename = "errorText", default, borrow)]
            error: Option<Cow<'a, str>>,
            #[serde(default)]
            canceled: bool,
            #[serde(default)]
            timestamp: Option<f64>,
        }
        #[derive(serde::Deserialize)]
        struct Request<'a> {
            #[serde(borrow)]
            url: Cow<'a, str>,
            #[serde(borrow)]
            method: Cow<'a, str>,
        }
        #[derive(serde::Deserialize)]
        struct Response {
            status: u16,
        }
        if json.len() > MAX_RECORD_EVENT {
            return;
        }
        let Ok(event) = serde_json::from_str::<Event<'_>>(json) else {
            return;
        };
        // The browser's own clock where the event has one: events reach Anbo
        // late, a Chrome or Edge tab's in bursts.
        let timestamp = event.timestamp;
        let elapsed = |record: &RequestRecord| match (record.sent, timestamp) {
            (Some(sent), Some(at)) => Some(((at - sent) * 1000.0).round().max(0.0) as u64),
            _ => Some(now.saturating_duration_since(record.started).as_millis() as u64),
        };
        let latest = self
            .records
            .iter_mut()
            .rev()
            .find(|record| record.id == event.id);
        match kind {
            NetworkEvent::Started => {
                // A Chrome or Edge extension before 0.5.4 passes on only
                // the id.
                let Some(request) = event.request else {
                    self.unlisted += 1;
                    return;
                };
                if let (Some(previous), Some(redirect)) = (latest, event.redirect) {
                    previous.status = Some(redirect.status);
                    previous.ms = elapsed(previous);
                }
                if self.records.len() >= MAX_RECORDS {
                    self.records.pop_front();
                    self.dropped += 1;
                }
                let mut url: String = request.url.chars().take(MAX_URL_CHARS).collect();
                if url.len() < request.url.len() {
                    url.push_str("...");
                }
                self.records.push_back(RequestRecord {
                    id: event.id.into_owned(),
                    method: request.method.into_owned(),
                    url,
                    kind: event.kind.map(Cow::into_owned),
                    status: None,
                    size: None,
                    ms: None,
                    error: None,
                    started: now,
                    sent: timestamp,
                });
            }
            NetworkEvent::Response => {
                if let (Some(record), Some(response)) = (latest, event.response) {
                    record.status = Some(response.status);
                }
            }
            NetworkEvent::Finished => {
                if let Some(record) = latest {
                    record.size = event.size.map(|size| size.max(0.0) as u64);
                    record.ms = elapsed(record);
                }
            }
            NetworkEvent::Failed => {
                if let Some(record) = latest {
                    record.error = Some(match event.error {
                        Some(error) if !error.is_empty() => error.chars().take(200).collect(),
                        _ if event.canceled => "canceled".to_string(),
                        _ => "failed".to_string(),
                    });
                    record.ms = elapsed(record);
                }
            }
        }
    }

    /// The list browser_network_requests answers with: the newest `limit`
    /// requests whose URL holds `filter` (any case), oldest first.
    fn listed(&self, filter: Option<&str>, limit: usize) -> serde_json::Value {
        let filter = filter.map(str::to_lowercase);
        let matching: Vec<&RequestRecord> = self
            .records
            .iter()
            .filter(|record| {
                filter
                    .as_deref()
                    .is_none_or(|filter| record.url.to_lowercase().contains(filter))
            })
            .collect();
        let shown = &matching[matching.len().saturating_sub(limit)..];
        let mut listed = serde_json::json!({
            "requests": shown,
            "matching": matching.len(),
            "dropped": self.dropped,
        });
        if self.unlisted > 0 {
            listed["unlisted"] = self.unlisted.into();
            listed["note"] = format!(
                "{} requests were not listed: this profile runs Anbo Browser Bridge older than 0.5.4, which does not say what requests are; reload it at chrome://extensions or edge://extensions",
                self.unlisted
            )
            .into();
        } else if self.external && !self.navigated {
            listed["note"] = "Anbo connected to this Chrome or Edge tab after its page loaded, so that load's requests are not listed; browser_reload lists them".into();
        }
        listed
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
            .or_else(|| {
                crate::modules::browser_external::get_target(tab_id).map(|target| target.network)
            })
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

/// browser_network_requests for a browser tab, Anbo's own or a Chrome or Edge
/// one (whose extension passes on what its requests are from 0.5.4).
pub fn requests(
    tab_id: i64,
    filter: Option<&str>,
    limit: usize,
) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let state = crate::modules::browser::embed::active_network(tab_id)
            .or_else(|| {
                crate::modules::browser_external::get_target(tab_id).map(|target| target.network)
            })
            .ok_or_else(|| "browser network state is unavailable".to_string())?;
        let tracker = state
            .0
            .lock()
            .map_err(|_| "browser network state is unavailable".to_string())?;
        Ok(tracker.listed(filter, limit))
    }
    #[cfg(not(windows))]
    {
        let _ = (tab_id, filter, limit);
        Err("network requests are only recorded on Windows".into())
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
            for (name, kind) in [
                ("Network.requestWillBeSent", NetworkEvent::Started),
                ("Network.responseReceived", NetworkEvent::Response),
                ("Network.loadingFinished", NetworkEvent::Finished),
                ("Network.loadingFailed", NetworkEvent::Failed),
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
                        // Only the events idle detection counts can fail it;
                        // a response is there for the request list alone.
                        let counted = kind.started();
                        let Some(args) = args else {
                            if counted.is_some() {
                                tracker.failure.get_or_insert("network event was missing");
                            }
                            return Ok(());
                        };
                        let mut payload = PWSTR::null();
                        if unsafe { args.ParameterObjectAsJson(&mut payload) }.is_err() {
                            if counted.is_some() {
                                tracker
                                    .failure
                                    .get_or_insert("network event was unavailable");
                            }
                            return Ok(());
                        }
                        let payload = take_pwstr(payload);
                        let now = Instant::now();
                        tracker.record(kind, &payload, now);
                        if let Some(started) = counted {
                            tracker.event(started, &payload, now);
                        }
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
            &webview.clone().into(),
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
    fn the_request_list_keeps_what_each_request_did() {
        let state = NetworkState::default();
        let mut tracker = state.0.lock().unwrap();
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let started = |id: &str, url: &str| {
            format!(
                r#"{{"requestId":"{id}","request":{{"url":"{url}","method":"GET"}},"type":"Fetch"}}"#
            )
        };
        tracker.record(
            NetworkEvent::Started,
            &started("a", "https://x.test/api"),
            at(0),
        );
        tracker.record(
            NetworkEvent::Response,
            r#"{"requestId":"a","response":{"status":404}}"#,
            at(30),
        );
        tracker.record(
            NetworkEvent::Finished,
            r#"{"requestId":"a","encodedDataLength":512.0}"#,
            at(40),
        );
        // A redirect closes the first hop and starts the next.
        tracker.record(
            NetworkEvent::Started,
            &started("b", "https://x.test/old"),
            at(50),
        );
        tracker.record(
            NetworkEvent::Started,
            r#"{"requestId":"b","request":{"url":"https://x.test/new","method":"GET"},"redirectResponse":{"status":301}}"#,
            at(60),
        );
        tracker.record(
            NetworkEvent::Failed,
            r#"{"requestId":"b","errorText":"net::ERR_CONNECTION_REFUSED"}"#,
            at(70),
        );
        tracker.record(
            NetworkEvent::Started,
            &started("c", "https://x.test/slow"),
            at(80),
        );
        tracker.record(
            NetworkEvent::Failed,
            r#"{"requestId":"c","errorText":"","canceled":true}"#,
            at(90),
        );
        // An old extension's event carries only the id: nothing to list,
        // and the list says so.
        tracker.record(NetworkEvent::Started, r#"{"requestId":"d"}"#, at(100));
        let listed = tracker.listed(None, 50);
        assert_eq!(listed["matching"], 4);
        assert_eq!(listed["unlisted"], 1);
        assert!(listed["note"]
            .as_str()
            .unwrap()
            .contains("older than 0.5.4"));
        let requests = listed["requests"].as_array().unwrap();
        assert_eq!(requests[0]["url"], "https://x.test/api");
        assert_eq!(requests[0]["status"], 404);
        assert_eq!(requests[0]["size"], 512);
        assert_eq!(requests[0]["ms"], 40);
        assert_eq!(requests[0]["type"], "Fetch");
        assert_eq!(requests[1]["status"], 301);
        assert_eq!(requests[2]["url"], "https://x.test/new");
        assert_eq!(requests[2]["error"], "net::ERR_CONNECTION_REFUSED");
        assert_eq!(requests[3]["error"], "canceled");
        assert!(requests[3].get("status").is_none());
        // A filter (any case) and a limit keep the newest matches.
        let listed = tracker.listed(Some("X.TEST/N"), 50);
        assert_eq!(listed["matching"], 1);
        assert_eq!(
            tracker.listed(None, 1)["requests"][0]["url"],
            "https://x.test/slow"
        );
        // A response the list cannot read never fails idle detection.
        tracker.record(
            NetworkEvent::Response,
            &" ".repeat(MAX_RECORD_EVENT + 1),
            at(110),
        );
        tracker.record(NetworkEvent::Response, "not json", at(120));
        assert!(tracker.failure.is_none());
        assert_eq!(NetworkEvent::Response.started(), None);
    }

    #[test]
    fn a_request_is_timed_by_the_browser_clock_when_its_events_carry_it() {
        let state = NetworkState::default();
        let mut tracker = state.0.lock().unwrap();
        let now = Instant::now();
        // Both events arrive at once, as a Chrome or Edge tab's often do.
        tracker.record(
            NetworkEvent::Started,
            r#"{"requestId":"a","request":{"url":"https://x.test/slow","method":"GET"},"timestamp":100.25}"#,
            now,
        );
        tracker.record(
            NetworkEvent::Failed,
            r#"{"requestId":"a","errorText":"net::ERR_ABORTED","timestamp":100.4497}"#,
            now,
        );
        // A redirect hop ends when the next one is sent.
        tracker.record(
            NetworkEvent::Started,
            r#"{"requestId":"b","request":{"url":"https://x.test/old","method":"GET"},"timestamp":101.0}"#,
            now,
        );
        tracker.record(
            NetworkEvent::Started,
            r#"{"requestId":"b","request":{"url":"https://x.test/new","method":"GET"},"redirectResponse":{"status":302},"timestamp":101.012}"#,
            now,
        );
        tracker.record(
            NetworkEvent::Finished,
            r#"{"requestId":"b","encodedDataLength":10,"timestamp":101.05}"#,
            now,
        );
        let listed = tracker.listed(None, 50);
        assert_eq!(listed["requests"][0]["ms"], 200);
        assert_eq!(listed["requests"][1]["ms"], 12);
        assert_eq!(listed["requests"][2]["ms"], 38);
    }

    #[cfg(windows)]
    #[test]
    fn an_external_tab_lists_its_requests_from_when_anbo_connected() {
        let state = NetworkState::default();
        state.external_enabled(true);
        state.external_event(
            "Network.requestWillBeSent",
            r#"{"requestId":":1","request":{"url":"https://x.test/api","method":"POST"},"type":"Fetch"}"#,
        );
        assert_eq!(state.0.lock().unwrap().pending.len(), 1);
        state.external_event(
            "Network.responseReceived",
            r#"{"requestId":":1","response":{"status":200}}"#,
        );
        state.external_event(
            "Network.loadingFinished",
            r#"{"requestId":":1","encodedDataLength":524}"#,
        );
        let listed = state.0.lock().unwrap().listed(None, 50);
        assert!(state.0.lock().unwrap().pending.is_empty());
        assert_eq!(listed["requests"][0]["method"], "POST");
        assert_eq!(listed["requests"][0]["status"], 200);
        assert_eq!(listed["requests"][0]["size"], 524);
        // Until the page loads again its first load is missing, and the list
        // says so; Anbo's own tab is watched from the start.
        assert!(listed["note"]
            .as_str()
            .unwrap()
            .contains("browser_reload lists them"));
        state.external_navigated();
        assert!(state
            .0
            .lock()
            .unwrap()
            .listed(None, 50)
            .get("note")
            .is_none());
        let own = NetworkState::default();
        assert!(own.0.lock().unwrap().listed(None, 50).get("note").is_none());
    }

    #[test]
    fn the_request_list_keeps_the_last_two_hundred_and_short_urls() {
        let state = NetworkState::default();
        let mut tracker = state.0.lock().unwrap();
        let now = Instant::now();
        for id in 0..MAX_RECORDS + 5 {
            tracker.record(
                NetworkEvent::Started,
                &format!(r#"{{"requestId":"{id}","request":{{"url":"https://x.test/{id}","method":"GET"}}}}"#),
                now,
            );
        }
        let listed = tracker.listed(None, MAX_RECORDS);
        assert_eq!(listed["matching"], MAX_RECORDS);
        assert_eq!(listed["dropped"], 5);
        assert_eq!(listed["requests"][0]["url"], "https://x.test/5");
        let long = format!("data:text/plain,{}", "a".repeat(2_000));
        tracker.record(
            NetworkEvent::Started,
            &format!(r#"{{"requestId":"long","request":{{"url":"{long}","method":"GET"}}}}"#),
            now,
        );
        let url = tracker.listed(Some("data:"), 1)["requests"][0]["url"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(url.chars().count(), MAX_URL_CHARS + 3);
        assert!(url.ends_with("..."));
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

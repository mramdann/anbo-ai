use super::*;
use crate::modules::browser_automation::{activity, design, registry, target::BrowserTarget};

#[derive(Clone)]
pub struct ExternalTarget {
    pub(super) connection_id: String,
    pub(super) browser_tab_id: i64,
    pub(super) selection_id: String,
    pub workspace: String,
    pub tab_id: i64,
    logs: std::sync::Arc<Mutex<ConsoleLogs>>,
    navigation: std::sync::Arc<Mutex<Navigation>>,
    #[cfg(windows)]
    pub network: std::sync::Arc<crate::modules::browser_automation::network::NetworkState>,
}

#[derive(Default)]
struct Navigation {
    observed_generation: u64,
    forced_loading: Option<u64>,
    pending_url: Option<String>,
}

#[derive(Default)]
struct ConsoleLogs {
    entries: std::collections::VecDeque<(usize, Value)>,
    bytes: usize,
}

impl ConsoleLogs {
    fn push(&mut self, value: Value) {
        let bytes = value.to_string().len();
        if bytes > 128 * 1024 {
            return;
        }
        while self.entries.len() >= 128 || self.bytes + bytes > 128 * 1024 {
            if let Some((removed, _)) = self.entries.pop_front() {
                self.bytes -= removed;
            } else {
                break;
            }
        }
        self.entries.push_back((bytes, value));
        self.bytes += bytes;
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRequest {
    connection_id: String,
    browser_tab_id: i64,
    selection_id: String,
    tab_id: i64,
    workspace: String,
}

impl Registry {
    fn bind(&mut self, binding: BindingRequest) -> Result<(ExternalTarget, bool), String> {
        let BindingRequest {
            connection_id,
            browser_tab_id,
            selection_id,
            tab_id,
            workspace,
        } = binding;
        if !protocol::valid_tab_id(tab_id) {
            return Err("invalid Anbo tab identity".into());
        }
        let target = ExternalTarget {
            connection_id,
            browser_tab_id,
            selection_id,
            tab_id,
            workspace,
            logs: Default::default(),
            navigation: Default::default(),
            #[cfg(windows)]
            network: Default::default(),
        };
        let generation = target.validate(self)?.generation;
        target
            .navigation
            .lock()
            .map_err(|_| "browser navigation state unavailable")?
            .observed_generation = generation;
        for existing in self.bindings.values() {
            if existing.tab_id == tab_id {
                if existing.connection_id == target.connection_id
                    && existing.browser_tab_id == browser_tab_id
                    && existing.selection_id == target.selection_id
                    && existing.workspace == target.workspace
                {
                    return Ok((existing.clone(), false));
                }
                return Err("Anbo tab is already bound to another browser tab".into());
            }
            if existing.connection_id == target.connection_id
                && existing.browser_tab_id == browser_tab_id
            {
                return Err("browser tab is already bound to another Anbo tab".into());
            }
        }
        if self.bindings.len() >= 64 {
            return Err("Anbo external tab limit reached; release an unused tab first".into());
        }
        self.bindings.insert(tab_id, target.clone());
        Ok((target, true))
    }
}

impl ExternalTarget {
    pub(super) fn check_lease(
        &self,
        connection_id: Option<&str>,
        selection_id: Option<&str>,
    ) -> Result<(), String> {
        if connection_id != Some(self.connection_id.as_str())
            || selection_id != Some(self.selection_id.as_str())
        {
            return Err("browser tab binding changed; retry from the current tab".into());
        }
        Ok(())
    }

    pub(super) fn validate<'a>(&self, registry: &'a Registry) -> Result<&'a Tab, String> {
        let connection = registry
            .connections
            .get(&self.connection_id)
            .ok_or("browser profile disconnected")?;
        if connection.workspace.as_deref() != Some(&self.workspace) {
            return Err("browser workspace changed".into());
        }
        connection
            .tabs
            .iter()
            .find(|tab| {
                tab.id == self.browser_tab_id
                    && tab.selection_id.as_deref() == Some(&self.selection_id)
            })
            .ok_or_else(|| {
                "browser tab released or disconnected; select it again explicitly".into()
            })
    }

    pub fn info(&self) -> Result<Tab, String> {
        let registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        self.validate(&registry).cloned()
    }

    pub fn console_logs(&self) -> Vec<Value> {
        self.logs
            .lock()
            .map(|logs| {
                logs.entries
                    .iter()
                    .map(|(_, value)| value.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn profile(&self) -> Option<Value> {
        let registry = REGISTRY.lock().ok()?;
        let connection = registry.connections.get(&self.connection_id)?;
        Some(
            json!({"browser":connection.profile.browser,"name":connection.profile.name,"profileId":connection.profile.profile_id}),
        )
    }

    pub fn loading(&self) -> Option<bool> {
        let info = self.info().ok()?;
        Some(info.loading || self.navigation.lock().ok()?.forced_loading.is_some())
    }

    pub fn pending_url(&self) -> Option<String> {
        self.navigation.lock().ok()?.pending_url.clone()
    }

    pub fn set_loading(&self, loading: bool) {
        let generation = self.info().ok().map(|info| info.generation);
        if let Ok(mut state) = self.navigation.lock() {
            state.forced_loading = if loading { generation } else { None };
            if !loading {
                state.pending_url = None;
            }
        }
    }

    pub fn set_pending_url(&self, url: Option<String>) {
        if let Ok(mut state) = self.navigation.lock() {
            state.pending_url = url;
        }
    }

    pub(super) fn observed(&self, tab: &Tab) -> bool {
        if let Ok(mut state) = self.navigation.lock() {
            let changed = state.observed_generation != tab.generation;
            state.observed_generation = tab.generation;
            if state
                .forced_loading
                .is_some_and(|generation| tab.generation > generation || tab.loading)
            {
                state.forced_loading = None;
            }
            if !tab.loading && state.forced_loading.is_none() {
                state.pending_url = None;
            }
            return changed;
        }
        false
    }

    fn queue(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(RequestGuard, oneshot::Receiver<Result<Value, String>>), String> {
        let mut registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        if !registry.bindings.get(&self.tab_id).is_some_and(|current| {
            current.connection_id == self.connection_id && current.selection_id == self.selection_id
        }) {
            return Err("browser tab binding was released".into());
        }
        self.validate(&registry)?;
        // The extension drops a tab whose command outlives its deadline, so it
        // always gets the whole budget. A short timeout is only how long the
        // caller listens (see `call`): a busy page then costs a retry, not the
        // tab.
        let (request_id, receiver) = registry.queue_timed(
            &self.connection_id,
            self.browser_tab_id,
            method,
            params,
            REQUEST_TIMEOUT,
        )?;
        Ok((
            RequestGuard {
                connection_id: self.connection_id.clone(),
                request_id,
            },
            receiver,
        ))
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (_guard, receiver) = self.queue(method, params)?;
        // Input and navigation are waited for in full: giving up early would
        // report an action as not done while it can still land.
        let wait = if changes_page(method) {
            REQUEST_TIMEOUT
        } else {
            timeout.min(REQUEST_TIMEOUT)
        };
        tokio::time::timeout(wait, receiver)
            .await
            .map_err(|_| "browser action timed out; it was not replayed")?
            .map_err(|_| "browser disconnected")?
    }

    /// The extension drops a tab whose command expires, so an effect waiting on
    /// a page that is busy for a moment gets as long as any other command.
    pub fn eval(&self, script: String) -> Result<(), String> {
        let (guard, receiver) = self.queue(
            "Runtime.evaluate",
            json!({"expression":script,"returnByValue":true}),
        )?;
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let _ = tokio::time::timeout(REQUEST_TIMEOUT, receiver).await;
        });
        Ok(())
    }
}

/// Whether a command acts on the page rather than reading it.
fn changes_page(method: &str) -> bool {
    method.starts_with("Input.")
        || matches!(
            method,
            "Page.navigate" | "Page.reload" | "Page.navigateToHistoryEntry"
        )
}

pub fn get(tab_id: i64) -> Option<ExternalTarget> {
    let registry = REGISTRY.lock().ok()?;
    let target = registry.bindings.get(&tab_id)?;
    target.validate(&registry).ok()?;
    Some(target.clone())
}

pub fn ids() -> Vec<i64> {
    REGISTRY
        .lock()
        .map(|registry| registry.bindings.keys().copied().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn browser_external_bind(
    app: AppHandle,
    webview: Webview,
    binding: BindingRequest,
) -> Result<(), String> {
    ensure_main(&webview)?;
    let tab_id = binding.tab_id;
    if crate::modules::browser::embed::is_embed_tab_active(tab_id) {
        return Err("Anbo tab identity is unavailable".into());
    }
    let lock = registry::get_tab_lock(tab_id);
    let _guard = lock.lock().await;
    let (target, created) = {
        let mut registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        registry.bind(binding)?
    };
    if !created {
        return Ok(());
    }
    crate::modules::browser_automation::snapshot::invalidate_document(tab_id);
    #[cfg(windows)]
    {
        let enabled = target
            .call(
                "Network.enable",
                json!({"maxTotalBufferSize":1,"maxResourceBufferSize":1,"maxPostDataSize":0}),
                Duration::from_secs(2),
            )
            .await
            .is_ok();
        target.network.external_enabled(enabled);
    }
    let handle = BrowserTarget::External {
        app,
        target,
        label: format!("browser-embed-{tab_id}"),
    };
    activity::presentation(&handle, true);
    Ok(())
}

pub(super) fn cleanup_retired(app: &AppHandle) {
    let (retired, navigated) = REGISTRY
        .lock()
        .map(|mut registry| {
            (
                std::mem::take(&mut registry.retired),
                std::mem::take(&mut registry.navigated),
            )
        })
        .unwrap_or_default();
    for tab_id in navigated {
        crate::modules::browser_automation::snapshot::invalidate_document(tab_id);
    }
    for tab_id in retired {
        super::dock::remove(tab_id);
        activity::retire(app, tab_id);
        design::remove(tab_id);
        crate::modules::browser_automation::snapshot::invalidate_document(tab_id);
    }
}

#[tauri::command]
pub async fn browser_external_unbind(
    webview: Webview,
    tab_id: i64,
    connection_id: Option<String>,
    selection_id: Option<String>,
    forget: Option<bool>,
) -> Result<(), String> {
    ensure_main(&webview)?;
    let lock = registry::get_tab_lock(tab_id);
    let _guard = lock.lock().await;
    let queued = {
        let mut registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        if let Some(target) = registry.bindings.get(&tab_id) {
            target.check_lease(connection_id.as_deref(), selection_id.as_deref())?;
        }
        if forget.unwrap_or(false) {
            crate::modules::browser_automation::snapshot::remove_generation(tab_id);
        } else {
            crate::modules::browser_automation::snapshot::invalidate_document(tab_id);
        }
        super::dock::remove(tab_id);
        let Some(target) = registry.bindings.remove(&tab_id) else {
            return Ok(());
        };
        target.validate(&registry)?;
        let (request_id, receiver) = registry.queue(
            &target.connection_id,
            target.browser_tab_id,
            "anbo.closeTab",
            json!({}),
        )?;
        (
            RequestGuard {
                connection_id: target.connection_id,
                request_id,
            },
            receiver,
        )
    };
    {
        activity::retire(tauri::Manager::app_handle(&webview), tab_id);
        design::remove(tab_id);
        let (_guard, receiver) = queued;
        tokio::time::timeout(REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| "browser release timed out")?
            .map_err(|_| "browser disconnected")??;
    }
    Ok(())
}

pub(super) fn restore(app: &AppHandle, connection_id: &str) {
    let ids = REGISTRY
        .lock()
        .map(|registry| {
            registry
                .bindings
                .values()
                .filter(|target| target.connection_id == connection_id)
                .map(|target| target.tab_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for tab_id in ids {
        if let Some(target) = registry::find_target(app, tab_id) {
            if get(tab_id)
                .and_then(|target| target.info().ok())
                .is_some_and(|info| !info.loading)
            {
                activity::restore(&target);
                design::restore(&target);
            }
        }
    }
}

pub(super) fn event(
    app: &AppHandle,
    connection_id: &str,
    browser_tab_id: i64,
    selection_id: &str,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let tab_id = {
        let registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        registry
            .bindings
            .values()
            .find(|target| {
                target.connection_id == connection_id
                    && target.browser_tab_id == browser_tab_id
                    && target.selection_id == selection_id
            })
            .map(|target| target.tab_id)
    };
    let Some(tab_id) = tab_id else {
        return Ok(());
    };
    match method {
        "anbo.dockReleased" => {
            if let Some(token) = params["token"].as_str().filter(|token| token.len() == 64) {
                super::dock::released(tab_id, token);
            }
        }
        "anbo.visible" => {
            if let Some(target) = registry::find_target(app, tab_id) {
                activity::restore(&target);
            }
        }
        "anbo.console" => {
            if params["level"]
                .as_str()
                .is_some_and(|value| value.len() <= 16)
                && params["msg"]
                    .as_str()
                    .is_some_and(|value| value.len() <= 16_000)
                && params["frame"]
                    .as_str()
                    .is_some_and(|value| value.len() <= 128)
                && params["ts"].as_u64().is_some()
            {
                if let Some(target) = get(tab_id) {
                    if let Ok(mut logs) = target.logs.lock() {
                        logs.push(json!({"level":params["level"],"msg":params["msg"],"ts":params["ts"],"frame":params["frame"]}));
                    }
                }
            }
        }
        #[cfg(windows)]
        "Network.requestWillBeSent" | "Network.loadingFinished" | "Network.loadingFailed" => {
            if let Some(target) = get(tab_id) {
                target
                    .network
                    .external_event(method == "Network.requestWillBeSent", &params.to_string());
            }
        }
        "Runtime.bindingCalled" => design::external_event(app, tab_id, &params.to_string()),
        "Page.frameNavigated" if params.get("parentId").is_none() => {
            if let Some(target) = registry::find_target(app, tab_id) {
                activity::navigation(&target);
                design::navigation(&target);
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const LEASE: &str = "00112233-4455-6677-8899-aabbccddeeff";

    #[test]
    fn console_capture_is_bounded_by_rows_and_bytes() {
        let mut logs = ConsoleLogs::default();
        for index in 0..1000 {
            logs.push(json!({"msg":"x".repeat(16000),"ts":index}));
        }
        assert!(logs.bytes <= 128 * 1024);
        assert!(logs.entries.len() <= 128);
        assert_eq!(logs.entries.back().unwrap().1["ts"], 999);
    }

    fn fixture() -> (Registry, mpsc::Receiver<Value>) {
        let (sender, receiver) = mpsc::channel(MAX_PENDING);
        let mut registry = Registry::default();
        registry.connections.insert(
            "profile".into(),
            Connection {
                profile: Profile {
                    version: protocol::VERSION,
                    profile_id: LEASE.into(),
                    browser: protocol::Browser::Chrome,
                    name: "Work".into(),
                },
                workspace: Some("D:/work".into()),
                tabs: vec![Tab {
                    id: 10,
                    selection_id: Some(LEASE.into()),
                    url: "https://example.com/".into(),
                    generation: 1,
                    ..Default::default()
                }],
                sender,
                pending: Default::default(),
                next_request: 1,
                stop: None,
            },
        );
        (registry, receiver)
    }

    fn binding() -> BindingRequest {
        BindingRequest {
            connection_id: "profile".into(),
            browser_tab_id: 10,
            selection_id: LEASE.into(),
            tab_id: 42,
            workspace: "D:/work".into(),
        }
    }

    #[test]
    fn binding_requires_exact_workspace_selection_and_unique_anbo_identity() {
        let (mut registry, _receiver) = fixture();
        let mut wrong = binding();
        wrong.workspace = "D:/other".into();
        assert!(registry.bind(wrong).is_err());
        let mut wrong = binding();
        wrong.selection_id = "stale".into();
        assert!(registry.bind(wrong).is_err());
        assert!(registry.bind(binding()).unwrap().1);
        assert!(!registry.bind(binding()).unwrap().1);
        let mut duplicate = binding();
        duplicate.tab_id = 43;
        assert!(registry.bind(duplicate).is_err());
        let mut duplicate = binding();
        duplicate.browser_tab_id = 11;
        assert!(registry.bind(duplicate).is_err());
    }

    #[test]
    fn revoked_or_reselected_tabs_never_reuse_a_live_binding() {
        let (mut registry, _receiver) = fixture();
        let (old, _) = registry.bind(binding()).unwrap();
        let mut replacement = registry.connections["profile"].tabs[0].clone();
        replacement.selection_id = Some("ffeeddcc-bbaa-9988-7766-554433221100".into());
        registry
            .receive(
                "profile",
                protocol::Incoming::Tabs {
                    tabs: vec![replacement],
                },
            )
            .unwrap();
        assert!(registry.bindings.is_empty());
        assert_eq!(registry.retired, vec![42]);
        assert!(old.validate(&registry).is_err());
    }

    #[test]
    fn stale_ui_actions_cannot_control_or_release_a_rebound_tab() {
        let (mut registry, _receiver) = fixture();
        let (target, _) = registry.bind(binding()).unwrap();
        assert!(target.check_lease(Some("profile"), Some(LEASE)).is_ok());
        assert!(target
            .check_lease(Some("old-profile"), Some(LEASE))
            .is_err());
        assert!(target
            .check_lease(Some("profile"), Some("old-selection"))
            .is_err());
        assert!(target.check_lease(None, None).is_err());
        assert!(registry.bindings.contains_key(&42));
    }

    #[test]
    fn navigation_epoch_never_regresses_and_commands_carry_the_selection_lease() {
        let (mut registry, mut receiver) = fixture();
        registry.bind(binding()).unwrap();
        let mut tab = registry.connections["profile"].tabs[0].clone();
        tab.generation = 2;
        registry
            .receive(
                "profile",
                protocol::Incoming::Tabs {
                    tabs: vec![tab.clone()],
                },
            )
            .unwrap();
        assert!(registry.navigated.contains(&42));
        tab.generation = 1;
        assert!(registry
            .receive("profile", protocol::Incoming::Tabs { tabs: vec![tab] })
            .is_err());
        let (_id, _response) = registry
            .queue_timed(
                "profile",
                10,
                "Input.insertText",
                json!({"text":"test"}),
                Duration::from_millis(500),
            )
            .unwrap();
        let command = receiver.try_recv().unwrap();
        assert_eq!(command["selectionId"], LEASE);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(command["expiresAt"].as_u64().unwrap() <= now + 500);
        registry.remove("profile");
        assert!(registry.bindings.is_empty());
    }

    #[test]
    fn page_actions_are_waited_for_and_reads_return_when_the_caller_stops() {
        for method in [
            "Input.dispatchMouseEvent",
            "Input.insertText",
            "Page.navigate",
            "Page.reload",
            "Page.navigateToHistoryEntry",
        ] {
            assert!(changes_page(method), "{method}");
        }
        for method in [
            "Runtime.evaluate",
            "DOM.getDocument",
            "Accessibility.getFullAXTree",
            "Page.captureScreenshot",
            "Page.getNavigationHistory",
        ] {
            assert!(!changes_page(method), "{method}");
        }
    }
}

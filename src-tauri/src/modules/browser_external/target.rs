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
    /// The Anbo tab whose page an agent's input opened this one from. Noted
    /// before the binding lands, so browser_tabs lists the tab as that agent's
    /// from its first moment (round 76, R76-1).
    #[serde(default)]
    opened_from: Option<i64>,
}

/// What a bind did.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Bound {
    New,
    /// The tab's binding was already this one.
    Same,
    /// The tab moved to another workspace its profile serves, and its binding
    /// went along.
    Moved,
}

impl Registry {
    fn bind(&mut self, binding: BindingRequest) -> Result<(ExternalTarget, Bound), String> {
        let BindingRequest {
            connection_id,
            browser_tab_id,
            selection_id,
            tab_id,
            workspace,
            opened_from: _,
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
        for existing in self.bindings.values_mut() {
            if existing.tab_id == tab_id {
                if existing.connection_id != target.connection_id
                    || existing.browser_tab_id != browser_tab_id
                    || existing.selection_id != target.selection_id
                {
                    return Err("Anbo tab is already bound to another browser tab".into());
                }
                if existing.workspace == target.workspace {
                    return Ok((existing.clone(), Bound::Same));
                }
                // Its logs, navigation and network state go along.
                existing.workspace = target.workspace;
                if let Some(connection) = self.connections.get_mut(&existing.connection_id) {
                    connection
                        .placed
                        .insert(existing.selection_id.clone(), existing.workspace.clone());
                }
                return Ok((existing.clone(), Bound::Moved));
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
        if let Some(connection) = self.connections.get_mut(&target.connection_id) {
            connection
                .placed
                .insert(target.selection_id.clone(), target.workspace.clone());
        }
        Ok((target, Bound::New))
    }
}

/// The name the extension keeps for a tab's workspace: opaque, so it can tell
/// whether two tabs belong to one workspace without learning its path.
fn scope_of(workspace: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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
        if !connection.workspaces.contains(&self.workspace) {
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
        self.queue_for(method, params, REQUEST_TIMEOUT)
    }

    fn queue_for(
        &self,
        method: &str,
        params: Value,
        budget: Duration,
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
        // Every command gets the whole budget in the extension, and one that
        // outlives it keeps the tab: the tab's later commands wait there until
        // it is done. A short timeout is only how long the caller listens (see
        // `call`).
        let (request_id, receiver) = registry.queue_timed(
            &self.connection_id,
            self.browser_tab_id,
            method,
            params,
            budget,
        )?;
        Ok((
            RequestGuard {
                connection_id: self.connection_id.clone(),
                request_id,
            },
            receiver,
        ))
    }

    /// A command the extension gives up on after `budget` instead of the
    /// whole budget, for one that holds no later command up when it ends late
    /// (a viewport capture): a page its browser does not show draws no frame,
    /// and its capture waited 10 s for one (round 60).
    pub async fn call_within(
        &self,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, String> {
        wait_for_slot(&self.connection_id, budget).await;
        let (_guard, receiver) = self.queue_for(method, params, budget)?;
        tokio::time::timeout(budget + REPLY_GRACE, receiver)
            .await
            .map_err(|_| {
                format!(
                    "browser action timed out after {:.1} s",
                    budget.as_secs_f32()
                )
            })?
            .map_err(|_| "browser disconnected".to_string())?
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        wait_for_slot(&self.connection_id, timeout).await;
        let (_guard, receiver) = self.queue(method, params)?;
        let wait = listen_window(method, timeout);
        tokio::time::timeout(wait, receiver)
            .await
            .map_err(|_| {
                format!(
                    "browser action timed out after {:.1} s; it was not replayed and may still finish in the page, so check the page before repeating it",
                    wait.as_secs_f32()
                )
            })?
            .map_err(|_| "browser disconnected".to_string())?
    }

    /// An effect waiting on a page that is busy for a moment gets as long as
    /// any other command.
    pub fn eval(&self, script: String) -> Result<(), String> {
        let (guard, receiver) = self.queue(
            "Runtime.evaluate",
            json!({"expression":script,"returnByValue":true}),
        )?;
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let _ = tokio::time::timeout(REQUEST_TIMEOUT + REPLY_GRACE, receiver).await;
        });
        Ok(())
    }
}

/// A read asked to wait this long or longer is waited for in full.
const LONG_READ: Duration = Duration::from_secs(1);

/// How long `call` listens. Input and navigation are waited for in full, as
/// giving up early would report an action as not done while it can still land.
/// So is a read of the page that may take a second or more: a Chrome or Edge
/// page its browser is not showing, or one on a busy machine, answers slowly
/// but in order, so giving up early frees nothing. Anbo then listens a little
/// past the command's deadline, so the extension's own answer arrives first.
/// A shorter wait is a quick look whose caller does without the answer.
fn listen_window(method: &str, requested: Duration) -> Duration {
    if changes_page(method) || (reads_page(method) && requested >= LONG_READ) {
        REQUEST_TIMEOUT + REPLY_GRACE
    } else {
        requested.min(REQUEST_TIMEOUT)
    }
}

/// Whether a command reads or works the page itself, not the browser around it.
fn reads_page(method: &str) -> bool {
    [
        "Runtime.",
        "DOM.",
        "DOMSnapshot.",
        "Accessibility.",
        "Page.",
    ]
    .iter()
    .any(|domain| method.starts_with(domain))
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
    // Before the binding lands, when browser_tabs starts listing the tab: an
    // agent that read the list at once saw its own new tab as yours:false.
    if let Some(source) = binding.opened_from {
        activity::note_opened_from(source, tab_id);
    }
    let (target, bound) = {
        let mut registry = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?;
        registry.bind(binding)?
    };
    if bound == Bound::Same {
        return Ok(());
    }
    // A profile can serve several workspaces. The extension learns which one
    // each tab is in, so it never hands a tab a page opened to the wrong one
    // (tabs.js `created`). Older extension code does not know the command.
    // It goes on the tab's control lane, beside the page's own setup below.
    let scope = async {
        if let Err(error) = target
            .call(
                "anbo.scopeTab",
                json!({ "scope": scope_of(&target.workspace) }),
                Duration::from_secs(2),
            )
            .await
        {
            log::debug!(
                "[browser_bridge] the extension did not take tab {tab_id}'s workspace: {error}"
            );
        }
    };
    if bound == Bound::Moved {
        scope.await;
        return Ok(());
    }
    crate::modules::browser_automation::snapshot::invalidate_document(tab_id);
    #[cfg(windows)]
    {
        let network = target.call(
            "Network.enable",
            json!({"maxTotalBufferSize":1,"maxResourceBufferSize":1,"maxPostDataSize":0}),
            Duration::from_secs(2),
        );
        let ((), enabled) = tokio::join!(scope, network);
        target.network.external_enabled(enabled.is_ok());
    }
    #[cfg(not(windows))]
    scope.await;
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

/// What the extension does with the browser's tab when Anbo lets go of it:
/// closes it when the Anbo tab was closed on purpose (by the user or an
/// agent), or leaves it open when the Anbo tab only moved on (to another
/// workspace, or with its workspace). Without the word, as from an older UI,
/// the extension closes only a tab Anbo opened.
fn close_params(close: Option<bool>) -> Value {
    close.map_or_else(|| json!({}), |close| json!({ "close": close }))
}

#[tauri::command]
pub async fn browser_external_unbind(
    webview: Webview,
    tab_id: i64,
    connection_id: Option<String>,
    selection_id: Option<String>,
    forget: Option<bool>,
    close: Option<bool>,
) -> Result<(), String> {
    ensure_main(&webview)?;
    let lock = registry::get_tab_lock(tab_id);
    let _guard = lock.lock().await;
    // Anbo lets go of the tab below, so a refused close would leave the page in
    // its browser with no tab here.
    let held = REGISTRY
        .lock()
        .ok()
        .and_then(|registry| Some(registry.bindings.get(&tab_id)?.connection_id.clone()));
    if let Some(held) = held {
        wait_for_slot(&held, REQUEST_TIMEOUT).await;
    }
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
            close_params(close),
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
        tokio::time::timeout(REQUEST_TIMEOUT + REPLY_GRACE, receiver)
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
                activity::restore_lost(&target);
                design::restore(&target);
            }
        }
    }
}

/// The UI closes Anbo's tab whose page was closed in its browser.
const CLOSED_EVENT: &str = "anbo:external-browser-closed";

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
        // Closed in the browser on its own (extension 0.5.7), not with its
        // window or by Anbo.
        "anbo.closedInBrowser" => {
            let _ = app.emit(CLOSED_EVENT, json!({ "tabId": tab_id }));
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
        "Network.requestWillBeSent"
        | "Network.responseReceived"
        | "Network.loadingFinished"
        | "Network.loadingFailed" => {
            if let Some(target) = get(tab_id) {
                target.network.external_event(method, &params.to_string());
            }
        }
        "Runtime.bindingCalled" => design::external_event(app, tab_id, &params.to_string()),
        "Page.frameNavigated" if params.get("parentId").is_none() => {
            #[cfg(windows)]
            {
                if let Some(target) = get(tab_id) {
                    target.network.external_navigated();
                }
            }
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
    fn the_close_word_says_whether_the_browser_tab_closes_too() {
        assert_eq!(close_params(Some(true)), json!({ "close": true }));
        assert_eq!(close_params(Some(false)), json!({ "close": false }));
        // An older UI says nothing; the extension then closes only a tab Anbo
        // opened.
        assert_eq!(close_params(None), json!({}));
    }

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
                workspaces: vec!["D:/work".into()],
                placed: Default::default(),
                tabs: vec![Tab {
                    id: 10,
                    selection_id: Some(LEASE.into()),
                    url: "https://example.com/".into(),
                    generation: 1,
                    ..Default::default()
                }],
                extension: None,
                sender,
                pending: Default::default(),
                limit_logged: None,
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
            opened_from: None,
        }
    }

    #[test]
    fn a_bind_may_name_the_tab_that_opened_it() {
        let request = |extra: serde_json::Value| {
            let mut value = json!({
                "connectionId": "profile",
                "browserTabId": 10,
                "selectionId": LEASE,
                "tabId": 42,
                "workspace": "D:/work",
            });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value::<BindingRequest>(value)
        };
        assert_eq!(request(json!({})).unwrap().opened_from, None);
        assert_eq!(
            request(json!({"openedFrom": 7})).unwrap().opened_from,
            Some(7)
        );
        assert!(
            request(json!({"opener": 7})).is_err(),
            "unknown fields stay refused"
        );
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
        assert_eq!(registry.bind(binding()).unwrap().1, Bound::New);
        assert_eq!(registry.bind(binding()).unwrap().1, Bound::Same);
        let mut duplicate = binding();
        duplicate.tab_id = 43;
        assert!(registry.bind(duplicate).is_err());
        let mut duplicate = binding();
        duplicate.browser_tab_id = 11;
        assert!(registry.bind(duplicate).is_err());
    }

    #[test]
    fn a_new_ui_binds_the_same_browser_tab_under_its_own_id() {
        // Round 60: after a page reload the UI's tab 93 was another tab, and
        // the restored tab could not bind its page again.
        let (mut registry, _receiver) = fixture();
        registry.bind(binding()).unwrap();
        let renumbered = || BindingRequest {
            tab_id: 7,
            ..binding()
        };
        assert!(registry.bind(renumbered()).is_err());
        registry.forget_bindings();
        assert!(registry.bindings.is_empty());
        assert_eq!(registry.retired, vec![42]);
        assert_eq!(registry.bind(renumbered()).unwrap().1, Bound::New);
    }

    #[test]
    fn a_tab_moves_between_workspaces_its_profile_serves_and_leaves_with_one() {
        let (mut registry, _receiver) = fixture();
        let mut other = binding();
        other.workspace = "D:/other".into();
        assert!(registry.bind(other).is_err(), "not approved there yet");
        registry.approve("profile", "D:/other".into()).unwrap();
        let (first, _) = registry.bind(binding()).unwrap();
        let mut moved = binding();
        moved.workspace = "D:/other".into();
        assert_eq!(registry.connections["profile"].placed[LEASE], "D:/work");
        let (target, bound) = registry.bind(moved).unwrap();
        assert_eq!(bound, Bound::Moved);
        assert_eq!(target.workspace, "D:/other");
        assert_eq!(registry.bindings[&42].workspace, "D:/other");
        assert!(std::sync::Arc::ptr_eq(
            &first.navigation,
            &target.navigation
        ));
        // A copy taken before the move still reaches the tab: both workspaces
        // are the profile's.
        assert!(first.validate(&registry).is_ok());
        // A new UI page learns where the tab was.
        registry.forget_bindings();
        assert_eq!(registry.connections["profile"].placed[LEASE], "D:/other");
        registry.retired.clear();
        let mut again = binding();
        again.workspace = "D:/other".into();
        let (target, _) = registry.bind(again).unwrap();

        // Leaving the tab's workspace lets the tab go; the profile stays.
        assert_eq!(registry.leave("profile", r"d:\other\").unwrap(), vec![10]);
        assert!(registry.bindings.is_empty());
        assert_eq!(registry.retired, vec![42]);
        assert_eq!(registry.connections["profile"].workspaces, ["D:/work"]);
        assert!(target.validate(&registry).is_err());
        assert!(registry.leave("profile", "D:/other").is_err());
        // The last workspace goes with the connection.
        assert!(registry.leave("profile", "D:/work").unwrap().is_empty());
        assert!(registry.connections.is_empty());
    }

    #[test]
    fn a_workspace_scope_is_opaque_and_one_per_workspace() {
        let scope = scope_of("D:/work");
        assert_eq!(scope.len(), 16);
        assert!(scope.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(scope, scope_of("D:/work"));
        assert_ne!(scope, scope_of("D:/other"));
    }

    #[test]
    fn revoked_or_reselected_tabs_never_reuse_a_live_binding() {
        let (mut registry, _receiver) = fixture();
        let (old, _) = registry.bind(binding()).unwrap();
        assert!(registry.connections["profile"].placed.contains_key(LEASE));
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
        // A selection the browser let go of is forgotten.
        assert!(registry.connections["profile"].placed.is_empty());
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

    #[test]
    fn a_slow_page_read_is_waited_for_in_full_and_a_quick_look_is_not() {
        let full = REQUEST_TIMEOUT + REPLY_GRACE;
        assert_eq!(
            listen_window("Input.insertText", Duration::from_millis(500)),
            full
        );
        for method in [
            "Runtime.evaluate",
            "Page.createIsolatedWorld",
            "DOM.getDocument",
        ] {
            assert_eq!(
                listen_window(method, Duration::from_secs(2)),
                full,
                "{method}"
            );
            assert_eq!(
                listen_window(method, Duration::from_millis(600)),
                Duration::from_millis(600),
                "{method}"
            );
        }
        // The dock and the network pick their own waits.
        assert_eq!(
            listen_window("anbo.dockCommit", Duration::from_secs(5)),
            Duration::from_secs(5)
        );
        assert_eq!(
            listen_window("Network.enable", Duration::from_secs(2)),
            Duration::from_secs(2)
        );
        assert_eq!(
            listen_window("anbo.tabState", Duration::from_secs(60)),
            REQUEST_TIMEOUT
        );
    }
}

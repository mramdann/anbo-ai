pub mod control;
pub mod dock;
#[cfg(windows)]
pub mod dock_window;
mod protocol;
pub mod setup;
pub mod target;
pub mod wire;
pub use target::ExternalTarget;
pub use target::{get as get_target, ids as target_ids};

use crate::modules::workspace::WorkspaceRegistry;
use protocol::{Profile, Tab, MAX_CONNECTIONS, MAX_PENDING};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State, Webview};
use tokio::sync::{mpsc, oneshot};

const EVENT: &str = "anbo:external-browser-changed";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
type Reply = oneshot::Sender<Result<Value, String>>;

struct Connection {
    profile: Profile,
    workspace: Option<String>,
    tabs: Vec<Tab>,
    sender: mpsc::Sender<Value>,
    pending: BTreeMap<u64, Reply>,
    next_request: u64,
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Registry {
    connections: BTreeMap<String, Connection>,
    bindings: BTreeMap<i64, ExternalTarget>,
    retired: Vec<i64>,
    navigated: std::collections::BTreeSet<i64>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    connection_id: String,
    profile: Profile,
    workspace: Option<String>,
    tabs: Vec<Tab>,
}

fn ensure_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("only the main webview may manage browser connections".into());
    }
    Ok(())
}

fn changed(app: &AppHandle) {
    target::cleanup_retired();
    let _ = app.emit_to("main", EVENT, ());
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Registry {
    fn insert(&mut self, id: String, connection: Connection) -> Result<(), String> {
        if self.connections.len() >= MAX_CONNECTIONS {
            return Err("external browser connection limit reached".into());
        }
        if self.connections.values().any(|existing| {
            existing.profile.browser == connection.profile.browser
                && existing.profile.profile_id == connection.profile.profile_id
        }) {
            return Err("this browser profile is already connected".into());
        }
        self.connections.insert(id, connection);
        Ok(())
    }

    fn connection_mut(&mut self, id: &str) -> Result<&mut Connection, String> {
        self.connections
            .get_mut(id)
            .ok_or_else(|| "browser disconnected; reconnect the same profile explicitly".into())
    }

    fn approve(&mut self, id: &str, workspace: String) -> Result<(), String> {
        let connection = self.connection_mut(id)?;
        if connection
            .workspace
            .as_ref()
            .is_some_and(|current| current != &workspace)
        {
            return Err("disconnect before assigning this profile to another workspace".into());
        }
        connection
            .sender
            .try_send(json!({"type":"approved"}))
            .map_err(|_| "browser bridge is busy or disconnected")?;
        connection.workspace = Some(workspace);
        Ok(())
    }

    fn queue(
        &mut self,
        id: &str,
        tab_id: i64,
        method: &str,
        params: Value,
    ) -> Result<(u64, oneshot::Receiver<Result<Value, String>>), String> {
        self.queue_timed(id, tab_id, method, params, REQUEST_TIMEOUT)
    }

    fn queue_timed(
        &mut self,
        id: &str,
        tab_id: i64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<(u64, oneshot::Receiver<Result<Value, String>>), String> {
        let connection = self.connection_mut(id)?;
        connection.pending.retain(|_, sender| !sender.is_closed());
        let target_allowed = match method {
            "anbo.listTabs" | "anbo.openTab" => tab_id == 0,
            "anbo.selectTab" | "anbo.releaseTab" => protocol::valid_tab_id(tab_id),
            _ => connection.tabs.iter().any(|tab| tab.id == tab_id),
        };
        if connection.workspace.is_none() || !target_allowed {
            return Err("approve this profile and select a tab inside Anbo first".into());
        }
        if connection.pending.len() >= MAX_PENDING {
            return Err("browser bridge request limit reached".into());
        }
        let request_id = connection.next_request;
        connection.next_request = request_id
            .checked_add(1)
            .ok_or("browser request counter exhausted")?;
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
            + timeout.min(REQUEST_TIMEOUT).as_millis();
        let selection = connection
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .and_then(|tab| tab.selection_id.as_deref());
        let message = json!({"type":"command", "id":request_id, "tabId":tab_id, "selectionId":selection, "method":method, "params":params, "expiresAt":expires_at as u64});
        if serde_json::to_vec(&message)
            .map_err(|error| error.to_string())?
            .len()
            > wire::TO_BROWSER_LIMIT
        {
            return Err("browser command exceeds its size limit".into());
        }
        let (sender, receiver) = oneshot::channel();
        connection
            .sender
            .try_send(message)
            .map_err(|_| "browser bridge is busy or disconnected")?;
        connection.pending.insert(request_id, sender);
        Ok((request_id, receiver))
    }

    fn receive(&mut self, id: &str, incoming: protocol::Incoming) -> Result<bool, String> {
        let connection = self.connection_mut(id)?;
        match incoming {
            protocol::Incoming::Event { .. } => Err("unexpected browser event".into()),
            protocol::Incoming::Tabs { tabs } => {
                protocol::validate_tabs(&tabs)?;
                if connection.workspace.is_none() {
                    return Err("profile approval is required before selecting tabs".into());
                }
                if tabs.iter().any(|tab| tab.selection_id.is_none()) {
                    return Err("selected tab omitted its control lease".into());
                }
                if tabs.iter().any(|tab| {
                    tab.generation == 0
                        || connection.tabs.iter().any(|previous| {
                            previous.id == tab.id
                                && previous.selection_id == tab.selection_id
                                && previous.generation > tab.generation
                        })
                }) {
                    return Err("browser navigation generation moved backwards".into());
                }
                connection.tabs = tabs;
                let tabs = connection.tabs.clone();
                self.bindings.retain(|tab_id, target| {
                    let selected = tabs.iter().find(|tab| {
                        tab.id == target.browser_tab_id
                            && tab.selection_id.as_deref() == Some(&target.selection_id)
                    });
                    let live = target.connection_id != id || selected.is_some();
                    if target.connection_id == id {
                        if let Some(tab) = selected {
                            if target.observed(tab) {
                                self.navigated.insert(*tab_id);
                            }
                        }
                    }
                    if !live {
                        self.retired.push(*tab_id);
                    }
                    live
                });
                Ok(true)
            }
            protocol::Incoming::Reply { id, result, error } => {
                if let Some(sender) = connection.pending.remove(&id) {
                    let reply = match (result, error) {
                        (Some(result), None) => Ok(result),
                        (None, Some(error)) if error.len() <= 4096 => Err(error),
                        _ => Err("invalid browser bridge response".into()),
                    };
                    let _ = sender.send(reply);
                }
                Ok(false)
            }
        }
    }

    fn remove(&mut self, id: &str) {
        self.bindings.retain(|tab_id, target| {
            let live = target.connection_id != id;
            if !live {
                self.retired.push(*tab_id);
            }
            live
        });
        if let Some(mut connection) = self.connections.remove(id) {
            if let Some(stop) = connection.stop.take() {
                let _ = stop.send(());
            }
            for (_, sender) in connection.pending {
                let _ = sender.send(Err("browser disconnected; action was not replayed".into()));
            }
        }
    }
}

struct RequestGuard {
    connection_id: String,
    request_id: u64,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = REGISTRY.lock() {
            if let Ok(connection) = registry.connection_mut(&self.connection_id) {
                connection.pending.remove(&self.request_id);
            }
        }
    }
}

async fn request(
    connection_id: &str,
    tab_id: i64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (request_id, receiver) = REGISTRY
        .lock()
        .map_err(|_| "browser registry unavailable")?
        .queue(connection_id, tab_id, method, params)?;
    let _guard = RequestGuard {
        connection_id: connection_id.into(),
        request_id,
    };
    tokio::time::timeout(REQUEST_TIMEOUT, receiver)
        .await
        .map_err(|_| "browser action timed out; it may already have run and will not be replayed")?
        .map_err(|_| "browser disconnected; action was not replayed")?
}

pub async fn serve<R, W>(
    app: AppHandle,
    mut reader: R,
    mut writer: W,
    handshake: Value,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    if !cfg!(debug_assertions) {
        return Err("external browser preview is only available in development builds".into());
    }
    let profile: Profile = serde_json::from_value(handshake).map_err(|error| error.to_string())?;
    if let Err(error) = profile.validate() {
        let bytes = serde_json::to_vec(&json!({"type":"error", "message":error}))
            .map_err(|cause| cause.to_string())?;
        wire::write_frame(&mut writer, &bytes, wire::TO_BROWSER_LIMIT).await?;
        return Err(error);
    }
    let id = random_id()?;
    let (sender, mut commands) = mpsc::channel(MAX_PENDING);
    let (stop, stopped) = oneshot::channel();
    REGISTRY
        .lock()
        .map_err(|_| "browser registry unavailable")?
        .insert(
            id.clone(),
            Connection {
                profile,
                workspace: None,
                tabs: Vec::new(),
                sender,
                pending: BTreeMap::new(),
                next_request: 1,
                stop: Some(stop),
            },
        )?;
    struct ConnectionGuard(AppHandle, String);
    impl Drop for ConnectionGuard {
        fn drop(&mut self) {
            if let Ok(mut registry) = REGISTRY.lock() {
                registry.remove(&self.1);
            }
            changed(&self.0);
        }
    }
    let _guard = ConnectionGuard(app.clone(), id.clone());
    changed(&app);
    let read = async {
        while let Some(bytes) = wire::read_frame(&mut reader, wire::FROM_BROWSER_LIMIT).await? {
            let message = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if let protocol::Incoming::Event {
                tab_id,
                selection_id,
                method,
                params,
            } = message
            {
                target::event(&app, &id, tab_id, &selection_id, &method, params)?;
                continue;
            }
            let update = REGISTRY
                .lock()
                .map_err(|_| "browser registry unavailable")?
                .receive(&id, message)?;
            if update {
                changed(&app);
                target::restore(&app, &id);
            }
        }
        Err::<(), String>("browser bridge closed".into())
    };
    let write = async {
        while let Some(message) = commands.recv().await {
            if let Some(request_id) = message["id"].as_u64() {
                let live = REGISTRY.lock().ok().and_then(|registry| {
                    registry.connections.get(&id).map(|connection| {
                        connection
                            .pending
                            .get(&request_id)
                            .is_some_and(|sender| !sender.is_closed())
                    })
                }) == Some(true);
                if !live {
                    continue;
                }
            }
            let bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
            wire::write_frame(&mut writer, &bytes, wire::TO_BROWSER_LIMIT).await?;
        }
        Err::<(), String>("browser bridge closed".into())
    };
    tokio::select! {
        result = async { tokio::try_join!(read, write).map(|_| ()) } => result,
        _ = stopped => Ok(()),
    }
}

#[tauri::command]
pub fn browser_external_connections(webview: Webview) -> Result<Vec<ConnectionInfo>, String> {
    ensure_main(&webview)?;
    let registry = REGISTRY
        .lock()
        .map_err(|_| "browser registry unavailable")?;
    Ok(registry
        .connections
        .iter()
        .map(|(id, connection)| ConnectionInfo {
            connection_id: id.clone(),
            profile: connection.profile.clone(),
            workspace: connection.workspace.clone(),
            tabs: connection.tabs.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn browser_external_approve(
    app: AppHandle,
    webview: Webview,
    registry: State<'_, WorkspaceRegistry>,
    connection_id: String,
    workspace: String,
) -> Result<(), String> {
    ensure_main(&webview)?;
    if workspace.len() > 4096 {
        return Err("invalid workspace path".into());
    }
    let root = std::fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    if !root.is_dir() || !registry.is_authorized_root(&root) {
        return Err("browser connection requires an authorized workspace".into());
    }
    REGISTRY
        .lock()
        .map_err(|_| "browser registry unavailable")?
        .approve(&connection_id, crate::modules::fs::to_canon(&root))?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn browser_external_disconnect(
    app: AppHandle,
    webview: Webview,
    connection_id: String,
) -> Result<(), String> {
    ensure_main(&webview)?;
    REGISTRY
        .lock()
        .map_err(|_| "browser registry unavailable")?
        .remove(&connection_id);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn browser_external_inspect(
    webview: Webview,
    connection_id: String,
    tab_id: i64,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    request(&connection_id, tab_id, "Runtime.evaluate", json!({"expression":"JSON.stringify({title:document.title,url:location.href,readyState:document.readyState})", "returnByValue":true})).await
}

#[tauri::command]
pub async fn browser_external_focus(
    webview: Webview,
    connection_id: String,
    tab_id: i64,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    request(&connection_id, tab_id, "anbo.focusTab", json!({})).await
}

#[tauri::command]
pub async fn browser_external_list_tabs(
    webview: Webview,
    connection_id: String,
) -> Result<Vec<Tab>, String> {
    ensure_main(&webview)?;
    let result = request(&connection_id, 0, "anbo.listTabs", json!({})).await?;
    let tabs: Vec<Tab> = serde_json::from_value(result).map_err(|error| error.to_string())?;
    protocol::validate_tabs(&tabs)?;
    Ok(tabs)
}

#[tauri::command]
pub async fn browser_external_select_tab(
    webview: Webview,
    connection_id: String,
    tab_id: i64,
    expected_url: String,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    protocol::validate_url(&expected_url)?;
    request(
        &connection_id,
        tab_id,
        "anbo.selectTab",
        json!({"expectedUrl":expected_url}),
    )
    .await
}

#[tauri::command]
pub async fn browser_external_open_tab(
    webview: Webview,
    connection_id: String,
    url: String,
    activate: Option<bool>,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    let url = protocol::validate_url(&url)?;
    request(
        &connection_id,
        0,
        "anbo.openTab",
        json!({"url":url.as_str(),"activate":activate.unwrap_or(true)}),
    )
    .await
}

#[tauri::command]
pub async fn browser_external_release_tab(
    webview: Webview,
    connection_id: String,
    tab_id: i64,
) -> Result<Value, String> {
    ensure_main(&webview)?;
    request(&connection_id, tab_id, "anbo.releaseTab", json!({})).await
}

pub fn stop() {
    dock::shutdown();
    if let Ok(mut registry) = REGISTRY.lock() {
        let ids: Vec<_> = registry.connections.keys().cloned().collect();
        for id in ids {
            registry.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(profile_id: &str) -> (Connection, mpsc::Receiver<Value>) {
        let (sender, receiver) = mpsc::channel(MAX_PENDING);
        (
            Connection {
                profile: Profile {
                    version: protocol::VERSION,
                    profile_id: profile_id.into(),
                    browser: protocol::Browser::Chrome,
                    name: "Work".into(),
                },
                workspace: None,
                tabs: Vec::new(),
                sender,
                pending: BTreeMap::new(),
                next_request: 1,
                stop: None,
            },
            receiver,
        )
    }

    fn share(registry: &mut Registry, id: &str) {
        registry.approve(id, "D:/workspace".into()).unwrap();
        registry
            .receive(
                id,
                protocol::Incoming::Tabs {
                    tabs: vec![Tab {
                        id: 1,
                        title: "Shared".into(),
                        url: "https://example.com".into(),
                        selection_id: Some("00112233-4455-6677-8899-aabbccddeeff".into()),
                        generation: 1,
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
    }

    #[tokio::test]
    async fn authorization_and_profile_identity_are_independent_of_active_workspace() {
        let mut registry = Registry::default();
        let (first, _first_receiver) = connection("profile-one");
        let (second, _second_receiver) = connection("profile-two");
        registry.insert("first".into(), first).unwrap();
        registry.insert("second".into(), second).unwrap();
        assert!(registry
            .queue("first", 1, "Runtime.evaluate", json!({}))
            .is_err());
        share(&mut registry, "first");
        assert!(registry
            .queue("second", 1, "Runtime.evaluate", json!({}))
            .is_err());
        let (_, mut pending) = registry
            .queue("first", 1, "Runtime.evaluate", json!({}))
            .unwrap();
        assert!(registry
            .approve("first", "D:/other-workspace".into())
            .is_err());
        registry.remove("second");
        assert!(matches!(
            pending.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        registry.remove("first");
        assert!(pending.await.unwrap().is_err());
        assert!(registry
            .queue("first", 1, "Runtime.evaluate", json!({}))
            .is_err());
    }

    #[tokio::test]
    async fn replies_cannot_complete_requests_in_a_different_connection() {
        let mut registry = Registry::default();
        let (first, _first_receiver) = connection("one");
        let (second, _second_receiver) = connection("two");
        registry.insert("first".into(), first).unwrap();
        registry.insert("second".into(), second).unwrap();
        share(&mut registry, "first");
        share(&mut registry, "second");
        let (request_id, mut response) = registry
            .queue("first", 1, "Page.getFrameTree", json!({}))
            .unwrap();
        registry
            .receive(
                "second",
                protocol::Incoming::Reply {
                    id: request_id,
                    result: Some(json!("wrong")),
                    error: None,
                },
            )
            .unwrap();
        assert!(matches!(
            response.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        registry
            .receive(
                "first",
                protocol::Incoming::Reply {
                    id: request_id,
                    result: Some(json!("right")),
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(response.await.unwrap().unwrap(), json!("right"));
    }

    #[test]
    fn duplicate_profiles_and_tab_publication_before_approval_are_refused() {
        let mut registry = Registry::default();
        let (first, _receiver) = connection("one");
        registry.insert("first".into(), first).unwrap();
        let (duplicate, _duplicate_receiver) = connection("one");
        assert!(registry.insert("second".into(), duplicate).is_err());
        assert!(registry
            .receive("first", protocol::Incoming::Tabs { tabs: vec![] })
            .is_err());
    }

    #[tokio::test]
    async fn listing_tabs_does_not_grant_control_and_all_profile_actions_require_approval() {
        let mut registry = Registry::default();
        let (profile, _receiver) = connection("one");
        registry.insert("profile".into(), profile).unwrap();
        for (tab_id, method) in [
            (0, "anbo.listTabs"),
            (0, "anbo.openTab"),
            (10, "anbo.selectTab"),
            (10, "anbo.releaseTab"),
        ] {
            assert!(registry
                .queue("profile", tab_id, method, json!({}))
                .is_err());
        }
        registry.approve("profile", "D:/workspace".into()).unwrap();
        let (request_id, response) = registry
            .queue("profile", 0, "anbo.listTabs", json!({}))
            .unwrap();
        registry
            .receive(
                "profile",
                protocol::Incoming::Reply {
                    id: request_id,
                    result: Some(
                        json!([{"id":10,"title":"Available","url":"https://example.com/"}]),
                    ),
                    error: None,
                },
            )
            .unwrap();
        assert!(response.await.unwrap().is_ok());
        assert!(registry.connections["profile"].tabs.is_empty());
        assert!(registry
            .queue("profile", 10, "Runtime.evaluate", json!({}))
            .is_err());
        assert!(registry
            .queue(
                "profile",
                10,
                "anbo.selectTab",
                json!({"expectedUrl":"https://example.com/"})
            )
            .is_ok());
        assert!(registry
            .queue("profile", 10, "Runtime.evaluate", json!({}))
            .is_err());
        assert!(registry
            .queue("profile", 10, "anbo.listTabs", json!({}))
            .is_err());
        assert!(registry
            .queue("profile", 0, "anbo.selectTab", json!({}))
            .is_err());
        assert!(registry
            .queue("profile", i64::MAX, "anbo.selectTab", json!({}))
            .is_err());
    }
}

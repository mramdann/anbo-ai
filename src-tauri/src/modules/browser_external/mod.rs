#[cfg(windows)]
pub(crate) mod browser_process;
pub mod control;
pub mod dock;
#[cfg(windows)]
pub mod dock_window;
mod profile_label;
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
    /// The extension version the browser runs, once asked after approval;
    /// empty when an extension too old to answer refused the question.
    extension: Option<String>,
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

/// The extension version this build ships. Setup and the startup refresh
/// write these files, but a browser keeps running the ones it loaded.
static BUNDLED_EXTENSION: LazyLock<Option<String>> = LazyLock::new(|| {
    serde_json::from_str::<Value>(include_str!(
        "../../../../extensions/anbo-browser/manifest.json"
    ))
    .ok()
    .and_then(|manifest| manifest["version"].as_str().map(str::to_owned))
});

impl Connection {
    /// Whether the browser still runs extension files from before an update.
    fn extension_outdated(&self) -> bool {
        match (&self.extension, BUNDLED_EXTENSION.as_deref()) {
            (Some(running), Some(bundled)) => running != bundled,
            _ => false,
        }
    }
}

fn valid_extension_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 32
        && version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    connection_id: String,
    profile: Profile,
    workspace: Option<String>,
    tabs: Vec<Tab>,
    extension_outdated: bool,
}

fn ensure_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("only the main webview may manage browser connections".into());
    }
    Ok(())
}

fn changed(app: &AppHandle) {
    target::cleanup_retired(app);
    let _ = app.emit_to("main", EVENT, ());
}

impl Registry {
    /// The browser runs extension code from before an update; true when that
    /// is news.
    fn mark_extension_outdated(&mut self, connection_id: &str) -> bool {
        self.connections
            .get_mut(connection_id)
            .is_some_and(|connection| {
                let news = connection.extension.as_deref() != Some("");
                connection.extension = Some(String::new());
                news
            })
    }
}

/// A command that only older extension code refuses shows that the browser
/// still runs it, also when the manifest on disk already reports the update,
/// so the menu asks for a reload.
pub(super) fn note_outdated_extension(app: &AppHandle, connection_id: &str) {
    let news = REGISTRY
        .lock()
        .is_ok_and(|mut registry| registry.mark_extension_outdated(connection_id));
    if news {
        changed(app);
    }
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
            "anbo.listTabs" | "anbo.openTab" | "anbo.version" => tab_id == 0,
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
    client: Option<u32>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut profile: Profile =
        serde_json::from_value(handshake).map_err(|error| error.to_string())?;
    if let Err(error) = profile.validate() {
        let bytes = serde_json::to_vec(&json!({"type":"error", "message":error}))
            .map_err(|cause| cause.to_string())?;
        wire::write_frame(&mut writer, &bytes, wire::TO_BROWSER_LIMIT).await?;
        return Err(error);
    }
    if profile.name.trim().is_empty() {
        let taken: Vec<String> = REGISTRY
            .lock()
            .map_err(|_| "browser registry unavailable")?
            .connections
            .values()
            .map(|connection| connection.profile.name.clone())
            .collect();
        let browser = profile.browser.clone();
        profile.name = tauri::async_runtime::spawn_blocking(move || {
            profile_label::resolve(&browser, client, &taken)
        })
        .await
        .map_err(|error| error.to_string())?;
        // The extension shows the name Anbo chose.
        let bytes = serde_json::to_vec(&json!({"type":"profile", "name":profile.name}))
            .map_err(|cause| cause.to_string())?;
        wire::write_frame(&mut writer, &bytes, wire::TO_BROWSER_LIMIT).await?;
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
                extension: None,
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
            extension_outdated: connection.extension_outdated(),
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
    // Ask which extension version the browser runs, so the menu can ask for
    // a reload when an update has refreshed the files on disk.
    tauri::async_runtime::spawn(async move {
        let Some(version) = extension_version(&connection_id).await else {
            return;
        };
        let stored = REGISTRY.lock().is_ok_and(|mut registry| {
            registry
                .connections
                .get_mut(&connection_id)
                .map(|connection| connection.extension = Some(version))
                .is_some()
        });
        if stored {
            changed(&app);
        }
    });
    Ok(())
}

/// The version an approved extension reports; empty when it is too old to
/// know the question, and None when it could not answer at all.
async fn extension_version(connection_id: &str) -> Option<String> {
    let (request_id, receiver) = REGISTRY
        .lock()
        .ok()?
        .queue(connection_id, 0, "anbo.version", json!({}))
        .ok()?;
    let _guard = RequestGuard {
        connection_id: connection_id.into(),
        request_id,
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(Ok(reply))) => Some(
            reply["version"]
                .as_str()
                .filter(|version| valid_extension_version(version))
                .unwrap_or_default()
                .to_owned(),
        ),
        Ok(Ok(Err(_))) => Some(String::new()),
        _ => None,
    }
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
                extension: None,
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

    #[test]
    fn version_question_needs_approval_and_an_old_extension_reads_as_outdated() {
        let mut registry = Registry::default();
        let (first, _receiver) = connection("profile-one");
        registry.insert("first".into(), first).unwrap();
        assert!(registry
            .queue("first", 0, "anbo.version", json!({}))
            .is_err());
        registry.approve("first", "D:/workspace".into()).unwrap();
        assert!(registry
            .queue("first", 0, "anbo.version", json!({}))
            .is_ok());
        assert!(registry
            .queue("first", 5, "anbo.version", json!({}))
            .is_err());

        let bundled = BUNDLED_EXTENSION.clone().unwrap();
        assert!(valid_extension_version(&bundled));
        let connection = registry.connections.get_mut("first").unwrap();
        assert!(!connection.extension_outdated());
        connection.extension = Some(String::new());
        assert!(connection.extension_outdated());
        connection.extension = Some("0.4.9".into());
        assert!(connection.extension_outdated());
        connection.extension = Some(bundled);
        assert!(!connection.extension_outdated());
        assert!(!valid_extension_version("1.0<script>"));
        // Old code refusing a newer dock command marks the profile, once.
        assert!(registry.mark_extension_outdated("first"));
        assert!(registry.connections["first"].extension_outdated());
        assert!(!registry.mark_extension_outdated("first"));
        assert!(!registry.mark_extension_outdated("missing"));
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

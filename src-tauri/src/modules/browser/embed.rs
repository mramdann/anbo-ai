use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::webview::{Color, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl};
use url::Url;

use crate::modules::browser_automation::registry::{get_tab_lock, remove_tab_lock};
use crate::modules::workspace::{authorize_existing_path, WorkspaceEnv, WorkspaceRegistry};

#[cfg(windows)]
use base64::Engine;
#[cfg(windows)]
use webview2_com::{
    CapturePreviewCompletedHandler, FocusChangedEventHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
    SourceChangedEventHandler,
};
#[cfg(windows)]
use windows::Win32::{
    Foundation::{HGLOBAL, RECT},
    Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF, RGN_ERROR},
    System::Com::{
        IStream, StructuredStorage::CreateStreamOnHGlobal, STREAM_SEEK_END, STREAM_SEEK_SET,
    },
    UI::WindowsAndMessaging::{
        DestroyWindow, GetClientRect, GetPropW, IsWindow, SetPropW, SetWindowPos, ShowWindow,
        HWND_BOTTOM, HWND_TOP, SET_WINDOW_POS_FLAGS, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_SHOWNOACTIVATE,
    },
};

const BROWSER_NAV_EVENT: &str = "anbo:browser-nav";
/// Raised when a tab's page takes keyboard focus. A click inside the page lands
/// in a native child window the host document never hears about, so this is
/// the only way the shell can tell that the panel is the one being used.
#[cfg(windows)]
const BROWSER_FOCUS_EVENT: &str = "anbo:browser-focus";
pub(crate) const BROWSER_POPUP_REQUEST_EVENT: &str = "anbo:browser-popup-request";
const MAX_ACTIVE_EMBEDS: usize = 256;
const MAX_CLOSED_EMBEDS: usize = 16 * 1024;
const MAX_RELEASED_OWNERS: usize = 32 * 1024;
const MAX_VOICE_TEXT_BYTES: usize = 32 * 1024;
const MAX_PUNCH_HOLES: usize = 8;

#[cfg(any(target_os = "linux", test))]
const fn browser_child_transparent() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
struct BrowserFocusEvent {
    #[serde(rename = "tabId")]
    tab_id: i64,
    #[serde(rename = "ownerId")]
    owner_id: String,
}

#[derive(Clone, serde::Serialize)]
struct BrowserNavEvent {
    #[serde(rename = "tabId")]
    tab_id: i64,
    #[serde(rename = "ownerId")]
    owner_id: String,
    kind: &'static str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct BrowserPopupRequest {
    #[serde(rename = "sourceTabId")]
    source_tab_id: i64,
    url: String,
}

#[derive(serde::Deserialize)]
pub struct EmbedBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// A rectangular "hole" to punch out of the embedded browser's window region,
/// in physical pixels relative to the webview's own top-left corner. `None`
/// restores the full window region. Used to let a floating HTML panel (the AI
/// mini window) show through and remain interactive over the browser without
/// sinking the whole webview behind the app layer.
#[derive(serde::Deserialize, Clone, Copy)]
pub struct PunchHole {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

type EmbedKey = (i64, String);

#[derive(Clone)]
struct ActiveEmbed {
    #[cfg(windows)]
    network: Arc<crate::modules::browser_automation::network::NetworkState>,
    instance_id: String,
    owner_id: String,
    local_root: Arc<Mutex<Option<PathBuf>>>,
    loading: Arc<AtomicBool>,
    pending_url: Arc<Mutex<Option<String>>>,
    navigation_generation: Arc<AtomicU64>,
    /// Host HWND of this child, captured at spawn. Closing only queues the
    /// destroy, so this handle is the one thing that can prove it happened.
    host_window: Arc<AtomicIsize>,
    startup_reservation: Option<Arc<crate::modules::resource_guard::Reservation>>,
}

/// Lock order contract for this module. The global registry and the per-embed
/// handles inside `ActiveEmbed` are never held at the same time: read a handle
/// out of the registry, drop the registry guard, then lock the handle. Holding
/// a `local_root` guard while taking the registry, or the reverse, is what
/// deadlocked a local file preview between the page-load callback and an embed
/// update. Among the globals the order is closed_embeds, released_owners,
/// active_embeds.
static CLOSED_EMBEDS: OnceLock<Mutex<HashSet<EmbedKey>>> = OnceLock::new();
static ACTIVE_EMBEDS: OnceLock<Mutex<HashMap<i64, ActiveEmbed>>> = OnceLock::new();
static RELEASED_OWNERS: OnceLock<Mutex<HashSet<(i64, String, String)>>> = OnceLock::new();
static CURRENT_INSTANCE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static LIFECYCLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn closed_embeds() -> &'static Mutex<HashSet<EmbedKey>> {
    CLOSED_EMBEDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn active_embeds() -> &'static Mutex<HashMap<i64, ActiveEmbed>> {
    ACTIVE_EMBEDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn released_owners() -> &'static Mutex<HashSet<(i64, String, String)>> {
    RELEASED_OWNERS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn current_instance() -> &'static Mutex<Option<String>> {
    CURRENT_INSTANCE.get_or_init(|| Mutex::new(None))
}

fn bounded_insert<T: Clone + Eq + Hash>(set: &mut HashSet<T>, value: T, limit: usize) {
    if !set.contains(&value) && set.len() >= limit {
        if let Some(oldest) = set.iter().next().cloned() {
            set.remove(&oldest);
        }
    }
    set.insert(value);
}

fn validate_voice_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("voice transcript is empty".to_string());
    }
    if text.len() > MAX_VOICE_TEXT_BYTES {
        return Err(format!(
            "voice transcript exceeds {MAX_VOICE_TEXT_BYTES} bytes"
        ));
    }
    if text.contains('\0') {
        return Err("voice transcript contains a null byte".to_string());
    }
    Ok(())
}

fn validate_punch_hole_count(count: usize) -> Result<(), String> {
    if count > MAX_PUNCH_HOLES {
        return Err(format!(
            "browser punch-hole count exceeds {MAX_PUNCH_HOLES}"
        ));
    }
    Ok(())
}

pub fn embed_label(tab_id: i64) -> String {
    format!("browser-embed-{tab_id}")
}

/// Inverse of `embed_label`. A strict prefix plus an i64 parse is what keeps the
/// reconciliation sweep away from "main", "settings" and the voice window.
fn parse_embed_label(label: &str) -> Option<i64> {
    label.strip_prefix("browser-embed-")?.parse::<i64>().ok()
}

pub fn list_active_tab_ids() -> Vec<i64> {
    active_embeds()
        .lock()
        .map(|active| active.keys().copied().collect())
        .unwrap_or_default()
}

pub fn is_embed_tab_active(tab_id: i64) -> bool {
    active_embeds()
        .lock()
        .map(|active| active.contains_key(&tab_id))
        .unwrap_or(false)
}

/// Canonical workspace root attached to a live native browser tab. Automation
/// file operations use this instead of the foreground workspace so background
/// tabs cannot cross workspace boundaries.
pub fn active_local_root(tab_id: i64) -> Option<PathBuf> {
    let root = active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)?
        .local_root
        .clone();
    let resolved = root.lock().ok()?.clone();
    resolved
}

pub fn active_loading(tab_id: i64) -> Option<bool> {
    active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)
        .map(|entry| entry.loading.load(Ordering::Acquire))
}

#[cfg(windows)]
pub(crate) fn active_network(
    tab_id: i64,
) -> Option<Arc<crate::modules::browser_automation::network::NetworkState>> {
    active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)
        .map(|entry| entry.network.clone())
}

pub fn active_pending_url(tab_id: i64) -> Option<String> {
    let pending = active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)?
        .pending_url
        .clone();
    let resolved = pending.lock().ok()?.clone();
    resolved
}

pub fn active_navigation_generation(tab_id: i64) -> Option<u64> {
    active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)
        .map(|entry| entry.navigation_generation.load(Ordering::Acquire))
}

pub fn set_active_pending_url(tab_id: i64, pending_url: Option<String>) {
    let pending = active_embeds()
        .lock()
        .ok()
        .and_then(|active| active.get(&tab_id).map(|entry| entry.pending_url.clone()));
    if let Some(pending) = pending {
        if let Ok(mut current) = pending.lock() {
            *current = pending_url;
        }
    }
}

pub fn set_active_loading(tab_id: i64, loading: bool) {
    if let Ok(active) = active_embeds().lock() {
        if let Some(entry) = active.get(&tab_id) {
            entry.loading.store(loading, Ordering::Release);
        }
    }
    if !loading {
        set_active_pending_url(tab_id, None);
    }
}

pub fn clear_lifecycle_state() {
    if let Ok(mut active) = active_embeds().lock() {
        active.clear();
    }
    if let Ok(mut closed) = closed_embeds().lock() {
        closed.clear();
    }
    if let Ok(mut released) = released_owners().lock() {
        released.clear();
    }
    if let Ok(mut current) = current_instance().lock() {
        *current = None;
    }
}

fn validate_tab_id(tab_id: i64) -> Result<(), String> {
    if tab_id <= 0 {
        return Err("invalid browser tab id".into());
    }
    Ok(())
}

fn validate_token(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid browser lifecycle token".into());
    }
    Ok(())
}

fn ensure_current_instance(instance_id: &str) -> Result<(), String> {
    let current = current_instance()
        .lock()
        .map_err(|_| "browser renderer state is unavailable".to_string())?;
    if current.as_deref() != Some(instance_id) {
        return Err("stale browser renderer session".into());
    }
    Ok(())
}

fn resolve_local_root(
    registry: &WorkspaceRegistry,
    workspace_root: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = workspace_root
        .map(str::trim)
        .filter(|root| !root.is_empty())
    else {
        return Ok(None);
    };
    let canonical = authorize_existing_path(registry, root, workspace)?;
    if !canonical.is_dir() {
        return Err("browser workspace root is not a directory".into());
    }
    Ok(Some(canonical))
}

fn parse_pane_url(value: &str, local_root: Option<&Path>) -> Result<Url, String> {
    let target = Url::parse(value).map_err(|error| format!("invalid URL: {error}"))?;
    if matches!(target.scheme(), "http" | "https") {
        return Ok(target);
    }
    if target.scheme() != "file" {
        return Err("only HTTP(S) URLs and workspace files can load in the browser".into());
    }
    let root = local_root.ok_or_else(|| "local files require an active workspace".to_string())?;
    let requested = target
        .to_file_path()
        .map_err(|_| "invalid local file URL".to_string())?;
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|error| format!("local file is not accessible: {error}"))?;
    if !canonical.is_file() {
        return Err("local browser target is not a file".into());
    }
    if !canonical.starts_with(root) {
        return Err("local file is outside the active workspace".into());
    }
    Url::from_file_path(&canonical).map_err(|_| "could not create local file URL".into())
}

fn navigation_allowed(target: &Url, app_url: Option<&Url>, local_root: Option<&Path>) -> bool {
    if target.scheme() == "file" {
        let Some(root) = local_root else {
            return false;
        };
        let Ok(requested) = target.to_file_path() else {
            return false;
        };
        let Ok(canonical) = std::fs::canonicalize(requested) else {
            return false;
        };
        return canonical.is_file() && canonical.starts_with(root);
    }
    if !matches!(target.scheme(), "http" | "https") {
        return false;
    }
    !app_url.is_some_and(|app| {
        matches!(app.scheme(), "http" | "https") && target.origin() == app.origin()
    })
}

fn is_active(tab_id: i64, instance_id: &str, owner_id: Option<&str>) -> bool {
    active_embeds()
        .lock()
        .map(|active| {
            active.get(&tab_id).is_some_and(|entry| {
                entry.instance_id == instance_id
                    && owner_id.is_none_or(|owner| entry.owner_id == owner)
            })
        })
        .unwrap_or(false)
}

fn active_owner(tab_id: i64) -> Option<String> {
    active_embeds()
        .lock()
        .ok()?
        .get(&tab_id)
        .map(|entry| entry.owner_id.clone())
}

/// Local-file policy check followed by the owner lookup, with the policy guard
/// released before the registry is touched. Webview callbacks must go through
/// here: holding `local_root` across `active_owner` inverts the lock order
/// against `prepare_active_embed` and hangs the whole app.
fn page_load_owner(
    local_root: &Mutex<Option<PathBuf>>,
    url: &Url,
    app_url: Option<&Url>,
    tab_id: i64,
) -> Option<String> {
    // Copy the root out instead of validating under the guard: the file branch
    // of navigation_allowed canonicalizes on disk, and no lock here may be held
    // across blocking I/O. That hold is why a local file preview, not an http
    // page, is what surfaced the original deadlock.
    let root = local_root.lock().ok().and_then(|root| root.clone());
    if !navigation_allowed(url, app_url, root.as_deref()) {
        return None;
    }
    active_owner(tab_id)
}

fn physical_rect(
    bounds: &EmbedBounds,
) -> Result<(PhysicalPosition<i32>, PhysicalSize<i32>), String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite()) {
        return Err("browser bounds must be finite".into());
    }
    if bounds.x < 0.0 || bounds.y < 0.0 || bounds.width < 1.0 || bounds.height < 1.0 {
        return Err("browser bounds must have a non-negative position and positive size".into());
    }
    if values.iter().any(|value| *value > i32::MAX as f64) {
        return Err("browser bounds are too large".into());
    }
    Ok((
        PhysicalPosition::new(bounds.x.round() as i32, bounds.y.round() as i32),
        PhysicalSize::new(bounds.width.round() as i32, bounds.height.round() as i32),
    ))
}

fn should_process_update(bounds: &EmbedBounds, _visible: bool) -> bool {
    bounds.width >= 1.0 && bounds.height >= 1.0
}

fn ensure_main_window(window: &tauri::Window) -> Result<(), String> {
    ensure_main_window_label(window.label())
}

fn ensure_main_window_label(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("browser panes can only be controlled by the main window".into());
    }
    Ok(())
}

#[cfg(test)]
mod privilege_tests {
    use super::ensure_main_window_label;

    #[test]
    fn privileged_browser_ipc_rejects_non_main_windows() {
        assert!(ensure_main_window_label("main").is_ok());
        assert!(ensure_main_window_label("settings").is_err());
        assert!(ensure_main_window_label("browser-embed-7").is_err());
    }
}

#[allow(clippy::too_many_arguments)] // One call site; splitting it would only hide the wiring.
async fn spawn_browser_child(
    window: &tauri::Window,
    tab_id: i64,
    target: Url,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<i32>,
    visible: bool,
    local_root: Arc<Mutex<Option<PathBuf>>>,
    host_window: Arc<AtomicIsize>,
) -> Result<(), String> {
    let app = window.app_handle();
    let reservation = Arc::new(crate::modules::resource_guard::reserve(
        crate::modules::resource_guard::Workload::Browser,
    )?);
    let app_url = app
        .get_webview(window.label())
        .and_then(|webview| webview.url().ok());
    let navigation_app_url = app_url.clone();
    let popup_app_url = app_url.clone();
    let event_app_url = app_url.clone();
    let title_app_url = app_url.clone();
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let title_app = app.clone();
    let browser_data_dir = super::data::profile_dir(app)?;
    let navigation_local_root = local_root.clone();
    let popup_local_root = local_root.clone();
    let event_local_root = local_root.clone();
    let title_local_root = local_root.clone();
    let loading = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .get(&tab_id)
        .map(|entry| entry.loading.clone())
        .ok_or_else(|| "browser lifecycle state is unavailable".to_string())?;
    let event_loading = loading;
    let event_pending_url = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .get(&tab_id)
        .map(|entry| entry.pending_url.clone())
        .ok_or_else(|| "browser lifecycle state is unavailable".to_string())?;
    let event_navigation_generation = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .get(&tab_id)
        .map(|entry| entry.navigation_generation.clone())
        .ok_or_else(|| "browser lifecycle state is unavailable".to_string())?;
    #[cfg(windows)]
    let initial_url = Url::parse("about:blank").map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    let initial_url = target;
    let builder = WebviewBuilder::new(embed_label(tab_id), WebviewUrl::External(initial_url))
        // Wry 0.55.1 can fail creation when MoveFocus targets an unfocusable host.
        .focused(false)
        .data_directory(browser_data_dir)
        // Opaque background so a not-yet-painted webview (new tab, mid-load) shows
        // a solid color instead of a transparent hole through to the desktop.
        .background_color(Color(255, 255, 255, 255))
        .initialization_script(include_str!("consoleCapture.js"));
    #[cfg(target_os = "linux")]
    let builder = builder.transparent(browser_child_transparent());
    #[cfg(not(target_os = "linux"))]
    let builder = builder;
    let builder = builder
        .on_navigation(move |target| {
            let root = navigation_local_root
                .lock()
                .ok()
                .and_then(|root| root.clone());
            navigation_allowed(target, navigation_app_url.as_ref(), root.as_deref())
        })
        .on_new_window(move |target, _features| {
            let root = popup_local_root.lock().ok().and_then(|root| root.clone());
            if navigation_allowed(&target, popup_app_url.as_ref(), root.as_deref()) {
                let _ = popup_app.emit(
                    BROWSER_POPUP_REQUEST_EVENT,
                    BrowserPopupRequest {
                        source_tab_id: tab_id,
                        url: target.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let Some(owner_id) = page_load_owner(
                &event_local_root,
                payload.url(),
                event_app_url.as_ref(),
                tab_id,
            ) else {
                return;
            };
            let kind = match payload.event() {
                PageLoadEvent::Started => {
                    crate::modules::browser_automation::activity::navigation(&webview);
                    event_loading.store(true, Ordering::Release);
                    event_navigation_generation.fetch_add(1, Ordering::AcqRel);
                    if let Ok(mut pending_url) = event_pending_url.lock() {
                        *pending_url = Some(payload.url().to_string());
                    }
                    "navigated"
                }
                PageLoadEvent::Finished => {
                    crate::modules::browser_automation::activity::navigation(&webview);
                    crate::modules::browser_automation::activity::restore(&webview);
                    event_loading.store(false, Ordering::Release);
                    if let Ok(mut pending_url) = event_pending_url.lock() {
                        *pending_url = None;
                    }
                    "loaded"
                }
            };
            let _ = navigation_app.emit(
                BROWSER_NAV_EVENT,
                BrowserNavEvent {
                    tab_id,
                    owner_id,
                    kind,
                    url: payload.url().to_string(),
                    title: None,
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            let Ok(url) = webview.url() else {
                return;
            };
            let Some(owner_id) =
                page_load_owner(&title_local_root, &url, title_app_url.as_ref(), tab_id)
            else {
                return;
            };
            let _ = title_app.emit(
                BROWSER_NAV_EVENT,
                BrowserNavEvent {
                    tab_id,
                    owner_id,
                    kind: "title",
                    url: url.to_string(),
                    title: Some(title),
                },
            );
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    return crate::modules::browser_automation::download::on_download_requested(
                        tab_id,
                        url.as_str(),
                        destination,
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    crate::modules::browser_automation::download::on_download_finished(
                        tab_id,
                        url.as_str(),
                        path,
                        success,
                    );
                }
                _ => {}
            }
            true
        });

    window
        .add_child(builder, position, size)
        .map_err(|error| error.to_string())?;
    if let Some(entry) = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state unavailable")?
        .get_mut(&tab_id)
    {
        entry.startup_reservation = Some(reservation);
    }
    if let Some(webview) = window.app_handle().get_webview(&embed_label(tab_id)) {
        // The host process is shared by every tab, so this only does work once.
        #[cfg(windows)]
        super::host::adopt_from_webview(&webview);
        // Record the child window while it certainly exists. Closing later only
        // queues the destroy, so this handle is the only way to observe that it
        // actually happened.
        #[cfg(windows)]
        if let Ok(hwnd) = webview_parent_hwnd(&webview) {
            mark_child_window(hwnd, &host_window);
            host_window.store(hwnd, Ordering::Release);
        }
        #[cfg(not(windows))]
        let _ = &host_window;
        #[cfg(windows)]
        register_focus_handler(&webview, tab_id);
        #[cfg(windows)]
        register_source_handler(&webview, tab_id, app_url, local_root);
        set_embed_presentation(&webview, visible)?;
        #[cfg(windows)]
        {
            if let Some(network) = active_network(tab_id) {
                crate::modules::browser_automation::network::install(&webview, network).await;
            }
            webview
                .navigate(target)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Have WebView2 tell the shell whenever this tab's page takes focus.
///
/// The registration token is dropped on purpose: the handler should live as
/// long as the controller does, and removing it early would only bring back
/// the silence this exists to end.
#[cfg(windows)]
fn register_focus_handler(webview: &tauri::Webview, tab_id: i64) {
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |platform| {
        let handler = FocusChangedEventHandler::create(Box::new(move |_sender, _args| {
            if let Some(owner_id) = active_owner(tab_id) {
                let _ = app.emit(BROWSER_FOCUS_EVENT, BrowserFocusEvent { tab_id, owner_id });
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = unsafe { platform.controller().add_GotFocus(&handler, &mut token) };
    });
}

#[cfg(windows)]
fn register_source_handler(
    webview: &tauri::Webview,
    tab_id: i64,
    app_url: Option<Url>,
    local_root: Arc<Mutex<Option<PathBuf>>>,
) {
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |platform| {
        let register = || -> windows::core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            let handler = SourceChangedEventHandler::create(Box::new(move |sender, _args| {
                let (Some(core), Some(owner_id)) = (sender, active_owner(tab_id)) else {
                    return Ok(());
                };
                let mut source = windows::core::PWSTR::null();
                unsafe { core.Source(&mut source)? };
                let source = webview2_com::take_pwstr(source);
                let Ok(url) = Url::parse(&source) else {
                    return Ok(());
                };
                let allowed = local_root.lock().ok().is_some_and(|root| {
                    navigation_allowed(&url, app_url.as_ref(), root.as_deref())
                });
                if allowed {
                    let _ = app.emit(
                        BROWSER_NAV_EVENT,
                        BrowserNavEvent {
                            tab_id,
                            owner_id,
                            kind: "source",
                            url: url.to_string(),
                            title: None,
                        },
                    );
                }
                Ok(())
            }));
            let mut token = 0;
            unsafe { core.add_SourceChanged(&handler, &mut token) }
        };
        if let Err(error) = register() {
            log::warn!("browser source observer could not be registered: {error}");
        }
    });
}

#[cfg(windows)]
type SnapshotResult = Result<Vec<u8>, String>;

#[cfg(windows)]
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

#[cfg(windows)]
type SnapshotSender = Arc<Mutex<Option<tokio::sync::oneshot::Sender<SnapshotResult>>>>;

#[cfg(windows)]
fn finish_snapshot(sender: &SnapshotSender, result: SnapshotResult) {
    if let Ok(mut sender) = sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

#[cfg(windows)]
fn read_snapshot_stream(stream: &IStream) -> SnapshotResult {
    unsafe {
        let mut size = 0_u64;
        stream
            .Seek(0, STREAM_SEEK_END, Some(&mut size))
            .map_err(|error| error.to_string())?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|error| error.to_string())?;
        let size =
            usize::try_from(size).map_err(|_| "browser snapshot is too large".to_string())?;
        if size > MAX_PREVIEW_BYTES {
            return Err("browser snapshot exceeds 8 MiB limit".to_string());
        }
        let mut bytes = vec![0_u8; size];
        let mut read = 0_u32;
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                u32::try_from(size).map_err(|_| "browser snapshot is too large".to_string())?,
                Some(&mut read),
            )
            .ok()
            .map_err(|error| error.to_string())?;
        bytes.truncate(read as usize);
        Ok(bytes)
    }
}

#[cfg(windows)]
async fn capture_preview_with_timeout(
    webview: tauri::Webview,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<SnapshotResult>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let platform_sender = sender.clone();

    webview
        .with_webview(move |platform| {
            let capture = (|| -> Result<(), String> {
                let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
                    .map_err(|error| error.to_string())?;
                let callback_stream = stream.clone();
                let callback_sender = platform_sender.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    let capture = result
                        .map_err(|error| error.to_string())
                        .and_then(|_| read_snapshot_stream(&callback_stream));
                    finish_snapshot(&callback_sender, capture);
                    Ok(())
                }));
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                unsafe {
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
                        &stream,
                        &handler,
                    )
                }
                .map_err(|error| error.to_string())
            })();
            if let Err(error) = capture {
                finish_snapshot(&platform_sender, Err(error));
            }
        })
        .map_err(|error| error.to_string())?;

    let bytes = tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "browser snapshot timed out".to_string())?
        .map_err(|_| "browser snapshot was cancelled".to_string())??;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(windows)]
async fn capture_preview(webview: tauri::Webview) -> Result<String, String> {
    capture_preview_with_timeout(webview, std::time::Duration::from_millis(500)).await
}

#[cfg(windows)]
fn overlay_insert_after(active: bool, main_webview: isize) -> isize {
    if active {
        main_webview
    } else {
        HWND_TOP.0 as isize
    }
}

#[cfg(windows)]
fn webview_parent_hwnd(webview: &tauri::Webview) -> Result<isize, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let mut hwnd = windows::Win32::Foundation::HWND::default();
            let result = unsafe { platform.controller().ParentWindow(&mut hwnd) }
                .map(|_| hwnd.0 as isize)
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|_| "timed out reading browser host window".to_string())?
}

#[cfg(windows)]
fn set_ui_overlay_z_order(
    webview: &tauri::Webview,
    main_webview: &tauri::Webview,
    active: bool,
) -> Result<(), String> {
    let insert_after = overlay_insert_after(active, webview_parent_hwnd(main_webview)?);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let controller = platform.controller();
                let mut hwnd = windows::Win32::Foundation::HWND::default();
                unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|error| error.to_string())?;
                unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(windows::Win32::Foundation::HWND(
                            insert_after as *mut std::ffi::c_void,
                        )),
                        0,
                        0,
                        0,
                        0,
                        SWP_ASYNCWINDOWPOS
                            | SWP_NOACTIVATE
                            | SWP_NOMOVE
                            | SWP_NOOWNERZORDER
                            | SWP_NOSIZE,
                    )
                }
                .map_err(|error| error.to_string())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|_| "timed out updating browser z-order".to_string())?
}

#[cfg(windows)]
fn embed_insert_after(visible: bool) -> windows::Win32::Foundation::HWND {
    if visible {
        HWND_TOP
    } else {
        HWND_BOTTOM
    }
}

#[cfg(windows)]
fn embed_window_pos_flags(visible: bool) -> SET_WINDOW_POS_FLAGS {
    let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSIZE;
    if visible {
        flags | SWP_NOMOVE
    } else {
        flags
    }
}

#[cfg(windows)]
fn set_embed_z_order(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let controller = platform.controller();
                let mut hwnd = windows::Win32::Foundation::HWND::default();
                unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|error| error.to_string())?;
                let (x, y) = if visible {
                    (0, 0)
                } else {
                    let mut bounds = RECT::default();
                    unsafe { GetClientRect(hwnd, &mut bounds) }
                        .map_err(|error| error.to_string())?;
                    super::presentation::background_origin(bounds.right.saturating_sub(bounds.left))
                };
                unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(embed_insert_after(visible)),
                        x,
                        y,
                        0,
                        0,
                        embed_window_pos_flags(visible),
                    )
                }
                .map_err(|error| error.to_string())?;
                if unsafe { SetWindowRgn(hwnd, None, true) } == 0 {
                    return Err("failed to clear browser presentation region".to_string());
                }
                let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
                if let Err(error) = unsafe { controller.NotifyParentWindowPositionChanged() } {
                    log::warn!("could not refresh browser presentation: {error}");
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|_| "timed out updating browser presentation".to_string())?
}

#[cfg(windows)]
fn set_embed_presentation(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
    // Hiding or empty-clipping the host can stall native input even while its
    // controller is visible. Park it outside the parent's client area instead.
    webview.show().map_err(|error| error.to_string())?;
    set_embed_z_order(webview, visible)?;
    crate::modules::browser_automation::activity::presentation(webview, visible);
    Ok(())
}

#[cfg(windows)]
pub fn refresh_webview_presentation(webview: &tauri::Webview) -> Result<(), String> {
    webview
        .with_webview(|platform| {
            let controller = platform.controller();
            if let Err(error) = unsafe { controller.NotifyParentWindowPositionChanged() } {
                log::warn!("could not refresh WebView2 presentation: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub fn refresh_webview_presentation(_webview: &tauri::Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn set_embed_presentation(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
    if visible {
        webview.show().map_err(|error| error.to_string())
    } else {
        webview.hide().map_err(|error| error.to_string())
    }
}

/// Clips the embedded browser's window region around floating HTML surfaces.
/// Hole coordinates use physical pixels relative to the webview's origin. An
/// empty list restores the complete browser region.
#[cfg(windows)]
async fn apply_punch_holes(webview: &tauri::Webview, holes: Vec<PunchHole>) -> Result<(), String> {
    // Await the webview-thread result on a tokio oneshot instead of blocking a
    // worker thread with a synchronous mpsc recv. This command runs per-frame
    // while a floating surface is dragged, so it must not stall the runtime.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let controller = platform.controller();
                let mut hwnd = windows::Win32::Foundation::HWND::default();
                unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|e| e.to_string())?;

                let region = if holes.is_empty() {
                    None
                } else {
                    let mut client = RECT::default();
                    unsafe { GetClientRect(hwnd, &mut client) }.map_err(|e| e.to_string())?;
                    let full = unsafe { CreateRectRgn(0, 0, client.right, client.bottom) };
                    for h in holes {
                        let left = h.x.max(0);
                        let top = h.y.max(0);
                        let right = (h.x + h.width).min(client.right).max(left);
                        let bottom = (h.y + h.height).min(client.bottom).max(top);
                        if right <= left || bottom <= top {
                            continue;
                        }
                        let hole = unsafe { CreateRectRgn(left, top, right, bottom) };
                        let kind =
                            unsafe { CombineRgn(Some(full), Some(full), Some(hole), RGN_DIFF) };
                        let _ = unsafe { DeleteObject(hole.into()) };
                        if kind == RGN_ERROR {
                            let _ = unsafe { DeleteObject(full.into()) };
                            return Err("failed to compute browser punch-hole region".to_string());
                        }
                    }
                    Some(full)
                };

                // SetWindowRgn returns nonzero on success and then takes ownership of
                // the region. On failure we still own it and must free it ourselves.
                let ok = unsafe { SetWindowRgn(hwnd, region, true) };
                if ok == 0 {
                    if let Some(r) = region {
                        let _ = unsafe { DeleteObject(r.into()) };
                    }
                    return Err("SetWindowRgn rejected the browser punch-hole region".to_string());
                }
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(1), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("browser punch-hole channel closed".to_string()),
        Err(_) => Err("timed out applying browser punch-hole".to_string()),
    }
}

#[tauri::command]
pub async fn browser_embed_set_ui_overlay(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    active: bool,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(());
        }
        let Some(webview) = app.get_webview(&embed_label(tab_id)) else {
            return Ok(());
        };
        webview
    };

    #[cfg(windows)]
    {
        let main_webview = app
            .get_webview(window.label())
            .ok_or_else(|| "main webview is unavailable".to_string())?;
        set_ui_overlay_z_order(&webview, &main_webview, active)
    }

    #[cfg(not(windows))]
    {
        let _ = (webview, active);
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_embed_set_punch_hole(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    holes: Vec<PunchHole>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    validate_punch_hole_count(holes.len())?;
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(());
        }
        let Some(webview) = app.get_webview(&embed_label(tab_id)) else {
            return Ok(());
        };
        webview
    };

    #[cfg(windows)]
    return apply_punch_holes(&webview, holes).await;

    #[cfg(not(windows))]
    {
        let _ = webview;
        let _ = holes
            .into_iter()
            .map(|hole| (hole.x, hole.y, hole.width, hole.height))
            .collect::<Vec<_>>();
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_embed_set_zoom(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    zoom: f64,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    ensure_current_instance(&instance_id)?;
    if !is_active(tab_id, &instance_id, Some(&owner_id)) {
        return Ok(());
    }
    let Some(webview) = app.get_webview(&embed_label(tab_id)) else {
        return Ok(());
    };
    // `set_zoom` scales the native WebView2 surface directly. Applying
    // `document.body.style.zoom` on top of it would compound the scale
    // (1.1 -> ~1.21x), so we rely on the native zoom alone.
    webview.set_zoom(zoom).map_err(|e| e.to_string())?;
    Ok(())
}

/// Emulate a device viewport, or clear the emulation when `width` is zero.
///
/// This overrides what the page believes it is being shown in rather than
/// resizing the native child. A site's own breakpoints, `matchMedia` and
/// `visualViewport` all follow the override, which is the whole point: a
/// letterboxed child window would look the same and prove nothing.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportRequest {
    /// Zero clears the emulation and hands the page back its real size.
    width: u32,
    height: u32,
    scale: f64,
    mobile: bool,
    /// Shrinks the rendered result so a viewport wider than the pane is shown
    /// whole instead of cropped. 1.0 renders at full size.
    fit_scale: Option<f64>,
}

#[tauri::command]
pub async fn browser_embed_set_viewport(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    viewport: ViewportRequest,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let ViewportRequest {
        width,
        height,
        scale,
        mobile,
        fit_scale,
    } = viewport;
    let fit_scale = fit_scale.unwrap_or(1.0);
    if !(0.05..=1.0).contains(&fit_scale) {
        return Err("viewport fit is outside the supported range".to_string());
    }
    if width > 0 && (height == 0 || width > MAX_VIEWPORT_EDGE || height > MAX_VIEWPORT_EDGE) {
        return Err("viewport is outside the supported range".to_string());
    }
    if !(0.1..=4.0).contains(&scale) {
        return Err("viewport scale is outside the supported range".to_string());
    }
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(());
        }
        let Some(webview) = app.get_webview(&embed_label(tab_id)) else {
            return Ok(());
        };
        webview
    };
    apply_viewport(&webview, width, height, scale, mobile, fit_scale).await
}

/// Widest viewport we will ask a page to lay out at. Well past any real device,
/// and low enough that a typo cannot ask WebView2 for a surface it will refuse.
const MAX_VIEWPORT_EDGE: u32 = 10_000;

#[cfg(windows)]
pub(crate) async fn apply_viewport(
    webview: &tauri::Webview,
    width: u32,
    height: u32,
    scale: f64,
    mobile: bool,
    fit_scale: f64,
) -> Result<(), String> {
    use crate::modules::browser_automation::cdp::call_devtools_protocol_method;
    const CDP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    let (method, params) = if width == 0 {
        ("Emulation.clearDeviceMetricsOverride", "{}".to_string())
    } else {
        (
            "Emulation.setDeviceMetricsOverride",
            serde_json::json!({
                // Zoom divides the override, so the page ends up laying out at
                // `width / fit`. Pre-multiplying by the same factor lands it
                // back on exactly `width`: a full desktop layout, painted small
                // enough to be seen whole in a narrow pane.
                "width": ((width as f64) * fit_scale).round().max(1.0) as u32,
                "height": ((height as f64) * fit_scale).round().max(1.0) as u32,
                "deviceScaleFactor": scale,
                "mobile": mobile,
            })
            .to_string(),
        )
    };
    call_devtools_protocol_method(webview, method, &params, CDP_TIMEOUT).await?;
    // WebView2's own zoom control fights the fit: a Ctrl+scroll or Ctrl+minus
    // rewrites the zoom this function just set, and nothing re-asserts it until
    // the next resize or navigation. Take the control away while emulating and
    // hand it back when the emulation is cleared.
    set_zoom_control(webview, width == 0);
    // WebView2 honours neither the metrics override's own `scale` field nor
    // Emulation.setPageScaleFactor; both were measured leaving cssVisualViewport
    // at scale 1. Native zoom is the one control that does shrink the painted
    // result, and because the override pins the layout width the page still
    // lays out as the device while being drawn small enough to be seen whole.
    let _ = webview.set_zoom(if width > 0 { fit_scale } else { 1.0 });
    // Touch has to follow the device, or a phone viewport keeps answering
    // hover-only media queries and sites serve their desktop behaviour anyway.
    let touch = serde_json::json!({
        "enabled": width > 0 && mobile,
        "maxTouchPoints": if mobile { 5 } else { 1 },
    })
    .to_string();
    let _ = call_devtools_protocol_method(
        webview,
        "Emulation.setTouchEmulationEnabled",
        &touch,
        CDP_TIMEOUT,
    )
    .await;
    Ok(())
}

/// Tabs whose built-in zoom is currently switched off.
#[cfg(windows)]
static ZOOM_DISABLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Enable or disable the browser's built-in Ctrl+scroll / Ctrl+/- zoom.
///
/// `with_webview` queues onto the main thread, and this runs on every re-fit,
/// which includes every settled resize. Repeating a setting that already holds
/// would put main-thread work on the path that once turned a workspace switch
/// into a whole-desktop stall, so only an actual change is worth dispatching.
#[cfg(windows)]
fn set_zoom_control(webview: &tauri::Webview, enabled: bool) {
    let label = webview.label().to_string();
    {
        let disabled = ZOOM_DISABLED.get_or_init(|| Mutex::new(HashSet::new()));
        let Ok(mut disabled) = disabled.lock() else {
            return;
        };
        let changed = if enabled {
            disabled.remove(&label)
        } else {
            disabled.insert(label)
        };
        if !changed {
            return;
        }
    }
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let Ok(settings) = (unsafe { core.Settings() }) else {
            return;
        };
        // Losing this is a papercut, never a reason to refuse the emulation.
        let _ = unsafe { settings.SetIsZoomControlEnabled(enabled) };
    });
}

#[cfg(not(windows))]
pub(crate) async fn apply_viewport(
    _webview: &tauri::Webview,
    _width: u32,
    _height: u32,
    _scale: f64,
    _mobile: bool,
    _fit_scale: f64,
) -> Result<(), String> {
    Err("device emulation requires WebView2".to_string())
}

type PreparedEmbed = (
    Arc<Mutex<Option<PathBuf>>>,
    Arc<AtomicBool>,
    Arc<Mutex<Option<String>>>,
    Arc<AtomicIsize>,
);

/// Registry side of an update: reuse this tab's shared handles when they exist,
/// otherwise create them, and record the entry. Caller holds LIFECYCLE_LOCK.
fn prepare_active_embed(
    tab_id: i64,
    instance_id: &str,
    owner_id: &str,
    resolved_local_root: Option<PathBuf>,
) -> Result<PreparedEmbed, String> {
    let active = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
    if !active.contains_key(&tab_id) && active.len() >= MAX_ACTIVE_EMBEDS {
        return Err("browser embed limit reached".to_string());
    }
    let mine = |entry: &&ActiveEmbed| entry.instance_id == instance_id;
    let local_root = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.local_root.clone())
        .unwrap_or_else(|| Arc::new(Mutex::new(None)));
    let loading = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.loading.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(true)));
    let pending_url = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.pending_url.clone())
        .unwrap_or_else(|| Arc::new(Mutex::new(None)));
    let navigation_generation = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.navigation_generation.clone())
        .unwrap_or_else(|| Arc::new(AtomicU64::new(0)));
    let host_window = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.host_window.clone())
        .unwrap_or_else(|| Arc::new(AtomicIsize::new(0)));
    let startup_reservation = active
        .get(&tab_id)
        .filter(mine)
        .and_then(|entry| entry.startup_reservation.clone());
    #[cfg(windows)]
    let network = active
        .get(&tab_id)
        .filter(mine)
        .map(|entry| entry.network.clone())
        .unwrap_or_default();
    // Release the registry before writing the local-file policy. Holding both
    // is the lock-order inversion that hung a local preview: the page-load
    // callback takes the policy lock first and the registry second. The caller
    // holds LIFECYCLE_LOCK, so re-taking the registry cannot interleave with
    // another prepare for this tab, and the policy is still written before the
    // entry becomes visible.
    drop(active);
    *local_root
        .lock()
        .map_err(|_| "browser local-file policy is unavailable".to_string())? = resolved_local_root;
    active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .insert(
            tab_id,
            ActiveEmbed {
                #[cfg(windows)]
                network,
                instance_id: instance_id.to_string(),
                owner_id: owner_id.to_string(),
                local_root: local_root.clone(),
                loading: loading.clone(),
                pending_url: pending_url.clone(),
                navigation_generation,
                host_window: host_window.clone(),
                startup_reservation,
            },
        );
    Ok((local_root, loading, pending_url, host_window))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes these as named invoke arguments.
pub async fn browser_embed_update(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceRegistry>,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    url: String,
    workspace_root: Option<String>,
    workspace: Option<WorkspaceEnv>,
    bounds: EmbedBounds,
    visible: bool,
    effects_enabled: Option<bool>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    // Per tab, the way browser_embed_navigate and browser_embed_close already do
    // it, and always taken before LIFECYCLE_LOCK so the order stays consistent.
    let tab_lock = get_tab_lock(tab_id);
    let _tab_lock = tab_lock.lock().await;
    let label = embed_label(tab_id);

    let workspace = WorkspaceEnv::from_option(workspace);
    let resolved_local_root = resolve_local_root(&registry, workspace_root.as_deref(), &workspace)?;

    // LIFECYCLE_LOCK guards the registries and nothing else. It used to be held
    // across the main-thread round trips further down, which turned one busy
    // main thread into an app-wide stall: every browser and automation command
    // queues behind this single mutex. Switching workspace flips visibility on
    // every mounted pane at once, which is exactly when that convoy forms.
    // Scoped so the std MutexGuard is provably gone before any await below:
    // the command future has to stay Send.
    let prepared = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;

        if closed_embeds()
            .lock()
            .map(|closed| closed.contains(&(tab_id, instance_id.clone())))
            .unwrap_or(true)
        {
            return Ok(());
        }
        if released_owners()
            .lock()
            .map(|released| released.contains(&(tab_id, instance_id.clone(), owner_id.clone())))
            .unwrap_or(true)
        {
            return Ok(());
        }

        if !should_process_update(&bounds, visible) {
            None
        } else {
            Some(prepare_active_embed(
                tab_id,
                &instance_id,
                &owner_id,
                resolved_local_root,
            )?)
        }
    };

    let Some((local_root, loading, pending_url, host_window)) = prepared else {
        if is_active(tab_id, &instance_id, Some(&owner_id)) {
            if let Some(webview) = app.get_webview(&label) {
                set_embed_presentation(&webview, false)?;
            }
        }
        return Ok(());
    };
    crate::modules::browser_automation::activity::set_enabled(
        &app,
        tab_id,
        effects_enabled.unwrap_or(true),
    );

    let target = if url.is_empty() {
        None
    } else {
        let root = local_root
            .lock()
            .map_err(|_| "browser local-file policy is unavailable".to_string())?;
        Some(parse_pane_url(&url, root.as_deref())?)
    };

    let (position, size) = physical_rect(&bounds)?;
    #[cfg(windows)]
    let position = if visible {
        position
    } else {
        let (x, y) = super::presentation::background_origin(size.width);
        PhysicalPosition::new(x, y)
    };
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_bounds(Rect {
                position: position.into(),
                size: size.into(),
            })
            .map_err(|error| error.to_string())?;
        set_embed_presentation(&webview, visible)?;
        return Ok(());
    }

    let Some(target) = target else {
        return Ok(());
    };
    loading.store(true, Ordering::Release);
    *pending_url
        .lock()
        .map_err(|_| "browser navigation state is unavailable".to_string())? =
        Some(target.to_string());
    let result = spawn_browser_child(
        &window,
        tab_id,
        target,
        position,
        size,
        visible,
        local_root,
        host_window,
    )
    .await;
    if result.is_err() {
        loading.store(false, Ordering::Release);
        if let Ok(mut pending) = pending_url.lock() {
            *pending = None;
        }
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes these as named invoke arguments.
pub async fn browser_embed_navigate(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: tauri::State<'_, WorkspaceRegistry>,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    url: String,
    workspace_root: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let tab_lock = get_tab_lock(tab_id);
    let _tab_lock = tab_lock.lock().await;
    let workspace = WorkspaceEnv::from_option(workspace);
    let resolved_local_root = resolve_local_root(&registry, workspace_root.as_deref(), &workspace)?;
    let (webview, local_root) = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(());
        }
        let local_root = active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?
            .get(&tab_id)
            .map(|entry| entry.local_root.clone())
            .ok_or_else(|| "browser lifecycle state is unavailable".to_string())?;
        *local_root
            .lock()
            .map_err(|_| "browser local-file policy is unavailable".to_string())? =
            resolved_local_root;
        (app.get_webview(&embed_label(tab_id)), local_root)
    };
    let target = {
        let root = local_root
            .lock()
            .map_err(|_| "browser local-file policy is unavailable".to_string())?;
        parse_pane_url(&url, root.as_deref())?
    };
    if let Some(webview) = webview {
        set_active_loading(tab_id, true);
        set_active_pending_url(tab_id, Some(target.to_string()));
        if let Err(error) = webview.navigate(target) {
            set_active_loading(tab_id, false);
            set_active_pending_url(tab_id, None);
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_dispatch(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    action: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let tab_lock = get_tab_lock(tab_id);
    let _tab_lock = tab_lock.lock().await;
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(());
        }
        app.get_webview(&embed_label(tab_id))
    };
    let Some(webview) = webview else {
        return Ok(());
    };
    if action == "reload" {
        set_active_loading(tab_id, true);
        set_active_pending_url(
            tab_id,
            webview.url().ok().map(|current| current.to_string()),
        );
        if let Err(error) = webview.reload() {
            set_active_loading(tab_id, false);
            return Err(error.to_string());
        }
        return Ok(());
    }
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "stop" => "window.stop()",
        other => return Err(format!("unknown browser action: {other}")),
    };
    if action == "stop" {
        set_active_loading(tab_id, false);
    } else {
        set_active_loading(tab_id, true);
    }
    if let Err(error) = webview.eval(script) {
        set_active_loading(tab_id, false);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_url(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
) -> Result<Option<String>, String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    ensure_current_instance(&instance_id)?;
    if !is_active(tab_id, &instance_id, Some(&owner_id)) {
        return Ok(None);
    }
    app.get_webview(&embed_label(tab_id))
        .map(|webview| webview.url().map(|url| url.to_string()))
        .transpose()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_embed_insert_text(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    text: String,
) -> Result<bool, String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    validate_voice_text(&text)?;
    let tab_lock = get_tab_lock(tab_id);
    let _tab_lock = tab_lock.lock().await;
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(false);
        }
        app.get_webview(&embed_label(tab_id))
    };
    let Some(webview) = webview else {
        return Ok(false);
    };

    #[cfg(windows)]
    {
        let focused = crate::modules::browser_automation::cdp::execute_script_with_timeout(
            &webview,
            r#"(() => {
                let doc = document;
                let el = doc.activeElement;
                if (!el) return "none";
                while (el instanceof HTMLIFrameElement) {
                    try {
                        doc = el.contentDocument;
                        if (!doc) return "frame";
                        el = doc.activeElement;
                        if (!el) return "none";
                    } catch {
                        return "frame";
                    }
                }
                const tag = el.tagName?.toLowerCase();
                if (tag === "input") {
                    if (el.type === "password") return "password";
                    return ["text", "search", "email", "url", "tel"].includes(el.type) ? "editable" : "none";
                }
                if (tag === "textarea" || el.isContentEditable) return "editable";
                return "none";
            })()"#,
            std::time::Duration::from_secs(2),
        )
        .await?;
        let focused = serde_json::from_str::<String>(&focused).unwrap_or_default();
        match focused.as_str() {
            "password" => {
                return Err("AnboVoice does not insert text into password fields".to_string())
            }
            "editable" => {}
            "frame" => return Ok(false),
            _ => return Ok(false),
        }
        webview.set_focus().map_err(|error| error.to_string())?;
        let params = serde_json::json!({ "text": text }).to_string();
        crate::modules::browser_automation::cdp::call_devtools_protocol_method(
            &webview,
            "Input.insertText",
            &params,
            std::time::Duration::from_secs(2),
        )
        .await?;
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        let text = serde_json::to_string(&text).map_err(|error| error.to_string())?;
        let script = format!(
            r#"(() => {{
                const el = document.activeElement;
                if (!el || (el instanceof HTMLInputElement && el.type === "password")) return;
                const text = {text};
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {{
                    const start = el.selectionStart ?? el.value.length;
                    const end = el.selectionEnd ?? start;
                    el.setRangeText(text, start, end, "end");
                    el.dispatchEvent(new InputEvent("input", {{ bubbles: true, data: text, inputType: "insertText" }}));
                }} else if (el.isContentEditable) {{
                    document.execCommand("insertText", false, text);
                }}
            }})()"#
        );
        webview.eval(&script).map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn browser_embed_snapshot(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
) -> Result<Option<String>, String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        if !is_active(tab_id, &instance_id, Some(&owner_id)) {
            return Ok(None);
        }
    }
    let Some(webview) = app.get_webview(&embed_label(tab_id)) else {
        return Ok(None);
    };

    #[cfg(windows)]
    return capture_preview(webview).await.map(Some);

    #[cfg(not(windows))]
    {
        let _ = webview;
        Ok(None)
    }
}

#[tauri::command]
pub async fn browser_embed_suspend(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let tab_lock = get_tab_lock(tab_id);
    let _tab_lock = tab_lock.lock().await;
    let webview = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        is_active(tab_id, &instance_id, Some(&owner_id))
            .then(|| app.get_webview(&embed_label(tab_id)))
            .flatten()
    };
    if let Some(webview) = webview {
        set_embed_presentation(&webview, false)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_suspend_all_presentations(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let tab_ids = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?
            .keys()
            .copied()
            .collect::<Vec<_>>()
    };
    for tab_id in tab_ids {
        let tab_lock = get_tab_lock(tab_id);
        let _tab_lock = tab_lock.lock().await;
        if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
            if let Err(error) = set_embed_presentation(&webview, false) {
                log::error!("failed to suspend browser presentation {tab_id}: {error}");
                return Err(error);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_release(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    validate_token(&owner_id)?;
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    ensure_current_instance(&instance_id)?;
    let mut released = released_owners()
        .lock()
        .map_err(|_| "browser owner state is unavailable".to_string())?;
    bounded_insert(
        &mut released,
        (tab_id, instance_id.clone(), owner_id.clone()),
        MAX_RELEASED_OWNERS,
    );
    drop(released);
    if is_active(tab_id, &instance_id, Some(&owner_id)) {
        if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_begin_session(
    app: tauri::AppHandle,
    window: tauri::Window,
    instance_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_token(&instance_id)?;
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    let is_new_session;
    {
        let mut current = current_instance()
            .lock()
            .map_err(|_| "browser renderer state is unavailable".to_string())?;
        is_new_session = current.as_deref() != Some(&instance_id);
        *current = Some(instance_id.clone());
    }

    let stale_tabs = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .iter()
        .filter(|(_, entry)| entry.instance_id != instance_id)
        .map(|(tab_id, _)| *tab_id)
        .collect::<Vec<_>>();
    for tab_id in stale_tabs {
        if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
            let _ = webview.hide();
            webview.close().map_err(|error| error.to_string())?;
        }
        active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?
            .remove(&tab_id);
        crate::modules::browser_automation::download::remove_tab(tab_id);
        crate::modules::browser_automation::snapshot::remove_generation(tab_id);
        crate::modules::browser_automation::activity::remove(tab_id);
        remove_tab_lock(tab_id);
    }
    if is_new_session {
        closed_embeds()
            .lock()
            .map_err(|_| "browser close state is unavailable".to_string())?
            .clear();
        released_owners()
            .lock()
            .map_err(|_| "browser owner state is unavailable".to_string())?
            .clear();
    }
    Ok(())
}

/// Wait for a browser child's host window to actually disappear.
///
/// `Webview::close()` returns as soon as the destroy is queued on the event
/// loop and drops the label from the manager immediately, so its `Ok` says
/// nothing about the child. The window handle does.
#[cfg(windows)]
async fn child_window_destroyed(raw_hwnd: isize, budget: std::time::Duration) -> bool {
    if raw_hwnd == 0 {
        // Never observed a handle, so nothing can be claimed either way.
        return false;
    }
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        // Rebuilt per poll on purpose: a raw HWND is not Send and must never be
        // held across the await below.
        let alive = {
            let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut std::ffi::c_void);
            unsafe { IsWindow(Some(hwnd)) }.as_bool()
        };
        if !alive {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[cfg(not(windows))]
async fn child_window_destroyed(_raw_hwnd: isize, _budget: std::time::Duration) -> bool {
    true
}

/// Destroy a stranded child window directly.
///
/// Once `Webview::close()` has run, the label is gone from the Tauri manager and
/// no handle in the app can reach that child again. The window handle recorded
/// at spawn is the only remaining way to reach it, and `DestroyWindow` has to
/// run on the thread that owns the window, which is the main thread.
#[cfg(windows)]
fn mark_child_window(raw_hwnd: isize, owner: &Arc<AtomicIsize>) {
    // Properties disappear when Windows destroys the HWND. Keep the Arc alive
    // through close so its address cannot be reused while fallback is queued.
    let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut std::ffi::c_void);
    let marker = windows::Win32::Foundation::HANDLE(Arc::as_ptr(owner) as *mut std::ffi::c_void);
    if let Err(error) = unsafe {
        SetPropW(
            hwnd,
            windows::core::w!("Anbo.BrowserChildOwner"),
            Some(marker),
        )
    } {
        log::warn!("browser child ownership marker unavailable: {error}");
    }
}

#[cfg(windows)]
async fn force_destroy_child(
    app: &tauri::AppHandle,
    raw_hwnd: isize,
    owner: Option<Arc<AtomicIsize>>,
) -> bool {
    if raw_hwnd == 0 {
        return false;
    }
    let Some(owner) = owner else {
        return false;
    };
    let requested = app
        .run_on_main_thread(move || {
            let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut std::ffi::c_void);
            let marker = unsafe { GetPropW(hwnd, windows::core::w!("Anbo.BrowserChildOwner")) };
            if marker.0 == Arc::as_ptr(&owner) as *mut std::ffi::c_void
                && unsafe { IsWindow(Some(hwnd)) }.as_bool()
            {
                let _ = unsafe { DestroyWindow(hwnd) };
            }
        })
        .is_ok();
    if !requested {
        return false;
    }
    child_window_destroyed(raw_hwnd, std::time::Duration::from_secs(2)).await
}

#[cfg(not(windows))]
async fn force_destroy_child(
    _app: &tauri::AppHandle,
    _raw_hwnd: isize,
    _owner: Option<Arc<AtomicIsize>>,
) -> bool {
    true
}

fn child_is_absent(has_webview: bool, recorded_window: Option<isize>) -> bool {
    !has_webview && recorded_window.is_none()
}

async fn close_embed_locked(
    app: &tauri::AppHandle,
    tab_id: i64,
    instance_id: &str,
) -> Result<bool, String> {
    let host_window = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(instance_id)?;
        bounded_insert(
            &mut *closed_embeds()
                .lock()
                .map_err(|_| "browser close state is unavailable".to_string())?,
            (tab_id, instance_id.to_string()),
            MAX_CLOSED_EMBEDS,
        );
        released_owners()
            .lock()
            .map_err(|_| "browser owner state is unavailable".to_string())?
            .retain(|(id, _, _)| *id != tab_id);
        active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?
            .get(&tab_id)
            .map(|entry| entry.host_window.clone())
    };
    let webview = app.get_webview(&embed_label(tab_id));
    let recorded = host_window.as_ref().map(|h| h.load(Ordering::Acquire));
    let existed = !child_is_absent(webview.is_some(), recorded);
    let outcome = async {
        if !existed {
            return Ok(());
        }
        let mut raw = recorded.unwrap_or(0);
        #[cfg(windows)]
        if raw == 0 {
            if let Some(webview) = &webview {
                raw = webview_parent_hwnd(webview)?;
                if let Some(handle) = &host_window {
                    mark_child_window(raw, handle);
                    handle.store(raw, Ordering::Release);
                }
            }
        }
        #[cfg(not(windows))]
        let _ = &mut raw;
        if let Some(webview) = webview {
            webview.close().map_err(|error| error.to_string())?;
        }
        if child_window_destroyed(raw, std::time::Duration::from_secs(3)).await
            || force_destroy_child(app, raw, host_window.clone()).await
        {
            Ok(())
        } else {
            Err(format!(
                "browser embed {tab_id} close did not destroy its window in time"
            ))
        }
    }
    .await;

    {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(instance_id)?;
        if outcome.is_ok() {
            active_embeds()
                .lock()
                .map_err(|_| "browser lifecycle state is unavailable".to_string())?
                .remove(&tab_id);
        } else if let Ok(mut closed) = closed_embeds().lock() {
            closed.remove(&(tab_id, instance_id.to_string()));
        }
    }
    if outcome.is_ok() {
        crate::modules::browser_automation::download::remove_tab(tab_id);
        crate::modules::browser_automation::snapshot::remove_generation(tab_id);
        crate::modules::browser_automation::activity::remove(tab_id);
    }
    outcome.map(|()| existed)
}

/// Receives all browser tabs across every workspace, with the allocator high-water mark.
#[tauri::command]
pub async fn browser_embed_reconcile(
    app: tauri::AppHandle,
    window: tauri::Window,
    instance_id: String,
    live_tab_ids: Vec<i64>,
    max_tab_id: i64,
) -> Result<usize, String> {
    ensure_main_window(&window)?;
    validate_token(&instance_id)?;
    let strays: Vec<i64> = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        let live: HashSet<i64> = live_tab_ids.into_iter().collect();
        let closed = closed_embeds()
            .lock()
            .map_err(|_| "browser close state is unavailable".to_string())?;
        let active = active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
        let mut candidates: HashSet<i64> = app
            .webviews()
            .keys()
            .filter_map(|label| parse_embed_label(label))
            .collect();
        candidates.extend(active.keys().copied());
        candidates
            .into_iter()
            .filter(|tab_id| {
                *tab_id <= max_tab_id
                    && !live.contains(tab_id)
                    && !closed.contains(&(*tab_id, instance_id.clone()))
            })
            .collect()
    };

    let mut reaped = 0;
    for tab_id in strays {
        let tab_lock = get_tab_lock(tab_id);
        let _tab_lock = tab_lock.lock().await;
        // Re-read current ownership and handle after queueing behind close/update.
        match close_embed_locked(&app, tab_id, &instance_id).await {
            Ok(true) => {
                reaped += 1;
                log::info!("reconciled stray browser embed {tab_id}");
            }
            Ok(false) => {}
            Err(error) => log::warn!("could not reconcile browser embed {tab_id}: {error}"),
        }
    }
    Ok(reaped)
}

#[tauri::command]
pub async fn browser_embed_close(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    validate_tab_id(tab_id)?;
    validate_token(&instance_id)?;
    let tab_lock = get_tab_lock(tab_id);
    let result = {
        let _tab_lock = tab_lock.lock().await;
        close_embed_locked(&app, tab_id, &instance_id).await
    };
    remove_tab_lock(tab_id);
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_insert, browser_child_transparent, navigation_allowed, parse_pane_url,
        physical_rect, should_process_update, validate_punch_hole_count, validate_voice_text,
        EmbedBounds, MAX_PUNCH_HOLES, MAX_VOICE_TEXT_BYTES,
    };
    use std::collections::HashSet;
    use url::Url;

    #[test]
    fn a_reconciled_child_is_absent_but_a_missing_handle_is_not_proof() {
        assert!(super::child_is_absent(false, None));
        assert!(!super::child_is_absent(false, Some(0)));
        assert!(!super::child_is_absent(false, Some(123)));
        assert!(!super::child_is_absent(true, None));
    }

    #[test]
    fn renderer_owner_transfer_retains_live_native_handles_and_loading_state() {
        use std::sync::{atomic::Ordering, Arc};
        let id = 991_340;
        let first = super::prepare_active_embed(id, "same-instance", "old-owner", None).unwrap();
        first.1.store(false, Ordering::Release);
        first.3.store(123, Ordering::Release);
        *first.2.lock().unwrap() = Some("https://example.test/pending".into());
        let next = super::prepare_active_embed(id, "same-instance", "new-owner", None).unwrap();
        assert!(Arc::ptr_eq(&first.1, &next.1));
        assert!(Arc::ptr_eq(&first.2, &next.2));
        assert!(Arc::ptr_eq(&first.3, &next.3));
        assert!(!next.1.load(Ordering::Acquire));
        assert_eq!(next.3.load(Ordering::Acquire), 123);
        let fresh = super::prepare_active_embed(id, "new-instance", "new-owner", None).unwrap();
        assert!(!Arc::ptr_eq(&first.3, &fresh.3));
        super::active_embeds().lock().unwrap().remove(&id);
    }

    /// The two lock-order tests below deliberately hold one of the real locks,
    /// so they must not observe each other.
    static LOCK_ORDER_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Regression: an embed update used to keep the registry locked while it
    /// waited for `local_root`, which deadlocked against a page-load callback
    /// that held `local_root` and wanted the registry. Bounded, so a
    /// reintroduced inversion fails the test instead of hanging the runner.
    #[test]
    fn an_embed_update_never_holds_the_registry_while_waiting_for_local_root() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let _serial = LOCK_ORDER_TEST.lock().unwrap_or_else(|e| e.into_inner());
        let id = 991_342;
        let prepared = super::prepare_active_embed(id, "iso", "owner", None).unwrap();
        let local_root = prepared.0.clone();
        // Stands in for a page-load callback sitting inside the policy lock.
        let held = local_root.lock().unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = started_tx.send(());
            let outcome = super::prepare_active_embed(id, "iso", "next-owner", None);
            let _ = done_tx.send(outcome.is_ok());
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(100));

        let mut registry_free = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if super::active_embeds().try_lock().is_ok() {
                registry_free = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let finished_early = done_rx.try_recv().is_ok();
        // Release before asserting so a regression fails this test alone rather
        // than poisoning the shared locks for every other test in the binary.
        drop(held);
        assert!(
            registry_free,
            "the embed update held the registry while waiting for local_root"
        );
        assert!(
            !finished_early,
            "the update finished early, so it never waited on the policy lock"
        );
        assert!(done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the update finished once the policy lock was released"));
        worker.join().unwrap();
        super::active_embeds().lock().unwrap().remove(&id);
    }

    /// Regression for the other half of the cycle: the page-load lookup must
    /// drop the policy guard before it asks the registry for the owner.
    #[test]
    fn the_page_load_lookup_releases_the_policy_lock_before_the_registry() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let _serial = LOCK_ORDER_TEST.lock().unwrap_or_else(|e| e.into_inner());
        let id = 991_343;
        let prepared = super::prepare_active_embed(id, "iso", "owner", None).unwrap();
        let local_root = prepared.0.clone();
        // Stands in for an embed update sitting inside the registry.
        let held = super::active_embeds().lock().unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let probe_root = local_root.clone();
        let worker = std::thread::spawn(move || {
            let url = Url::parse("https://example.test/page").unwrap();
            let _ = started_tx.send(());
            let _ = done_tx.send(super::page_load_owner(&probe_root, &url, None, id));
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(100));

        let mut policy_free = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if local_root.try_lock().is_ok() {
                policy_free = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let finished_early = done_rx.try_recv().is_ok();
        // Release before asserting, same reason as the test above.
        drop(held);
        assert!(
            policy_free,
            "the page-load lookup held local_root while waiting for the registry"
        );
        assert!(
            !finished_early,
            "the lookup finished early, so it never waited on the registry"
        );
        let owner = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the lookup finished once the registry was released");
        assert_eq!(owner.as_deref(), Some("owner"));
        worker.join().unwrap();
        super::active_embeds().lock().unwrap().remove(&id);
    }

    #[test]
    fn accepts_http_and_https_urls() {
        assert!(parse_pane_url("http://localhost:3000", None).is_ok());
        assert!(parse_pane_url("https://example.com/path", None).is_ok());
    }

    #[test]
    fn native_browser_transparency_is_linux_only() {
        assert_eq!(browser_child_transparent(), cfg!(target_os = "linux"));
    }

    #[test]
    fn bounded_lifecycle_set_never_exceeds_its_limit() {
        let mut values = HashSet::new();
        bounded_insert(&mut values, 1, 2);
        bounded_insert(&mut values, 2, 2);
        bounded_insert(&mut values, 3, 2);
        assert_eq!(values.len(), 2);
        assert!(values.contains(&3));
    }

    #[test]
    fn voice_text_validation_is_bounded_and_rejects_null_bytes() {
        assert!(validate_voice_text("open ANBO.md").is_ok());
        assert!(validate_voice_text("   ").is_err());
        assert!(validate_voice_text("bad\0text").is_err());
        assert!(validate_voice_text(&"a".repeat(MAX_VOICE_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn browser_punch_holes_are_bounded() {
        assert!(validate_punch_hole_count(MAX_PUNCH_HOLES).is_ok());
        assert!(validate_punch_hole_count(MAX_PUNCH_HOLES + 1).is_err());
    }

    #[test]
    fn hidden_preview_with_bounds_still_processes_navigation() {
        let bounds = EmbedBounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(should_process_update(&bounds, false));
    }

    #[cfg(windows)]
    #[test]
    fn ui_overlay_moves_preview_behind_then_restores_it() {
        use windows::Win32::UI::WindowsAndMessaging::HWND_TOP;

        let main_webview = 42;
        assert_eq!(
            super::overlay_insert_after(true, main_webview),
            main_webview
        );
        assert_eq!(
            super::overlay_insert_after(false, main_webview),
            HWND_TOP.0 as isize
        );
    }

    #[cfg(windows)]
    #[test]
    fn background_embed_is_parked_without_activation_or_resize() {
        use windows::Win32::UI::WindowsAndMessaging::{
            HWND_BOTTOM, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        assert_eq!(super::embed_insert_after(false), HWND_BOTTOM);
        assert_eq!(super::embed_insert_after(true), HWND_TOP);
        for visible in [false, true] {
            let flags = super::embed_window_pos_flags(visible).0;
            assert_eq!(flags & SWP_ASYNCWINDOWPOS.0, 0);
            assert_ne!(flags & SWP_NOACTIVATE.0, 0);
            assert_ne!(flags & SWP_NOSIZE.0, 0);
            assert_eq!(flags & SWP_NOMOVE.0 != 0, visible);
        }
    }

    #[test]
    fn rejects_active_content_schemes_and_unscoped_files() {
        assert!(parse_pane_url("javascript:alert(1)", None).is_err());
        assert!(parse_pane_url("data:text/html,hello", None).is_err());
        assert!(parse_pane_url("file:///tmp/report.html", None).is_err());
    }

    #[test]
    fn local_files_are_limited_to_the_workspace_root() {
        let root = tempfile::tempdir().expect("workspace root");
        let outside = tempfile::tempdir().expect("outside root");
        let inside_file = root.path().join("index.html");
        let outside_file = outside.path().join("secret.html");
        std::fs::write(&inside_file, "<h1>inside</h1>").expect("inside fixture");
        std::fs::write(&outside_file, "<h1>outside</h1>").expect("outside fixture");
        let canonical_root = std::fs::canonicalize(root.path()).expect("canonical root");
        let inside_url = Url::from_file_path(&inside_file).expect("inside URL");
        let outside_url = Url::from_file_path(&outside_file).expect("outside URL");

        assert!(parse_pane_url(inside_url.as_str(), Some(&canonical_root)).is_ok());
        assert!(parse_pane_url(outside_url.as_str(), Some(&canonical_root)).is_err());
        assert!(navigation_allowed(&inside_url, None, Some(&canonical_root)));
        assert!(!navigation_allowed(
            &outside_url,
            None,
            Some(&canonical_root)
        ));
    }

    #[test]
    fn navigation_rejects_non_web_and_app_origins() {
        let app = Url::parse("http://localhost:1420/app").unwrap();
        assert!(!navigation_allowed(
            &Url::parse("javascript:alert(1)").unwrap(),
            Some(&app),
            None,
        ));
        assert!(!navigation_allowed(
            &Url::parse("http://localhost:1420/recursive").unwrap(),
            Some(&app),
            None,
        ));
        assert!(navigation_allowed(
            &Url::parse("https://example.com").unwrap(),
            Some(&app),
            None,
        ));
    }

    #[test]
    fn popup_routing_rejects_blank_bootstrap_and_accepts_web_targets() {
        assert!(!navigation_allowed(
            &Url::parse("about:blank").unwrap(),
            None,
            None,
        ));
        assert!(navigation_allowed(
            &Url::parse("https://www.youtube.com/").unwrap(),
            None,
            None,
        ));
    }

    #[test]
    fn rejects_invalid_bounds() {
        assert!(physical_rect(&EmbedBounds {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 100.0,
        })
        .is_err());
        assert!(physical_rect(&EmbedBounds {
            x: -1.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        })
        .is_err());
    }
}

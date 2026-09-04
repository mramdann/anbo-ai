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
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
};
#[cfg(windows)]
use windows::Win32::{
    Foundation::{HGLOBAL, RECT},
    Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF, RGN_ERROR},
    System::Com::{
        IStream, StructuredStorage::CreateStreamOnHGlobal, STREAM_SEEK_END, STREAM_SEEK_SET,
    },
    UI::WindowsAndMessaging::{
        DestroyWindow, GetClientRect, IsWindow, SetWindowPos, ShowWindow, HWND_BOTTOM, HWND_TOP,
        SET_WINDOW_POS_FLAGS,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_HIDE,
        SW_SHOWNOACTIVATE,
    },
};

const BROWSER_NAV_EVENT: &str = "anbo:browser-nav";
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
    instance_id: String,
    owner_id: String,
    local_root: Arc<Mutex<Option<PathBuf>>>,
    loading: Arc<AtomicBool>,
    pending_url: Arc<Mutex<Option<String>>>,
    navigation_generation: Arc<AtomicU64>,
    /// Host HWND of this child, captured at spawn. Closing only queues the
    /// destroy, so this handle is the one thing that can prove it happened.
    host_window: Arc<AtomicIsize>,
}

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
fn spawn_browser_child(
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
    let app_url = app
        .get_webview(window.label())
        .and_then(|webview| webview.url().ok());
    let navigation_app_url = app_url.clone();
    let popup_app_url = app_url.clone();
    let event_app_url = app_url.clone();
    let title_app_url = app_url;
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let title_app = app.clone();
    let browser_data_dir = super::data::profile_dir(app)?;
    let navigation_local_root = local_root.clone();
    let popup_local_root = local_root.clone();
    let event_local_root = local_root.clone();
    let title_local_root = local_root;
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
    let builder = WebviewBuilder::new(embed_label(tab_id), WebviewUrl::External(target))
        .data_directory(browser_data_dir)
        // Opaque background so a not-yet-painted webview (new tab, mid-load) shows
        // a solid color instead of a transparent hole through to the desktop.
        .background_color(Color(255, 255, 255, 255))
        .initialization_script(
            r#"
            (() => {
            const anboLogs = Array.isArray(window.__anboLogs) ? window.__anboLogs : [];
            window.__anboLogs = anboLogs;
            const syncAnboLogs = () => {
                try {
                    document.documentElement?.setAttribute(
                        'data-anbo-console-logs',
                        JSON.stringify(anboLogs.slice(-50))
                    );
                } catch (_) {}
            };
            if (!document.documentElement) {
                document.addEventListener('DOMContentLoaded', syncAnboLogs, { once: true });
            }
            const safeStringify = (arg) => {
                try {
                    if (arg === null || typeof arg !== 'object') return String(arg).slice(0, 2000);
                    if (arg instanceof Error) {
                        return `${String(arg.name || 'Error')}: ${String(arg.message || '').slice(0, 1500)}${
                            arg.stack ? `\n${String(arg.stack).slice(0, 2000)}` : ''
                        }`.slice(0, 2000);
                    }
                    const result = {};
                    for (const key of Object.keys(arg).slice(0, 20)) {
                        const value = arg[key];
                        result[String(key).slice(0, 100)] =
                            value === null || typeof value !== 'object'
                                ? String(value).slice(0, 500)
                                : Object.prototype.toString.call(value);
                    }
                    return JSON.stringify(result).slice(0, 2000);
                } catch (e) { return Object.prototype.toString.call(arg).slice(0, 2000); }
            };
            const recordAnboLog = (level, message) => {
                anboLogs.push({
                    level: String(level || 'info').slice(0, 16),
                    msg: String(message || '').slice(0, 4000),
                    ts: Date.now()
                });
                if (anboLogs.length > 50) anboLogs.shift();
                syncAnboLogs();
            };
            const origLog = console.log;
            console.log = function(...args) {
                recordAnboLog('info', args.slice(0, 20).map(safeStringify).join(' '));
                origLog.apply(console, args);
            };
            const origErr = console.error;
            console.error = function(...args) {
                recordAnboLog('error', args.slice(0, 20).map(safeStringify).join(' '));
                origErr.apply(console, args);
            };
            window.addEventListener('error', event => {
                const location = event.filename
                    ? ` at ${String(event.filename).slice(0, 1000)}:${Number(event.lineno) || 0}:${Number(event.colno) || 0}`
                    : '';
                const message = String(event.message || 'runtime error').slice(0, 3000);
                recordAnboLog('error', `${message.startsWith('Uncaught') ? '' : 'Uncaught '}${message}${location}`);
            });
            window.addEventListener('unhandledrejection', event => {
                recordAnboLog('error', `Unhandled promise rejection: ${safeStringify(event.reason)}`);
            });
            syncAnboLogs();
            })();
            "#,
        );
    #[cfg(target_os = "linux")]
    let builder = builder.transparent(browser_child_transparent());
    #[cfg(not(target_os = "linux"))]
    let builder = builder;
    let builder = builder
        .on_navigation(move |target| {
            let root = navigation_local_root.lock().ok();
            navigation_allowed(
                target,
                navigation_app_url.as_ref(),
                root.as_deref().and_then(Option::as_deref),
            )
        })
        .on_new_window(move |target, _features| {
            let root = popup_local_root.lock().ok();
            if navigation_allowed(
                &target,
                popup_app_url.as_ref(),
                root.as_deref().and_then(Option::as_deref),
            ) {
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
        .on_page_load(move |_webview, payload| {
            let root = event_local_root.lock().ok();
            if !navigation_allowed(
                payload.url(),
                event_app_url.as_ref(),
                root.as_deref().and_then(Option::as_deref),
            ) {
                return;
            }
            let Some(owner_id) = active_owner(tab_id) else {
                return;
            };
            let kind = match payload.event() {
                PageLoadEvent::Started => {
                    event_loading.store(true, Ordering::Release);
                    event_navigation_generation.fetch_add(1, Ordering::AcqRel);
                    if let Ok(mut pending_url) = event_pending_url.lock() {
                        *pending_url = Some(payload.url().to_string());
                    }
                    "navigated"
                }
                PageLoadEvent::Finished => {
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
            let Some(owner_id) = active_owner(tab_id) else {
                return;
            };
            let Ok(url) = webview.url() else {
                return;
            };
            let root = title_local_root.lock().ok();
            if !navigation_allowed(
                &url,
                title_app_url.as_ref(),
                root.as_deref().and_then(Option::as_deref),
            ) {
                return;
            }
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
    if let Some(webview) = window.app_handle().get_webview(&embed_label(tab_id)) {
        // The host process is shared by every tab, so this only does work once.
        #[cfg(windows)]
        super::host::adopt_from_webview(&webview);
        // Record the child window while it certainly exists. Closing later only
        // queues the destroy, so this handle is the only way to observe that it
        // actually happened.
        #[cfg(windows)]
        if let Ok(hwnd) = webview_parent_hwnd(&webview) {
            host_window.store(hwnd, Ordering::Release);
        }
        #[cfg(not(windows))]
        let _ = &host_window;
        set_embed_presentation(&webview, visible)?;
    }
    Ok(())
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
fn embed_window_pos_flags() -> SET_WINDOW_POS_FLAGS {
    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOOWNERZORDER | SWP_NOSIZE
}

#[cfg(windows)]
fn embed_should_clip(visible: bool) -> bool {
    !visible
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
                if embed_should_clip(visible) {
                    // Windows can discard a child window region while restoring
                    // its transparent parent. Clear WS_VISIBLE on the host HWND
                    // as the durable guard; the WebView2 controller itself stays
                    // alive because we do not call controller.put_IsVisible(false).
                    let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
                }
                let region = if embed_should_clip(visible) {
                    Some(unsafe { CreateRectRgn(0, 0, 0, 0) })
                } else {
                    None
                };
                let clipped = unsafe { SetWindowRgn(hwnd, region, true) };
                if clipped == 0 {
                    if let Some(region) = region {
                        let _ = unsafe { DeleteObject(region.into()) };
                    }
                    return Err("failed to update browser presentation region".to_string());
                }
                unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(embed_insert_after(visible)),
                        0,
                        0,
                        0,
                        0,
                        embed_window_pos_flags(),
                    )
                }
                .map_err(|error| error.to_string())?;
                if visible {
                    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
                    if let Err(error) = unsafe { controller.NotifyParentWindowPositionChanged() } {
                        log::warn!("could not refresh browser presentation: {error}");
                    }
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
    // Keep WebView2's controller visible so background pages, audio, and CDP
    // automation continue running. Merely sinking the child HWND to the bottom
    // leaks its pixels during Windows' restore animation, before the main
    // transparent webview has composed. The host HWND stays natively hidden
    // (while its WebView2 controller keeps running) until the frontend reports
    // its settled visible bounds; the empty region is a second paint guard.
    webview.show().map_err(|error| error.to_string())?;
    set_embed_z_order(webview, visible)
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
    let mut active = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
    if !active.contains_key(&tab_id) && active.len() >= MAX_ACTIVE_EMBEDS {
        return Err("browser embed limit reached".to_string());
    }
    let mine =
        |entry: &&ActiveEmbed| entry.instance_id == instance_id && entry.owner_id == owner_id;
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
    *local_root
        .lock()
        .map_err(|_| "browser local-file policy is unavailable".to_string())? =
        resolved_local_root;
    active.insert(
        tab_id,
        ActiveEmbed {
            instance_id: instance_id.to_string(),
            owner_id: owner_id.to_string(),
            local_root: local_root.clone(),
            loading: loading.clone(),
            pending_url: pending_url.clone(),
            navigation_generation,
            host_window: host_window.clone(),
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
                webview.hide().map_err(|error| error.to_string())?;
            }
        }
        return Ok(());
    };


    let target = if url.is_empty() {
        None
    } else {
        let root = local_root
            .lock()
            .map_err(|_| "browser local-file policy is unavailable".to_string())?;
        Some(parse_pane_url(&url, root.as_deref())?)
    };

    let (position, size) = physical_rect(&bounds)?;
    if let Some(webview) = app.get_webview(&label) {
        if let Some(target) = target {
            // webview.url() posts to the main thread and waits on an UNBOUNDED
            // channel receive. This runs while LIFECYCLE_LOCK is held, so a
            // wedged main thread would stall every other browser and automation
            // command behind it, permanently. Bound the wait and let the caller
            // retry instead of holding the lock for everyone.
            let probe = webview.clone();
            let current = match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                tauri::async_runtime::spawn_blocking(move || probe.url()),
            )
            .await
            {
                Ok(Ok(Ok(url))) => url,
                Ok(Ok(Err(error))) => return Err(error.to_string()),
                Ok(Err(error)) => return Err(error.to_string()),
                Err(_) => return Err("timed out reading the browser URL".to_string()),
            };
            if current != target {
                loading.store(true, Ordering::Release);
                if let Ok(mut pending) = pending_url.lock() {
                    *pending = Some(target.to_string());
                }
                if let Err(error) = webview.navigate(target) {
                    loading.store(false, Ordering::Release);
                    if let Ok(mut pending) = pending_url.lock() {
                        *pending = None;
                    }
                    return Err(error.to_string());
                }
            }
        }
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
    spawn_browser_child(
        &window,
        tab_id,
        target,
        position,
        size,
        visible,
        local_root,
        host_window,
    )
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
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    ensure_current_instance(&instance_id)?;
    if is_active(tab_id, &instance_id, Some(&owner_id)) {
        if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_embed_suspend_all_presentations(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    let tab_ids = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?
        .keys()
        .copied()
        .collect::<Vec<_>>();
    for tab_id in tab_ids {
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
async fn force_destroy_child(app: &tauri::AppHandle, raw_hwnd: isize) -> bool {
    if raw_hwnd == 0 {
        return false;
    }
    let requested = app
        .run_on_main_thread(move || {
            let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut std::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
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
async fn force_destroy_child(_app: &tauri::AppHandle, _raw_hwnd: isize) -> bool {
    true
}

/// Destroy browser children the renderer no longer has a tab for.
///
/// `Webview::close()` returns once the destroy is queued and forgets the label
/// immediately, so any close that never reached the event loop leaves a child
/// nothing in Anbo can reach again. This is the backstop that turns such a miss
/// from permanent into transient.
///
/// The caller must send EVERY browser tab it holds, across every space,
/// including inactive spaces, background-hosted and cold tabs. Anything
/// narrower would destroy exactly the background tabs the product keeps alive
/// on purpose. `max_tab_id` is the renderer's id high-water mark: ids above it
/// belong to tabs being created right now and are never candidates.
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

    // Registry work only, so the closes below never run under the global lock.
    let strays: Vec<(i64, isize)> = {
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        let live: HashSet<i64> = live_tab_ids.into_iter().collect();
        let closed = closed_embeds()
            .lock()
            .map_err(|_| "browser close state is unavailable".to_string())?;
        let active = active_embeds()
            .lock()
            .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
        // Two sources, because neither alone is complete. The manager knows the
        // children it still tracks; the registry knows the window handle of a
        // child whose close was already dispatched and whose label the manager
        // has therefore forgotten. Only the second can reach a stranded child.
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
            .map(|tab_id| {
                let handle = active
                    .get(&tab_id)
                    .map(|entry| entry.host_window.load(Ordering::Acquire))
                    .unwrap_or(0);
                (tab_id, handle)
            })
            .collect()
    };

    let mut reaped = 0_usize;
    for (tab_id, host_window) in strays {
        let tab_lock = get_tab_lock(tab_id);
        let _tab_lock = tab_lock.lock().await;
        // Never abort the loop on one failure: the rest are still strays.
        if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
            if let Err(error) = webview.close() {
                log::warn!("could not reconcile stray browser embed {tab_id}: {error}");
                continue;
            }
        }
        let gone = child_window_destroyed(host_window, std::time::Duration::from_secs(2)).await
            || force_destroy_child(&app, host_window).await
            || host_window == 0;
        if gone {
            reaped += 1;
            if let Ok(mut active) = active_embeds().lock() {
                active.remove(&tab_id);
            }
            log::info!("reconciled stray browser embed {tab_id}");
        } else {
            log::warn!("stray browser embed {tab_id} survived reconciliation");
        }
    }
    if reaped > 0 {
        log::info!("browser reconciliation destroyed {reaped} stray embed(s)");
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
    {
        let _tab_lock = tab_lock.lock().await;
        let _lifecycle = LIFECYCLE_LOCK.lock().await;
        ensure_current_instance(&instance_id)?;
        // Scoped: this std guard must be provably gone before the await below,
        // or the command future stops being Send.
        {
            let mut closed = closed_embeds()
                .lock()
                .map_err(|_| "browser close state is unavailable".to_string())?;
            bounded_insert(
                &mut closed,
                (tab_id, instance_id.clone()),
                MAX_CLOSED_EMBEDS,
            );
        }
        released_owners()
            .lock()
            .map_err(|_| "browser owner state is unavailable".to_string())?
            .retain(|(released_tab_id, _, _)| *released_tab_id != tab_id);
        // Close whatever handle still exists, whether or not the registry
        // agrees this tab is ours. The old is_active gate turned a stale entry
        // into a permanently live child, and the registry entry used to be
        // erased even when the lookup found nothing to close, throwing away the
        // last record that the tab ever existed.
        let host_window = active_embeds()
            .lock()
            .ok()
            .and_then(|active| active.get(&tab_id).map(|entry| entry.host_window.clone()));
        let requested = match app.get_webview(&embed_label(tab_id)) {
            Some(webview) => match webview.close() {
                Ok(()) => true,
                Err(error) => {
                    // Keep the entry so a later sweep can still find this tab.
                    log::warn!("browser embed {tab_id} did not close: {error}");
                    false
                }
            },
            None => true,
        };
        if requested {
            let raw = host_window
                .map(|handle| handle.load(Ordering::Acquire))
                .unwrap_or(0);
            if child_window_destroyed(raw, std::time::Duration::from_secs(3)).await {
                active_embeds()
                    .lock()
                    .map_err(|_| "browser lifecycle state is unavailable".to_string())?
                    .remove(&tab_id);
            } else if force_destroy_child(&app, raw).await {
                // The queued destroy never ran, but the recorded window handle
                // still reaches the child. This is the only path that can, since
                // close() already dropped the label from the manager.
                log::info!("browser embed {tab_id} destroyed through its window handle");
                active_embeds()
                    .lock()
                    .map_err(|_| "browser lifecycle state is unavailable".to_string())?
                    .remove(&tab_id);
            } else {
                // Keep the registry entry, which still holds the handle, and take
                // the tab back out of the closed set so reconciliation can retry
                // instead of reporting a success that never happened.
                log::warn!("browser embed {tab_id} close did not destroy its window in time");
                if let Ok(mut closed) = closed_embeds().lock() {
                    closed.retain(|(closed_tab_id, _)| *closed_tab_id != tab_id);
                }
            }
        }
    }
    remove_tab_lock(tab_id);
    crate::modules::browser_automation::download::remove_tab(tab_id);
    crate::modules::browser_automation::snapshot::remove_generation(tab_id);
    Ok(())
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
    fn suppressed_embed_keeps_controller_alive_but_has_no_host_paint() {
        use windows::Win32::UI::WindowsAndMessaging::{HWND_BOTTOM, HWND_TOP, SWP_ASYNCWINDOWPOS};

        assert_eq!(super::embed_insert_after(false), HWND_BOTTOM);
        assert_eq!(super::embed_insert_after(true), HWND_TOP);
        assert_eq!(super::embed_window_pos_flags().0 & SWP_ASYNCWINDOWPOS.0, 0);
        assert!(super::embed_should_clip(false));
        assert!(!super::embed_should_clip(true));
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

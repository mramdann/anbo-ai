use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::path::{Path, PathBuf};
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
        GetClientRect, SetWindowPos, ShowWindow, HWND_BOTTOM, HWND_TOP, SET_WINDOW_POS_FLAGS,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_HIDE,
        SW_SHOWNOACTIVATE,
    },
};

const BROWSER_NAV_EVENT: &str = "anbo:browser-nav";
const MAX_ACTIVE_EMBEDS: usize = 256;
const MAX_CLOSED_EMBEDS: usize = 16 * 1024;
const MAX_RELEASED_OWNERS: usize = 32 * 1024;

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

pub fn embed_label(tab_id: i64) -> String {
    format!("browser-embed-{tab_id}")
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

fn spawn_browser_child(
    window: &tauri::Window,
    tab_id: i64,
    target: Url,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<i32>,
    visible: bool,
    local_root: Arc<Mutex<Option<PathBuf>>>,
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
    let popup_label = embed_label(tab_id);
    let title_app = app.clone();
    let browser_data_dir = super::data::profile_dir(app)?;
    let navigation_local_root = local_root.clone();
    let popup_local_root = local_root.clone();
    let event_local_root = local_root.clone();
    let title_local_root = local_root;
    let builder = WebviewBuilder::new(embed_label(tab_id), WebviewUrl::External(target))
        .data_directory(browser_data_dir)
        // Opaque background so a not-yet-painted webview (new tab, mid-load) shows
        // a solid color instead of a transparent hole through to the desktop.
        .background_color(Color(255, 255, 255, 255))
        .initialization_script(
            r#"
            window.__anboLogs = window.__anboLogs || [];
            const safeStringify = (arg) => {
                try {
                    if (arg === null || typeof arg !== 'object') return String(arg).slice(0, 2000);
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
            const origLog = console.log;
            console.log = function(...args) {
                window.__anboLogs.push({ level: 'info', msg: args.slice(0, 20).map(safeStringify).join(' ').slice(0, 4000) });
                if (window.__anboLogs.length > 50) window.__anboLogs.shift();
                origLog.apply(console, args);
            };
            const origErr = console.error;
            console.error = function(...args) {
                window.__anboLogs.push({ level: 'error', msg: args.slice(0, 20).map(safeStringify).join(' ').slice(0, 4000) });
                if (window.__anboLogs.length > 50) window.__anboLogs.shift();
                origErr.apply(console, args);
            };
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
                if let Some(webview) = popup_app.get_webview(&popup_label) {
                    let _ = webview.navigate(target);
                }
            }
            // Native popup windows have no Anbo tab owner. Keep the request in
            // the registered tab instead of creating an unmanaged webview.
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
                PageLoadEvent::Started => "navigated",
                PageLoadEvent::Finished => "loaded",
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

#[cfg(not(windows))]
fn set_embed_presentation(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
    if visible {
        webview.show().map_err(|error| error.to_string())
    } else {
        webview.hide().map_err(|error| error.to_string())
    }
}

/// Clips the embedded browser's window region to exclude `hole` (a rectangle in
/// physical pixels relative to the webview's own origin), or restores the full
/// region when `hole` is `None`. While the webview stays on top (receiving
/// input everywhere it paints), the punched-out area lets the HTML layer behind
/// it — the AI mini window — show through and stay interactive. Region
/// coordinates are clamped to the webview's client rect to stay well-formed.
#[cfg(windows)]
async fn apply_punch_hole(webview: &tauri::Webview, hole: Option<PunchHole>) -> Result<(), String> {
    // Await the webview-thread result on a tokio oneshot instead of blocking a
    // worker thread with a synchronous mpsc recv — this command runs per-frame
    // while the AI mini window is dragged, so it must not stall the runtime.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let controller = platform.controller();
                let mut hwnd = windows::Win32::Foundation::HWND::default();
                unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|e| e.to_string())?;

                let region = match hole {
                    None => None,
                    Some(h) => {
                        let mut client = RECT::default();
                        unsafe { GetClientRect(hwnd, &mut client) }.map_err(|e| e.to_string())?;
                        let left = h.x.max(0);
                        let top = h.y.max(0);
                        let right = (h.x + h.width).min(client.right).max(left);
                        let bottom = (h.y + h.height).min(client.bottom).max(top);
                        let full = unsafe { CreateRectRgn(0, 0, client.right, client.bottom) };
                        let hole_rgn = unsafe { CreateRectRgn(left, top, right, bottom) };
                        let combined = unsafe { CreateRectRgn(0, 0, 0, 0) };
                        let kind = unsafe {
                            CombineRgn(Some(combined), Some(full), Some(hole_rgn), RGN_DIFF)
                        };
                        // Scratch regions are ours to free; `combined` is either handed
                        // to SetWindowRgn (ownership transferred on success) or freed below.
                        let _ = unsafe { DeleteObject(full.into()) };
                        let _ = unsafe { DeleteObject(hole_rgn.into()) };
                        if kind == RGN_ERROR {
                            let _ = unsafe { DeleteObject(combined.into()) };
                            return Err("failed to compute browser punch-hole region".to_string());
                        }
                        Some(combined)
                    }
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
    hole: Option<PunchHole>,
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
    return apply_punch_hole(&webview, hole).await;

    #[cfg(not(windows))]
    {
        let _ = webview;
        let _ = hole.map(|hole| (hole.x, hole.y, hole.width, hole.height));
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
    let _lifecycle = LIFECYCLE_LOCK.lock().await;
    ensure_current_instance(&instance_id)?;
    let label = embed_label(tab_id);

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
        if is_active(tab_id, &instance_id, Some(&owner_id)) {
            if let Some(webview) = app.get_webview(&label) {
                webview.hide().map_err(|error| error.to_string())?;
            }
        }
        return Ok(());
    }

    let workspace = WorkspaceEnv::from_option(workspace);
    let resolved_local_root = resolve_local_root(&registry, workspace_root.as_deref(), &workspace)?;

    let mut active = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
    if !active.contains_key(&tab_id) && active.len() >= MAX_ACTIVE_EMBEDS {
        return Err("browser embed limit reached".to_string());
    }
    let local_root = active
        .get(&tab_id)
        .filter(|entry| entry.instance_id == instance_id && entry.owner_id == owner_id)
        .map(|entry| entry.local_root.clone())
        .unwrap_or_else(|| Arc::new(Mutex::new(None)));
    *local_root
        .lock()
        .map_err(|_| "browser local-file policy is unavailable".to_string())? = resolved_local_root;
    active.insert(
        tab_id,
        ActiveEmbed {
            instance_id: instance_id.clone(),
            owner_id: owner_id.clone(),
            local_root: local_root.clone(),
        },
    );
    drop(active);

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
            let current = webview.url().map_err(|error| error.to_string())?;
            if current != target {
                webview
                    .navigate(target)
                    .map_err(|error| error.to_string())?;
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
    spawn_browser_child(&window, tab_id, target, position, size, visible, local_root)
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
        webview
            .navigate(target)
            .map_err(|error| error.to_string())?;
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
        return webview.reload().map_err(|error| error.to_string());
    }
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "stop" => "window.stop()",
        other => return Err(format!("unknown browser action: {other}")),
    };
    webview.eval(script).map_err(|error| error.to_string())
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
        let mut closed = closed_embeds()
            .lock()
            .map_err(|_| "browser close state is unavailable".to_string())?;
        bounded_insert(
            &mut closed,
            (tab_id, instance_id.clone()),
            MAX_CLOSED_EMBEDS,
        );
        drop(closed);
        released_owners()
            .lock()
            .map_err(|_| "browser owner state is unavailable".to_string())?
            .retain(|(released_tab_id, _, _)| *released_tab_id != tab_id);
        if is_active(tab_id, &instance_id, None) {
            if let Some(webview) = app.get_webview(&embed_label(tab_id)) {
                let _ = webview.hide();
                webview.close().map_err(|error| error.to_string())?;
            }
            active_embeds()
                .lock()
                .map_err(|_| "browser lifecycle state is unavailable".to_string())?
                .remove(&tab_id);
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
        physical_rect, should_process_update, EmbedBounds,
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

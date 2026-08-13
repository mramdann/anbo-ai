use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::{Mutex, OnceLock};

use tauri::webview::{Color, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl};
use url::Url;

use crate::modules::browser_automation::registry::{get_tab_lock, remove_tab_lock};

#[cfg(windows)]
use base64::Engine;
#[cfg(windows)]
use std::sync::Arc;
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
        GetClientRect, SetWindowPos, HWND_BOTTOM, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    },
};

const BROWSER_NAV_EVENT: &str = "anbo:browser-nav";
const MAX_ACTIVE_EMBEDS: usize = 256;
const MAX_CLOSED_EMBEDS: usize = 16 * 1024;
const MAX_RELEASED_OWNERS: usize = 32 * 1024;

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

#[derive(Clone, PartialEq)]
struct ActiveEmbed {
    instance_id: String,
    owner_id: String,
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

fn parse_pane_url(value: &str) -> Result<Url, String> {
    let target = Url::parse(value).map_err(|error| format!("invalid URL: {error}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("only HTTP(S) URLs can load in the browser".into());
    }
    Ok(target)
}

fn navigation_allowed(target: &Url, app_url: Option<&Url>) -> bool {
    if !matches!(target.scheme(), "http" | "https") {
        return false;
    }
    !app_url.is_some_and(|app| {
        matches!(app.scheme(), "http" | "https") && target.origin() == app.origin()
    })
}

fn popup_allowed(target: &Url, app_url: Option<&Url>) -> bool {
    target.as_str() == "about:blank" || navigation_allowed(target, app_url)
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
) -> Result<(), String> {
    let app = window.app_handle();
    let app_url = app
        .get_webview(window.label())
        .and_then(|webview| webview.url().ok());
    let navigation_app_url = app_url.clone();
    let popup_app_url = app_url;
    let navigation_app = app.clone();
    let title_app = app.clone();
    let builder = WebviewBuilder::new(embed_label(tab_id), WebviewUrl::External(target))
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
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let builder = builder
        .on_navigation(move |target| navigation_allowed(target, navigation_app_url.as_ref()))
        .on_new_window(move |target, _features| {
            if popup_allowed(&target, popup_app_url.as_ref()) {
                NewWindowResponse::Allow
            } else {
                NewWindowResponse::Deny
            }
        })
        .on_page_load(move |_webview, payload| {
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
            let url = webview.url().map(|url| url.to_string()).unwrap_or_default();
            let _ = title_app.emit(
                BROWSER_NAV_EVENT,
                BrowserNavEvent {
                    tab_id,
                    owner_id,
                    kind: "title",
                    url,
                    title: Some(title),
                },
            );
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
fn set_embed_z_order(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
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
                        Some(embed_insert_after(visible)),
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
        .map_err(|_| "timed out updating browser presentation".to_string())?
}

#[cfg(windows)]
fn set_embed_presentation(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
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
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    url: String,
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

    let target = if url.is_empty() {
        None
    } else {
        Some(parse_pane_url(&url)?)
    };

    let mut active = active_embeds()
        .lock()
        .map_err(|_| "browser lifecycle state is unavailable".to_string())?;
    if !active.contains_key(&tab_id) && active.len() >= MAX_ACTIVE_EMBEDS {
        return Err("browser embed limit reached".to_string());
    }
    active.insert(
        tab_id,
        ActiveEmbed {
            instance_id: instance_id.clone(),
            owner_id: owner_id.clone(),
        },
    );
    drop(active);

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
    spawn_browser_child(&window, tab_id, target, position, size, visible)
}

#[tauri::command]
pub async fn browser_embed_navigate(
    app: tauri::AppHandle,
    window: tauri::Window,
    tab_id: i64,
    instance_id: String,
    owner_id: String,
    url: String,
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
    let target = parse_pane_url(&url)?;
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
    crate::modules::browser_automation::snapshot::remove_generation(tab_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_insert, navigation_allowed, parse_pane_url, physical_rect, popup_allowed,
        should_process_update, EmbedBounds,
    };
    use std::collections::HashSet;
    use url::Url;

    #[test]
    fn accepts_http_and_https_urls() {
        assert!(parse_pane_url("http://localhost:3000").is_ok());
        assert!(parse_pane_url("https://example.com/path").is_ok());
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
    fn background_embed_stays_rendered_behind_the_ui() {
        use windows::Win32::UI::WindowsAndMessaging::{HWND_BOTTOM, HWND_TOP};

        assert_eq!(super::embed_insert_after(false), HWND_BOTTOM);
        assert_eq!(super::embed_insert_after(true), HWND_TOP);
    }

    #[test]
    fn rejects_active_and_local_content_schemes() {
        assert!(parse_pane_url("javascript:alert(1)").is_err());
        assert!(parse_pane_url("data:text/html,hello").is_err());
        assert!(parse_pane_url("file:///tmp/report.html").is_err());
    }

    #[test]
    fn navigation_rejects_non_web_and_app_origins() {
        let app = Url::parse("http://localhost:1420/app").unwrap();
        assert!(!navigation_allowed(
            &Url::parse("javascript:alert(1)").unwrap(),
            Some(&app)
        ));
        assert!(!navigation_allowed(
            &Url::parse("http://localhost:1420/recursive").unwrap(),
            Some(&app)
        ));
        assert!(navigation_allowed(
            &Url::parse("https://example.com").unwrap(),
            Some(&app)
        ));
    }

    #[test]
    fn popup_allows_blank_bootstrap_but_not_other_internal_schemes() {
        assert!(popup_allowed(&Url::parse("about:blank").unwrap(), None));
        assert!(!popup_allowed(
            &Url::parse("data:text/html,hello").unwrap(),
            None
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

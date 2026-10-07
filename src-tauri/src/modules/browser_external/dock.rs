// Only the Windows dock places a browser window; other platforms build the
// layout planning for its tests and the shared commands.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

const LIMIT: i32 = 16_384;
// Matches MAX_FLOATING_SURFACES in nativeVisibility.ts.
const MAX_CUTOUTS: usize = 16;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.width
    }

    fn bottom(self) -> i32 {
        self.y + self.height
    }

    fn is_empty(self) -> bool {
        self.width <= 0 || self.height <= 0
    }

    fn offset(self, dx: i32, dy: i32) -> Self {
        Self {
            x: self.x + dx,
            y: self.y + dy,
            ..self
        }
    }

    fn intersect(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > x && bottom > y).then_some(Self {
            x,
            y,
            width: right - x,
            height: bottom - y,
        })
    }

    fn within_limit(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| (0..=LIMIT).contains(value))
    }
}

/// The docked panel in physical pixels of Anbo's client area. `covered` means
/// an Anbo menu or dialog overlaps it, so input belongs to Anbo; `cutouts` are
/// floating Anbo panels that stay interactive over the page.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
    #[serde(default)]
    pub covered: bool,
    #[serde(default)]
    pub cutouts: Vec<Rect>,
    pub revision: u64,
}

impl Layout {
    fn update(&mut self, next: Self) {
        if next.revision > self.revision {
            *self = next;
        }
    }

    fn valid(&self) -> bool {
        self.panel().within_limit()
            && self.cutouts.len() <= MAX_CUTOUTS
            && self.cutouts.iter().all(|cutout| cutout.within_limit())
    }

    fn panel(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    tab_id: i64,
    connection_id: String,
    selection_id: String,
    dock_id: Option<String>,
    action: Action,
    layout: Option<Layout>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Attach,
    Layout,
    Release,
    Status,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    dock_id: Option<String>,
    live: bool,
    reason: Option<&'static str>,
}

/// Chrome's own frame around the page (tab strip, toolbar, infobars, borders)
/// in physical pixels, from the window rectangle to the page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
struct Insets {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// Chrome paints a one-pixel separator over the first row of the page, so the
/// page sits that much higher than the panel and its first row stays behind Anbo.
const TOP_SEPARATOR: i32 = 1;

/// How far below the desktop a browser that resets its window region waits
/// while Anbo is minimized.
const PARKED_GAP: i32 = 64;

/// A guess used only while the window is still hidden behind Anbo: Chrome's
/// frame at 100% scale without a bookmarks bar.
const ESTIMATED_INSETS: Insets = Insets {
    left: 8,
    top: 87,
    right: 8,
    bottom: 8,
};

/// Derives the frame from the browser window and the child window Chromium
/// keeps over the page, which it moves with every layout of its own bars. After
/// the window switches tabs, Chromium can leave that child where another layout
/// put it; the frame's border is as wide at the bottom as on its narrower side,
/// so such a reading is refused.
fn page_insets(window: Rect, page: Rect) -> Option<Insets> {
    let insets = Insets {
        left: page.x - window.x,
        top: page.y - window.y,
        right: window.right() - page.right(),
        bottom: window.bottom() - page.bottom(),
    };
    let inside = [insets.left, insets.top, insets.right, insets.bottom]
        .iter()
        .all(|value| *value >= 0);
    let framed = insets.bottom == insets.left.min(insets.right);
    (inside && framed && !page.is_empty()).then_some(insets)
}

/// The frame from the page's own size, for a page whose window Chromium keeps
/// hidden: the sides and the bottom are the same border, and the bars fill the
/// rest of the top. A page smaller than its window, as under device emulation,
/// gives no frame.
fn viewport_insets(window: Rect, page_width: i32, page_height: i32) -> Option<Insets> {
    let sides = window.width - page_width;
    let border = sides / 2;
    let insets = Insets {
        left: border,
        top: window.height - page_height - border,
        right: sides - border,
        bottom: border,
    };
    let plausible = page_width > 0
        && page_height > 0
        && (0..=32).contains(&border)
        && insets.right - insets.left <= 1
        && (insets.bottom..=640).contains(&insets.top);
    plausible.then_some(insets)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum BrowserRegion {
    /// No region: the browser owns its whole window again.
    Full,
    /// Invisible and click-through.
    Empty,
    /// Only `keep` stays. Anbo's floating surfaces over the page are kept in
    /// Anbo's own region and not cut from this one: where such a surface is
    /// transparent, at a rounded corner or while it moves, the page shows
    /// rather than whatever lies behind both windows.
    Clip { keep: Rect },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum HostRegion {
    Full,
    /// Opaque everywhere except one pixel of the rounded corner. A window region
    /// that is not a single rectangle makes Chromium stop treating Anbo as a
    /// window that occludes the page below it, so the page keeps rendering.
    Notch,
    /// The panel is cut out of Anbo so the page below receives the input.
    Hole {
        hole: Rect,
        keep: Vec<Rect>,
    },
}

#[derive(Clone, Debug, Default)]
struct Scene {
    host_shown: bool,
    host_window: Rect,
    client: Rect,
    /// The browser window where it is now, and the desktop across all monitors.
    browser_window: Rect,
    desktop: Rect,
    browser_aside: bool,
    /// The browser fills its monitor the way a full screen page does.
    full_screen: bool,
    layout: Layout,
    panel: Option<Rect>,
    insets: Option<Insets>,
    /// The selected page has replaced the window's placeholder page.
    ready: bool,
    min_width: i32,
    /// The browser keeps the window regions Anbo gives it.
    regions: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Plan {
    live: bool,
    reason: Option<&'static str>,
    browser: Option<Rect>,
    browser_region: BrowserRegion,
    host_region: HostRegion,
    restack: bool,
    /// Put the browser above Anbo once, as the page goes full screen.
    raise: bool,
}

fn plan(scene: &Scene) -> Plan {
    if scene.browser_aside {
        // The user took the page full screen or maximized it; the browser shows it
        // whole until it returns to the docked bounds, even while Anbo is minimized.
        return Plan {
            live: false,
            reason: Some("browser-fullscreen"),
            browser: None,
            browser_region: BrowserRegion::Full,
            host_region: HostRegion::Full,
            restack: false,
            raise: true,
        };
    }
    if !scene.host_shown {
        // An empty region hides the window while the page keeps rendering. Chrome
        // resets any region once it has been full screen, so its window then waits
        // below the desktop, where the page is hidden until Anbo returns.
        return Plan {
            live: false,
            reason: Some("host-hidden-or-minimized"),
            browser: (!scene.regions).then_some(Rect {
                y: scene.desktop.bottom() + PARKED_GAP,
                ..scene.browser_window
            }),
            browser_region: if scene.regions {
                BrowserRegion::Empty
            } else {
                BrowserRegion::Full
            },
            host_region: HostRegion::Full,
            restack: false,
            raise: false,
        };
    }
    let shown = scene.layout.visible && !scene.layout.panel().is_empty();
    let panel = if shown {
        scene.layout.panel()
    } else {
        scene.panel.unwrap_or(Rect {
            x: 0,
            y: 0,
            width: scene.client.width,
            height: scene.client.height,
        })
    };
    let insets = scene.insets.unwrap_or(ESTIMATED_INSETS);
    let top = insets.top + TOP_SEPARATOR;
    let mut bounds = Rect {
        x: scene.client.x + panel.x - insets.left,
        y: scene.client.y + panel.y - top,
        width: panel.width + insets.left + insets.right,
        height: panel.height + top + insets.bottom,
    };
    let content = Rect {
        x: insets.left,
        y: top,
        width: panel.width,
        height: panel.height,
    };
    // While Anbo shrinks, the panel can briefly reach past the client area until
    // the next layout arrives; the part outside stays clipped.
    let visible = panel.intersect(Rect {
        x: 0,
        y: 0,
        width: scene.client.width,
        height: scene.client.height,
    });
    let reason = if !shown {
        Some("panel-hidden")
    } else if !scene.ready || scene.insets.is_none() {
        Some("measuring")
    } else if visible.is_none() {
        Some("panel-outside-host")
    } else if scene.min_width > bounds.width {
        Some("panel-too-narrow")
    } else {
        None
    };
    let host_dx = scene.client.x - scene.host_window.x;
    let host_dy = scene.client.y - scene.host_window.y;
    // Below Anbo the browser needs no shape of its own: Anbo covers its frame and
    // shows the page through the hole. A region would not hide what the browser
    // composites above Anbo either. So only a window reaching past Anbo is
    // clipped, and only while the browser keeps the regions it is given.
    let shape = |bounds: Rect, clip: BrowserRegion| {
        if !scene.regions || bounds.intersect(scene.host_window) == Some(bounds) {
            BrowserRegion::Full
        } else {
            clip
        }
    };
    if let (None, Some(visible)) = (reason, visible) {
        let to_browser = |value: Rect| value.offset(insets.left - panel.x, top - panel.y);
        let cutouts: Vec<Rect> = scene
            .layout
            .cutouts
            .iter()
            .filter_map(|cutout| cutout.intersect(visible))
            .collect();
        return Plan {
            live: true,
            reason: None,
            browser: Some(bounds),
            browser_region: shape(
                bounds,
                BrowserRegion::Clip {
                    keep: to_browser(visible),
                },
            ),
            host_region: if scene.layout.covered {
                HostRegion::Notch
            } else {
                HostRegion::Hole {
                    hole: visible.offset(host_dx, host_dy),
                    keep: cutouts
                        .iter()
                        .map(|cutout| cutout.offset(host_dx, host_dy))
                        .collect(),
                }
            },
            restack: true,
            raise: false,
        };
    }
    // Not presentable yet: the page keeps rendering behind Anbo.
    bounds.width = bounds.width.max(scene.min_width);
    let behind_host = scene.host_window.offset(-bounds.x, -bounds.y);
    Plan {
        live: false,
        reason,
        browser: Some(bounds),
        browser_region: shape(
            bounds,
            content
                .intersect(behind_host)
                .map_or(BrowserRegion::Empty, |keep| BrowserRegion::Clip { keep }),
        ),
        host_region: HostRegion::Notch,
        restack: true,
        raise: false,
    }
}

/// Physical pixels to the browser's device-independent pixels at `scale`.
fn to_dips(bounds: Rect, scale: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let scaled = |value: i32| (f64::from(value) / scale).round() as i32;
    Rect {
        x: scaled(bounds.x),
        y: scaled(bounds.y),
        width: scaled(bounds.width),
        height: scaled(bounds.height),
    }
}

pub fn diagnostics(tab_id: i64) -> Option<serde_json::Value> {
    #[cfg(windows)]
    {
        native::diagnostics(tab_id)
    }
    #[cfg(not(windows))]
    {
        let _ = tab_id;
        None
    }
}

#[tauri::command]
pub async fn browser_external_dock(
    app: AppHandle,
    webview: Webview,
    request: Request,
) -> Result<Status, String> {
    super::ensure_main(&webview)?;
    if request
        .layout
        .as_ref()
        .is_some_and(|layout| !layout.valid())
    {
        return Err("Invalid dock panel bounds".into());
    }
    #[cfg(windows)]
    {
        native::command(&app, request).await
    }
    #[cfg(not(windows))]
    {
        let _ = (
            app,
            request.tab_id,
            request.connection_id,
            request.selection_id,
            request.dock_id,
            request.action,
        );
        Err("Native docking currently requires Windows".into())
    }
}

pub fn remove(tab_id: i64) {
    #[cfg(windows)]
    native::remove(tab_id);
    #[cfg(not(windows))]
    let _ = tab_id;
}

pub fn released(tab_id: i64, token: &str) {
    #[cfg(windows)]
    native::released(tab_id, token);
    #[cfg(not(windows))]
    let _ = (tab_id, token);
}

pub fn shutdown() {
    #[cfg(windows)]
    native::remove_all();
}

pub fn window_changed() {
    #[cfg(windows)]
    {
        native::clear_leftover_topmost();
        native::signal();
    }
}

/// Where Anbo's window stands for a page it would bring into a panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// Anbo is the window the user is in.
    Front,
    Minimized,
    /// Another window has the user's input: another app, or the page Anbo docks.
    Behind,
}

pub fn standing<R: tauri::Runtime>(app: &AppHandle<R>) -> Standing {
    #[cfg(windows)]
    {
        native::standing(app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Standing::Front
    }
}

/// Whether the dock shows this tab's page (true), holds it without showing it
/// yet (false, with the reason), or does not hold it (None).
pub fn docked(tab_id: i64) -> Option<(bool, Option<&'static str>)> {
    #[cfg(windows)]
    {
        native::docked(tab_id)
    }
    #[cfg(not(windows))]
    {
        let _ = tab_id;
        None
    }
}

#[cfg(windows)]
fn main_window<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<tauri::Window<R>, String> {
    use tauri::Manager;
    app.get_window("main")
        .ok_or_else(|| "Anbo main window is unavailable".into())
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::modules::browser_automation::{activity, registry};
    use crate::modules::browser_external::{
        dock_window::{window_bounds, Lease},
        get_target, ExternalTarget,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::{LazyLock, Mutex};
    use std::time::Duration;
    use std::time::Instant;
    use tauri::Emitter;
    use windows::core::BOOL;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, GetMonitorInfoW, GetWindowRgnBox,
        MonitorFromWindow, SetWindowRgn, HRGN, MONITORINFO, MONITOR_DEFAULTTONEAREST, NULLREGION,
        RGN_COMBINE_MODE, RGN_DIFF, RGN_ERROR, RGN_OR,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const WM_PRESENT: u32 = WM_APP + 0x41;

    #[derive(Clone)]
    struct Dock {
        target: ExternalTarget,
        lease: Lease,
        app: AppHandle,
        host: usize,
        thread: u32,
        layout: Layout,
        panel: Option<Rect>,
        insets: Option<Insets>,
        min_width: i32,
        /// A width the browser refused once; a second refusal makes it the
        /// minimum, so a window caught mid-transition is not taken for one.
        refused_width: Option<i32>,
        applied: Applied,
        /// Times in a row the browser reset the region Anbo last gave it.
        region_resets: u8,
        /// The browser resets the regions Anbo gives it, as Chrome does for the
        /// rest of the window's life once its page has been full screen.
        regions_refused: bool,
        status: (bool, Option<&'static str>),
        last_error: Option<String>,
        exited: std::sync::Arc<tokio::sync::Notify>,
        /// The selected page is in the dock window.
        committed: bool,
        /// The frame was read from the page's own window since the dock opened.
        measured: bool,
        /// Anbo's scale in percent when the dock opened, for `KNOWN_INSETS`.
        scale: u32,
        started: Instant,
    }

    #[derive(Clone, Default)]
    struct Applied {
        browser: Option<Rect>,
        browser_region: Option<BrowserRegion>,
        host_region: Option<HostRegion>,
        raised: bool,
    }

    static DOCK: Mutex<Option<Dock>> = Mutex::new(None);
    static OPERATIONS: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));
    // Read by the event hook, which must never wait for the dock lock.
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static HOST: AtomicUsize = AtomicUsize::new(0);
    static BROWSER: AtomicUsize = AtomicUsize::new(0);
    static QUEUED: AtomicBool = AtomicBool::new(false);
    /// The frame each browser last had around a docked page, by Anbo's scale in
    /// percent. A new dock window has the same frame, so its page shows at once,
    /// also when the page's own window never shows.
    static KNOWN_INSETS: Mutex<Vec<(String, u32, Insets)>> = Mutex::new(Vec::new());

    fn known_insets(browser: &str, scale: u32) -> Option<Insets> {
        KNOWN_INSETS
            .lock()
            .ok()?
            .iter()
            .find(|(name, at, _)| name == browser && *at == scale)
            .map(|(_, _, insets)| *insets)
    }

    fn remember_insets(browser: &str, scale: u32, insets: Insets) {
        if let Ok(mut known) = KNOWN_INSETS.lock() {
            known.retain(|(name, at, _)| !(name == browser && *at == scale));
            known.push((browser.to_owned(), scale, insets));
            if known.len() > 8 {
                known.remove(0);
            }
        }
    }

    fn rect(value: RECT) -> Rect {
        Rect {
            x: value.left,
            y: value.top,
            width: value.right - value.left,
            height: value.bottom - value.top,
        }
    }

    fn window_rect(window: HWND) -> Option<Rect> {
        let mut value = RECT::default();
        unsafe { GetWindowRect(window, &mut value) }
            .ok()
            .map(|()| rect(value))
    }

    fn client_rect(window: HWND) -> Option<Rect> {
        let mut value = RECT::default();
        let mut origin = POINT::default();
        unsafe {
            (GetClientRect(window, &mut value).is_ok()
                && ClientToScreen(window, &mut origin).as_bool())
            .then_some(Rect {
                x: origin.x,
                y: origin.y,
                width: value.right,
                height: value.bottom,
            })
        }
    }

    /// Queues one presentation pass on the dock thread. Signals that arrive
    /// before it runs collapse into that pass, and a signal during a pass queues
    /// the next one, so no window change is dropped.
    pub(super) fn signal() {
        let thread = THREAD.load(Ordering::Acquire);
        if thread == 0 || QUEUED.swap(true, Ordering::AcqRel) {
            return;
        }
        if unsafe { PostThreadMessageW(thread, WM_PRESENT, WPARAM(0), LPARAM(0)) }.is_err() {
            QUEUED.store(false, Ordering::Release);
        }
    }

    unsafe extern "system" fn collect(window: HWND, context: LPARAM) -> BOOL {
        let windows = unsafe { &mut *(context.0 as *mut Vec<usize>) };
        windows.push(window.0 as usize);
        BOOL(1)
    }

    fn locate(token: &str, browser: &str) -> Result<Lease, String> {
        let mut windows = Vec::<usize>::new();
        unsafe {
            EnumWindows(Some(collect), LPARAM(&mut windows as *mut _ as isize))
                .map_err(|error| error.to_string())?;
        }
        let mut matches = Vec::new();
        for handle in windows {
            let window = HWND(handle as *mut _);
            let mut title = [0_u16; 512];
            let length = unsafe { GetWindowTextW(window, &mut title) };
            if !String::from_utf16_lossy(&title[..length.max(0) as usize])
                .starts_with(&format!("Anbo Dock {token}"))
            {
                continue;
            }
            let mut process = 0;
            unsafe {
                GetWindowThreadProcessId(window, Some(&mut process));
            }
            let lease = Lease {
                handle: handle as u64,
                process,
                token: token.into(),
                browser: browser.into(),
                original: window_bounds(window)?,
            };
            if lease.arm().is_ok() {
                matches.push(lease);
            }
        }
        if matches.len() != 1 {
            for lease in matches {
                lease.restore();
            }
            return Err("Could not uniquely identify the dedicated browser window".into());
        }
        Ok(matches.remove(0))
    }

    unsafe extern "system" fn event(
        _hook: HWINEVENTHOOK,
        event: u32,
        window: HWND,
        object: i32,
        child: i32,
        _thread: u32,
        _time: u32,
    ) {
        let handle = window.0 as usize;
        let browser = BROWSER.load(Ordering::Acquire);
        // A click on the browser raises it above Anbo, where its compositor child
        // covers Anbo's header whatever the window's region, so it goes straight
        // back below. A browser that is already active changes no foreground;
        // its thread reports the raise as a reorder of the desktop, and the
        // click itself as a mouse capture.
        let raised = (event == EVENT_OBJECT_REORDER
            && handle == unsafe { GetDesktopWindow() }.0 as usize)
            || (matches!(event, EVENT_SYSTEM_CAPTURESTART | EVENT_SYSTEM_CAPTUREEND)
                && handle == browser);
        if event == EVENT_SYSTEM_FOREGROUND || raised {
            if handle == browser || raised {
                // Activation can raise the browser again after this event;
                // look once more when it has settled.
                unsafe {
                    SetTimer(None, 0, 120, None);
                }
            }
            signal();
            return;
        }
        if object != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 {
            return;
        }
        if handle == browser && event == EVENT_SYSTEM_MOVESIZEEND {
            let dock = DOCK.lock().ok().and_then(|mut state| {
                state
                    .as_ref()
                    .is_some_and(|dock| dock.lease.hwnd() == window)
                    .then(|| state.take())
                    .flatten()
            });
            if let Some(dock) = dock {
                log::info!("[browser_dock] released: the browser window was moved by hand");
                tauri::async_runtime::spawn(async move {
                    let _ = release(dock).await;
                });
            }
            return;
        }
        if handle == browser
            || handle == HOST.load(Ordering::Acquire)
            // The page's own window moves when the browser shows or hides a bar.
            || (browser != 0 && unsafe { GetAncestor(window, GA_ROOT) }.0 as usize == browser)
        {
            signal();
        }
    }

    fn install_hooks(host: HWND, browser: HWND) -> Result<Vec<HWINEVENTHOOK>, String> {
        let mut host_process = 0;
        let host_thread = unsafe { GetWindowThreadProcessId(host, Some(&mut host_process)) };
        let mut browser_process = 0;
        let browser_thread =
            unsafe { GetWindowThreadProcessId(browser, Some(&mut browser_process)) };
        if host_thread == 0 || browser_thread == 0 {
            return Err("Could not observe native window changes".into());
        }
        let mut hooks = Vec::new();
        for (first, last, process, thread) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, 0),
            (
                EVENT_SYSTEM_MOVESIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                host_process,
                host_thread,
            ),
            (
                EVENT_OBJECT_DESTROY,
                EVENT_OBJECT_LOCATIONCHANGE,
                host_process,
                host_thread,
            ),
            (
                EVENT_SYSTEM_CAPTURESTART,
                EVENT_SYSTEM_CAPTUREEND,
                browser_process,
                browser_thread,
            ),
            (
                EVENT_SYSTEM_MOVESIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                browser_process,
                browser_thread,
            ),
            (
                EVENT_OBJECT_DESTROY,
                EVENT_OBJECT_LOCATIONCHANGE,
                browser_process,
                browser_thread,
            ),
        ] {
            let hook = unsafe {
                SetWinEventHook(
                    first,
                    last,
                    None,
                    Some(event),
                    process,
                    thread,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook.0.is_null() {
                for hook in hooks {
                    unsafe {
                        let _ = UnhookWinEvent(hook);
                    }
                }
                return Err("Could not observe native window changes".into());
            }
            hooks.push(hook);
        }
        Ok(hooks)
    }

    /// Owns the window hooks and applies every presentation change, so Anbo's UI
    /// thread never waits on the browser's and events are handled in order. On
    /// exit Anbo gets its whole window back after any pass already running; the
    /// browser keeps only its page until the page goes back to its own window or
    /// the window is put back, so its frame never shows over Anbo.
    async fn start_thread(
        host: usize,
        lease: Lease,
    ) -> Result<(u32, std::sync::Arc<tokio::sync::Notify>), String> {
        let exited = std::sync::Arc::new(tokio::sync::Notify::new());
        let notify = exited.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("anbo-browser-dock".into())
            .spawn(move || {
                let host = HWND(host as *mut _);
                let mut message = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE);
                }
                let hooks = match install_hooks(host, lease.hwnd()) {
                    Ok(hooks) => hooks,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        notify.notify_one();
                        return;
                    }
                };
                let _ = sender.send(Ok(unsafe { GetCurrentThreadId() }));
                loop {
                    let received = unsafe { GetMessageW(&mut message, None, 0, 0) };
                    if received.0 <= 0 {
                        break;
                    }
                    if message.message == WM_PRESENT {
                        QUEUED.store(false, Ordering::Release);
                        present();
                    } else if message.message == WM_TIMER && message.hwnd.0.is_null() {
                        unsafe {
                            let _ = KillTimer(None, message.wParam.0);
                        }
                        present();
                    } else {
                        unsafe {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
                for hook in hooks {
                    unsafe {
                        let _ = UnhookWinEvent(hook);
                    }
                }
                let _ = apply_host_region(host, &HostRegion::Full);
                notify.notify_one();
            })
            .map_err(|error| error.to_string())?;
        let thread = tokio::time::timeout(Duration::from_secs(3), receiver)
            .await
            .map_err(|_| "Could not start native docking".to_string())?
            .map_err(|_| "Could not start native docking".to_string())??;
        Ok((thread, exited))
    }

    fn stop_thread(thread: u32) {
        if THREAD
            .compare_exchange(thread, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            HOST.store(0, Ordering::Release);
            BROWSER.store(0, Ordering::Release);
        }
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }

    fn rectangle(value: Rect) -> HRGN {
        unsafe { CreateRectRgn(value.x, value.y, value.right(), value.bottom()) }
    }

    fn combine(target: HRGN, value: Rect, mode: RGN_COMBINE_MODE) -> Result<(), String> {
        let part = rectangle(value);
        let kind = unsafe { CombineRgn(Some(target), Some(target), Some(part), mode) };
        unsafe {
            let _ = DeleteObject(part.into());
        }
        if kind == RGN_ERROR {
            return Err("Could not compute the dock region".into());
        }
        Ok(())
    }

    /// Hands a region to the window, which owns it from then on.
    fn set_region(window: HWND, region: Option<HRGN>) -> Result<(), String> {
        if unsafe { SetWindowRgn(window, region, true) } == 0 {
            if let Some(region) = region {
                unsafe {
                    let _ = DeleteObject(region.into());
                }
            }
            return Err("Windows rejected the dock region".into());
        }
        Ok(())
    }

    fn apply_browser_region(window: HWND, region: &BrowserRegion) -> Result<(), String> {
        match region {
            BrowserRegion::Full => set_region(window, None),
            BrowserRegion::Empty => set_region(window, Some(rectangle(Rect::default()))),
            BrowserRegion::Clip { keep } => set_region(window, Some(rectangle(*keep))),
        }
    }

    fn apply_host_region(window: HWND, region: &HostRegion) -> Result<(), String> {
        // Larger than any window, so resizing Anbo never clips its new edges
        // before the next pass moves the hole.
        let all = Rect {
            x: 0,
            y: 0,
            width: 32_000,
            height: 32_000,
        };
        let value = match region {
            HostRegion::Full => return set_region(window, None),
            HostRegion::Notch => {
                let value = rectangle(all);
                combine(
                    value,
                    Rect {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                    },
                    RGN_DIFF,
                )
                .map(|()| value)
            }
            HostRegion::Hole { hole, keep } => {
                let value = rectangle(all);
                let mut result = combine(value, *hole, RGN_DIFF);
                for part in keep {
                    result = result.and_then(|()| combine(value, *part, RGN_OR));
                }
                result.map(|()| value)
            }
        };
        match value {
            Ok(value) => set_region(window, Some(value)),
            Err(error) => Err(error),
        }
    }

    /// Whether the browser still carries the region Anbo gave it. The browser
    /// resets regions on some frame changes, so this is checked every pass.
    fn browser_region_intact(window: HWND, region: &BrowserRegion) -> bool {
        let mut value = RECT::default();
        let kind = unsafe { GetWindowRgnBox(window, &mut value) };
        match region {
            BrowserRegion::Full => kind == RGN_ERROR,
            BrowserRegion::Empty => kind == NULLREGION,
            BrowserRegion::Clip { keep } => kind != RGN_ERROR && rect(value) == *keep,
        }
    }

    fn topmost(window: HWND) -> bool {
        let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
        style & WS_EX_TOPMOST.0 as isize != 0
    }

    /// The first visible window below Anbo that the browser does not own. While
    /// Anbo is briefly topmost, other topmost windows sit between the two.
    fn window_below(host: HWND, browser: HWND) -> Option<HWND> {
        let mut current = host;
        for _ in 0..64 {
            current = unsafe { GetWindow(current, GW_HWNDNEXT) }.ok()?;
            if current.0.is_null() {
                return None;
            }
            let owner = unsafe { GetWindow(current, GW_OWNER) }.unwrap_or_default();
            if unsafe { IsWindowVisible(current) }.as_bool()
                && owner != browser
                && !topmost(current)
            {
                return Some(current);
            }
        }
        None
    }

    /// Keeps Anbo above every other window while the browser opens or restores
    /// a window, which it shows at the top of the z-order: the window then
    /// appears below Anbo instead of over it. Only while Anbo is in front
    /// anyway, so nothing else on screen changes.
    struct KeepInFront(usize);

    // Only these guards make Anbo topmost, so with none alive a topmost Anbo
    // is a leftover that would keep it over every other app.
    static GUARDS: AtomicUsize = AtomicUsize::new(0);
    static GUARDED_HOST: AtomicUsize = AtomicUsize::new(0);

    impl KeepInFront {
        fn new(host: usize) -> Option<Self> {
            let window = HWND(host as *mut _);
            if unsafe { GetForegroundWindow() } != window || topmost(window) {
                return None;
            }
            // Counted before the change, so the leftover check never takes this
            // guard's topmost for one.
            GUARDS.fetch_add(1, Ordering::AcqRel);
            GUARDED_HOST.store(host, Ordering::Release);
            let raised = unsafe {
                SetWindowPos(
                    window,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
            };
            if raised.is_err() {
                GUARDS.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            Some(Self(host))
        }
    }

    impl Drop for KeepInFront {
        fn drop(&mut self) {
            let window = HWND(self.0 as *mut _);
            let browser = HWND(BROWSER.load(Ordering::Acquire) as *mut _);
            // A browser window that turned topmost below Anbo leaves first, so
            // it is never left above Anbo.
            if !browser.is_invalid() && topmost(browser) {
                unsafe {
                    let _ = SetWindowPos(
                        browser,
                        Some(HWND_NOTOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
            leave_topmost(window, browser);
            GUARDS.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn process(window: HWND) -> u32 {
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(window, Some(&mut process)) };
        process
    }

    /// Takes Anbo out of the topmost band. The user may have switched to
    /// another app meanwhile, so Anbo goes back below it, but never below a
    /// topmost window such as the taskbar or the task switcher the user is
    /// switching with: Windows makes a window placed there topmost, which is
    /// how Anbo once stayed over every app after a dock. The browser's own
    /// windows never count either, or Anbo could end up below one of them.
    fn leave_topmost(window: HWND, browser: HWND) {
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        unsafe {
            let _ = SetWindowPos(window, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
            let front = GetForegroundWindow();
            let owner = process(front);
            if owner != 0
                && owner != process(window)
                && (browser.is_invalid() || owner != process(browser))
                && !topmost(front)
            {
                let _ = SetWindowPos(window, Some(front), 0, 0, 0, 0, flags);
            }
            if topmost(window) {
                log::warn!("[browser_dock] Anbo was still topmost after leaving it; cleared again");
                let _ = SetWindowPos(window, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
            }
        }
    }

    /// Anbo's window events end any topmost a lost restore left behind.
    pub(super) fn clear_leftover_topmost() {
        let host = GUARDED_HOST.load(Ordering::Acquire);
        if host == 0 || GUARDS.load(Ordering::Acquire) != 0 {
            return;
        }
        let window = HWND(host as *mut _);
        if topmost(window) {
            log::warn!("[browser_dock] Anbo was topmost with no dock holding it there; cleared");
            leave_topmost(window, HWND(BROWSER.load(Ordering::Acquire) as *mut _));
        }
    }

    fn desktop() -> Rect {
        unsafe {
            Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    fn fills_monitor(window: HWND, bounds: Rect) -> bool {
        let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() && rect(info.rcMonitor) == bounds
    }

    /// The page's rectangle on screen. Other web contents in the window, such as
    /// a side panel or docked DevTools, are smaller than the page.
    fn page_rect(browser: HWND) -> Option<Rect> {
        let mut page: Option<Rect> = None;
        let mut child = None;
        while let Ok(next) = unsafe {
            FindWindowExW(
                Some(browser),
                child,
                w!("Chrome_RenderWidgetHostHWND"),
                PCWSTR::null(),
            )
        } {
            child = Some(next);
            if !unsafe { IsWindowVisible(next) }.as_bool() {
                continue;
            }
            let area = |rect: Rect| i64::from(rect.width) * i64::from(rect.height);
            if let Some(rect) = window_rect(next) {
                if page.is_none_or(|page| area(rect) > area(page)) {
                    page = Some(rect);
                }
            }
        }
        page
    }

    /// The scene, and the frame read from the page's own window on this pass.
    fn scene(dock: &Dock) -> Option<(Scene, Option<Insets>)> {
        let host = HWND(dock.host as *mut _);
        let browser = dock.lease.hwnd();
        let host_window = window_rect(host)?;
        let client = client_rect(host)?;
        let browser_window = window_rect(browser)?;
        let host_shown = unsafe { IsWindowVisible(host).as_bool() && !IsIconic(host).as_bool() };
        let zoomed = unsafe { IsZoomed(browser).as_bool() };
        let full_screen = !zoomed
            && dock.applied.browser != Some(browser_window)
            && fills_monitor(browser, browser_window);
        let browser_aside = zoomed || full_screen;
        // Read on every pass: the browser lays the page out before a move
        // returns, and reports it with a location change when its bars change.
        let measured = if browser_aside {
            None
        } else {
            page_rect(browser).and_then(|page| page_insets(browser_window, page))
        };
        let insets = measured.or(dock.insets);
        let scene = Scene {
            host_shown,
            host_window,
            client,
            browser_window,
            desktop: desktop(),
            browser_aside,
            full_screen,
            layout: dock.layout.clone(),
            panel: dock.panel,
            insets,
            ready: dock.committed,
            min_width: dock.min_width,
            regions: !dock.regions_refused,
        };
        Some((scene, measured))
    }

    struct Outcome {
        applied: Applied,
        clamped: Option<i32>,
        error: Option<String>,
        /// The browser had reset the region Anbo gave it.
        reset: bool,
    }

    fn apply(dock: &Dock, plan: &Plan) -> Outcome {
        let host = HWND(dock.host as *mut _);
        let browser = dock.lease.hwnd();
        let mut outcome = Outcome {
            applied: dock.applied.clone(),
            clamped: None,
            error: None,
            reset: false,
        };
        let mut result = Ok(());
        let opening = matches!(plan.host_region, HostRegion::Hole { .. });
        // Close Anbo's hole before the page moves away from it; open it only
        // once the page is in place below.
        if !opening && outcome.applied.host_region.as_ref() != Some(&plan.host_region) {
            result = apply_host_region(host, &plan.host_region);
            if result.is_ok() {
                outcome.applied.host_region = Some(plan.host_region.clone());
            }
        }
        // Anbo may have put the browser back below it while its window was
        // growing to full screen; the page is what the user is looking at now.
        if plan.raise && !outcome.applied.raised {
            let raised = unsafe {
                SetWindowPos(
                    browser,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
            };
            outcome.applied.raised = raised.is_ok();
        } else if !plan.raise {
            outcome.applied.raised = false;
        }
        if let Some(bounds) = plan.browser {
            let mut front = None;
            if unsafe { IsIconic(browser).as_bool() } {
                front = KeepInFront::new(dock.host);
                unsafe {
                    let _ = ShowWindow(browser, SW_SHOWNOACTIVATE);
                }
            }
            let actual = window_rect(browser);
            let stacked = !plan.restack || window_below(host, browser) == Some(browser);
            if actual != Some(bounds) || !stacked {
                let mut flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
                if actual == Some(bounds) {
                    flags |= SWP_NOMOVE | SWP_NOSIZE;
                }
                let after = if plan.restack {
                    // Placed right after a topmost Anbo, the browser would turn
                    // topmost too; the top of the other windows is the same place.
                    Some(if topmost(host) { HWND_TOP } else { host })
                } else {
                    flags |= SWP_NOZORDER;
                    None
                };
                let placed = unsafe {
                    SetWindowPos(
                        browser,
                        after,
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        flags,
                    )
                };
                match placed {
                    Ok(()) => {
                        outcome.applied.browser = Some(bounds);
                        // Chrome keeps a minimum window width; a narrower panel
                        // cannot show the page's full width.
                        if let Some(now) = window_rect(browser) {
                            if now.width > bounds.width {
                                outcome.clamped = Some(now.width);
                                outcome.applied.browser = Some(now);
                            }
                        }
                    }
                    Err(error) => result = Err(format!("Could not position browser: {error}")),
                }
            }
            drop(front);
        }
        let given = outcome.applied.browser_region.as_ref() == Some(&plan.browser_region);
        if !given || !browser_region_intact(browser, &plan.browser_region) {
            outcome.reset = given;
            // A browser that keeps resetting it would otherwise be fought with
            // on every pass; Anbo keeps it below either way.
            if !given || dock.region_resets < 3 {
                match apply_browser_region(browser, &plan.browser_region) {
                    Ok(()) => outcome.applied.browser_region = Some(plan.browser_region.clone()),
                    Err(error) => result = Err(error),
                }
            }
        }
        if opening
            && outcome.clamped.is_none()
            && outcome.applied.host_region.as_ref() != Some(&plan.host_region)
        {
            match apply_host_region(host, &plan.host_region) {
                Ok(()) => outcome.applied.host_region = Some(plan.host_region.clone()),
                Err(error) => result = Err(error),
            }
        }
        outcome.error = result.err();
        outcome
    }

    fn present() {
        let Some(dock) = DOCK.lock().ok().and_then(|state| state.clone()) else {
            return;
        };
        if !dock.lease.live() {
            if let Some(dock) = take_token(&dock.lease.token) {
                log::info!("[browser_dock] released: the dock window closed or lost its mark");
                tauri::async_runtime::spawn(async move {
                    let _ = release(dock).await;
                });
            }
            return;
        }
        let Some((scene, measured)) = scene(&dock) else {
            return;
        };
        let plan = plan(&scene);
        let outcome = apply(&dock, &plan);
        let mut changed = None;
        let mut again = false;
        if let Ok(mut state) = DOCK.lock() {
            if let Some(current) = state
                .as_mut()
                .filter(|current| current.lease.token == dock.lease.token)
            {
                if current.applied.browser_region.as_ref() != Some(&plan.browser_region) {
                    current.region_resets = 0;
                } else if outcome.reset {
                    current.region_resets = current.region_resets.saturating_add(1);
                }
                if !current.regions_refused
                    && (scene.full_screen || current.region_resets >= 3)
                {
                    log::info!("[browser_dock] the browser resets window regions from now on; its frame stays out of sight by position alone");
                    current.regions_refused = true;
                    again = true;
                }
                current.applied = outcome.applied;
                if let Some(error) = outcome
                    .error
                    .as_ref()
                    .filter(|error| current.last_error.as_ref() != Some(*error))
                {
                    log::warn!("[browser_dock] {error}");
                }
                current.last_error = outcome.error;
                if let Some(width) = outcome.clamped {
                    if current.refused_width == Some(width) {
                        log::info!(
                            "[browser_dock] the browser keeps its window at least {width} px wide"
                        );
                        current.min_width = current.min_width.max(width);
                        current.refused_width = None;
                        again = true;
                    } else {
                        // Leaving full screen, the browser can briefly hold a
                        // wider window; ask again once it has settled.
                        current.refused_width = Some(width);
                        unsafe {
                            SetTimer(None, 0, 250, None);
                        }
                    }
                } else if current.applied.browser == plan.browser {
                    current.refused_width = None;
                }
                if current.insets != scene.insets {
                    log::info!("[browser_dock] browser frame {:?}", scene.insets);
                    current.insets = scene.insets;
                }
                if let Some(insets) = measured {
                    current.measured = true;
                    remember_insets(&current.lease.browser, current.scale, insets);
                }
                if plan.live {
                    current.panel = Some(current.layout.panel());
                }
                let status = (plan.live, plan.reason);
                if current.status != status {
                    log::info!(
                        "[browser_dock] {} at {} ms",
                        status.1.unwrap_or("live"),
                        current.started.elapsed().as_millis()
                    );
                    current.status = status;
                    changed = Some(json!({
                        "tabId": current.target.tab_id,
                        "dockId": current.lease.token,
                        "live": status.0,
                        "reason": status.1,
                    }));
                }
            }
        }
        if let Some(payload) = changed {
            let _ = dock.app.emit_to("main", "anbo:browser-dock-state", payload);
        }
        if again {
            signal();
        }
    }

    fn take_token(token: &str) -> Option<Dock> {
        let mut state = DOCK.lock().ok()?;
        if state.as_ref().is_some_and(|dock| dock.lease.token == token) {
            state.take()
        } else {
            None
        }
    }

    fn take(tab_id: i64) -> Option<Dock> {
        let mut state = DOCK.lock().ok()?;
        if state
            .as_ref()
            .is_some_and(|dock| dock.target.tab_id == tab_id)
        {
            state.take()
        } else {
            None
        }
    }

    /// Stops presenting; the dock thread gives both windows their whole shape
    /// back once it has finished any pass already under way.
    fn detach(dock: &Dock) {
        stop_thread(dock.thread);
        let _ = dock.app.emit_to(
            "main",
            "anbo:browser-dock-released",
            json!({"tabId":dock.target.tab_id,"dockId":dock.lease.token}),
        );
    }

    /// For a tab Anbo let go of: the extension moves the page back to its own
    /// window, which then closes. Only a window left behind is put back where
    /// it was, so the common case never flashes it on screen.
    fn restore(dock: Dock) {
        detach(&dock);
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), dock.exited.notified()).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            put_back(&dock.lease).await;
        });
    }

    async fn put_back(lease: &Lease) {
        let lease = lease.clone();
        let _ = tokio::task::spawn_blocking(move || lease.restore()).await;
    }

    pub(super) fn remove(tab_id: i64) {
        if let Some(dock) = take(tab_id) {
            log::info!("[browser_dock] released: Anbo let go of the tab");
            restore(dock);
        }
    }

    pub(super) fn released(tab_id: i64, token: &str) {
        let previous = DOCK.lock().ok().and_then(|mut state| {
            if state
                .as_ref()
                .is_some_and(|dock| dock.target.tab_id == tab_id && dock.lease.token == token)
            {
                state.take()
            } else {
                None
            }
        });
        if let Some(dock) = previous {
            log::info!("[browser_dock] released: the browser took the tab back");
            restore(dock);
        }
    }

    /// Anbo is exiting: the native host restores the browser window when the
    /// connection closes, so only Anbo's own window needs its shape back now.
    pub(super) fn remove_all() {
        if let Some(dock) = DOCK.lock().ok().and_then(|mut state| state.take()) {
            detach(&dock);
            let _ = apply_host_region(HWND(dock.host as *mut _), &HostRegion::Full);
        }
    }

    pub(super) fn diagnostics(tab_id: i64) -> Option<serde_json::Value> {
        let dock = DOCK
            .lock()
            .ok()?
            .as_ref()
            .filter(|dock| dock.target.tab_id == tab_id)?
            .clone();
        Some(json!({
            "layout": dock.layout,
            "live": dock.status.0,
            "reason": dock.status.1,
            "insets": dock.insets,
            "minWidth": dock.min_width,
            "requestedBounds": dock.applied.browser,
            "actualBounds": window_bounds(dock.lease.hwnd()).ok(),
            "lastWindowError": dock.last_error,
        }))
    }

    pub(super) fn docked(tab_id: i64) -> Option<(bool, Option<&'static str>)> {
        let state = DOCK.lock().ok()?;
        let dock = state.as_ref().filter(|dock| dock.target.tab_id == tab_id)?;
        Some((dock.committed && dock.status.0, dock.status.1))
    }

    pub(super) fn standing<R: tauri::Runtime>(app: &AppHandle<R>) -> Standing {
        let Some(host) = main_window(app)
            .ok()
            .and_then(|window| window.hwnd().ok())
            .map(|handle| HWND(handle.0 as *mut _))
        else {
            return Standing::Behind;
        };
        if unsafe { IsIconic(host) }.as_bool() {
            Standing::Minimized
        } else if unsafe { GetForegroundWindow() } == host {
            Standing::Front
        } else {
            Standing::Behind
        }
    }

    fn status(dock: &Dock) -> Status {
        Status {
            dock_id: Some(dock.lease.token.clone()),
            live: dock.status.0,
            reason: dock.status.1,
        }
    }

    async fn release(dock: Dock) -> Result<(), String> {
        let started = Instant::now();
        detach(&dock);
        let _ = tokio::time::timeout(Duration::from_secs(2), dock.exited.notified()).await;
        let result = dock
            .target
            .call(
                "anbo.dockRelease",
                json!({"token":dock.lease.token}),
                Duration::from_secs(5),
            )
            .await;
        match &result {
            Ok(_) => log::info!(
                "[browser_dock] page back in its own window in {} ms",
                started.elapsed().as_millis()
            ),
            Err(error) => log::warn!("[browser_dock] the browser kept the page: {error}"),
        }
        let _ = dock
            .target
            .call(
                "anbo.guardDock",
                json!({"action":"restore","window":dock.lease}),
                Duration::from_secs(2),
            )
            .await;
        // Still open only if the page could not go back to its own window.
        put_back(&dock.lease).await;
        if let Some(target) = registry::find_target(&dock.app, dock.target.tab_id) {
            activity::restore(&target);
        }
        result.map(|_| ())
    }

    pub(super) async fn command(app: &AppHandle, request: Request) -> Result<Status, String> {
        let _operation = OPERATIONS.lock().await;
        let target =
            get_target(request.tab_id).ok_or("Reconnect and select this browser tab first")?;
        target.check_lease(Some(&request.connection_id), Some(&request.selection_id))?;
        if !matches!(request.action, Action::Attach) {
            let mut state = DOCK.lock().map_err(|_| "Dock registry unavailable")?;
            if state.as_ref().is_some_and(|dock| !dock.lease.live()) {
                let previous = state.take();
                drop(state);
                if let Some(dock) = previous {
                    log::info!("[browser_dock] released: the dock window closed or lost its mark");
                    restore(dock);
                }
                return Ok(Status::default());
            }
            let Some(dock) = state
                .as_mut()
                .filter(|dock| dock.target.tab_id == request.tab_id)
            else {
                return Ok(Status::default());
            };
            if !matches!(request.action, Action::Status)
                && request.dock_id.as_deref() != Some(&dock.lease.token)
            {
                return Err("Dock identity changed".into());
            }
            match request.action {
                Action::Status => return Ok(status(dock)),
                Action::Layout => {
                    dock.layout
                        .update(request.layout.ok_or("Missing dock layout")?);
                    let current = status(dock);
                    drop(state);
                    signal();
                    return Ok(current);
                }
                _ => {}
            }
        }
        let lock = registry::get_tab_lock(request.tab_id);
        let _tab = lock.lock().await;
        if matches!(request.action, Action::Release) {
            if let Some(dock) = take(request.tab_id) {
                log::info!("[browser_dock] released on request");
                release(dock).await?;
            }
            return Ok(Status::default());
        }
        if DOCK
            .lock()
            .map_err(|_| "Dock registry unavailable")?
            .is_some()
        {
            return Err("Prototype supports one docked tab at a time. Release it first.".into());
        }
        let window = main_window(app)?;
        let host = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let scale = (scale_factor * 100.0).round() as u32;
        let browser = target
            .profile()
            .and_then(|profile| profile["browser"].as_str().map(str::to_owned))
            .ok_or("Browser profile unavailable")?;
        let token = format!(
            "{}{}",
            super::super::random_id()?,
            super::super::random_id()?
        );
        let started = Instant::now();
        // The browser shows a new window at the top of the z-order; it opens
        // where the page will be, below Anbo while Anbo is in front.
        let front = KeepInFront::new(host);
        let bounds = opening_bounds(host, request.layout.as_ref())
            .map(|bounds| to_dips(bounds, scale_factor))
            .map(|bounds| {
                json!({"left":bounds.x,"top":bounds.y,"width":bounds.width,"height":bounds.height})
            });
        target
            .call(
                "anbo.dockPrepare",
                json!({"token":token,"bounds":bounds}),
                Duration::from_secs(5),
            )
            .await?;
        let prepare = async {
            let mut lease = None;
            // The new window is on screen until it is found and tucked below
            // Anbo, so look often.
            for _ in 0..100 {
                if let Ok(found) = locate(&token, &browser) {
                    lease = Some(found);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let lease =
                lease.ok_or("Could not verify the new browser window. Nothing was docked.")?;
            if let Err(error) = target
                .call(
                    "anbo.guardDock",
                    json!({"action":"arm","window":lease}),
                    Duration::from_secs(3),
                )
                .await
            {
                lease.restore();
                return Err(error);
            }
            let (thread, exited) = match start_thread(host, lease.clone()).await {
                Ok(started) => started,
                Err(error) => {
                    lease.restore();
                    return Err(error);
                }
            };
            let insets = known_insets(&browser, scale);
            HOST.store(host, Ordering::Release);
            BROWSER.store(lease.handle as usize, Ordering::Release);
            QUEUED.store(false, Ordering::Release);
            THREAD.store(thread, Ordering::Release);
            *DOCK.lock().map_err(|_| "Dock registry unavailable")? = Some(Dock {
                target: target.clone(),
                lease,
                app: app.clone(),
                host,
                thread,
                layout: request.layout.clone().unwrap_or_default(),
                panel: None,
                insets,
                min_width: 0,
                refused_width: None,
                applied: Applied::default(),
                region_resets: 0,
                regions_refused: false,
                status: (false, Some("measuring")),
                last_error: None,
                exited,
                committed: false,
                measured: false,
                scale,
                started,
            });
            log::info!(
                "[browser_dock] dock window found and tucked below Anbo at {} ms",
                started.elapsed().as_millis()
            );
            if let Some(insets) = insets {
                log::info!("[browser_dock] browser frame from the last dock window {insets:?}");
            }
            signal();
            target
                .call(
                    "anbo.dockCommit",
                    json!({"token":token}),
                    Duration::from_secs(5),
                )
                .await?;
            if let Some(dock) = DOCK
                .lock()
                .map_err(|_| "Dock registry unavailable")?
                .as_mut()
                .filter(|dock| dock.lease.token == token)
            {
                dock.committed = true;
            }
            log::info!(
                "[browser_dock] page moved into the dock window at {} ms",
                started.elapsed().as_millis()
            );
            signal();
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = prepare {
            if let Some(dock) = take(request.tab_id) {
                let _ = release(dock).await;
            } else {
                let _ = target
                    .call(
                        "anbo.dockRelease",
                        json!({"token":token}),
                        Duration::from_secs(3),
                    )
                    .await;
            }
            return Err(error);
        }
        drop(front);
        signal();
        tauri::async_runtime::spawn(measure_from_page(token.clone(), target.clone()));
        Ok(Status {
            dock_id: Some(token),
            live: false,
            reason: Some("measuring"),
        })
    }

    /// Chromium can keep the page's own window hidden in the dock window, as it
    /// does after focus emulation, and then no pass reads the frame. Without a
    /// reading soon after the page arrives, the page's size gives it.
    async fn measure_from_page(token: String, target: ExternalTarget) {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let unmeasured =
            |dock: &Dock| dock.lease.token == token && dock.committed && !dock.measured;
        let Some(window) = DOCK.lock().ok().and_then(|state| {
            state
                .as_ref()
                .filter(|dock| unmeasured(dock))
                .map(|dock| dock.lease.handle)
        }) else {
            return;
        };
        let Ok(value) = target
            .call(
                "Runtime.evaluate",
                json!({"expression":"[innerWidth, innerHeight, devicePixelRatio]","returnByValue":true}),
                Duration::from_secs(1),
            )
            .await
        else {
            return;
        };
        let numbers: Vec<f64> = value["result"]["value"]
            .as_array()
            .map(|values| values.iter().filter_map(serde_json::Value::as_f64).collect())
            .unwrap_or_default();
        let [width, height, ratio] = numbers[..] else {
            return;
        };
        let Some(bounds) = window_rect(HWND(window as usize as *mut _)) else {
            return;
        };
        let insets = (0.25..=8.0).contains(&ratio).then(|| {
            viewport_insets(
                bounds,
                (width * ratio).round() as i32,
                (height * ratio).round() as i32,
            )
        });
        let Some(insets) = insets.flatten() else {
            log::info!("[browser_dock] the page's size gives no browser frame");
            return;
        };
        if let Ok(mut state) = DOCK.lock() {
            if let Some(dock) = state.as_mut().filter(|dock| unmeasured(dock)) {
                if dock.insets != Some(insets) {
                    log::info!("[browser_dock] browser frame from the page size {insets:?}");
                    dock.insets = Some(insets);
                }
                remember_insets(&dock.lease.browser, dock.scale, insets);
            }
        }
        signal();
    }

    /// Where the dock window will sit, from the panel and an estimated frame.
    fn opening_bounds(host: usize, layout: Option<&Layout>) -> Option<Rect> {
        let window = HWND(host as *mut _);
        let layout = layout.filter(|layout| layout.visible)?.clone();
        plan(&Scene {
            host_shown: true,
            host_window: window_rect(window)?,
            client: client_rect(window)?,
            layout,
            regions: true,
            ..Default::default()
        })
        .browser
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene() -> Scene {
        Scene {
            host_shown: true,
            host_window: Rect {
                x: 100,
                y: 50,
                width: 1600,
                height: 900,
            },
            client: Rect {
                x: 100,
                y: 50,
                width: 1600,
                height: 900,
            },
            browser_window: Rect {
                x: 692,
                y: 82,
                width: 916,
                height: 796,
            },
            desktop: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            browser_aside: false,
            full_screen: false,
            layout: Layout {
                x: 600,
                y: 120,
                width: 900,
                height: 700,
                visible: true,
                revision: 1,
                ..Default::default()
            },
            panel: None,
            insets: Some(Insets {
                left: 8,
                top: 87,
                right: 8,
                bottom: 8,
            }),
            ready: true,
            min_width: 0,
            regions: true,
        }
    }

    #[test]
    fn a_shown_panel_aligns_the_page_with_a_hole_in_anbo() {
        let plan = plan(&scene());
        assert!(plan.live);
        assert_eq!(
            plan.browser,
            Some(Rect {
                x: 692,
                y: 82,
                width: 916,
                height: 796,
            })
        );
        // Anbo covers the whole browser window, so it keeps its own shape.
        assert_eq!(plan.browser_region, BrowserRegion::Full);
        assert_eq!(
            plan.host_region,
            HostRegion::Hole {
                hole: Rect {
                    x: 600,
                    y: 120,
                    width: 900,
                    height: 700,
                },
                keep: Vec::new(),
            }
        );
        assert!(plan.restack);
    }

    #[test]
    fn a_browser_reaching_past_anbo_is_clipped_to_the_page() {
        let mut state = scene();
        state.layout.y = 20;
        let plan = plan(&state);
        assert!(plan.live);
        assert_eq!(plan.browser.map(|bounds| bounds.y), Some(-18));
        // The page's first row, under Chrome's separator, stays above the clip.
        assert_eq!(
            plan.browser_region,
            BrowserRegion::Clip {
                keep: Rect {
                    x: 8,
                    y: 88,
                    width: 900,
                    height: 700,
                },
            }
        );
    }

    #[test]
    fn floating_anbo_panels_leave_a_clipped_browser_its_whole_page() {
        let mut state = scene();
        state.layout.y = 20;
        let bare = plan(&state).browser_region;
        state.layout.cutouts = vec![Rect {
            x: 700,
            y: 300,
            width: 300,
            height: 100,
        }];
        let plan = plan(&state);
        // Anbo keeps the panel in its own region, above the page...
        let HostRegion::Hole { keep, .. } = plan.host_region else {
            panic!("expected a hole");
        };
        assert_eq!(keep.len(), 1);
        // ...and the page below stays whole, so a transparent corner of the
        // panel shows the page, not whatever lies behind both windows.
        assert_eq!(plan.browser_region, bare);
    }

    #[test]
    fn the_hole_is_cut_in_window_coordinates() {
        let mut state = scene();
        state.host_window = Rect {
            x: 92,
            y: 42,
            width: 1616,
            height: 916,
        };
        let HostRegion::Hole { hole, .. } = plan(&state).host_region else {
            panic!("expected a hole");
        };
        assert_eq!((hole.x, hole.y), (608, 128));
    }

    #[test]
    fn an_anbo_menu_over_the_panel_takes_input_but_keeps_the_page_visible() {
        let mut state = scene();
        state.layout.covered = true;
        let plan = plan(&state);
        assert!(plan.live);
        assert_eq!(plan.host_region, HostRegion::Notch);
        assert_eq!(plan.browser_region, BrowserRegion::Full);
    }

    #[test]
    fn floating_anbo_panels_stay_above_the_page() {
        let mut state = scene();
        state.layout.cutouts = vec![
            Rect {
                x: 1400,
                y: 700,
                width: 300,
                height: 200,
            },
            Rect {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
        ];
        let plan = plan(&state);
        let HostRegion::Hole { keep, .. } = plan.host_region else {
            panic!("expected a hole");
        };
        assert_eq!(
            keep,
            vec![Rect {
                x: 1400,
                y: 700,
                width: 100,
                height: 120,
            }]
        );
    }

    #[test]
    fn a_hidden_panel_keeps_the_page_rendering_behind_anbo() {
        let mut state = scene();
        state.panel = Some(state.layout.panel());
        state.layout.visible = false;
        state.layout.width = 0;
        let plan = plan(&state);
        assert!(!plan.live);
        assert_eq!(plan.reason, Some("panel-hidden"));
        assert_eq!(plan.host_region, HostRegion::Notch);
        assert_eq!(
            plan.browser,
            Some(Rect {
                x: 692,
                y: 82,
                width: 916,
                height: 796,
            })
        );
        assert_eq!(plan.browser_region, BrowserRegion::Full);
    }

    #[test]
    fn nothing_is_shown_before_the_frame_is_measured() {
        let mut state = scene();
        state.insets = None;
        let plan = plan(&state);
        assert!(!plan.live);
        assert_eq!(plan.reason, Some("measuring"));
        assert_eq!(plan.host_region, HostRegion::Notch);
    }

    #[test]
    fn the_placeholder_page_is_never_shown_in_the_panel() {
        let mut state = scene();
        state.ready = false;
        let plan = plan(&state);
        assert!(!plan.live);
        assert_eq!(plan.reason, Some("measuring"));
        // Already placed with the measured frame, so going live moves nothing.
        assert_eq!(
            plan.browser,
            Some(Rect {
                x: 692,
                y: 82,
                width: 916,
                height: 796,
            })
        );
    }

    #[test]
    fn a_minimized_anbo_hides_the_page_and_restores_its_window() {
        let mut state = scene();
        state.host_shown = false;
        let plan = plan(&state);
        assert_eq!(plan.browser_region, BrowserRegion::Empty);
        assert_eq!(plan.host_region, HostRegion::Full);
        assert_eq!(plan.browser, None);
    }

    #[test]
    fn a_browser_that_resets_regions_waits_below_the_desktop_while_anbo_is_minimized() {
        let mut state = scene();
        state.host_shown = false;
        state.regions = false;
        let plan = plan(&state);
        assert!(!plan.live);
        assert_eq!(
            plan.browser,
            Some(Rect {
                x: 692,
                y: 1080 + PARKED_GAP,
                width: 916,
                height: 796,
            })
        );
        assert_eq!(plan.browser_region, BrowserRegion::Full);
        assert!(!plan.restack);
        // Once Anbo is back, one move puts the window in place below it.
        state.host_shown = true;
        state.browser_window = plan.browser.unwrap();
        let back = super::plan(&state);
        assert!(back.live && back.restack);
        assert_eq!(
            back.browser,
            Some(Rect {
                x: 692,
                y: 82,
                width: 916,
                height: 796,
            })
        );
    }

    #[test]
    fn a_browser_that_resets_regions_keeps_its_whole_window() {
        let mut state = scene();
        state.regions = false;
        state.layout.y = 20;
        assert!(plan(&state).live);
        assert_eq!(plan(&state).browser_region, BrowserRegion::Full);
        state.insets = None;
        assert_eq!(plan(&state).browser_region, BrowserRegion::Full);
    }

    #[test]
    fn the_dock_window_opens_in_the_browsers_own_units() {
        let bounds = Rect {
            x: 692,
            y: -3,
            width: 916,
            height: 796,
        };
        assert_eq!(to_dips(bounds, 1.0), bounds);
        assert_eq!(
            to_dips(bounds, 1.5),
            Rect {
                x: 461,
                y: -2,
                width: 611,
                height: 531,
            }
        );
        assert_eq!(to_dips(bounds, 0.0), bounds);
    }

    #[test]
    fn a_full_screen_page_is_left_to_the_browser() {
        let mut state = scene();
        state.browser_aside = true;
        let plan = plan(&state);
        assert_eq!(plan.browser_region, BrowserRegion::Full);
        assert_eq!(plan.host_region, HostRegion::Full);
        assert!(!plan.restack);
        assert!(plan.raise, "the full screen page comes to the front");
        assert!(!super::plan(&scene()).raise);
        state.host_shown = false;
        assert_eq!(super::plan(&state).reason, Some("browser-fullscreen"));
    }

    #[test]
    fn a_panel_narrower_than_the_browser_allows_is_not_shown() {
        let mut state = scene();
        state.min_width = 1000;
        let plan = plan(&state);
        assert!(!plan.live);
        assert_eq!(plan.reason, Some("panel-too-narrow"));
        assert_eq!(plan.browser.map(|bounds| bounds.width), Some(1000));
        assert_eq!(plan.host_region, HostRegion::Notch);
    }

    #[test]
    fn a_panel_reaching_past_the_client_area_is_clipped_to_it() {
        let mut state = scene();
        state.layout.width = 1100;
        let plan = plan(&state);
        assert!(plan.live);
        let HostRegion::Hole { hole, .. } = plan.host_region else {
            panic!("expected a hole");
        };
        assert_eq!(hole.width, 1000);
        let BrowserRegion::Clip { keep } = plan.browser_region else {
            panic!("expected a clip");
        };
        assert_eq!(keep.width, 1000);
        assert_eq!(plan.browser.map(|bounds| bounds.width), Some(1116));
        let mut outside = scene();
        outside.layout.x = 1700;
        assert_eq!(super::plan(&outside).reason, Some("panel-outside-host"));
    }

    #[test]
    fn the_frame_is_the_window_around_the_page() {
        let window = Rect {
            x: 200,
            y: 120,
            width: 1000,
            height: 760,
        };
        let page = Rect {
            x: 208,
            y: 207,
            width: 984,
            height: 665,
        };
        assert_eq!(
            page_insets(window, page),
            Some(Insets {
                left: 8,
                top: 87,
                right: 8,
                bottom: 8,
            })
        );
        // A side panel narrows the page; the page keeps its left edge.
        assert_eq!(
            page_insets(window, Rect { width: 700, ..page }).map(|insets| insets.right),
            Some(292)
        );
    }

    #[test]
    fn a_page_outside_its_window_is_not_a_frame() {
        let window = Rect {
            x: 0,
            y: 0,
            width: 1000,
            height: 700,
        };
        for page in [
            Rect {
                x: -8,
                y: 87,
                width: 984,
                height: 600,
            },
            Rect {
                x: 8,
                y: 87,
                width: 1200,
                height: 600,
            },
            Rect {
                x: 8,
                y: 87,
                width: 984,
                height: 0,
            },
        ] {
            assert_eq!(page_insets(window, page), None);
        }
    }

    #[test]
    fn a_page_window_left_behind_by_a_tab_switch_is_not_a_frame() {
        let window = Rect {
            x: 738,
            y: -3,
            width: 1189,
            height: 1028,
        };
        // Seen live: after a tab opened in the dock window and moved out, the
        // page's child window sat at the top of the window while the page
        // itself was still below the browser's bars.
        let stale = Rect {
            x: 746,
            y: -3,
            width: 1173,
            height: 877,
        };
        assert_eq!(page_insets(window, stale), None);
        let current = Rect { y: 140, ..stale };
        assert_eq!(
            page_insets(window, current),
            Some(Insets {
                left: 8,
                top: 143,
                right: 8,
                bottom: 8,
            })
        );
    }

    #[test]
    fn the_page_size_gives_the_frame_when_its_window_cannot() {
        let window = Rect {
            x: 956,
            y: 11,
            width: 971,
            height: 910,
        };
        // Chrome 154 at 100% with the debugging bar: the frame its page window
        // gives when it shows.
        assert_eq!(
            viewport_insets(window, 955, 759),
            Some(Insets {
                left: 8,
                top: 143,
                right: 8,
                bottom: 8,
            })
        );
        // A page width rounded from CSS pixels can leave one pixel over.
        assert_eq!(
            viewport_insets(window, 954, 759),
            Some(Insets {
                left: 8,
                top: 143,
                right: 9,
                bottom: 8,
            })
        );
        // A device-emulated page is smaller than the window.
        assert_eq!(viewport_insets(window, 390, 759), None);
        assert_eq!(viewport_insets(window, 955, 905), None);
        assert_eq!(viewport_insets(window, 0, 759), None);
        assert_eq!(viewport_insets(window, 980, 759), None);
    }

    #[test]
    fn panel_coordinates_are_bounded_and_never_negative() {
        assert!(Layout {
            width: 800,
            height: 600,
            ..Default::default()
        }
        .valid());
        assert!(!Layout {
            x: -1,
            ..Default::default()
        }
        .valid());
        assert!(!Layout {
            width: i32::MAX,
            ..Default::default()
        }
        .valid());
        assert!(!Layout {
            cutouts: vec![Rect::default(); MAX_CUTOUTS + 1],
            ..Default::default()
        }
        .valid());
        assert!(!Layout {
            cutouts: vec![Rect {
                x: -5,
                ..Default::default()
            }],
            ..Default::default()
        }
        .valid());
    }

    #[test]
    fn stale_workspace_cleanup_cannot_hide_a_newer_panel() {
        let mut layout = Layout {
            visible: true,
            revision: 10,
            ..Default::default()
        };
        layout.update(Layout {
            visible: false,
            revision: 9,
            ..Default::default()
        });
        assert!(layout.visible);
        layout.update(Layout {
            visible: false,
            revision: 11,
            ..Default::default()
        });
        assert!(!layout.visible);
        layout.update(Layout {
            visible: true,
            revision: 10,
            ..Default::default()
        });
        assert!(!layout.visible);
    }

    #[test]
    fn diagnostics_never_selects_or_attaches_an_unknown_tab() {
        assert!(diagnostics(i64::MAX).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn dock_host_remains_available_with_embedded_browser_children() {
        use tauri::{Manager, WebviewBuilder, WebviewWindowBuilder};
        let app = tauri::test::mock_app();
        assert!(main_window(app.handle()).is_err());
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert!(app.get_webview_window("main").is_some());
        let window = main_window(app.handle()).unwrap();
        window
            .add_child(
                WebviewBuilder::new("embedded-browser", Default::default()),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(800.0, 600.0),
            )
            .unwrap();
        assert!(app.get_webview_window("main").is_none());
        assert_eq!(main_window(app.handle()).unwrap().label(), main.label());
    }
}

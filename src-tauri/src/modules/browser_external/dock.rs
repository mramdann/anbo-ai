use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
    pub revision: u64,
}

impl Layout {
    fn update(&mut self, next: Self) {
        if next.revision > self.revision {
            *self = next;
        }
    }

    fn valid(&self) -> bool {
        (0..=16_384).contains(&self.x)
            && (0..=16_384).contains(&self.y)
            && (0..=16_384).contains(&self.width)
            && (0..=16_384).contains(&self.height)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    dock_id: Option<String>,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Presentation {
    lease_live: bool,
    geometry_available: bool,
    client_width: i32,
    client_height: i32,
    foreground_in_group: bool,
    host_visible: bool,
    host_minimized: bool,
    browser_visible: bool,
    browser_minimized: bool,
}

#[cfg(any(windows, test))]
impl Presentation {
    fn hidden_reason(&self, layout: Layout) -> Option<&'static str> {
        if !self.lease_live {
            Some("window-identity-lost")
        } else if !layout.visible {
            Some("panel-hidden-or-covered")
        } else if !self.geometry_available {
            Some("host-geometry-unavailable")
        } else if layout.width < 400 || layout.height < 300 {
            Some("panel-too-small")
        } else if layout.x + layout.width > self.client_width
            || layout.y + layout.height > self.client_height
        {
            Some("panel-outside-host")
        } else if self.host_minimized || !self.host_visible {
            Some("host-hidden-or-minimized")
        } else if !self.foreground_in_group {
            Some("another-application-is-active")
        } else {
            None
        }
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
    if !cfg!(debug_assertions) || app.config().identifier == "com.anbo.desktop" {
        return Err("Native docking is available only in an isolated development build".into());
    }
    if request.layout.is_some_and(|layout| !layout.valid()) {
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
    native::reconcile();
}

pub fn contains(tab_id: i64) -> bool {
    #[cfg(windows)]
    {
        native::contains(tab_id)
    }
    #[cfg(not(windows))]
    {
        let _ = tab_id;
        false
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
        dock_window::{window_bounds, Bounds, Lease},
        get_target, ExternalTarget,
    };
    use serde_json::json;
    use std::sync::{LazyLock, Mutex};
    use std::time::Duration;
    use tauri::Emitter;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::*;

    struct Dock {
        target: ExternalTarget,
        lease: Lease,
        app: AppHandle,
        host: usize,
        layout: Layout,
        shown: bool,
        requested: Option<Bounds>,
        foreground: usize,
        hooks: Vec<usize>,
        last_presentation: Option<Presentation>,
        last_error: Option<String>,
    }

    static DOCK: Mutex<Option<Dock>> = Mutex::new(None);
    static OPERATIONS: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    pub(super) fn contains(tab_id: i64) -> bool {
        DOCK.lock().ok().is_some_and(|dock| {
            dock.as_ref()
                .is_some_and(|dock| dock.target.tab_id == tab_id)
        })
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
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event == EVENT_SYSTEM_MOVESIZEEND {
            let tab_id = DOCK.try_lock().ok().and_then(|state| {
                state
                    .as_ref()
                    .filter(|dock| dock.lease.hwnd() == window)
                    .map(|dock| dock.target.tab_id)
            });
            if let Some(dock) = tab_id.and_then(take) {
                tauri::async_runtime::spawn(async move {
                    let _ = release(dock).await;
                });
            }
            return;
        }
        let relevant = DOCK.try_lock().ok().is_some_and(|dock| {
            dock.as_ref().is_some_and(|dock| {
                event == EVENT_SYSTEM_FOREGROUND
                    || (object == 0
                        && (window.0 as usize == dock.host || window == dock.lease.hwnd()))
            })
        });
        if relevant {
            reconcile();
        }
    }

    async fn hooks(app: &AppHandle, browser_process: u32) -> Result<Vec<usize>, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let mut hooks = Vec::new();
            for (kind, process) in [
                (EVENT_SYSTEM_FOREGROUND, 0),
                (EVENT_OBJECT_LOCATIONCHANGE, std::process::id()),
                (EVENT_OBJECT_LOCATIONCHANGE, browser_process),
                (EVENT_SYSTEM_MOVESIZEEND, browser_process),
            ] {
                let hook = unsafe {
                    SetWinEventHook(
                        kind,
                        kind,
                        None,
                        Some(event),
                        process,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    )
                };
                if hook.0.is_null() {
                    for handle in hooks {
                        unsafe {
                            let _ = UnhookWinEvent(HWINEVENTHOOK(handle as *mut _));
                        }
                    }
                    let _ = sender.send(Err("Could not observe native window changes".to_string()));
                    return;
                }
                hooks.push(hook.0 as usize);
            }
            let _ = sender.send(Ok(hooks));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "Anbo closed while preparing docking".to_string())?
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

    fn restore(dock: &Dock) {
        dock.lease.restore();
        let _ = dock.app.emit_to(
            "main",
            "anbo:browser-dock-released",
            json!({"tabId":dock.target.tab_id,"dockId":dock.lease.token}),
        );
        let hooks = dock.hooks.clone();
        let _ = dock.app.run_on_main_thread(move || {
            for handle in hooks {
                unsafe {
                    let _ = UnhookWinEvent(HWINEVENTHOOK(handle as *mut _));
                }
            }
        });
    }

    pub(super) fn remove(tab_id: i64) {
        if let Some(dock) = take(tab_id) {
            restore(&dock);
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
            restore(&dock);
        }
    }
    pub(super) fn remove_all() {
        if let Some(dock) = DOCK.lock().ok().and_then(|mut state| state.take()) {
            restore(&dock);
        }
    }

    fn presentation(dock: &Dock) -> (Presentation, POINT, HWND) {
        let host = HWND(dock.host as *mut _);
        let foreground = unsafe { GetForegroundWindow() };
        let root = unsafe { GetAncestor(foreground, GA_ROOTOWNER) };
        let mut client = windows::Win32::Foundation::RECT::default();
        let mut origin = POINT::default();
        let geometry = unsafe {
            GetClientRect(host, &mut client).is_ok() && ClientToScreen(host, &mut origin).as_bool()
        };
        (
            Presentation {
                lease_live: dock.lease.live(),
                geometry_available: geometry,
                client_width: client.right,
                client_height: client.bottom,
                foreground_in_group: foreground == host
                    || foreground == dock.lease.hwnd()
                    || root == dock.lease.hwnd(),
                host_visible: unsafe { IsWindowVisible(host).as_bool() },
                host_minimized: unsafe { IsIconic(host).as_bool() },
                browser_visible: unsafe { IsWindowVisible(dock.lease.hwnd()).as_bool() },
                browser_minimized: unsafe { IsIconic(dock.lease.hwnd()).as_bool() },
            },
            origin,
            foreground,
        )
    }

    pub(super) fn diagnostics(tab_id: i64) -> Option<serde_json::Value> {
        let state = DOCK.lock().ok()?;
        let dock = state.as_ref().filter(|dock| dock.target.tab_id == tab_id)?;
        let (current, _, _) = presentation(dock);
        Some(json!({
            "layout": dock.layout,
            "hiddenReason": current.hidden_reason(dock.layout),
            "current": current,
            "lastReconciled": dock.last_presentation,
            "requestedBounds": dock.requested,
            "actualBounds": window_bounds(dock.lease.hwnd()).ok(),
            "lastWindowError": dock.last_error,
        }))
    }

    pub(super) fn reconcile() {
        let Ok(mut state) = DOCK.try_lock() else {
            return;
        };
        let Some(dock) = state.as_mut() else {
            return;
        };
        let (current, origin, foreground) = presentation(dock);
        dock.last_presentation = Some(current.clone());
        if !current.lease_live {
            return;
        }
        let host = HWND(dock.host as *mut _);
        let layout = dock.layout;
        let visible = current.hidden_reason(layout).is_none();
        if visible {
            let bounds = Bounds {
                x: origin.x + layout.x,
                y: origin.y + layout.y,
                width: layout.width,
                height: layout.height,
            };
            if dock.requested != Some(bounds) || !dock.shown {
                let placed = unsafe {
                    SetWindowPos(
                        dock.lease.hwnd(),
                        None,
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
                    )
                };
                match placed {
                    Ok(()) => {
                        dock.requested = Some(bounds);
                        dock.last_error = None;
                    }
                    Err(error) => {
                        dock.last_error = Some(format!("Could not position browser: {error}"));
                        return;
                    }
                }
            }
            if foreground == host && (dock.foreground != foreground.0 as usize || !dock.shown) {
                let raised = unsafe {
                    SetWindowPos(
                        dock.lease.hwnd(),
                        Some(HWND_TOP),
                        0,
                        0,
                        0,
                        0,
                        SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                    )
                };
                if let Err(error) = raised {
                    dock.last_error = Some(format!("Could not raise browser: {error}"));
                    return;
                }
            }
        } else if dock.shown {
            unsafe {
                let _ = ShowWindowAsync(dock.lease.hwnd(), SW_HIDE);
            }
        }
        dock.shown = visible;
        dock.foreground = foreground.0 as usize;
    }

    async fn release(dock: Dock) -> Result<(), String> {
        restore(&dock);
        let _ = dock
            .target
            .call(
                "anbo.guardDock",
                json!({"action":"restore","window":dock.lease}),
                Duration::from_secs(2),
            )
            .await;
        dock.target
            .call(
                "anbo.dockRelease",
                json!({"token":dock.lease.token}),
                Duration::from_secs(5),
            )
            .await?;
        if let Some(target) = registry::find_target(&dock.app, dock.target.tab_id) {
            activity::restore(&target);
        }
        Ok(())
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
                    restore(&dock);
                }
                return Ok(Status { dock_id: None });
            }
            let Some(dock) = state
                .as_mut()
                .filter(|dock| dock.target.tab_id == request.tab_id)
            else {
                return Ok(Status { dock_id: None });
            };
            if !matches!(request.action, Action::Status)
                && request.dock_id.as_deref() != Some(&dock.lease.token)
            {
                return Err("Dock identity changed".into());
            }
            match request.action {
                Action::Status => {
                    return Ok(Status {
                        dock_id: Some(dock.lease.token.clone()),
                    })
                }
                Action::Layout => {
                    dock.layout
                        .update(request.layout.ok_or("Missing dock layout")?);
                    let id = dock.lease.token.clone();
                    drop(state);
                    reconcile();
                    return Ok(Status { dock_id: Some(id) });
                }
                _ => {}
            }
        }
        let lock = registry::get_tab_lock(request.tab_id);
        let _tab = lock.lock().await;
        if matches!(request.action, Action::Release) {
            if let Some(dock) = take(request.tab_id) {
                release(dock).await?;
            }
            return Ok(Status { dock_id: None });
        }
        if crate::modules::browser_automation::design::is_active(request.tab_id) {
            return Err("Exit design mode before docking this tab".into());
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
        let browser = target
            .profile()
            .and_then(|profile| profile["browser"].as_str().map(str::to_owned))
            .ok_or("Browser profile unavailable")?;
        let token = format!(
            "{}{}",
            super::super::random_id()?,
            super::super::random_id()?
        );
        target
            .call(
                "anbo.dockPrepare",
                json!({"token":token}),
                Duration::from_secs(5),
            )
            .await?;
        let prepare = async {
            let mut lease = None;
            for _ in 0..20 {
                if let Ok(found) = locate(&token, &browser) {
                    lease = Some(found);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
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
            let installed_hooks = match hooks(app, lease.process).await {
                Ok(hooks) => hooks,
                Err(error) => {
                    lease.restore();
                    return Err(error);
                }
            };
            let dock = Dock {
                target: target.clone(),
                lease,
                app: app.clone(),
                host,
                layout: Layout {
                    visible: false,
                    ..request.layout.unwrap_or_default()
                },
                shown: true,
                requested: None,
                foreground: 0,
                hooks: installed_hooks,
                last_presentation: None,
                last_error: None,
            };
            *DOCK.lock().map_err(|_| "Dock registry unavailable")? = Some(dock);
            if let Some(handle) = registry::find_target(app, request.tab_id) {
                let _ = handle
                    .eval("window.dispatchEvent(new CustomEvent('anbo-automation-visual-hide'));");
            }
            target
                .call(
                    "anbo.dockCommit",
                    json!({"token":token}),
                    Duration::from_secs(5),
                )
                .await?;
            reconcile();
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
        Ok(Status {
            dock_id: Some(token),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_reports_the_guard_that_hides_an_attached_window() {
        let layout = Layout {
            x: 672,
            y: 141,
            width: 1247,
            height: 771,
            visible: true,
            revision: 1,
        };
        let ready = Presentation {
            lease_live: true,
            geometry_available: true,
            client_width: 1920,
            client_height: 946,
            foreground_in_group: true,
            host_visible: true,
            ..Default::default()
        };
        assert_eq!(ready.hidden_reason(layout), None);
        for (state, expected) in [
            (
                Presentation {
                    lease_live: false,
                    ..ready.clone()
                },
                "window-identity-lost",
            ),
            (
                Presentation {
                    geometry_available: false,
                    ..ready.clone()
                },
                "host-geometry-unavailable",
            ),
            (
                Presentation {
                    client_width: 1918,
                    ..ready.clone()
                },
                "panel-outside-host",
            ),
            (
                Presentation {
                    client_height: 911,
                    ..ready.clone()
                },
                "panel-outside-host",
            ),
            (
                Presentation {
                    host_minimized: true,
                    ..ready.clone()
                },
                "host-hidden-or-minimized",
            ),
            (
                Presentation {
                    host_visible: false,
                    ..ready.clone()
                },
                "host-hidden-or-minimized",
            ),
            (
                Presentation {
                    foreground_in_group: false,
                    ..ready.clone()
                },
                "another-application-is-active",
            ),
        ] {
            assert_eq!(state.hidden_reason(layout), Some(expected));
        }
        assert_eq!(
            ready.hidden_reason(Layout {
                visible: false,
                ..layout
            }),
            Some("panel-hidden-or-covered")
        );
        assert_eq!(
            ready.hidden_reason(Layout {
                width: 399,
                ..layout
            }),
            Some("panel-too-small")
        );
        assert_eq!(
            ready.hidden_reason(Layout {
                height: 299,
                ..layout
            }),
            Some("panel-too-small")
        );
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
}

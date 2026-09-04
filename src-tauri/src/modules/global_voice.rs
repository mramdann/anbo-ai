use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const WINDOW_LABEL: &str = "voice";
pub const SHORTCUT: &str = "ctrl+alt+space";
pub const TOGGLE_EVENT: &str = "anbo://global-voice-toggle";
const RESTORE_INTERNAL_FOCUS_SCRIPT: &str = "(() => { const target = document.querySelector('[data-anbo-voice-target=\"true\"]'); if (target?.isConnected && target.getClientRects().length > 0) target.focus({ preventScroll: true }); })()";
const PENDING_INTERNAL_TARGET_MAX_AGE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct GlobalVoiceState {
    inner: Mutex<GlobalVoiceInner>,
}

#[derive(Default)]
struct GlobalVoiceInner {
    enabled: bool,
    target: Option<platform::CapturedTarget>,
    pending_internal_target: Option<PendingInternalTarget>,
}

struct PendingInternalTarget {
    target: platform::CapturedTarget,
    details: GlobalVoiceTarget,
    captured_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalVoiceStatus {
    supported: bool,
    enabled: bool,
    shortcut: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalVoiceTarget {
    label: String,
    window_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalVoiceInsertResult {
    inserted_utf16_units: usize,
}

pub fn handle_shortcut(app: &tauri::AppHandle) {
    let expected = SHORTCUT.parse::<tauri_plugin_global_shortcut::Shortcut>();
    let enabled = app
        .try_state::<GlobalVoiceState>()
        .and_then(|state| state.inner.lock().ok().map(|inner| inner.enabled))
        .unwrap_or(false);
    if !enabled || expected.is_err() {
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, TOGGLE_EVENT, ());
}

pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<GlobalVoiceState>() {
        if let Ok(mut inner) = state.inner.lock() {
            inner.enabled = false;
            inner.target = None;
            inner.pending_internal_target = None;
        }
    }
    if app.global_shortcut().is_registered(SHORTCUT) {
        let _ = app.global_shortcut().unregister(SHORTCUT);
    }
    platform::stop_foreground_tracking();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}

#[cfg(target_os = "windows")]
fn voice_window_handle(app: &tauri::AppHandle) -> Option<isize> {
    app.get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as isize)
}

fn request_internal_focus(app: &tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "The main Anbo window is unavailable.".to_string())?
        .eval(RESTORE_INTERNAL_FOCUS_SCRIPT)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
fn voice_window_handle(_app: &tauri::AppHandle) -> Option<isize> {
    None
}

fn place_window_at_default(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let work = monitor.work_area();
    let margin = (18.0 * monitor.scale_factor()).round() as i32;
    let x = work
        .position
        .x
        .saturating_add(work.size.width.saturating_sub(size.width) as i32)
        .saturating_sub(margin);
    let y = work
        .position
        .y
        .saturating_add(work.size.height.saturating_sub(size.height) as i32)
        .saturating_sub(margin);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn ensure_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.set_always_on_top(true);
        let _ = window.set_focusable(false);
        return Ok(window);
    }

    let builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("voice.html".into()))
            .title("AnboVoice")
            .inner_size(122.0, 42.0)
            .min_inner_size(122.0, 42.0)
            .max_inner_size(122.0, 42.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .visible(false);

    #[cfg(target_os = "windows")]
    let builder = builder.drag_and_drop(false);

    let window = builder.build().map_err(|error| error.to_string())?;
    place_window_at_default(&window);
    Ok(window)
}

#[tauri::command]
pub fn global_voice_status(state: tauri::State<'_, GlobalVoiceState>) -> GlobalVoiceStatus {
    let enabled = state
        .inner
        .lock()
        .map(|inner| inner.enabled)
        .unwrap_or(false);
    GlobalVoiceStatus {
        supported: platform::supported(),
        enabled,
        shortcut: SHORTCUT,
    }
}

#[tauri::command]
pub async fn global_voice_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalVoiceState>,
    enabled: bool,
) -> Result<GlobalVoiceStatus, String> {
    if enabled && !platform::supported() {
        return Err("Global AnboVoice is currently available on Windows only.".to_string());
    }

    if enabled {
        let mut registered_here = false;
        if !app.global_shortcut().is_registered(SHORTCUT) {
            app.global_shortcut()
                .register(SHORTCUT)
                .map_err(|error| format!("Could not register {SHORTCUT}: {error}"))?;
            registered_here = true;
        }
        let window = match ensure_window(&app) {
            Ok(window) => window,
            Err(error) => {
                if registered_here {
                    let _ = app.global_shortcut().unregister(SHORTCUT);
                }
                return Err(error);
            }
        };
        if let Err(error) = platform::start_foreground_tracking(voice_window_handle(&app)) {
            if registered_here {
                let _ = app.global_shortcut().unregister(SHORTCUT);
            }
            let _ = window.close();
            return Err(error);
        }
        if let Err(error) = window.show() {
            platform::stop_foreground_tracking();
            if registered_here {
                let _ = app.global_shortcut().unregister(SHORTCUT);
            }
            return Err(error.to_string());
        }
    } else {
        shutdown(&app);
    }

    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?;
    inner.enabled = enabled;
    if !enabled {
        inner.target = None;
        inner.pending_internal_target = None;
    }
    Ok(GlobalVoiceStatus {
        supported: platform::supported(),
        enabled,
        shortcut: SHORTCUT,
    })
}

#[tauri::command]
pub async fn global_voice_capture_target(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalVoiceState>,
) -> Result<GlobalVoiceTarget, String> {
    let enabled = state
        .inner
        .lock()
        .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
        .enabled;
    if !enabled {
        return Err("Global AnboVoice is disabled.".to_string());
    }

    let excluded_window = voice_window_handle(&app);
    let restore_internal =
        tauri::async_runtime::spawn_blocking(move || platform::prepare_capture(excluded_window))
            .await
            .map_err(|error| error.to_string())??;
    if restore_internal {
        let pending = state
            .inner
            .lock()
            .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
            .pending_internal_target
            .take()
            .filter(|pending| pending.captured_at.elapsed() <= PENDING_INTERNAL_TARGET_MAX_AGE);
        if let Some(pending) = pending {
            let target = pending.target.clone();
            let restored = tauri::async_runtime::spawn_blocking(move || {
                platform::restore_internal_target(&target)
            })
            .await
            .map_err(|error| error.to_string())?;
            if restored {
                state
                    .inner
                    .lock()
                    .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
                    .target = Some(pending.target);
                return Ok(pending.details);
            }
        }
        request_internal_focus(&app)?;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    let excluded_window = voice_window_handle(&app);
    let (target, details) =
        tauri::async_runtime::spawn_blocking(move || platform::capture_target(excluded_window))
            .await
            .map_err(|error| error.to_string())??;
    state
        .inner
        .lock()
        .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
        .target = Some(target);
    Ok(details)
}

#[tauri::command]
pub async fn global_voice_clear_target(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalVoiceState>,
) -> Result<(), String> {
    let target = state
        .inner
        .lock()
        .map(|mut inner| {
            let target = inner.target.take();
            inner.pending_internal_target = None;
            target
        })
        .unwrap_or(None);
    let excluded_window = voice_window_handle(&app);
    tauri::async_runtime::spawn_blocking(move || platform::restore_foreground(excluded_window))
        .await
        .map_err(|error| error.to_string())??;
    if let Some(target) = target.filter(platform::requires_internal_focus_restore) {
        let restored = tauri::async_runtime::spawn_blocking(move || {
            platform::restore_internal_target(&target)
        })
        .await
        .map_err(|error| error.to_string())?;
        if !restored {
            request_internal_focus(&app)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn global_voice_remember_foreground(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalVoiceState>,
) -> Result<(), String> {
    let excluded_window = voice_window_handle(&app);
    let pending = tauri::async_runtime::spawn_blocking(move || {
        platform::remember_foreground(excluded_window);
        platform::capture_target(excluded_window)
            .ok()
            .filter(|(target, _)| platform::requires_internal_focus_restore(target))
    })
    .await
    .map_err(|error| error.to_string())?;
    state
        .inner
        .lock()
        .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
        .pending_internal_target = pending.map(|(target, details)| PendingInternalTarget {
        target,
        details,
        captured_at: Instant::now(),
    });
    Ok(())
}

#[tauri::command]
pub async fn global_voice_insert_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, GlobalVoiceState>,
    text: String,
) -> Result<GlobalVoiceInsertResult, String> {
    let target = state
        .inner
        .lock()
        .map_err(|_| "Global AnboVoice state is unavailable.".to_string())?
        .target
        .take()
        .ok_or_else(|| "The original input target is no longer available.".to_string())?;
    let excluded_window = voice_window_handle(&app);
    if platform::requires_internal_focus_restore(&target) {
        tauri::async_runtime::spawn_blocking(move || platform::restore_foreground(excluded_window))
            .await
            .map_err(|error| error.to_string())??;
        let internal_target = target.clone();
        let restored = tauri::async_runtime::spawn_blocking(move || {
            platform::restore_internal_target(&internal_target)
        })
        .await
        .map_err(|error| error.to_string())?;
        if !restored {
            request_internal_focus(&app)?;
        }
        let restored = restored
            || tauri::async_runtime::spawn_blocking(platform::wait_for_internal_focus)
                .await
                .map_err(|error| error.to_string())?;
        if !restored {
            return Err("Anbo could not restore the selected terminal input.".to_string());
        }
    }
    let excluded_window = voice_window_handle(&app);
    let inserted_utf16_units = tauri::async_runtime::spawn_blocking(move || {
        platform::insert_text(&target, &text, excluded_window)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(GlobalVoiceInsertResult {
        inserted_utf16_units,
    })
}

#[cfg(target_os = "windows")]
mod platform {
    use super::GlobalVoiceTarget;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Ole::{
        SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, SetWinEventHook, TreeScope_Descendants, UnhookWinEvent,
        HWINEVENTHOOK, IUIAutomationElement,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VK_RETURN, VK_TAB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindow, SetForegroundWindow, EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT,
    };

    const MAX_TRANSCRIPT_UTF16_UNITS: usize = 32_000;
    const MAX_RUNTIME_ID_ITEMS: usize = 64;
    const POINTER_FOREGROUND_MAX_AGE_MS: u64 = 2_500;
    static VOICE_WINDOW: AtomicIsize = AtomicIsize::new(0);
    static LAST_NON_VOICE_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
    static POINTER_FOREGROUND: AtomicIsize = AtomicIsize::new(0);
    static POINTER_FOREGROUND_AT: AtomicU64 = AtomicU64::new(0);
    static FOREGROUND_HOOK: AtomicIsize = AtomicIsize::new(0);
    static CLOCK_START: OnceLock<Instant> = OnceLock::new();

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct CapturedTarget {
        hwnd: isize,
        focused_process_id: i32,
        runtime_id: Vec<i32>,
        application_owned: bool,
        internal_text_input: bool,
        focused_class_name: String,
    }

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            result
                .ok()
                .map_err(|error| format!("Windows accessibility is unavailable: {error}"))?;
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub fn supported() -> bool {
        true
    }

    unsafe extern "system" fn foreground_changed(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        let raw = hwnd.0 as isize;
        if raw != 0
            && raw != VOICE_WINDOW.load(Ordering::Relaxed)
            && unsafe { IsWindow(Some(hwnd)) }.as_bool()
        {
            LAST_NON_VOICE_FOREGROUND.store(raw, Ordering::Relaxed);
        }
    }

    pub fn start_foreground_tracking(voice_window: Option<isize>) -> Result<(), String> {
        stop_foreground_tracking();
        let Some(voice_window) = voice_window.filter(|handle| *handle != 0) else {
            return Err("Could not identify the AnboVoice overlay window.".to_string());
        };
        VOICE_WINDOW.store(voice_window, Ordering::Relaxed);
        let current = unsafe { GetForegroundWindow() };
        let current_raw = current.0 as isize;
        if current_raw != 0 && current_raw != voice_window {
            LAST_NON_VOICE_FOREGROUND.store(current_raw, Ordering::Relaxed);
        }
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(foreground_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_invalid() {
            VOICE_WINDOW.store(0, Ordering::Relaxed);
            LAST_NON_VOICE_FOREGROUND.store(0, Ordering::Relaxed);
            return Err("Could not monitor the active Windows application.".to_string());
        }
        FOREGROUND_HOOK.store(hook.0 as isize, Ordering::Relaxed);
        Ok(())
    }

    pub fn stop_foreground_tracking() {
        let raw = FOREGROUND_HOOK.swap(0, Ordering::Relaxed);
        if raw != 0 {
            let _ = unsafe { UnhookWinEvent(HWINEVENTHOOK(raw as *mut c_void)) };
        }
        VOICE_WINDOW.store(0, Ordering::Relaxed);
        LAST_NON_VOICE_FOREGROUND.store(0, Ordering::Relaxed);
        POINTER_FOREGROUND.store(0, Ordering::Relaxed);
        POINTER_FOREGROUND_AT.store(0, Ordering::Relaxed);
    }

    fn monotonic_millis() -> u64 {
        (CLOCK_START
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64)
            .saturating_add(1)
    }

    pub fn remember_foreground(excluded_window: Option<isize>) -> bool {
        let current = unsafe { GetForegroundWindow() };
        let raw = current.0 as isize;
        if raw == 0 || excluded_window == Some(raw) || !unsafe { IsWindow(Some(current)) }.as_bool()
        {
            return false;
        }
        LAST_NON_VOICE_FOREGROUND.store(raw, Ordering::Relaxed);
        POINTER_FOREGROUND.store(raw, Ordering::Relaxed);
        POINTER_FOREGROUND_AT.store(monotonic_millis(), Ordering::Relaxed);
        window_is_application_owned(current)
    }

    pub fn restore_foreground(excluded_window: Option<isize>) -> Result<(), String> {
        input_foreground(excluded_window).map(|_| ())
    }

    pub fn prepare_capture(excluded_window: Option<isize>) -> Result<bool, String> {
        let foreground = input_foreground(excluded_window)?;
        POINTER_FOREGROUND.store(0, Ordering::Relaxed);
        POINTER_FOREGROUND_AT.store(0, Ordering::Relaxed);
        Ok(window_is_application_owned(foreground))
    }

    pub fn wait_for_internal_focus() -> bool {
        for _ in 0..50 {
            if focused_is_internal_input() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    pub fn restore_internal_target(target: &CapturedTarget) -> bool {
        if !target.internal_text_input {
            return false;
        }
        let window = HWND(target.hwnd as *mut c_void);
        if !unsafe { IsWindow(Some(window)) }.as_bool() || !window_is_application_owned(window) {
            return false;
        }
        let Ok(_apartment) = ComApartment::initialize() else {
            return false;
        };
        let Ok(automation): Result<IUIAutomation, _> =
            (unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) })
        else {
            return false;
        };
        let Ok(root) = (unsafe { automation.ElementFromHandle(window) }) else {
            return false;
        };
        let Ok(condition) = (unsafe { automation.CreateTrueCondition() }) else {
            return false;
        };
        let Ok(elements) = (unsafe { root.FindAll(TreeScope_Descendants, &condition) }) else {
            return false;
        };
        let length = unsafe { elements.Length() }
            .unwrap_or_default()
            .clamp(0, 4_096);
        let mut fallback: Option<IUIAutomationElement> = None;
        for index in 0..length {
            let Ok(element) = (unsafe { elements.GetElement(index) }) else {
                continue;
            };
            let class_name = unsafe { element.CurrentClassName() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            if !is_internal_input_class(&class_name) {
                continue;
            }
            let process_id = unsafe { element.CurrentProcessId() }.unwrap_or_default();
            if process_id != target.focused_process_id {
                continue;
            }
            let Ok(id) = runtime_id(&element) else {
                continue;
            };
            if !target.focused_class_name.is_empty()
                && class_name == target.focused_class_name
                && fallback.is_none()
            {
                fallback = Some(element.clone());
            }
            if id == target.runtime_id && unsafe { element.SetFocus() }.is_ok() {
                return true;
            }
        }
        if let Some(element) = fallback {
            return unsafe { element.SetFocus() }.is_ok();
        }
        false
    }

    pub fn requires_internal_focus_restore(target: &CapturedTarget) -> bool {
        target.internal_text_input
    }

    fn window_is_application_owned(window: HWND) -> bool {
        let mut process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
        process_id == std::process::id()
    }

    const INTERNAL_INPUT_CLASSES: [&str; 2] = ["xterm-helper-textarea", "cm-content"];

    // UI Automation reports a Chromium element's whole class attribute, so a
    // CodeMirror surface arrives as "cm-content cm-lineWrapping" and never
    // matched a whole string comparison. Only xterm happened to carry one token.
    fn is_internal_input_class(class_name: &str) -> bool {
        class_name
            .split_whitespace()
            .any(|token| INTERNAL_INPUT_CLASSES.contains(&token))
    }

    fn focused_is_internal_input() -> bool {
        let Ok(_apartment) = ComApartment::initialize() else {
            return false;
        };
        let Ok(automation): Result<IUIAutomation, _> =
            (unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) })
        else {
            return false;
        };
        let Ok(focused) = (unsafe { automation.GetFocusedElement() }) else {
            return false;
        };
        unsafe { focused.CurrentClassName() }
            .map(|name| is_internal_input_class(&name.to_string()))
            .unwrap_or(false)
    }

    fn take_pointer_foreground() -> Option<isize> {
        let raw = POINTER_FOREGROUND.swap(0, Ordering::Relaxed);
        let captured_at = POINTER_FOREGROUND_AT.swap(0, Ordering::Relaxed);
        if raw == 0
            || captured_at == 0
            || monotonic_millis().saturating_sub(captured_at) > POINTER_FOREGROUND_MAX_AGE_MS
        {
            return None;
        }
        let window = HWND(raw as *mut c_void);
        unsafe { IsWindow(Some(window)) }.as_bool().then_some(raw)
    }

    fn input_foreground(excluded_window: Option<isize>) -> Result<HWND, String> {
        let current = unsafe { GetForegroundWindow() };
        let current_raw = current.0 as isize;
        if excluded_window != Some(current_raw) {
            if current_raw != 0 {
                LAST_NON_VOICE_FOREGROUND.store(current_raw, Ordering::Relaxed);
            }
            return Ok(current);
        }

        let previous = take_pointer_foreground()
            .unwrap_or_else(|| LAST_NON_VOICE_FOREGROUND.load(Ordering::Relaxed));
        let previous_window = HWND(previous as *mut c_void);
        if previous == 0 || !unsafe { IsWindow(Some(previous_window)) }.as_bool() {
            return Err("Place the cursor in an input before starting AnboVoice.".to_string());
        }
        if !unsafe { SetForegroundWindow(previous_window) }.as_bool() {
            return Err("AnboVoice could not restore the previous input window.".to_string());
        }
        std::thread::sleep(Duration::from_millis(12));
        let restored = unsafe { GetForegroundWindow() };
        if restored != previous_window {
            return Err("AnboVoice could not restore the previous input window.".to_string());
        }
        LAST_NON_VOICE_FOREGROUND.store(previous, Ordering::Relaxed);
        Ok(restored)
    }

    fn window_title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return "Windows app".to_string();
        }
        let mut buffer = vec![0_u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..copied])
    }

    fn runtime_id(
        element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> Result<Vec<i32>, String> {
        let array = unsafe { element.GetRuntimeId() }
            .map_err(|error| format!("Could not identify the focused input: {error}"))?;
        if array.is_null() {
            return Err("The focused input did not provide a stable identity.".to_string());
        }
        let result = (|| {
            let lower =
                unsafe { SafeArrayGetLBound(array, 1) }.map_err(|error| error.to_string())?;
            let upper =
                unsafe { SafeArrayGetUBound(array, 1) }.map_err(|error| error.to_string())?;
            if upper < lower || (upper - lower + 1) as usize > MAX_RUNTIME_ID_ITEMS {
                return Err("The focused input returned an invalid identity.".to_string());
            }
            let mut id = Vec::with_capacity((upper - lower + 1) as usize);
            for index in lower..=upper {
                let mut value = 0_i32;
                unsafe {
                    SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast::<c_void>())
                }
                .map_err(|error| error.to_string())?;
                id.push(value);
            }
            Ok(id)
        })();
        let _ = unsafe { SafeArrayDestroy(array) };
        result
    }

    fn focused_target(
        excluded_window: Option<isize>,
    ) -> Result<(CapturedTarget, GlobalVoiceTarget, bool), String> {
        let hwnd = input_foreground(excluded_window)?;
        if hwnd.0.is_null() || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("Place the cursor in an app before starting AnboVoice.".to_string());
        }
        if excluded_window == Some(hwnd.0 as isize) {
            return Err("Place the cursor in an input before starting AnboVoice.".to_string());
        }

        let _apartment = ComApartment::initialize()?;
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("Windows accessibility is unavailable: {error}"))?;
        let focused = unsafe { automation.GetFocusedElement() }
            .map_err(|error| format!("Could not inspect the focused input: {error}"))?;
        let password = unsafe { focused.CurrentIsPassword() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let focused_process_id = unsafe { focused.CurrentProcessId() }.unwrap_or_default();
        let class_name = unsafe { focused.CurrentClassName() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let id = runtime_id(&focused)?;
        let title = window_title(hwnd);
        let name = unsafe { focused.CurrentName() }
            .map(|value| value.to_string())
            .unwrap_or_default();
        let label = if name.trim().is_empty() {
            title.clone()
        } else {
            name
        };
        let application_owned = window_is_application_owned(hwnd);
        Ok((
            CapturedTarget {
                hwnd: hwnd.0 as isize,
                focused_process_id,
                runtime_id: id,
                application_owned,
                internal_text_input: application_owned && is_internal_input_class(&class_name),
                focused_class_name: class_name.clone(),
            },
            GlobalVoiceTarget {
                label,
                window_title: title,
            },
            password,
        ))
    }

    pub fn capture_target(
        excluded_window: Option<isize>,
    ) -> Result<(CapturedTarget, GlobalVoiceTarget), String> {
        let (target, details, password) = focused_target(excluded_window)?;
        if password {
            return Err("AnboVoice never inserts text into password fields.".to_string());
        }
        Ok((target, details))
    }

    fn keyboard_input(
        vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
        scan: u16,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
    ) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn append_key_pair(
        inputs: &mut Vec<INPUT>,
        vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
        scan: u16,
        flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS,
    ) {
        inputs.push(keyboard_input(vk, scan, flags));
        inputs.push(keyboard_input(vk, scan, flags | KEYEVENTF_KEYUP));
    }

    fn text_inputs(text: &str) -> Result<(Vec<INPUT>, usize), String> {
        if text.contains('\0') {
            return Err("The transcript contains an unsupported null character.".to_string());
        }
        let units = text.encode_utf16().count();
        if units == 0 {
            return Err("The transcript is empty.".to_string());
        }
        if units > MAX_TRANSCRIPT_UTF16_UNITS {
            return Err("The transcript is too long to insert safely.".to_string());
        }

        let mut inputs = Vec::with_capacity(units.saturating_mul(2));
        for unit in text.encode_utf16() {
            match unit {
                10 => append_key_pair(&mut inputs, VK_RETURN, 0, Default::default()),
                13 => {}
                9 => append_key_pair(&mut inputs, VK_TAB, 0, Default::default()),
                _ => append_key_pair(&mut inputs, Default::default(), unit, KEYEVENTF_UNICODE),
            }
        }
        Ok((inputs, units))
    }

    pub fn insert_text(
        target: &CapturedTarget,
        text: &str,
        excluded_window: Option<isize>,
    ) -> Result<usize, String> {
        insert_text_excluding(target, text, excluded_window)
    }

    fn is_same_input(target: &CapturedTarget, current: &CapturedTarget) -> bool {
        target == current
            || (!target.internal_text_input
                && !current.internal_text_input
                && target.application_owned
                && current.application_owned
                && target.hwnd == current.hwnd)
            || (target.application_owned
                && current.application_owned
                && target.internal_text_input
                && current.internal_text_input
                && target.hwnd == current.hwnd
                && target.focused_class_name == current.focused_class_name)
    }

    fn insert_text_excluding(
        target: &CapturedTarget,
        text: &str,
        excluded_window: Option<isize>,
    ) -> Result<usize, String> {
        let (current, _, password) = focused_target(excluded_window)?;
        if password {
            return Err("AnboVoice never inserts text into password fields.".to_string());
        }
        if !is_same_input(target, &current) {
            log::warn!(
                "global voice input changed: target_hwnd={} target_pid={} target_owned={} current_hwnd={} current_pid={} current_owned={}",
                target.hwnd,
                target.focused_process_id,
                target.application_owned,
                current.hwnd,
                current.focused_process_id,
                current.application_owned,
            );
            return Err(
                "The focused input changed while AnboVoice was listening. The transcript was kept instead of being sent to the wrong app."
                    .to_string(),
            );
        }

        let (inputs, units) = text_inputs(text)?;
        for chunk in inputs.chunks(256) {
            let sent = unsafe { SendInput(chunk, std::mem::size_of::<INPUT>() as i32) } as usize;
            if sent != chunk.len() {
                return Err(
                    "Windows blocked text insertion. The target may be running as administrator."
                        .to_string(),
                );
            }
        }
        Ok(units)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::Duration;
        use windows::core::w;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            mouse_event, SetFocus, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, SetCursorPos,
            SetForegroundWindow, TranslateMessage, ES_MULTILINE, MSG, PM_REMOVE, WINDOW_EX_STYLE,
            WINDOW_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };

        #[test]
        fn text_input_preserves_unicode_and_normalizes_crlf() {
            let (inputs, units) = text_inputs("Halo ✓\r\nbaris 2").unwrap();
            assert_eq!(units, "Halo ✓\r\nbaris 2".encode_utf16().count());
            assert_eq!(inputs.len(), (units - 1) * 2);
        }

        #[test]
        fn text_input_rejects_empty_null_and_oversized_transcripts() {
            assert!(text_inputs("").is_err());
            assert!(text_inputs("a\0b").is_err());
            assert!(text_inputs(&"a".repeat(MAX_TRANSCRIPT_UTF16_UNITS + 1)).is_err());
        }

        #[test]
        fn internal_input_classes_cover_terminals_and_codemirror() {
            assert!(is_internal_input_class("xterm-helper-textarea"));
            assert!(is_internal_input_class("cm-content"));
            assert!(!is_internal_input_class("Tauri Window"));

            // The terminal block always ships lineWrapping, and the editor adds
            // it whenever word wrap is on. Both used to be rejected outright.
            assert!(is_internal_input_class("cm-content cm-lineWrapping"));
            assert!(is_internal_input_class(
                "cm-content cm-lineWrapping cm-focused"
            ));
            assert!(is_internal_input_class(
                "  cm-lineWrapping   cm-content  "
            ));

            // A token has to match whole, never as a prefix or a substring.
            assert!(!is_internal_input_class("cm-contenteditable"));
            assert!(!is_internal_input_class("precm-content"));
            assert!(!is_internal_input_class(""));
        }

        #[test]
        fn captured_target_equality_includes_window_process_and_runtime_id() {
            let base = CapturedTarget {
                hwnd: 7,
                focused_process_id: 11,
                runtime_id: vec![42, 9],
                application_owned: false,
                internal_text_input: false,
                focused_class_name: "EDIT".to_string(),
            };
            assert_eq!(base, base.clone());
            assert_ne!(
                base,
                CapturedTarget {
                    hwnd: 8,
                    ..base.clone()
                }
            );
            let owned = CapturedTarget {
                application_owned: true,
                ..base.clone()
            };
            assert!(is_same_input(
                &owned,
                &CapturedTarget {
                    runtime_id: vec![99, 4],
                    ..owned.clone()
                }
            ));
            let internal = CapturedTarget {
                internal_text_input: true,
                ..owned.clone()
            };
            assert!(is_same_input(
                &internal,
                &CapturedTarget {
                    runtime_id: vec![99, 4],
                    ..internal.clone()
                }
            ));
            assert!(is_same_input(
                &owned,
                &CapturedTarget {
                    focused_process_id: 12,
                    runtime_id: vec![99, 4],
                    ..owned.clone()
                }
            ));
            assert!(!is_same_input(
                &owned,
                &CapturedTarget {
                    hwnd: 8,
                    ..owned.clone()
                }
            ));
            assert!(!is_same_input(
                &base,
                &CapturedTarget {
                    runtime_id: vec![99, 4],
                    ..base.clone()
                }
            ));
            assert_ne!(
                base,
                CapturedTarget {
                    focused_process_id: 12,
                    ..base.clone()
                }
            );
            assert_ne!(
                base,
                CapturedTarget {
                    runtime_id: vec![42, 10],
                    ..base.clone()
                }
            );
        }

        #[test]
        fn inserts_unicode_into_a_real_windows_edit_control() {
            let style = WS_OVERLAPPEDWINDOW | WS_VISIBLE | WINDOW_STYLE(ES_MULTILINE as u32);
            let window = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("EDIT"),
                    w!(""),
                    style,
                    100,
                    100,
                    420,
                    180,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .expect("test edit window should be created");
            let _ = unsafe { SetForegroundWindow(window) };
            unsafe { SetFocus(Some(window)) }.expect("test edit window should accept focus");
            unsafe {
                SetCursorPos(180, 140).expect("test cursor should move to the edit window");
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            }
            std::thread::sleep(Duration::from_millis(120));

            let (target, _, password) =
                focused_target(None).expect("test edit target should be captured");
            assert_eq!(target.hwnd, window.0 as isize);
            assert!(!password);
            let excluded_error = focused_target(Some(target.hwnd))
                .expect_err("the overlay window must never capture itself");
            assert!(excluded_error.contains("cursor"));
            let expected = "Halo Anbo ✓ 漢字\r\nbaris dua";
            insert_text_excluding(&target, expected, None)
                .expect("unicode transcript should be inserted");
            let deadline = std::time::Instant::now() + Duration::from_millis(300);
            while std::time::Instant::now() < deadline {
                let mut event = MSG::default();
                while unsafe { PeekMessageW(&mut event, None, 0, 0, PM_REMOVE) }.as_bool() {
                    unsafe {
                        let _ = TranslateMessage(&event);
                        DispatchMessageW(&event);
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }

            let mut buffer = vec![0_u16; 128];
            let copied = unsafe { GetWindowTextW(window, &mut buffer) } as usize;
            let actual = String::from_utf16_lossy(&buffer[..copied]);
            unsafe { DestroyWindow(window) }.expect("test edit window should be destroyed");
            assert_eq!(actual, expected);
        }

        #[test]
        fn refuses_a_changed_target_and_detects_password_controls() {
            let normal = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("EDIT"),
                    w!(""),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    100,
                    100,
                    360,
                    140,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .expect("normal edit window should be created");
            let password = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("EDIT"),
                    w!(""),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE | WINDOW_STYLE(0x20),
                    520,
                    100,
                    360,
                    140,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .expect("password edit window should be created");

            let _ = unsafe { SetForegroundWindow(normal) };
            unsafe { SetFocus(Some(normal)) }.expect("normal edit should accept focus");
            unsafe {
                SetCursorPos(180, 140).expect("cursor should move to the normal edit");
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            }
            std::thread::sleep(Duration::from_millis(120));
            let (target, _, is_password) =
                focused_target(None).expect("normal edit should be captured");
            assert!(!is_password);

            let _ = unsafe { SetForegroundWindow(password) };
            unsafe { SetFocus(Some(password)) }.expect("password edit should accept focus");
            unsafe {
                SetCursorPos(600, 140).expect("cursor should move to the password edit");
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            }
            std::thread::sleep(Duration::from_millis(120));
            let (_, _, is_password) =
                focused_target(None).expect("password edit should be inspected");
            assert!(is_password);
            let error = insert_text_excluding(&target, "must not appear", None)
                .expect_err("changed password target must be rejected");
            assert!(error.contains("password"));

            unsafe { DestroyWindow(normal) }.expect("normal edit should be destroyed");
            unsafe { DestroyWindow(password) }.expect("password edit should be destroyed");
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::GlobalVoiceTarget;

    #[derive(Clone, Debug)]
    pub struct CapturedTarget;

    pub fn supported() -> bool {
        false
    }

    pub fn start_foreground_tracking(_voice_window: Option<isize>) -> Result<(), String> {
        Ok(())
    }

    pub fn stop_foreground_tracking() {}

    pub fn remember_foreground(_excluded_window: Option<isize>) -> bool {
        false
    }

    pub fn prepare_capture(_excluded_window: Option<isize>) -> Result<bool, String> {
        Ok(false)
    }

    pub fn wait_for_internal_focus() -> bool {
        false
    }

    pub fn restore_internal_target(_target: &CapturedTarget) -> bool {
        false
    }

    pub fn requires_internal_focus_restore(_target: &CapturedTarget) -> bool {
        false
    }

    pub fn restore_foreground(_excluded_window: Option<isize>) -> Result<(), String> {
        Ok(())
    }

    pub fn capture_target(
        _excluded_window: Option<isize>,
    ) -> Result<(CapturedTarget, GlobalVoiceTarget), String> {
        Err("Global AnboVoice is currently available on Windows only.".to_string())
    }

    pub fn insert_text(
        _target: &CapturedTarget,
        _text: &str,
        _excluded_window: Option<isize>,
    ) -> Result<usize, String> {
        Err("Global AnboVoice is currently available on Windows only.".to_string())
    }
}

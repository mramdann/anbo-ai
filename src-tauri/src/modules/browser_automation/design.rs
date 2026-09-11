//! Design mode: the user marks up a live page inside the Anbo browser and the
//! marks, with the elements under them, are handed to a coding agent.
//!
//! The layer lives in the page, in the automation isolated world, so drawing,
//! scrolling and element picking never cross IPC. Page scripts share the DOM
//! with it but not its closure, so a page cannot forge or read the notes the
//! user types. The only channel back to Anbo is one DevTools binding, and the
//! only thing that leaves the page is the model the user chose to send.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Webview};

use super::accessible_name::ACCESSIBLE_NAME_JS;
use super::output_path;
use super::visibility::VISIBILITY_JS;

const LAYER_JS: &str = include_str!("designLayer.js");
pub const EVENT: &str = "anbo:browser-design";
const BINDING: &str = "__anboDesignPost";
const WORLD: &str = "anbo-browser-automation";
const MAX_SESSIONS: usize = 32;
const MAX_MODEL_BYTES: usize = 256 * 1024;
const MAX_PAGES: usize = 8;
const MAX_SESSION_BYTES: usize = 1024 * 1024;
const MAX_BINDING_BYTES: usize = 320 * 1024;
/// Above this the annotated capture is re-encoded as JPEG; a full-DPR PNG of a
/// large emulated viewport is otherwise several times the cost of reading it.
const MAX_PNG_BYTES: usize = 12 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES: usize = 4 * 1024;
const CDP_TIMEOUT: Duration = Duration::from_secs(2);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(5);

static SESSIONS: Mutex<Option<HashMap<i64, Session>>> = Mutex::new(None);
/// Tabs whose webview already forwards binding calls. The receiver lives as
/// long as the webview, so it is registered once and never torn down by hand.
static RECEIVERS: Mutex<Option<HashSet<i64>>> = Mutex::new(None);

#[derive(Default)]
struct Session {
    active: bool,
    installed: bool,
    tool: String,
    marks: u32,
    dirty: bool,
    limit: Option<String>,
    /// The app's colours for the in-page chrome, already sanitized.
    theme: Option<Value>,
    /// Marks per page, keyed by URL without its fragment, newest last. A dev
    /// server reload lands on the same key and gets its marks back.
    pages: VecDeque<(String, String)>,
}

const THEME_KEYS: [&str; 7] = [
    "surface",
    "text",
    "muted",
    "border",
    "field",
    "accent",
    "accentText",
];

const COLOR_FUNCTIONS: [&str; 12] = [
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "color",
    "color-mix",
    "light-dark",
];

/// A colour travels into the page as a CSS custom property value. This is the
/// alphabet a colour function needs and nothing that could end a declaration
/// or open a block, and only colour functions may be called, so a theme file
/// can neither smuggle CSS into the layer nor make the page fetch a url.
fn safe_css_value(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '#' | '(' | ')' | ',' | '.' | '%' | '/' | ' ' | '-')
        })
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'(' {
            continue;
        }
        let start = bytes[..index]
            .iter()
            .rposition(|c| !(c.is_ascii_lowercase() || *c == b'-'))
            .map_or(0, |position| position + 1);
        if !COLOR_FUNCTIONS.contains(&&lower[start..index]) {
            return false;
        }
    }
    true
}

fn sanitize_theme(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mode = match object.get("mode").and_then(Value::as_str) {
        Some("light") => "light",
        Some("dark") => "dark",
        _ => return None,
    };
    let mut out = serde_json::Map::new();
    out.insert("mode".into(), Value::from(mode));
    for key in THEME_KEYS {
        if let Some(color) = object.get(key).and_then(Value::as_str).map(str::trim) {
            if safe_css_value(color) {
                out.insert(key.into(), Value::from(color));
            }
        }
    }
    Some(Value::Object(out))
}

impl Session {
    fn store(&mut self, url: &str, model: String) {
        if model.len() > MAX_MODEL_BYTES {
            return;
        }
        let key = url_key(url);
        self.pages.retain(|(existing, _)| existing != &key);
        self.pages.push_back((key, model));
        while self.pages.len() > MAX_PAGES
            || self.pages.iter().map(|(_, m)| m.len()).sum::<usize>() > MAX_SESSION_BYTES
        {
            if self.pages.pop_front().is_none() {
                break;
            }
        }
    }

    fn model_for(&self, url: &str) -> Option<&str> {
        let key = url_key(url);
        self.pages
            .iter()
            .find(|(existing, _)| existing == &key)
            .map(|(_, model)| model.as_str())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tab_id: i64,
    pub active: bool,
    pub tool: String,
    pub marks: u32,
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Notification<'a> {
    kind: &'a str,
    #[serde(flatten)]
    status: Status,
}

fn tab_id_of(webview: &Webview) -> Option<i64> {
    webview.label().strip_prefix("browser-embed-")?.parse().ok()
}

/// The page a set of marks belongs to. The fragment changes as the user
/// scrolls a documentation site and must not orphan the marks; everything
/// else, query included, is a different page.
fn url_key(url: &str) -> String {
    let trimmed = url.trim();
    let bounded: String = trimmed.chars().take(2048).collect();
    match url::Url::parse(&bounded) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => bounded.split('#').next().unwrap_or("").to_string(),
    }
}

fn with_session<R>(tab_id: i64, f: impl FnOnce(&mut Session) -> R) -> Option<R> {
    let mut guard = SESSIONS.lock().ok()?;
    let sessions = guard.get_or_insert_with(HashMap::new);
    if sessions.len() >= MAX_SESSIONS && !sessions.contains_key(&tab_id) {
        return None;
    }
    let session = sessions.entry(tab_id).or_insert_with(|| Session {
        tool: "box".into(),
        ..Session::default()
    });
    Some(f(session))
}

fn read_session<R>(tab_id: i64, f: impl FnOnce(&Session) -> R) -> Option<R> {
    let guard = SESSIONS.lock().ok()?;
    guard.as_ref()?.get(&tab_id).map(f)
}

fn status_of(tab_id: i64) -> Status {
    read_session(tab_id, |session| Status {
        tab_id,
        active: session.active,
        tool: session.tool.clone(),
        marks: session.marks,
        dirty: session.dirty,
        limit: session.limit.clone(),
    })
    .unwrap_or(Status {
        tab_id,
        active: false,
        tool: "box".into(),
        marks: 0,
        dirty: false,
        limit: None,
    })
}

fn notify(app: &AppHandle, tab_id: i64, kind: &str) {
    let _ = app.emit_to(
        "main",
        EVENT,
        Notification {
            kind,
            status: status_of(tab_id),
        },
    );
}

pub fn is_active(tab_id: i64) -> bool {
    read_session(tab_id, |session| session.active).unwrap_or(false)
}

/// Agent actions that would land on the design layer instead of the page.
///
/// Wheel scrolling passes through the layer, reads never touch input, and
/// navigation is the user's business too; everything that presses, types or
/// drags is refused while the user is drawing, with a message that says why.
pub fn blocks_input(method: &str) -> bool {
    matches!(
        method,
        "click"
            | "double_click"
            | "focus"
            | "check"
            | "drag"
            | "type_text"
            | "type"
            | "upload_files"
            | "upload"
            | "press_key"
            | "press"
            | "key"
            | "dialog"
            | "download"
            | "select_option"
            | "select"
            | "hover"
    )
}

pub fn refusal() -> String {
    "design_mode: the user is marking up this tab in Anbo's design mode, so page input is paused; read the page, wait for their design feedback message, or ask them to leave design mode".into()
}

fn apply_status(tab_id: i64, status: &Value) {
    with_session(tab_id, |session| {
        if let Some(tool) = status.get("tool").and_then(Value::as_str) {
            session.tool = tool.chars().take(16).collect();
        }
        if let Some(marks) = status.get("marks").and_then(Value::as_u64) {
            session.marks = marks.min(u32::MAX as u64) as u32;
        }
        if let Some(dirty) = status.get("dirty").and_then(Value::as_bool) {
            session.dirty = dirty;
        }
        session.limit = status
            .get("limit")
            .and_then(Value::as_str)
            .map(|limit| limit.chars().take(120).collect());
    });
}

/// What the page sent back through the binding.
///
/// Anything unparseable or oversized is dropped: the page cannot break Anbo by
/// shouting, and the model it wants stored has to fit the same budget the
/// export does. Returns the event kind to forward, if any.
fn receive(tab_id: i64, raw: &str) -> Option<&'static str> {
    if raw.len() > MAX_BINDING_BYTES {
        return None;
    }
    let event: Value = serde_json::from_str(raw).ok()?;
    if event.get("name").and_then(Value::as_str) != Some(BINDING) {
        return None;
    }
    let payload = event.get("payload").and_then(Value::as_str)?;
    if payload.len() > MAX_BINDING_BYTES {
        return None;
    }
    let message: Value = serde_json::from_str(payload).ok()?;
    if !is_active(tab_id) {
        return None;
    }
    match message.get("type").and_then(Value::as_str)? {
        "state" => {
            apply_status(tab_id, &message);
            Some("state")
        }
        "model" => {
            let url = message.get("url").and_then(Value::as_str)?;
            let model = message.get("model")?;
            let marks = model
                .get("marks")
                .and_then(Value::as_array)
                .map(|marks| marks.len().min(u32::MAX as usize) as u32)
                .unwrap_or(0);
            let serialized = model.to_string();
            with_session(tab_id, |session| {
                session.store(url, serialized);
                session.marks = marks;
            });
            Some("state")
        }
        "exit" => Some("exit"),
        _ => None,
    }
}

#[cfg(windows)]
async fn call(webview: &Webview, method: &str, params: &str) -> Result<String, String> {
    super::cdp::call_devtools_protocol_method(webview, method, params, CDP_TIMEOUT).await
}

#[cfg(windows)]
async fn evaluate(webview: &Webview, expression: &str) -> Result<Value, String> {
    let context = super::ref_context::main_context(webview).await?;
    let raw = super::cdp::call_devtools_protocol_method(
        webview,
        "Runtime.evaluate",
        &json!({"expression": expression, "contextId": context, "returnByValue": true,
            "awaitPromise": false, "userGesture": true})
        .to_string(),
        SCRIPT_TIMEOUT,
    )
    .await?;
    let payload: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if let Some(details) = payload.get("exceptionDetails") {
        let description = details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .unwrap_or("unknown error");
        let description: String = description.chars().take(300).collect();
        return Err(format!("design layer script failed: {description}"));
    }
    Ok(payload["result"].get("value").cloned().unwrap_or(Value::Null))
}

#[cfg(windows)]
async fn register_receiver(app: AppHandle, webview: &Webview, tab_id: i64) -> Result<(), String> {
    use webview2_com::{take_pwstr, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{PCWSTR, PWSTR};
    let already = RECEIVERS
        .lock()
        .map(|guard| {
            guard
                .as_ref()
                .is_some_and(|receivers| receivers.contains(&tab_id))
        })
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| error.to_string())?;
                let name: Vec<u16> = "Runtime.bindingCalled"
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let events = unsafe { core.GetDevToolsProtocolEventReceiver(PCWSTR(name.as_ptr())) }
                    .map_err(|error| error.to_string())?;
                let handler =
                    DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut payload = PWSTR::null();
                        if unsafe { args.ParameterObjectAsJson(&mut payload) }.is_err() {
                            return Ok(());
                        }
                        if let Some(kind) = receive(tab_id, &take_pwstr(payload)) {
                            notify(&app, tab_id, kind);
                        }
                        Ok(())
                    }));
                let mut token = 0;
                unsafe { events.add_DevToolsProtocolEventReceived(&handler, &mut token) }
                    .map_err(|error| error.to_string())?;
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(CDP_TIMEOUT, receiver)
        .await
        .map_err(|_| "timed out installing the design binding".to_string())?
        .map_err(|_| "design binding installation was cancelled".to_string())??;
    if let Ok(mut guard) = RECEIVERS.lock() {
        guard.get_or_insert_with(HashSet::new).insert(tab_id);
    }
    Ok(())
}

#[cfg(windows)]
fn install_script(init: &str) -> String {
    format!(
        "(() => {{\n{ACCESSIBLE_NAME_JS}\n{VISIBILITY_JS}\n{LAYER_JS}\nreturn globalThis.__anboDesign.configure({init});\n}})()"
    )
}

#[cfg(windows)]
async fn install(app: &AppHandle, webview: &Webview, tab_id: i64) -> Result<Status, String> {
    register_receiver(app.clone(), webview, tab_id).await?;
    call(webview, "Runtime.enable", "{}").await?;
    call(
        webview,
        "Runtime.addBinding",
        &json!({"name": BINDING, "executionContextName": WORLD}).to_string(),
    )
    .await?;
    let url = super::cdp::read_url(webview, CDP_TIMEOUT)
        .await
        .unwrap_or_default();
    let init = read_session(tab_id, |session| {
        let model = session
            .model_for(&url)
            .and_then(|model| serde_json::from_str::<Value>(model).ok())
            .unwrap_or(Value::Null);
        json!({"tool": session.tool, "model": model, "theme": session.theme.clone().unwrap_or(Value::Null)})
            .to_string()
    })
    .unwrap_or_else(|| json!({"tool": "box", "model": null, "theme": null}).to_string());
    let status = evaluate(webview, &install_script(&init)).await?;
    if status.get("ok") != Some(&Value::Bool(true)) {
        return Err("design layer did not report ready".into());
    }
    with_session(tab_id, |session| session.installed = true);
    apply_status(tab_id, &status);
    Ok(status_of(tab_id))
}

#[cfg(windows)]
async fn pull_model(webview: &Webview, tab_id: i64) {
    let exported = evaluate(
        webview,
        "(() => { const d = globalThis.__anboDesign; return d && d.alive() ? d.export() : null; })()",
    )
    .await;
    if let Ok(model) = exported {
        if let Some(url) = model.get("url").and_then(Value::as_str) {
            let marks = model
                .get("marks")
                .and_then(Value::as_array)
                .map(|marks| marks.len().min(u32::MAX as usize) as u32)
                .unwrap_or(0);
            let url = url.to_string();
            let serialized = model.to_string();
            with_session(tab_id, |session| {
                session.store(&url, serialized);
                session.marks = marks;
            });
        }
    }
}

pub async fn set_active(
    app: &AppHandle,
    tab_id: i64,
    active: bool,
    theme: Option<Value>,
) -> Result<Status, String> {
    #[cfg(windows)]
    {
        let webview = super::registry::get_embed_webview(app, tab_id)?;
        let lock = super::registry::get_tab_lock(tab_id);
        let _guard = lock.lock().await;
        if active {
            let theme = theme.as_ref().and_then(sanitize_theme);
            with_session(tab_id, |session| {
                session.active = true;
                if theme.is_some() {
                    session.theme = theme;
                }
            })
            .ok_or_else(|| "too many tabs in design mode".to_string())?;
            let installed = install(app, &webview, tab_id).await;
            if installed.is_err() {
                with_session(tab_id, |session| {
                    session.active = false;
                    session.installed = false;
                });
            }
            let status = installed?;
            notify(app, tab_id, "state");
            Ok(status)
        } else {
            let was_installed = read_session(tab_id, |session| session.installed).unwrap_or(false);
            if was_installed {
                pull_model(&webview, tab_id).await;
                let _ = evaluate(
                    &webview,
                    "(() => { const d = globalThis.__anboDesign; return d ? d.uninstall() : false; })()",
                )
                .await;
            }
            with_session(tab_id, |session| {
                session.active = false;
                session.installed = false;
                session.dirty = false;
                session.limit = None;
            });
            let _ = call(&webview, "Runtime.disable", "{}").await;
            notify(app, tab_id, "state");
            Ok(status_of(tab_id))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab_id, active, theme);
        Err("design mode is only supported on Windows".into())
    }
}

/// The app changed its colours; the chrome inside the page follows. Stored
/// for the next install either way, applied now only if a layer is up.
pub async fn set_theme(app: &AppHandle, tab_id: i64, theme: &Value) -> Result<(), String> {
    let theme = sanitize_theme(theme).ok_or_else(|| "invalid design theme".to_string())?;
    let live = with_session(tab_id, |session| {
        session.theme = Some(theme.clone());
        session.active && session.installed
    })
    .unwrap_or(false);
    if !live {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let webview = super::registry::get_embed_webview(app, tab_id)?;
        let lock = super::registry::get_tab_lock(tab_id);
        let _guard = lock.lock().await;
        let script = format!(
            "(() => {{ const d = globalThis.__anboDesign; return d ? d.configure({}) : null; }})()",
            json!({ "theme": theme })
        );
        evaluate(&webview, &script).await.map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

pub async fn command(app: &AppHandle, tab_id: i64, command: &str) -> Result<Status, String> {
    #[cfg(windows)]
    {
        let known = matches!(
            command,
            "undo" | "delete" | "clear" | "deselect" | "flush" | "status"
        ) || matches!(
            command,
            "tool:pen" | "tool:box" | "tool:arrow" | "tool:pick" | "tool:hand"
        );
        if !known {
            return Err(format!("unknown design command '{command}'"));
        }
        if !is_active(tab_id) {
            return Err("design mode is not active on this tab".into());
        }
        let webview = super::registry::get_embed_webview(app, tab_id)?;
        let lock = super::registry::get_tab_lock(tab_id);
        let _guard = lock.lock().await;
        if let Some(tool) = command.strip_prefix("tool:") {
            with_session(tab_id, |session| session.tool = tool.to_string());
        }
        let script = format!(
            "(() => {{ const d = globalThis.__anboDesign; return d ? d.command({}) : null; }})()",
            json!(command)
        );
        let status = evaluate(&webview, &script).await?;
        if status.is_null() {
            // The document changed under the user; the page-load hook brings
            // the layer back, and the tool they chose is already remembered.
            with_session(tab_id, |session| session.installed = false);
            return Ok(status_of(tab_id));
        }
        if status.get("ok") != Some(&Value::Bool(true)) {
            let error = status
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("design command failed");
            return Err(error.to_string());
        }
        apply_status(tab_id, &status);
        notify(app, tab_id, "state");
        Ok(status_of(tab_id))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab_id, command);
        Err("design mode is only supported on Windows".into())
    }
}

fn resolve_workspace(tab_id: i64, workspace: &str) -> Result<PathBuf, String> {
    let requested = workspace.trim();
    if requested.is_empty() {
        return Err("design capture requires the tab's workspace root".into());
    }
    if requested.len() > MAX_WORKSPACE_BYTES {
        return Err("workspace path is too long".into());
    }
    let canonical = std::fs::canonicalize(requested)
        .map_err(|error| format!("workspace is not accessible: {error}"))?;
    if !canonical.is_dir() {
        return Err("workspace is not a directory".into());
    }
    let actual = crate::modules::browser::embed::active_local_root(tab_id)
        .ok_or_else(|| format!("tab {tab_id} has no active workspace root"))?;
    if canonical != actual {
        return Err(format!("tab {tab_id} belongs to a different workspace"));
    }
    Ok(actual)
}

fn resolve_output_dir(workspace_root: &Path) -> Result<PathBuf, String> {
    let requested = workspace_root
        .join(".anbo")
        .join("artifacts")
        .join("design");
    std::fs::create_dir_all(&requested)
        .map_err(|error| format!("failed to create the design artifacts directory: {error}"))?;
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve the design artifacts directory: {error}"))?;
    if !canonical.starts_with(workspace_root) {
        return Err("design artifacts directory escapes the workspace".into());
    }
    Ok(canonical)
}

fn slug_for(url: &str) -> String {
    let path = url::Url::parse(url)
        .map(|parsed| {
            let host = parsed.host_str().unwrap_or("").to_string();
            let path = parsed.path().to_string();
            if host.is_empty() || host == "localhost" || host == "127.0.0.1" {
                path
            } else {
                format!("{host}{path}")
            }
        })
        .unwrap_or_default();
    let mut slug = String::new();
    let mut dash = false;
    for ch in path.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "page".into()
    } else {
        slug
    }
}

/// `YYYYMMDD-HHMMSS` in UTC from a unix timestamp, without a date crate.
fn stamp(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

fn unique_base(dir: &Path, base: &str) -> String {
    let taken = |candidate: &str| {
        dir.join(format!("{candidate}.png")).exists()
            || dir.join(format!("{candidate}.jpg")).exists()
            || dir.join(format!("{candidate}.json")).exists()
    };
    if !taken(base) {
        return base.to_string();
    }
    for suffix in 2..=1000 {
        let candidate = format!("{base}-{suffix}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!(
        "{base}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

fn summarize_marks(model: &Value) -> Vec<Value> {
    model
        .get("marks")
        .and_then(Value::as_array)
        .map(|marks| {
            marks
                .iter()
                .map(|mark| {
                    let element = mark.get("element").map(|element| {
                        json!({
                            "tag": element.get("tag"),
                            "name": element.get("name"),
                            "text": element.get("text"),
                            "selector": element.get("selector"),
                            "testId": element.get("testId"),
                            "locator": element.get("locator"),
                        })
                    });
                    json!({
                        "n": mark.get("n"),
                        "kind": mark.get("kind"),
                        "note": mark.get("note"),
                        "inViewport": mark.get("inViewport"),
                        "element": element,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn capture(
    app: &AppHandle,
    tab_id: i64,
    workspace: &str,
    include_image: bool,
) -> Result<Value, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        if !is_active(tab_id) {
            return Err("design mode is not active on this tab".into());
        }
        let root = resolve_workspace(tab_id, workspace)?;
        let dir = resolve_output_dir(&root)?;
        let webview = super::registry::get_embed_webview(app, tab_id)?;
        let lock = super::registry::get_tab_lock(tab_id);
        let _guard = lock.lock().await;
        let model = evaluate(
            &webview,
            "(() => { const d = globalThis.__anboDesign; return d && d.alive() ? d.export() : null; })()",
        )
        .await?;
        if model.is_null() {
            return Err("the design layer is not on this page yet; toggle design mode again".into());
        }
        let serialized = model.to_string();
        if serialized.len() > MAX_MODEL_BYTES {
            return Err("the marks on this page exceed the export budget; remove some".into());
        }
        let mark_count = model
            .get("marks")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if mark_count == 0 {
            return Err("add at least one mark before sending".into());
        }
        let url = model
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        with_session(tab_id, |session| {
            session.store(&url, serialized.clone());
            session.marks = mark_count.min(u32::MAX as usize) as u32;
        });

        let _ = evaluate(
            &webview,
            "(() => { const d = globalThis.__anboDesign; return d ? d.present('capture') : false; })()",
        )
        .await;
        let shot = super::cdp::capture_screenshot(&webview, super::cdp::ScreenshotEncoding::default())
            .await;
        let mut image = shot.and_then(|raw| decode_screenshot(&raw));
        let mut extension = "png";
        if let Ok(bytes) = &image {
            if bytes.len() > MAX_PNG_BYTES {
                let encoding = super::cdp::ScreenshotEncoding::parse(Some("jpeg"), Some(85))?;
                image = super::cdp::capture_screenshot(&webview, encoding)
                    .await
                    .and_then(|raw| decode_screenshot(&raw));
                extension = "jpg";
            }
        }
        let _ = evaluate(
            &webview,
            "(() => { const d = globalThis.__anboDesign; return d ? d.present('normal') : false; })()",
        )
        .await;
        let image = image?;

        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let base = unique_base(&dir, &format!("design-{}-{}", stamp(secs), slug_for(&url)));
        let image_path = dir.join(format!("{base}.{extension}"));
        let json_path = dir.join(format!("{base}.json"));
        std::fs::write(&image_path, &image)
            .map_err(|error| format!("failed to write the annotated capture: {error}"))?;
        let mut document = model.clone();
        if let Some(object) = document.as_object_mut() {
            object.insert("capturedAt".into(), Value::from(secs));
            object.insert(
                "image".into(),
                json!({
                    "path": output_path::display(&image_path),
                    "format": if extension == "jpg" { "jpeg" } else { "png" },
                    "bytes": image.len(),
                    "dpr": model["viewport"]["dpr"].clone(),
                    "note": "Pixel coordinates in the image are each mark's viewport rect multiplied by dpr; the numbered badges match n.",
                }),
            );
            object.insert("workspace".into(), Value::from(output_path::display(&root)));
        }
        let document_text = serde_json::to_string_pretty(&document)
            .map_err(|error| format!("failed to encode the design document: {error}"))?;
        std::fs::write(&json_path, document_text)
            .map_err(|error| format!("failed to write the design document: {error}"))?;
        with_session(tab_id, |session| session.dirty = false);
        notify(app, tab_id, "state");
        let inline = (include_image && image.len() <= MAX_INLINE_IMAGE_BYTES).then(|| {
            format!(
                "data:image/{};base64,{}",
                if extension == "jpg" { "jpeg" } else { "png" },
                base64::engine::general_purpose::STANDARD.encode(&image)
            )
        });
        Ok(json!({
            "tabId": tab_id,
            "url": url,
            "title": model.get("title").cloned().unwrap_or(Value::Null),
            "viewport": model.get("viewport").cloned().unwrap_or(Value::Null),
            "imagePath": output_path::display(&image_path),
            "jsonPath": output_path::display(&json_path),
            "imageBytes": image.len(),
            "marks": summarize_marks(&model),
            "image": inline,
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab_id, workspace, include_image);
        Err("design mode is only supported on Windows".into())
    }
}

#[cfg(windows)]
fn decode_screenshot(response: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if response.len() > 64 * 1024 * 1024 {
        return Err("screenshot response exceeds 64 MiB".into());
    }
    let payload: Value = serde_json::from_str(response)
        .map_err(|error| format!("invalid screenshot response: {error}"))?;
    if let Some(error) = payload.get("error") {
        return Err(format!("screenshot protocol error: {error}"));
    }
    let data = payload
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "screenshot response omitted image data".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("invalid screenshot image data: {error}"))
}

/// The layer goes with the document; the page-load hook brings it back.
pub fn navigation(webview: &Webview) {
    if let Some(tab_id) = tab_id_of(webview) {
        with_session(tab_id, |session| session.installed = false);
    }
}

/// A new document finished loading in a tab that is in design mode: put the
/// layer back, with the marks this URL had if it has been here before.
pub fn restore(webview: &Webview) {
    let Some(tab_id) = tab_id_of(webview) else {
        return;
    };
    let wanted = read_session(tab_id, |session| session.active && !session.installed).unwrap_or(false);
    if !wanted {
        return;
    }
    #[cfg(windows)]
    {
        let app = webview.app_handle().clone();
        let webview = webview.clone();
        tauri::async_runtime::spawn(async move {
            let lock = super::registry::get_tab_lock(tab_id);
            let _guard = lock.lock().await;
            let still_wanted =
                read_session(tab_id, |session| session.active && !session.installed).unwrap_or(false);
            if !still_wanted {
                return;
            }
            if install(&app, &webview, tab_id).await.is_ok() {
                notify(&app, tab_id, "state");
            }
        });
    }
}

/// Keeps the user's marks out of an agent's screenshot for as long as the
/// guard lives. Screenshots exclude Anbo's own surfaces; the marks reach the
/// agent through the capture the user sends, not as pixels it must decode.
pub struct HiddenLayer(Option<Webview>);

impl Drop for HiddenLayer {
    fn drop(&mut self) {
        let Some(webview) = self.0.take() else {
            return;
        };
        #[cfg(windows)]
        {
            tauri::async_runtime::spawn(async move {
                let _ = evaluate(
                    &webview,
                    "(() => { const d = globalThis.__anboDesign; return d ? d.present('normal') : false; })()",
                )
                .await;
            });
        }
        #[cfg(not(windows))]
        {
            let _ = webview;
        }
    }
}

pub async fn hide_for_capture(webview: &Webview) -> HiddenLayer {
    let installed = tab_id_of(webview)
        .and_then(|tab_id| read_session(tab_id, |session| session.active && session.installed))
        .unwrap_or(false);
    if !installed {
        return HiddenLayer(None);
    }
    #[cfg(windows)]
    {
        let hidden = evaluate(
            webview,
            "(() => { const d = globalThis.__anboDesign; return d ? d.present('hidden') : false; })()",
        )
        .await;
        if hidden.is_ok() {
            return HiddenLayer(Some(webview.clone()));
        }
    }
    HiddenLayer(None)
}

pub fn remove(tab_id: i64) {
    if let Ok(mut guard) = SESSIONS.lock() {
        if let Some(sessions) = guard.as_mut() {
            sessions.remove(&tab_id);
        }
    }
    if let Ok(mut guard) = RECEIVERS.lock() {
        if let Some(receivers) = guard.as_mut() {
            receivers.remove(&tab_id);
        }
    }
}

pub fn clear() {
    if let Ok(mut guard) = SESSIONS.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = RECEIVERS.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session registry is process-wide and the test runner is parallel;
    /// the tests that touch it take turns.
    static REGISTRY_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn registry_guard() -> std::sync::MutexGuard<'static, ()> {
        REGISTRY_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn fresh(tab_id: i64) {
        remove(tab_id);
        with_session(tab_id, |session| session.active = true);
    }

    #[test]
    fn url_keys_ignore_fragments_but_not_queries() {
        assert_eq!(
            url_key("http://localhost:3000/settings#profile"),
            "http://localhost:3000/settings"
        );
        assert_ne!(
            url_key("http://localhost:3000/settings?tab=a"),
            url_key("http://localhost:3000/settings?tab=b")
        );
        assert_eq!(url_key("not a url#frag"), "not a url");
    }

    #[test]
    fn input_actions_are_refused_and_reads_are_not() {
        for method in ["click", "type", "press", "key", "drag", "hover", "upload", "dialog"] {
            assert!(blocks_input(method), "{method}");
        }
        for method in [
            "snapshot",
            "find",
            "get_text",
            "scroll",
            "scroll_to_element",
            "navigate",
            "reload",
            "screenshot",
            "wait",
            "emulate",
            "page_info",
        ] {
            assert!(!blocks_input(method), "{method}");
        }
    }

    #[test]
    fn stored_models_are_bounded_per_page_and_per_session() {
        let mut session = Session::default();
        session.store("http://a/1", "x".repeat(MAX_MODEL_BYTES + 1));
        assert!(session.pages.is_empty());
        for index in 0..(MAX_PAGES + 3) {
            session.store(&format!("http://a/{index}"), "m".into());
        }
        assert_eq!(session.pages.len(), MAX_PAGES);
        assert!(session.model_for("http://a/0").is_none());
        assert!(session.model_for("http://a/10#fragment").is_some());
        session.store("http://a/10", "n".into());
        assert_eq!(session.pages.len(), MAX_PAGES);
        assert_eq!(session.model_for("http://a/10"), Some("n"));
        let mut heavy = Session::default();
        for index in 0..8 {
            heavy.store(&format!("http://b/{index}"), "y".repeat(200 * 1024));
        }
        assert!(heavy.pages.iter().map(|(_, m)| m.len()).sum::<usize>() <= MAX_SESSION_BYTES);
        assert!(heavy.model_for("http://b/7").is_some());
    }

    #[test]
    fn binding_messages_update_the_session_and_ignore_noise() {
        let _registry = registry_guard();
        let tab_id = -710_001;
        fresh(tab_id);
        let state = json!({"name": BINDING, "payload": json!({"type": "state", "tool": "pen", "marks": 3, "dirty": true}).to_string()});
        assert_eq!(receive(tab_id, &state.to_string()), Some("state"));
        let status = status_of(tab_id);
        assert_eq!((status.tool.as_str(), status.marks, status.dirty), ("pen", 3, true));
        let model = json!({"name": BINDING, "payload": json!({"type": "model", "url": "http://localhost/x#top", "model": {"marks": [{}, {}]}}).to_string()});
        assert_eq!(receive(tab_id, &model.to_string()), Some("state"));
        assert_eq!(status_of(tab_id).marks, 2);
        assert!(read_session(tab_id, |session| session.model_for("http://localhost/x").is_some()).unwrap());
        assert_eq!(
            receive(tab_id, &json!({"name": BINDING, "payload": "{\"type\":\"exit\"}"}).to_string()),
            Some("exit")
        );
        assert_eq!(receive(tab_id, &json!({"name": "other", "payload": "{}"}).to_string()), None);
        assert_eq!(receive(tab_id, "not json"), None);
        assert_eq!(receive(tab_id, &"x".repeat(MAX_BINDING_BYTES + 1)), None);
        with_session(tab_id, |session| session.active = false);
        assert_eq!(receive(tab_id, &state.to_string()), None);
        remove(tab_id);
    }

    #[test]
    fn sessions_are_capped_and_removed_with_their_tab() {
        let _registry = registry_guard();
        let base = -720_000;
        clear();
        for offset in 0..MAX_SESSIONS as i64 {
            assert!(with_session(base - offset, |_| ()).is_some());
        }
        assert!(with_session(base - MAX_SESSIONS as i64, |_| ()).is_none());
        remove(base);
        assert!(!is_active(base));
        clear();
    }

    #[test]
    fn artifact_names_are_readable_and_collision_free() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_788_716_542), "20260906-174222");
        assert_eq!(stamp(951_782_400), "20000229-000000");
        assert_eq!(slug_for("http://localhost:3000/settings/Profile?x=1"), "settings-profile");
        assert_eq!(slug_for("https://example.com/"), "example-com");
        assert_eq!(slug_for("about:blank"), "blank");
        assert_eq!(slug_for("nope"), "page");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("design-1-x.png"), b"a").unwrap();
        std::fs::write(dir.path().join("design-1-x-2.json"), b"a").unwrap();
        assert_eq!(unique_base(dir.path(), "design-1-x"), "design-1-x-3");
        assert_eq!(unique_base(dir.path(), "design-1-y"), "design-1-y");
    }

    #[test]
    fn output_dir_stays_inside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let out = resolve_output_dir(&root).unwrap();
        assert!(out.starts_with(&root));
        assert!(out.ends_with(Path::new(".anbo").join("artifacts").join("design")));
        assert!(resolve_workspace(-1, "").is_err());
        assert!(resolve_workspace(-1, &"a".repeat(MAX_WORKSPACE_BYTES + 1)).is_err());
        assert!(resolve_workspace(-1, root.to_str().unwrap()).is_err());
    }

    #[test]
    fn themes_keep_colour_text_and_nothing_else() {
        let theme = sanitize_theme(&json!({
            "mode": "light",
            "surface": " oklch(1 0 0) ",
            "border": "oklch(1 0 0 / 10%)",
            "text": "#1b2330",
            "accent": "red; color: blue",
            "field": "url(x)",
            "muted": "x".repeat(65),
            "accentText": "color-mix(in srgb, red 50%, blue)",
            "bogus": "#fff",
        }))
        .unwrap();
        assert_eq!(theme["mode"], "light");
        assert_eq!(theme["surface"], "oklch(1 0 0)");
        assert_eq!(theme["border"], "oklch(1 0 0 / 10%)");
        assert_eq!(theme["text"], "#1b2330");
        assert_eq!(theme["accentText"], "color-mix(in srgb, red 50%, blue)");
        for key in ["accent", "field", "muted", "bogus"] {
            assert!(theme.get(key).is_none(), "{key}");
        }
        assert!(!safe_css_value("image(x)"));
        assert!(!safe_css_value("var(--x)"));
        assert!(!safe_css_value(" (x)"));
        assert!(sanitize_theme(&json!({"mode": "auto"})).is_none());
        assert!(sanitize_theme(&json!("dark")).is_none());
        assert_eq!(sanitize_theme(&json!({"mode": "dark"})).unwrap(), json!({"mode": "dark"}));
    }

    #[test]
    fn summaries_carry_locators_but_not_geometry() {
        let model = json!({"marks": [{"n": 1, "kind": "box", "note": "tighter", "inViewport": true,
            "rect": {"x": 1, "y": 2}, "points": [[1, 2]],
            "element": {"tag": "button", "name": "Save", "text": "Save", "selector": "#save", "testId": "",
                "locator": {"by": "css", "value": "#save"}, "bounds": {"x": 1}}}]});
        let summary = summarize_marks(&model);
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0]["element"]["locator"]["value"], "#save");
        assert!(summary[0].get("rect").is_none());
        assert!(summary[0]["element"].get("bounds").is_none());
    }
}

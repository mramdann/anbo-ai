use super::caller::Caller;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Webview};

#[path = "activity_icon.rs"]
mod icon;

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TABS: Mutex<Option<HashMap<i64, Surface>>> = Mutex::new(None);
const MAX_SURFACES: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub tab_id: i64,
    pub control_id: u64,
    pub request_id: u64,
    pub sequence: u64,
    pub actor: Caller,
    pub method: String,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Default)]
struct Surface {
    visible: bool,
    disabled: bool,
    installed: bool,
    last: Option<(Activity, Instant)>,
    capturing: usize,
    icon_brand: Option<&'static str>,
    in_flight: usize,
    latest_request: u64,
}

impl Surface {
    fn finish_observed(&mut self, target: &TurnEnd, next: u64) -> Option<Activity> {
        let (event, _) = self.last.as_ref()?;
        if self.in_flight != 0
            || self.latest_request != event.request_id
            || event.actor.pty_id != Some(target.pty_id)
            || event.sequence != target.sequence
            || !matches!(event.phase, "done" | "error")
        {
            return None;
        }
        let caller = event.actor.clone();
        self.finish(target.control_id, &caller, next)
    }

    fn retain_point(&self, event: &mut Activity) {
        if event.phase != "frame" && event.point.is_none() {
            event.point = self
                .last
                .as_ref()
                .filter(|(previous, _)| previous.control_id == event.control_id)
                .and_then(|(previous, _)| previous.point.clone());
        }
    }
    fn control_id(&self, actor: &Caller, next: u64) -> u64 {
        self.last
            .as_ref()
            .filter(|(event, _)| event.phase != "ended" && &event.actor == actor)
            .map_or(next, |(event, _)| event.control_id)
    }

    fn finish(&mut self, control_id: u64, caller: &Caller, sequence: u64) -> Option<Activity> {
        let (event, _) = self.last.as_mut()?;
        if event.phase == "ended" || event.control_id != control_id || &event.actor != caller {
            return None;
        }
        event.phase = "ended";
        event.point = None;
        event.sequence = sequence;
        Some(event.clone())
    }

    fn needs_icon(&mut self, brand: &'static str, install: bool) -> bool {
        let changed = install || self.icon_brand != Some(brand);
        self.icon_brand = Some(brand);
        changed
    }
}

#[derive(Serialize)]
struct VisualActivity<'a> {
    #[serde(flatten)]
    activity: &'a Activity,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<icon::Icon>,
}

#[derive(Clone)]
struct Context {
    app: AppHandle,
    event: Activity,
    navigation: u64,
}
tokio::task_local! { static CURRENT: Context; }

pub async fn track<F>(
    app: &AppHandle,
    method: &str,
    tab_id: Option<i64>,
    actor: Caller,
    action: F,
) -> Result<serde_json::Value, (String, String)>
where
    F: Future<Output = Result<serde_json::Value, (String, String)>>,
{
    let Some(tab_id) = tab_id.filter(|id| {
        *id > 0
            && method != "close"
            && !method.starts_with("agent_")
            && !method.starts_with("terminal_")
            && !method.starts_with("skills_")
    }) else {
        return action.await;
    };
    let live = crate::modules::browser::embed::active_navigation_generation(tab_id).is_some()
        && app
            .get_webview(&crate::modules::browser::embed::embed_label(tab_id))
            .is_some();
    let request_id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let control_id = TABS.lock().ok().and_then(|mut guard| {
        let tabs = guard.get_or_insert_with(HashMap::new);
        begin_tracking(tabs, tab_id, live, &actor, request_id)
    });
    let Some(control_id) = control_id else {
        return action.await;
    };
    let event = Activity {
        tab_id,
        control_id,
        request_id,
        sequence: request_id,
        actor,
        method: method.chars().take(48).collect(),
        phase: "queued",
        point: None,
    };
    let context = Context {
        app: app.clone(),
        event,
        navigation: crate::modules::browser::embed::active_navigation_generation(tab_id)
            .unwrap_or(0),
    };
    CURRENT
        .scope(context.clone(), async move {
            let mut guard = Completion {
                context,
                finished: false,
            };
            emit(&guard.context, "queued", None);
            let mut result = action.await;
            complete_request(tab_id);
            emit(
                &guard.context,
                if result.is_ok() { "done" } else { "error" },
                None,
            );
            guard.finished = true;
            match &mut result {
                Ok(value) => if let Some(object) = value.as_object_mut() {
                    object.insert("controlId".into(), control_id.into());
                },
                Err((_, message)) => message.push_str(&format!(" (browser controlId: {control_id}; call browser_end_session when the task ends)")),
            }
            result
        })
        .await
}

fn begin_tracking(
    tabs: &mut HashMap<i64, Surface>,
    tab_id: i64,
    live: bool,
    actor: &Caller,
    request_id: u64,
) -> Option<u64> {
    if !live || (tabs.len() >= MAX_SURFACES && !tabs.contains_key(&tab_id)) {
        return None;
    }
    let surface = tabs.entry(tab_id).or_default();
    surface.in_flight += 1;
    surface.latest_request = surface.latest_request.max(request_id);
    Some(surface.control_id(actor, request_id))
}

struct Completion {
    context: Context,
    finished: bool,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.finished {
            complete_request(self.context.event.tab_id);
            emit(&self.context, "error", None);
        }
    }
}

fn complete_request(tab_id: i64) {
    if let Ok(mut guard) = TABS.lock() {
        if let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&tab_id)) {
            surface.in_flight = surface.in_flight.saturating_sub(1);
        }
    }
}

fn notify_frontend(app: &AppHandle, event: &Activity) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FrontendActivity<'a> {
        #[serde(flatten)]
        activity: &'a Activity,
        #[serde(skip_serializing_if = "Option::is_none")]
        pty_id: Option<u32>,
    }
    // The PTY association is main-webview-only, not part of MCP responses or
    // the page overlay. Display branding remains separate from ownership.
    let _ = app.emit_to(
        "main",
        "browser-automation-activity",
        FrontendActivity {
            activity: event,
            pty_id: event.actor.pty_id,
        },
    );
}

pub fn stage(phase: &'static str) {
    let _ = CURRENT.try_with(|context| emit(context, phase, None));
}

pub fn pointer(phase: &'static str, x: f64, y: f64) {
    if x.is_finite() && y.is_finite() && x.abs() <= 100_000.0 && y.abs() <= 100_000.0 {
        let _ = CURRENT.try_with(|context| {
            emit(
                context,
                phase,
                Some(Point {
                    x,
                    y,
                    width: None,
                    height: None,
                }),
            )
        });
    }
}

pub fn target(x: f64, y: f64, width: f64, height: f64) {
    if [x, y, width, height]
        .iter()
        .all(|n| n.is_finite() && n.abs() < 100_000.0)
        && width > 0.0
        && height > 0.0
    {
        let _ = CURRENT.try_with(|context| {
            emit(
                context,
                "move",
                Some(Point {
                    x,
                    y,
                    width: Some(width),
                    height: Some(height),
                }),
            )
        });
    }
}

fn accepts(previous: &Activity, next: &Activity) -> bool {
    if next.sequence <= previous.sequence
        || next.request_id < previous.request_id
        || (previous.phase == "ended" && previous.control_id == next.control_id)
    {
        return false;
    }
    if matches!(next.phase, "done" | "error") && previous.request_id != next.request_id {
        return false;
    }
    if next.phase == "queued" && !matches!(previous.phase, "done" | "error" | "queued" | "ended") {
        return false;
    }
    if previous.request_id == next.request_id && previous.phase == "move" && next.phase == "move" {
        if let (Some(a), Some(b)) = (&previous.point, &next.point) {
            if a.x == b.x && a.y == b.y && b.width.is_none() && b.height.is_none() {
                return false;
            }
        }
    }
    !(previous.request_id == next.request_id
        && previous.phase == next.phase
        && next.point.is_none())
}

fn emit(context: &Context, phase: &'static str, point: Option<Point>) {
    let mut event = context.event.clone();
    event.phase = phase;
    event.point = if crate::modules::browser::embed::active_navigation_generation(event.tab_id)
        == Some(context.navigation)
    {
        point
    } else {
        None
    };
    event.sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let Some(webview) = context
        .app
        .get_webview(&crate::modules::browser::embed::embed_label(event.tab_id))
    else {
        return;
    };
    let (accepted, notify) = if let Ok(mut guard) = TABS.lock() {
        let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&event.tab_id)) else {
            return;
        };
        if surface
            .last
            .as_ref()
            .is_some_and(|(previous, _)| !accepts(previous, &event))
        {
            (false, false)
        } else {
            surface.retain_point(&mut event);
            let notify = surface.last.as_ref().is_none_or(|(previous, _)| {
                previous.request_id != event.request_id || previous.phase != event.phase
            });
            surface.last = Some((event.clone(), Instant::now()));
            (true, notify)
        }
    } else {
        (false, false)
    };
    if accepted {
        if notify {
            notify_frontend(&context.app, &event);
        }
        render(&webview, event.tab_id, &event);
    }
}

fn render(webview: &Webview, tab_id: i64, event: &Activity) {
    if event.phase == "ended" {
        hide(webview);
        return;
    }
    if event.phase == "queued" {
        return;
    }
    if event.phase == "running"
        && matches!(
            event.method.as_str(),
            "click" | "double_click" | "hover" | "type" | "drag" | "check" | "focus"
        )
    {
        return;
    }
    let (install, include_icon) = {
        let Ok(mut guard) = TABS.lock() else {
            return;
        };
        let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&tab_id)) else {
            return;
        };
        if !surface.visible
            || surface.disabled
            || surface.capturing > 0
            || surface
                .last
                .as_ref()
                .is_some_and(|(last, _)| last.sequence != event.sequence)
        {
            return;
        }
        let install = !surface.installed;
        surface.installed = true;
        (install, surface.needs_icon(event.actor.brand, install))
    };
    let visual = VisualActivity {
        activity: event,
        icon: include_icon
            .then(|| icon::for_brand(event.actor.brand))
            .flatten(),
    };
    if let Ok(json) = serde_json::to_string(&visual) {
        let prefix = if install {
            include_str!("activityOverlay.js")
        } else {
            ""
        };
        let script = format!("{prefix}\nwindow.dispatchEvent(new CustomEvent('anbo-automation-visual',{{detail:{json}}}));");
        let _ = webview.eval(script);
    }
}

fn tab_id(webview: &Webview) -> Option<i64> {
    webview.label().strip_prefix("browser-embed-")?.parse().ok()
}

pub fn presentation(webview: &Webview, visible: bool) {
    let Some(id) = tab_id(webview) else {
        return;
    };
    let (changed, last, installed) = {
        let Ok(mut guard) = TABS.lock() else {
            return;
        };
        let tabs = guard.get_or_insert_with(HashMap::new);
        if tabs.len() >= MAX_SURFACES && !tabs.contains_key(&id) {
            return;
        }
        let surface = tabs.entry(id).or_default();
        let changed = surface.visible != visible;
        surface.visible = visible;
        (changed, surface.last.clone(), surface.installed)
    };
    if !changed {
        return;
    }
    if !visible && installed {
        hide(webview);
    }
    if visible {
        if let Some((event, _)) = last.filter(|(event, _)| event.phase != "ended") {
            render(webview, id, &event);
        }
    }
}

pub fn set_enabled(app: &AppHandle, tab_id: i64, enabled: bool) {
    let changed = if let Ok(mut guard) = TABS.lock() {
        let tabs = guard.get_or_insert_with(HashMap::new);
        if tabs.len() < MAX_SURFACES || tabs.contains_key(&tab_id) {
            let surface = tabs.entry(tab_id).or_default();
            let changed = surface.disabled == enabled;
            surface.disabled = !enabled;
            changed
        } else {
            false
        }
    } else {
        false
    };
    if changed {
        if let Some(webview) = app.get_webview(&crate::modules::browser::embed::embed_label(tab_id))
        {
            if enabled {
                restore(&webview);
            } else {
                hide(&webview);
            }
        }
    }
}

pub fn navigation(webview: &Webview) {
    let Some(id) = tab_id(webview) else {
        return;
    };
    if let Ok(mut guard) = TABS.lock() {
        if let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&id)) {
            surface.installed = false;
            if let Some((event, _)) = surface.last.as_mut() {
                event.point = None;
            }
        }
    }
}

fn hide(webview: &Webview) {
    let _ = webview.eval("window.dispatchEvent(new CustomEvent('anbo-automation-visual-hide'));");
}

pub fn restore(webview: &Webview) {
    let Some(id) = tab_id(webview) else {
        return;
    };
    let last = TABS
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref()?.get(&id)?.last.clone());
    if let Some((event, _)) = last.filter(|(event, _)| event.phase != "ended") {
        render(webview, id, &event);
    }
}

pub fn end_session(app: &AppHandle, tab_id: i64, control_id: u64, caller: &Caller) -> bool {
    let event = TABS.lock().ok().and_then(|mut guard| {
        guard.as_mut()?.get_mut(&tab_id)?.finish(
            control_id,
            caller,
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        )
    });
    let Some(event) = event else {
        return false;
    };
    publish_end(app, &event);
    true
}

fn publish_end(app: &AppHandle, event: &Activity) {
    notify_frontend(app, event);
    if let Some(webview) =
        app.get_webview(&crate::modules::browser::embed::embed_label(event.tab_id))
    {
        // Send an ordered end event, so a delayed completion cannot recreate the surface.
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('anbo-automation-visual',{{detail:{json}}}));"));
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    pty_id: u32,
    tab_id: i64,
    control_id: u64,
    sequence: u64,
}

/// Compare-and-end: a newer request, another PTY, or any in-flight work wins
/// over delayed renderer completion. No browser or process is closed here.
pub fn end_observed(app: &AppHandle, target: &TurnEnd) -> bool {
    let event = TABS.lock().ok().and_then(|mut guard| {
        guard
            .as_mut()?
            .get_mut(&target.tab_id)?
            .finish_observed(target, SEQUENCE.fetch_add(1, Ordering::Relaxed))
    });
    if let Some(event) = event {
        publish_end(app, &event);
        true
    } else {
        false
    }
}

pub fn end_pty(app: &AppHandle, pty_id: u32) {
    let events = TABS
        .lock()
        .ok()
        .map(|mut guard| {
            guard
                .iter_mut()
                .flat_map(|tabs| tabs.values_mut())
                .filter_map(|surface| {
                    let (event, _) = surface.last.as_ref()?;
                    if event.actor.pty_id != Some(pty_id) {
                        return None;
                    }
                    let (id, caller) = (event.control_id, event.actor.clone());
                    surface.finish(id, &caller, SEQUENCE.fetch_add(1, Ordering::Relaxed))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for event in events {
        publish_end(app, &event);
    }
}

pub fn end_owner(app: &AppHandle, caller: &Caller) {
    let owned = TABS
        .lock()
        .ok()
        .map(|guard| {
            guard
                .iter()
                .flat_map(|tabs| tabs.values())
                .filter_map(|surface| {
                    surface
                        .last
                        .as_ref()
                        .filter(|(event, _)| &event.actor == caller && event.phase != "ended")
                        .map(|(event, _)| (event.tab_id, event.control_id))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (tab_id, control_id) in owned {
        end_session(app, tab_id, control_id, caller);
    }
}

pub struct CaptureGuard(Option<Webview>);
impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = TABS.lock() {
            if let Some(surface) = self
                .0
                .as_ref()
                .and_then(tab_id)
                .and_then(|id| guard.as_mut()?.get_mut(&id))
            {
                surface.capturing = surface.capturing.saturating_sub(1);
            }
        }
        if let Some(webview) = &self.0 {
            restore(webview);
        }
    }
}

pub async fn prepare_capture(webview: &Webview) -> Result<CaptureGuard, String> {
    let Some(id) = tab_id(webview) else {
        return Ok(CaptureGuard(None));
    };
    let installed = {
        let mut guard = TABS.lock().map_err(|_| "visual state unavailable")?;
        let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&id)) else {
            return Ok(CaptureGuard(None));
        };
        surface.capturing += 1;
        surface.installed && surface.visible && !surface.disabled
    };
    let capture = CaptureGuard(Some(webview.clone()));
    if installed {
        super::cdp::execute_script_with_timeout(
            webview,
            "window.dispatchEvent(new CustomEvent('anbo-automation-visual-hide'));",
            Duration::from_secs(1),
        )
        .await?;
    }
    Ok(capture)
}

pub fn remove(tab_id: i64) {
    if let Ok(mut guard) = TABS.lock() {
        if let Some(tabs) = guard.as_mut() {
            tabs.remove(&tab_id);
        }
    }
}

pub fn clear() {
    if let Ok(mut guard) = TABS.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_tabs_cannot_fill_the_visual_registry() {
        let mut tabs = HashMap::new();
        for id in 1..=1024 {
            assert!(begin_tracking(&mut tabs, id, false, &Caller::default(), 1).is_none());
        }
        assert!(tabs.is_empty());
        assert_eq!(
            begin_tracking(&mut tabs, 2000, true, &Caller::default(), 2),
            Some(2)
        );
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[&2000].in_flight, 1);
        assert!(begin_tracking(&mut tabs, 2000, false, &Caller::default(), 3).is_none());
        assert_eq!(tabs[&2000].in_flight, 1);
    }

    #[test]
    fn observed_finish_rejects_foreign_pty_stale_sequence_and_in_flight_work() {
        let mut last = event(1, "done", 2);
        last.actor =
            Caller::from_client_info(&serde_json::json!({"name":"codex"})).with_pty(Some(11));
        let mut surface = Surface {
            last: Some((last, Instant::now())),
            latest_request: 1,
            ..Surface::default()
        };
        let mut target = TurnEnd {
            tab_id: 1,
            pty_id: 12,
            control_id: 1,
            sequence: 2,
        };
        assert!(surface.finish_observed(&target, 3).is_none());
        target.pty_id = 11;
        target.sequence = 1;
        assert!(surface.finish_observed(&target, 4).is_none());
        target.sequence = 2;
        surface.in_flight = 1;
        assert!(surface.finish_observed(&target, 5).is_none());
        surface.in_flight = 0;
        surface.latest_request = 6; // newer queued request not painted yet
        assert!(surface.finish_observed(&target, 7).is_none());
        surface.latest_request = 1;
        assert!(surface.finish_observed(&target, 8).is_some());
        assert!(surface.finish_observed(&target, 9).is_none());
    }

    #[test]
    fn observed_finish_never_guesses_ownership_from_brand_or_ends_running_input() {
        let target = TurnEnd {
            tab_id: 1,
            pty_id: 1,
            control_id: 1,
            sequence: 2,
        };
        for phase in ["queued", "running", "move", "click", "frame", "done"] {
            let mut last = event(1, phase, 2);
            last.actor = Caller::from_client_info(&serde_json::json!({"name":"codex"}));
            if phase != "done" {
                last.actor = last.actor.with_pty(Some(1));
            }
            let mut surface = Surface {
                last: Some((last, Instant::now())),
                latest_request: 1,
                ..Surface::default()
            };
            assert!(surface.finish_observed(&target, 3).is_none(), "{phase}");
        }
    }
    #[test]
    fn session_survives_tool_completion_and_long_thinking_gaps() {
        let mut last = event(1, "done", 2);
        last.point = Some(Point {
            x: 10.0,
            y: 20.0,
            width: None,
            height: None,
        });
        let mut surface = Surface {
            last: Some((last, Instant::now() - Duration::from_secs(600))),
            ..Surface::default()
        };
        assert_eq!(surface.control_id(&Caller::default(), 3), 1);
        let mut read = event(3, "running", 4);
        read.control_id = 1;
        surface.retain_point(&mut read);
        assert_eq!(read.point.as_ref().unwrap().x, 10.0);
        read.phase = "frame";
        read.point = None;
        surface.retain_point(&mut read);
        assert!(read.point.is_none());
        let ended = surface.finish(1, &Caller::default(), 5).unwrap();
        assert!(!accepts(&ended, &read));
        read.sequence = 6;
        assert!(!accepts(&ended, &read));
        assert!(surface.finish(1, &Caller::default(), 7).is_none());
        assert_eq!(surface.control_id(&Caller::default(), 8), 8);
    }

    #[test]
    fn same_brand_connections_and_stale_end_are_isolated() {
        let first =
            Caller::from_pipe_info(&serde_json::json!({"name":"codex", "instance":"a".repeat(64)}));
        let second =
            Caller::from_pipe_info(&serde_json::json!({"name":"codex", "instance":"b".repeat(64)}));
        let mut last = event(1, "done", 2);
        last.actor = first.clone();
        let mut surface = Surface {
            last: Some((last, Instant::now())),
            ..Surface::default()
        };
        assert_eq!(surface.control_id(&first, 3), 1);
        assert_eq!(surface.control_id(&second, 3), 3);
        assert!(surface.finish(1, &second, 4).is_none());
        assert!(surface.finish(3, &first, 5).is_none());
        assert!(surface.finish(1, &first, 6).is_some());
    }
    fn event(id: u64, phase: &'static str, sequence: u64) -> Activity {
        Activity {
            tab_id: 1,
            control_id: id,
            request_id: id,
            sequence,
            actor: Caller::default(),
            method: "click".into(),
            phase,
            point: None,
        }
    }
    #[test]
    fn queued_and_late_completion_do_not_steal_another_request() {
        assert!(!accepts(&event(1, "running", 1), &event(2, "queued", 2)));
        assert!(accepts(&event(1, "running", 1), &event(2, "running", 2)));
        assert!(!accepts(&event(2, "running", 2), &event(1, "done", 3)));
        assert!(accepts(&event(2, "running", 2), &event(2, "done", 3)));
        assert!(!accepts(&event(2, "running", 2), &event(2, "running", 3)));
        assert!(!accepts(&event(2, "running", 2), &event(1, "running", 1)));
    }
    #[test]
    fn visual_payload_has_no_tool_arguments() {
        let value = serde_json::to_value(event(1, "running", 1)).unwrap();
        assert!(value.get("params").is_none());
        assert!(value.get("text").is_none());
        assert!(value.get("url").is_none());
        assert!(value.get("icon").is_none());
        assert_eq!(value["actor"]["label"], "Remote agent");
    }

    #[test]
    fn icons_are_sent_only_on_install_or_actor_change() {
        let mut surface = Surface::default();
        assert!(surface.needs_icon("codex", true));
        assert!(!surface.needs_icon("codex", false));
        assert!(surface.needs_icon("claude", false));
        assert!(!surface.needs_icon("claude", false));
        assert!(surface.needs_icon("remote", false));
        assert!(surface.needs_icon("codex", false));
        assert!(surface.needs_icon("codex", true));
    }

    #[test]
    fn native_move_does_not_repeat_an_already_painted_target() {
        let mut previous = event(1, "move", 1);
        previous.point = Some(Point {
            x: 10.0,
            y: 20.0,
            width: Some(30.0),
            height: Some(40.0),
        });
        let mut next = event(1, "move", 2);
        next.point = Some(Point {
            x: 10.0,
            y: 20.0,
            width: None,
            height: None,
        });
        assert!(!accepts(&previous, &next));
        next.point.as_mut().unwrap().x = 11.0;
        assert!(accepts(&previous, &next));
    }
}

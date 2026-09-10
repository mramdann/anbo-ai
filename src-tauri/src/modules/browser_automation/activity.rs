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
/// Open control sessions, keyed by the id handed back to the caller.
///
/// A session is a contract with one caller, not with one tab. The caller opens
/// it once, touches as many tabs as the task needs, and closes it once. Deriving
/// the id from the tab instead meant an agent working three tabs held three
/// unrelated sessions, had to remember three ids, and could not be asked the one
/// question worth asking -- which tab is it in right now.
static CONTROL: Mutex<Option<HashMap<u64, (Caller, Instant)>>> = Mutex::new(None);
const MAX_CONTROLS: usize = 64;
/// How long a session may sit untouched before it is reclaimed.
///
/// Sessions are meant to be closed by the caller, and end_owner closes them when
/// a connection drops -- but a client that simply goes away announces nothing,
/// so without this the registry fills with sessions nobody will ever end and the
/// next real agent is refused. Measured the hard way: a polling loop that
/// reconnected each time exhausted all 64 slots in a couple of minutes.
const CONTROL_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_SURFACES: usize = 256;
/// A session younger than this is never closed by turn observation.
///
/// Turn ends are inferred from the shape of the agent's terminal, and that can
/// lag reality badly at the start of a turn. Measured on Claude Code: the
/// classifier reported "finished" for the first sixteen seconds of a turn that
/// was already opening tabs and claiming them, so the session was created and
/// torn down four seconds later -- before the classifier caught up -- and the
/// agent spent the rest of the task holding an id for a session that no longer
/// existed. Terminal shape is a heuristic and will keep drifting per CLI; the
/// age of the session is not. A genuine end still lands, because the classifier
/// signals again when it leaves the working state.
///
/// It is measured on the session, not on the tab named in the signal. A session
/// spans tabs, and an agent working its third tab leaves the first one's last
/// event minutes old -- so a stale tab was letting a spurious signal through and
/// tearing down the whole session under an agent that was plainly still working.
/// Idleness of the session is the only thing that means the turn is over.
const OBSERVED_MIN_AGE: Duration = Duration::from_secs(45);

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
        if control_idle(event.control_id).is_none_or(|idle| idle < OBSERVED_MIN_AGE) {
            return None;
        }
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

/// The id this caller is already working under, or a fresh one.
fn control_for(caller: &Caller, next: u64) -> Option<u64> {
    let mut guard = CONTROL.lock().ok()?;
    let controls = guard.get_or_insert_with(HashMap::new);
    controls.retain(|_, (_, touched)| touched.elapsed() < CONTROL_TTL);
    if let Some((id, held)) = controls
        .iter_mut()
        .find(|(_, (owner, _))| owner == caller)
        .map(|(id, held)| (*id, held))
    {
        held.1 = Instant::now();
        return Some(id);
    }
    if controls.len() >= MAX_CONTROLS {
        return None;
    }
    controls.insert(next, (caller.clone(), Instant::now()));
    Some(next)
}

/// Whether this caller already holds a session.
///
/// Read-only on purpose: the session gate has to be able to ask without
/// creating the very thing it is checking for.
pub fn holds_control(caller: &Caller) -> bool {
    let Ok(mut guard) = CONTROL.lock() else {
        return false;
    };
    let Some(controls) = guard.as_mut() else {
        return false;
    };
    controls.retain(|_, (_, touched)| touched.elapsed() < CONTROL_TTL);
    controls.values().any(|(owner, _)| owner == caller)
}

/// How long since anything happened under this session.
fn control_idle(control_id: u64) -> Option<Duration> {
    CONTROL
        .lock()
        .ok()?
        .as_ref()?
        .get(&control_id)
        .map(|(_, touched)| touched.elapsed())
}

/// Give up a session, but only to the caller that holds it.
fn release_control(control_id: u64, caller: &Caller) -> bool {
    let Ok(mut guard) = CONTROL.lock() else {
        return false;
    };
    let Some(controls) = guard.as_mut() else {
        return false;
    };
    if controls
        .get(&control_id)
        .is_some_and(|(owner, _)| owner == caller)
    {
        controls.remove(&control_id);
        return true;
    }
    false
}

/// Every open session whose caller satisfies `owned`.
fn controls_where(owned: impl Fn(&Caller) -> bool) -> Vec<(u64, Caller)> {
    CONTROL
        .lock()
        .ok()
        .and_then(|guard| {
            Some(
                guard
                    .as_ref()?
                    .iter()
                    .filter(|(_, (caller, _))| owned(caller))
                    .map(|(id, (caller, _))| (*id, caller.clone()))
                    .collect(),
            )
        })
        .unwrap_or_default()
}

/// The tab this session is in right now: the one it touched most recently.
///
/// Derived rather than stored, so it can never disagree with what was painted.
fn session_current(control_id: u64) -> Option<i64> {
    TABS.lock()
        .ok()?
        .as_ref()?
        .iter()
        .filter_map(|(id, surface)| {
            surface
                .last
                .as_ref()
                .filter(|(event, _)| event.control_id == control_id && event.phase != "ended")
                .map(|(event, _)| (*id, event.sequence))
        })
        .max_by_key(|(_, sequence)| *sequence)
        .map(|(id, _)| id)
}

/// Take the cursor and card off every other tab this session holds.
///
/// A session spans tabs, but the agent is only ever in one of them at a time.
/// The tab strip already shows a single badge that moves; the in-page cursor has
/// to move with it. Left alone every tab kept the cursor and card it was last
/// painted with, so an agent three tabs into a task had left three cursors
/// scattered behind it, none of which was where the work was happening.
fn blur_others(app: &AppHandle, control_id: u64, focused: i64) {
    let others: Vec<i64> = TABS
        .lock()
        .ok()
        .and_then(|guard| {
            Some(
                guard
                    .as_ref()?
                    .iter()
                    .filter(|(id, surface)| {
                        **id != focused
                            && surface.last.as_ref().is_some_and(|(event, _)| {
                                event.control_id == control_id && event.phase != "ended"
                            })
                    })
                    .map(|(id, _)| *id)
                    .collect(),
            )
        })
        .unwrap_or_default();
    for tab in others {
        if let Some(webview) = app.get_webview(&crate::modules::browser::embed::embed_label(tab)) {
            hide(&webview);
        }
    }
}

/// Close every tab painted under this session and announce each one.
fn finish_all(app: &AppHandle, control_id: u64, caller: &Caller) -> bool {
    let events = TABS
        .lock()
        .ok()
        .map(|mut guard| {
            guard
                .iter_mut()
                .flat_map(|tabs| tabs.values_mut())
                .filter_map(|surface| {
                    surface.finish(control_id, caller, SEQUENCE.fetch_add(1, Ordering::Relaxed))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ended = !events.is_empty();
    for event in events {
        publish_end(app, &event);
    }
    ended
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
    control_for(actor, request_id)
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
        if event.phase != "ended" {
            blur_others(&context.app, event.control_id, event.tab_id);
        }
    }
}

fn render(webview: &Webview, tab_id: i64, event: &Activity) {
    if event.phase == "ended" {
        hide(webview);
        return;
    }
    // Only the tab the session is in carries the cursor and card. This also
    // covers restore(): coming back to a tab the agent has since left must not
    // bring its old cursor back with it.
    if session_current(event.control_id).is_some_and(|current| current != tab_id) {
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

/// Claim a tab for a caller without running an action.
///
/// `browser_end_session` had no counterpart. A session could only ever begin as
/// a side effect of the first tracked action, which is an odd shape to hand an
/// agent -- it is given a handle it never asked for -- and it left `browser_open`
/// out entirely, because that call cannot be tracked: the tab has no id while it
/// runs. Starting one explicitly closes both gaps. The implicit start stays, so
/// an agent that forgets to call this still gets its presence.
pub fn begin_session(app: &AppHandle, tab_id: Option<i64>, caller: &Caller) -> Option<u64> {
    let request_id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    // A session with no tab yet is still a session: an agent can claim one
    // before it opens anything, which is the only way browser_open can show the
    // tab's controller from the first frame it is drawn.
    let Some(tab_id) = tab_id else {
        return control_for(caller, request_id);
    };
    let live = crate::modules::browser::embed::active_navigation_generation(tab_id).is_some()
        && app
            .get_webview(&crate::modules::browser::embed::embed_label(tab_id))
            .is_some();
    let control_id = TABS.lock().ok().and_then(|mut guard| {
        let tabs = guard.get_or_insert_with(HashMap::new);
        begin_tracking(tabs, tab_id, live, caller, request_id)
    })?;
    // begin_tracking counts a request as in flight; claiming the tab runs none.
    complete_request(tab_id);
    let context = Context {
        app: app.clone(),
        event: Activity {
            tab_id,
            control_id,
            request_id,
            sequence: request_id,
            actor: caller.clone(),
            method: "start_session".into(),
            phase: "queued",
            point: None,
        },
        navigation: crate::modules::browser::embed::active_navigation_generation(tab_id)
            .unwrap_or(0),
    };
    // Two events, exactly as a tracked action does. A lone "done" is rejected by
    // accepts(): a completion whose request_id differs from the last event's is
    // read as a late reply to an older request, so the claim was minted, handed
    // back, and never recorded -- leaving the agent holding an id for a session
    // that did not exist, which browser_end_session then refused. Opening the
    // request first gives the completion something of its own to close.
    emit(&context, "queued", None);
    // "done" is what every consumer downstream reads as held-but-idle: the tab
    // pulses at the quieter level and the overlay parks its cursor rather than
    // animating work that is not happening.
    emit(&context, "done", None);
    Some(control_id)
}

/// Close a control session and every tab it was painted on.
///
/// Answering true means "your session is closed", not "a tab happened to have a
/// cursor on it". The old per-tab shape returned false whenever a session was
/// real but nothing had been painted yet, which read to agents as a failure and
/// sent them retrying an id that was never going to work.
pub fn end_session(app: &AppHandle, control_id: u64, caller: &Caller) -> bool {
    let held = release_control(control_id, caller);
    let painted = finish_all(app, control_id, caller);
    held || painted
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
    let Some(event) = event else {
        return false;
    };
    let (control_id, caller) = (event.control_id, event.actor.clone());
    publish_end(app, &event);
    // The turn ended, so the whole session goes with it -- not only the tab that
    // happened to be painted last. A session spans every tab the agent touched.
    release_control(control_id, &caller);
    finish_all(app, control_id, &caller);
    true
}

pub fn end_pty(app: &AppHandle, pty_id: u32) {
    for (control_id, caller) in controls_where(|caller| caller.pty_id == Some(pty_id)) {
        end_session(app, control_id, &caller);
    }
}

pub fn end_owner(app: &AppHandle, caller: &Caller) {
    for (control_id, owner) in controls_where(|owner| owner == caller) {
        end_session(app, control_id, &owner);
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
fn seed_control(control_id: u64, caller: &Caller, idle: Duration) {
    if let Ok(mut guard) = CONTROL.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(control_id, (caller.clone(), Instant::now() - idle));
    }
}

#[cfg(test)]
fn reset_controls() {
    if let Ok(mut guard) = CONTROL.lock() {
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
    fn a_turn_end_never_closes_a_session_that_just_started() {
        // Measured on Claude Code: the screen classifier called the turn
        // "finished" for the first sixteen seconds of a turn that was already
        // opening tabs, so a session born at t+8s was torn down at t+12s and
        // every later call had to mint a fresh id against a session that no
        // longer existed. The agent's own browser_end_session then answered
        // ended:false for the rest of the task.
        let mut last = event(1, "done", 2);
        last.actor =
            Caller::from_client_info(&serde_json::json!({"name":"claude"})).with_pty(Some(7));
        let target = TurnEnd {
            tab_id: 1,
            pty_id: 7,
            control_id: 1,
            sequence: 2,
        };
        let _serial = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_controls();
        seed_control(1, &last.actor, Duration::from_secs(1));
        let mut fresh = Surface {
            last: Some((last.clone(), Instant::now())),
            latest_request: 1,
            ..Surface::default()
        };
        assert!(
            fresh.finish_observed(&target, 3).is_none(),
            "a session this busy is the classifier lagging, not a finished turn"
        );

        // The same signal on a settled session still ends it, so a real turn end
        // is not swallowed -- the classifier signals again on leaving working.
        seed_control(1, &last.actor, OBSERVED_MIN_AGE + Duration::from_secs(1));
        let mut settled = Surface {
            // The tab's own last event is recent; what decides is that nothing
            // has happened anywhere under the session.
            last: Some((last, Instant::now())),
            latest_request: 1,
            ..Surface::default()
        };
        assert!(settled.finish_observed(&target, 4).is_some());
        reset_controls();
    }

    #[test]
    fn observed_finish_rejects_foreign_pty_stale_sequence_and_in_flight_work() {
        let mut last = event(1, "done", 2);
        last.actor =
            Caller::from_client_info(&serde_json::json!({"name":"codex"})).with_pty(Some(11));
        let _serial = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_controls();
        // Idle past OBSERVED_MIN_AGE: this test is about the other guards.
        seed_control(1, &last.actor, OBSERVED_MIN_AGE + Duration::from_secs(30));
        let mut surface = Surface {
            last: Some((last, Instant::now() - Duration::from_secs(60))),
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
        reset_controls();
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
        assert!(surface.finish(1, &second, 4).is_none());
        assert!(surface.finish(3, &first, 5).is_none());
        assert!(surface.finish(1, &first, 6).is_some());
    }
    #[test]
    fn a_claimed_session_is_recorded_and_not_only_minted() {
        // begin_session emits a queued event before its done. accepts() reads a
        // lone completion whose request_id differs from the last event's as a
        // late reply to an older request and drops it, so without the queued
        // event the claim was minted, handed back to the caller, and never
        // stored -- leaving an id for a session that did not exist, which
        // browser_end_session then refused with ended:false.
        let mut surface = Surface {
            last: Some((event(1, "ended", 5), Instant::now())),
            ..Surface::default()
        };
        let claim = 11u64;
        let _ = &surface;

        // The shape of the bug: a completion on its own never lands.
        assert!(
            !accepts(&event(1, "ended", 5), &event(claim, "done", 12)),
            "a lone completion is read as a late reply to an older request"
        );

        let queued = event(claim, "queued", 12);
        assert!(
            accepts(&surface.last.as_ref().unwrap().0, &queued),
            "a claim must be able to open its own request"
        );
        surface.last = Some((queued.clone(), Instant::now()));

        let done = event(claim, "done", 13);
        assert!(
            accepts(&queued, &done),
            "the completion must be allowed to close the request it opened"
        );
        surface.last = Some((done, Instant::now()));

        assert!(
            surface.finish(claim, &Caller::default(), 14).is_some(),
            "a claimed session has to be closable"
        );
    }

    static CONTROL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_session_keeps_its_cursor_on_one_tab_at_a_time() {
        // A session spans tabs, but the agent is only ever in one of them. Left
        // alone, every tab kept the cursor and card it was last painted with, so
        // an agent three tabs into a task had left three cursors behind it and
        // none of them was where the work was happening.
        let _serial = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(mut guard) = TABS.lock() {
            let tabs = guard.get_or_insert_with(HashMap::new);
            tabs.clear();
            for (tab, sequence) in [(701_i64, 10_u64), (702, 20), (703, 15)] {
                let mut event = event(9, "done", sequence);
                event.tab_id = tab;
                tabs.insert(
                    tab,
                    Surface {
                        last: Some((event, Instant::now())),
                        ..Surface::default()
                    },
                );
            }
        }
        assert_eq!(
            session_current(9),
            Some(702),
            "the tab it touched last is the tab it is in"
        );

        // A tab whose own session has ended is not a candidate, even if its
        // sequence is the highest.
        if let Ok(mut guard) = TABS.lock() {
            if let Some(surface) = guard.as_mut().and_then(|tabs| tabs.get_mut(&702)) {
                if let Some((event, _)) = surface.last.as_mut() {
                    event.phase = "ended";
                }
            }
        }
        assert_eq!(session_current(9), Some(703));
        // Another session's tabs are none of its business.
        assert_eq!(session_current(8), None);
        if let Ok(mut guard) = TABS.lock() {
            if let Some(tabs) = guard.as_mut() {
                tabs.clear();
            }
        }
    }

    #[test]
    fn abandoned_sessions_are_reclaimed_before_a_new_caller_is_refused() {
        let _serial = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_controls();
        // A client that simply goes away announces nothing, so the registry has
        // to reclaim its own. Without this a polling loop that reconnected each
        // time filled every slot in a couple of minutes and the next real agent
        // was told there were too many sessions.
        if let Ok(mut guard) = CONTROL.lock() {
            let controls = guard.get_or_insert_with(HashMap::new);
            for slot in 0..MAX_CONTROLS as u64 {
                let stale = Caller::from_pipe_info(
                    &serde_json::json!({"name":"codex","instance":format!("{slot:064x}")}),
                );
                controls.insert(
                    slot,
                    (stale, Instant::now() - CONTROL_TTL - Duration::from_secs(1)),
                );
            }
        }
        let fresh = Caller::from_client_info(&serde_json::json!({"name":"claude"}));
        assert!(
            control_for(&fresh, 9_000).is_some(),
            "a stale registry must not lock out a live agent"
        );
        reset_controls();
    }

    #[test]
    fn a_session_belongs_to_its_caller_and_outlives_any_one_tab() {
        let _serial = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_controls();
        let claude = Caller::from_client_info(&serde_json::json!({"name":"claude"}));
        let codex =
            Caller::from_pipe_info(&serde_json::json!({"name":"codex","instance":"a".repeat(64)}));

        // One caller, one id, however many tabs the task ends up touching.
        // Deriving it per tab gave an agent working three tabs three unrelated
        // sessions and three ids to remember.
        let held = control_for(&claude, 10).expect("a first session");
        assert_eq!(control_for(&claude, 11), Some(held));
        assert_eq!(control_for(&claude, 12), Some(held));

        // A different caller never shares it, even mid-task.
        let other = control_for(&codex, 13).expect("a second session");
        assert_ne!(other, held);

        // Only the holder can give it up, and giving it up is not repeatable.
        assert!(!release_control(held, &codex), "not codex's to end");
        assert!(release_control(held, &claude));
        assert!(!release_control(held, &claude), "already ended");

        // The next task gets a fresh contract rather than reviving the old one.
        assert_ne!(control_for(&claude, 14), Some(held));
        reset_controls();
    }

    #[test]
    fn asking_whether_a_caller_holds_a_session_does_not_open_one() {
        let _guard = CONTROL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_controls();
        let kimi = Caller::from_client_info(&serde_json::json!({"name":"kimi-code"}));

        // The gate has to be able to ask before letting an action through. If
        // asking created the session, the gate would open itself.
        assert!(!holds_control(&kimi));
        assert!(!holds_control(&kimi));

        let held = control_for(&kimi, 20).expect("a session");
        assert!(holds_control(&kimi));
        assert!(release_control(held, &kimi));
        assert!(!holds_control(&kimi));
        reset_controls();
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

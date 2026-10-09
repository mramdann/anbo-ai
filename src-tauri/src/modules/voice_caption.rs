//! The live text bubble beside the AnboVoice orb. It is a window of its own:
//! growing the orb window to hold it would move the pill on screen and into
//! the orb's saved position. The bubble only shows text, so it never takes
//! focus and clicks pass through it.

use crate::modules::{global_voice, window_open};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "voice-caption";
pub const EVENT: &str = "anbo://global-voice-caption";
/// The window's size in logical pixels: a bubble of three lines of text and
/// room for its shadow. voice-caption.html lays the bubble out in it.
const SIZE: (f64, f64) = (340.0, 84.0);
/// Half the busy orb pill's width in logical pixels. The bubble lines up
/// with the pill's edge rather than the wider orb window's.
const PILL_HALF_WIDTH: f64 = 16.0;

#[derive(Default)]
pub struct VoiceCaptionState {
    caption: Mutex<Caption>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    /// Grows with every change, so a page that loads during a take can tell
    /// its first read from a newer event.
    seq: u64,
    text: Option<String>,
    /// The bubble sits above the orb, so it hangs from its window's bottom.
    above: bool,
    /// The bubble lines up with the orb's right edge rather than its left.
    align_right: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Placement {
    x: i32,
    y: i32,
    above: bool,
    align_right: bool,
}

/// Above the orb when the work area has room, below it otherwise, and on the
/// orb's side of the screen so that a long line runs toward the middle.
fn placement(orb: Rect, work: Rect, width: i32, height: i32, pill_half: i32) -> Placement {
    let above = orb.y - height >= work.y;
    let y = if above {
        orb.y - height
    } else {
        (orb.y + orb.height)
            .min(work.y + work.height - height)
            .max(work.y)
    };
    let center = orb.x + orb.width / 2;
    let align_right = center >= work.x + work.width / 2;
    let x = if align_right {
        center + pill_half - width
    } else {
        center - pill_half
    };
    let x = x.clamp(work.x, (work.x + work.width - width).max(work.x));
    Placement {
        x,
        y,
        above,
        align_right,
    }
}

fn locate(orb: &tauri::WebviewWindow) -> Result<Placement, String> {
    let position = orb.outer_position().map_err(|error| error.to_string())?;
    let size = orb.outer_size().map_err(|error| error.to_string())?;
    let monitor = orb
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| orb.primary_monitor().ok().flatten())
        .ok_or_else(|| "No screen holds the AnboVoice orb.".to_string())?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let physical = |value: f64| (value * scale).round() as i32;
    Ok(placement(
        Rect {
            x: position.x,
            y: position.y,
            width: size.width as i32,
            height: size.height as i32,
        },
        Rect {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width as i32,
            height: work.size.height as i32,
        },
        physical(SIZE.0),
        physical(SIZE.1),
        physical(PILL_HALF_WIDTH),
    ))
}

fn ensure_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }
    let builder = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("voice-caption.html".into()),
    )
    .title("AnboVoice caption")
    .inner_size(SIZE.0, SIZE.1)
    .min_inner_size(SIZE.0, SIZE.1)
    .max_inner_size(SIZE.0, SIZE.1)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false);

    // See global_voice::ensure_window: the bubble is Windows only too.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);

    #[cfg(target_os = "windows")]
    let builder = builder.drag_and_drop(false);

    let window = window_open::build("the AnboVoice caption", || builder.build())?;
    if let Err(error) = window.set_ignore_cursor_events(true) {
        // A bubble that caught clicks would sit on top of the text the user
        // is dictating into.
        let _ = window.close();
        return Err(error.to_string());
    }
    Ok(window)
}

fn update(state: &VoiceCaptionState, change: impl FnOnce(&mut Caption)) -> Result<Caption, String> {
    let mut caption = state
        .caption
        .lock()
        .map_err(|_| "The AnboVoice caption state is unavailable.".to_string())?;
    caption.seq += 1;
    change(&mut caption);
    Ok(caption.clone())
}

/// Shows `text` beside the orb, or hides the bubble when there is none.
#[tauri::command]
pub async fn global_voice_caption(
    app: tauri::AppHandle,
    state: tauri::State<'_, VoiceCaptionState>,
    text: Option<String>,
) -> Result<(), String> {
    let text = text
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let Some(text) = text else {
        let caption = update(&state, |caption| caption.text = None)?;
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.hide();
            let _ = app.emit_to(WINDOW_LABEL, EVENT, caption);
        }
        return Ok(());
    };
    let Some(orb) = app.get_webview_window(global_voice::WINDOW_LABEL) else {
        return Ok(());
    };
    let window = ensure_window(&app)?;
    let visible = window.is_visible().unwrap_or(false);
    // The orb cannot be dragged during a take, so the bubble is placed once,
    // as it appears.
    let spot = if visible { None } else { Some(locate(&orb)?) };
    let caption = update(&state, |caption| {
        caption.text = Some(text);
        if let Some(spot) = spot {
            caption.above = spot.above;
            caption.align_right = spot.align_right;
        }
    })?;
    if let Some(spot) = spot {
        window
            .set_position(PhysicalPosition::new(spot.x, spot.y))
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit_to(WINDOW_LABEL, EVENT, caption);
    if !visible {
        window_open::show("the AnboVoice caption", &window)?;
    }
    Ok(())
}

/// What a caption page that just loaded should show.
#[tauri::command]
pub fn global_voice_caption_current(
    state: tauri::State<'_, VoiceCaptionState>,
) -> Result<Caption, String> {
    state
        .caption
        .lock()
        .map(|caption| caption.clone())
        .map_err(|_| "The AnboVoice caption state is unavailable.".to_string())
}

/// Goes with the orb.
pub fn close(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<VoiceCaptionState>() {
        let _ = update(&state, |caption| caption.text = None);
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn orb_at(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 122,
            height: 42,
        }
    }

    #[test]
    fn sits_above_an_orb_in_the_default_corner_lined_up_with_the_pill() {
        // The orb's default place: 18 px from the bottom right of the work area.
        let spot = placement(orb_at(1780, 980), WORK, 340, 84, 16);
        assert_eq!(
            spot,
            Placement {
                x: 1780 + 61 + 16 - 340,
                y: 980 - 84,
                above: true,
                align_right: true,
            }
        );
    }

    #[test]
    fn drops_below_an_orb_at_the_top_and_runs_right_from_the_left_side() {
        let spot = placement(orb_at(10, 20), WORK, 340, 84, 16);
        assert_eq!(
            spot,
            Placement {
                x: 10 + 61 - 16,
                y: 20 + 42,
                above: false,
                align_right: false,
            }
        );
    }

    #[test]
    fn stays_inside_the_work_area_of_a_second_screen() {
        let work = Rect {
            x: -1280,
            y: 0,
            width: 1280,
            height: 984,
        };
        // An orb dragged half off the left edge of a screen left of the main one.
        let spot = placement(orb_at(-1330, 500), work, 340, 84, 16);
        assert_eq!((spot.x, spot.y, spot.above), (-1280, 416, true));
        let spot = placement(orb_at(-60, 500), work, 340, 84, 16);
        assert_eq!(spot.x, -1280 + 1280 - 340);
    }
}

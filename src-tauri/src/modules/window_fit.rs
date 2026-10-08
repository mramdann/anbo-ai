//! Keeps the main window and Settings inside the screen they open on.
//!
//! The window-state plugin puts a window back where it was saved, and the
//! screen can change in between: a TeamViewer session or a projector brings
//! another resolution, a monitor goes away. Settings saved at y=159 with its
//! 880 px then opened 93 px under the taskbar of a 946 px work area. A
//! maximized window keeps its restored bounds in `prev_x`/`prev_y`, which a
//! second move while maximized overwrites with the maximized -8,-8, so the
//! main window came out of maximize past the screen's corner, or taller than
//! the screen. Each of these windows is fitted to its monitor's work area when
//! it is ready (after window-state, which plugins see in order) and again when
//! it leaves maximize, minimize or fullscreen. A window the user drags partly
//! off the screen stays there: nothing is fitted on a move.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, Window, WindowEvent};

const FITTED_WINDOWS: [&str; 2] = ["main", "settings"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Register after the window-state plugin, so a window is fitted where that
/// plugin put it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-fit")
        .on_window_ready(|window| {
            if !FITTED_WINDOWS.contains(&window.label()) {
                return;
            }
            fit(&window);
            // A restore puts back bounds window-state saved, or bounds the
            // screen no longer holds; fit them once, as they come back.
            let held = Arc::new(AtomicBool::new(held_by_state(&window)));
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            window.on_window_event(move |event| {
                if !matches!(event, WindowEvent::Resized(_)) {
                    return;
                }
                let Some(window) = app.get_window(&label) else {
                    return;
                };
                let now = held_by_state(&window);
                if held.swap(now, Ordering::Relaxed) && !now {
                    fit(&window);
                }
            });
        })
        .build()
}

/// Maximized, minimized or full screen: the window's own bounds are not the
/// ones it shows.
fn held_by_state<R: Runtime>(window: &Window<R>) -> bool {
    window.is_maximized().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
        || window.is_fullscreen().unwrap_or(false)
}

/// Moves and, if it must, shrinks a shown or about-to-show window so that it
/// lies inside the work area of its monitor.
pub fn fit<R: Runtime>(window: &Window<R>) {
    if held_by_state(window) || pointer_pressed() {
        // A drag out of maximize is the user placing the window.
        return;
    }
    let (Ok(position), Ok(outer), Ok(inner)) = (
        window.outer_position(),
        window.outer_size(),
        window.inner_size(),
    ) else {
        return;
    };
    let Some(monitor) = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
    else {
        return;
    };
    let area = monitor.work_area();
    let current = Rect {
        x: position.x,
        y: position.y,
        width: outer.width,
        height: outer.height,
    };
    let work = Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let Some(next) = fitted(current, work) else {
        return;
    };
    if (next.width, next.height) != (current.width, current.height) {
        // set_size takes the inner size; keep whatever frame the window has.
        let frame_width = outer.width.saturating_sub(inner.width);
        let frame_height = outer.height.saturating_sub(inner.height);
        let _ = window.set_size(PhysicalSize::new(
            next.width.saturating_sub(frame_width),
            next.height.saturating_sub(frame_height),
        ));
    }
    let _ = window.set_position(PhysicalPosition::new(next.x, next.y));
    log::info!(
        "[windows] fitted {} into the screen: {}x{} at {},{} -> {}x{} at {},{}",
        window.label(),
        current.width,
        current.height,
        current.x,
        current.y,
        next.width,
        next.height,
        next.x,
        next.y
    );
}

/// The window's bounds moved, and shrunk where they must, to lie inside
/// `work`; `None` when they already do.
fn fitted(window: Rect, work: Rect) -> Option<Rect> {
    let width = window.width.min(work.width);
    let height = window.height.min(work.height);
    let right = work.x.saturating_add(work.width as i32);
    let bottom = work.y.saturating_add(work.height as i32);
    let x = window.x.min(right - width as i32).max(work.x);
    let y = window.y.min(bottom - height as i32).max(work.y);
    let next = Rect {
        x,
        y,
        width,
        height,
    };
    (next != window).then_some(next)
}

/// Whether a mouse button is down, as it is while the user drags a window out
/// of maximize. Checks both physical buttons, so swapped buttons count too.
#[cfg(windows)]
fn pointer_pressed() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    [VK_LBUTTON, VK_RBUTTON]
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0)
}

#[cfg(not(windows))]
fn pointer_pressed() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{fitted, Rect};

    const WORK: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 946,
    };

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_window_inside_the_screen_stays_where_it_is() {
        assert_eq!(fitted(rect(556, 30, 900, 880), WORK), None);
        assert_eq!(fitted(rect(0, 0, 1920, 946), WORK), None);
    }

    #[test]
    fn settings_saved_for_a_taller_screen_moves_up_above_the_taskbar() {
        assert_eq!(
            fitted(rect(556, 159, 900, 880), WORK),
            Some(rect(556, 66, 900, 880))
        );
    }

    #[test]
    fn a_restore_past_the_corner_or_taller_than_the_screen_comes_inside() {
        assert_eq!(
            fitted(rect(-8, -8, 859, 734), WORK),
            Some(rect(0, 0, 859, 734))
        );
        assert_eq!(
            fitted(rect(211, 93, 1003, 946), WORK),
            Some(rect(211, 0, 1003, 946))
        );
        assert_eq!(
            fitted(rect(100, 50, 2500, 1200), WORK),
            Some(rect(0, 0, 1920, 946))
        );
    }

    #[test]
    fn a_window_left_on_a_monitor_that_went_away_comes_back() {
        assert_eq!(
            fitted(rect(2400, 300, 900, 700), WORK),
            Some(rect(1020, 246, 900, 700))
        );
    }

    #[test]
    fn a_work_area_beside_a_taskbar_on_the_left_or_top_is_respected() {
        let work = rect(48, 40, 1872, 936);
        assert_eq!(
            fitted(rect(0, 0, 800, 600), work),
            Some(rect(48, 40, 800, 600))
        );
        let second = rect(-1920, 0, 1920, 1040);
        assert_eq!(
            fitted(rect(-1960, 100, 900, 700), second),
            Some(rect(-1920, 100, 900, 700))
        );
    }
}

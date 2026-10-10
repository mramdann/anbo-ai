//! Hold to talk for the global AnboVoice orb. A low-level keyboard hook on its
//! own thread watches one chord: Win, Ctrl+Win or Right Alt. Holding it alone
//! for `HOLD` starts a take and releasing it stops the take; any other key
//! pressed during the hold leaves the press to Windows as the shortcut it was.
//! A shorter press is a tap, so the Start menu (or the menu bar, for Alt)
//! behaves as before.

// Only the Windows hook feeds the chord tracker; other platforms build it for
// its tests and start no listener.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// The orb window listens for this event.
pub const EVENT: &str = "anbo://global-voice-ptt";

/// A shorter press is a tap or the start of a shortcut and never opens the
/// microphone: Win+E is typed well within it, and the Windows microphone
/// indicator would otherwise flash on every Start menu press.
pub const HOLD: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PttKey {
    #[default]
    Win,
    CtrlWin,
    RightAlt,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PttPhase {
    Start,
    Stop,
    Cancel,
}

const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_RMENU: u32 = 0xA5;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Nothing,
    /// The chord is complete with nothing else held: wait out `HOLD`.
    Arm,
    Start,
    Stop,
    Cancel,
}

/// The chord's state, fed every key transition the hook sees. Kept free of
/// Windows calls so the rules are unit tested; the hook asks the keyboard
/// itself only in `poll`, through `is_down`.
pub(crate) struct Chord {
    key: PttKey,
    parts: Vec<u32>,
    others: [bool; 256],
    broken: bool,
    armed_at: Option<Instant>,
    active: bool,
}

impl Chord {
    pub(crate) fn new(key: PttKey) -> Self {
        Self {
            key,
            parts: Vec::new(),
            others: [false; 256],
            broken: false,
            armed_at: None,
            active: false,
        }
    }

    fn is_part(&self, vk: u32) -> bool {
        match self.key {
            PttKey::Win => matches!(vk, VK_LWIN | VK_RWIN),
            PttKey::CtrlWin => matches!(vk, VK_LWIN | VK_RWIN | VK_LCONTROL | VK_RCONTROL),
            PttKey::RightAlt => vk == VK_RMENU,
            PttKey::Off => false,
        }
    }

    fn complete(&self) -> bool {
        let held = |keys: &[u32]| self.parts.iter().any(|vk| keys.contains(vk));
        match self.key {
            PttKey::Win => held(&[VK_LWIN, VK_RWIN]),
            PttKey::CtrlWin => held(&[VK_LWIN, VK_RWIN]) && held(&[VK_LCONTROL, VK_RCONTROL]),
            PttKey::RightAlt => held(&[VK_RMENU]),
            PttKey::Off => false,
        }
    }

    fn other_held(&self) -> bool {
        self.others.iter().any(|held| *held)
    }

    /// Whether the hook should keep its poll timer running: while any part of
    /// the chord is held, so stale keys are cleared and a missed release is
    /// noticed, and while a take runs.
    pub(crate) fn needs_poll(&self) -> bool {
        !self.parts.is_empty() || self.active
    }

    /// Forgets keys the hook saw go down but never saw come up: one released
    /// while an elevated window had the keyboard, or an unpaired event some
    /// tool sent. `is_down` asks the keyboard itself.
    fn forget_released(&mut self, is_down: &impl Fn(u32) -> bool) {
        for (index, held) in self.others.iter_mut().enumerate() {
            if *held && !is_down(index as u32) {
                *held = false;
            }
        }
    }

    pub(crate) fn key_down(
        &mut self,
        vk: u32,
        now: Instant,
        is_down: impl Fn(u32) -> bool,
    ) -> Step {
        if self.key == PttKey::Off {
            return Step::Nothing;
        }
        if self.is_part(vk) {
            if self.parts.contains(&vk) {
                return Step::Nothing; // auto-repeat
            }
            let was_complete = self.complete();
            self.parts.push(vk);
            if was_complete || !self.complete() || self.active || self.broken {
                return Step::Nothing;
            }
            // Shift+Win and the like are other combinations, not the chord.
            // A key remembered as held may be one whose release went unseen,
            // and Win alone has no poll before it to notice, so one such key
            // cost the next press; the keyboard settles it first.
            if self.other_held() {
                self.forget_released(&is_down);
            }
            if self.other_held() {
                self.broken = true;
                return Step::Nothing;
            }
            self.armed_at = Some(now);
            return Step::Arm;
        }
        self.others[(vk & 0xFF) as usize] = true;
        if self.parts.is_empty() {
            return Step::Nothing;
        }
        // A key pressed with the chord (Win+E, Ctrl+Win+Right) makes it the
        // shortcut it is; a take already running is thrown away.
        self.broken = true;
        self.armed_at = None;
        if self.active {
            self.active = false;
            return Step::Cancel;
        }
        Step::Nothing
    }

    pub(crate) fn key_up(&mut self, vk: u32) -> Step {
        if self.key == PttKey::Off {
            return Step::Nothing;
        }
        if !self.is_part(vk) {
            self.others[(vk & 0xFF) as usize] = false;
            return Step::Nothing;
        }
        self.parts.retain(|held| *held != vk);
        if self.complete() {
            return Step::Nothing;
        }
        self.armed_at = None;
        if self.parts.is_empty() {
            self.broken = false;
        }
        if self.active {
            self.active = false;
            return Step::Stop;
        }
        Step::Nothing
    }

    /// Called on the hook thread's timer. Releases the hook never saw (focus
    /// moved to an elevated window mid-hold, so Windows withheld the key up)
    /// would otherwise keep a take running to its five-minute cap, so held
    /// keys are checked against the keyboard first.
    pub(crate) fn poll(&mut self, now: Instant, is_down: impl Fn(u32) -> bool) -> Step {
        self.forget_released(&is_down);
        let released: Vec<u32> = self
            .parts
            .iter()
            .copied()
            .filter(|vk| !is_down(*vk))
            .collect();
        let mut step = Step::Nothing;
        for vk in released {
            if self.key_up(vk) == Step::Stop {
                step = Step::Stop;
            }
        }
        if step != Step::Nothing {
            return step;
        }
        match self.armed_at {
            Some(armed)
                if now.saturating_duration_since(armed) >= HOLD
                    && self.complete()
                    && !self.broken
                    && !self.active
                    && !self.other_held() =>
            {
                self.armed_at = None;
                self.active = true;
                Step::Start
            }
            _ => Step::Nothing,
        }
    }

    /// The listener is going away: a take still running is not finished.
    pub(crate) fn abandon(&mut self) -> Step {
        let active = self.active;
        *self = Self::new(self.key);
        if active {
            Step::Cancel
        } else {
            Step::Nothing
        }
    }
}

/// A running hook. Dropping it removes the hook and ends its threads; a take
/// still held is cancelled first.
pub struct Listener {
    #[cfg(windows)]
    thread_id: u32,
    #[cfg(windows)]
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(windows)]
    emitter: Option<std::thread::JoinHandle<()>>,
}

impl Listener {
    /// Nothing to listen for when `key` is `Off`, or off Windows.
    pub fn start(
        key: PttKey,
        emit: impl Fn(PttPhase) + Send + 'static,
    ) -> Result<Option<Self>, String> {
        if key == PttKey::Off {
            return Ok(None);
        }
        #[cfg(windows)]
        {
            // Windows removes a low-level hook whose thread does not answer in
            // time, and holds the keyboard while it waits. The hook thread
            // therefore only queues phases; another thread emits them.
            let (phases, queued) = std::sync::mpsc::channel::<PttPhase>();
            let emitter = std::thread::Builder::new()
                .name("anbo-voice-ptt-events".into())
                .spawn(move || {
                    for phase in queued {
                        emit(phase);
                    }
                })
                .map_err(|error| format!("Could not start push to talk: {error}"))?;
            let (ready, started) = std::sync::mpsc::channel();
            let thread = std::thread::Builder::new()
                .name("anbo-voice-ptt".into())
                .spawn(move || hook::run(key, phases, ready))
                .map_err(|error| format!("Could not start push to talk: {error}"))?;
            match started.recv() {
                Ok(Ok(thread_id)) => Ok(Some(Self {
                    thread_id,
                    thread: Some(thread),
                    emitter: Some(emitter),
                })),
                Ok(Err(error)) => {
                    let _ = thread.join();
                    let _ = emitter.join();
                    Err(error)
                }
                Err(_) => Err("Push to talk stopped while starting.".to_string()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = emit;
            Ok(None)
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            hook::quit(self.thread_id);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            // The hook thread dropped its sender on the way out, which ends
            // the emitter's loop.
            if let Some(emitter) = self.emitter.take() {
                let _ = emitter.join();
            }
        }
    }
}

#[cfg(windows)]
mod hook {
    use super::{Chord, PttKey, PttPhase, Step};
    use std::cell::{Cell, RefCell};
    use std::sync::mpsc::Sender;
    use std::time::Instant;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, KillTimer, PostThreadMessageW, SetTimer, SetWindowsHookExW,
        UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
        WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
    };

    /// Marks the keys this module sends, so its own hook passes them by. All
    /// other injected input (TeamViewer, accessibility tools) is a user's.
    const OWN_INPUT: usize = 0x414E_424F;
    /// Unassigned. Sent while the chord is held, it makes Windows read the
    /// press as a combination, so releasing Win opens no Start menu and
    /// releasing Alt activates no menu bar.
    const MASK_KEY: VIRTUAL_KEY = VIRTUAL_KEY(0xE8);
    const POLL_MS: u32 = 50;

    thread_local! {
        static CHORD: RefCell<Option<Chord>> = const { RefCell::new(None) };
        static TIMER: Cell<usize> = const { Cell::new(0) };
        static PHASES: RefCell<Option<Sender<PttPhase>>> = const { RefCell::new(None) };
    }

    fn key_is_down(vk: u32) -> bool {
        (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
    }

    fn ensure_timer() {
        if TIMER.get() == 0 {
            TIMER.set(unsafe { SetTimer(None, 0, POLL_MS, None) });
        }
    }

    fn stop_timer() {
        let timer = TIMER.replace(0);
        if timer != 0 {
            let _ = unsafe { KillTimer(None, timer) };
        }
    }

    /// Never blocks: the channel is unbounded and its reader is the emitter
    /// thread.
    fn queue(phase: PttPhase) {
        PHASES.with_borrow(|phases| {
            if let Some(phases) = phases {
                let _ = phases.send(phase);
            }
        });
    }

    fn send_mask_key() {
        let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: MASK_KEY,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: OWN_INPUT,
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    }

    // Windows removes a hook whose procedure is slow, so this one only updates
    // the chord, starts the poll timer and queues a phase.
    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            if info.dwExtraInfo != OWN_INPUT {
                let message = wparam.0 as u32;
                let now = Instant::now();
                let (step, polling) = CHORD.with_borrow_mut(|chord| match chord.as_mut() {
                    Some(chord) => {
                        let step = if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                            chord.key_down(info.vkCode, now, key_is_down)
                        } else if message == WM_KEYUP || message == WM_SYSKEYUP {
                            chord.key_up(info.vkCode)
                        } else {
                            Step::Nothing
                        };
                        (step, chord.needs_poll())
                    }
                    None => (Step::Nothing, false),
                });
                if polling {
                    ensure_timer();
                }
                match step {
                    Step::Stop => queue(PttPhase::Stop),
                    Step::Cancel => queue(PttPhase::Cancel),
                    Step::Arm | Step::Start | Step::Nothing => {}
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub(super) fn quit(thread_id: u32) {
        let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }

    pub(super) fn run(key: PttKey, phases: Sender<PttPhase>, ready: Sender<Result<u32, String>>) {
        CHORD.with_borrow_mut(|chord| *chord = Some(Chord::new(key)));
        PHASES.with_borrow_mut(|slot| *slot = Some(phases));
        let module = unsafe { GetModuleHandleW(None) }.ok();
        let hook = match unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module.map(Into::into), 0)
        } {
            Ok(hook) => hook,
            Err(error) => {
                let _ = ready.send(Err(format!(
                    "Windows refused the push to talk keyboard hook: {error}"
                )));
                PHASES.with_borrow_mut(|slot| *slot = None);
                return;
            }
        };
        let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
            if message.message != WM_TIMER {
                continue;
            }
            let (step, polling) = CHORD.with_borrow_mut(|chord| match chord.as_mut() {
                Some(chord) => (chord.poll(Instant::now(), key_is_down), chord.needs_poll()),
                None => (Step::Nothing, false),
            });
            match step {
                Step::Start => {
                    send_mask_key();
                    queue(PttPhase::Start);
                }
                Step::Stop => queue(PttPhase::Stop),
                Step::Cancel => queue(PttPhase::Cancel),
                Step::Arm | Step::Nothing => {}
            }
            if !polling {
                stop_timer();
            }
        }
        stop_timer();
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        let last = CHORD.with_borrow_mut(|chord| {
            let step = chord.as_mut().map(Chord::abandon).unwrap_or(Step::Nothing);
            *chord = None;
            step
        });
        if last == Step::Cancel {
            queue(PttPhase::Cancel);
        }
        // Dropping the sender ends the emitter thread's loop.
        PHASES.with_borrow_mut(|slot| *slot = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_E: u32 = 0x45;
    const LSHIFT: u32 = 0xA0;

    fn after(start: Instant, millis: u64) -> Instant {
        start + Duration::from_millis(millis)
    }

    #[test]
    fn a_held_win_starts_after_the_hold_and_stops_on_release() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        assert_eq!(chord.key_down(VK_LWIN, t0, |_| true), Step::Arm);
        assert_eq!(chord.poll(after(t0, 100), |_| true), Step::Nothing);
        assert_eq!(
            chord.key_down(VK_LWIN, after(t0, 150), |_| true),
            Step::Nothing,
            "auto-repeat"
        );
        assert_eq!(chord.poll(after(t0, 300), |_| true), Step::Start);
        assert_eq!(chord.poll(after(t0, 400), |_| true), Step::Nothing);
        assert_eq!(chord.key_up(VK_LWIN), Step::Stop);
        assert!(!chord.needs_poll());
    }

    #[test]
    fn a_tap_never_starts() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        assert_eq!(chord.key_down(VK_LWIN, t0, |_| true), Step::Arm);
        assert_eq!(chord.key_up(VK_LWIN), Step::Nothing);
        assert_eq!(chord.poll(after(t0, 500), |_| false), Step::Nothing);
    }

    #[test]
    fn a_shortcut_typed_with_win_never_starts_and_cancels_a_running_take() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        chord.key_down(VK_LWIN, t0, |_| true);
        assert_eq!(
            chord.key_down(KEY_E, after(t0, 80), |_| true),
            Step::Nothing
        );
        assert_eq!(chord.poll(after(t0, 400), |_| true), Step::Nothing);
        chord.key_up(KEY_E);
        assert_eq!(
            chord.poll(after(t0, 700), |_| true),
            Step::Nothing,
            "still the same press"
        );
        assert_eq!(chord.key_up(VK_LWIN), Step::Nothing);

        let t1 = after(t0, 1000);
        chord.key_down(VK_LWIN, t1, |_| true);
        assert_eq!(chord.poll(after(t1, 300), |_| true), Step::Start);
        assert_eq!(
            chord.key_down(KEY_E, after(t1, 900), |_| true),
            Step::Cancel
        );
        assert_eq!(chord.key_up(VK_LWIN), Step::Nothing, "already cancelled");
    }

    #[test]
    fn win_pressed_while_another_key_is_held_is_not_the_chord() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        chord.key_down(LSHIFT, t0, |_| true);
        assert_eq!(
            chord.key_down(VK_LWIN, after(t0, 10), |_| true),
            Step::Nothing
        );
        assert_eq!(chord.poll(after(t0, 500), |_| true), Step::Nothing);
    }

    #[test]
    fn a_missed_release_stops_the_take_on_the_next_poll() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        chord.key_down(VK_LWIN, t0, |_| true);
        assert_eq!(chord.poll(after(t0, 300), |_| true), Step::Start);
        assert_eq!(chord.poll(after(t0, 350), |_| false), Step::Stop);
        assert!(!chord.needs_poll());
    }

    #[test]
    fn a_key_whose_release_went_unseen_does_not_cost_a_press() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        chord.key_down(KEY_E, t0, |_| true); // its key up was never seen
        assert_eq!(
            chord.key_down(VK_LWIN, after(t0, 10), |vk| vk != KEY_E),
            Step::Arm
        );
        assert_eq!(chord.poll(after(t0, 310), |vk| vk != KEY_E), Step::Start);
    }

    #[test]
    fn ctrl_win_pressed_quickly_is_not_broken_by_a_stale_key() {
        // Win 40 ms after Ctrl comes before the first 50 ms poll could prune
        // the stale key; the press used to be lost (Oct 10 stress run).
        const F24: u32 = 0x87;
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::CtrlWin);
        chord.key_down(F24, t0, |_| true);
        let keyboard = |vk: u32| vk != F24;
        assert_eq!(
            chord.key_down(VK_LCONTROL, after(t0, 300), keyboard),
            Step::Nothing
        );
        assert_eq!(chord.key_down(VK_LWIN, after(t0, 340), keyboard), Step::Arm);
        assert_eq!(chord.poll(after(t0, 640), keyboard), Step::Start);
    }

    #[test]
    fn ctrl_win_needs_both_keys_in_either_order() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::CtrlWin);
        assert_eq!(chord.key_down(VK_LWIN, t0, |_| true), Step::Nothing);
        assert_eq!(
            chord.key_down(VK_RCONTROL, after(t0, 40), |_| true),
            Step::Arm
        );
        assert_eq!(
            chord.poll(after(t0, 300), |_| true),
            Step::Nothing,
            "armed at 40 ms"
        );
        assert_eq!(chord.poll(after(t0, 340), |_| true), Step::Start);
        assert_eq!(chord.key_up(VK_RCONTROL), Step::Stop);
        assert_eq!(chord.key_up(VK_LWIN), Step::Nothing);
    }

    #[test]
    fn win_alone_is_another_key_for_right_alt_and_ctrl_for_win() {
        let t0 = Instant::now();
        let mut alt = Chord::new(PttKey::RightAlt);
        assert_eq!(alt.key_down(VK_LWIN, t0, |_| true), Step::Nothing);
        assert_eq!(
            alt.key_down(VK_RMENU, after(t0, 10), |_| true),
            Step::Nothing,
            "Win is held"
        );

        let mut win = Chord::new(PttKey::Win);
        win.key_down(VK_LCONTROL, t0, |_| true);
        assert_eq!(
            win.key_down(VK_LWIN, after(t0, 10), |_| true),
            Step::Nothing,
            "Ctrl+Win is not Win"
        );
    }

    #[test]
    fn off_ignores_everything() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Off);
        assert_eq!(chord.key_down(VK_LWIN, t0, |_| true), Step::Nothing);
        assert_eq!(chord.poll(after(t0, 500), |_| true), Step::Nothing);
    }

    #[test]
    fn abandoning_a_running_take_cancels_it() {
        let t0 = Instant::now();
        let mut chord = Chord::new(PttKey::Win);
        chord.key_down(VK_LWIN, t0, |_| true);
        chord.poll(after(t0, 300), |_| true);
        assert_eq!(chord.abandon(), Step::Cancel);
        assert_eq!(chord.abandon(), Step::Nothing);
    }

    #[test]
    fn the_key_names_match_the_frontend() {
        let names: Vec<String> = [PttKey::Win, PttKey::CtrlWin, PttKey::RightAlt, PttKey::Off]
            .iter()
            .map(|key| serde_json::to_string(key).unwrap())
            .collect();
        assert_eq!(
            names,
            ["\"win\"", "\"ctrl_win\"", "\"right_alt\"", "\"off\""]
        );
    }
}

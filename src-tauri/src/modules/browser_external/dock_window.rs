use serde::{Deserialize, Serialize};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, RECT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Bounds {
    pub fn valid(&self) -> bool {
        (-100_000..=100_000).contains(&self.x)
            && (-100_000..=100_000).contains(&self.y)
            && (1..=16_384).contains(&self.width)
            && (1..=16_384).contains(&self.height)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub handle: u64,
    pub process: u32,
    pub token: String,
    pub browser: String,
    pub original: Bounds,
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

impl Lease {
    pub fn hwnd(&self) -> HWND {
        HWND(self.handle as usize as *mut _)
    }

    fn property(&self) -> Vec<u16> {
        wide(&format!("AnboDock-{}", self.token))
    }

    fn identity(&self) -> bool {
        if self.handle == 0
            || self.handle > isize::MAX as u64
            || self.process == 0
            || self.token.len() != 64
            || !self.token.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !self.original.valid()
        {
            return false;
        }
        let mut process = 0;
        unsafe {
            GetWindowThreadProcessId(self.hwnd(), Some(&mut process));
        }
        process == self.process && unsafe { IsWindow(Some(self.hwnd())).as_bool() }
    }

    pub fn live(&self) -> bool {
        self.identity()
            && unsafe { GetPropW(self.hwnd(), PCWSTR(self.property().as_ptr())).0 as usize == 1 }
    }

    pub fn arm(&self) -> Result<(), String> {
        if !self.identity() {
            return Err("Dock window identity is invalid".into());
        }
        let expected = match self.browser.as_str() {
            "chrome" => "chrome.exe",
            "edge" => "msedge.exe",
            _ => return Err("Unknown dock browser".into()),
        };
        let mut class = [0_u16; 128];
        let length = unsafe { GetClassNameW(self.hwnd(), &mut class) };
        if String::from_utf16_lossy(&class[..length.max(0) as usize]) != "Chrome_WidgetWin_1" {
            return Err("Not a Chrome/Edge browser window".into());
        }
        let mut title = [0_u16; 512];
        let length = unsafe { GetWindowTextW(self.hwnd(), &mut title) };
        let title = String::from_utf16_lossy(&title[..length.max(0) as usize]);
        let marker = format!("Anbo Dock {}", self.token);
        if title != marker && !title.starts_with(&format!("{marker} - ")) {
            return Err("Dock challenge did not match the dedicated browser window".into());
        }
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, self.process)
                .map_err(|error| error.to_string())?;
            let mut path = [0_u16; 32768];
            let mut size = path.len() as u32;
            let queried = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(path.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(process);
            queried.map_err(|error| error.to_string())?;
            let name = String::from_utf16_lossy(&path[..size as usize]);
            if !name
                .rsplit(['\\', '/'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case(expected))
            {
                return Err("Dock process does not match the approved browser".into());
            }
            SetPropW(
                self.hwnd(),
                PCWSTR(self.property().as_ptr()),
                Some(HANDLE(std::ptr::dangling_mut())),
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn restore(&self) {
        if !self.live() {
            return;
        }
        unsafe {
            let _ = SetWindowPos(
                self.hwnd(),
                None,
                self.original.x,
                self.original.y,
                self.original.width,
                self.original.height,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW,
            );
            let _ = ShowWindowAsync(self.hwnd(), SW_SHOWNOACTIVATE);
            let _ = RemovePropW(self.hwnd(), PCWSTR(self.property().as_ptr()));
        }
    }
}

pub fn window_bounds(window: HWND) -> Result<Bounds, String> {
    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(window, &mut rect).map_err(|error| error.to_string())?;
    }
    Ok(Bounds {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_invalid_window_geometry() {
        assert!(Bounds {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080
        }
        .valid());
        for bounds in [
            Bounds::default(),
            Bounds {
                width: 20_000,
                height: 600,
                ..Default::default()
            },
            Bounds {
                x: i32::MAX,
                width: 800,
                height: 600,
                ..Default::default()
            },
        ] {
            assert!(!bounds.valid());
        }
    }
    #[test]
    fn stale_window_handles_cannot_be_restored() {
        let lease = Lease {
            handle: 0,
            process: 0,
            token: "a".repeat(64),
            browser: "chrome".into(),
            original: Bounds {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
        };
        assert!(!lease.live());
        assert!(lease.arm().is_err());
        lease.restore();
    }
}

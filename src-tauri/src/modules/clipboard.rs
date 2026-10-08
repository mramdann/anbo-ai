//! The clipboard's text for a terminal paste. WebView2's
//! `navigator.clipboard.readText` first asks the user for a permission in a
//! small prompt: a paste waits on it, a later Allow delivers every paste that
//! waited at once, and no context menu opens while the prompt is up.

/// The clipboard's text, or `None` when it holds no text (an image, files).
#[tauri::command]
pub async fn clipboard_read_text() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win32::read_text)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("the native clipboard read is only used on Windows".to_string())
    }
}

/// Clipboard text is NUL-terminated UTF-16 in a block that may be larger.
#[cfg_attr(not(windows), allow(dead_code))]
fn text_until_nul(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

#[cfg(windows)]
mod win32 {
    use std::time::Duration;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    /// Another program can hold the clipboard open for a moment, a clipboard
    /// manager, or TeamViewer and Remote Desktop syncing a copy, which is just
    /// when a paste follows. Chromium gives up after about 25 ms; this waits
    /// up to 300 ms.
    const OPEN_ATTEMPTS: u32 = 20;
    const OPEN_RETRY: Duration = Duration::from_millis(15);

    pub fn read_text() -> Result<Option<String>, String> {
        let mut attempt = 0;
        while unsafe { OpenClipboard(None) }.is_err() {
            attempt += 1;
            if attempt == OPEN_ATTEMPTS {
                return Err("another program holds the clipboard".to_string());
            }
            std::thread::sleep(OPEN_RETRY);
        }
        let text = open_clipboard_text();
        let _ = unsafe { CloseClipboard() };
        text
    }

    /// Only called while this thread has the clipboard open.
    fn open_clipboard_text() -> Result<Option<String>, String> {
        let format = u32::from(CF_UNICODETEXT.0);
        if unsafe { IsClipboardFormatAvailable(format) }.is_err() {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(format) }.map_err(|error| error.to_string())?;
        let memory = HGLOBAL(handle.0);
        let units = unsafe { GlobalLock(memory) }.cast::<u16>();
        if units.is_null() {
            return Err("the clipboard text could not be read".to_string());
        }
        let length = unsafe { GlobalSize(memory) } / 2;
        let text = super::text_until_nul(unsafe { std::slice::from_raw_parts(units, length) });
        let _ = unsafe { GlobalUnlock(memory) };
        Ok(Some(text))
    }
}

#[cfg(test)]
mod tests {
    use super::text_until_nul;

    #[test]
    fn clipboard_text_stops_at_its_terminator() {
        let units: Vec<u16> = "echo hi\r\nnext"
            .encode_utf16()
            .chain([0, 0x41, 0x42])
            .collect();
        assert_eq!(text_until_nul(&units), "echo hi\r\nnext");
        let unterminated: Vec<u16> = "no end".encode_utf16().collect();
        assert_eq!(text_until_nul(&unterminated), "no end");
        assert_eq!(text_until_nul(&[0]), "");
    }
}

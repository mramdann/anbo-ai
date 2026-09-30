//! The Chrome or Edge process tree around a native host: which browser started
//! it, and what its other processes are. Shared by Anbo, which names the
//! profile that connects, and the native host, which keeps the extension's
//! process scheduled.

use std::collections::HashMap;
use std::path::PathBuf;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

const BROWSERS: [&str; 2] = ["chrome.exe", "msedge.exe"];
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        class: u32,
        information: *mut core::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

/// The browser that started the native host, a few parents up: the
/// browser starts the host through cmd.exe.
pub(super) fn browser_ancestor(client: u32) -> Option<u32> {
    let processes = processes()?;
    let mut current = client;
    for _ in 0..4 {
        let (parent, _) = processes.get(&current)?;
        let (_, name) = processes.get(parent)?;
        if BROWSERS
            .iter()
            .any(|browser| name.eq_ignore_ascii_case(browser))
        {
            return Some(*parent);
        }
        current = *parent;
    }
    None
}

/// Every process with its parent and executable name.
pub(super) fn processes() -> Option<HashMap<u32, (u32, String)>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = Handle(snapshot);
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = HashMap::new();
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while more {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        processes.insert(
            entry.th32ProcessID,
            (
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..length]),
            ),
        );
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    Some(processes)
}

fn open(pid: u32) -> Option<Handle> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    (!handle.is_null()).then_some(Handle(handle))
}

pub(super) fn image_path(pid: u32) -> Option<PathBuf> {
    let process = open(pid)?;
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

pub(super) fn command_line(pid: u32) -> Option<String> {
    let process = open(pid)?;
    let mut needed = 0_u32;
    unsafe {
        NtQueryInformationProcess(
            process.0,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed == 0 || needed > 1 << 20 {
        return None;
    }
    // Whole u64 units keep the header that leads the buffer aligned.
    let mut buffer = vec![0_u64; (needed as usize).div_ceil(8)];
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            PROCESS_COMMAND_LINE_INFORMATION,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
            &mut needed,
        )
    };
    if status < 0 {
        return None;
    }
    let header = unsafe { &*buffer.as_ptr().cast::<UnicodeString>() };
    if header.buffer.is_null() {
        return None;
    }
    let text = unsafe { std::slice::from_raw_parts(header.buffer, usize::from(header.length) / 2) };
    Some(String::from_utf16_lossy(text))
}

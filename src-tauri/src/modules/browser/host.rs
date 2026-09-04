//! The WebView2 process that hosts every browser tab is not ours to reap.
//! Nothing ties it to anbo.exe, so force quitting Anbo leaves it running with
//! its renderer, GPU and utility children, all still holding composited
//! surfaces. Days of force quits pile those up until the desktop compositor
//! itself is the bottleneck and the whole machine crawls.
//!
//! Both halves of the guard live here: the running host joins a job object that
//! dies with us, and a host recorded by an older build gets reaped at startup.

#![cfg(windows)]

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;
use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::modules::proc::job::ProcessJob;

const HOST_PID_FILE: &str = "browser-host.pid";
const HOST_IMAGE: &str = "msedgewebview2.exe";

// WebView2 shuts its host down once the last tab goes away and starts a fresh
// one for the next tab, so a single adopt-once slot would only ever protect the
// first generation. Scraping, which closes every tab and opens more, is exactly
// the workload that produces new generations.
static HOST_JOBS: OnceLock<Mutex<Vec<(u32, ProcessJob)>>> = OnceLock::new();

fn host_jobs() -> &'static Mutex<Vec<(u32, ProcessJob)>> {
    HOST_JOBS.get_or_init(|| Mutex::new(Vec::new()))
}

fn pid_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(HOST_PID_FILE))
        .map_err(|error| error.to_string())
}

/// Full image path of a live process, or None when the pid is already gone.
fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0_u16; 512];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

/// A recorded pid is only safe to kill while it still belongs to a WebView2
/// host. Windows reuses pids, and terminating a stranger would be far worse
/// than leaving one orphan behind.
fn is_webview_host(pid: u32) -> bool {
    image_path(pid)
        .map(|path| path.to_ascii_lowercase().ends_with(HOST_IMAGE))
        .unwrap_or(false)
}

/// Kill the browser host a previous run left behind. Runs before any tab
/// exists, so the only host it can find is a stale one.
pub fn reap_orphaned_host(app: &tauri::AppHandle) {
    let Ok(path) = pid_path(app) else {
        return;
    };
    let Ok(recorded) = fs::read_to_string(&path) else {
        return;
    };
    let _ = fs::remove_file(&path);
    let Ok(pid) = recorded.trim().parse::<u32>() else {
        return;
    };
    if !is_webview_host(pid) {
        return;
    }
    match ProcessJob::create_for(pid) {
        Ok(job) => match job.terminate() {
            Ok(()) => log::info!("reaped orphaned browser host tree pid={pid}"),
            Err(error) => log::warn!("could not terminate orphaned browser host {pid}: {error}"),
        },
        Err(error) => log::warn!("could not claim orphaned browser host {pid}: {error}"),
    }
}

/// Put the live browser host in a job that dies with this process. One call is
/// enough: every tab shares a data directory and therefore a single host.
pub fn adopt_host(app: &tauri::AppHandle, pid: u32) {
    let Ok(mut jobs) = host_jobs().lock() else {
        return;
    };
    // Dropping a job terminates its tree, so only release the ones whose host is
    // already gone. That is also what clears the handles a long session leaks.
    jobs.retain(|(adopted, _)| is_webview_host(*adopted));
    if jobs.iter().any(|(adopted, _)| *adopted == pid) {
        return;
    }
    match ProcessJob::create_for(pid) {
        Ok(job) => {
            jobs.push((pid, job));
            match pid_path(app) {
                Ok(path) => {
                    if let Err(error) = fs::write(&path, pid.to_string()) {
                        log::warn!("could not record browser host pid: {error}");
                    }
                }
                Err(error) => log::warn!("could not resolve browser host pid file: {error}"),
            }
            log::info!("browser host pid={pid} now terminates with Anbo");
        }
        // Worth knowing about but never worth blocking a tab over.
        Err(error) => log::warn!("could not put browser host {pid} in a job: {error}"),
    }
}

/// Read the host pid straight from the freshly created webview and adopt it.
pub fn adopt_from_webview(webview: &tauri::Webview) {
    let app = webview.app_handle().clone();
    let _ = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let mut pid = 0_u32;
        if unsafe { core.BrowserProcessId(&mut pid) }.is_err() || pid == 0 {
            return;
        }
        adopt_host(&app, pid);
    });
}

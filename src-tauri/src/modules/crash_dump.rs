//! A Dev build writes a minidump of a native crash beside `panic.log`.
//!
//! The round 76 soak ended with Dev gone on an access violation 4.8 s after a
//! page reload, with no panic, no log line and no dump: Windows Error
//! Reporting is off on the test machine, and the kit's debugger had stopped
//! minutes before. A debugger attached for the whole run also changes the
//! timing a race needs. This filter runs only when no debugger is attached and
//! Windows is about to end the process anyway. A thread started now writes
//! `crash-<pid>-<start>.dmp`, so a crash on a broken stack still gets its
//! dump, and the crash then goes on as before. A heap corruption ends the
//! process without reaching any filter; only a debugger sees that one.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL};
use windows_sys::Win32::System::Diagnostics::Debug::{
    MiniDumpWithDataSegs, MiniDumpWithFullMemoryInfo, MiniDumpWithHandleData,
    MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithPrivateReadWriteMemory,
    MiniDumpWithProcessThreadData, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules,
    MiniDumpWriteDump, SetUnhandledExceptionFilter, EXCEPTION_POINTERS,
    LPTOP_LEVEL_EXCEPTION_FILTER, MINIDUMP_EXCEPTION_INFORMATION,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, SetEvent,
    WaitForSingleObject,
};

/// The top-level filter's "not handled here": Windows goes on ending the
/// process (excpt.h's EXCEPTION_CONTINUE_SEARCH).
const CONTINUE_SEARCH: i32 = 0;
/// Long enough for a dump of Dev's heaps; a crash never waits forever on it.
const DUMP_WAIT_MS: u32 = 120_000;
/// How often the writer puts the filter back if a library replaced it.
const REASSERT_MS: u32 = 30_000;

static PATH: OnceLock<Vec<u16>> = OnceLock::new();
static REQUEST: AtomicUsize = AtomicUsize::new(0);
static DONE: AtomicUsize = AtomicUsize::new(0);
static WRITER_THREAD: AtomicU32 = AtomicU32::new(0);
static CRASH_THREAD: AtomicU32 = AtomicU32::new(0);
static POINTERS: AtomicPtr<EXCEPTION_POINTERS> = AtomicPtr::new(std::ptr::null_mut());
static TAKEN: AtomicBool = AtomicBool::new(false);
/// The filter that was in place before Anbo's, called after the dump.
static PREVIOUS: AtomicUsize = AtomicUsize::new(0);

pub fn install(log_dir: &Path) {
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let path = log_dir.join(format!("crash-{}-{started}.dmp", std::process::id()));
    if std::fs::create_dir_all(log_dir).is_err() {
        return;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    if PATH.set(wide).is_err() {
        return;
    }
    // SAFETY: plain event objects, owned for the process's lifetime.
    let (request, done) = unsafe {
        (
            CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()),
            CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()),
        )
    };
    if request.is_null() || done.is_null() {
        return;
    }
    REQUEST.store(request as usize, Ordering::Release);
    DONE.store(done as usize, Ordering::Release);
    let writer = std::thread::Builder::new()
        .name("anbo-crash-dump".into())
        .stack_size(512 * 1024)
        .spawn(write_on_request);
    if writer.is_err() {
        return;
    }
    // SAFETY: `filter` is a plain extern "system" function that lives forever.
    let previous = unsafe { SetUnhandledExceptionFilter(Some(filter)) };
    remember_previous(previous);
    log::info!("[crash_dump] a native crash writes {}", path.display());
}

/// Anbo's filter as a number, to tell it from one a library set.
fn ours() -> usize {
    let ours: unsafe extern "system" fn(*const EXCEPTION_POINTERS) -> i32 = filter;
    ours as usize
}

fn remember_previous(previous: LPTOP_LEVEL_EXCEPTION_FILTER) {
    if let Some(previous) = previous.filter(|&found| found as usize != ours()) {
        PREVIOUS.store(previous as usize, Ordering::Release);
    }
}

fn write_on_request() {
    // SAFETY: the current thread's id, read once.
    WRITER_THREAD.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
    let request = REQUEST.load(Ordering::Acquire) as HANDLE;
    loop {
        // SAFETY: `request` stays open for the process's lifetime.
        if unsafe { WaitForSingleObject(request, REASSERT_MS) } == 0 {
            break;
        }
        // A library that set its own filter after Anbo's (none is known to)
        // would leave a crash without a dump; it stays chained after ours.
        // SAFETY: as in `install`.
        let current = unsafe { SetUnhandledExceptionFilter(Some(filter)) };
        if current.is_some_and(|found| found as usize != ours()) {
            log::warn!(
                "[crash_dump] another unhandled-exception filter replaced Anbo's; chained after it"
            );
            remember_previous(current);
        }
    }
    write_dump();
    // SAFETY: `done` stays open for the process's lifetime.
    unsafe { SetEvent(DONE.load(Ordering::Acquire) as HANDLE) };
}

fn write_dump() {
    let Some(path) = PATH.get() else {
        return;
    };
    // SAFETY: `path` is NUL-terminated; the handle is closed below.
    let file = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if file == INVALID_HANDLE_VALUE {
        return;
    }
    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: CRASH_THREAD.load(Ordering::Acquire),
        ExceptionPointers: POINTERS.load(Ordering::Acquire),
        ClientPointers: 0,
    };
    // Heaps and stacks, handles and module lists: what a read of the crash
    // needs, without every mapped image (the symbol server has those).
    let kind = MiniDumpWithDataSegs
        | MiniDumpWithPrivateReadWriteMemory
        | MiniDumpWithIndirectlyReferencedMemory
        | MiniDumpWithHandleData
        | MiniDumpWithThreadInfo
        | MiniDumpWithProcessThreadData
        | MiniDumpWithFullMemoryInfo
        | MiniDumpWithUnloadedModules;
    // SAFETY: the crashing thread waits in `filter` while this runs, so its
    // exception record and context stay valid.
    unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file,
            kind,
            &exception,
            std::ptr::null(),
            std::ptr::null(),
        );
        CloseHandle(file);
    }
}

unsafe extern "system" fn filter(pointers: *const EXCEPTION_POINTERS) -> i32 {
    // SAFETY: reading the current thread's id has no preconditions.
    let thread = unsafe { GetCurrentThreadId() };
    // The writer itself crashing cannot wait for itself.
    if thread != WRITER_THREAD.load(Ordering::Acquire) {
        let done = DONE.load(Ordering::Acquire) as HANDLE;
        // One dump: a second crashing thread waits for the first one's.
        if !TAKEN.swap(true, Ordering::AcqRel) {
            CRASH_THREAD.store(thread, Ordering::Release);
            POINTERS.store(pointers.cast_mut(), Ordering::Release);
            // SAFETY: both events stay open for the process's lifetime.
            unsafe { SetEvent(REQUEST.load(Ordering::Acquire) as HANDLE) };
        }
        // SAFETY: as above.
        unsafe { WaitForSingleObject(done, DUMP_WAIT_MS) };
    }
    match PREVIOUS.load(Ordering::Acquire) {
        0 => CONTINUE_SEARCH,
        previous => {
            // SAFETY: stored from a live LPTOP_LEVEL_EXCEPTION_FILTER.
            unsafe {
                let previous = std::mem::transmute::<
                    usize,
                    unsafe extern "system" fn(*const EXCEPTION_POINTERS) -> i32,
                >(previous);
                previous(pointers)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const CHILD: &str = "ANBO_CRASH_DUMP_TEST_DIR";

    /// The test binary runs itself again with the dump folder in `CHILD`; that
    /// copy installs the filter and writes through a null pointer.
    #[test]
    fn a_native_crash_leaves_a_dump() {
        if let Some(dir) = std::env::var_os(CHILD) {
            use windows_sys::Win32::System::Diagnostics::Debug::{
                SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
            };
            // No Windows Error Reporting window for the planned crash.
            // SAFETY: changes only this child's error mode.
            unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
            install(Path::new(&dir));
            // SAFETY: none; this is the crash under test.
            unsafe { std::ptr::null_mut::<u32>().write_volatile(1) };
            return;
        }
        let dir = std::env::temp_dir().join(format!("anbo-crash-dump-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let status = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "modules::crash_dump::tests::a_native_crash_leaves_a_dump",
                "--test-threads",
                "1",
            ])
            .env(CHILD, &dir)
            .status()
            .expect("run the crashing copy");
        assert_eq!(
            status.code(),
            Some(0xC000_0005_u32 as i32),
            "ends on its access violation"
        );
        let dumps: Vec<_> = std::fs::read_dir(&dir)
            .expect("dump folder")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "dmp"))
            .collect();
        assert_eq!(dumps.len(), 1, "one dump");
        let size = dumps[0].metadata().expect("dump size").len();
        assert!(size > 64 * 1024, "a dump with memory, {size} bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

use std::collections::HashSet;
use std::path::Path;

use crate::modules::pty::PtyState;

/// How many lock files are looked at: the newest. agy makes one for every
/// conversation and removes none (140 on one machine in two months), so the
/// folder only grows. Giving up past 512 entries, as this did, would have
/// ended session discovery for good on a machine that had seen that many
/// conversations: every reopened or resumed agy tab a new conversation (round
/// 96, R96-2). A lock keeps the time it was made, so the newest are the ones
/// that can be live; a conversation from far back that a user resumes by hand
/// is not found, as none was before.
const ENTRY_LIMIT: usize = 512;
/// A folder with more entries than this is not agy's own any more: nothing in
/// it is trusted.
const SCAN_LIMIT: usize = 65_536;

pub(super) fn find(state: &PtyState, pty_id: u32, claimed: &HashSet<String>) -> Option<String> {
    if !state.is_live(pty_id) {
        return None;
    }
    let root = dirs::home_dir()?.join(".gemini/antigravity-cli/presence");
    find_owned(&root, claimed, |path| owned_by(path, state, pty_id))
}

fn find_owned(
    root: &Path,
    claimed: &HashSet<String>,
    owns: impl FnMut(&Path) -> Result<bool, ()>,
) -> Option<String> {
    find_among(root, claimed, owns, ENTRY_LIMIT, SCAN_LIMIT)
}

fn find_among(
    root: &Path,
    claimed: &HashSet<String>,
    mut owns: impl FnMut(&Path) -> Result<bool, ()>,
    newest: usize,
    scan_limit: usize,
) -> Option<String> {
    let root = std::fs::canonicalize(root).ok()?;
    let mut locks = Vec::new();
    for (index, entry) in std::fs::read_dir(&root).ok()?.enumerate() {
        if index >= scan_limit {
            return None;
        }
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "lock") {
            continue;
        }
        let id = path.file_stem()?.to_str()?;
        if !super::resume::is_uuid(id) {
            continue;
        }
        // The folder's own listing has the time: no call per file.
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        locks.push((modified, path));
    }
    // Newest first; one whose time cannot be read counts as the oldest.
    locks.sort_by_key(|lock| std::cmp::Reverse(lock.0));
    locks.truncate(newest);
    let mut found = None;
    for (_, path) in &locks {
        let id = path.file_stem()?.to_str()?;
        let metadata = std::fs::symlink_metadata(path).ok()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 4096
            || std::fs::canonicalize(path).ok()?.parent() != Some(root.as_path())
        {
            return None;
        }
        if owns(path).ok()? {
            if found.is_some() {
                return None;
            }
            found = Some(id.to_owned());
        }
    }
    let id = found.filter(|id| !claimed.contains(id))?;
    owns(&root.join(format!("{id}.lock"))).ok()?.then_some(id)
}

/// Whether a running process's file is agy's: `agy.exe`, or the name agy's own
/// updater leaves a running one under. Windows cannot replace a file that is
/// running, so an agy that updates itself renames its file to
/// `agy.exe.<nanoseconds>.old` and puts the new `agy.exe` next to it, and from
/// then on Windows reports the running process under the new name. Asking for
/// `agy.exe` alone, as this did, an agy that had updated itself was nobody's
/// session for as long as it ran: its tab came back from a pause, a restart
/// or a reopen as a new conversation (round 96, R96-3: seen when agy went
/// from 1.5.6 to 1.5.7 seven seconds after its start).
#[cfg(any(windows, test))]
fn is_agy_image(image: &Path) -> bool {
    let Some(name) = image.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    match name.strip_prefix("agy.exe") {
        Some("") => true,
        Some(renamed) => renamed.starts_with('.') && renamed.ends_with(".old"),
        None => false,
    }
}

#[cfg(not(windows))]
fn owned_by(_path: &Path, _state: &PtyState, _pty_id: u32) -> Result<bool, ()> {
    // No timestamp/cwd fallback when exact process ownership is unavailable.
    Err(())
}

#[cfg(windows)]
fn owned_by(path: &Path, state: &PtyState, pty_id: u32) -> Result<bool, ()> {
    windows::owned_by(path, state, pty_id)
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{HANDLE, STILL_ACTIVE};
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::*;

    const OWNER_LIMIT: usize = 128;
    type Query = unsafe extern "system" fn(HANDLE, *mut IoStatus, *mut c_void, u32, i32) -> i32;

    #[repr(C)]
    #[derive(Default)]
    struct IoStatus {
        status: usize,
        information: usize,
    }

    fn query_function() -> Option<Query> {
        static FUNCTION: OnceLock<Option<Query>> = OnceLock::new();
        *FUNCTION.get_or_init(|| unsafe {
            let module_name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
            let module = GetModuleHandleW(module_name.as_ptr());
            if module.is_null() {
                return None;
            }
            let function = GetProcAddress(module, c"NtQueryInformationFile".as_ptr().cast())?;
            Some(std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                Query,
            >(function))
        })
    }

    fn process_ids(file: &File) -> Result<Vec<u32>, ()> {
        let query = query_function().ok_or(())?;
        let mut status = IoStatus::default();
        let mut output = [0usize; OWNER_LIMIT + 1];
        // Class 47 is optional OS evidence. Unsupported/truncated results fail closed.
        let code = unsafe {
            query(
                file.as_raw_handle(),
                &mut status,
                output.as_mut_ptr().cast(),
                std::mem::size_of_val(&output) as u32,
                47,
            )
        };
        let count = output[0] as u32 as usize;
        if code != 0 || count > OWNER_LIMIT {
            return Err(());
        }
        let required = (count + 1) * std::mem::size_of::<usize>();
        if status.information < required || status.information > std::mem::size_of_val(&output) {
            return Err(());
        }
        output[1..=count]
            .iter()
            .map(|pid| u32::try_from(*pid).map_err(|_| ()))
            .collect()
    }

    pub(super) fn owned_by(path: &Path, state: &PtyState, pty_id: u32) -> Result<bool, ()> {
        let file = File::open(path).map_err(|_| ())?;
        let owners = process_ids(&file)?;
        let [pid] = owners.as_slice() else {
            return Ok(false);
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid) };
        if handle.is_null() {
            return Err(());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut name = [0u16; 4096];
        let mut length = name.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(process.as_raw_handle(), 0, name.as_mut_ptr(), &mut length)
        } == 0
        {
            return Err(());
        }
        let name = String::from_utf16(&name[..length as usize]).map_err(|_| ())?;
        if !is_agy_image(Path::new(&name)) || state.owner_of_process(*pid) != Some(pty_id) {
            return Ok(false);
        }
        let mut exit_code = 0;
        let active = unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) } != 0
            && exit_code == STILL_ACTIVE as u32;
        // Pin the process handle across the second query to prevent PID-reuse attribution.
        Ok(active && process_ids(&file)? == owners && state.is_live(pty_id))
    }

    #[test]
    fn native_query_reports_a_held_presence_lock_and_releases_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("presence.lock");
        let writer = File::create(&path).unwrap();
        writer.lock().unwrap();
        assert!(process_ids(&File::open(&path).unwrap())
            .unwrap()
            .contains(&std::process::id()));
        drop(writer);
        assert!(process_ids(&File::open(&path).unwrap()).unwrap().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "11111111-2222-4333-8444-555555555555";
    const SECOND: &str = "22222222-2222-4333-8444-555555555555";

    fn presence(root: &Path, id: &str) {
        std::fs::write(root.join(format!("{id}.lock")), []).unwrap();
    }

    #[test]
    fn delayed_first_input_cannot_claim_the_second_agents_session() {
        let root = tempfile::tempdir().unwrap();
        presence(root.path(), SECOND);
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |_| Ok(false)),
            None
        );
        presence(root.path(), FIRST);
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |path| Ok(path
                .file_stem()
                .unwrap()
                == FIRST)),
            Some(FIRST.into())
        );
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |path| Ok(path
                .file_stem()
                .unwrap()
                == SECOND)),
            Some(SECOND.into())
        );
    }

    #[test]
    fn stale_files_newer_mtimes_and_claimed_ids_never_override_ownership() {
        let root = tempfile::tempdir().unwrap();
        presence(root.path(), FIRST);
        presence(root.path(), SECOND);
        assert_eq!(
            find_owned(root.path(), &HashSet::from([FIRST.into()]), |path| Ok(path
                .file_stem()
                .unwrap()
                == FIRST)),
            None
        );
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |_| Ok(false)),
            None
        );
        assert_eq!(find_owned(root.path(), &HashSet::new(), |_| Err(())), None);
        assert_eq!(
            find_owned(root.path(), &HashSet::from([FIRST.into()]), |_| Ok(true)),
            None
        );
    }

    #[test]
    fn ambiguous_sessions_and_scan_overflow_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        presence(root.path(), FIRST);
        presence(root.path(), SECOND);
        assert_eq!(find_owned(root.path(), &HashSet::new(), |_| Ok(true)), None);
        let owned_first = |path: &Path| Ok(path.file_stem().unwrap() == FIRST);
        for index in 0..6 {
            std::fs::write(root.path().join(format!("other-{index}")), []).unwrap();
        }
        // Eight entries: within a scan limit of eight, past one of seven.
        assert_eq!(
            find_among(root.path(), &HashSet::new(), owned_first, 512, 8),
            Some(FIRST.into())
        );
        assert_eq!(
            find_among(root.path(), &HashSet::new(), owned_first, 512, 7),
            None
        );
    }

    /// A lock named like a session, made `days` ago.
    fn old_presence(root: &Path, index: usize, days: u64) -> String {
        let id = format!("{index:08x}-2222-4333-8444-555555555555");
        let path = root.join(format!("{id}.lock"));
        std::fs::write(&path, []).unwrap();
        let made = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(made)
            .unwrap();
        id
    }

    #[test]
    fn more_stale_locks_than_are_looked_at_do_not_hide_the_live_session() {
        // Round 96 (R96-2): agy leaves a lock behind for every conversation.
        // Past 512 of them no session was found any more.
        let root = tempfile::tempdir().unwrap();
        for index in 0..ENTRY_LIMIT + 8 {
            old_presence(root.path(), index, 30 + index as u64);
        }
        presence(root.path(), FIRST);
        let mut asked = 0;
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |path| {
                asked += 1;
                Ok(path.file_stem().unwrap() == FIRST)
            }),
            Some(FIRST.into())
        );
        // The newest 512 and the one found, once more.
        assert_eq!(asked, ENTRY_LIMIT + 1);
    }

    #[test]
    fn a_lock_older_than_the_newest_looked_at_is_not_asked_about() {
        let root = tempfile::tempdir().unwrap();
        let oldest = old_presence(root.path(), 1, 400);
        for index in 2..6 {
            old_presence(root.path(), index, index as u64);
        }
        let owned_oldest = |path: &Path| Ok(path.file_stem().unwrap() == oldest.as_str());
        assert_eq!(
            find_among(root.path(), &HashSet::new(), owned_oldest, 4, 64),
            None
        );
        assert_eq!(
            find_among(root.path(), &HashSet::new(), owned_oldest, 5, 64),
            Some(oldest.clone())
        );
    }

    #[test]
    fn an_agy_that_updated_itself_while_running_is_still_agy() {
        // Round 96 (R96-3): what its updater renamed the running 1.5.6 to.
        for image in [
            "C:/Users/someone/AppData/Local/agy/bin/agy.exe",
            "C:/Users/someone/AppData/Local/agy/bin/AGY.EXE",
            "C:/Users/someone/AppData/Local/agy/bin/agy.exe.1794506160744373800.old",
            "C:/Users/someone/AppData/Local/agy/bin/Agy.exe.1794506160744373800.OLD",
            "C:/Users/someone/AppData/Local/agy/bin/agy.exe.old",
        ] {
            assert!(is_agy_image(Path::new(image)), "{image}");
        }
        for image in [
            "C:/tools/notagy.exe",
            "C:/tools/agy.exe.1794506160744373800",
            "C:/tools/agy.exe.1794506160744373800.new",
            "C:/tools/agy.exeold",
            "C:/tools/agy.exe2.old",
            "C:/tools/agy.exe.old.exe",
            "C:/tools/agy-helper.exe",
            "C:/tools/agy",
            "C:/tools/agy.exe.old/node.exe",
            "C:/tools/",
        ] {
            assert!(!is_agy_image(Path::new(image)), "{image}");
        }
    }

    #[test]
    fn malformed_and_oversized_presence_is_not_trusted() {
        let root = tempfile::tempdir().unwrap();
        presence(root.path(), "not-a-session");
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |_| panic!("invalid id")),
            None
        );
        std::fs::write(root.path().join(format!("{FIRST}.lock")), [0; 4097]).unwrap();
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |_| panic!("oversized file")),
            None
        );
    }
}

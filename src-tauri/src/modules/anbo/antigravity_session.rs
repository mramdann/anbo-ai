use std::collections::HashSet;
use std::path::Path;

use crate::modules::pty::PtyState;

const ENTRY_LIMIT: usize = 512;

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
    mut owns: impl FnMut(&Path) -> Result<bool, ()>,
) -> Option<String> {
    let root = std::fs::canonicalize(root).ok()?;
    let mut found = None;
    for (index, entry) in std::fs::read_dir(&root).ok()?.enumerate() {
        if index >= ENTRY_LIMIT {
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
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 4096
            || std::fs::canonicalize(&path).ok()?.parent() != Some(root.as_path())
        {
            return None;
        }
        if owns(&path).ok()? {
            if found.is_some() {
                return None;
            }
            found = Some(id.to_owned());
        }
    }
    let id = found.filter(|id| !claimed.contains(id))?;
    owns(&root.join(format!("{id}.lock"))).ok()?.then_some(id)
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
        if !Path::new(&name)
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("agy.exe"))
            || state.owner_of_process(*pid) != Some(pty_id)
        {
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
        for index in 0..ENTRY_LIMIT {
            std::fs::write(root.path().join(format!("other-{index}")), []).unwrap();
        }
        assert_eq!(
            find_owned(root.path(), &HashSet::new(), |path| Ok(path
                .file_stem()
                .unwrap()
                == FIRST)),
            None
        );
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

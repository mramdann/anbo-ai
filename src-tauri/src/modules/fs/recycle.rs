use crate::modules::workspace::{authorize_entry_path, WorkspaceEnv, WorkspaceRegistry};
use std::path::{Path, PathBuf};

static TRASH_OPERATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[tauri::command]
pub async fn fs_trash(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = prepare_target(&registry, &path, &workspace)?;
    let permit = TRASH_OPERATION
        .try_acquire()
        .map_err(|_| "Another trash operation is in progress. Please try again.".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("anbo-trash".into())
        .spawn(move || {
            let result = recycle_with(&target, platform_recycle);
            drop(permit);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Trash operation did not complete.".to_string())?
}

fn prepare_target(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<PathBuf, String> {
    if matches!(workspace, WorkspaceEnv::Wsl { .. }) {
        return Err("Recycle Bin is not available for WSL files. No files were deleted.".into());
    }
    let target = authorize_entry_path(registry, path, workspace)?;
    if registry.is_authorized_root(&target) {
        return Err("A workspace root cannot be moved to the trash.".into());
    }
    std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if super::to_canon(&target).starts_with("//") {
        return Err(
            "Recycle Bin is not available for network paths. No files were deleted.".into(),
        );
    }
    Ok(target)
}

fn recycle_with(
    path: &Path,
    recycle: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    recycle(path).map_err(|error| {
        format!("Could not move to trash: {error}. Permanent deletion was not attempted.")
    })
}

#[cfg(not(windows))]
fn platform_recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn recycle_flags() -> windows::Win32::UI::Shell::FILEOPERATION_FLAGS {
    use windows::Win32::UI::Shell::*;
    FOF_NO_UI
        | FOF_WANTNUKEWARNING
        | FOF_NO_CONNECTED_ELEMENTS
        | FOFX_RECYCLEONDELETE
        | FOFX_ADDUNDORECORD
        | FOFX_EARLYFAILURE
}

#[cfg(windows)]
fn platform_recycle(path: &Path) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName},
        },
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let run = || -> windows::core::Result<()> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        let _apartment = Apartment;
        let operation: IFileOperation =
            unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)? };
        let name = HSTRING::from(super::to_canon(path).replace('/', "\\"));
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(&name, None)? };
        unsafe {
            operation.SetOperationFlags(recycle_flags())?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_ABORT,
                ));
            }
        }
        Ok(())
    };
    run().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_keeps_file_and_directory_contents() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("keep.txt");
        std::fs::write(&file, "keep").unwrap();
        for target in [&file, &folder] {
            let error = recycle_with(target, |_| Err("unsupported volume".into())).unwrap_err();
            assert!(error.contains("Permanent deletion was not attempted"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        }
    }

    #[test]
    fn authorizes_entries_but_rejects_roots_outside_and_wsl() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let file = root.path().join("file.txt");
        std::fs::write(&file, "keep").unwrap();
        assert!(prepare_target(&registry, &file.to_string_lossy(), &WorkspaceEnv::Local).is_ok());
        assert!(prepare_target(
            &registry,
            &root.path().to_string_lossy(),
            &WorkspaceEnv::Local
        )
        .is_err());
        assert!(prepare_target(
            &registry,
            &outside.path().join("file").to_string_lossy(),
            &WorkspaceEnv::Local
        )
        .is_err());
        assert!(prepare_target(
            &registry,
            "/repo/file",
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into()
            }
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn passes_symlink_entry_without_following_target() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("keep");
        std::fs::write(&target, "keep").unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let entry =
            prepare_target(&registry, &link.to_string_lossy(), &WorkspaceEnv::Local).unwrap();
        recycle_with(&entry, |path| {
            assert!(std::fs::symlink_metadata(path).unwrap().is_symlink());
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    }

    #[cfg(windows)]
    #[test]
    fn windows_requires_recycling_without_connected_file_deletion() {
        use windows::Win32::UI::Shell::*;
        let flags = recycle_flags().0;
        for required in [
            FOFX_RECYCLEONDELETE,
            FOF_WANTNUKEWARNING,
            FOFX_EARLYFAILURE,
            FOF_NO_CONNECTED_ELEMENTS,
        ] {
            assert_ne!(flags & required.0, 0);
        }
        assert_eq!(flags & FOFX_NOSKIPJUNCTIONS.0, 0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Moves only an owned fixture into the Windows Recycle Bin"]
    fn live_windows_recycles_owned_fixture() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("anbo-recycle-fixture");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("keep.txt"), "recoverable fixture").unwrap();
        platform_recycle(&folder).unwrap();
        assert!(!folder.exists());
    }
}

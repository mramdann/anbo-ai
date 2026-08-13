use crate::modules::workspace::{
    authorize_entry_path, authorize_existing_path, WorkspaceEnv, WorkspaceRegistry,
};

/// Creates a new empty file. Fails if the file already exists.
#[tauri::command]
pub fn fs_create_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_entry_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&p)?;
    }
    create_file_at(&p)
}

fn create_file_at(p: &std::path::Path) -> Result<(), String> {
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[tauri::command]
pub fn fs_create_dir(
    path: String,
    workspace: Option<WorkspaceEnv>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_entry_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&p)?;
    }
    create_dir_at(&p)
}

fn create_dir_at(p: &std::path::Path) -> Result<(), String> {
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let from_p = authorize_entry_path(&registry, &from, &workspace)?;
    let to_p = authorize_entry_path(&registry, &to, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&from_p)?;
        crate::modules::authority::ensure_unprotected(&to_p)?;
    }
    rename_at(&from_p, &to_p)
}

fn rename_at(from_p: &std::path::Path, to_p: &std::path::Path) -> Result<(), String> {
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    std::fs::rename(from_p, to_p).map_err(|e| {
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

/// Deletes a file or directory (recursively for dirs). Callers are
/// responsible for confirming destructive operations with the user.
#[tauri::command]
pub fn fs_delete(
    path: String,
    workspace: Option<WorkspaceEnv>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_entry_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&p)?;
    }
    delete_at(&p)
}

fn delete_at(p: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}

fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// Copies external files/dirs into a destination directory, recursively for
/// dirs. Sources are absolute OS paths (from a drag-drop); only the destination
/// is workspace-resolved. Refuses to overwrite existing entries.
#[tauri::command]
pub fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let dest = authorize_existing_path(&registry, &dest_dir, &workspace)?;
    copy_into(&sources, &dest)
}

fn copy_into(sources: &[String], dest: &std::path::Path) -> Result<(), String> {
    for source in sources {
        let src = std::path::PathBuf::from(source);
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid source: {source}"))?;
        let target = dest.join(name);
        if target.exists() {
            return Err(format!("already exists: {}", target.display()));
        }
        copy_recursive(&src, &target).map_err(|e| {
            log::warn!(
                "fs_copy({} -> {}) failed: {e}",
                src.display(),
                target.display()
            );
            e.to_string()
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: std::path::PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn create_file_makes_empty_and_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("new.txt");
        create_file_at(&f).expect("create");
        assert!(f.exists());
        assert_eq!(std::fs::read(&f).unwrap(), b"");

        // A second create must error, not truncate existing content.
        std::fs::write(&f, b"data").unwrap();
        let err = create_file_at(&f).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"data");
    }

    #[test]
    fn create_dir_builds_nested_chain_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        create_dir_at(&nested).expect("create dir");
        assert!(nested.is_dir());
        let err = create_dir_at(&nested).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        std::fs::write(&from, b"payload").unwrap();

        rename_at(&from, &to).expect("rename");
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"payload");

        // Missing source is reported, not silently ignored.
        let err = rename_at(&from, &dir.path().join("c.txt")).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // Refusing to overwrite an existing target is the data-loss guard.
        let occupied = dir.path().join("keep.txt");
        std::fs::write(&occupied, b"keep").unwrap();
        let err = rename_at(&to, &occupied).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep");
        assert!(to.exists());
    }

    #[test]
    fn copy_brings_file_and_dir_in_and_refuses_clobber() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.txt"), b"payload").unwrap();
        std::fs::create_dir_all(src.path().join("d/inner")).unwrap();
        std::fs::write(src.path().join("d/inner/y.txt"), b"y").unwrap();

        copy_into(
            &[s(src.path().join("a.txt")), s(src.path().join("d"))],
            dest.path(),
        )
        .expect("copy");

        assert_eq!(
            std::fs::read(dest.path().join("a.txt")).unwrap(),
            b"payload"
        );
        assert_eq!(
            std::fs::read(dest.path().join("d/inner/y.txt")).unwrap(),
            b"y"
        );
        // copy, not move: the source survives.
        assert!(src.path().join("a.txt").exists());

        let err = copy_into(&[s(src.path().join("a.txt"))], dest.path()).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn delete_removes_file_then_dir_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        delete_at(&f).expect("delete file");
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/y.txt"), b"y").unwrap();
        delete_at(&sub).expect("delete dir");
        assert!(!sub.exists());

        let err = delete_at(&dir.path().join("missing")).unwrap_err();
        assert!(!err.is_empty());
    }

    // Deleting a symlink that points at a directory must remove only the link,
    // never recurse through it and wipe the target's contents.
    #[cfg(unix)]
    #[test]
    fn delete_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        delete_at(&link).expect("delete symlink");
        assert!(!link.exists(), "symlink itself should be gone");
        assert!(real.is_dir(), "target dir must survive");
        assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"keep");
    }
}

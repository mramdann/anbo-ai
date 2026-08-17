use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::UNIX_EPOCH;
use std::{fs, io::Write};

use serde::Serialize;
use tauri::Emitter;
use tempfile::NamedTempFile;

use crate::modules::workspace::{
    authorize_existing_path, authorize_target_path, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Ceiling for explicit "open anyway"; mirrored as FORCE_READ_LIMIT in useDocument.ts.
const FORCE_MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const EXPECTED_MISSING_VERSION: &str = "__anbo_missing__";
static FILE_WRITE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        mtime: u64,
        version: String,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn version_for(meta: &fs::Metadata, bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{}:{}:{hash:016x}", meta.len(), mtime_millis(meta))
}

fn current_version(path: &Path) -> std::io::Result<Option<(u64, String)>> {
    match fs::read(path) {
        Ok(bytes) => {
            let meta = fs::metadata(path)?;
            Ok(Some((mtime_millis(&meta), version_for(&meta, &bytes))))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn file_write_lock(path: &Path) -> Arc<Mutex<()>> {
    let locks = FILE_WRITE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|error| error.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

#[tauri::command]
pub async fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
    max_bytes: Option<u64>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let path = authorize_existing_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&path)?;
    }
    read_file_sync(&path, force.unwrap_or(false), max_bytes)
}

fn read_file_sync(p: &Path, force: bool, max_bytes: Option<u64>) -> Result<ReadResult, String> {
    let meta = std::fs::metadata(p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    let base_limit = if force {
        FORCE_MAX_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    let limit = max_bytes.unwrap_or(base_limit).clamp(1, base_limit);
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }

    let bytes = std::fs::read(p).map_err(|e| {
        log::debug!("fs_read_file read({}) failed: {e}", p.display());
        e.to_string()
    })?;

    // Null-byte sniff on the first chunk. Not perfect (misses UTF-16 BOM
    // cases) but catches the common "this is a PNG" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    let version = version_for(&meta, &bytes);
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            mtime: mtime_millis(&meta),
            version,
        }),
        Err(_) => Ok(ReadResult::Binary { size }),
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum WriteResult {
    Written {
        mtime: u64,
        version: String,
    },
    Conflict {
        #[serde(rename = "currentMtime")]
        current_mtime: Option<u64>,
        #[serde(rename = "currentVersion")]
        current_version: Option<String>,
    },
}

fn write_if_version(
    target: &Path,
    content: &[u8],
    expected_version: Option<&str>,
) -> std::io::Result<WriteResult> {
    let write_lock = file_write_lock(target);
    let _write_guard = write_lock
        .lock()
        .map_err(|_| std::io::Error::other("file write lock poisoned"))?;
    if let Some(expected) = expected_version {
        let current = current_version(target)?;
        let matches = if expected == EXPECTED_MISSING_VERSION {
            current.is_none()
        } else {
            current.as_ref().map(|(_, version)| version.as_str()) == Some(expected)
        };
        if !matches {
            return Ok(WriteResult::Conflict {
                current_mtime: current.as_ref().map(|(mtime, _)| *mtime),
                current_version: current.map(|(_, version)| version),
            });
        }
    }

    let original_permissions = fs::metadata(target).ok().map(|m| m.permissions());
    write_atomic(target, content)?;
    if let Some(perms) = original_permissions {
        let _ = fs::set_permissions(target, perms);
    }
    let meta = fs::metadata(target)?;
    Ok(WriteResult::Written {
        mtime: mtime_millis(&meta),
        version: version_for(&meta, content),
    })
}

#[derive(Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Atomic write via O_EXCL tempfile in the target's parent, then rename.
/// The random suffix is what blocks pre-staged symlink attacks.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

/// Returns the new mtime so the editor can track disk state for conflict
/// detection without a follow-up stat.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes these as named invoke arguments.
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    protected: Option<bool>,
    expected_version: Option<String>,
    app: tauri::AppHandle,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<WriteResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let target = authorize_target_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&target)?;
    }
    let result = write_if_version(&target, content.as_bytes(), expected_version.as_deref())
        .map_err(|e| {
            log::warn!("fs_write_file({}) failed: {e}", target.display());
            e.to_string()
        })?;
    if matches!(result, WriteResult::Written { .. }) {
        let _ = app.emit(
            "fs:file-written",
            FileWrittenEvent {
                path: path.clone(),
                source,
            },
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn fs_canonicalize(
    path: String,
    workspace: Option<WorkspaceEnv>,
    protected: Option<bool>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let canon = authorize_existing_path(&registry, &path, &workspace)?;
    if protected.unwrap_or(false) {
        crate::modules::authority::ensure_unprotected(&canon)?;
    }
    Ok(super::to_canon(&canon))
}

#[tauri::command]
pub async fn fs_stat(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_existing_path(&registry, &path, &workspace)?;
    let p = resolve_path(&path, &workspace);
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    // fs::metadata follows symlinks, so the link check needs symlink_metadata.
    let kind = if std::fs::symlink_metadata(&p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    Ok(FileStat {
        size: meta.len(),
        mtime: mtime_millis(&meta),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn read_file_classifies_utf8_as_text() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"hello world").unwrap();
        match read_file_sync(&f, false, None).unwrap() {
            ReadResult::Text {
                content,
                size,
                mtime,
                version,
            } => {
                assert_eq!(content, "hello world");
                assert_eq!(size, 11);
                assert!(mtime > 0);
                assert!(!version.is_empty());
            }
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn read_file_detects_binary_via_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"PNG\0\x89image").unwrap();
        assert!(matches!(
            read_file_sync(&f, false, None).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn read_file_detects_binary_via_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        // Invalid UTF-8 with no null byte: must still classify as binary.
        std::fs::write(&f, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false, None).unwrap(),
            ReadResult::Binary { .. }
        ));
    }

    #[test]
    fn force_lifts_the_default_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.txt");
        std::fs::write(&f, vec![b'a'; (MAX_READ_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            read_file_sync(&f, false, None).unwrap(),
            ReadResult::TooLarge { .. }
        ));
        assert!(matches!(
            read_file_sync(&f, true, None).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn caller_can_lower_but_not_raise_the_read_limit() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("bounded.txt");
        std::fs::write(&f, b"12345").unwrap();

        assert!(matches!(
            read_file_sync(&f, false, Some(4)).unwrap(),
            ReadResult::TooLarge { size: 5, limit: 4 }
        ));
        assert!(matches!(
            read_file_sync(&f, false, Some(MAX_READ_BYTES + 1)).unwrap(),
            ReadResult::Text { .. }
        ));
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn versioned_write_rejects_a_stale_expected_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"first").unwrap();
        let expected = current_version(&target).unwrap().unwrap().1;
        std::fs::write(&target, b"external").unwrap();

        let result = write_if_version(&target, b"editor", Some(&expected)).unwrap();
        assert!(matches!(result, WriteResult::Conflict { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"external");
    }

    #[test]
    fn versioned_write_accepts_the_current_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"first").unwrap();
        let expected = current_version(&target).unwrap().unwrap().1;

        let result = write_if_version(&target, b"editor", Some(&expected)).unwrap();
        assert!(matches!(result, WriteResult::Written { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"editor");
    }

    #[test]
    fn versioned_write_can_require_a_missing_target() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("new.txt");
        let first = write_if_version(&target, b"first", Some(EXPECTED_MISSING_VERSION)).unwrap();
        assert!(matches!(first, WriteResult::Written { .. }));

        let second = write_if_version(&target, b"second", Some(EXPECTED_MISSING_VERSION)).unwrap();
        assert!(matches!(second, WriteResult::Conflict { .. }));
        assert_eq!(fs::read_to_string(target).unwrap(), "first");
    }

    #[test]
    fn concurrent_versioned_writes_allow_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"first").unwrap();
        let expected = current_version(&target).unwrap().unwrap().1;
        let barrier = Arc::new(Barrier::new(3));
        let workers = [b"alpha".as_slice(), b"bravo".as_slice()].map(|content| {
            let target = target.clone();
            let expected = expected.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                write_if_version(&target, content, Some(&expected)).unwrap()
            })
        });
        barrier.wait();
        let results = workers.map(|worker| worker.join().unwrap());

        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, WriteResult::Written { .. }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, WriteResult::Conflict { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn file_write_locks_are_released_after_use() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        let first = file_write_lock(&target);
        let weak = Arc::downgrade(&first);
        drop(first);
        let second = file_write_lock(&target);
        assert!(weak.upgrade().is_none());
        assert_eq!(Arc::strong_count(&second), 1);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.anbo.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }
}

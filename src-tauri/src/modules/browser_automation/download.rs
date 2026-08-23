use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

const MAX_DOWNLOAD_RECORDS: usize = 128;
const MAX_FILE_NAME_BYTES: usize = 255;
static NEXT_DOWNLOAD_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    pub download_id: String,
    pub tab_id: i64,
    pub workspace: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct DownloadRecord {
    snapshot: Mutex<DownloadSnapshot>,
    notify: Notify,
    download_dir: PathBuf,
    preferred_file_name: Option<String>,
}

#[derive(Default)]
struct DownloadRegistry {
    by_id: HashMap<String, Arc<DownloadRecord>>,
    pending_by_tab: HashMap<i64, String>,
    reserved_destinations: HashMap<String, PathBuf>,
    order: VecDeque<String>,
}

static DOWNLOADS: OnceLock<Mutex<DownloadRegistry>> = OnceLock::new();

fn downloads() -> &'static Mutex<DownloadRegistry> {
    DOWNLOADS.get_or_init(|| Mutex::new(DownloadRegistry::default()))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn bounded_source_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return value.chars().take(2_000).collect();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string().chars().take(2_000).collect()
}

fn is_windows_reserved_file_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn validate_preferred_file_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_FILE_NAME_BYTES {
        return Err("fileName must contain 1-255 bytes".to_string());
    }
    let path = Path::new(value);
    if path.file_name().and_then(|name| name.to_str()) != Some(value)
        || value == "."
        || value == ".."
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || value.ends_with(['.', ' '])
        || is_windows_reserved_file_name(value)
    {
        return Err("fileName must be a safe file name without a directory".to_string());
    }
    Ok(())
}

fn safe_default_file_name(destination: &Path) -> String {
    let raw = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download.bin");
    let mut output = raw
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect::<String>();
    while output.ends_with(['.', ' ']) {
        output.pop();
    }
    if output.is_empty() || output == "." || output == ".." {
        "download.bin".to_string()
    } else if is_windows_reserved_file_name(&output) {
        format!("_{output}")
    } else {
        output
    }
}

fn resolve_download_dir(workspace_root: &Path) -> Result<PathBuf, String> {
    let requested = workspace_root.join(".anbo").join("downloads");
    std::fs::create_dir_all(&requested)
        .map_err(|error| format!("failed to create browser download directory: {error}"))?;
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|error| format!("failed to resolve browser download directory: {error}"))?;
    if !canonical.starts_with(workspace_root) {
        return Err("browser download directory escapes the selected workspace".to_string());
    }
    Ok(canonical)
}

fn unique_destination(
    dir: &Path,
    file_name: &str,
    reserved_destinations: &HashMap<String, PathBuf>,
) -> PathBuf {
    let is_available = |candidate: &Path| {
        !candidate.exists()
            && !reserved_destinations
                .values()
                .any(|reserved| reserved == candidate)
    };
    let initial = dir.join(file_name);
    if is_available(&initial) {
        return initial;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 1..=10_000_u32 {
        let candidate = match extension {
            Some(extension) if !extension.is_empty() => {
                dir.join(format!("{stem} ({suffix}).{extension}"))
            }
            _ => dir.join(format!("{stem} ({suffix})")),
        };
        if is_available(&candidate) {
            return candidate;
        }
    }
    dir.join(format!("download-{}.bin", now_millis()))
}

fn trim_completed_records(registry: &mut DownloadRegistry) -> Result<(), String> {
    while registry.by_id.len() >= MAX_DOWNLOAD_RECORDS {
        let Some(oldest) = registry.order.pop_front() else {
            break;
        };
        let removable = registry
            .by_id
            .get(&oldest)
            .and_then(|record| record.snapshot.lock().ok())
            .is_some_and(|snapshot| is_terminal(&snapshot.status));
        if removable {
            registry.by_id.remove(&oldest);
        } else {
            registry.order.push_back(oldest);
            return Err("too many active or retained browser downloads".to_string());
        }
    }
    Ok(())
}

pub fn arm_download(
    tab_id: i64,
    workspace_root: &Path,
    preferred_file_name: Option<&str>,
) -> Result<Arc<DownloadRecord>, String> {
    if let Some(file_name) = preferred_file_name {
        validate_preferred_file_name(file_name)?;
    }
    let download_dir = resolve_download_dir(workspace_root)?;

    let mut registry = downloads()
        .lock()
        .map_err(|_| "browser download registry is unavailable".to_string())?;
    if registry.pending_by_tab.contains_key(&tab_id) {
        return Err(format!(
            "tab {tab_id} already has an active browser download"
        ));
    }
    trim_completed_records(&mut registry)?;

    let download_id = format!(
        "download-{tab_id}-{}-{}",
        now_millis(),
        NEXT_DOWNLOAD_ID.fetch_add(1, Ordering::Relaxed)
    );
    let record = Arc::new(DownloadRecord {
        snapshot: Mutex::new(DownloadSnapshot {
            download_id: download_id.clone(),
            tab_id,
            workspace: workspace_root.to_string_lossy().to_string(),
            status: "armed".to_string(),
            url: None,
            path: None,
            file_name: None,
            size: None,
            error: None,
        }),
        notify: Notify::new(),
        download_dir,
        preferred_file_name: preferred_file_name.map(ToOwned::to_owned),
    });
    registry.pending_by_tab.insert(tab_id, download_id.clone());
    registry.order.push_back(download_id.clone());
    registry.by_id.insert(download_id, Arc::clone(&record));
    Ok(record)
}

/// Called by the native webview download hook. Manual downloads are allowed
/// unchanged; only a download explicitly armed through MCP gets redirected to
/// the workspace-scoped directory and tracked.
pub fn on_download_requested(tab_id: i64, url: &str, destination: &mut PathBuf) -> bool {
    let selected = {
        let Ok(mut registry) = downloads().lock() else {
            return true;
        };
        let Some(download_id) = registry.pending_by_tab.get(&tab_id).cloned() else {
            return true;
        };
        let Some(record) = registry.by_id.get(&download_id).cloned() else {
            return true;
        };
        let file_name = record
            .preferred_file_name
            .clone()
            .unwrap_or_else(|| safe_default_file_name(destination));
        let selected = unique_destination(
            &record.download_dir,
            &file_name,
            &registry.reserved_destinations,
        );
        registry
            .reserved_destinations
            .insert(download_id, selected.clone());
        (record, selected)
    };
    let (record, selected) = selected;
    if selected.as_os_str().is_empty() {
        return true;
    }
    *destination = selected.clone();
    if let Ok(mut snapshot) = record.snapshot.lock() {
        snapshot.status = "downloading".to_string();
        snapshot.url = Some(bounded_source_url(url));
        snapshot.path = Some(selected.to_string_lossy().to_string());
        snapshot.file_name = selected
            .file_name()
            .map(|name| name.to_string_lossy().to_string());
        snapshot.error = None;
    }
    record.notify.notify_waiters();
    true
}

pub fn on_download_finished(tab_id: i64, url: &str, path: Option<PathBuf>, success: bool) {
    let record = {
        let Ok(mut registry) = downloads().lock() else {
            return;
        };
        let Some(id) = registry.pending_by_tab.remove(&tab_id) else {
            return;
        };
        registry.reserved_destinations.remove(&id);
        registry.by_id.get(&id).cloned()
    };
    let Some(record) = record else {
        return;
    };
    if let Ok(mut snapshot) = record.snapshot.lock() {
        snapshot.url = Some(bounded_source_url(url));
        if let Some(path) = path {
            snapshot.path = Some(path.to_string_lossy().to_string());
            snapshot.file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string());
            snapshot.size = std::fs::metadata(&path).ok().map(|metadata| metadata.len());
        }
        snapshot.status = if success { "completed" } else { "failed" }.to_string();
        snapshot.error = (!success).then(|| "native browser download failed".to_string());
    }
    record.notify.notify_waiters();
}

pub fn fail_download(record: &Arc<DownloadRecord>, message: impl Into<String>) {
    let (download_id, tab_id) = match record.snapshot.lock() {
        Ok(mut snapshot) => {
            if is_terminal(&snapshot.status) {
                return;
            }
            snapshot.status = "failed".to_string();
            snapshot.error = Some(message.into());
            (snapshot.download_id.clone(), snapshot.tab_id)
        }
        Err(_) => return,
    };
    if let Ok(mut registry) = downloads().lock() {
        if registry.pending_by_tab.get(&tab_id) == Some(&download_id) {
            registry.pending_by_tab.remove(&tab_id);
        }
        registry.reserved_destinations.remove(&download_id);
    }
    record.notify.notify_waiters();
}

pub fn snapshot(record: &Arc<DownloadRecord>) -> Result<DownloadSnapshot, String> {
    record
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "browser download state is unavailable".to_string())
}

pub fn find_download(
    download_id: &str,
    workspace_root: &Path,
) -> Result<Arc<DownloadRecord>, String> {
    let record = downloads()
        .lock()
        .map_err(|_| "browser download registry is unavailable".to_string())?
        .by_id
        .get(download_id)
        .cloned()
        .ok_or_else(|| format!("browser download '{download_id}' was not found"))?;
    let actual_workspace = record
        .snapshot
        .lock()
        .map_err(|_| "browser download state is unavailable".to_string())?
        .workspace
        .clone();
    if Path::new(&actual_workspace) != workspace_root {
        return Err("browser download belongs to a different workspace".to_string());
    }
    Ok(record)
}

pub async fn wait_for_status_change(
    record: &Arc<DownloadRecord>,
    previous_status: &str,
    timeout: std::time::Duration,
) -> Result<(DownloadSnapshot, bool), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let notified = record.notify.notified();
        let current = snapshot(record)?;
        if current.status != previous_status || is_terminal(&current.status) {
            return Ok((current, false));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() || tokio::time::timeout(remaining, notified).await.is_err() {
            return Ok((snapshot(record)?, true));
        }
    }
}

pub fn remove_tab(tab_id: i64) {
    let record = downloads().lock().ok().and_then(|mut registry| {
        let id = registry.pending_by_tab.remove(&tab_id)?;
        registry.by_id.get(&id).cloned()
    });
    if let Some(record) = record {
        fail_download(&record, "browser tab closed before the download completed");
    }
}

pub fn clear() {
    let records = downloads()
        .lock()
        .map(|mut registry| {
            let records = registry.by_id.values().cloned().collect::<Vec<_>>();
            *registry = DownloadRegistry::default();
            records
        })
        .unwrap_or_default();
    for record in records {
        if let Ok(mut snapshot) = record.snapshot.lock() {
            if !is_terminal(&snapshot.status) {
                snapshot.status = "cancelled".to_string();
                snapshot.error = Some("Anbo browser automation stopped".to_string());
            }
        }
        record.notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_names_cannot_escape_the_download_directory() {
        for invalid in [
            "../secret.txt",
            "dir/file.txt",
            r"dir\file.txt",
            "bad?.txt",
            ".",
            "CON.txt",
            "lpt1.log",
        ] {
            assert!(validate_preferred_file_name(invalid).is_err(), "{invalid}");
        }
        assert!(validate_preferred_file_name("video-final.mp4").is_ok());
    }

    #[test]
    fn default_names_are_sanitized_and_urls_drop_secrets() {
        assert_eq!(
            safe_default_file_name(Path::new(r"C:\Downloads\bad?name.txt")),
            "bad_name.txt"
        );
        assert_eq!(safe_default_file_name(Path::new("NUL.txt")), "_NUL.txt");
        assert_eq!(
            bounded_source_url("https://user:pass@example.com/file?q=secret#token"),
            "https://example.com/file"
        );
    }

    #[tokio::test]
    async fn tracked_download_moves_through_lifecycle() {
        clear();
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let record = arm_download(44, &canonical_root, Some("fixture.txt")).unwrap();
        let mut destination = PathBuf::from("server-name.txt");
        assert!(on_download_requested(
            44,
            "https://example.com/file?token=x",
            &mut destination
        ));
        assert_eq!(
            destination,
            canonical_root.join(".anbo/downloads/fixture.txt")
        );
        assert_eq!(snapshot(&record).unwrap().status, "downloading");
        std::fs::write(&destination, b"ok").unwrap();
        on_download_finished(
            44,
            "https://example.com/file?token=x",
            Some(destination),
            true,
        );
        let done = snapshot(&record).unwrap();
        assert_eq!(done.status, "completed");
        assert_eq!(done.size, Some(2));
        assert_eq!(done.url.as_deref(), Some("https://example.com/file"));
        clear();
    }

    #[test]
    fn download_directory_resolves_inside_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let directory = resolve_download_dir(&canonical_root).unwrap();
        assert!(directory.starts_with(&canonical_root));
        assert!(directory.ends_with(Path::new(".anbo/downloads")));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_download_directory_cannot_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".anbo")).unwrap();
        symlink(outside.path(), root.path().join(".anbo/downloads")).unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        assert!(resolve_download_dir(&canonical_root).is_err());
    }

    #[test]
    fn concurrent_downloads_reserve_collision_free_destinations() {
        clear();
        let root = tempfile::tempdir().unwrap();
        let canonical_root = std::fs::canonicalize(root.path()).unwrap();
        let first = arm_download(51, &canonical_root, Some("video.mp4")).unwrap();
        let second = arm_download(52, &canonical_root, Some("video.mp4")).unwrap();
        let mut first_destination = PathBuf::from("server.mp4");
        let mut second_destination = PathBuf::from("server.mp4");
        assert!(on_download_requested(
            51,
            "https://example.com/first",
            &mut first_destination
        ));
        assert!(on_download_requested(
            52,
            "https://example.com/second",
            &mut second_destination
        ));
        assert_eq!(
            first_destination,
            canonical_root.join(".anbo/downloads/video.mp4")
        );
        assert_eq!(
            second_destination,
            canonical_root.join(".anbo/downloads/video (1).mp4")
        );
        fail_download(&first, "test cleanup");
        fail_download(&second, "test cleanup");
        clear();
    }
}

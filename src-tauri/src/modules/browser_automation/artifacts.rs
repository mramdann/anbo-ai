use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::modules::authority::ensure_unprotected;

const MAX_GROUPS: usize = 64;
const GROUP_IDLE: Duration = Duration::from_secs(600);
static GROUPS: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();

#[derive(Clone, Default)]
pub struct Options {
    pub workspace: Option<String>,
    pub context: Option<String>,
    pub label: Option<String>,
}

impl Options {
    pub fn parse(value: &Value) -> Result<Self, String> {
        fn text(value: &Value, key: &str, limit: usize) -> Result<Option<String>, String> {
            let Some(raw) = value.get(key) else {
                return Ok(None);
            };
            let text = raw
                .as_str()
                .ok_or_else(|| format!("{key} must be text"))?
                .trim();
            if text.is_empty()
                || text.len() > limit
                || text.chars().any(|ch| {
                    ch.is_control()
                        || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
            {
                return Err(format!(
                    "{key} requires 1-{limit} bytes without control characters"
                ));
            }
            Ok(Some(text.into()))
        }
        Ok(Self {
            workspace: text(value, "workspace", 4096)?,
            context: text(value, "context", 120)?,
            label: text(value, "label", 120)?,
        })
    }
}

pub fn source(url: &str) -> (String, Option<String>) {
    if url.len() > 8192 {
        return ("browser".into(), None);
    }
    let Ok(url) = url::Url::parse(url) else {
        return ("browser".into(), None);
    };
    if !matches!(url.scheme(), "http" | "https") {
        return ("local-page".into(), None);
    }
    let host = url.host_str().unwrap_or("browser");
    (
        host.to_ascii_lowercase(),
        Some(url.origin().ascii_serialization()),
    )
}

fn slug(text: &str, fallback: &str) -> String {
    let mut result = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch.to_ascii_lowercase());
        } else if !result.is_empty() && !result.ends_with('-') {
            result.push('-');
        }
        if result.len() >= 48 {
            break;
        }
    }
    let result = result.trim_end_matches('-');
    if result.is_empty() {
        fallback.into()
    } else {
        result.into()
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

pub fn prepare(actual: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let root = fs::canonicalize(actual).map_err(|_| "tab workspace is unavailable")?;
    ensure_unprotected(&root)?;
    if super::output_path::display(&root) != super::output_path::display(actual) {
        return Err("tab workspace was redirected; reopen the tab before capture".into());
    }
    if let Some(requested) = requested {
        let selected =
            fs::canonicalize(requested).map_err(|_| "requested workspace is unavailable")?;
        if selected != root {
            return Err("screenshot workspace must match the tab's workspace".into());
        }
    }
    directory(&root, None)?;
    Ok(root)
}

fn directory(root: &Path, group: Option<&str>) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in [Some(".anbo"), Some("artifacts"), Some("browser"), group]
        .into_iter()
        .flatten()
    {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) || !meta.is_dir() => {
                return Err("artifact directories must not be symlinks, junctions or files".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .or_else(|error| {
                        if error.kind() == std::io::ErrorKind::AlreadyExists {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    })
                    .map_err(|error| format!("create artifact directory: {error}"))?;
            }
            Err(error) => return Err(format!("inspect artifact directory: {error}")),
        }
        let meta = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if is_link(&meta) || !meta.is_dir() {
            return Err("artifact directory was redirected".into());
        }
        let canonical = fs::canonicalize(&current).map_err(|error| error.to_string())?;
        ensure_unprotected(&canonical)?;
        if !canonical.starts_with(root) {
            return Err("artifact directory escapes the workspace".into());
        }
        current = canonical;
    }
    Ok(current)
}

struct Entry {
    root: PathBuf,
    control: u64,
    context: String,
    touched: Instant,
    group: Arc<Mutex<Group>>,
}

struct Group {
    name: String,
    context: String,
    next: u64,
    manifest: File,
    manifest_bytes: u64,
    failed: bool,
}

fn fresh_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options.open(path)
}

fn group(
    root: &Path,
    control: u64,
    context: &str,
    timestamp: u64,
) -> Result<Arc<Mutex<Group>>, String> {
    let mut groups = GROUPS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "artifact groups unavailable")?;
    groups.retain(|entry| {
        entry.touched.elapsed() < GROUP_IDLE
            && entry
                .group
                .try_lock()
                .map(|group| !group.failed)
                .unwrap_or(true)
    });
    if let Some(entry) = groups
        .iter_mut()
        .find(|entry| entry.root == root && entry.control == control && entry.context == context)
    {
        entry.touched = Instant::now();
        return Ok(entry.group.clone());
    }
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|_| "cannot allocate artifact group ID")?;
    let id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let stamp = super::design::stamp(timestamp / 1000);
    let name = format!(
        "{}-{}-{}_{}_{id}",
        &stamp[..4],
        &stamp[4..6],
        &stamp[6..8],
        slug(context, "task")
    );
    let parent = directory(root, None)?;
    let path = parent.join(&name);
    fs::create_dir(&path).map_err(|error| format!("reserve artifact group: {error}"))?;
    directory(root, Some(&name))?;
    let manifest = fresh_file(&path.join("manifest.jsonl"))
        .map_err(|error| format!("reserve artifact manifest: {error}"))?;
    let group = Arc::new(Mutex::new(Group {
        name,
        context: context.into(),
        next: 1,
        manifest,
        manifest_bytes: 0,
        failed: false,
    }));
    if groups.len() >= MAX_GROUPS {
        let oldest = groups
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.touched)
            .map(|(index, _)| index)
            .unwrap_or(0);
        groups.remove(oldest);
    }
    groups.push(Entry {
        root: root.into(),
        control,
        context: context.into(),
        touched: Instant::now(),
        group: group.clone(),
    });
    Ok(group)
}

pub struct Capture {
    pub root: PathBuf,
    pub control: u64,
    pub options: Options,
    pub fallback: String,
    pub origin: Option<String>,
    pub timestamp: u64,
    pub tab_id: i64,
    pub actor: Value,
    pub extension: &'static str,
    pub format: &'static str,
}

pub fn save(capture: Capture, bytes: &[u8]) -> Result<Value, String> {
    if !matches!(capture.extension, "png" | "jpg" | "webp") {
        return Err("unsupported artifact image extension".into());
    }
    let context = capture
        .options
        .context
        .as_deref()
        .unwrap_or(&capture.fallback);
    let group = group(&capture.root, capture.control, context, capture.timestamp)?;
    let mut group = group.lock().map_err(|_| "artifact group unavailable")?;
    let directory = directory(&capture.root, Some(&group.name))?;
    let manifest_path = directory.join("manifest.jsonl");
    let meta = fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("inspect manifest: {error}"))?;
    let held = group
        .manifest
        .metadata()
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let replaced = {
        use std::os::unix::fs::MetadataExt;
        meta.dev() != held.dev() || meta.ino() != held.ino()
    };
    #[cfg(not(unix))]
    let replaced = false;
    if replaced
        || group.failed
        || is_link(&meta)
        || !meta.is_file()
        || meta.len() != group.manifest_bytes
        || held.len() != group.manifest_bytes
    {
        group.failed = true;
        return Err("artifact manifest changed; capture refused, existing files preserved".into());
    }
    let label = capture.options.label.as_deref().unwrap_or("viewport");
    let mut created = None;
    for _ in 0..8 {
        let sequence = group.next;
        group.next = group
            .next
            .checked_add(1)
            .ok_or("artifact sequence exhausted")?;
        let name = format!(
            "{sequence:03}-{}.{}",
            slug(label, "viewport"),
            capture.extension
        );
        let path = directory.join(&name);
        match fresh_file(&path) {
            Ok(file) => {
                created = Some((sequence, name, path, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("reserve screenshot: {error}")),
        }
    }
    let (sequence, name, path, mut file) =
        created.ok_or("artifact filename collisions; no existing files overwritten")?;
    file.write_all(bytes).map_err(|error| {
        format!(
            "write screenshot (partial file may remain at {}): {error}",
            super::output_path::display(&path)
        )
    })?;
    let record = json!({"version":1,"sequence":sequence,"file":name,"context":group.context,"label":label,"capturedAtUnixMs":capture.timestamp,"sourceOrigin":capture.origin,"tabId":capture.tab_id,"actor":capture.actor,"format":capture.format,"size":bytes.len()});
    let mut line = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    line.push(b'\n');
    let metadata_recorded = group.manifest.write_all(&line).is_ok();
    if metadata_recorded {
        group.manifest_bytes += line.len() as u64;
    } else {
        group.failed = true;
    }
    let mut result = json!({"path":super::output_path::display(&path),"groupId":group.name,"context":group.context,"label":label,"sequence":sequence,"manifestPath":super::output_path::display(&manifest_path),"metadataRecorded":metadata_recorded});
    if !metadata_recorded {
        result["warning"] = json!("Screenshot saved; manifest write failed. Keep the returned path, do not recapture automatically.");
    }
    Ok(result)
}

pub fn end_control(control: u64) {
    if let Some(groups) = GROUPS.get() {
        if let Ok(mut groups) = groups.try_lock() {
            groups.retain(|entry| entry.control != control);
        } else {
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(mut groups) = groups.lock() {
                    groups.retain(|entry| entry.control != control);
                }
            });
        }
    }
}

pub fn clear() {
    if let Some(groups) = GROUPS.get() {
        if let Ok(mut groups) = groups.try_lock() {
            groups.clear();
        } else {
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(mut groups) = groups.lock() {
                    groups.clear();
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static CONTROL: AtomicU64 = AtomicU64::new(10000);
    static TEST_GROUPS: Mutex<()> = Mutex::new(());

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        control: u64,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            prepare(&root, None).unwrap();
            Self {
                _temp: temp,
                root,
                control: CONTROL.fetch_add(10, Ordering::Relaxed),
            }
        }
        fn capture(&self, context: Option<&str>, label: Option<&str>) -> Capture {
            Capture {
                root: self.root.clone(),
                control: self.control,
                options: Options {
                    context: context.map(String::from),
                    label: label.map(String::from),
                    workspace: None,
                },
                fallback: "example.test".into(),
                origin: Some("https://example.test".into()),
                timestamp: 1_789_430_400_000,
                tab_id: 1,
                actor: json!({"brand":"codex","label":"Codex"}),
                extension: "png",
                format: "png",
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            end_control(self.control);
            end_control(self.control + 1);
        }
    }
    fn lines(result: &Value) -> Vec<Value> {
        fs::read_to_string(result["manifestPath"].as_str().unwrap())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn artifact_options_and_names_are_bounded_and_cannot_be_paths() {
        for bad in [
            json!({"context":""}),
            json!({"label":"\n"}),
            json!({"context":"a".repeat(121)}),
            json!({"context":false}),
            json!({"workspace":null}),
            json!({"label":"x\u{202e}y"}),
        ] {
            assert!(Options::parse(&bad).is_err());
        }
        assert!(Options::parse(&json!({})).is_ok());
        assert_eq!(
            Options::parse(&json!({"label":" before pause "}))
                .unwrap()
                .label
                .as_deref(),
            Some("before pause")
        );
        for text in [
            "../../escape",
            "C:\\outside",
            "CON",
            "AUX.txt",
            "foo:bar",
            "中文",
            "...",
        ] {
            let normalized = slug(text, "task");
            assert!(!normalized.is_empty());
            assert!(normalized
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
            assert!(normalized.len() <= 48);
        }
    }

    #[test]
    fn artifact_source_never_persists_url_secrets_or_local_paths() {
        let (host, origin) =
            source("https://user:password@example.test/private/token?key=secret#fragment");
        assert_eq!(host, "example.test");
        assert_eq!(origin.as_deref(), Some("https://example.test"));
        for url in [
            "file:///C:/private/file.html",
            "data:text/html,secret",
            "not a url",
        ] {
            assert!(source(url).1.is_none());
            assert!(!source(url).0.contains("private"));
        }
    }

    #[test]
    fn artifact_workspace_mismatch_and_protected_roots_fail_before_creation() {
        let tab = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let actual = fs::canonicalize(tab.path()).unwrap();
        assert!(prepare(&actual, outside.path().to_str()).is_err());
        assert!(!outside.path().join(".anbo").exists());
        assert!(!actual.join(".anbo").exists());
        let protected = actual.join(".ssh");
        fs::create_dir(&protected).unwrap();
        assert!(prepare(&protected, None).is_err());
        assert!(!protected.join(".anbo").exists());
    }

    #[test]
    fn artifact_linked_directory_is_rejected_before_writing_outside() {
        for component in [".anbo", ".anbo/artifacts", ".anbo/artifacts/browser"] {
            let tab = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let actual = fs::canonicalize(tab.path()).unwrap();
            let link = actual.join(component);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(outside.path(), &link).unwrap();
            assert!(prepare(&actual, None).is_err());
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn artifact_group_reuses_context_and_numbers_images_without_overwrite() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let first = save(
            fixture.capture(Some("YouTube playback"), Some("before pause")),
            b"one",
        )
        .unwrap();
        let first_path = Path::new(first["path"].as_str().unwrap());
        assert_eq!(first_path.file_name().unwrap(), "001-before-pause.png");
        assert!(first["groupId"]
            .as_str()
            .unwrap()
            .contains("_youtube-playback_"));
        fs::write(
            first_path.parent().unwrap().join("002-after-pause.png"),
            b"user file",
        )
        .unwrap();
        let second = save(
            fixture.capture(Some("YouTube playback"), Some("after pause")),
            b"two",
        )
        .unwrap();
        assert_eq!(second["groupId"], first["groupId"]);
        assert_eq!(second["sequence"], 3);
        assert_eq!(fs::read(first_path).unwrap(), b"one");
        assert_eq!(
            fs::read(first_path.parent().unwrap().join("002-after-pause.png")).unwrap(),
            b"user file"
        );
        let records = lines(&second);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["label"], "after pause");
        assert_eq!(records[0]["sourceOrigin"], "https://example.test");
    }

    #[test]
    fn artifact_groups_separate_tasks_callers_and_workspaces() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let first = save(fixture.capture(Some("test"), None), b"x").unwrap();
        let different = save(fixture.capture(Some("other"), None), b"x").unwrap();
        let mut foreign = fixture.capture(Some("test"), None);
        foreign.control += 1;
        let foreign = save(foreign, b"x").unwrap();
        let workspace = Fixture::new();
        let elsewhere = save(workspace.capture(Some("test"), None), b"x").unwrap();
        for next in [different, foreign, elsewhere] {
            assert_ne!(next["groupId"], first["groupId"]);
        }
        let fallback = save(fixture.capture(None, None), b"x").unwrap();
        assert_eq!(fallback["context"], "example.test");
    }

    #[test]
    fn artifact_session_end_starts_a_new_run_and_preserves_old_files() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let first = save(fixture.capture(Some("test"), None), b"x").unwrap();
        end_control(fixture.control);
        let next = save(fixture.capture(Some("test"), None), b"y").unwrap();
        assert_ne!(first["groupId"], next["groupId"]);
        assert!(Path::new(first["path"].as_str().unwrap()).is_file());
        assert_eq!(lines(&first).len(), 1);
    }

    #[test]
    fn artifact_concurrent_tabs_share_a_valid_append_only_manifest() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let captures: Vec<_> = (0..12)
            .map(|tab| {
                let mut capture = fixture.capture(Some("parallel"), None);
                capture.tab_id = tab;
                capture
            })
            .collect();
        let handles: Vec<_> = captures
            .into_iter()
            .map(|capture| std::thread::spawn(move || save(capture, b"image").unwrap()))
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(results
            .iter()
            .all(|result| result["groupId"] == results[0]["groupId"]));
        let sequences: std::collections::HashSet<_> = results
            .iter()
            .map(|result| result["sequence"].as_u64().unwrap())
            .collect();
        assert_eq!(sequences.len(), 12);
        assert_eq!(lines(&results[0]).len(), 12);
    }

    #[test]
    fn artifact_registry_is_bounded_without_deleting_evicted_images() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let first = save(fixture.capture(Some("first"), None), b"x").unwrap();
        for i in 0..MAX_GROUPS + 2 {
            save(fixture.capture(Some(&format!("task-{i}")), None), b"x").unwrap();
        }
        assert!(GROUPS.get().unwrap().lock().unwrap().len() <= MAX_GROUPS);
        assert!(Path::new(first["path"].as_str().unwrap()).is_file());
    }

    #[test]
    fn artifact_idle_expiry_keeps_old_flat_and_grouped_files() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let legacy = fixture.root.join(".anbo/artifacts/screenshot_1_100.png");
        fs::write(&legacy, b"legacy image").unwrap();
        let first = save(fixture.capture(Some("test"), None), b"first").unwrap();
        {
            let mut groups = GROUPS.get().unwrap().lock().unwrap();
            let entry = groups
                .iter_mut()
                .find(|entry| entry.control == fixture.control)
                .unwrap();
            entry.touched = Instant::now() - GROUP_IDLE;
        }
        let next = save(fixture.capture(Some("test"), None), b"next").unwrap();
        assert_ne!(first["groupId"], next["groupId"]);
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy image");
        assert_eq!(fs::read(first["path"].as_str().unwrap()).unwrap(), b"first");
        assert_eq!(lines(&first).len(), 1);
    }

    #[test]
    fn artifact_live_manifest_cannot_be_silently_replaced() {
        let _serial = TEST_GROUPS.lock().unwrap();
        let fixture = Fixture::new();
        let first = save(fixture.capture(Some("test"), None), b"first").unwrap();
        let path = Path::new(first["manifestPath"].as_str().unwrap());
        #[cfg(windows)]
        {
            assert!(fs::write(path, b"external edit").is_err());
            assert!(fs::remove_file(path).is_err());
            let next = save(fixture.capture(Some("test"), None), b"next").unwrap();
            assert_eq!(next["groupId"], first["groupId"]);
            assert_eq!(lines(&next).len(), 2);
        }
        #[cfg(unix)]
        {
            fs::remove_file(path).unwrap();
            fs::write(path, b"external edit").unwrap();
            assert!(save(fixture.capture(Some("test"), None), b"refused").is_err());
            assert_eq!(fs::read(path).unwrap(), b"external edit");
            let next = save(fixture.capture(Some("test"), None), b"next").unwrap();
            assert_ne!(next["groupId"], first["groupId"]);
        }
        assert_eq!(fs::read(first["path"].as_str().unwrap()).unwrap(), b"first");
    }
}

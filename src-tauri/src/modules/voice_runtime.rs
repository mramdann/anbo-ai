use crate::modules::proc;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

const PROGRESS_EVENT: &str = "anbo:whisper-runtime-progress";
const RUNTIME_VERSION: &str = "b4938";
const ARCHIVE_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip";
const ARCHIVE_BYTES: u64 = 8_361_840;
const ARCHIVE_SHA256: &str = "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d";
const SERVER_SHA256: &str = "9eb6ee297215f07ba77a6d588a6a2715f2235f665528529c377b775bbab3cd2d";
const DOWNLOAD_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 128;
const MAX_ARCHIVE_BYTES: u64 = 96 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ModelSpec {
    id: &'static str,
    label: &'static str,
    file: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODELS: [ModelSpec; 3] = [
    ModelSpec {
        id: "tiny",
        label: "Tiny multilingual",
        file: "ggml-tiny.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    ModelSpec {
        id: "base",
        label: "Base multilingual",
        file: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelSpec {
        id: "small",
        label: "Small multilingual",
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperInstallProgress {
    phase: String,
    model: String,
    downloaded: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperRuntimeStatus {
    supported: bool,
    phase: String,
    installed: bool,
    running: bool,
    installing: bool,
    model: Option<String>,
    installed_models: Vec<String>,
    base_url: Option<String>,
    pid: Option<u32>,
    install_dir: String,
    size_bytes: u64,
    progress: Option<WhisperInstallProgress>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    runtime_version: String,
    server_sha256: String,
    installed_models: Vec<String>,
}

struct RunningRuntime {
    child: Arc<proc::ManagedChild>,
    port: u16,
    model: String,
}

struct WhisperRuntimeInner {
    lifecycle: tokio::sync::Mutex<()>,
    process: Mutex<Option<RunningRuntime>>,
    progress: Mutex<Option<WhisperInstallProgress>>,
    last_error: Mutex<Option<String>>,
    installing: AtomicBool,
    cancel_install: AtomicBool,
}

impl Default for WhisperRuntimeInner {
    fn default() -> Self {
        Self {
            lifecycle: tokio::sync::Mutex::new(()),
            process: Mutex::new(None),
            progress: Mutex::new(None),
            last_error: Mutex::new(None),
            installing: AtomicBool::new(false),
            cancel_install: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Default)]
pub struct WhisperRuntimeState {
    inner: Arc<WhisperRuntimeInner>,
}

struct InstallGuard {
    inner: Arc<WhisperRuntimeInner>,
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        self.inner.installing.store(false, Ordering::Release);
        *self
            .inner
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

fn runtime_supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

fn runtime_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("Anbo").join("whisper.cpp"))
        .ok_or_else(|| "could not resolve the local application data directory".to_string())
}

fn model_spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("unsupported Whisper model: {id}"))
}

fn server_path(root: &Path) -> PathBuf {
    root.join("Release").join("whisper-server.exe")
}

fn model_path(root: &Path, model: &ModelSpec) -> PathBuf {
    root.join("models").join(model.file)
}

fn file_has_size(path: &Path, expected: u64) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() == expected)
        .unwrap_or(false)
}

fn installed_models(root: &Path) -> Vec<String> {
    MODELS
        .iter()
        .filter(|model| file_has_size(&model_path(root, model), model.bytes))
        .map(|model| model.id.to_string())
        .collect()
}

fn directory_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn clear_finished_process(inner: &WhisperRuntimeInner) {
    let mut process = inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let finished = process
        .as_ref()
        .and_then(|running| running.child.try_wait().ok().flatten());
    if let Some(status) = finished {
        if !status.success() {
            *inner
                .last_error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                Some(format!("Whisper server exited with {status}"));
        }
        *process = None;
    }
}

fn status_from_inner(inner: &WhisperRuntimeInner) -> Result<WhisperRuntimeStatus, String> {
    let root = runtime_root()?;
    clear_finished_process(inner);
    let installed_models = installed_models(&root);
    let server_installed = server_path(&root).is_file();
    let installing = inner.installing.load(Ordering::Acquire);
    let process = inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let running = process.is_some();
    let installed = server_installed && !installed_models.is_empty();
    let phase = if installing {
        "installing"
    } else if running {
        "running"
    } else if installed {
        "stopped"
    } else {
        "notInstalled"
    };
    Ok(WhisperRuntimeStatus {
        supported: runtime_supported(),
        phase: phase.to_string(),
        installed,
        running,
        installing,
        model: process.as_ref().map(|running| running.model.clone()),
        installed_models,
        base_url: process
            .as_ref()
            .map(|running| format!("http://127.0.0.1:{}", running.port)),
        pid: process.as_ref().map(|running| running.child.id()),
        install_dir: root.to_string_lossy().into_owned(),
        size_bytes: directory_size(&root),
        progress: inner
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone(),
        error: inner
            .last_error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone(),
    })
}

fn set_error(inner: &WhisperRuntimeInner, error: Option<String>) {
    *inner
        .last_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
}

fn emit_progress(
    app: &AppHandle,
    inner: &WhisperRuntimeInner,
    phase: &str,
    model: &str,
    downloaded: u64,
    total: u64,
) {
    let progress = WhisperInstallProgress {
        phase: phase.to_string(),
        model: model.to_string(),
        downloaded,
        total,
    };
    *inner
        .progress
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(progress.clone());
    let _ = app.emit(PROGRESS_EVENT, progress);
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut reader = io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn file_is_valid(path: PathBuf, bytes: u64, hash: &'static str) -> bool {
    if !file_has_size(&path, bytes) {
        return false;
    }
    tokio::task::spawn_blocking(move || hash_file(&path).is_ok_and(|actual| actual == hash))
        .await
        .unwrap_or(false)
}

async fn server_is_valid(root: &Path) -> bool {
    let path = server_path(root);
    let Ok(metadata) = fs::metadata(&path) else {
        return false;
    };
    let bytes = metadata.len();
    tokio::task::spawn_blocking(move || {
        hash_file(&path).is_ok_and(|actual| actual == SERVER_SHA256)
    })
    .await
    .unwrap_or(false)
        && bytes > 0
}

struct DownloadRequest<'a> {
    url: &'a str,
    destination: &'a Path,
    expected_bytes: u64,
    expected_hash: &'a str,
    phase: &'a str,
    model: &'a str,
    offset: u64,
    total: u64,
}

async fn download_file(
    app: &AppHandle,
    inner: &WhisperRuntimeInner,
    request: DownloadRequest<'_>,
) -> Result<(), String> {
    let DownloadRequest {
        url,
        destination,
        expected_bytes,
        expected_hash,
        phase,
        model,
        offset,
        total,
    } = request;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("create download client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download {phase}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download {phase} failed with {}",
            response.status()
        ));
    }
    if let Some(length) = response.content_length() {
        if length != expected_bytes {
            return Err(format!(
                "download {phase} reported an unexpected size: {length}"
            ));
        }
    }
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("create {}: {error}", destination.display()))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now();
    emit_progress(app, inner, phase, model, offset, total);
    while let Some(chunk) = stream.next().await {
        if inner.cancel_install.load(Ordering::Acquire) {
            return Err("Whisper installation was cancelled".to_string());
        }
        let chunk = chunk.map_err(|error| format!("download {phase}: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > expected_bytes {
            return Err(format!("download {phase} exceeded its expected size"));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("write {}: {error}", destination.display()))?;
        hasher.update(&chunk);
        if last_emit.elapsed() >= Duration::from_millis(150) || downloaded == expected_bytes {
            emit_progress(app, inner, phase, model, offset + downloaded, total);
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("flush {}: {error}", destination.display()))?;
    drop(file);
    if downloaded != expected_bytes {
        return Err(format!(
            "download {phase} was incomplete: {downloaded} of {expected_bytes} bytes"
        ));
    }
    let actual_hash = format!("{:x}", hasher.finalize());
    if actual_hash != expected_hash {
        return Err(format!("download {phase} failed integrity verification"));
    }
    Ok(())
}

fn release_entry_destination(staging: &Path, entry: &Path) -> Result<PathBuf, String> {
    if entry.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Whisper archive contains an unsafe path".to_string());
    }
    if !entry.starts_with("Release") {
        return Err("Whisper archive contains an unexpected entry".to_string());
    }
    Ok(staging.join(entry))
}

fn extract_release_archive(archive_path: &Path, staging: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("open {}: {error}", archive_path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("read Whisper archive: {error}"))?;
    if archive.len() > MAX_ARCHIVE_FILES {
        return Err("Whisper archive contains too many files".to_string());
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read Whisper archive entry: {error}"))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Whisper archive contains a symbolic link".to_string());
        }
        extracted_bytes = extracted_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Whisper archive size overflow".to_string())?;
        if extracted_bytes > MAX_ARCHIVE_BYTES {
            return Err("Whisper archive expands beyond the allowed size".to_string());
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Whisper archive contains an unsafe path".to_string())?;
        let destination = release_entry_destination(staging, &enclosed)?;
        if entry.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("create {}: {error}", destination.display()))?;
            continue;
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "Whisper archive entry has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
        let mut output = File::create(&destination)
            .map_err(|error| format!("create {}: {error}", destination.display()))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("extract {}: {error}", destination.display()))?;
        output
            .flush()
            .map_err(|error| format!("flush {}: {error}", destination.display()))?;
    }
    Ok(())
}

fn refuse_symlink(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refusing symbolic link: {}", path.display()));
    }
    Ok(())
}

fn remove_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    refuse_symlink(path)?;
    fs::remove_dir_all(path).map_err(|error| format!("remove {}: {error}", path.display()))
}

fn replace_directory(source: &Path, destination: &Path) -> Result<(), String> {
    remove_directory(destination)?;
    fs::rename(source, destination).map_err(|error| {
        format!(
            "move {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        let metadata = fs::symlink_metadata(destination)
            .map_err(|error| format!("inspect {}: {error}", destination.display()))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "refusing unexpected path: {}",
                destination.display()
            ));
        }
        fs::remove_file(destination)
            .map_err(|error| format!("remove {}: {error}", destination.display()))?;
    }
    fs::rename(source, destination).map_err(|error| {
        format!(
            "move {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn write_manifest(root: &Path) -> Result<(), String> {
    let manifest = RuntimeManifest {
        runtime_version: RUNTIME_VERSION.to_string(),
        server_sha256: SERVER_SHA256.to_string(),
        installed_models: installed_models(root),
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("serialize Whisper manifest: {error}"))?;
    let destination = root.join(".anbo-runtime.json");
    let temporary = root.join(".anbo-runtime.json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write {}: {error}", temporary.display()))?;
    replace_file(&temporary, &destination)
}

#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available = 0_u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "read free space for {}: {}",
            path.display(),
            io::Error::last_os_error()
        ));
    }
    Ok(available)
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

async fn install_runtime(
    app: &AppHandle,
    state: &WhisperRuntimeState,
    model: &ModelSpec,
) -> Result<(), String> {
    if !runtime_supported() {
        return Err("Managed Whisper installation currently supports Windows x64".to_string());
    }
    if state.inner.cancel_install.load(Ordering::Acquire) {
        return Err("Whisper installation was cancelled".to_string());
    }
    clear_finished_process(&state.inner);
    if state
        .inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .is_some()
    {
        return Err("Stop the Whisper server before changing its installation".to_string());
    }
    let root = runtime_root()?;
    refuse_symlink(&root)?;
    let parent = root
        .parent()
        .ok_or_else(|| "Whisper installation path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    let server_valid = server_is_valid(&root).await;
    let model_destination = model_path(&root, model);
    let model_valid = file_is_valid(model_destination.clone(), model.bytes, model.sha256).await;
    let required_download =
        (if server_valid { 0 } else { ARCHIVE_BYTES }) + if model_valid { 0 } else { model.bytes };
    if required_download > 0 {
        let free = available_space(parent)?;
        let required = required_download.saturating_add(DOWNLOAD_HEADROOM_BYTES);
        if free < required {
            return Err(format!(
                "Not enough free disk space. Need at least {} MB free",
                required.div_ceil(1024 * 1024)
            ));
        }
    }
    let total = required_download.max(1);
    let mut offset = 0_u64;
    fs::create_dir_all(&root).map_err(|error| format!("create {}: {error}", root.display()))?;

    if !server_valid {
        let archive_path = root.join(".whisper-bin.zip.part");
        let staging = root.join(".release-install");
        let _ = fs::remove_file(&archive_path);
        remove_directory(&staging)?;
        let download = download_file(
            app,
            &state.inner,
            DownloadRequest {
                url: ARCHIVE_URL,
                destination: &archive_path,
                expected_bytes: ARCHIVE_BYTES,
                expected_hash: ARCHIVE_SHA256,
                phase: "runtime",
                model: model.id,
                offset,
                total,
            },
        )
        .await;
        if let Err(error) = download {
            let _ = fs::remove_file(&archive_path);
            return Err(error);
        }
        offset += ARCHIVE_BYTES;
        let archive_for_extract = archive_path.clone();
        let staging_for_extract = staging.clone();
        tokio::task::spawn_blocking(move || {
            extract_release_archive(&archive_for_extract, &staging_for_extract)
        })
        .await
        .map_err(|error| format!("extract Whisper runtime task: {error}"))??;
        let staged_server = server_path(&staging);
        if hash_file(&staged_server)? != SERVER_SHA256 {
            remove_directory(&staging)?;
            let _ = fs::remove_file(&archive_path);
            return Err("Whisper server failed integrity verification".to_string());
        }
        replace_directory(&staging.join("Release"), &root.join("Release"))?;
        remove_directory(&staging)?;
        let _ = fs::remove_file(&archive_path);
    }

    if !model_valid {
        let model_dir = root.join("models");
        fs::create_dir_all(&model_dir)
            .map_err(|error| format!("create {}: {error}", model_dir.display()))?;
        let temporary = model_dir.join(format!(".{}.part", model.file));
        let _ = fs::remove_file(&temporary);
        let download = download_file(
            app,
            &state.inner,
            DownloadRequest {
                url: model.url,
                destination: &temporary,
                expected_bytes: model.bytes,
                expected_hash: model.sha256,
                phase: "model",
                model: model.id,
                offset,
                total,
            },
        )
        .await;
        if let Err(error) = download {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        replace_file(&temporary, &model_destination)?;
    }
    emit_progress(app, &state.inner, "finalizing", model.id, total, total);
    write_manifest(&root)
}

fn choose_port() -> Result<u16, String> {
    for port in 8080..=8090 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err("No free local port is available between 8080 and 8090".to_string())
}

fn stop_runtime(inner: &WhisperRuntimeInner) {
    let process = inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(running) = process {
        running.child.kill_tree();
        let _ = running.child.wait();
    }
}

#[tauri::command]
pub fn whisper_runtime_status(
    state: State<'_, WhisperRuntimeState>,
) -> Result<WhisperRuntimeStatus, String> {
    status_from_inner(&state.inner)
}

#[tauri::command]
pub async fn whisper_runtime_install(
    app: AppHandle,
    state: State<'_, WhisperRuntimeState>,
    model: String,
) -> Result<WhisperRuntimeStatus, String> {
    let model = model_spec(&model)?;
    if state
        .inner
        .installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Whisper installation is already running".to_string());
    }
    state.inner.cancel_install.store(false, Ordering::Release);
    let _lifecycle = state.inner.lifecycle.lock().await;
    set_error(&state.inner, None);
    let guard = InstallGuard {
        inner: state.inner.clone(),
    };
    let result = install_runtime(&app, &state, model).await;
    drop(guard);
    if let Err(error) = result {
        if error == "Whisper installation was cancelled" {
            set_error(&state.inner, None);
        } else {
            set_error(&state.inner, Some(error.clone()));
        }
        return Err(error);
    }
    set_error(&state.inner, None);
    status_from_inner(&state.inner)
}

#[tauri::command]
pub fn whisper_runtime_cancel_install(state: State<'_, WhisperRuntimeState>) -> bool {
    if !state.inner.installing.load(Ordering::Acquire) {
        return false;
    }
    state.inner.cancel_install.store(true, Ordering::Release);
    true
}

#[tauri::command]
pub async fn whisper_runtime_start(
    state: State<'_, WhisperRuntimeState>,
    model: String,
) -> Result<WhisperRuntimeStatus, String> {
    let _lifecycle = state.inner.lifecycle.lock().await;
    if !runtime_supported() {
        return Err("Managed Whisper runtime currently supports Windows x64".to_string());
    }
    let model = *model_spec(&model)?;
    if state.inner.installing.load(Ordering::Acquire) {
        return Err("Wait for the Whisper installation to finish".to_string());
    }
    clear_finished_process(&state.inner);
    let current_model = state
        .inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|running| running.model.clone());
    if current_model.as_deref() == Some(model.id) {
        return status_from_inner(&state.inner);
    }
    let root = runtime_root()?;
    if !server_is_valid(&root).await {
        return Err("Whisper runtime is missing or failed integrity verification".to_string());
    }
    if !file_is_valid(model_path(&root, &model), model.bytes, model.sha256).await {
        return Err(format!("{} is not installed or is invalid", model.label));
    }
    if current_model.is_some() {
        stop_runtime(&state.inner);
    }
    write_manifest(&root)?;
    let port = choose_port()?;
    let stdout = File::create(root.join("server.stdout.log"))
        .map_err(|error| format!("create Whisper stdout log: {error}"))?;
    let stderr = File::create(root.join("server.stderr.log"))
        .map_err(|error| format!("create Whisper stderr log: {error}"))?;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get().clamp(1, 4))
        .unwrap_or(1);
    let server = server_path(&root);
    let selected_model = model_path(&root, &model);
    let mut command = Command::new(&server);
    command
        .current_dir(root.join("Release"))
        .args([
            "-m",
            &selected_model.to_string_lossy(),
            "-l",
            "auto",
            "-t",
            &threads.to_string(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--no-gpu",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    proc::hide_console(&mut command);
    let child = proc::ManagedChild::spawn(&mut command)
        .map_err(|error| format!("start Whisper server: {error}"))?;
    let pid = child.id();
    *state
        .inner
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(RunningRuntime {
        child: child.clone(),
        port,
        model: model.id.to_string(),
    });
    let address = format!("127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("inspect Whisper server: {error}"))?
            .is_some()
        {
            stop_runtime(&state.inner);
            let log = fs::read_to_string(root.join("server.stderr.log")).unwrap_or_default();
            let tail = log
                .lines()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" ");
            let error = if tail.is_empty() {
                "Whisper server exited during startup".to_string()
            } else {
                format!("Whisper server exited during startup: {tail}")
            };
            set_error(&state.inner, Some(error.clone()));
            return Err(error);
        }
        if tokio::net::TcpStream::connect(&address).await.is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            stop_runtime(&state.inner);
            let error = "Whisper server did not become ready within 20 seconds".to_string();
            set_error(&state.inner, Some(error.clone()));
            return Err(error);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    set_error(&state.inner, None);
    log::info!("started managed Whisper server pid={pid} port={port}");
    status_from_inner(&state.inner)
}

#[tauri::command]
pub async fn whisper_runtime_stop(
    state: State<'_, WhisperRuntimeState>,
) -> Result<WhisperRuntimeStatus, String> {
    let _lifecycle = state.inner.lifecycle.lock().await;
    stop_runtime(&state.inner);
    set_error(&state.inner, None);
    status_from_inner(&state.inner)
}

#[tauri::command]
pub async fn whisper_runtime_uninstall(
    state: State<'_, WhisperRuntimeState>,
) -> Result<WhisperRuntimeStatus, String> {
    let _lifecycle = state.inner.lifecycle.lock().await;
    if state.inner.installing.load(Ordering::Acquire) {
        return Err("Cancel the Whisper installation before uninstalling".to_string());
    }
    stop_runtime(&state.inner);
    let root = runtime_root()?;
    tokio::task::spawn_blocking(move || remove_directory(&root))
        .await
        .map_err(|error| format!("uninstall Whisper task: {error}"))??;
    set_error(&state.inner, None);
    status_from_inner(&state.inner)
}

#[cfg(test)]
mod tests {
    use super::{installed_models, model_spec, release_entry_destination, MODELS};
    use std::fs;
    use std::path::Path;

    #[test]
    fn model_registry_accepts_only_known_multilingual_models() {
        assert_eq!(model_spec("tiny").unwrap().file, "ggml-tiny.bin");
        assert_eq!(model_spec("base").unwrap().file, "ggml-base.bin");
        assert_eq!(model_spec("small").unwrap().file, "ggml-small.bin");
        assert!(model_spec("base.en").is_err());
    }

    #[test]
    fn archive_entries_cannot_escape_the_release_directory() {
        let staging = Path::new("C:/private/runtime-stage");
        assert!(release_entry_destination(staging, Path::new("Release/server.exe")).is_ok());
        assert!(release_entry_destination(staging, Path::new("../server.exe")).is_err());
        assert!(release_entry_destination(staging, Path::new("Other/server.exe")).is_err());
    }

    #[test]
    fn installed_model_discovery_requires_the_exact_file_size() {
        let temp = tempfile::tempdir().unwrap();
        let model_dir = temp.path().join("models");
        fs::create_dir_all(&model_dir).unwrap();
        fs::write(model_dir.join(MODELS[0].file), vec![0_u8; 8]).unwrap();
        assert!(installed_models(temp.path()).is_empty());
    }
}

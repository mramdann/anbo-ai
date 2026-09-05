use crate::modules::proc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROGRESS_EVENT: &str = "anbo:whisper-runtime-progress";
const RUNTIME_DIR: &str = "whisper.cpp";
const RUNTIME_VERSION: &str = "b4938";
const ARCHIVE_BASE: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b4938";
const DOWNLOAD_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 128;

/// whisper.cpp ships one Windows build per compute backend, and the backend is
/// baked into the binaries: the plain build has no GPU code to enable, so the
/// choice is made at download time rather than by a flag at startup.
#[derive(Clone, Copy, PartialEq, Eq)]
struct RuntimeVariant {
    id: &'static str,
    label: &'static str,
    archive: &'static str,
    bytes: u64,
    sha256: &'static str,
    server_sha256: &'static str,
    /// Unpacked size, which the CUDA build takes far past the others because it
    /// carries the CUDA runtime with it.
    max_bytes: u64,
    gpu: bool,
}

const VARIANTS: [RuntimeVariant; 3] = [
    RuntimeVariant {
        id: "cpu",
        label: "CPU",
        archive: "whisper-bin-x64.zip",
        bytes: 8_361_840,
        sha256: "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d",
        server_sha256: "9eb6ee297215f07ba77a6d588a6a2715f2235f665528529c377b775bbab3cd2d",
        max_bytes: 96 * 1024 * 1024,
        gpu: false,
    },
    RuntimeVariant {
        id: "blas",
        label: "CPU with OpenBLAS",
        archive: "whisper-blas-bin-x64.zip",
        bytes: 21_147_582,
        sha256: "78568aa80b361382cb303438a7be3b05669651f2ca8258910394679e049d26ea",
        server_sha256: "5f369c78348c2d4478daa5a89eb38ef6c37ccbc90de0f7bf489921315539c46d",
        max_bytes: 128 * 1024 * 1024,
        gpu: false,
    },
    RuntimeVariant {
        id: "cuda",
        label: "NVIDIA GPU (CUDA 11.8)",
        archive: "whisper-cublas-11.8.0-bin-x64.zip",
        bytes: 269_896_802,
        sha256: "2510ae3fe25af5cd7fed55ff71a97a5b1bcc7ea27e88e98d1d53229761a0857d",
        server_sha256: "be3d33d12181460bacd4058fc7f1471f062cf2b1b60df2d94d2b0a689413d801",
        // 581 MB unpacked, and a release that grows a little must not start
        // failing extraction over it.
        max_bytes: 704 * 1024 * 1024,
        gpu: true,
    },
];

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
    variant: Option<String>,
    variant_label: Option<String>,
    gpu: bool,
    gpu_available: bool,
    recommended_variant: String,
    recommended_model: String,
    machine_cores: usize,
    machine_ram_mb: u64,
    threads: usize,
    progress: Option<WhisperInstallProgress>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    runtime_version: String,
    /// Absent in manifests written before backends existed, which is why the
    /// reader falls back to the server hash it has always recorded.
    #[serde(default)]
    variant: String,
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
    crate::modules::app_data::local_data_root().map(|root| root.join(RUNTIME_DIR))
}

/// Where the runtime used to live. `data_local_dir()/Anbo` is not a data
/// directory at all: the NSIS installer sets `$INSTDIR` to
/// `$LOCALAPPDATA\${PRODUCTNAME}`, and this product is named Anbo, so the
/// server and its models were being written into the app's own install folder.
/// Nothing there survives cleanly: the uninstaller clears only the files it
/// recorded and then calls a non-recursive `RMDir`, so half a gigabyte of
/// models stayed behind and kept the install folder alive with it.
fn legacy_runtime_root() -> Option<PathBuf> {
    dirs::data_local_dir().map(|path| path.join("Anbo").join(RUNTIME_DIR))
}

/// Move a runtime installed by an older build into the data directory. Both
/// paths sit under `%LOCALAPPDATA%`, so this is a rename on one volume rather
/// than half a gigabyte of copying, and a user who already downloaded a model
/// never downloads it again.
pub fn migrate_legacy_runtime() {
    let (Some(legacy), Ok(current)) = (legacy_runtime_root(), runtime_root()) else {
        return;
    };
    match migrate_runtime_dir(&legacy, &current) {
        Ok(true) => log::info!(
            "moved the Whisper runtime out of the install directory into {}",
            current.display()
        ),
        Ok(false) => {}
        Err(error) => log::warn!(
            "could not move the Whisper runtime from {}: {error}",
            legacy.display()
        ),
    }
}

/// Returns whether anything moved. Doing nothing is the common case and is
/// never an error: most installs have no legacy directory at all.
fn migrate_runtime_dir(legacy: &Path, current: &Path) -> Result<bool, String> {
    if legacy == current || !legacy.is_dir() {
        return Ok(false);
    }
    // A runtime already at the new path is the authority. Deleting the old copy
    // here could destroy a model the user is still using, so leave it alone.
    if current.exists() {
        return Err(format!("{} already exists", current.display()));
    }
    if let Some(parent) = current.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    fs::rename(legacy, current).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Threads to hand the transcription server.
///
/// whisper.cpp's own default is four, which leaves most of a modern machine
/// idle while a recording waits. Take more where there is more to take, but
/// always leave two cores for the desktop, and stop at eight: past that the
/// gain flattens while the contention does not. Small machines keep exactly
/// what they had, so nothing gets slower.
fn transcription_threads(cores: usize) -> usize {
    if cores <= 4 {
        cores.max(1)
    } else {
        // Never below the old default either: leaving two cores free would
        // otherwise hand a five core machine fewer threads than a four core
        // one, which is the wrong direction.
        (cores - 2).clamp(4, 8)
    }
}

/// The model worth suggesting on a machine with this much memory.
///
/// Measured resident cost of the server with each model loaded: roughly 0.4 GB
/// for tiny, 0.6 for base, 1.2 for small. Suggesting one the machine cannot
/// hold comfortably trades accuracy for swapping, which is not a trade.
fn recommended_model(total_ram_mb: u64, gpu: bool) -> &'static str {
    // A GPU build keeps the weights in VRAM, so system memory is under less
    // pressure and the middle tier can reach for the better model.
    let generous = gpu && total_ram_mb >= 4 * 1024;
    if total_ram_mb >= 8 * 1024 || generous {
        "small"
    } else if total_ram_mb >= 4 * 1024 {
        "base"
    } else {
        "tiny"
    }
}

/// Physical memory in MB, or 0 when it cannot be read.
#[cfg(windows)]
fn total_ram_mb() -> u64 {
    use windows_sys::Win32::System::SystemInformation::{
        GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return 0;
    }
    status.ullTotalPhys / (1024 * 1024)
}

#[cfg(not(windows))]
fn total_ram_mb() -> u64 {
    0
}

/// Cores and physical memory, read once.
///
/// Neither changes while the app runs, and the status they feed is polled
/// every two seconds by the settings panel. Reading them per poll spends an
/// FFI call to learn something already known.
static MACHINE_FACTS: OnceLock<(usize, u64)> = OnceLock::new();

fn machine_facts() -> (usize, u64) {
    *MACHINE_FACTS.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1);
        (cores, total_ram_mb())
    })
}

fn machine_cores() -> usize {
    machine_facts().0
}

fn variant_spec(id: &str) -> Option<&'static RuntimeVariant> {
    VARIANTS.iter().find(|variant| variant.id == id)
}

fn variant_url(variant: &RuntimeVariant) -> String {
    format!("{ARCHIVE_BASE}/{}", variant.archive)
}

/// Every NVIDIA display driver installs the CUDA driver API next to the system
/// libraries. Its absence is the cheapest honest answer to "is there a GPU we
/// can use", and it costs no process spawn and no extra dependency.
#[cfg(windows)]
fn nvidia_driver_present() -> bool {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Windows"));
    system_root.join("System32").join("nvcuda.dll").is_file()
}

#[cfg(not(windows))]
fn nvidia_driver_present() -> bool {
    false
}

/// The variant an unconfigured machine should get. OpenBLAS rather than the
/// plain build: it is 13 MB more to download and measurably faster on every
/// CPU, so there is no reason to prefer the slower one by default.
fn detected_variant() -> &'static RuntimeVariant {
    let wanted = if nvidia_driver_present() {
        "cuda"
    } else {
        "blas"
    };
    variant_spec(wanted).unwrap_or(&VARIANTS[0])
}

/// Resolve a stored preference. "auto" follows the hardware; anything else is
/// honoured as written so a user can refuse a 270 MB CUDA download, or force it
/// on a machine whose driver we failed to spot.
fn resolve_variant(preference: Option<&str>) -> Result<&'static RuntimeVariant, String> {
    match preference {
        None | Some("") | Some("auto") => Ok(detected_variant()),
        Some(id) => {
            variant_spec(id).ok_or_else(|| format!("unsupported Whisper acceleration: {id}"))
        }
    }
}

/// Which variant is on disk, decided by hashing the installed server rather
/// than by trusting the manifest. A runtime installed before variants existed
/// carries no marker, and re-downloading over a perfectly good install would be
/// the worst possible answer.
async fn installed_variant(root: &Path) -> Option<&'static RuntimeVariant> {
    let path = server_path(root);
    if !path.is_file() {
        return None;
    }
    let hash = tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .ok()?
        .ok()?;
    VARIANTS.iter().find(|variant| variant.server_sha256 == hash)
}

/// The backend an install advertises, read from its manifest. This is for
/// display: it costs a small file read rather than hashing the server on every
/// poll, and the paths that must not be wrong hash it anyway.
fn manifest_variant(root: &Path) -> Option<&'static RuntimeVariant> {
    let raw = fs::read(root.join(".anbo-runtime.json")).ok()?;
    let manifest: RuntimeManifest = serde_json::from_slice(&raw).ok()?;
    variant_spec(&manifest.variant).or_else(|| {
        VARIANTS
            .iter()
            .find(|variant| variant.server_sha256 == manifest.server_sha256)
    })
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

/// Size of the install, cached between the events that can change it.
///
/// Computing it walks every file in the runtime — around fifty stat calls with
/// a model on disk — and the answer only moves when an install or uninstall
/// happens. Doing that on each poll is work spent to learn the same number.
static INSTALL_SIZE: OnceLock<Mutex<Option<u64>>> = OnceLock::new();

fn install_size_cache() -> &'static Mutex<Option<u64>> {
    INSTALL_SIZE.get_or_init(|| Mutex::new(None))
}

fn cached_directory_size(path: &Path) -> u64 {
    if let Ok(cache) = install_size_cache().lock() {
        if let Some(size) = *cache {
            return size;
        }
    }
    let size = directory_size(path);
    if let Ok(mut cache) = install_size_cache().lock() {
        *cache = Some(size);
    }
    size
}

/// Called wherever the runtime directory is written to or removed.
fn forget_install_size() {
    if let Ok(mut cache) = install_size_cache().lock() {
        *cache = None;
    }
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
    let variant = manifest_variant(&root);
    let cores = machine_cores();
    let ram = total_ram_mb();
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
        size_bytes: cached_directory_size(&root),
        variant: variant.map(|found| found.id.to_string()),
        variant_label: variant.map(|found| found.label.to_string()),
        gpu: variant.is_some_and(|found| found.gpu),
        gpu_available: nvidia_driver_present(),
        recommended_variant: detected_variant().id.to_string(),
        // What this machine can hold comfortably, so the dropdown can say so
        // rather than leaving the choice to guesswork.
        recommended_model: recommended_model(ram, detected_variant().gpu).to_string(),
        machine_cores: cores,
        machine_ram_mb: ram,
        threads: transcription_threads(cores),
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

async fn server_is_valid(root: &Path, variant: &RuntimeVariant) -> bool {
    installed_variant(root).await == Some(variant)
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
    // Whatever a previous attempt left behind is worth keeping: losing a
    // connection at 420 MB of 465 should cost the remainder, not the lot.
    let on_disk = tokio::fs::metadata(destination)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    let resume_from = resume_offset(on_disk, expected_bytes);
    let mut builder = client.get(url);
    if resume_from > 0 {
        builder = builder.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("download {phase}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download {phase} failed with {}",
            response.status()
        ));
    }
    // A server free to ignore the range header answers 200 with the whole body,
    // so the resume only counts once it has been acknowledged.
    let resume_from = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        resume_from
    } else {
        0
    };
    if let Some(length) = response.content_length() {
        if length != expected_bytes - resume_from {
            return Err(format!(
                "download {phase} reported an unexpected size: {length}"
            ));
        }
    }
    let mut hasher = Sha256::new();
    let mut file = if resume_from > 0 {
        // The hash covers the whole file, so the kept bytes have to go through
        // it before the new ones do.
        hash_prefix(destination, resume_from, &mut hasher).await?;
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(destination)
            .await
            .map_err(|error| format!("append to {}: {error}", destination.display()))?
    } else {
        tokio::fs::File::create(destination)
            .await
            .map_err(|error| format!("create {}: {error}", destination.display()))?
    };
    let mut stream = response.bytes_stream();
    let mut downloaded = resume_from;
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
        // Bytes that hash wrong are poison for a resume: keeping them would
        // make every later attempt fail the same way.
        let _ = fs::remove_file(destination);
        return Err(format!("download {phase} failed integrity verification"));
    }
    Ok(())
}

/// How many bytes of a previous attempt are worth keeping. A file already at
/// its full length is not a resume candidate: it is either finished or wrong,
/// and both are decided by the hash rather than by another request.
fn resume_offset(on_disk: u64, expected_bytes: u64) -> u64 {
    if on_disk > 0 && on_disk < expected_bytes {
        on_disk
    } else {
        0
    }
}

/// Feed the bytes already on disk through the hash before appending more.
async fn hash_prefix(path: &Path, length: u64, hasher: &mut Sha256) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut remaining = length;
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..want])
            .await
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        hasher.update(&buffer[..want]);
        remaining -= want as u64;
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

fn extract_release_archive(
    archive_path: &Path,
    staging: &Path,
    max_bytes: u64,
) -> Result<(), String> {
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
        if extracted_bytes > max_bytes {
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

fn write_manifest(root: &Path, variant: &RuntimeVariant) -> Result<(), String> {
    let manifest = RuntimeManifest {
        runtime_version: RUNTIME_VERSION.to_string(),
        variant: variant.id.to_string(),
        server_sha256: variant.server_sha256.to_string(),
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
    variant: &'static RuntimeVariant,
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
    // A different backend on disk is not a valid install for this request, so
    // switching backends re-downloads the runtime and leaves the models alone.
    let server_valid = server_is_valid(&root, variant).await;
    let model_destination = model_path(&root, model);
    let model_valid = file_is_valid(model_destination.clone(), model.bytes, model.sha256).await;
    let required_download =
        (if server_valid { 0 } else { variant.bytes }) + if model_valid { 0 } else { model.bytes };
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
        let archive_path = root.join(format!(".whisper-{}.zip.part", variant.id));
        let staging = root.join(".release-install");
        remove_directory(&staging)?;
        let download = download_file(
            app,
            &state.inner,
            DownloadRequest {
                url: &variant_url(variant),
                destination: &archive_path,
                expected_bytes: variant.bytes,
                expected_hash: variant.sha256,
                phase: "runtime",
                model: model.id,
                offset,
                total,
            },
        )
        .await;
        // A partial archive stays put so the next attempt resumes it. Bytes
        // that fail their hash are removed by the download itself.
        download?;
        offset += variant.bytes;
        let archive_for_extract = archive_path.clone();
        let staging_for_extract = staging.clone();
        let max_bytes = variant.max_bytes;
        tokio::task::spawn_blocking(move || {
            extract_release_archive(&archive_for_extract, &staging_for_extract, max_bytes)
        })
        .await
        .map_err(|error| format!("extract Whisper runtime task: {error}"))??;
        let staged_server = server_path(&staging);
        if hash_file(&staged_server)? != variant.server_sha256 {
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
        download?;
        replace_file(&temporary, &model_destination)?;
    }
    emit_progress(app, &state.inner, "finalizing", model.id, total, total);
    // The install just changed what is on disk.
    forget_install_size();
    write_manifest(&root, variant)
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

/// Async so Tauri runs it off the main thread: a synchronous command would
/// put this poll's remaining file reads on the thread that paints the window.
#[tauri::command]
pub async fn whisper_runtime_status(
    state: State<'_, WhisperRuntimeState>,
) -> Result<WhisperRuntimeStatus, String> {
    status_from_inner(&state.inner)
}

#[tauri::command]
pub async fn whisper_runtime_install(
    app: AppHandle,
    state: State<'_, WhisperRuntimeState>,
    model: String,
    acceleration: Option<String>,
) -> Result<WhisperRuntimeStatus, String> {
    let model = model_spec(&model)?;
    let variant = resolve_variant(acceleration.as_deref())?;
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
    let result = install_runtime(&app, &state, model, variant).await;
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
    let Some(variant) = installed_variant(&root).await else {
        return Err("Whisper runtime is missing or failed integrity verification".to_string());
    };
    if !file_is_valid(model_path(&root, &model), model.bytes, model.sha256).await {
        return Err(format!("{} is not installed or is invalid", model.label));
    }
    if current_model.is_some() {
        stop_runtime(&state.inner);
    }
    write_manifest(&root, variant)?;
    let port = choose_port()?;
    let stdout = File::create(root.join("server.stdout.log"))
        .map_err(|error| format!("create Whisper stdout log: {error}"))?;
    let stderr = File::create(root.join("server.stderr.log"))
        .map_err(|error| format!("create Whisper stderr log: {error}"))?;
    let threads = transcription_threads(machine_cores());
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
        ]);
    if !variant.gpu {
        // The CPU builds carry no GPU code at all, so this only silences the
        // attempt; on the CUDA build it would throw the acceleration away.
        command.arg("--no-gpu");
    }
    command
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
    log::info!(
        "started managed Whisper server pid={pid} port={port} backend={}",
        variant.id
    );
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
    forget_install_size();
    set_error(&state.inner, None);
    status_from_inner(&state.inner)
}

#[cfg(test)]
mod tests {
    use super::{
        detected_variant, hash_prefix, installed_models, manifest_variant, migrate_runtime_dir,
        model_spec, recommended_model, release_entry_destination, resolve_variant, resume_offset,
        transcription_threads, variant_spec, MODELS, VARIANTS,
    };
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;

    #[test]
    fn an_interrupted_download_resumes_from_what_it_already_wrote() {
        assert_eq!(resume_offset(420_000_000, 487_601_967), 420_000_000);
    }

    #[test]
    fn a_complete_or_oversized_file_is_never_resumed() {
        // Both are settled by the hash, not by asking for more bytes.
        assert_eq!(resume_offset(487_601_967, 487_601_967), 0);
        assert_eq!(resume_offset(500_000_000, 487_601_967), 0);
        assert_eq!(resume_offset(0, 487_601_967), 0);
    }

    #[tokio::test]
    async fn resuming_hashes_the_kept_bytes_before_the_new_ones() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("partial.bin");
        fs::write(&path, b"first half").unwrap();

        let mut resumed = Sha256::new();
        hash_prefix(&path, 10, &mut resumed).await.unwrap();
        resumed.update(b"second half");

        let mut whole = Sha256::new();
        whole.update(b"first halfsecond half");
        assert_eq!(
            format!("{:x}", resumed.finalize()),
            format!("{:x}", whole.finalize())
        );
    }

    #[test]
    fn a_runtime_left_in_the_install_directory_moves_to_the_data_directory() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("Anbo").join("whisper.cpp");
        let current = temp.path().join("com.anbo.desktop").join("whisper.cpp");
        fs::create_dir_all(legacy.join("models")).unwrap();
        fs::write(legacy.join("models").join("ggml-tiny.bin"), b"model").unwrap();

        assert!(migrate_runtime_dir(&legacy, &current).unwrap());
        assert!(!legacy.exists());
        assert_eq!(
            fs::read(current.join("models").join("ggml-tiny.bin")).unwrap(),
            b"model"
        );
    }

    #[test]
    fn migration_never_destroys_a_runtime_already_in_the_data_directory() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("Anbo").join("whisper.cpp");
        let current = temp.path().join("com.anbo.desktop").join("whisper.cpp");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("keep.bin"), b"keep").unwrap();

        assert!(migrate_runtime_dir(&legacy, &current).is_err());
        assert_eq!(fs::read(current.join("keep.bin")).unwrap(), b"keep");
        assert!(legacy.is_dir());
    }

    #[test]
    fn a_fresh_install_has_nothing_to_migrate() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("Anbo").join("whisper.cpp");
        let current = temp.path().join("com.anbo.desktop").join("whisper.cpp");
        assert!(!migrate_runtime_dir(&legacy, &current).unwrap());
        assert!(!current.exists());
    }

    #[test]
    fn the_install_size_is_computed_once_and_dropped_when_it_changes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.bin"), vec![0_u8; 1024]).unwrap();

        super::forget_install_size();
        let first = super::cached_directory_size(temp.path());
        assert_eq!(first, 1024);

        // A second file is deliberately not seen: the point of the cache is
        // that a poll every two seconds does not walk the directory again.
        fs::write(temp.path().join("b.bin"), vec![0_u8; 2048]).unwrap();
        assert_eq!(super::cached_directory_size(temp.path()), 1024);

        // Install and uninstall drop it, and then the truth is read again.
        super::forget_install_size();
        assert_eq!(super::cached_directory_size(temp.path()), 3072);
        super::forget_install_size();
    }

    #[cfg(windows)]
    #[test]
    fn the_machine_reports_its_own_memory_and_cores() {
        // A failed FFI call would silently return zero and quietly recommend
        // the smallest model on every machine, which looks like a policy
        // rather than a bug.
        let ram = super::total_ram_mb();
        assert!(ram > 512, "reported {ram} MB of RAM");
        assert!(ram < 8 * 1024 * 1024, "reported {ram} MB of RAM");
        assert!(super::machine_cores() >= 1);
    }

    #[test]
    fn a_bigger_machine_gets_more_threads_and_a_small_one_loses_nothing() {
        // whisper.cpp's own default of four left most of a large machine idle.
        assert_eq!(transcription_threads(16), 8);
        assert_eq!(transcription_threads(12), 8);
        assert_eq!(transcription_threads(8), 6);
        assert_eq!(transcription_threads(6), 4);
        // At or below four cores the count is unchanged, so no machine that
        // works today gets slower.
        assert_eq!(transcription_threads(4), 4);
        assert_eq!(transcription_threads(2), 2);
        assert_eq!(transcription_threads(1), 1);
        assert_eq!(transcription_threads(0), 1);
    }

    #[test]
    fn thread_count_never_falls_as_cores_rise() {
        // A machine with more cores must never be handed fewer threads.
        let mut previous = 0;
        for cores in 1..64 {
            let threads = transcription_threads(cores);
            assert!(threads >= previous, "{cores} cores gave {threads}");
            assert!((1..=8).contains(&threads));
            previous = threads;
        }
    }

    #[test]
    fn the_suggested_model_fits_the_memory_the_machine_has() {
        // Resident cost measured with each model loaded: ~0.4, ~0.6, ~1.2 GB.
        assert_eq!(recommended_model(16 * 1024, false), "small");
        assert_eq!(recommended_model(8 * 1024, false), "small");
        assert_eq!(recommended_model(6 * 1024, false), "base");
        assert_eq!(recommended_model(4 * 1024, false), "base");
        assert_eq!(recommended_model(2 * 1024, false), "tiny");
        assert_eq!(recommended_model(0, false), "tiny");
    }

    #[test]
    fn a_gpu_lifts_the_middle_tier_but_not_a_starved_machine() {
        // Weights sit in VRAM, so system memory is under less pressure.
        assert_eq!(recommended_model(4 * 1024, true), "small");
        assert_eq!(recommended_model(6 * 1024, true), "small");
        // A machine short on memory is still short on memory.
        assert_eq!(recommended_model(2 * 1024, true), "tiny");
    }

    #[test]
    fn every_suggestion_is_a_model_that_exists() {
        for ram in [0_u64, 2048, 4096, 8192, 32768] {
            for gpu in [false, true] {
                assert!(model_spec(recommended_model(ram, gpu)).is_ok());
            }
        }
    }

    #[test]
    fn only_the_cuda_backend_claims_the_gpu() {
        assert!(!variant_spec("cpu").unwrap().gpu);
        assert!(!variant_spec("blas").unwrap().gpu);
        assert!(variant_spec("cuda").unwrap().gpu);
        assert!(variant_spec("vulkan").is_none());
    }

    #[test]
    fn every_backend_is_pinned_to_its_own_binaries() {
        // A shared hash between two variants would let the wrong backend pass
        // verification and run without anyone noticing.
        for (index, variant) in VARIANTS.iter().enumerate() {
            assert_eq!(variant.sha256.len(), 64, "{}", variant.id);
            assert_eq!(variant.server_sha256.len(), 64, "{}", variant.id);
            for other in VARIANTS.iter().skip(index + 1) {
                assert_ne!(variant.sha256, other.sha256);
                assert_ne!(variant.server_sha256, other.server_sha256);
                assert_ne!(variant.archive, other.archive);
            }
        }
    }

    #[test]
    fn an_explicit_backend_is_honoured_and_a_wrong_one_is_refused() {
        assert_eq!(resolve_variant(Some("cpu")).unwrap().id, "cpu");
        assert_eq!(resolve_variant(Some("cuda")).unwrap().id, "cuda");
        assert!(resolve_variant(Some("rocm")).is_err());
    }

    #[test]
    fn an_unset_preference_follows_the_hardware() {
        // Whatever this machine has, "auto" and an absent preference must agree
        // with detection rather than diverging.
        let detected = detected_variant().id;
        assert_eq!(resolve_variant(None).unwrap().id, detected);
        assert_eq!(resolve_variant(Some("auto")).unwrap().id, detected);
        assert_eq!(resolve_variant(Some("")).unwrap().id, detected);
    }

    #[test]
    fn a_manifest_written_before_backends_existed_is_read_by_its_server_hash() {
        let temp = tempfile::tempdir().unwrap();
        let cpu = variant_spec("cpu").unwrap();
        fs::write(
            temp.path().join(".anbo-runtime.json"),
            format!(
                r#"{{"runtimeVersion":"b4938","serverSha256":"{}","installedModels":["base"]}}"#,
                cpu.server_sha256
            ),
        )
        .unwrap();

        assert_eq!(manifest_variant(temp.path()).map(|v| v.id), Some("cpu"));
    }

    #[test]
    fn a_manifest_naming_its_backend_is_taken_at_its_word() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(".anbo-runtime.json"),
            r#"{"runtimeVersion":"b4938","variant":"cuda","serverSha256":"","installedModels":[]}"#,
        )
        .unwrap();

        assert_eq!(manifest_variant(temp.path()).map(|v| v.id), Some("cuda"));
    }

    #[test]
    fn no_manifest_means_no_backend_rather_than_a_guess() {
        let temp = tempfile::tempdir().unwrap();
        assert!(manifest_variant(temp.path()).is_none());
    }

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

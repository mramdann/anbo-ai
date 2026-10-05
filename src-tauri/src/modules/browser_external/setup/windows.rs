use super::{Browser, SetupResult};
use crate::modules::{app_data, browser_automation, proc::hide_console};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;

static INSTALLING: Mutex<()> = Mutex::const_new(());
const MANIFEST: &str = include_str!("../../../../../extensions/anbo-browser/manifest.json");
const INSTALLER: &str = include_str!("../../../../../scripts/install-browser-bridge.ps1");
const ASSETS: &[(&str, &[u8])] = &[
    ("manifest.json", MANIFEST.as_bytes()),
    (
        "dock.html",
        include_bytes!("../../../../../extensions/anbo-browser/dock.html"),
    ),
    (
        "dock-page.js",
        include_bytes!("../../../../../extensions/anbo-browser/dock-page.js"),
    ),
    (
        "dock.js",
        include_bytes!("../../../../../extensions/anbo-browser/dock.js"),
    ),
    (
        "frames.js",
        include_bytes!("../../../../../extensions/anbo-browser/frames.js"),
    ),
    (
        "background.js",
        include_bytes!("../../../../../extensions/anbo-browser/background.js"),
    ),
    (
        "bridge.js",
        include_bytes!("../../../../../extensions/anbo-browser/bridge.js"),
    ),
    (
        "tabs.js",
        include_bytes!("../../../../../extensions/anbo-browser/tabs.js"),
    ),
    (
        "popup.html",
        include_bytes!("../../../../../extensions/anbo-browser/popup.html"),
    ),
    (
        "popup.css",
        include_bytes!("../../../../../extensions/anbo-browser/popup.css"),
    ),
    (
        "popup.js",
        include_bytes!("../../../../../extensions/anbo-browser/popup.js"),
    ),
    (
        "popup-view.js",
        include_bytes!("../../../../../extensions/anbo-browser/popup-view.js"),
    ),
    (
        "icon-16.png",
        include_bytes!("../../../../../extensions/anbo-browser/icon-16.png"),
    ),
    (
        "icon-24.png",
        include_bytes!("../../../../../extensions/anbo-browser/icon-24.png"),
    ),
    (
        "icon-32.png",
        include_bytes!("../../../../../extensions/anbo-browser/icon-32.png"),
    ),
    (
        "icon-48.png",
        include_bytes!("../../../../../extensions/anbo-browser/icon-48.png"),
    ),
    (
        "icon-128.png",
        include_bytes!("../../../../../extensions/anbo-browser/icon-128.png"),
    ),
];

fn host_name(identifier: &str) -> String {
    let digest = Sha256::digest(identifier.as_bytes());
    let suffix: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("com.anbo.browser_bridge.{suffix}")
}

fn extension_id() -> Result<String, String> {
    let manifest: Value = serde_json::from_str(MANIFEST).map_err(|error| error.to_string())?;
    let key = manifest["key"]
        .as_str()
        .ok_or("Missing browser extension public key")?;
    let public_key = STANDARD.decode(key).map_err(|error| error.to_string())?;
    Ok(Sha256::digest(public_key)[..16]
        .iter()
        .flat_map(|byte| {
            [
                char::from(b'a' + (byte >> 4)),
                char::from(b'a' + (byte & 15)),
            ]
        })
        .collect())
}

fn reject_reparse_points(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
                return Err(format!(
                    "Browser setup cannot use a reparse point: {}",
                    ancestor.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

/// Writes a file only when its content changed; true when it did.
fn write_asset(path: &Path, content: impl AsRef<[u8]>) -> Result<bool, String> {
    let content = content.as_ref();
    reject_reparse_points(path)?;
    if fs::read(path).is_ok_and(|existing| existing == content) {
        return Ok(false);
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing setup directory")?)
            .map_err(|error| error.to_string())?;
    temporary
        .write_all(content)
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Writes the extension files and installer; true when an extension file changed.
fn prepare_assets(root: &Path, host: &str) -> Result<(PathBuf, bool), String> {
    reject_reparse_points(root)?;
    let extension = root.join("extension");
    reject_reparse_points(&extension)?;
    fs::create_dir_all(&extension).map_err(|error| error.to_string())?;
    let mut changed = false;
    for (name, content) in ASSETS {
        changed |= write_asset(&extension.join(name), content)?;
    }
    changed |= write_asset(
        &extension.join("host.js"),
        format!("export const NATIVE_HOST = {host:?};\n"),
    )?;
    write_asset(&root.join("install.ps1"), INSTALLER)?;
    Ok((extension, changed))
}

/// What an update changed in an earlier Setup.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refreshed {
    pub extension: bool,
    pub native_host: bool,
}

/// Brings an earlier Setup's extension files and native host copy up to
/// this build. Browsers keep the extension they loaded until it is reloaded,
/// which the browser menu asks for.
pub fn refresh_installed(identifier: &str, sidecar: &Path) -> Result<Refreshed, String> {
    let _guard = INSTALLING
        .try_lock()
        .map_err(|_| "browser setup is running")?;
    let root = app_data::local_data_root()?.join("browser-bridge");
    refresh_at(&root, &host_name(identifier), sidecar)
}

fn refresh_at(root: &Path, host: &str, sidecar: &Path) -> Result<Refreshed, String> {
    if !root.join("extension").join("manifest.json").is_file() {
        return Ok(Refreshed::default());
    }
    let (_, extension) = prepare_assets(root, host)?;
    let native_host =
        refresh_native_host(&root.join("native-host").join("anbo-browser.exe"), sidecar)?;
    Ok(Refreshed {
        extension,
        native_host,
    })
}

/// Copies this build's native host over the one Setup installed when it is
/// newer. A host the browser runs right now cannot be overwritten, but
/// Windows lets its file be renamed, so it moves aside and the next start
/// uses the copy. An older sidecar (a stale development build, a downgrade)
/// never replaces a newer host.
fn refresh_native_host(installed: &Path, sidecar: &Path) -> Result<bool, String> {
    if !installed.is_file() || !sidecar.is_file() {
        return Ok(false);
    }
    reject_reparse_points(installed)?;
    let modified = |path: &Path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    };
    let Some(built) = modified(sidecar) else {
        return Ok(false);
    };
    if modified(installed).is_some_and(|current| current >= built) {
        return Ok(false);
    }
    let fresh = fs::read(sidecar).map_err(|error| error.to_string())?;
    if fs::read(installed).is_ok_and(|current| current == fresh) {
        return Ok(false);
    }
    let directory = installed.parent().ok_or("Missing native host directory")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let parked = directory.join(format!("anbo-browser.{stamp}.old"));
    fs::rename(installed, &parked).map_err(|error| error.to_string())?;
    if let Err(error) = write_asset(installed, &fresh) {
        let _ = fs::rename(&parked, installed);
        return Err(error);
    }
    // The copy keeps the build's time, so the next update compares builds
    // rather than the moment this copy was made.
    if let Ok(file) = fs::File::options().write(true).open(installed) {
        let _ = file.set_modified(built);
    }
    for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "old") {
            // Still in use until that host exits; a later start retries.
            let _ = fs::remove_file(path);
        }
    }
    Ok(true)
}

async fn run_hidden(mut command: Command, seconds: u64) -> Result<Output, String> {
    hide_console(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(seconds), command.output())
        .await
        .map_err(|_| {
            "Browser setup timed out. Retry setup; no profile has been connected.".to_string()
        })?
        .map_err(|error| error.to_string())
}

fn browser_details(browser: &Browser) -> (&'static str, &'static str, &'static str) {
    match browser {
        Browser::Chrome => (
            "Chrome",
            "chrome://extensions",
            "Google/Chrome/Application/chrome.exe",
        ),
        Browser::Edge => (
            "Edge",
            "edge://extensions",
            "Microsoft/Edge/Application/msedge.exe",
        ),
    }
}

fn installer_command(
    root: &Path,
    sidecar: &Path,
    descriptor: &Path,
    browser: &Browser,
    host: &str,
) -> Result<Command, String> {
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("Missing Windows system directory")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(powershell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(root.join("install.ps1"))
        .arg("-ExtensionId")
        .arg(extension_id()?)
        .arg("-SidecarPath")
        .arg(sidecar)
        .arg("-DescriptorPath")
        .arg(descriptor)
        .arg("-InstallDirectory")
        .arg(root.join("native-host"))
        .arg("-Browser")
        .arg(browser_details(browser).0)
        .arg("-HostName")
        .arg(host);
    Ok(command)
}

fn open_extensions(browser: &Browser) -> Result<(), String> {
    let (label, url, relative) = browser_details(browser);
    let executable = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join(relative))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!("Could not find {label}. Open {url} in your chosen browser profile.")
        })?;
    // The shell starts the browser, so it inherits none of Anbo's handles. A
    // browser started as Anbo's child keeps Anbo's MCP listening socket open
    // after Anbo exits, and every later launch fails to bind that port.
    use std::os::windows::ffi::OsStrExt;
    let wide =
        |value: &std::ffi::OsStr| -> Vec<u16> { value.encode_wide().chain(Some(0)).collect() };
    let file = wide(executable.as_os_str());
    let parameters = wide(std::ffi::OsStr::new(url));
    let started = unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(file.as_ptr()),
            windows::core::PCWSTR(parameters.as_ptr()),
            windows::core::PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    if started.0 as isize <= 32 {
        return Err(format!("Open {url} manually in {label}."));
    }
    Ok(())
}

pub async fn install(app: AppHandle, browser: Browser) -> Result<SetupResult, String> {
    let _guard = INSTALLING
        .try_lock()
        .map_err(|_| "Browser setup is already running")?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let sidecar = executable
        .parent()
        .ok_or("Missing Anbo executable directory")?
        .join("anbo-browser.exe");
    let mut probe = Command::new(&sidecar);
    probe.arg("--native-host-version");
    let supported = run_hidden(probe, 5)
        .await
        .is_ok_and(|output| output.status.success() && output.stdout == b"anbo-native-host-2\n");
    if !supported {
        return Err("Anbo's browser bridge binary does not match this version of Anbo. Restart Anbo, or reinstall it if this message comes back, then run Setup again.".into());
    }
    let data_root = app_data::local_data_root()?;
    reject_reparse_points(&data_root)?;
    let descriptor = data_root.join("runtime/browser/instance.json");
    reject_reparse_points(&descriptor)?;
    reject_reparse_points(&data_root.join("runtime/browser/auth-token"))?;
    let root = data_root.join("browser-bridge");
    let host = host_name(&app.config().identifier);
    let asset_root = root.clone();
    let asset_host = host.clone();
    let (extension, _) =
        tauri::async_runtime::spawn_blocking(move || prepare_assets(&asset_root, &asset_host))
            .await
            .map_err(|error| error.to_string())??;
    browser_automation::server::start_server(app)?;
    let command = installer_command(&root, &sidecar, &descriptor, &browser, &host)?;
    let output = run_hidden(command, 60).await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Browser setup failed: {}",
            detail.chars().take(2000).collect::<String>()
        ));
    }
    let extensions_url = browser_details(&browser).1.to_string();
    let warning = open_extensions(&browser).err();
    Ok(SetupResult {
        browser,
        extension_path: extension.to_string_lossy().into_owned(),
        extensions_url,
        warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_id_is_pinned_and_registration_is_instance_scoped() {
        assert_eq!(extension_id().unwrap(), "ikadkplcmlaopjecapgimjecabpnilnj");
        let development = host_name("com.anbo.desktop.dev");
        assert_eq!(development, host_name("com.anbo.desktop.dev"));
        assert_ne!(development, host_name("com.anbo.desktop"));
        assert!(development.bytes().all(|byte| byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || b"._".contains(&byte)));
    }

    #[test]
    fn setup_extracts_only_extension_assets_and_binds_the_selected_instance() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("browser-bridge");
        let host = host_name("com.anbo.desktop.dev");
        let (extension, written) = prepare_assets(&root, &host).unwrap();
        assert!(written);
        assert_eq!(fs::read_dir(&extension).unwrap().count(), ASSETS.len() + 1);
        assert!(fs::read_to_string(extension.join("host.js"))
            .unwrap()
            .contains(&host));
        assert!(!extension.join("bridge.test.js").exists());
        assert_eq!(
            prepare_assets(&root, &host).unwrap(),
            (extension.clone(), false)
        );
        assert_eq!(
            fs::read_to_string(extension.join("manifest.json")).unwrap(),
            MANIFEST
        );
    }

    #[test]
    fn setup_ships_every_extension_file_and_manifest_icon() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../extensions/anbo-browser");
        for entry in fs::read_dir(source).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            if name == "host.js" || name.ends_with(".test.js") {
                continue;
            }
            assert!(
                ASSETS.iter().any(|(asset, _)| *asset == name),
                "{name} is not extracted by browser setup"
            );
        }
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let icons = manifest["icons"].as_object().unwrap().values().chain(
            manifest["action"]["default_icon"]
                .as_object()
                .unwrap()
                .values(),
        );
        for icon in icons {
            let (_, content) = ASSETS
                .iter()
                .find(|(asset, _)| Some(*asset) == icon.as_str())
                .unwrap_or_else(|| panic!("{icon} is not extracted by browser setup"));
            assert!(
                content.starts_with(b"\x89PNG\r\n\x1a\n"),
                "{icon} is not a PNG"
            );
        }
    }

    #[test]
    fn chrome_and_edge_do_not_fall_back_to_the_default_browser() {
        assert_eq!(browser_details(&Browser::Chrome).1, "chrome://extensions");
        assert_eq!(browser_details(&Browser::Edge).1, "edge://extensions");
        assert_ne!(
            browser_details(&Browser::Chrome).2,
            browser_details(&Browser::Edge).2
        );
    }

    #[test]
    fn refresh_updates_only_an_earlier_setup_and_never_downgrades_its_host() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("browser-bridge");
        let host = host_name("com.anbo.desktop.setup-test");
        let sidecar = temporary.path().join("anbo-browser.exe");
        fs::write(&sidecar, b"new host").unwrap();
        assert_eq!(
            refresh_at(&root, &host, &sidecar).unwrap(),
            Refreshed::default()
        );
        assert!(!root.exists());

        let (extension, _) = prepare_assets(&root, &host).unwrap();
        fs::write(extension.join("bridge.js"), "old bridge").unwrap();
        let installed = root.join("native-host").join("anbo-browser.exe");
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&installed, b"old host").unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&installed)
            .unwrap()
            .set_modified(old)
            .unwrap();

        let refreshed = refresh_at(&root, &host, &sidecar).unwrap();
        assert_eq!(
            refreshed,
            Refreshed {
                extension: true,
                native_host: true
            }
        );
        assert_ne!(
            fs::read_to_string(extension.join("bridge.js")).unwrap(),
            "old bridge"
        );
        assert_eq!(fs::read(&installed).unwrap(), b"new host");
        assert_eq!(
            fs::read_dir(installed.parent().unwrap()).unwrap().count(),
            1
        );
        assert_eq!(
            refresh_at(&root, &host, &sidecar).unwrap(),
            Refreshed::default()
        );

        fs::write(&installed, b"newer host").unwrap();
        fs::File::options()
            .write(true)
            .open(&sidecar)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(!refresh_native_host(&installed, &sidecar).unwrap());
        assert_eq!(fs::read(&installed).unwrap(), b"newer host");
    }

    #[tokio::test]
    async fn installer_dry_run_validates_arguments_without_installing_a_host() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("path with spaces and ' quotes");
        let host = host_name("com.anbo.desktop.setup-test");
        prepare_assets(&root, &host).unwrap();
        let sidecar = root.join("source.exe");
        let descriptor = root.join("instance.json");
        fs::write(&sidecar, "not executed by the installer").unwrap();
        fs::write(&descriptor, "{}").unwrap();
        let mut command =
            installer_command(&root, &sidecar, &descriptor, &Browser::Chrome, &host).unwrap();
        command.arg("-WhatIf");
        let output = run_hidden(command, 30).await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!root.join("native-host").exists());
        assert_eq!(fs::read_to_string(&descriptor).unwrap(), "{}");
    }

    #[tokio::test]
    async fn installer_text_updates_are_atomic_and_leave_no_temporary_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        prepare_assets(root, &host_name("com.anbo.desktop.setup-test")).unwrap();
        let test_script = root.join("text-test.ps1");
        write_asset(&test_script, r#"
param([string]$Installer, [string]$Destination)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Invalid installer syntax' }
$definition = $tree.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-BridgeText' }, $true)
. ([ScriptBlock]::Create($definition.Extent.Text))
Write-BridgeText $Destination 'first'
Write-BridgeText $Destination 'second'
Write-BridgeText $Destination 'second'
"#).unwrap();
        let destination = root.join("text.json");
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(powershell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(test_script)
            .arg("-Installer")
            .arg(root.join("install.ps1"))
            .arg("-Destination")
            .arg(&destination);
        let output = run_hidden(command, 30).await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read_to_string(destination).unwrap(), "second");
        assert_eq!(fs::read_dir(root).unwrap().count(), 4);
    }
}

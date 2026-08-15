use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

const PROFILE_DIR_NAME: &str = "browser-data";
const MAX_PROFILE_ENTRIES: u64 = 500_000;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDataUsage {
    pub bytes: u64,
    pub files: u64,
    pub complete: bool,
}

pub fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(PROFILE_DIR_NAME))
        .map_err(|error| error.to_string())
}

fn measure_profile(path: &Path) -> BrowserDataUsage {
    if !path.exists() {
        return BrowserDataUsage {
            complete: true,
            ..BrowserDataUsage::default()
        };
    }
    let mut usage = BrowserDataUsage {
        complete: true,
        ..BrowserDataUsage::default()
    };
    let mut pending = vec![path.to_path_buf()];
    let mut entries = 0_u64;

    while let Some(dir) = pending.pop() {
        let Ok(children) = std::fs::read_dir(dir) else {
            usage.complete = false;
            continue;
        };
        for child in children {
            entries = entries.saturating_add(1);
            if entries > MAX_PROFILE_ENTRIES {
                usage.complete = false;
                return usage;
            }
            let Ok(child) = child else {
                usage.complete = false;
                continue;
            };
            let Ok(metadata) = child.file_type() else {
                usage.complete = false;
                continue;
            };
            if metadata.is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(child.path());
            } else if metadata.is_file() {
                match child.metadata() {
                    Ok(file) => {
                        usage.bytes = usage.bytes.saturating_add(file.len());
                        usage.files = usage.files.saturating_add(1);
                    }
                    Err(_) => usage.complete = false,
                }
            }
        }
    }
    usage
}

fn ensure_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("browser data commands are only available to the main window".into())
    }
}

#[tauri::command]
pub async fn browser_data_usage(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<BrowserDataUsage, String> {
    ensure_main_window(&window)?;
    let profile = profile_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || measure_profile(&profile))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_clear_data(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    ensure_main_window(&window)?;

    for tab_id in super::embed::list_active_tab_ids() {
        if let Some(webview) = app.get_webview(&super::embed::embed_label(tab_id)) {
            webview
                .clear_all_browsing_data()
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }

    let profile = profile_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !profile.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&profile).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_files_without_following_symlinks() {
        let dir = tempfile::tempdir().expect("temp profile");
        std::fs::create_dir(dir.path().join("Cache")).expect("cache dir");
        std::fs::write(dir.path().join("Cookies"), [1_u8; 7]).expect("cookies");
        std::fs::write(dir.path().join("Cache").join("entry"), [2_u8; 11]).expect("cache entry");

        let usage = measure_profile(dir.path());
        assert_eq!(usage.bytes, 18);
        assert_eq!(usage.files, 2);
        assert!(usage.complete);
    }

    #[test]
    fn missing_profile_is_empty() {
        let dir = tempfile::tempdir().expect("temp profile");
        let usage = measure_profile(&dir.path().join("missing"));
        assert_eq!(usage.bytes, 0);
        assert_eq!(usage.files, 0);
        assert!(usage.complete);
    }
}

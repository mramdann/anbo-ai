use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MIGRATION_MARKER: &str = ".local-data-v1";
const ROAMING_FILES: &[&str] = &[
    ".window-state.json",
    "anbo-settings.json",
    "anbo-spaces.json",
    "anbo-custom-themes.json",
    "anbo-ai-agents.json",
    "anbo-ai-sessions.json",
    "anbo-ai-snippets.json",
    "anbo-ai-todos.json",
];

static LOCAL_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub struct AppDataPaths {
    pub root: PathBuf,
    pub window_state: PathBuf,
}

pub fn prepare(identifier: &str) -> Result<AppDataPaths, String> {
    let local_root = dirs::data_local_dir()
        .ok_or_else(|| "could not resolve local data directory".to_string())?
        .join(identifier);
    fs::create_dir_all(&local_root)
        .map_err(|e| format!("create local data directory {}: {e}", local_root.display()))?;

    if let Some(roaming_base) = dirs::data_dir() {
        let roaming_root = roaming_base.join(identifier);
        if roaming_root != local_root {
            migrate_roaming_data(&roaming_root, &local_root)?;
        }
    }
    migrate_shell_integration(&local_root)?;

    LOCAL_DATA_ROOT
        .set(local_root.clone())
        .map_err(|_| "local data directory was initialized more than once".to_string())?;

    Ok(AppDataPaths {
        window_state: local_root.join(".window-state.json"),
        root: local_root,
    })
}

pub fn local_data_root() -> Result<PathBuf, String> {
    LOCAL_DATA_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "local data directory is not initialized".to_string())
}

fn migrate_roaming_data(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.join(MIGRATION_MARKER).exists() {
        return Ok(());
    }
    if !source.exists() {
        write_marker(destination)?;
        return Ok(());
    }

    for name in ROAMING_FILES {
        migrate_file(
            &source.join(name),
            &destination.join(name),
            &destination
                .join("migration-backup")
                .join("roaming")
                .join(name),
            true,
        )?;
    }

    migrate_directory(
        &source.join("themes"),
        &destination.join("themes"),
        &destination
            .join("migration-backup")
            .join("roaming")
            .join("themes"),
    )?;
    remove_if_empty(source)?;
    write_marker(destination)
}

fn migrate_shell_integration(destination: &Path) -> Result<(), String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    migrate_directory(
        &home.join(".cache").join("anbo").join("shell-integration"),
        &destination.join("runtime").join("shell-integration"),
        &destination
            .join("migration-backup")
            .join("shell-integration"),
    )
}

fn migrate_directory(source: &Path, destination: &Path, backup: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(source).map_err(|e| format!("read {}: {e}", source.display()))? {
        let entry = entry.map_err(|e| format!("read {}: {e}", source.display()))?;
        let name = entry.file_name();
        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let backup_path = backup.join(&name);
        if entry
            .file_type()
            .map_err(|e| format!("inspect {}: {e}", source_path.display()))?
            .is_dir()
        {
            migrate_directory(&source_path, &destination_path, &backup_path)?;
        } else {
            migrate_file(&source_path, &destination_path, &backup_path, false)?;
        }
    }
    fs::remove_dir(source).map_err(|e| format!("remove {}: {e}", source.display()))
}

fn migrate_file(
    source: &Path,
    destination: &Path,
    backup: &Path,
    validate_json: bool,
) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    let bytes = fs::read(source).map_err(|e| format!("read {}: {e}", source.display()))?;
    if validate_json {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|e| format!("invalid JSON in {}: {e}", source.display()))?;
    }

    if destination.is_file() {
        let current =
            fs::read(destination).map_err(|e| format!("read {}: {e}", destination.display()))?;
        if current != bytes {
            write_new_file(backup, &bytes)?;
        }
    } else {
        write_new_file(destination, &bytes)?;
    }

    fs::remove_file(source).map_err(|e| format!("remove {}: {e}", source.display()))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        let existing = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        if existing == bytes {
            return Ok(());
        }
        return Err(format!(
            "migration backup already exists: {}",
            path.display()
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let temporary = path.with_extension(format!("migrate-{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|e| format!("write {}: {e}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("rename {} to {}: {e}", temporary.display(), path.display())
    })
}

fn write_marker(destination: &Path) -> Result<(), String> {
    let marker = destination.join(MIGRATION_MARKER);
    if marker.exists() {
        return Ok(());
    }
    write_new_file(&marker, b"1\n")
}

fn remove_if_empty(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if entries.next().is_none() {
        fs::remove_dir(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate_roaming_data, MIGRATION_MARKER};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn moves_known_roaming_data_to_local_root() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("roaming");
        let destination = temp.path().join("local");
        fs::create_dir_all(source.join("themes")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("anbo-settings.json"), br#"{"theme":"dark"}"#).unwrap();
        fs::write(source.join("themes").join("night.anbo-theme"), b"theme").unwrap();

        migrate_roaming_data(&source, &destination).unwrap();

        assert!(destination.join("anbo-settings.json").is_file());
        assert!(destination
            .join("themes")
            .join("night.anbo-theme")
            .is_file());
        assert!(destination.join(MIGRATION_MARKER).is_file());
        assert!(!source.exists());
    }

    #[test]
    fn local_data_wins_and_roaming_conflict_is_backed_up() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("roaming");
        let destination = temp.path().join("local");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("anbo-settings.json"), br#"{"source":true}"#).unwrap();
        fs::write(destination.join("anbo-settings.json"), br#"{"local":true}"#).unwrap();

        migrate_roaming_data(&source, &destination).unwrap();

        assert_eq!(
            fs::read(destination.join("anbo-settings.json")).unwrap(),
            br#"{"local":true}"#
        );
        assert_eq!(
            fs::read(
                destination
                    .join("migration-backup")
                    .join("roaming")
                    .join("anbo-settings.json")
            )
            .unwrap(),
            br#"{"source":true}"#
        );
        assert!(!source.exists());
    }

    #[test]
    fn invalid_json_is_not_removed() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("roaming");
        let destination = temp.path().join("local");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("anbo-settings.json"), b"not json").unwrap();

        let error = migrate_roaming_data(&source, &destination).unwrap_err();

        assert!(error.contains("invalid JSON"));
        assert!(source.join("anbo-settings.json").is_file());
        assert!(!destination.join("anbo-settings.json").exists());
    }
}

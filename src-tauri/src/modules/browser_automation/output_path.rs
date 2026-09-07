use std::path::Path;

pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        normalize_windows(&text)
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

#[cfg(any(windows, test))]
fn normalize_windows(text: &str) -> String {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\")
            .unwrap_or(text)
            .replace('\\', "/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_only_normalizes_drive_and_unc_prefixes() {
        assert_eq!(
            normalize_windows(r"\\?\D:\space\file.txt"),
            "D:/space/file.txt"
        );
        assert_eq!(
            normalize_windows(r"\\?\UNC\server\share\file.txt"),
            "//server/share/file.txt"
        );
        assert_eq!(normalize_windows(r"D:\space\file.txt"), "D:/space/file.txt");
        assert_eq!(normalize_windows("D:/space/file.txt"), "D:/space/file.txt");
    }
}

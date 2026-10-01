//! Names a connecting profile the way its browser does, read from the browser's
//! own `Local State`, when the extension leaves the label empty. Extensions have
//! no API for their profile's name.
// Only Windows reads the browser's process; other platforms build the parsing
// for its tests.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use super::browser_process as native;
use super::protocol::Browser;
use serde_json::Value;
use std::path::{Path, PathBuf};

const LOCAL_STATE_LIMIT: u64 = 16 * 1024 * 1024;

/// The label for a profile the extension left unnamed: the browser's name for
/// it when the connecting profile can be told apart, otherwise the browser's
/// own name, numbered when another connected profile already has it.
pub fn resolve(browser: &Browser, client: Option<u32>, taken: &[String]) -> String {
    let named = client.and_then(read_from_browser);
    let fallback = match browser {
        Browser::Chrome => "Chrome",
        Browser::Edge => "Edge",
    };
    unique(named.unwrap_or_else(|| fallback.into()), taken)
}

fn unique(label: String, taken: &[String]) -> String {
    let used = |candidate: &str| {
        taken
            .iter()
            .any(|name| name.eq_ignore_ascii_case(candidate))
    };
    let mut candidate = label.clone();
    let mut number = 1;
    while used(&candidate) {
        number += 1;
        candidate = format!("{label} {number}");
    }
    candidate
}

/// The profile that connected, when the browser can only mean one: its only
/// profile, or the only one active at its last save. With several active the
/// extension cannot tell which one it runs in.
fn from_local_state(state: &Value) -> Option<String> {
    let profiles = state.pointer("/profile/info_cache")?.as_object()?;
    let profile = if profiles.len() == 1 {
        profiles.values().next()
    } else {
        match state
            .pointer("/profile/last_active_profiles")?
            .as_array()?
            .as_slice()
        {
            [only] => profiles.get(only.as_str()?),
            _ => None,
        }
    }?;
    let name = profile.get("name")?.as_str()?.trim();
    // Room for a number when another connected profile has the same name.
    (!name.is_empty() && !name.chars().any(char::is_control))
        .then(|| name.chars().take(60).collect())
}

/// Splits a Windows command line; quotes group and are dropped. Backslashes
/// stay as written, which is all a browser's own paths need.
fn arguments(command_line: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for character in command_line.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ' ' | '\t' if !quoted => {
                if started {
                    arguments.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            _ => {
                current.push(character);
                started = true;
            }
        }
    }
    if started {
        arguments.push(current);
    }
    arguments
}

/// Where the browser keeps its profiles: the folder it was started with, or
/// the one its install layout implies (`<Vendor>\<Product>\Application\` keeps
/// them in `<Vendor>\<Product>\User Data` under local app data).
fn user_data_dir(arguments: &[String], image: &Path, local_app_data: &Path) -> Option<PathBuf> {
    if let Some(dir) = arguments
        .iter()
        .find_map(|argument| argument.strip_prefix("--user-data-dir="))
    {
        return (!dir.is_empty()).then(|| PathBuf::from(dir));
    }
    let application = image.parent()?;
    if !application.file_name()?.eq_ignore_ascii_case("Application") {
        return None;
    }
    let product = application.parent()?;
    let vendor = product.parent()?.file_name()?;
    Some(
        local_app_data
            .join(vendor)
            .join(product.file_name()?)
            .join("User Data"),
    )
}

#[cfg(windows)]
fn read_from_browser(client: u32) -> Option<String> {
    let browser = native::browser_ancestor(client)?;
    let image = native::image_path(browser)?;
    let arguments = arguments(&native::command_line(browser)?);
    let local_app_data = std::env::var_os("LOCALAPPDATA")?;
    let dir = user_data_dir(&arguments, &image, Path::new(&local_app_data))?;
    let file = std::fs::File::open(dir.join("Local State")).ok()?;
    if file.metadata().ok()?.len() > LOCAL_STATE_LIMIT {
        return None;
    }
    let state: Value = serde_json::from_reader(std::io::BufReader::new(file)).ok()?;
    from_local_state(&state)
}

#[cfg(not(windows))]
fn read_from_browser(_client: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_single_profile_is_named_as_the_browser_names_it() {
        let state = json!({"profile": {"info_cache": {"Default": {"name": "Your Chrome"}}}});
        assert_eq!(from_local_state(&state).as_deref(), Some("Your Chrome"));
    }

    #[test]
    fn several_profiles_are_named_only_when_one_was_active() {
        let mut state = json!({"profile": {
            "info_cache": {"Default": {"name": "Personal"}, "Profile 1": {"name": "Work"}},
            "last_active_profiles": ["Profile 1"],
        }});
        assert_eq!(from_local_state(&state).as_deref(), Some("Work"));
        state["profile"]["last_active_profiles"] = json!(["Default", "Profile 1"]);
        assert_eq!(from_local_state(&state), None);
        state["profile"]["last_active_profiles"] = json!([]);
        assert_eq!(from_local_state(&state), None);
    }

    #[test]
    fn unusable_names_leave_the_label_to_the_fallback() {
        for name in [json!(""), json!("   "), json!("Bad\u{7}name"), json!(42)] {
            let state = json!({"profile": {"info_cache": {"Default": {"name": name}}}});
            assert_eq!(from_local_state(&state), None);
        }
        assert_eq!(from_local_state(&json!({})), None);
        let long = "x".repeat(80);
        let state = json!({"profile": {"info_cache": {"Default": {"name": long}}}});
        assert_eq!(from_local_state(&state).map(|name| name.len()), Some(60));
    }

    #[test]
    fn a_taken_label_gets_the_next_free_number() {
        assert_eq!(unique("Chrome".into(), &[]), "Chrome");
        let taken = ["chrome".to_string(), "Chrome 2".to_string()];
        assert_eq!(unique("Chrome".into(), &taken), "Chrome 3");
        assert_eq!(resolve(&Browser::Edge, None, &taken), "Edge");
    }

    // Windows paths: elsewhere a backslash is not a separator.
    #[cfg(windows)]
    #[test]
    fn the_profile_folder_follows_the_command_line_or_the_install() {
        let local = Path::new(r"C:\Users\Someone\AppData\Local");
        let chrome = Path::new(r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        assert_eq!(
            user_data_dir(&arguments(r#""C:\x\chrome.exe" --flag"#), chrome, local),
            Some(local.join("Google").join("Chrome").join("User Data"))
        );
        let beta = Path::new(r"C:\Program Files (x86)\Microsoft\Edge Beta\Application\msedge.exe");
        assert_eq!(
            user_data_dir(&[], beta, local),
            Some(local.join("Microsoft").join("Edge Beta").join("User Data"))
        );
        let started = arguments(
            r#""C:\msedge.exe" --user-data-dir=C:\Temp\edge-profile --no-first-run "http://x/?a b""#,
        );
        assert_eq!(
            user_data_dir(&started, beta, local),
            Some(PathBuf::from(r"C:\Temp\edge-profile"))
        );
        let quoted = arguments(r#"chrome.exe "--user-data-dir=C:\Profiles\Work Stuff" --x"#);
        assert_eq!(
            user_data_dir(&quoted, chrome, local),
            Some(PathBuf::from(r"C:\Profiles\Work Stuff"))
        );
        assert_eq!(
            user_data_dir(&[], Path::new(r"C:\Tools\chrome.exe"), local),
            None
        );
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u32 = 3;
pub const MAX_CONNECTIONS: usize = 16;
pub const MAX_TABS: usize = 128;
pub const MAX_PENDING: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub version: u32,
    pub profile_id: String,
    pub browser: Browser,
    pub name: String,
}

impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != VERSION {
            return Err(
                "Update browser setup in Anbo, reload the extension, and reconnect this profile."
                    .into(),
            );
        }
        let valid_id = self.profile_id.len() == 36
            && self.profile_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        // An empty name asks Anbo to name the profile.
        if !valid_id || self.name.chars().count() > 64 || self.name.chars().any(char::is_control) {
            return Err("invalid external browser profile handshake".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tab {
    pub id: i64,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub selection_id: Option<String>,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub loading: bool,
    #[serde(default)]
    pub created_by_anbo: bool,
    /// For a tab the extension connected because a page Anbo drives opened
    /// it (a link, a script): which tab, and how.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_from: Option<OpenedFrom>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenedFrom {
    /// The opening tab's selection.
    pub selection_id: String,
    /// The browser opened it behind its opener (a Ctrl or middle click).
    #[serde(default)]
    pub background: bool,
    /// Anbo had just sent its opener input: an agent's click or key opened it.
    #[serde(default)]
    pub agent: bool,
}

/// A selection's id, as the extension makes one: a UUID.
fn lease_shaped(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub fn validate_url(address: &str) -> Result<url::Url, String> {
    if address.len() > 8192 {
        return Err("browser URL exceeds its size limit".into());
    }
    let url = url::Url::parse(address).map_err(|_| "enter a complete HTTP or HTTPS URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only HTTP and HTTPS browser tabs are supported".into());
    }
    Ok(url)
}

pub fn valid_tab_id(tab_id: i64) -> bool {
    (1..=9_007_199_254_740_991).contains(&tab_id)
}

pub fn validate_tabs(tabs: &[Tab]) -> Result<(), String> {
    if tabs.len() > MAX_TABS {
        return Err("too many browser tabs".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut leases = std::collections::HashSet::new();
    for tab in tabs {
        validate_url(&tab.url)?;
        if !valid_tab_id(tab.id)
            || !ids.insert(tab.id)
            || tab.title.len() > 1024
            || tab.url.len() > 8192
            || tab
                .selection_id
                .as_ref()
                .is_some_and(|id| !lease_shaped(id) || !leases.insert(id))
            || tab
                .opened_from
                .as_ref()
                .is_some_and(|opened| !lease_shaped(&opened.selection_id))
        {
            return Err("invalid browser tab".into());
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Incoming {
    Event {
        #[serde(rename = "tabId")]
        tab_id: i64,
        #[serde(rename = "selectionId")]
        selection_id: String,
        method: String,
        params: Value,
    },
    Tabs {
        tabs: Vec<Tab>,
    },
    Reply {
        id: u64,
        result: Option<Value>,
        error: Option<String>,
    },
    /// A word the extension meant for the native host, such as the renderers
    /// it keeps scheduled. The host keeps these; one an older host passes on
    /// is left alone.
    Host {
        #[serde(rename = "method")]
        _method: String,
        #[serde(default, rename = "params")]
        _params: Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_for_the_native_host_reads_as_one_and_leaves_other_types_strict() {
        let host: Incoming = serde_json::from_str(
            r#"{"method":"keepRenderers","params":{"ids":[11]},"type":"host"}"#,
        )
        .unwrap();
        assert!(matches!(host, Incoming::Host { _method, .. } if _method == "keepRenderers"));
        assert!(serde_json::from_str::<Incoming>(r#"{"type":"later"}"#).is_err());
        assert!(serde_json::from_str::<Incoming>(
            r#"{"method":"keepRenderers","type":"host","extra":1}"#
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_profiles_and_unknown_browsers() {
        let mut profile = Profile {
            version: VERSION,
            profile_id: "00112233-4455-6677-8899-aabbccddeeff".into(),
            browser: Browser::Chrome,
            name: "Work".into(),
        };
        assert!(profile.validate().is_ok());
        profile.name = String::new();
        assert!(profile.validate().is_ok());
        profile.name = "Bad\u{7}name".into();
        assert!(profile.validate().is_err());
        profile.name = "x".repeat(65);
        assert!(profile.validate().is_err());
        profile.name = "Work".into();
        profile.version = 1;
        assert!(profile
            .validate()
            .unwrap_err()
            .contains("reload the extension"));
        profile.version = VERSION;
        profile.profile_id = "another-profile".into();
        assert!(profile.validate().is_err());
        assert!(serde_json::from_value::<Browser>(serde_json::json!("firefox")).is_err());
    }

    #[test]
    fn only_web_urls_and_javascript_safe_tab_ids_are_accepted() {
        for address in [
            "chrome://extensions",
            "edge://settings",
            "file:///secret.txt",
            "javascript:alert(1)",
            "example.com",
        ] {
            assert!(validate_url(address).is_err());
        }
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url(&format!("https://example.com/{}", "a".repeat(8192))).is_err());
        assert!(!valid_tab_id(0));
        assert!(!valid_tab_id(i64::MAX));
        assert!(valid_tab_id(10));
    }

    #[test]
    fn a_tab_a_page_opened_names_its_opener_by_its_lease() {
        let opened: Tab = serde_json::from_str(
            r#"{"id":12,"title":"New","url":"https://example.com/","selectionId":"00112233-4455-6677-8899-aabbccddeeff","generation":1,"createdByAnbo":true,"openedFrom":{"selectionId":"aabbccdd-4455-6677-8899-001122334455","background":true,"agent":false}}"#,
        )
        .unwrap();
        assert_eq!(
            opened.opened_from,
            Some(OpenedFrom {
                selection_id: "aabbccdd-4455-6677-8899-001122334455".into(),
                background: true,
                agent: false,
            })
        );
        assert!(validate_tabs(std::slice::from_ref(&opened)).is_ok());
        let mut odd = opened.clone();
        odd.opened_from = Some(OpenedFrom {
            selection_id: "not-a-lease".into(),
            ..Default::default()
        });
        assert!(validate_tabs(&[odd]).is_err());
        assert!(serde_json::from_str::<Tab>(
            r#"{"id":12,"title":"","url":"https://example.com/","openedFrom":{"selectionId":"aabbccdd-4455-6677-8899-001122334455","later":1}}"#
        )
        .is_err());
        // A tab the user or an agent selected says nothing of an opener.
        let plain = Tab {
            id: 1,
            title: String::new(),
            url: "https://example.com/".into(),
            ..Default::default()
        };
        assert!(!serde_json::to_string(&plain)
            .unwrap()
            .contains("openedFrom"));
    }

    #[test]
    fn rejects_duplicate_ids_and_non_web_targets() {
        let tab = Tab {
            id: 1,
            title: "Example".into(),
            url: "https://example.com".into(),
            ..Default::default()
        };
        assert!(validate_tabs(std::slice::from_ref(&tab)).is_ok());
        assert!(validate_tabs(&[tab.clone(), tab]).is_err());
        assert!(validate_tabs(&[Tab {
            id: 1,
            title: String::new(),
            url: "chrome://settings".into(),
            ..Default::default()
        }])
        .is_err());
    }
}

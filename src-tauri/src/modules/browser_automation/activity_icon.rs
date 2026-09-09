use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

const REGISTRY: &str = include_str!("../../../../src/modules/agents/lib/agentIconAssets.json");
static ASSETS: LazyLock<HashMap<String, Asset>> =
    LazyLock::new(|| serde_json::from_str(REGISTRY).unwrap_or_default());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    light: String,
    dark: Option<String>,
    #[serde(default)]
    invert_on_dark: bool,
}

#[derive(Serialize)]
pub(super) struct Icon {
    source: String,
    invert: bool,
}

pub(super) fn for_brand(brand: &str) -> Option<Icon> {
    let (path, invert) = if brand == "anbo" {
        ("/logo.svg", false)
    } else {
        let asset = ASSETS.get(brand)?;
        (
            asset.dark.as_deref().unwrap_or(&asset.light),
            asset.dark.is_none() && asset.invert_on_dark,
        )
    };
    let bytes: &[u8] = match path {
        "/agent-icons/claude.svg" => include_bytes!("../../../../public/agent-icons/claude.svg"),
        "/agent-icons/codex-dark.svg" => {
            include_bytes!("../../../../public/agent-icons/codex-dark.svg")
        }
        "/agent-icons/antigravity.svg" => {
            include_bytes!("../../../../public/agent-icons/antigravity.svg")
        }
        "/agent-icons/pi.svg" => include_bytes!("../../../../public/agent-icons/pi.svg"),
        "/agent-icons/opencode-dark.svg" => {
            include_bytes!("../../../../public/agent-icons/opencode-dark.svg")
        }
        "/agent-icons/grok-dark.svg" => {
            include_bytes!("../../../../public/agent-icons/grok-dark.svg")
        }
        "/logo.svg" => include_bytes!("../../../../public/logo.svg"),
        _ => return None,
    };
    let mime = if path.ends_with(".png") {
        "image/png"
    } else {
        "image/svg+xml"
    };
    Some(Icon {
        source: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        invert,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_registered_brands_use_bounded_embedded_assets() {
        let assets: HashMap<String, Asset> = serde_json::from_str(REGISTRY).unwrap();
        assert!(!assets.is_empty());
        for brand in assets.keys().map(String::as_str).chain(["anbo"]) {
            let icon = for_brand(brand).expect("registered brand has a native icon");
            assert!(icon.source.starts_with("data:image/"));
            assert!(icon.source.len() < 100_000);
            assert!(!base64::engine::general_purpose::STANDARD
                .decode(icon.source.split_once(',').unwrap().1)
                .unwrap()
                .is_empty());
        }
        // Every monochrome brand ships an explicit dark asset, so the CSS
        // invert fallback stays off for all of them.
        assert!(assets.keys().all(|brand| !for_brand(brand).unwrap().invert));
    }

    #[test]
    fn unknown_brand_cannot_load_an_arbitrary_asset() {
        for brand in [
            "remote",
            "https://example.com/icon.svg",
            "../../secrets",
            "",
        ] {
            assert!(for_brand(brand).is_none());
        }
    }
}

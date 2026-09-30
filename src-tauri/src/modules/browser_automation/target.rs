use crate::modules::browser_external::ExternalTarget;
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview};

#[derive(Clone)]
pub enum BrowserTarget {
    Embedded(Webview),
    External {
        app: AppHandle,
        target: ExternalTarget,
        label: String,
    },
}

impl From<Webview> for BrowserTarget {
    fn from(webview: Webview) -> Self {
        Self::Embedded(webview)
    }
}

impl BrowserTarget {
    pub fn label(&self) -> &str {
        match self {
            Self::Embedded(webview) => webview.label(),
            Self::External { label, .. } => label,
        }
    }

    pub fn app_handle(&self) -> &AppHandle {
        match self {
            Self::Embedded(webview) => webview.app_handle(),
            Self::External { app, .. } => app,
        }
    }

    pub fn embedded(&self) -> Result<&Webview, String> {
        match self {
            Self::Embedded(webview) => Ok(webview),
            Self::External { .. } => Err("this operation requires an embedded browser".into()),
        }
    }

    pub fn url(&self) -> Result<url::Url, String> {
        match self {
            Self::Embedded(webview) => webview.url().map_err(|error| error.to_string()),
            Self::External { target, .. } => {
                url::Url::parse(&target.info()?.url).map_err(|error| error.to_string())
            }
        }
    }

    pub async fn navigate(&self, url: url::Url) -> Result<(), String> {
        match self {
            Self::Embedded(webview) => webview.navigate(url).map_err(|error| error.to_string()),
            Self::External { target, .. } => {
                let result = target
                    .call(
                        "Page.navigate",
                        serde_json::json!({"url":url.as_str()}),
                        Duration::from_secs(10),
                    )
                    .await?;
                if let Some(error) = result.get("errorText").and_then(serde_json::Value::as_str) {
                    return Err(error.into());
                }
                Ok(())
            }
        }
    }

    pub fn eval(&self, script: impl Into<String>) -> Result<(), String> {
        let script = script.into();
        match self {
            Self::Embedded(webview) => webview.eval(script).map_err(|error| error.to_string()),
            Self::External { target, .. } => target.eval(script),
        }
    }
}

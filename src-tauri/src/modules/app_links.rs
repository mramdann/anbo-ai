//! A link in Anbo's own windows that asks for a new window (`target=_blank`,
//! or a Ctrl or Shift click) opens in the system's browser, as the opener
//! plugin's script did. That script ran in every webview, Anbo's browser tabs
//! too, where it cancelled each such click and then could not reach Anbo, whose
//! IPC a tab does not serve: a `target=_blank` link, a Ctrl+click or a
//! Shift+click on a page did nothing. This copy stays out of the tabs, whose
//! pages open such links as a browser does, as new Anbo tabs (`new_tab.rs`).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("anbo-links")
        .js_init_script(include_str!("app_links.js").to_string())
        .build()
}

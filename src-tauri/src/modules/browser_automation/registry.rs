use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::Mutex as AsyncMutex;

use crate::modules::preview::embed::{embed_label, is_embed_tab_active, list_active_tab_ids};

static TAB_LOCKS: Mutex<Option<HashMap<i64, Arc<AsyncMutex<()>>>>> = Mutex::new(None);

fn locks() -> &'static Mutex<Option<HashMap<i64, Arc<AsyncMutex<()>>>>> {
    &TAB_LOCKS
}

pub fn get_tab_lock(tab_id: i64) -> Arc<AsyncMutex<()>> {
    let mut guard = locks().lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.entry(tab_id)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

pub fn get_active_tabs() -> Vec<i64> {
    list_active_tab_ids()
}

pub fn get_embed_webview(app: &AppHandle, tab_id: i64) -> Result<Webview, String> {
    if !is_embed_tab_active(tab_id) {
        return Err(format!("tab {tab_id} not found or closed"));
    }
    let label = embed_label(tab_id);
    app.get_webview(&label)
        .ok_or_else(|| format!("webview window for tab {tab_id} ({label}) is unavailable"))
}

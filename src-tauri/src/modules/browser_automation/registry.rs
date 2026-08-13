use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::Mutex as AsyncMutex;

use crate::modules::browser::embed::{embed_label, is_embed_tab_active, list_active_tab_ids};

static TAB_LOCKS: Mutex<Option<HashMap<i64, Weak<AsyncMutex<()>>>>> = Mutex::new(None);

pub fn get_tab_lock(tab_id: i64) -> Arc<AsyncMutex<()>> {
    let mut guard = TAB_LOCKS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = map.get(&tab_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    map.insert(tab_id, Arc::downgrade(&lock));
    lock
}

pub fn remove_tab_lock(tab_id: i64) {
    let Ok(mut guard) = TAB_LOCKS.lock() else {
        return;
    };
    if let Some(map) = guard.as_mut() {
        map.remove(&tab_id);
    }
}

pub fn clear_tab_locks() {
    if let Ok(mut guard) = TAB_LOCKS.lock() {
        if let Some(map) = guard.as_mut() {
            map.clear();
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_a_tab_lock_releases_its_registry_entry() {
        let first = get_tab_lock(991_337);
        remove_tab_lock(991_337);
        let second = get_tab_lock(991_337);
        assert!(!Arc::ptr_eq(&first, &second));
        remove_tab_lock(991_337);
    }
}

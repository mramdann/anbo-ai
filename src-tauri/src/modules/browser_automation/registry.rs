use super::target::BrowserTarget;
use crate::modules::{browser::embed, browser_external};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tauri::{AppHandle, Manager};
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
        if map
            .get(&tab_id)
            .is_some_and(|lock| lock.strong_count() == 0)
        {
            map.remove(&tab_id);
        }
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
    let mut tabs = list_active_tab_ids();
    tabs.extend(browser_external::target_ids());
    tabs
}

pub fn find_target(app: &AppHandle, tab_id: i64) -> Option<BrowserTarget> {
    if let Some(target) = browser_external::get_target(tab_id) {
        return Some(BrowserTarget::External {
            app: app.clone(),
            target,
            label: embed_label(tab_id),
        });
    }
    is_embed_tab_active(tab_id)
        .then(|| app.get_webview(&embed_label(tab_id)))
        .flatten()
        .map(BrowserTarget::Embedded)
}

pub fn get_embed_webview(app: &AppHandle, tab_id: i64) -> Result<BrowserTarget, String> {
    if let Some(target) = browser_external::get_target(tab_id) {
        super::activity::stage("running");
        return Ok(BrowserTarget::External {
            app: app.clone(),
            target,
            label: embed_label(tab_id),
        });
    }
    if !is_embed_tab_active(tab_id) {
        return Err(format!("tab {tab_id} not found or closed"));
    }
    let label = embed_label(tab_id);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview window for tab {tab_id} ({label}) is unavailable"))?;
    super::activity::stage("running");
    Ok(webview.into())
}

pub fn active_navigation_generation(tab_id: i64) -> Option<u64> {
    embed::active_navigation_generation(tab_id).or_else(|| {
        browser_external::get_target(tab_id)?
            .info()
            .ok()
            .map(|info| info.generation)
    })
}

pub fn active_local_root(tab_id: i64) -> Option<std::path::PathBuf> {
    embed::active_local_root(tab_id)
        .or_else(|| Some(browser_external::get_target(tab_id)?.workspace.into()))
}

pub fn active_loading(tab_id: i64) -> Option<bool> {
    embed::active_loading(tab_id).or_else(|| browser_external::get_target(tab_id)?.loading())
}

pub fn active_pending_url(tab_id: i64) -> Option<String> {
    embed::active_pending_url(tab_id)
        .or_else(|| browser_external::get_target(tab_id)?.pending_url())
}
pub fn set_active_loading(tab_id: i64, loading: bool) {
    if let Some(target) = browser_external::get_target(tab_id) {
        target.set_loading(loading);
    } else {
        embed::set_active_loading(tab_id, loading);
    }
}
pub fn set_active_pending_url(tab_id: i64, url: Option<String>) {
    if let Some(target) = browser_external::get_target(tab_id) {
        target.set_pending_url(url);
    } else {
        embed::set_active_pending_url(tab_id, url);
    }
}

pub async fn apply_viewport(
    target: &BrowserTarget,
    width: u32,
    height: u32,
    scale: f64,
    mobile: bool,
    fit: f64,
) -> Result<(), String> {
    if let BrowserTarget::Embedded(webview) = target {
        return embed::apply_viewport(webview, width, height, scale, mobile, fit).await;
    }
    let (method, params) = if width == 0 {
        (
            "Emulation.clearDeviceMetricsOverride",
            serde_json::json!({}),
        )
    } else {
        (
            "Emulation.setDeviceMetricsOverride",
            serde_json::json!({"width":width,"height":height,"deviceScaleFactor":scale,"mobile":mobile,"scale":fit}),
        )
    };
    super::cdp::call_devtools_protocol_method(
        target,
        method,
        &params.to_string(),
        std::time::Duration::from_secs(5),
    )
    .await?;
    super::cdp::call_devtools_protocol_method(
        target,
        "Emulation.setTouchEmulationEnabled",
        &serde_json::json!({"enabled":width>0 && mobile,"maxTouchPoints":if mobile {5} else {1}})
            .to_string(),
        std::time::Duration::from_secs(5),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_tab_keeps_the_same_lock_for_existing_owners_and_waiters() {
        let first = get_tab_lock(991_337);
        remove_tab_lock(991_337);
        let second = get_tab_lock(991_337);
        assert!(Arc::ptr_eq(&first, &second));
        drop(first);
        drop(second);
        remove_tab_lock(991_337);
        assert!(!TAB_LOCKS
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains_key(&991_337));
    }

    #[tokio::test]
    async fn cleanup_cannot_create_a_parallel_lock_while_a_close_is_waiting() {
        let first = get_tab_lock(991_339);
        let held = first.lock().await;
        let waiting = get_tab_lock(991_339);
        remove_tab_lock(991_339);
        let later = get_tab_lock(991_339);
        assert!(Arc::ptr_eq(&waiting, &later));
        assert!(later.try_lock().is_err());
        drop(held);
        assert!(later.try_lock().is_ok());
    }

    #[tokio::test]
    async fn cancelling_a_waiter_leaves_the_tab_lock_reusable() {
        let lock = get_tab_lock(991_338);
        let guard = lock.lock().await;
        let waiting_lock = Arc::clone(&lock);
        let waiter = tokio::spawn(async move {
            let _guard = waiting_lock.lock().await;
        });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter
            .await
            .expect_err("waiter should be cancelled")
            .is_cancelled());
        drop(guard);
        let reacquired =
            tokio::time::timeout(std::time::Duration::from_millis(250), lock.lock()).await;
        assert!(reacquired.is_ok());
        remove_tab_lock(991_338);
    }
}

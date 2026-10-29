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
    // A tab a page opened in the background is in Anbo before its page has
    // started, which can wait for memory: "webview window ... unavailable"
    // for 10 to 75 s said neither why nor whether a retry would help.
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| unstarted_page(tab_id, embed::spawn_failure(tab_id)))?;
    super::activity::stage("running");
    Ok(webview.into())
}

fn unstarted_page(tab_id: i64, failure: Option<String>) -> String {
    match failure {
        Some(reason) => format!(
            "tab {tab_id}'s page could not start: {reason}. Anbo starts it again when memory allows; retry, or close tabs you no longer need"
        ),
        None => format!(
            "tab {tab_id}'s page has not started yet (a tab opened in the background starts when Anbo has room for it); retry in a moment"
        ),
    }
}

/// Whether a tab lookup failed because the tab's page could not start for lack
/// of memory. Such a call answers `resource_exhausted`, as an open short of
/// memory does, not `tab_not_found` for a tab that is still there (round 70).
pub fn short_of_memory(message: &str) -> bool {
    message.contains("'s page could not start: resource_exhausted")
}

pub fn active_navigation_generation(tab_id: i64) -> Option<u64> {
    embed::active_navigation_generation(tab_id).or_else(|| {
        browser_external::get_target(tab_id)?
            .info()
            .ok()
            .map(|info| info.generation)
    })
}

/// The workspace of the tab a call on `tab_id` reaches: a Chrome or Edge
/// tab first, as `find_target` looks there first.
pub fn active_local_root(tab_id: i64) -> Option<std::path::PathBuf> {
    browser_external::get_target(tab_id)
        .map(|target| canonical_root(&target.workspace))
        .or_else(|| embed::active_local_root(tab_id))
}

/// A Chrome/Edge tab's workspace in the canonical form an embedded tab keeps.
/// Callers compare it with a canonicalized request: the raw `D:/...` never
/// matched `\\?\D:\...`, so every upload or download on such a tab was refused
/// as another workspace's, and the tab_in_use guard never saw its holder.
fn canonical_root(workspace: &str) -> std::path::PathBuf {
    std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.into())
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
    fn a_chrome_tabs_workspace_compares_like_a_canonicalized_request() {
        // Measured: browser_upload on Chrome/Edge tabs answered "tab N belongs to
        // a different workspace" for the tab's own workspace, slash or backslash.
        let dir = std::env::temp_dir().join(format!("anbo-root-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let requested = std::fs::canonicalize(&dir).unwrap();
        let forward = dir.to_string_lossy().replace('\\', "/");
        assert_eq!(canonical_root(&forward), requested);
        assert_eq!(canonical_root(&dir.to_string_lossy()), requested);
        std::fs::remove_dir_all(&dir).unwrap();
        let gone = dir.to_string_lossy().into_owned();
        assert_eq!(canonical_root(&gone), std::path::PathBuf::from(&gone));
    }

    #[test]
    fn a_page_that_could_not_start_for_memory_reads_as_short_of_memory() {
        // Measured (round 70): "[tab_not_found] tab 490's page could not start:
        // resource_exhausted ..." for a tab that was still in Anbo.
        let memory = unstarted_page(490, Some("resource_exhausted: not enough memory".into()));
        assert!(memory.starts_with("tab 490's page could not start: resource_exhausted"));
        assert!(short_of_memory(&memory));
        assert!(!short_of_memory(&unstarted_page(
            490,
            Some("the browser could not start".into())
        )));
        assert!(!short_of_memory(&unstarted_page(490, None)));
        assert!(!short_of_memory("tab 490 not found or closed"));
    }

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

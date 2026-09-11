use std::future::Future;

use super::protocol::error_codes;
use super::registry::get_tab_lock;
use super::snapshot::{commit_generation, peek_next_generation};

/// Run one scan under the tab lock, publishing its generation only if it used
/// it.
///
/// `earns_generation` answers whether the scan registered refs. A lookup that
/// matched nothing did not replace anything, so the refs the caller already
/// holds stay valid -- a mistyped selector should cost one failed call, not
/// every target in hand.
pub async fn scan_with_fresh_refs<T, F, Fut, E>(
    tab_id: i64,
    deadline: tokio::time::Instant,
    scan: F,
    earns_generation: E,
) -> Result<(u64, T), (String, String)>
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<T, (String, String)>>,
    E: FnOnce(&T) -> bool,
{
    let lock = get_tab_lock(tab_id);
    tokio::time::timeout_at(deadline, async {
        let _guard = lock.lock().await;
        let generation = peek_next_generation(tab_id);
        scan(generation).await.map(|result| {
            if earns_generation(&result) {
                commit_generation(tab_id, generation);
            }
            (generation, result)
        })
    })
    .await
    .map_err(|_| {
        (
            error_codes::TIMEOUT.to_string(),
            "browser reference scan exceeded its deadline".to_string(),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::browser_automation::snapshot::{
        commit_generation, get_current_generation, remove_generation,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn queued_scans_do_not_invalidate_the_current_generation() {
        let tab_id = -810_001;
        let lock = get_tab_lock(tab_id);
        let held = lock.lock().await;
        let generation = 1;
        commit_generation(tab_id, generation);
        let waiting = tokio::spawn(scan_with_fresh_refs(
            tab_id,
            tokio::time::Instant::now() + Duration::from_secs(1),
            |next| async move { Ok(next) },
            |_| true,
        ));
        tokio::task::yield_now().await;
        assert_eq!(get_current_generation(tab_id), generation);
        drop(held);
        let (next, value) = waiting.await.unwrap().unwrap();
        assert_eq!(next, generation + 1);
        assert_eq!(value, next);
        remove_generation(tab_id);
    }

    #[tokio::test]
    async fn retry_after_an_intervening_scan_publishes_a_new_generation() {
        let tab_id = -810_002;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let (first, _) = scan_with_fresh_refs(tab_id, deadline, |_| async { Ok(()) }, |_| true)
            .await
            .unwrap();
        let (other, _) = scan_with_fresh_refs(tab_id, deadline, |_| async { Ok(()) }, |_| true)
            .await
            .unwrap();
        let (retry, _) = scan_with_fresh_refs(tab_id, deadline, |_| async { Ok(()) }, |_| true)
            .await
            .unwrap();
        assert!(first < other && other < retry);
        assert_eq!(get_current_generation(tab_id), retry);
        remove_generation(tab_id);
    }

    #[tokio::test]
    async fn deadline_includes_lock_wait_without_allocating_refs() {
        let tab_id = -810_003;
        let lock = get_tab_lock(tab_id);
        let _held = lock.lock().await;
        let error = scan_with_fresh_refs(
            tab_id,
            tokio::time::Instant::now() + Duration::from_millis(5),
            |_| async { Ok(()) },
            |_| true,
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, error_codes::TIMEOUT);
        assert_eq!(get_current_generation(tab_id), 0);
        remove_generation(tab_id);
    }

    #[tokio::test]
    async fn a_scan_that_registers_nothing_leaves_live_refs_alone() {
        // One mistyped selector used to retire every ref the caller held: the
        // scan claimed a generation before it knew whether it would use one.
        let tab_id = -810_005;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let (found, _) = scan_with_fresh_refs(tab_id, deadline, |g| async move { Ok(g) }, |_| true)
            .await
            .unwrap();
        assert_eq!(get_current_generation(tab_id), found);

        for _ in 0..5 {
            let (claimed, _) =
                scan_with_fresh_refs(tab_id, deadline, |g| async move { Ok(g) }, |_| false)
                    .await
                    .unwrap();
            // The number it would have taken is handed back for the scan's own
            // refs, but the page still answers for the generation that matched.
            assert_eq!(claimed, found + 1);
            assert_eq!(get_current_generation(tab_id), found);
        }

        // The next scan that does match publishes the very next number, so
        // nothing is burned by the failures in between.
        let (next, _) = scan_with_fresh_refs(tab_id, deadline, |g| async move { Ok(g) }, |_| true)
            .await
            .unwrap();
        assert_eq!(next, found + 1);
        assert_eq!(get_current_generation(tab_id), next);
        remove_generation(tab_id);
    }

    #[tokio::test]
    async fn a_stalled_scan_expires_and_releases_the_tab_lock() {
        let tab_id = -810_004;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5);
        let error =
            scan_with_fresh_refs::<(), _, _, _>(tab_id, deadline, |_| std::future::pending(), |_| {
                true
            })
            .await
            .unwrap_err();
        assert_eq!(error.0, error_codes::TIMEOUT);
        let lock = get_tab_lock(tab_id);
        assert!(lock.try_lock().is_ok());
        remove_generation(tab_id);
    }
}

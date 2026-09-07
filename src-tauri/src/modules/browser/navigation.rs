pub fn update_needs_navigation(current: &str, target: &str, pending: Option<&str>) -> bool {
    current != target && pending != Some(target)
}

#[cfg(test)]
mod tests {
    use super::update_needs_navigation;

    #[test]
    fn layout_updates_do_not_restart_an_uncommitted_navigation() {
        let target = "https://example.com/slow";
        assert!(!update_needs_navigation(
            "about:blank",
            target,
            Some(target)
        ));
        assert!(!update_needs_navigation(
            "https://example.com/old",
            target,
            Some(target)
        ));
    }

    #[test]
    fn a_new_target_can_replace_a_pending_navigation() {
        assert!(update_needs_navigation(
            "about:blank",
            "https://example.com/new",
            Some("https://example.com/slow"),
        ));
    }

    #[test]
    fn completed_and_failed_navigations_keep_existing_update_behavior() {
        let target = "https://example.com/";
        assert!(!update_needs_navigation(target, target, None));
        assert!(update_needs_navigation("about:blank", target, None));
        assert!(!update_needs_navigation(
            target,
            target,
            Some("https://example.com/new")
        ));
    }
}

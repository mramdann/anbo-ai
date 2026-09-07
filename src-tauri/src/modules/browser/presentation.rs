pub fn background_origin(width: i32) -> (i32, i32) {
    ((-width.max(1)).saturating_sub(64), 0)
}

#[cfg(test)]
mod tests {
    use super::background_origin;

    #[test]
    fn background_host_stays_outside_its_parent_without_clipping() {
        for width in [1, 64, 800, 1920, 7680, i32::MAX - 64, i32::MAX] {
            let (left, top) = background_origin(width);
            assert!(i64::from(left) + i64::from(width) < 0);
            assert_eq!(top, 0);
        }
    }

    #[test]
    fn normal_background_hosts_have_a_restore_animation_margin() {
        assert_eq!(background_origin(1280), (-1344, 0));
        assert_eq!(background_origin(0), (-65, 0));
        assert_eq!(background_origin(-1), (-65, 0));
    }
}

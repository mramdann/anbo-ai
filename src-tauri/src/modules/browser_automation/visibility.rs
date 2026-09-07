pub const VISIBILITY_JS: &str = r#"
    const isRenderedElement = el => {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
        }
        let current = el;
        for (let depth = 0; current && depth <= 256; depth++) {
            const style = getComputedStyle(current);
            if (style.display === 'none' || Number(style.opacity || 1) === 0 ||
                (current !== el && style.contentVisibility === 'hidden') ||
                (current === el && (style.visibility === 'hidden' || style.visibility === 'collapse'))) return false;
            current = current.assignedSlot || current.parentElement || current.getRootNode?.().host || null;
        }
        return current === null;
    };
"#;

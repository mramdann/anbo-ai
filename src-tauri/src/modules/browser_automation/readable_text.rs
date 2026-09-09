pub const READABLE_TEXT_JS: &str = r#"
    const clipReadableText = (value, max) => {
        let end = Math.min(value.length, max);
        if (end > 0 && end < value.length && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF && value.charCodeAt(end) >= 0xDC00 && value.charCodeAt(end) <= 0xDFFF) end--;
        return value.slice(0, end);
    };
    const readableText = root => {
        const parts = [];
        let size = 0;
        let visited = 0;
        let sourceTruncated = false;
        const visit = (node, depth, visible = true) => {
            if (visited >= 50000 || depth > 256 || size > 16000) { sourceTruncated = true; return; }
            visited++;
            if (node.nodeType === 3) {
                if (!visible) return;
                const value = String(node.textContent || '').trim();
                if (value) { const piece = clipReadableText(value, Math.max(0, 16001 - size)); parts.push(piece); size += piece.length + 1; sourceTruncated ||= piece.length < value.length; }
                return;
            }
            if (node.nodeType !== 1 && node.nodeType !== 11) return;
            if (node.nodeType === 1) {
                if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','ANBO-AUTOMATION-VISUAL'].includes(String(node.tagName).toUpperCase()) || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity || 1) === 0) return;
                visible = style.visibility !== 'hidden' && style.visibility !== 'collapse';
            }
            const assigned = String(node.tagName).toUpperCase() === 'SLOT' ? node.assignedNodes?.() : null;
            const children = node.shadowRoot ? [node.shadowRoot] : (assigned?.length ? assigned : node.childNodes);
            for (const child of children) {
                visit(child, depth + 1, visible);
                if (visited >= 50000 || size > 16000) { sourceTruncated = true; break; }
            }
        };
        const parent = node => {
            if (node.assignedSlot) return node.assignedSlot;
            const ancestor = node.parentElement;
            if (ancestor?.shadowRoot || (String(ancestor?.tagName).toUpperCase() === 'SLOT' && ancestor.assignedNodes?.().length)) return false;
            return ancestor || node.getRootNode?.().host || null;
        };
        let ancestor = parent(root);
        for (let depth = 0; ancestor && depth <= 256; ancestor = parent(ancestor), depth++) {
            const style = getComputedStyle(ancestor);
            if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity || 1) === 0) return {text:'', sourceTruncated:false};
        }
        if (ancestor === false) return {text:'', sourceTruncated:false};
        if (ancestor) return {text:'', sourceTruncated:true};
        visit(root, 0);
        return {text:parts.join('\n'), sourceTruncated};
    };
"#;

pub const READABLE_TEXT_JS: &str = r#"
    const normalizeLoose = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Whether the visible text under `root` contains `needle`, compared after
    // whitespace and case normalization. This is a streaming twin of
    // readableText: the same visibility rules, but one block at a time with an
    // early exit and no 16k cap, because a wait that reads the first 16k
    // characters of a big page can never see a dialog appended to its end.
    const readableTextContains = (root, needle) => {
        const wanted = normalizeLoose(needle);
        if (!wanted || !root) return false;
        let found = false;
        let visited = 0;
        let buffer = '';
        const flush = () => { if (buffer && normalizeLoose(buffer).includes(wanted)) found = true; buffer = ''; };
        const visit = (node, depth, visible = true) => {
            if (found || visited >= 200000 || depth > 256) return;
            visited++;
            if (node.nodeType === 3) { if (visible) buffer += String(node.textContent || ''); return; }
            if (node.nodeType !== 1 && node.nodeType !== 11) return;
            let block = false;
            if (node.nodeType === 1) {
                if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','ANBO-AUTOMATION-VISUAL','ANBO-DESIGN-LAYER'].includes(String(node.tagName).toUpperCase())) return;
                const style = getComputedStyle(node);
                if (style.display === 'none') return;
                block = !/^(inline|contents)/.test(String(style.display || ''));
                if (style.contentVisibility === 'hidden' || Number(style.opacity || 1) === 0) { if (block) flush(); return; }
                visible = style.visibility !== 'hidden' && style.visibility !== 'collapse';
            }
            if (block) flush();
            const assigned = String(node.tagName).toUpperCase() === 'SLOT' ? node.assignedNodes?.() : null;
            const children = node.shadowRoot ? [node.shadowRoot] : (assigned?.length ? assigned : node.childNodes);
            for (const child of children) { visit(child, depth + 1, visible); if (found) return; }
            if (block) flush();
        };
        visit(root, 0, true);
        flush();
        return found;
    };
    // Whether the page shows `needle` anywhere a reader would see it: the
    // title or the visible body text. The native innerText is the fast path,
    // layout-aware and unbounded; shadow trees are not part of it, so the
    // composed walk follows for those.
    const pageTextIncludes = needle => {
        const wanted = normalizeLoose(needle);
        if (!wanted) return false;
        if (normalizeLoose(document.title || '').includes(wanted)) return true;
        const body = document.body;
        if (!body) return false;
        if (typeof body.innerText === 'string' && normalizeLoose(body.innerText).includes(wanted)) return true;
        return readableTextContains(body, wanted);
    };
    const clipReadableText = (value, max) => {
        let end = Math.min(value.length, max);
        if (end > 0 && end < value.length && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF && value.charCodeAt(end) >= 0xDC00 && value.charCodeAt(end) <= 0xDFFF) end--;
        return value.slice(0, end);
    };
    const BREAK = '\u0000';
    const readableText = root => {
        const parts = [];
        let size = 0;
        let visited = 0;
        let sourceTruncated = false;
        const visit = (node, depth, visible = true) => {
            if (visited >= 50000 || depth > 256 || size > 16000) { sourceTruncated = true; return; }
            visited++;
            let block = false;
            if (node.nodeType === 3) {
                if (!visible) return;
                // Raw, not trimmed: the space between two inline spans lives in
                // a text node of its own, and trimming each node separately is
                // what glued "99.0" and "32" into a wrong number.
                const value = String(node.textContent || '');
                if (value) { const piece = clipReadableText(value, Math.max(0, 16001 - size)); parts.push(piece); size += piece.length; sourceTruncated ||= piece.length < value.length; }
                return;
            }
            if (node.nodeType !== 1 && node.nodeType !== 11) return;
            if (node.nodeType === 1) {
                if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','ANBO-AUTOMATION-VISUAL','ANBO-DESIGN-LAYER'].includes(String(node.tagName).toUpperCase()) || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
                const style = getComputedStyle(node);
                // display:none removes the box, so the text around it closes
                // up. An invisible box still holds its line, which is why the
                // break is decided before the content is skipped.
                if (style.display === 'none') return;
                // A line break belongs where the layout puts one. Inline boxes
                // sit on the same line however many elements they are split
                // across, which is how a ticker renders a changing digit.
                block = !/^(inline|contents)/.test(String(style.display || ''));
                if (style.contentVisibility === 'hidden' || Number(style.opacity || 1) === 0) {
                    if (block) parts.push(BREAK);
                    return;
                }
                visible = style.visibility !== 'hidden' && style.visibility !== 'collapse';
            }
            if (block) parts.push(BREAK);
            const assigned = String(node.tagName).toUpperCase() === 'SLOT' ? node.assignedNodes?.() : null;
            const children = node.shadowRoot ? [node.shadowRoot] : (assigned?.length ? assigned : node.childNodes);
            for (const child of children) {
                visit(child, depth + 1, visible);
                if (visited >= 50000 || size > 16000) { sourceTruncated = true; break; }
            }
            if (block) parts.push(BREAK);
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
        // One rule for the whole tree: inline runs join as they were written,
        // layout boundaries become lines, and each line collapses its own
        // whitespace. get_text, find and the accessible name all read the same
        // element the same way now.
        const text = parts.join('')
            .split(BREAK)
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
        return {text, sourceTruncated};
    };
"#;

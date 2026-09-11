const nameNormalize = value => String(value || '').slice(0, 4096).replace(/\s+/g, ' ').trim();
const NAME_BREAK = '\u0000';
const nameContent = (root, includeHidden = false) => {
    let remaining = 256;
    let length = 0;
    const parts = [];
    const visit = node => {
        let block = false;
        if (!node || remaining-- <= 0 || length >= 4096) return;
        if (node.nodeType === 3) {
            const text = (node.textContent || '').slice(0, 4096 - length);
            parts.push(text);
            length += text.length;
            return;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) return;
        if (node.nodeType === 1) {
            if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'ANBO-AUTOMATION-VISUAL'].includes(node.tagName)) return;
            if (!includeHidden) {
                if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
                // Same rule the readable text uses: only a layout boundary
                // separates words. Joining every text node with a space turned
                // a ticker's "99.032" into "99.0 32".
                block = !/^(inline|contents)/.test(String(style.display || ''));
            }
            const alternative = node !== root && (node.getAttribute('aria-label') || node.getAttribute('alt'));
            if (alternative) {
                const text = nameNormalize(alternative).slice(0, 4096 - length);
                parts.push(text);
                length += text.length;
                return;
            }
        }
        if (block) parts.push(NAME_BREAK);
        const children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
        for (const child of children || []) {
            if (remaining <= 0 || length >= 4096) break;
            visit(child);
        }
        if (block) parts.push(NAME_BREAK);
    };
    visit(root);
    return nameNormalize(parts.join('').split(NAME_BREAK).map(part => part.trim()).filter(Boolean).join(' '));
};
const labelName = el => {
    if (!el || !el.getAttribute) return '';
    const root = el.getRootNode ? el.getRootNode() : document;
    const ids = nameNormalize(el.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean).slice(0, 32);
    const referenced = ids.map(id => root.getElementById ? root.getElementById(id) : null).filter(Boolean);
    if (referenced.length) return nameNormalize(referenced.map(node => nameContent(node, true)).join(' '));
    const aria = nameNormalize(el.getAttribute('aria-label'));
    if (aria) return aria;
    return el.labels ? nameNormalize(Array.from(el.labels).slice(0, 32).map(node => nameContent(node, true)).join(' ')) : '';
};
const accessibleName = el => {
    if (!el || !el.getAttribute) return '';
    const label = labelName(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
    if (tag === 'img' || type === 'image') return nameNormalize(el.getAttribute('alt') || el.getAttribute('title'));
    if (['button', 'submit', 'reset'].includes(type)) {
        return nameNormalize(el.value || el.getAttribute('title') || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return nameNormalize(el.getAttribute('title') || el.getAttribute('placeholder'));
    }
    return nameContent(el) || nameNormalize(el.getAttribute('title'));
};

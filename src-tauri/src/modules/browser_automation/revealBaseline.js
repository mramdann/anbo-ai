const REVEAL_DIALOGS = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';

const revealQueryOf = text => String(text || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();

// The nearest ancestor that repeats like a list row: it has parts of its own
// and a sibling of the same tag and class. Eight levels up at most, never the
// host itself.
function revealRowOf(node, host) {
    for (let current = node, depth = 0; current && current !== host && depth < 8; current = current.parentElement, depth++) {
        const parent = current.parentElement;
        if (!parent || current.children.length < 2) continue;
        for (const sibling of parent.children) {
            if (sibling !== current && sibling.localName === current.localName && sibling.className === current.className) return current;
        }
    }
    return null;
}

// Rows inside `host` holding text that contains `query`, in document order.
// Bounded by text nodes read, not by the size of the host.
function revealQueryRows(host, query, limit) {
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let scanned = 0;
    for (let text = walker.nextNode(); text && ++scanned <= 3000 && out.length <= limit; text = walker.nextNode()) {
        if (!String(text.nodeValue || '').toLocaleLowerCase().includes(query)) continue;
        const row = revealRowOf(text.parentElement, host);
        if (!row || seen.has(row)) continue;
        seen.add(row);
        out.push(row);
    }
    return out;
}

function captureRevealBaseline(el, text) {
    if ((el.getAttribute('aria-controls') || '').trim() || (el.getAttribute('aria-owns') || '').trim()) return null;
    try {
        const nodes = new WeakSet();
        let scanned = 0;
        let dialog = false;
        let complete = true;
        for (const node of document.querySelectorAll('[role="listbox"],[role="menu"],[role="tree"],[role="grid"],[role="dialog"],[role="alertdialog"],dialog[open]')) {
            if (++scanned > 64) { complete = false; break; }
            if (!isRenderedElement(node)) continue;
            nodes.add(node);
            dialog ||= /dialog/.test(node.getAttribute('role') || node.localName);
        }
        // A field already inside an open dialog gets its results in that dialog
        // (TradingView's symbol search). Rows that carried the text before the
        // fill are remembered, so a default list is never read as the answer.
        const host = el.closest ? el.closest(REVEAL_DIALOGS) : null;
        const query = revealQueryOf(text);
        const hostRows = host && query.length >= 2 ? new WeakSet(revealQueryRows(host, query, 200)) : null;
        const key = '__anboRevealBaseline';
        const token = ((globalThis[key]?.token || 0) % Number.MAX_SAFE_INTEGER) + 1;
        globalThis[key] = {
            token, target: new WeakRef(el), nodes, dialog, complete, created: Date.now(),
            host: hostRows ? new WeakRef(host) : null, hostRows,
        };
        return token;
    } catch {
        return null;
    }
}

function readRevealBaseline(el, token) {
    const state = globalThis.__anboRevealBaseline;
    return token != null && state?.token === token && state.target.deref() === el &&
        Date.now() - state.created <= 10000 ? state : null;
}

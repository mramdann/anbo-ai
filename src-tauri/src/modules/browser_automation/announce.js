// Live regions a click may post its outcome to: a form's "saved" status, an
// alert with the error. Their text is read right before the press and again
// after it, so the click's reply says what changed there: a submit used to
// come back with only an unchanged URL and title, and its confirmation cost a
// separate read.
const ANNOUNCE_REGIONS = '[role="status"],[role="alert"],[role="log"],[aria-live]:not([aria-live="off"]),output';
const ANNOUNCE_TEXT_LIMIT = 20000;

function announceState(node) {
    const text = String(node.textContent || '');
    if (text.length > ANNOUNCE_TEXT_LIMIT) return null;
    return { text: text.replace(/\s+/g, ' ').trim(), shown: isRenderedElement(node) };
}

function captureAnnounceBaseline(el) {
    try {
        const states = new WeakMap();
        let scanned = 0;
        for (const node of document.querySelectorAll(ANNOUNCE_REGIONS)) {
            if (++scanned > 32) break;
            states.set(node, announceState(node));
        }
        globalThis.__anboAnnounceBaseline = { target: new WeakRef(el), states, created: Date.now() };
    } catch {}
}

// A region whose text changed, or that came into view with text: the new part
// of a log, the whole of anything else. Read once, for the press it was taken for.
function readAnnounced(el, limit) {
    const baseline = globalThis.__anboAnnounceBaseline;
    if (!baseline || baseline.target.deref() !== el || Date.now() - baseline.created > 10000) return [];
    globalThis.__anboAnnounceBaseline = null;
    const out = [];
    try {
        let scanned = 0;
        for (const node of document.querySelectorAll(ANNOUNCE_REGIONS)) {
            if (++scanned > 32 || out.length >= limit) break;
            const now = announceState(node);
            if (!now || !now.text || !now.shown) continue;
            const before = baseline.states.has(node) ? baseline.states.get(node) : { text: '', shown: false };
            if (!before || before.text === now.text && before.shown) continue;
            if (out.some(entry => entry.node.contains(node) || node.contains(entry.node))) continue;
            const added = before.text && now.text.startsWith(before.text) ? now.text.slice(before.text.length).trim() : now.text;
            const text = added || now.text;
            const politeness = node.getAttribute('aria-live');
            out.push({
                node,
                role: node.getAttribute('role') || (politeness === 'assertive' ? 'alert' : 'status'),
                text: text.length > 300 ? text.slice(0, 299) + '…' : text,
            });
        }
    } catch {
        return [];
    }
    return out.map(({ role, text }) => ({ role, text }));
}

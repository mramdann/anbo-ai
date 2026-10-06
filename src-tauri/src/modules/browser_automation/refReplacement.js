// What took a detached ref's place: the one rendered element in the ref's
// document with the same tag, input type and accessible name. Wikipedia swaps
// its search field for a new node, with a new role, right after a click hands
// it back, and the agent spent a find to learn the ref of the same field. The
// element is only named: the stale ref is still refused and nothing is done
// with the replacement, so no similar target is ever acted on silently.
function refReplacement(old) {
    if (!old || !old.localName || old.isConnected) return null;
    const squashName = node => String(accessibleName(node) || '').replace(/\s+/g, ' ').trim();
    const name = squashName(old);
    if (!name) return null;
    const typeOf = node => node.localName === 'input' ? String(node.type || 'text').toLowerCase() : '';
    const type = typeOf(old);
    let found = null;
    let scanned = 0;
    for (const node of document.querySelectorAll(old.localName)) {
        if (++scanned > 2000) return null;
        if (!isRenderedElement(node) || typeOf(node) !== type || squashName(node) !== name) continue;
        if (found) return null;
        found = node;
    }
    return found;
}

function refRole(node) {
    const role = node.getAttribute('role');
    if (role) return role;
    if (node.localName === 'input') {
        const type = String(node.type || 'text').toLowerCase();
        if (type === 'search') return 'searchbox';
        if (['checkbox', 'radio', 'button'].includes(type)) return type;
        return 'textbox';
    }
    if (node.localName === 'a') return 'link';
    if (node.localName === 'textarea') return 'textbox';
    if (node.localName === 'select') return 'combobox';
    return node.localName;
}

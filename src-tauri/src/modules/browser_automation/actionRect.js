const actionRect = (element, position) => {
    const fragments = element.getClientRects();
    let first = null;
    for (let index = 0; index < Math.min(fragments.length, 32); index++) {
        const rect = fragments[index];
        if (rect.width <= 0 || rect.height <= 0) continue;
        first ||= rect;
        const x = rect.left + rect.width * (position?.x ?? 0.5);
        const y = rect.top + rect.height * (position?.y ?? 0.5);
        if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) return rect;
    }
    return first || element.getBoundingClientRect();
};
const actionPoint = (element, position) => {
    const rect = actionRect(element, position);
    const x = rect.left + rect.width * (position?.x ?? 0.5);
    const y = rect.top + rect.height * (position?.y ?? 0.5);
    return { x, y, width: rect.width, height: rect.height,
        centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2,
        inViewport: Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight };
};
const ACTION_CONTROL = 'button,a[href],summary,label,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"]';
// Where the pointer at point would land: 'element' (on element, or on the
// control whose words or icon it is), 'other' (another element takes it),
// 'none' (the hit test names no element there) or 'outside' (off the
// viewport). It names none at an in-viewport point outside the page's content
// area, such as on its own scrollbar, which innerWidth counts, and did for
// five seconds at a textarea on an Edge tab the dock had just left. Nothing
// covers the point then.
const actionPointerHit = (element, point) => {
    if (!point.inViewport) return 'outside';
    const root = element.getRootNode?.();
    const source = root && typeof root.elementFromPoint === 'function' ? root : document;
    const first = source.elementFromPoint(point.x, point.y);
    if (!first) return 'none';
    let hit = first;
    for (let depth = 0; hit && depth < 257; depth++) {
        if (hit === element) return 'element';
        hit = hit.assignedSlot || hit.parentNode || hit.host || null;
    }
    // The words or icon of a control are part of it: YouTube lays a full-size
    // ::after over its Skip button, so the button answers the hit test, not
    // the "Skip" text an agent found, and the click lands on that button. A
    // target that is a control itself stays strict.
    if (element.matches?.(ACTION_CONTROL)) return 'other';
    const owner = element.parentElement?.closest?.(ACTION_CONTROL);
    return owner && owner.contains(first) ? 'element' : 'other';
};
const receivesActionPointer = (element, point) => actionPointerHit(element, point) === 'element';
const prepareActionPoint = (element, scroll, position) => {
    let point = actionPoint(element, position);
    if (scroll && !receivesActionPointer(element, point)) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        point = { ...actionPoint(element, position), scrolled: true };
    }
    return point;
};

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
const receivesActionPointer = (element, point) => {
    if (!point.inViewport) return false;
    const root = element.getRootNode?.();
    const source = root && typeof root.elementFromPoint === 'function' ? root : document;
    const first = source.elementFromPoint(point.x, point.y);
    let hit = first;
    for (let depth = 0; hit && depth < 257; depth++) {
        if (hit === element) return true;
        hit = hit.assignedSlot || hit.parentNode || hit.host || null;
    }
    // The words or icon of a control are part of it: YouTube lays a full-size
    // ::after over its Skip button, so the button answers the hit test, not
    // the "Skip" text an agent found, and the click lands on that button. A
    // target that is a control itself stays strict.
    if (!first || element.matches?.(ACTION_CONTROL)) return false;
    const owner = element.parentElement?.closest?.(ACTION_CONTROL);
    return !!owner && owner.contains(first);
};
const prepareActionPoint = (element, scroll, position) => {
    let point = actionPoint(element, position);
    if (scroll && !receivesActionPointer(element, point)) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        point = { ...actionPoint(element, position), scrolled: true };
    }
    return point;
};

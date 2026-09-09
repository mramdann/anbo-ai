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
const receivesActionPointer = (element, point) => {
    if (!point.inViewport) return false;
    const root = element.getRootNode?.();
    const source = root && typeof root.elementFromPoint === 'function' ? root : document;
    let hit = source.elementFromPoint(point.x, point.y);
    for (let depth = 0; hit && depth < 257; depth++) {
        if (hit === element) return true;
        hit = hit.assignedSlot || hit.parentNode || hit.host || null;
    }
    return false;
};
const prepareActionPoint = (element, scroll, position) => {
    let point = actionPoint(element, position);
    if (scroll && !receivesActionPointer(element, point)) {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        point = actionPoint(element, position);
    }
    return point;
};

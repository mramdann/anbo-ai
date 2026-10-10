// Why a point inside el cannot take the pointer, in the fractions of el that
// positions take: the part of el inside the viewport and, when another
// element covers the point, what covers it and where the same row and column
// of el are free. It runs once, when a pointer action gives up, so its hit
// tests cost nothing while the action waits.
if (!el) return JSON.stringify(null);
const rect = el.getBoundingClientRect();
if (!(rect.width > 0 && rect.height > 0)) return JSON.stringify(null);
const fx = position ? position.x : 0.5, fy = position ? position.y : 0.5;
const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
const root = el.getRootNode?.();
const source = root && typeof root.elementFromPoint === 'function' ? root : document;
const inside = (px, py) => px >= 0 && py >= 0 && px < innerWidth && py < innerHeight;
const reaches = (px, py) => {
    if (!inside(px, py)) return false;
    for (let hit = source.elementFromPoint(px, py), depth = 0; hit && depth < 257; depth++) {
        if (hit === el) return true;
        hit = hit.assignedSlot || hit.parentNode || hit.host || null;
    }
    return false;
};
const clamp = (value) => Math.min(1, Math.max(0, value));
const span = (from, to) => (to > from ? [from, to] : null);
const visible = {
    x: span(clamp(-rect.left / rect.width), clamp((innerWidth - rect.left) / rect.width)),
    y: span(clamp(-rect.top / rect.height), clamp((innerHeight - rect.top) / rect.height)),
};
// The longest free stretch along one line through el, in 48 steps; its ends
// are sample points that took the hit test, so a position on them is free.
const freeRun = (at) => {
    const steps = 48;
    let best = null, start = -1;
    for (let index = 0; index <= steps; index++) {
        const free = index < steps && reaches(...at((index + 0.5) / steps));
        if (free && start < 0) start = index;
        if (!free && start >= 0) {
            if (!best || index - start > best[1] - best[0]) best = [start, index];
            start = -1;
        }
    }
    return best && [(best[0] + 0.5) / steps, (best[1] - 0.5) / steps];
};
let covered = null;
if (inside(x, y) && !reaches(x, y)) {
    // Named by the outermost element of the covering subtree that says what
    // it is (a role or a label), else by that subtree's root: a hit test lands
    // on some leaf inside a panel, and the panel is what the caller can act on.
    const hit = source.elementFromPoint(x, y);
    let label = '', top = hit;
    for (let node = hit, depth = 0; node && depth < 64; depth++) {
        const name = (node.getAttribute?.('aria-label') || '').trim().replace(/\s+/g, ' ');
        const role = node.getAttribute?.('role') || '';
        if (name || (role && !['presentation', 'none', 'generic'].includes(role))) {
            label = (role || node.tagName.toLowerCase()) + (name ? " '" + name.slice(0, 48) + "'" : '');
        }
        top = node;
        const parent = node.parentElement || node.parentNode?.host || null;
        if (!parent || parent.contains(el)) break;
        node = parent;
    }
    if (!label && top) label = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '');
    covered = {
        by: label,
        row: freeRun((t) => [rect.left + rect.width * t, y]),
        column: freeRun((t) => [x, rect.top + rect.height * t]),
    };
}
return JSON.stringify({ visible, covered });

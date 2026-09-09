if (!el) return { ok: false, error: 'stale_ref', reason: refRegistry.reason(refId) };
if (!isRenderedElement(el)) return { ok: false, reason: 'hidden' };
if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
const point = actionPoint(el);
if (!point.inViewport || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(point.x - x) > 0.5 || Math.abs(point.y - y) > 0.5) {
    return { ok: false, reason: 'moved' };
}
if (!receivesActionPointer(el, { ...point, x, y })) return { ok: false, reason: 'covered' };
return { ok: true };

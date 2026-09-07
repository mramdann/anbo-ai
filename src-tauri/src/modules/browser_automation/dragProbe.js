if (!source || !destination || source.getAttribute('data-anbo-gen') !== generation || destination.getAttribute('data-anbo-gen') !== generation) {
    return JSON.stringify({error:'stale_ref'});
}
if (scroll) {
    source.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    destination.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
}
const inspect = (el, name) => {
    if (!isRenderedElement(el)) return {error:name + ' is not visible'};
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return {error:name + ' is disabled'};
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
        return {error:name + ' is outside the viewport; both drag endpoints must be visible together'};
    }
    const root = el.getRootNode();
    let hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
    for (let depth = 0; hit && depth < 256; depth++) {
        if (hit === el) return {x,y};
        hit = hit.parentNode || hit.host || null;
    }
    return {error:name + ' is covered by another element'};
};
const from = inspect(source, 'drag source'), to = inspect(destination, 'drag target');
return JSON.stringify(from.error ? from : to.error ? to : {points:[from.x,from.y,to.x,to.y]});

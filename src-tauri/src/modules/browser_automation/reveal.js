// Wait out the surface an action opens (autocomplete listbox, menu, dialog)
// and hand its items back as refs in the same reply. Without this the caller
// spends a whole round trip discovering that a suggestion list arrived, which
// costs far more than the bounded wait does.
function revealAfterAction(el, options, refRegistry) {
    const budgetMs = options.budgetMs;
    // A click on a control that declares nothing gets no wait at all: ten
    // sessions of the heavy suite opened no undeclared menu, so sweeping the
    // document for one was paid for by every click and repaid none of them.
    const declaredOnly = !!options.declaredOnly;
    const refPrefix = options.refPrefix;
    const limit = options.limit;
    const before = options.before || null;
    const SURFACE_SELECTOR =
        '[role="listbox"],[role="menu"],[role="tree"],[role="grid"],[role="dialog"],[role="alertdialog"],dialog[open]';
    const ITEM_SELECTOR =
        '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[role="row"]';
    const FALLBACK_ITEM_SELECTOR = 'li,a[href],button';
    const MAX_POLLS = 14;

    const signature = () => ({
        url: String(location.href).slice(0, 2000),
        title: String(document.title || '').slice(0, 500),
        height: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
    });

    const surfaceRole = node => {
        const role = node.getAttribute && node.getAttribute('role');
        if (role) return role;
        return node.localName === 'dialog' ? 'dialog' : 'listbox';
    };

    // Only the surface this element says it owns. A page that declares the
    // relationship is never guessed at.
    const declaredSurfaces = () => {
        if (!el || !el.getAttribute) return [];
        const ids = ((el.getAttribute('aria-controls') || '') + ' ' + (el.getAttribute('aria-owns') || ''))
            .split(/\s+/).filter(Boolean).slice(0, 8);
        if (!ids.length) return [];
        const root = el.getRootNode ? el.getRootNode() : document;
        const out = [];
        for (const id of ids) {
            const node = (root && root.getElementById ? root.getElementById(id) : null) ||
                (document.getElementById ? document.getElementById(id) : null);
            if (node && !out.includes(node)) out.push(node);
        }
        return out;
    };

    const visibleSurfaces = () => {
        const out = [];
        let scanned = 0;
        for (const node of document.querySelectorAll(SURFACE_SELECTOR)) {
            if (++scanned > 64) break;
            if (isRenderedElement(node)) out.push(node);
        }
        return out;
    };

    const itemsOf = surface => {
        const out = [];
        const seen = new Set();
        const take = selector => {
            let scanned = 0;
            for (const node of surface.querySelectorAll(selector)) {
                if (++scanned > 400 || out.length > limit) break;
                if (seen.has(node) || node === surface) continue;
                if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') continue;
                if (!isRenderedElement(node)) continue;
                seen.add(node);
                out.push(node);
            }
        };
        take(ITEM_SELECTOR);
        if (!out.length) take(FALLBACK_ITEM_SELECTOR);
        return out;
    };

    const declared = declaredSurfaces();
    const declaresPopup = !!(el && el.getAttribute &&
        (declared.length || el.getAttribute('aria-haspopup') || el.getAttribute('aria-expanded') !== null));
    // Before the document is swept for a surface nobody declared: that sweep is
    // the cost, so a click that cannot open anything must not reach it.
    if (declaredOnly && !declaresPopup) {
        return Promise.resolve(JSON.stringify({
            ok: true, surface: null, count: 0, items: [], observed: {}, waitedMs: 0,
        }));
    }
    // A surface already open before the action is not something the action
    // revealed, so only the ones the page declares are read without proof.
    const baseline = declared.length ? [] : visibleSurfaces();
    const baselineDialog = baseline.some(node => /dialog/.test(surfaceRole(node)));
    const entry = signature();

    const candidate = () => {
        if (declared.length) {
            for (const node of declared) {
                if (isRenderedElement(node) && itemsOf(node).length) return node;
            }
            return null;
        }
        for (const node of visibleSurfaces()) {
            if (baseline.includes(node)) continue;
            if (/dialog/.test(surfaceRole(node)) || itemsOf(node).length) return node;
        }
        return null;
    };

    // The same nodes two frames running. A suggestion list that answers twice
    // replaces its rows between them, and a ref taken from the first answer is
    // detached before the caller can use it.
    const sameNodes = (a, b) =>
        !!a && !!b && a.length === b.length && a.every((node, index) => node === b[index]);

    return new Promise(resolve => {
        const started = Date.now();
        let polls = 0;
        let previous = null;
        let found = null;
        let frame = null;
        let timer = null;

        const finish = () => {
            if (frame !== null) cancelAnimationFrame(frame);
            if (timer !== null) clearTimeout(timer);
            frame = timer = null;
            const exit = signature();
            const nodes = found ? itemsOf(found) : [];
            const truncated = nodes.length > limit;
            const items = [];
            // A scan that started elsewhere can take the generation first. That
            // costs this reveal its refs, never the action's reply.
            try {
                if (nodes.length) {
                    refRegistry.begin(options.generation);
                    for (let index = 0; index < nodes.length && index < limit; index++) {
                        const node = nodes[index];
                        const ref = refPrefix + (index + 1);
                        refRegistry.remember(ref, node);
                        const role = (node.getAttribute && node.getAttribute('role')) || node.localName || 'option';
                        const selected = node.getAttribute && node.getAttribute('aria-selected');
                        items.push({
                            ref,
                            role,
                            name: accessibleName(node).slice(0, 120),
                            selected: selected === 'true' ? true : undefined,
                        });
                    }
                }
            } catch {
                items.length = 0;
            }
            const observed = {};
            if (exit.url !== entry.url) observed.urlChanged = exit.url;
            if (exit.title !== entry.title) observed.titleChanged = exit.title;
            if (found && /dialog/.test(surfaceRole(found)) && !baselineDialog) observed.dialogOpened = true;
            if (before) {
                if (before.url && before.url !== exit.url) observed.urlChanged = exit.url;
                if (before.title != null && before.title !== exit.title) observed.titleChanged = exit.title;
            }
            resolve(JSON.stringify({
                ok: true,
                surface: found ? surfaceRole(found) : null,
                expanded: !!(el && el.getAttribute && el.getAttribute('aria-expanded') === 'true'),
                count: items.length,
                truncated,
                items,
                observed,
                waitedMs: Date.now() - started,
            }));
        };

        // Watching a declared surface is two attribute reads, so it runs every
        // frame. The fallback has to sweep the document for a surface nobody
        // declared, so it is capped and gives the rest of the budget back.
        const tick = () => {
            frame = null;
            try {
                if (found) {
                    const current = itemsOf(found);
                    if (sameNodes(previous, current)) return finish();
                    previous = current;
                } else {
                    polls += 1;
                    if (!declared.length && polls > MAX_POLLS) return finish();
                    found = candidate();
                    if (found) previous = null;
                }
                frame = requestAnimationFrame(tick);
            } catch (error) {
                resolve(JSON.stringify({ ok: false, error: String(error && error.message || error).slice(0, 200) }));
            }
        };

        timer = setTimeout(finish, Math.max(0, budgetMs));
        frame = requestAnimationFrame(tick);
    });
}

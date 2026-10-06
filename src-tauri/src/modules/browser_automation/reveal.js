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
    const declaredIds = () => !el?.getAttribute ? [] :
        ((el.getAttribute('aria-controls') || '') + ' ' + (el.getAttribute('aria-owns') || ''))
            .split(/\s+/).filter(Boolean).slice(0, 8);
    const declaredSurfaces = ids => {
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

    // A control that declares nothing can still hand focus to a field it just
    // opened, a search dialog most often (TradingView's symbol search declares
    // no popup). That field is what the caller types into next, so it comes
    // back as a ref instead of costing a find. A few property reads, no wait.
    const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'hidden', 'color', 'file'];
    const focusHandoff = () => {
        let node = document.activeElement;
        for (let depth = 0; node && node.shadowRoot && node.shadowRoot.activeElement && depth < 8; depth++) {
            node = node.shadowRoot.activeElement;
        }
        if (!node || node === el || !node.getAttribute) return null;
        const type = String(node.type || 'text').toLowerCase();
        const entry = node.localName === 'textarea' || node.isContentEditable === true ||
            (node.localName === 'input' && !NOT_TEXT.includes(type));
        if (!entry || !isRenderedElement(node)) return null;
        const role = node.getAttribute('role') || (node.localName === 'input' && type === 'search' ? 'searchbox' : 'textbox');
        const inDialog = node.closest ? node.closest('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]') : null;
        return inDialog || role === 'searchbox' || role === 'combobox' ? { node, role } : null;
    };

    const ids = declaredIds();
    const declaresPopup = !!(el && el.getAttribute &&
        (ids.length || el.getAttribute('aria-haspopup') || el.getAttribute('aria-expanded') !== null));
    // Before the document is swept for a surface nobody declared: that sweep is
    // the cost, so a click that cannot open anything must not reach it.
    if (declaredOnly && !declaresPopup) {
        const focused = focusHandoff();
        const started = Date.now();
        const reply = items => JSON.stringify({
            ok: true, surface: items.length ? 'focus' : null, count: items.length, items, observed: {},
            announced: readAnnounced(el, options.announcedLimit || 3),
            waitedMs: Date.now() - started,
        });
        if (!focused) return Promise.resolve(reply([]));
        // A dialog still mounting rewrites the item context around its field, so a
        // ref taken on the first frame was stale by the caller's next call (every
        // TradingView session in v37). The field is handed back only once its ref
        // resolves on two frames running, re-registered whenever it went stale;
        // one that never settles within the budget is not handed back at all.
        const ref = refPrefix + '1';
        const register = () => {
            refRegistry.begin(options.generation);
            refRegistry.remember(ref, focused.node);
        };
        try { register(); } catch { return Promise.resolve(reply([])); }
        return new Promise(resolve => {
            let steady = 0;
            let frame = null;
            let timer = null;
            const done = items => {
                if (frame !== null) cancelAnimationFrame(frame);
                if (timer !== null) clearTimeout(timer);
                frame = timer = null;
                resolve(reply(items));
            };
            const tick = () => {
                frame = null;
                try {
                    if (refRegistry.resolve(ref) === focused.node) steady += 1;
                    else { steady = 0; register(); }
                    if (steady >= 2) {
                        return done([{ ref, role: focused.role, name: accessibleName(focused.node).slice(0, 120) }]);
                    }
                    frame = requestAnimationFrame(tick);
                } catch {
                    done([]);
                }
            };
            timer = setTimeout(() => done([]), Math.max(0, Math.min(budgetMs, 400)));
            frame = requestAnimationFrame(tick);
        });
    }
    // A surface already open before the action is not something the action
    // revealed, so only the ones the page declares are read without proof.
    const captured = readRevealBaseline(el, before?.revealToken);
    const existing = ids.length || captured ? [] : visibleSurfaces();
    const baseline = captured?.nodes || new WeakSet(existing);
    const baselineDialog = captured?.dialog ?? existing.some(node => /dialog/.test(surfaceRole(node)));
    const entry = signature();

    // A field inside a dialog that was already open (TradingView's symbol
    // search) fills that same dialog with rows no ARIA role names, so no
    // surface opens. Rows that repeat like list rows and carry the typed text
    // are the results, unless they already carried it before the fill: a
    // default list is never mistaken for an answer.
    const query = String(options.query || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const rowsHost = (!declaredOnly && query.length >= 2 && captured?.host?.deref?.()) || null;
    // TradingView lays each row out with display: contents, so the row has no
    // box of its own; its first rendered part carrying the query stands in for
    // it (a click there bubbles to the row), and the row still names the item.
    const rowNames = new WeakMap();
    const renderedPart = row => {
        if (isRenderedElement(row)) return row;
        for (const child of row.children) {
            if (isRenderedElement(child) && String(child.textContent || '').toLocaleLowerCase().includes(query)) return child;
        }
        return null;
    };
    const textRows = () => {
        if (!rowsHost || !rowsHost.isConnected) return [];
        const out = [];
        for (const row of revealQueryRows(rowsHost, query, limit)) {
            if (captured.hostRows.has(row) || row.contains(el)) continue;
            const target = renderedPart(row);
            if (!target) continue;
            rowNames.set(target, row);
            out.push(target);
        }
        return out;
    };
    const itemsFor = surface => (surface && surface === rowsHost ? textRows() : itemsOf(surface));

    const candidate = () => {
        const currentIds = declaredIds();
        if (currentIds.length) {
            for (const node of declaredSurfaces(currentIds)) {
                if (isRenderedElement(node) && itemsOf(node).length) return node;
            }
            return null;
        }
        if (captured && !captured.complete) return null;
        for (const node of visibleSurfaces()) {
            if (baseline.has(node)) continue;
            if (/dialog/.test(surfaceRole(node)) || itemsOf(node).length) return node;
        }
        if (rowsHost && textRows().length) return rowsHost;
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
            const nodes = found ? itemsFor(found) : [];
            const rows = !!found && found === rowsHost;
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
                        const role = (node.getAttribute && node.getAttribute('role')) || (rows ? 'option' : node.localName) || 'option';
                        const selected = node.getAttribute && node.getAttribute('aria-selected');
                        items.push({
                            ref,
                            role,
                            name: accessibleName(rows ? rowNames.get(node) || node : node).slice(0, 120),
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
                surface: rows ? 'results' : found ? surfaceRole(found) : null,
                expanded: !!(el && el.getAttribute && el.getAttribute('aria-expanded') === 'true'),
                count: items.length,
                truncated,
                items,
                observed,
                announced: readAnnounced(el, options.announcedLimit || 3),
                waitedMs: Date.now() - started,
            }));
        };

        // Watching a declared surface is two attribute reads, so it runs every
        // frame. The fallback has to sweep the document for a surface nobody
        // declared, so it is capped and gives the rest of the budget back.
        const tick = () => {
            frame = null;
            try {
                const next = candidate();
                if (next !== found) { found = next; previous = null; }
                if (found) {
                    const current = itemsFor(found);
                    if (sameNodes(previous, current)) return finish();
                    previous = current;
                } else {
                    polls += 1;
                    // Rows in an open dialog wait on the page's own search, so
                    // they get the caller's budget rather than the sweep cap.
                    if (!declaredIds().length && !rowsHost && polls > MAX_POLLS) return finish();
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

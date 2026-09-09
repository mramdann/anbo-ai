const refRegistry = (() => {
    const key = '__anboBrowserRefs';
    if (globalThis[key]) return globalThis[key];
    let generation = 0;
    const refs = new Map();
    const parent = node => node.assignedSlot || node.parentElement || node.getRootNode?.().host || null;
    const identityAttributes = ['data-item-id', 'data-id', 'data-key', 'data-video-id'];
    const repeatedItem = node => {
        if (!node.localName?.includes('-')) return false;
        for (const direction of ['previousElementSibling', 'nextElementSibling']) {
            let sibling = node[direction];
            for (let i = 0; sibling && i < 8; i++, sibling = sibling[direction]) {
                if (sibling.localName === node.localName) return true;
            }
        }
        return false;
    };
    const destination = node => {
        let current = node;
        for (let depth = 0; current && depth <= 256; depth++) {
            if (current.localName === 'a' || current.localName === 'area') {
                const href = current.getAttribute('href') ?? (
                    current.namespaceURI === 'http://www.w3.org/2000/svg'
                        ? current.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null
                );
                if (href === null) return '';
                if (href.length > 8192) return undefined;
                try {
                    const resolved = new URL(href, current.baseURI).href;
                    return resolved.length <= 8192 ? resolved : undefined;
                } catch {
                    return undefined;
                }
            }
            current = parent(current);
        }
        return current ? undefined : null;
    };
    const itemContext = node => {
        let control = false;
        let current = node;
        for (let depth = 0; current && depth <= 256; depth++, current = parent(current)) {
            const tag = current.localName || '';
            const role = current.getAttribute('role');
            control ||= ['button', 'input', 'select', 'textarea'].includes(tag) ||
                ['button', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'menuitem', 'option'].includes(role);
            if (!control) continue;
            const identities = identityAttributes.map(name => current.getAttribute(name));
            if (!['li', 'tr', 'article'].includes(tag) && !['listitem', 'row', 'article'].includes(role) &&
                !identities.some(value => value !== null) && !repeatedItem(current)) continue;
            let length = identities.reduce((sum, value) => sum + (value?.length || 0), 0);
            if (length > 16384) return undefined;
            const urls = new Set();
            let scanned = 0;
            let capped = false;
            const visit = element => {
                if (++scanned > 256) { capped = true; return false; }
                if (element.localName === 'a' || element.localName === 'area') {
                    const url = destination(element);
                    if (url === undefined) { capped = true; return false; }
                    if (!urls.has(url)) { urls.add(url); length += url.length; }
                    if (urls.size > 16 || length > 16384) { capped = true; return false; }
                }
                if (element.localName === 'slot') {
                    const assigned = element.assignedElements?.({ flatten: true }) || [];
                    if (assigned.length > 256) { capped = true; return false; }
                    if (assigned.length) return assigned.every(visit);
                }
                const container = element.shadowRoot || element;
                for (let child = container.firstElementChild; child; child = child.nextElementSibling) {
                    if (!visit(child)) return false;
                }
                return true;
            };
            if (!visit(current) && !capped) return undefined;
            const fingerprint = JSON.stringify([identities, capped ? null : [...urls].sort()]);
            return fingerprint.length <= 16384 ? { root: new WeakRef(current), fingerprint } : undefined;
        }
        return current ? undefined : null;
    };
    const registry = Object.freeze({
        begin(next) {
            if (next < generation) throw new Error('stale_scan');
            for (const entry of refs.values()) {
                const node = entry.node.deref();
                node?.removeAttribute('data-anbo-ref');
                node?.removeAttribute('data-anbo-gen');
            }
            refs.clear();
            generation = next;
        },
        remember(ref, node) {
            if (!ref.startsWith('g' + generation + '-') || refs.size >= 1000) throw new Error('ref_limit');
            const url = destination(node);
            const context = url === null ? itemContext(node) : null;
            refs.set(ref, { node: new WeakRef(node), destination: url, context,
                reason: url === undefined ? 'destination_limit' : context === undefined ? 'context_limit' : null });
            node.setAttribute('data-anbo-ref', ref);
            node.setAttribute('data-anbo-gen', 'gen-' + generation);
        },
        resolve(ref) {
            if (!ref.startsWith('g' + generation + '-')) return null;
            const entry = refs.get(ref);
            const node = entry?.node.deref();
            if (!node?.isConnected || node.ownerDocument !== document || entry.reason) return null;
            if (destination(node) !== entry.destination) {
                entry.reason = 'destination_changed';
                return null;
            }
            if (entry.destination === null) {
                const context = itemContext(node);
                if (context === undefined) entry.reason = 'context_limit';
                else if (context?.root.deref() !== entry.context?.root.deref() ||
                    context?.fingerprint !== entry.context?.fingerprint) entry.reason = 'context_changed';
                if (entry.reason) return null;
            }
            return node;
        },
        hasDestination(ref) {
            return refs.get(ref)?.destination != null;
        },
        needsGuard(ref) {
            const entry = refs.get(ref);
            return !!entry && (entry.destination != null || entry.context != null);
        },
        reason(ref) {
            if (!ref.startsWith('g' + generation + '-')) return 'generation_changed';
            const entry = refs.get(ref), node = entry?.node.deref();
            if (!node?.isConnected || node.ownerDocument !== document) return 'node_detached';
            return entry.reason || 'ref_invalid';
        }
    });
    Object.defineProperty(globalThis, key, { value: registry });
    return registry;
})();

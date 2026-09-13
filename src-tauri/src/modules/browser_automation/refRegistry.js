const refRegistry = (() => {
    const key = '__anboBrowserRefs';
    if (globalThis[key]) return globalThis[key];
    // Refs from the last KEEP scans stay usable while their node lives: a
    // caller that found A, then found B, can still drag A onto B. Rust keeps
    // the same window (REF_GENERATIONS_KEPT) and refuses older refs up front.
    const KEEP = 8;
    let generation = 0;
    // The generation a scan asked for but has not earned yet. A scan that ends
    // up registering nothing has replaced nothing, so the refs the caller is
    // still holding must outlive it.
    let pending = 0;
    // Every retained ref by id; the id carries its scan, so one map holds the
    // whole window. `current` counts the live scan against the cap.
    const refs = new Map();
    let current = 0;
    const scanOf = ref => {
        const match = /^g(\d+)-/.exec(ref);
        return match ? Number(match[1]) : NaN;
    };
    const retained = scan => Number.isFinite(scan) && scan <= generation && scan + KEEP >= generation;
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
            // Claim the generation without spending it: a failed lookup used to
            // drop every live ref here, so one mistyped selector cost the caller
            // every target it already held.
            pending = next;
        },
        remember(ref, node) {
            if (!ref.startsWith('g' + pending + '-')) throw new Error('ref_limit');
            if (pending !== generation) {
                // A new scan retires only what falls out of the window. A node
                // keeps its newest label, so an older ref that was re-found
                // under a new one leaves that label alone.
                for (const [old, entry] of refs) {
                    if (scanOf(old) + KEEP >= pending) continue;
                    const stale = entry.node.deref();
                    if (stale?.getAttribute('data-anbo-ref') === old) {
                        stale.removeAttribute('data-anbo-ref');
                        stale.removeAttribute('data-anbo-gen');
                    }
                    refs.delete(old);
                }
                generation = pending;
                current = 0;
            }
            if (current >= 1000) throw new Error('ref_limit');
            const url = destination(node);
            const context = url === null ? itemContext(node) : null;
            refs.set(ref, { node: new WeakRef(node), destination: url, context,
                reason: url === undefined ? 'destination_limit' : context === undefined ? 'context_limit' : null });
            current += 1;
            node.setAttribute('data-anbo-ref', ref);
            node.setAttribute('data-anbo-gen', 'gen-' + generation);
        },
        resolve(ref) {
            if (!retained(scanOf(ref))) return null;
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
            if (!retained(scanOf(ref))) return 'generation_changed';
            const entry = refs.get(ref), node = entry?.node.deref();
            if (!node?.isConnected || node.ownerDocument !== document) return 'node_detached';
            return entry.reason || 'ref_invalid';
        }
    });
    Object.defineProperty(globalThis, key, { value: registry });
    return registry;
})();

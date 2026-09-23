function contextBlock(element, ancestors) {
    const parent = node => node.assignedSlot || node.parentElement || node.getRootNode?.().host || null;
    let node = element;
    if (ancestors === 'row') {
        for (let depth = 0; node && depth <= 32; depth++, node = parent(node)) {
            if (node.localName === 'tr' || node.getAttribute?.('role')?.trim().split(/\s+/)[0] === 'row') return node;
            if (node.localName === 'body' || node.localName === 'html') break;
        }
        return null;
    }
    for (let depth = 0; depth < Math.min(10, ancestors) && node.parentElement; depth++) node = node.parentElement;
    return node;
}

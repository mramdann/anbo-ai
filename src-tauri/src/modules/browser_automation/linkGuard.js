// Holds back the next click on a link that opens another tab, once the page's
// own handlers have had it, for Anbo to open (hidden_input.rs open_held_link),
// which reads the guard right after its key or click and takes it away. One
// left unread stands down by itself, so the user's own click on the page later
// is theirs. It waits as long as Anbo's input may take: on a busy machine the
// key reached the page 2.7 and 3.1 s after the guard was set, which then stood
// down at 2 s, so the browser opened the tab and brought its minimized window
// up in front of the user's (round 94, R92-1).
// A new guard retires the one before it, whose hold would otherwise read the
// next click as the page's.
const anboGuardLink = (node, opensTab) => {
    if (window.__anboHeldLink) window.__anboHeldLink.disarm();
    const link = node.closest ? node.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || !opensTab(link) ||
        !/^https?:$/.test(link.protocol) || link.hasAttribute('download') ||
        link.relList.contains('opener')) return false;
    // armedAt and stoodDown are for Anbo's log (R92-1).
    const held = { url: null, pageTookIt: false, armedAt: Date.now(), stoodDown: false };
    // The hold comes last, on the window or on the node whose handler kept the
    // click from going further, as one on a link in a clickable row does.
    const path = [window];
    for (let at = link; at; at = at.parentNode || at.host) path.push(at);
    const disarm = () => {
        for (const at of path) at.removeEventListener('click', hold);
        clearTimeout(timer);
    };
    const hold = (event) => {
        if (event.currentTarget !== window && !event.cancelBubble) return;
        if (!event.composedPath().includes(link)) return;
        disarm();
        if (event.defaultPrevented) {
            held.pageTookIt = true;
            return;
        }
        event.preventDefault();
        held.url = link.href;
    };
    const timer = setTimeout(() => {
        held.stoodDown = true;
        disarm();
    }, 30000);
    for (const at of path) at.addEventListener('click', hold);
    window.__anboHeldLink = { held, disarm };
    return true;
};

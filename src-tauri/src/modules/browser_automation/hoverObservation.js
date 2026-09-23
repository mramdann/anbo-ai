function beginHoverObservation(element, ref, point) {
  globalThis.__anboHoverObservation?.stop();
  if (!element?.isConnected) throw new Error('hover target detached before dispatch');
  const win = element.ownerDocument.defaultView;
  const types = ['pointerover', 'pointermove', 'mouseover', 'mousemove'];
  let received = null;
  let timer;
  let stopped = false;
  const listener = event => {
    if (received !== null || !event.isTrusted ||
        !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
        Math.abs(event.clientX - point.x) > 1 || Math.abs(event.clientY - point.y) > 1) return;
    received = event.composedPath().includes(element);
  };
  const observation = {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const type of types) win.removeEventListener(type, listener, true);
      clearTimeout(timer);
      if (globalThis.__anboHoverObservation === observation) delete globalThis.__anboHoverObservation;
    },
    take(expectedRef) {
      if (expectedRef !== ref || stopped) return null;
      const connected = element.isConnected;
      const cssHover = connected && element.matches(':hover');
      const eventVerified = received === true;
      const ok = received !== false && (eventVerified || cssHover);
      observation.stop();
      return { ok, cssHover, eventVerified, connected,
        error: ok ? null : received === false ? 'hover_intercepted' : 'hover_not_observed' };
    },
  };
  globalThis.__anboHoverObservation = observation;
  for (const type of types) win.addEventListener(type, listener, true);
  // Bound cleanup if dispatch fails, the caller cancels, or the document navigates.
  timer = setTimeout(() => observation.stop(), 5000);
}

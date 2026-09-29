function waitForActionableSample(probe, requirement, scroll, valueAction, onReady, external) {
  return new Promise((resolve, reject) => {
    let frame = null;
    let timer = null;
    let finished = false;
    let framed = false;
    let first;
    let firstAt = NaN;
    let previous;
    // The call-time sample and the next frame already span a frame boundary,
    // one frame sooner on a page that keeps rendering. Never closer than the
    // two frames of a 60 Hz display, so a timer-driven slide shows no less than
    // it did there, and never across our own scroll, answered on later frames.
    const quickSpanMs = 16;
    const now = () => (typeof performance === 'object' ? performance.now() : NaN);
    const keys = ['x', 'y', 'width', 'height'];
    const ready = value => value?.ok === true && value.visible === true &&
      keys.every(key => Number.isFinite(value[key])) &&
      (requirement === 'focus' || requirement === 'select' ? value.enabled === true :
        requirement === 'editable' ? value.editable === true && (value.receives === true || value.active === true) :
          value.enabled === true && value.receives === true);
    const stable = (a, b) => keys.every(key => Math.abs(a[key] - b[key]) <= 0.5);
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = timer = null;
    };
    const finish = (value, settled) => {
      if (finished) return;
      if (settled && ready(value) && onReady) onReady(value);
      finished = true;
      cleanup();
      resolve(JSON.stringify({ ...value, stable: settled }));
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const sample = shouldScroll => {
      const value = probe(shouldScroll);
      if (ready(value)) return value;
      finish(value, false);
      return null;
    };
    const onFrame = () => {
      if (finished) return;
      framed = true;
      frame = null;
      try {
        const quick = !previous && first.scrolled !== true && now() - firstAt >= quickSpanMs;
        const current = sample(false);
        if (!current) return;
        if (previous) finish(current, stable(previous, current));
        else if (quick && stable(first, current)) finish(current, true);
        else {
          previous = current;
          frame = requestAnimationFrame(onFrame);
        }
      } catch (error) { fail(error); }
    };
    try {
      first = sample(scroll);
      firstAt = now();
      if (!first) return;
      if ((requirement === 'check' || requirement === 'uncheck') && first.tag === 'input' &&
          (first.inputType === 'checkbox' || (first.inputType === 'radio' && requirement === 'check')) &&
          first.checked === (requirement === 'check')) {
        finish(first, false);
        return;
      }
      if (requirement === 'editable' || requirement === 'select') {
        if (valueAction) first = { ...first, valueActionResult: valueAction() };
        finish(first, false);
        return;
      }
      // A hidden page draws no frames and wakes its timers about once a second,
      // and nothing on it moves meanwhile, so its first sample is the settled one.
      if (external === true && document.visibilityState === 'hidden') {
        finish({ ...first, pageHidden: true }, true);
        return;
      }
      // Suspended frames retain the original bounded 100 ms stability check.
      timer = setTimeout(() => {
        if (finished) return;
        timer = null;
        try {
          const current = sample(false);
          // A page shown in a window nobody sees draws no frames either, and
          // answers a pointer move only once it draws again.
          const value = external === true && !framed ? { ...current, noFrames: true } : current;
          if (current) finish(value, stable(first, current) && (!previous || stable(previous, current)));
        } catch (error) { fail(error); }
      }, 100);
      frame = requestAnimationFrame(onFrame);
    } catch (error) { fail(error); }
  });
}

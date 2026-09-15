function waitForActionableSample(probe, requirement, scroll) {
  return new Promise((resolve, reject) => {
    let frame = null;
    let timer = null;
    let finished = false;
    let first;
    let previous;
    const keys = ['x', 'y', 'width', 'height'];
    const ready = value => value?.ok === true && value.visible === true &&
      keys.every(key => Number.isFinite(value[key])) &&
      (requirement === 'focus' ? value.enabled === true :
        requirement === 'editable' ? value.editable === true && value.receives === true :
          value.enabled === true && value.receives === true);
    const stable = (a, b) => keys.every(key => Math.abs(a[key] - b[key]) <= 0.5);
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = timer = null;
    };
    const finish = (value, settled) => {
      if (finished) return;
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
      frame = null;
      try {
        const current = sample(false);
        if (!current) return;
        if (previous) finish(current, stable(previous, current));
        else {
          previous = current;
          frame = requestAnimationFrame(onFrame);
        }
      } catch (error) { fail(error); }
    };
    try {
      first = sample(scroll);
      if (!first) return;
      // Suspended frames retain the original bounded 100 ms stability check.
      timer = setTimeout(() => {
        if (finished) return;
        timer = null;
        try {
          const current = sample(false);
          if (current) finish(current, stable(first, current) && (!previous || stable(previous, current)));
        } catch (error) { fail(error); }
      }, 100);
      frame = requestAnimationFrame(onFrame);
    } catch (error) { fail(error); }
  });
}

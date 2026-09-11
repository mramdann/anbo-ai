(() => {
  const KEY = '__anboDesign';
  const POST = '__anboDesignPost';
  if (globalThis[KEY]) return;
  const TAG = 'anbo-design-layer';
  const MAX_MARKS = 100, MAX_POINTS = 512, MAX_NOTE = 500, MAX_MODEL = 256 * 1024, MAX_UNDO = 50;
  const TOOLS = ['pen', 'box', 'arrow', 'pick', 'hand'];
  const FIND_ROLES = ['link', 'button', 'textbox', 'combobox', 'listbox', 'option', 'img', 'checkbox', 'radio', 'slider', 'spinbutton'];
  const SVG = 'http://www.w3.org/2000/svg';
  const DRAG_THRESHOLD = 4;
  const ACCENT = '#ff4d6d', PICK = '#3b82f6';
  let host, root, canvas, svg, docGroup, hover, hoverTag, note, noteInput, noteHead, noteRemove, hint;
  let tool = 'box', marks = [], nextId = 1, selected = null, undoStack = [], gesture = null, hoverNode = null;
  let presentation = 'normal', dirty = false, limitNotice = '';
  let frame = 0, stateTimer = 0, modelTimer = 0, scroll = { x: 0, y: 0 };
  let listeners = [];
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  const cancelRaf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const escapeCss = (value) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round = (value) => Math.round(value * 10) / 10;
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const trimNote = (value) => {
    const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    return text.length > MAX_NOTE ? text.slice(0, MAX_NOTE) : text;
  };
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  const readScroll = () => { scroll = { x: scrollX || 0, y: scrollY || 0 }; };
  const toDoc = (x, y) => ({ x: x + scroll.x, y: y + scroll.y });
  const docRectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + scroll.x, y: r.top + scroll.y, width: r.width, height: r.height };
  };
  const post = (message) => {
    const send = globalThis[POST];
    if (typeof send !== 'function') return false;
    try { send(JSON.stringify(message)); return true; } catch { return false; }
  };
  const status = () => ({ ok: true, tool, marks: marks.length, dirty, selected, limit: limitNotice || null });
  const scheduleState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => { stateTimer = 0; post({ type: 'state', ...status() }); }, 200);
  };
  const scheduleModel = () => {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(() => { modelTimer = 0; flushModel(); }, 800);
  };
  const flushModel = () => {
    clearTimeout(modelTimer); modelTimer = 0;
    post({ type: 'model', url: location.href, model: exportModel() });
  };
  const changed = () => { dirty = true; scheduleState(); scheduleModel(); };

  const describeElement = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const tag = String(el.tagName || '').toLowerCase();
    const id = el.getAttribute('id') || '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
    const role = el.getAttribute('role') || implicitRole(el);
    let name = '';
    try { name = typeof accessibleName === 'function' ? accessibleName(el) : fallbackName(el); } catch { name = fallbackName(el); }
    name = normalizeText(name).slice(0, 120);
    let text = '';
    try { text = normalizeText(el.innerText ?? el.textContent).slice(0, 160); } catch { text = ''; }
    const classes = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).map((c) => c.slice(0, 48));
    const selector = buildSelector(el);
    const source = {};
    for (const attr of ['data-source', 'data-loc', 'data-inspector-line', 'data-inspector-relative-path', 'data-component', 'data-v-inspector', 'data-sentry-component', 'data-sentry-source-file']) {
      const value = el.getAttribute(attr);
      if (value) source[attr] = String(value).slice(0, 200);
    }
    const rect = el.getBoundingClientRect();
    // browser_find only derives these roles from tags; anything else has to be
    // an explicit role attribute or the hint would send the agent nowhere.
    const findableRole = Boolean(el.getAttribute('role')) || FIND_ROLES.includes(role);
    let locator;
    if (testId) locator = { by: 'testId', value: testId };
    else if (role && name && findableRole) locator = { by: 'role', value: role, name };
    else if (id && selector.startsWith('#')) locator = { by: 'css', value: selector };
    else if (text && text.length <= 80 && !/^(div|span|section|main|body|html)$/.test(tag)) locator = { by: 'text', value: text };
    else locator = { by: 'css', value: selector };
    return {
      tag, id: id.slice(0, 80), testId: testId.slice(0, 80), role, name, text, classes, selector, locator,
      source: Object.keys(source).length ? source : undefined,
      inShadow: el.getRootNode() !== document,
      bounds: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
    };
  };
  const implicitRole = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'input') return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'range' ? 'slider' : type === 'number' ? 'spinbutton' : /^(button|submit|reset|image)$/.test(type) ? 'button' : 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'dialog') return 'dialog';
    return '';
  };
  const fallbackName = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (label) return label;
    return el.innerText ?? el.textContent ?? '';
  };
  const uniqueIn = (scope, selector) => {
    try { return scope.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const buildSelector = (el) => {
    const scope = el.getRootNode();
    const queryRoot = scope && scope.querySelectorAll ? scope : document;
    const id = el.getAttribute('id');
    if (id && !/^\d/.test(id) && !/^[a-z]*\d{4,}/i.test(id) && uniqueIn(queryRoot, '#' + escapeCss(id))) return '#' + escapeCss(id);
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'name']) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const candidate = `${String(el.tagName).toLowerCase()}[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;
      if (uniqueIn(queryRoot, candidate)) return candidate;
    }
    const segments = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      const tag = String(node.tagName).toLowerCase();
      const nodeId = node.getAttribute('id');
      if (nodeId && !/^\d/.test(nodeId) && uniqueIn(queryRoot, '#' + escapeCss(nodeId))) {
        segments.unshift('#' + escapeCss(nodeId));
        break;
      }
      let segment = tag;
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => String(child.tagName).toLowerCase() === tag);
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      segments.unshift(segment);
      const candidate = segments.join(' > ');
      if (uniqueIn(queryRoot, candidate)) return candidate;
      node = parent;
    }
    return segments.join(' > ').slice(0, 240);
  };

  const elementAt = (x, y) => {
    if (typeof document.elementsFromPoint !== 'function') return null;
    let stack;
    try { stack = document.elementsFromPoint(x, y); } catch { return null; }
    for (const el of stack) {
      if (el === host || el === document.documentElement || el === document.body) continue;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === TAG.toUpperCase() || tag === 'ANBO-AUTOMATION-VISUAL') continue;
      return el;
    }
    return null;
  };

  const THEME_KEYS = ['surface', 'text', 'muted', 'border', 'field', 'accent', 'accentText'];
  const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark'];
  const themeValue = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9#(),.%/ -]{1,64}$/.test(value)) return null;
    for (const match of value.matchAll(/([a-z-]*)\(/gi)) {
      if (!COLOR_FUNCTIONS.includes(match[1].toLowerCase())) return null;
    }
    return value;
  };
  const applyTheme = (theme) => {
    if (!host || !theme || typeof theme !== 'object') return;
    const mode = theme.mode === 'light' ? 'light' : 'dark';
    host.setAttribute('data-mode', mode);
    host.style.setProperty('color-scheme', mode, 'important');
    for (const key of THEME_KEYS) {
      const value = themeValue(theme[key]);
      if (value) host.style.setProperty('--anbo-design-' + key, value);
      else host.style.removeProperty('--anbo-design-' + key);
    }
  };

  const css = `
    :host{--anbo-design-surface:#0d202bf5;--anbo-design-text:#e4f2f5;--anbo-design-muted:#8ea6b2;--anbo-design-border:#79cad42e;--anbo-design-field:#08161d;--anbo-design-accent:#61c6d1;--anbo-design-accentText:#0b1a20}
    :host([data-mode=light]){--anbo-design-surface:#fffffff7;--anbo-design-text:#1b2330;--anbo-design-muted:#66727f;--anbo-design-border:#d5dae3;--anbo-design-field:#f3f5f9;--anbo-design-accent:#3b5bdb;--anbo-design-accentText:#ffffff}
    *{box-sizing:border-box}
    .canvas{position:absolute;inset:0;cursor:crosshair;touch-action:none;user-select:none;-webkit-user-select:none}
    :host([data-tool=hand]) .canvas{pointer-events:none}
    .marks{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
    .marks .shape{pointer-events:none}
    .marks .halo{fill:none;stroke:#fff;stroke-opacity:.85;stroke-linecap:round;stroke-linejoin:round}
    .marks .ink{fill:none;stroke:${ACCENT};stroke-linecap:round;stroke-linejoin:round}
    .marks .fill{fill:${ACCENT};fill-opacity:.06}
    .marks .pick .ink{stroke:${PICK};stroke-dasharray:6 4}
    .marks .pick .fill{fill:${PICK};fill-opacity:.08}
    .marks .badge{pointer-events:auto;cursor:pointer}
    .marks .badge circle{fill:${ACCENT};stroke:#fff;stroke-width:2}
    .marks .ink.head{fill:${ACCENT}}
    .marks .pick .badge circle{fill:${PICK}}
    .marks .badge text{fill:#fff;font:700 11px ui-sans-serif,system-ui,sans-serif;text-anchor:middle;dominant-baseline:central;pointer-events:none}
    .marks .selected .badge circle{stroke:#ffe66d;stroke-width:3}
    .marks .selected .ink{filter:drop-shadow(0 0 3px rgba(255,230,109,.9))}
    :host([data-presentation=capture]) .marks .selected .badge circle{stroke:#fff;stroke-width:2}
    :host([data-presentation=capture]) .marks .selected .ink{filter:none}
    .hover{position:absolute;left:0;top:0;display:none;border:2px solid ${PICK};border-radius:3px;background:rgba(59,130,246,.08);pointer-events:none;will-change:transform}
    .hover .tag{position:absolute;left:-2px;bottom:100%;margin-bottom:3px;max-width:320px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:2px 6px;border-radius:4px;background:${PICK};color:#fff;font:600 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
    .hover.below .tag{bottom:auto;top:100%;margin:3px 0 0}
    .note{position:absolute;left:0;top:0;display:none;width:280px;padding:8px;border:1px solid var(--anbo-design-border);border-radius:8px;background:var(--anbo-design-surface);color:var(--anbo-design-text);font:500 11px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px #00000040,0 1px 3px #00000030;pointer-events:auto}
    .note .head{display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:6px;color:var(--anbo-design-muted);font-size:10px}
    .note .head b{display:inline-grid;flex:none;place-items:center;width:18px;height:18px;border-radius:50%;background:${ACCENT};color:#fff;font-size:10px}
    .note .head .kind{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .note .head .remove{all:unset;flex:none;display:inline-grid;place-items:center;width:22px;height:22px;cursor:pointer;border:1px solid var(--anbo-design-border);border-radius:5px;color:var(--anbo-design-muted)}
    .note .head .remove svg{display:block;width:14px;height:14px}
    .note .head .remove:hover,.note .head .remove:focus-visible{color:${ACCENT};border-color:${ACCENT};outline:none}
    .note textarea{display:block;width:100%;min-height:52px;max-height:160px;resize:vertical;padding:6px 8px;border:1px solid var(--anbo-design-border);border-radius:6px;background:var(--anbo-design-field);color:var(--anbo-design-text);font:500 12px/1.45 ui-sans-serif,system-ui,sans-serif;outline:none}
    .note textarea::placeholder{color:var(--anbo-design-muted)}
    .note textarea:focus{border-color:var(--anbo-design-accent)}
    .note .keys{margin-top:5px;color:var(--anbo-design-muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hint{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100% - 24px);padding:6px 10px;border:1px solid var(--anbo-design-border);border-radius:999px;background:var(--anbo-design-surface);color:var(--anbo-design-text);font:500 10.5px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;pointer-events:none;box-shadow:0 6px 18px #00000030}
    .hint .dot{width:7px;height:7px;border-radius:50%;background:${ACCENT}}
    .hint .dim{color:var(--anbo-design-muted)}
    .hint .warn{color:${ACCENT}}
    :host([data-presentation=capture]) .hover,:host([data-presentation=capture]) .note,:host([data-presentation=capture]) .hint{display:none!important}
  `;

  const create = () => {
    if (host && host.isConnected) return;
    host = document.createElement(TAG);
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-anbo-design', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;display:block!important;contain:strict!important;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
    canvas = document.createElement('div');
    canvas.className = 'canvas';
    svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'marks');
    docGroup = document.createElementNS(SVG, 'g');
    docGroup.setAttribute('class', 'doc');
    svg.append(docGroup);
    hover = document.createElement('div');
    hover.className = 'hover';
    hoverTag = document.createElement('div');
    hoverTag.className = 'tag';
    hover.append(hoverTag);
    note = document.createElement('div');
    note.className = 'note';
    noteHead = document.createElement('div');
    noteHead.className = 'head';
    noteInput = document.createElement('textarea');
    noteInput.setAttribute('placeholder', 'What should change here? (optional)');
    noteInput.setAttribute('maxlength', String(MAX_NOTE));
    noteInput.setAttribute('rows', '2');
    const keys = document.createElement('div');
    keys.className = 'keys';
    keys.textContent = 'Enter saves \u00b7 Shift+Enter new line \u00b7 Esc closes';
    noteRemove = document.createElement('button');
    noteRemove.type = 'button';
    noteRemove.className = 'remove';
    noteRemove.setAttribute('title', 'Remove this mark');
    noteRemove.setAttribute('aria-label', 'Remove mark');
    // Hugeicons CommentRemove01, inlined so the layer needs no asset request.
    const removeIcon = document.createElementNS(SVG, 'svg');
    removeIcon.setAttribute('viewBox', '0 0 24 24');
    removeIcon.setAttribute('fill', 'none');
    removeIcon.setAttribute('stroke', 'currentColor');
    removeIcon.setAttribute('stroke-width', '1.75');
    removeIcon.setAttribute('stroke-linecap', 'round');
    removeIcon.setAttribute('stroke-linejoin', 'round');
    removeIcon.setAttribute('aria-hidden', 'true');
    for (const d of [
      'M15 2L18.5 5.5M18.5 5.5L22 9M18.5 5.5L22 2M18.5 5.5L15 9',
      'M6.09881 19.5C4.7987 19.3721 3.82475 18.9816 3.17157 18.3284C2 17.1569 2 15.2712 2 11.5V11C2 7.22876 2 5.34315 3.17157 4.17157C4.34315 3 6.22876 3 10 3H11.5M6.5 18C6.29454 19.0019 5.37769 21.1665 6.31569 21.8651C6.806 22.2218 7.58729 21.8408 9.14987 21.0789C10.2465 20.5441 11.3562 19.9309 12.5546 19.655C12.9931 19.5551 13.4395 19.5125 14 19.5C17.7712 19.5 19.6569 19.5 20.8284 18.3284C21.947 17.2098 21.9976 15.4403 21.9999 12',
      'M8 14H14M8 9H11',
    ]) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      removeIcon.append(path);
    }
    noteRemove.append(removeIcon);
    note.append(noteHead, noteInput, keys);
    hint = document.createElement('div');
    hint.className = 'hint';
    root.append(canvas, svg, hover, note, hint);
    (document.fullscreenElement || document.documentElement).append(host);
    on(canvas, 'pointerdown', onPointerDown);
    on(canvas, 'pointermove', onPointerMove);
    on(canvas, 'pointerup', onPointerUp);
    on(canvas, 'pointercancel', onPointerCancel);
    on(canvas, 'pointerleave', () => { if (!gesture) showHover(null); });
    on(svg, 'click', onBadgeClick);
    on(noteInput, 'keydown', onNoteKey);
    on(noteInput, 'input', onNoteInput);
    on(noteRemove, 'click', (event) => { event.preventDefault(); if (selected !== null) deleteMark(selected); });
    on(window, 'keydown', onKey, true);
    on(document, 'scroll', onScroll, { capture: true, passive: true });
    on(window, 'resize', onResize, { passive: true });
    on(window, 'pagehide', () => { commitNote(); flushModel(); });
    on(document, 'fullscreenchange', () => { const parent = document.fullscreenElement || document.documentElement; if (host && host.parentNode !== parent) parent.append(host); });
    readScroll();
    applyTool();
    render();
  };

  const showHover = (el) => {
    hoverNode = el;
    if (!hover) return;
    if (!el) { hover.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    hover.style.display = 'block';
    hover.style.width = Math.max(0, r.width) + 'px';
    hover.style.height = Math.max(0, r.height) + 'px';
    hover.style.transform = `translate(${round(r.left)}px,${round(r.top)}px)`;
    hover.classList.toggle('below', r.top < 24);
    const tag = String(el.tagName || '').toLowerCase();
    let label = tag;
    const id = el.getAttribute('id');
    if (id) label += '#' + id.slice(0, 32);
    else { const testId = el.getAttribute('data-testid'); if (testId) label += `[data-testid=${testId.slice(0, 32)}]`; }
    let name = '';
    try { name = normalizeText(typeof accessibleName === 'function' ? accessibleName(el) : fallbackName(el)).slice(0, 40); } catch { name = ''; }
    if (name) label += ` \u201c${name}\u201d`;
    hoverTag.textContent = label;
  };

  const applyTool = () => {
    if (!host) return;
    host.setAttribute('data-tool', tool);
    // The host resets itself with an inline all:initial!important so page CSS
    // cannot restyle it, which also means only an inline value can change it.
    host.style.setProperty('pointer-events', tool === 'hand' ? 'none' : 'auto', 'important');
    if (tool === 'hand' || tool === 'pen' || tool === 'arrow') showHover(null);
    renderHint();
  };
  const renderHint = () => {
    if (!hint) return;
    const words = { pen: 'Pen \u00b7 draw freely', box: 'Box \u00b7 drag an area or click an element', arrow: 'Arrow \u00b7 drag toward the target', pick: 'Inspect \u00b7 click an element', hand: 'Hand \u00b7 the page is interactive' };
    hint.replaceChildren();
    const dot = document.createElement('span'); dot.className = 'dot';
    const text = document.createElement('span'); text.textContent = words[tool] || tool;
    const count = document.createElement('span'); count.className = 'dim';
    count.textContent = `${marks.length} mark${marks.length === 1 ? '' : 's'} \u00b7 P B A I V keys \u00b7 Esc`;
    hint.append(dot, text, count);
    if (limitNotice) { const warn = document.createElement('span'); warn.className = 'warn'; warn.textContent = limitNotice; hint.append(warn); }
  };

  const bboxOf = (points) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
  };
  const simplify = (points, tolerance) => {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i += 1) {
      const p = points[i];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= tolerance) { out.push(p); last = p; }
    }
    out.push(points[points.length - 1]);
    if (out.length <= MAX_POINTS) return out;
    const step = out.length / MAX_POINTS;
    const capped = [];
    for (let i = 0; i < MAX_POINTS; i += 1) capped.push(out[Math.min(out.length - 1, Math.floor(i * step))]);
    capped[capped.length - 1] = out[out.length - 1];
    return capped;
  };
  const pathOf = (points) => points.map((p, i) => (i ? 'L' : 'M') + round(p[0]) + ' ' + round(p[1])).join('');

  const shapeFor = (mark) => {
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', 'mark ' + mark.kind);
    g.setAttribute('data-id', String(mark.id));
    const layer = document.createElementNS(SVG, 'g');
    layer.setAttribute('class', 'shape');
    g.append(layer);
    const badge = document.createElementNS(SVG, 'g');
    badge.setAttribute('class', 'badge');
    badge.setAttribute('data-id', String(mark.id));
    const circle = document.createElementNS(SVG, 'circle');
    circle.setAttribute('r', '10');
    const label = document.createElementNS(SVG, 'text');
    badge.append(circle, label);
    g.append(badge);
    mark.g = g; mark.layer = layer; mark.badge = badge; mark.label = label;
    paint(mark);
    return g;
  };
  const paint = (mark) => {
    const layer = mark.layer;
    layer.replaceChildren();
    const add = (name, attrs, className) => {
      const node = document.createElementNS(SVG, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      node.setAttribute('class', className);
      layer.append(node);
      return node;
    };
    const rect = mark.rect;
    let anchor = { x: rect.x, y: rect.y };
    if (mark.kind === 'pen' || mark.kind === 'arrow') {
      const d = pathOf(mark.points);
      add('path', { d, 'stroke-width': mark.kind === 'pen' ? 5 : 4.5 }, 'halo');
      add('path', { d, 'stroke-width': mark.kind === 'pen' ? 2.5 : 2 }, 'ink');
      if (mark.kind === 'arrow' && mark.points.length >= 2) {
        const [x1, y1] = mark.points[mark.points.length - 2];
        const [x2, y2] = mark.points[mark.points.length - 1];
        const angle = Math.atan2(y2 - y1, x2 - x1), size = 11;
        const head = [[x2, y2], [x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6)], [x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6)]];
        const points = head.map((p) => round(p[0]) + ',' + round(p[1])).join(' ');
        add('polygon', { points, 'stroke-width': 4 }, 'halo');
        add('polygon', { points, 'stroke-width': 2 }, 'ink head');
        anchor = { x: mark.points[0][0], y: mark.points[0][1] };
      }
    } else {
      const attrs = { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height), rx: 3 };
      add('rect', attrs, 'fill');
      add('rect', { ...attrs, 'stroke-width': 4 }, 'halo');
      add('rect', { ...attrs, 'stroke-width': 2 }, 'ink');
    }
    mark.badge.setAttribute('transform', `translate(${round(anchor.x)},${round(anchor.y)})`);
    mark.label.textContent = String(mark.n);
  };
  const renumber = () => { marks.forEach((mark, index) => { mark.n = index + 1; if (mark.label) mark.label.textContent = String(mark.n); }); };
  const render = () => {
    if (!docGroup) return;
    docGroup.setAttribute('transform', `translate(${-round(scroll.x)},${-round(scroll.y)})`);
  };
  const schedule = () => {
    if (frame) return;
    frame = raf(() => { frame = 0; render(); syncAnchored(); positionNote(); });
  };
  const syncAnchored = () => {
    for (const mark of marks) {
      const node = mark.node && mark.node.deref ? mark.node.deref() : mark.node;
      if (!node || !node.isConnected) continue;
      const next = docRectOf(node);
      if (next.width <= 0 && next.height <= 0) continue;
      if (Math.abs(next.x - mark.rect.x) < 0.5 && Math.abs(next.y - mark.rect.y) < 0.5 && Math.abs(next.width - mark.rect.width) < 0.5 && Math.abs(next.height - mark.rect.height) < 0.5) continue;
      mark.rect = next;
      paint(mark);
    }
    if (hoverNode && hoverNode.isConnected) showHover(hoverNode);
  };
  const onScroll = () => { readScroll(); schedule(); };
  const onResize = () => { readScroll(); schedule(); };

  const modelSize = () => JSON.stringify(exportModel()).length;
  const addMark = (mark) => {
    if (marks.length >= MAX_MARKS) { limitNotice = `Limit of ${MAX_MARKS} marks reached`; renderHint(); scheduleState(); return null; }
    mark.id = nextId++;
    mark.n = marks.length + 1;
    mark.note = mark.note || '';
    marks.push(mark);
    if (modelSize() > MAX_MODEL) {
      marks.pop();
      limitNotice = 'Mark detail limit reached; remove or simplify marks';
      renderHint(); scheduleState();
      return null;
    }
    limitNotice = '';
    docGroup.append(shapeFor(mark));
    pushUndo({ type: 'add', id: mark.id });
    changed();
    select(mark.id, true);
    renderHint();
    return mark;
  };
  const removeMark = (id) => {
    const index = marks.findIndex((mark) => mark.id === id);
    if (index < 0) return null;
    const [mark] = marks.splice(index, 1);
    if (mark.g) mark.g.remove();
    if (selected === id) { selected = null; hideNote(); }
    renumber();
    changed();
    renderHint();
    return { mark, index };
  };
  const deleteMark = (id) => {
    const removed = removeMark(id);
    if (removed) pushUndo({ type: 'delete', mark: removed.mark, index: removed.index });
  };
  const restoreMark = (mark, index) => {
    if (marks.length >= MAX_MARKS) return;
    marks.splice(Math.min(index, marks.length), 0, mark);
    const g = shapeFor(mark);
    const next = marks[index + 1];
    if (next && next.g && next.g.parentNode === docGroup) docGroup.insertBefore(g, next.g); else docGroup.append(g);
    renumber();
    changed();
    renderHint();
  };
  const pushUndo = (entry) => { undoStack.push(entry); if (undoStack.length > MAX_UNDO) undoStack.shift(); };
  const undo = () => {
    const entry = undoStack.pop();
    if (!entry) return false;
    if (entry.type === 'add') removeMark(entry.id);
    else if (entry.type === 'delete') restoreMark(entry.mark, entry.index);
    else if (entry.type === 'clear') { for (const mark of entry.marks) restoreMark(mark, marks.length); }
    return true;
  };
  const clearAll = () => {
    commitNote();
    if (!marks.length) return;
    const removed = marks.slice();
    for (const mark of removed) if (mark.g) mark.g.remove();
    marks = [];
    selected = null;
    hideNote();
    pushUndo({ type: 'clear', marks: removed });
    limitNotice = '';
    changed();
    renderHint();
  };

  const select = (id, edit) => {
    commitNote();
    for (const mark of marks) if (mark.g) mark.g.classList.toggle('selected', mark.id === id);
    selected = id;
    const mark = marks.find((candidate) => candidate.id === id);
    if (mark && edit) showNote(mark); else hideNote();
    scheduleState();
  };
  const showNote = (mark) => {
    if (!note) return;
    noteHead.replaceChildren();
    const n = document.createElement('b'); n.textContent = String(mark.n);
    const kind = document.createElement('span');
    kind.className = 'kind';
    const label = mark.kind === 'pick' ? 'Element' : mark.kind === 'box' ? 'Area' : mark.kind === 'arrow' ? 'Arrow' : 'Sketch';
    kind.textContent = mark.element && mark.element.tag ? `${label} \u00b7 <${mark.element.tag}>${mark.element.name ? ' \u201c' + mark.element.name.slice(0, 32) + '\u201d' : ''}` : label;
    kind.setAttribute('title', kind.textContent);
    noteHead.append(n, kind, noteRemove);
    noteInput.value = mark.note || '';
    note.style.display = 'block';
    positionNote();
    try { noteInput.focus({ preventScroll: true }); } catch { /* focus is optional */ }
  };
  const positionNote = () => {
    if (!note || note.style.display !== 'block' || selected === null) return;
    const mark = marks.find((candidate) => candidate.id === selected);
    if (!mark) return;
    const { width, height } = viewport();
    const r = mark.rect;
    let x = r.x - scroll.x, y = r.y - scroll.y + r.height + 10;
    const noteWidth = 280, noteHeight = note.offsetHeight || 120;
    if (y + noteHeight > height - 10) y = r.y - scroll.y - noteHeight - 10;
    x = clamp(x, 10, Math.max(10, width - noteWidth - 10));
    y = clamp(y, 10, Math.max(10, height - noteHeight - 10));
    note.style.transform = `translate(${round(x)}px,${round(y)}px)`;
  };
  const hideNote = () => { if (note) note.style.display = 'none'; };
  const commitNote = () => {
    if (!note || note.style.display !== 'block' || selected === null) return;
    const mark = marks.find((candidate) => candidate.id === selected);
    if (!mark) return;
    const next = trimNote(noteInput.value);
    if (next !== mark.note) { mark.note = next; changed(); }
  };
  const onNoteInput = () => { scheduleModel(); };
  const onNoteKey = (event) => {
    if (!event.isTrusted) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); commitNote(); hideNote(); try { noteInput.blur(); } catch { /* optional */ } return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); commitNote(); hideNote(); try { noteInput.blur(); } catch { /* optional */ } return; }
    event.stopPropagation();
  };

  const isEditable = (target) => {
    if (!target || target === host) return false;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  };
  const onKey = (event) => {
    if (!event.isTrusted) return;
    if (event.target === host) return;
    if (isEditable(event.target)) return;
    const key = String(event.key || '');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'z') {
      if (!undoStack.length) return;
      event.preventDefault(); event.stopPropagation();
      undo();
      return;
    }
    if (mod || event.altKey) return;
    if (key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (gesture) { cancelGesture(); return; }
      if (selected !== null) { select(null, false); return; }
      post({ type: 'exit' });
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      event.preventDefault(); event.stopPropagation();
      deleteMark(selected);
      return;
    }
    const map = { p: 'pen', b: 'box', a: 'arrow', i: 'pick', v: 'hand', h: 'hand' };
    const next = map[key.toLowerCase()];
    if (next && key.length === 1) {
      event.preventDefault(); event.stopPropagation();
      setTool(next);
    }
  };
  const setTool = (next) => {
    if (!TOOLS.includes(next)) return false;
    if (gesture) cancelGesture();
    commitNote();
    tool = next;
    applyTool();
    scheduleState();
    return true;
  };

  const onPointerDown = (event) => {
    if (!event.isTrusted || event.button !== 0 || tool === 'hand') return;
    commitNote();
    if (selected !== null) select(null, false);
    event.preventDefault();
    const start = toDoc(event.clientX, event.clientY);
    gesture = { tool, pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, start, points: [[start.x, start.y]], moved: false, node: null, lastStamp: typeof event.timeStamp === 'number' ? event.timeStamp : -Infinity };
    if (tool === 'pen') {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', 'mark pen');
      const halo = document.createElementNS(SVG, 'path'); halo.setAttribute('class', 'halo'); halo.setAttribute('stroke-width', '5');
      const ink = document.createElementNS(SVG, 'path'); ink.setAttribute('class', 'ink'); ink.setAttribute('stroke-width', '2.5');
      g.append(halo, ink);
      docGroup.append(g);
      gesture.preview = { g, halo, ink };
    } else if (tool === 'box' || tool === 'arrow') {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', 'mark ' + tool);
      docGroup.append(g);
      gesture.preview = { g };
    }
    try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
  };
  const gesturePoints = (event) => {
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const list = events.length ? events : [event];
    for (const e of list) {
      // A coalesced batch can repeat a sample the previous event already
      // delivered, which made a stroke stutter back and forth by a few pixels.
      if (typeof e.timeStamp === 'number') {
        if (e.timeStamp <= gesture.lastStamp) continue;
        gesture.lastStamp = e.timeStamp;
      }
      const p = toDoc(e.clientX, e.clientY);
      gesture.points.push([p.x, p.y]);
    }
  };
  const onPointerMove = (event) => {
    if (!event.isTrusted) return;
    if (!gesture) {
      if (tool === 'pick' || tool === 'box') {
        if (frame) return;
        frame = raf(() => { frame = 0; render(); showHover(elementAt(event.clientX, event.clientY)); });
      }
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y) >= DRAG_THRESHOLD) gesture.moved = true;
    if (gesture.tool === 'pen') gesturePoints(event);
    else { const p = toDoc(event.clientX, event.clientY); gesture.points[1] = [p.x, p.y]; }
    if (gesture.tool === 'arrow' || gesture.tool === 'box') gesture.hoverClient = { x: event.clientX, y: event.clientY };
    if (!gesture.frame) gesture.frame = raf(() => { if (gesture) { gesture.frame = 0; drawPreview(); } });
  };
  const drawPreview = () => {
    const preview = gesture.preview;
    if (!preview) return;
    if (gesture.tool === 'pen') {
      const d = pathOf(gesture.points);
      preview.halo.setAttribute('d', d);
      preview.ink.setAttribute('d', d);
      return;
    }
    const [x1, y1] = gesture.points[0];
    const end = gesture.points[1] || gesture.points[0];
    preview.g.replaceChildren();
    const add = (name, attrs, className) => { const node = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); node.setAttribute('class', className); preview.g.append(node); };
    if (gesture.tool === 'box') {
      const rect = { x: Math.min(x1, end[0]), y: Math.min(y1, end[1]), width: Math.abs(end[0] - x1), height: Math.abs(end[1] - y1) };
      const attrs = { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height), rx: 3 };
      add('rect', attrs, 'fill');
      add('rect', { ...attrs, 'stroke-width': 4 }, 'halo');
      add('rect', { ...attrs, 'stroke-width': 2 }, 'ink');
      if (gesture.moved) showHover(null);
    } else {
      const d = pathOf([[x1, y1], end]);
      add('path', { d, 'stroke-width': 4.5 }, 'halo');
      add('path', { d, 'stroke-width': 2 }, 'ink');
      if (gesture.hoverClient) showHover(elementAt(gesture.hoverClient.x, gesture.hoverClient.y));
    }
  };
  const finishGesture = (event) => {
    const current = gesture;
    gesture = null;
    if (current.frame) cancelRaf(current.frame);
    if (current.preview && current.preview.g) current.preview.g.remove();
    try { canvas.releasePointerCapture(current.pointerId); } catch { /* optional */ }
    const clientEnd = { x: event.clientX, y: event.clientY };
    if (current.tool === 'pen') {
      if (!current.moved || current.points.length < 2) return;
      const points = simplify(current.points, 1.5);
      addMark({ kind: 'pen', points, rect: bboxOf(points), element: null, node: null, anchored: false });
      return;
    }
    const end = toDoc(clientEnd.x, clientEnd.y);
    if (current.tool === 'arrow') {
      if (!current.moved) return;
      const target = elementAt(clientEnd.x, clientEnd.y);
      const points = [[current.start.x, current.start.y], [end.x, end.y]];
      addMark({ kind: 'arrow', points, rect: bboxOf(points), element: describeElement(target), node: null, anchored: false });
      showHover(null);
      return;
    }
    if (current.tool === 'box' && current.moved) {
      const rect = { x: Math.min(current.start.x, end.x), y: Math.min(current.start.y, end.y), width: Math.abs(end.x - current.start.x), height: Math.abs(end.y - current.start.y) };
      const center = elementAt((current.startClient.x + clientEnd.x) / 2, (current.startClient.y + clientEnd.y) / 2);
      addMark({ kind: 'box', rect, points: null, element: describeElement(center), node: null, anchored: false });
      return;
    }
    const target = elementAt(clientEnd.x, clientEnd.y);
    if (!target) return;
    const rect = docRectOf(target);
    addMark({ kind: current.tool === 'box' ? 'box' : 'pick', rect, points: null, element: describeElement(target), node: typeof WeakRef === 'function' ? new WeakRef(target) : target, anchored: true });
    showHover(null);
  };
  const onPointerUp = (event) => {
    if (!event.isTrusted || !gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    finishGesture(event);
  };
  const cancelGesture = () => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    if (current.frame) cancelRaf(current.frame);
    if (current.preview && current.preview.g) current.preview.g.remove();
    try { canvas.releasePointerCapture(current.pointerId); } catch { /* optional */ }
    showHover(null);
  };
  const onPointerCancel = (event) => { if (gesture && event.pointerId === gesture.pointerId) cancelGesture(); };
  const onBadgeClick = (event) => {
    if (!event.isTrusted) return;
    let node = event.target;
    while (node && node !== svg && !(node.getAttribute && node.getAttribute('class') === 'badge')) node = node.parentNode;
    if (!node || node === svg) return;
    event.preventDefault(); event.stopPropagation();
    const id = Number(node.getAttribute('data-id'));
    if (selected === id && note.style.display === 'block') { commitNote(); hideNote(); return; }
    select(id, true);
  };

  const exportModel = () => {
    const { width, height } = viewport();
    return {
      version: 1,
      url: location.href,
      title: String(document.title || '').slice(0, 200),
      viewport: { width, height, dpr: devicePixelRatio || 1, scrollX: round(scroll.x), scrollY: round(scroll.y) },
      marks: marks.map((mark) => ({
        n: mark.n,
        kind: mark.kind,
        note: mark.note || '',
        rect: { x: round(mark.rect.x), y: round(mark.rect.y), width: round(mark.rect.width), height: round(mark.rect.height) },
        viewport: { x: round(mark.rect.x - scroll.x), y: round(mark.rect.y - scroll.y), width: round(mark.rect.width), height: round(mark.rect.height) },
        inViewport: mark.rect.x - scroll.x < width && mark.rect.x - scroll.x + mark.rect.width > 0 && mark.rect.y - scroll.y < height && mark.rect.y - scroll.y + mark.rect.height > 0,
        anchored: Boolean(mark.anchored),
        points: mark.points ? mark.points.map((p) => [round(p[0]), round(p[1])]) : undefined,
        element: mark.element || undefined,
      })),
    };
  };
  const importModel = (model) => {
    for (const mark of marks) if (mark.g) mark.g.remove();
    marks = []; selected = null; undoStack = []; hideNote();
    if (!model || !Array.isArray(model.marks)) { renderHint(); return; }
    for (const item of model.marks.slice(0, MAX_MARKS)) {
      if (!item || typeof item !== 'object' || !item.rect) continue;
      const kind = TOOLS.includes(item.kind) && item.kind !== 'hand' ? item.kind : 'box';
      const rect = { x: Number(item.rect.x) || 0, y: Number(item.rect.y) || 0, width: Number(item.rect.width) || 0, height: Number(item.rect.height) || 0 };
      const points = Array.isArray(item.points) ? item.points.slice(0, MAX_POINTS).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]) : null;
      if ((kind === 'pen' || kind === 'arrow') && (!points || points.length < 2)) continue;
      let node = null;
      const anchored = item.anchored === true && (kind === 'pick' || kind === 'box');
      const selector = item.element && typeof item.element.selector === 'string' ? item.element.selector : '';
      if (anchored && selector && !item.element.inShadow) {
        try { const found = document.querySelector(selector); if (found) { node = typeof WeakRef === 'function' ? new WeakRef(found) : found; } } catch { node = null; }
      }
      const mark = { id: nextId++, n: marks.length + 1, kind, note: trimNote(item.note), rect, points, element: item.element && typeof item.element === 'object' ? item.element : null, node, anchored };
      marks.push(mark);
      docGroup.append(shapeFor(mark));
    }
    dirty = false;
    renderHint();
    schedule();
  };

  const present = (mode) => {
    if (!host) return false;
    presentation = mode === 'capture' || mode === 'hidden' ? mode : 'normal';
    if (presentation !== 'normal') { commitNote(); hideNote(); if (gesture) cancelGesture(); showHover(null); }
    host.setAttribute('data-presentation', presentation);
    host.style.setProperty('display', presentation === 'hidden' ? 'none' : 'block', 'important');
    if (presentation === 'capture') { readScroll(); render(); syncAnchored(); }
    return true;
  };
  const uninstall = () => {
    commitNote();
    flushModel();
    if (gesture) cancelGesture();
    cancelRaf(frame); frame = 0;
    clearTimeout(stateTimer); clearTimeout(modelTimer); stateTimer = modelTimer = 0;
    for (const off of listeners) { try { off(); } catch { /* already gone */ } }
    listeners = [];
    if (host) host.remove();
    host = root = canvas = svg = docGroup = hover = hoverTag = note = noteInput = noteHead = noteRemove = hint = null;
    marks = []; selected = null; undoStack = []; hoverNode = null;
    delete globalThis[KEY];
    return true;
  };

  const api = {
    alive: () => Boolean(host && host.isConnected),
    configure: (init) => {
      create();
      if (init && typeof init === 'object') {
        if (TOOLS.includes(init.tool)) tool = init.tool;
        if (init.theme) applyTheme(init.theme);
        if (init.model !== undefined) importModel(init.model);
      }
      applyTool();
      return status();
    },
    command: (name) => {
      if (!host || !host.isConnected) return { ok: false, error: 'design layer is not installed' };
      const value = String(name || '');
      if (value.startsWith('tool:')) return setTool(value.slice(5)) ? status() : { ok: false, error: 'unknown tool' };
      if (value === 'undo') { undo(); return status(); }
      if (value === 'delete') { if (selected !== null) deleteMark(selected); return status(); }
      if (value === 'clear') { clearAll(); return status(); }
      if (value === 'deselect') { select(null, false); return status(); }
      if (value === 'flush') { commitNote(); flushModel(); return status(); }
      if (value === 'status') return status();
      return { ok: false, error: 'unknown command' };
    },
    export: () => { commitNote(); readScroll(); return exportModel(); },
    present,
    uninstall,
    status,
  };
  globalThis[KEY] = api;
})();

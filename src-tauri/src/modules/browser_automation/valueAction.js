function valueActionGuard(el, refRegistry, refId, editable) {
  if (!el || refRegistry.resolve(refId) !== el) return 'stale_ref';
  if (!isRenderedElement(el) || el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return 'input_not_ready';
  if (editable && (el.readOnly || el.getAttribute('aria-readonly') === 'true' || !(
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
  ))) return 'input_not_ready';
  return null;
}

// Whether this field is one the page opens something under. Waiting on an
// ordinary text box would be paid for by every caller and repay none of them.
// A declared relationship is the strongest signal, but most real search boxes
// declare nothing and still open a list, so the search roles count too.
function opensASurface(el) {
  const attribute = name => {
    const value = el.getAttribute && el.getAttribute(name);
    return !!(value && value.length);
  };
  if (attribute('aria-controls') || attribute('aria-owns') || attribute('aria-haspopup')) return true;
  if (el.getAttribute && el.getAttribute('aria-expanded') !== null) return true;
  if (attribute('list')) return true;
  const role = (el.getAttribute && el.getAttribute('role')) || '';
  if (role === 'combobox' || role === 'searchbox') return true;
  return el instanceof HTMLInputElement && String(el.type || '').toLowerCase() === 'search';
}

function fillValue(el, refRegistry, refId, text, append, verify = true, captureReveal = false) {
  let error = valueActionGuard(el, refRegistry, refId, true);
  if (error) return { ok: false, error };
  // Read before the mutation: what the page looked like when the caller acted.
  const before = { url: String(location.href).slice(0, 2000), title: String(document.title || '').slice(0, 500) };
  const popup = opensASurface(el);
  if (popup && captureReveal) before.revealToken = captureRevealBaseline(el, text);
  el.focus();
  error = valueActionGuard(el, refRegistry, refId, true);
  if (error) return { ok: false, error };
  const current = el.isContentEditable ? (el.textContent || '') : (el.value || '');
  const next = append ? current + text : text;
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;
  if (setter) setter.call(el, next);
  else if (el.isContentEditable) el.textContent = next;
  else el.value = next;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = el.isContentEditable ? (el.textContent || '') : el.value;
  const valueRetained = actual === next;
  // The element leaving the tree (or being swapped) after dispatch is a stale ref, not a value mismatch.
  if (!el.isConnected || refRegistry.resolve(refId) !== el) return { ok: false, error: 'stale_ref', dispatched: true, valueRetained };
  // Canvas/terminal/remote-desktop inputs capture keystrokes then clear the field; verify:false accepts that.
  if (verify && !valueRetained) return { ok: false, error: 'input_mismatch', dispatched: true, valueRetained: false };
  return { ok: true, dispatched: true, valueRetained, popup, before };
}

// Chromium on Windows applies the option a select's own list has highlighted
// (by arrow keys) whenever that list closes, whatever closes it: Escape, a
// click elsewhere, a blur. A value set while the list is open was replaced by
// the page's next click, after select_option had reported it held. So the
// list is closed first, out of the page's sight: listeners do not hear the
// close or the focus round trip it takes, and the selection the page had is
// put back. A customizable select (base-select) draws its list in the page and
// applies nothing when it closes, so it is left as it is.
// null: no list to close; true: closed; false: the list stayed open.
function closeSelectPicker(el) {
  let view;
  try {
    if (!el.matches(':open')) return null;
    view = el.ownerDocument.defaultView;
    if (view.getComputedStyle(el, '::picker(select)').appearance === 'base-select') return null;
  } catch (_) {
    return null;
  }
  const root = el.getRootNode();
  const hosts = root === el.ownerDocument ? [view] : [view, root];
  const hush = event => {
    if (event.composedPath()[0] === el) event.stopImmediatePropagation();
  };
  const types = ['input', 'change', 'blur', 'focusout', 'focus', 'focusin'];
  const selected = el.selectedIndex;
  for (const host of hosts) for (const type of types) host.addEventListener(type, hush, true);
  try {
    el.blur();
    el.selectedIndex = selected;
    el.focus({ preventScroll: true });
  } finally {
    for (const host of hosts) for (const type of types) host.removeEventListener(type, hush, true);
  }
  return !el.matches(':open');
}

function selectValue(el, refRegistry, refId, want) {
  let error = valueActionGuard(el, refRegistry, refId, false);
  if (error) return { ok: false, error };
  if (el.tagName !== 'SELECT') return { ok: false, error: 'not_a_select' };
  const matchesWanted = opt => opt.value === want || (opt.textContent || '').trim() === want;
  const matched = Array.from(el.options).find(matchesWanted);
  if (!matched) return { ok: false, error: 'option_not_found' };
  const available = () => !matched.disabled && !matched.matches(':disabled') && matchesWanted(matched) && Array.from(el.options).includes(matched);
  if (!available()) return { ok: false, error: 'input_not_ready' };
  const closedPicker = closeSelectPicker(el);
  if (closedPicker === false) return { ok: false, error: 'picker_open' };
  el.focus();
  error = valueActionGuard(el, refRegistry, refId, false);
  if (error || !available()) return { ok: false, error: error || 'input_not_ready' };
  const expected = matched.value;
  el.value = expected;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (!el.isConnected || refRegistry.resolve(refId) !== el || el.value !== expected || !matched.selected) return { ok: false, error: 'input_mismatch' };
  return { ok: true, value: expected, label: (matched.textContent || '').trim(), valueVerified: true, closedPicker: closedPicker === true };
}

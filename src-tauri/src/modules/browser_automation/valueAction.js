function valueActionGuard(el, refRegistry, refId, editable) {
  if (!el || refRegistry.resolve(refId) !== el) return 'stale_ref';
  if (!isRenderedElement(el) || el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return 'input_not_ready';
  if (editable && (el.readOnly || el.getAttribute('aria-readonly') === 'true' || !(
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
  ))) return 'input_not_ready';
  return null;
}

function fillValue(el, refRegistry, refId, text, append) {
  let error = valueActionGuard(el, refRegistry, refId, true);
  if (error) return { ok: false, error };
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
  return { ok: el.isConnected && refRegistry.resolve(refId) === el && actual === next, error: 'input_mismatch' };
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
  el.focus();
  error = valueActionGuard(el, refRegistry, refId, false);
  if (error || !available()) return { ok: false, error: error || 'input_not_ready' };
  const expected = matched.value;
  el.value = expected;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (!el.isConnected || refRegistry.resolve(refId) !== el || el.value !== expected || !matched.selected) return { ok: false, error: 'input_mismatch' };
  return { ok: true, value: expected, label: (matched.textContent || '').trim(), valueVerified: true };
}

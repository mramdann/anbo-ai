export const EVIDENCE_VERSION = 6;

export function toolRecords(events) {
  const pending = new Map(), records = [];
  for (const event of events) for (const block of event.message?.content ?? []) {
    if (block.type === 'tool_use') pending.set(block.id, block);
    if (block.type !== 'tool_result') continue;
    const call = pending.get(block.tool_use_id);
    if (!call) continue;
    const text = typeof block.content === 'string' ? block.content : (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    let result;
    try { result = JSON.parse(text); } catch { result = null; }
    records.push({ name: call.name.replace(/^mcp__.*?__/, ''), args: call.input ?? {}, result, error: !!block.is_error, text });
    pending.delete(block.tool_use_id);
  }
  return records;
}

function mapState(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname) || !u.pathname.startsWith('/maps')) return null;
    const m = u.pathname.match(/^(\/maps\/place\/[^/]+)\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?[mz])(?:\/|$)/);
    return m ? { place: u.origin + m[1], center: m.slice(2, 4).map(Number), scale: m[4] } : null;
  } catch { return null; }
}

export function auditSession(task, events, answer = '') {
  const records = toolRecords(events), checks = [];
  const open = records.find(r => r.name === 'browser_open' && !r.error && Number.isInteger(r.result?.tabId));
  const target = open?.result.tabId;
  const scoped = records.filter(r => !r.error && r.result && r.result.ok !== false && target != null && (r.result.tabId ?? r.args.tabId) === target);
  const add = (name, state, detail) => checks.push({ name, state, detail });
  const pages = scoped.flatMap((r, index) => {
    const page = r.result.page ?? (r.name === 'browser_page_info' || r.name === 'browser_get_url' ? r.result : null);
    return page ? [{ ...page, index, nativeTitle: r.result.page != null || page.titleSource === 'native' }] : [];
  });
  const readTexts = scoped.filter(r => r.name === 'browser_get_text' && r.result.visible === true && r.result.truncated !== true && typeof r.result.text === 'string').map(r => r.result.text.trim());
  const finalPage = pages.at(-1);
  const observedAnswer = !!answer && readTexts.some(text => text === answer.trim());
  const requireUrl = pattern => add('committed destination', finalPage?.url ? (pattern.test(finalPage.url) ? 'pass' : 'fail') : 'unverified', finalPage?.url ?? 'No native page URL recorded');
  if (task === 'wikipedia') {
    requireUrl(/^https:\/\/en\.wikipedia\.org\/wiki\/Tim_Berners-Lee(?:[?#]|$)/);
    add('article heading read', readTexts.some(text => text === 'Tim Berners-Lee') ? 'pass' : 'unverified', 'Requires an observed text result, not the final answer alone');
  } else if (task === 'youtube') {
    requireUrl(/^https:\/\/(?:www\.)?youtube\.com\/watch\?/);
    const title = answer.trim();
    const watchPage = /^https:\/\/(?:www\.)?youtube\.com\/watch\?/.test(finalPage?.url ?? '');
    const firstWatch = pages.find(p => p.url === finalPage?.url)?.index;
    const headingRead = watchPage && title.length > 0 && title.length < 300 &&
      finalPage?.title === title + ' - YouTube' && firstWatch != null &&
      scoped.some((r, index) => index >= firstWatch && r.name === 'browser_find' &&
        Array.isArray(r.result.matches) && r.result.matches.some(m => m.visible === true &&
          m.tag === 'h1' && m.role === 'heading' && m.name === title && m.text === title));
    add('title read', observedAnswer || headingRead ? 'pass' : 'unverified', 'Exact visible text read, or visible h1 find below the name cap corroborated by the committed native video title');
    const key = scoped.findLastIndex(r => r.name === 'browser_press' && ['k', 'K', ' ', 'Space'].includes(r.args.key));
    const observed = scoped.findLast((r, index) => index > key && key >= 0 && r.name === 'browser_get_property' && typeof r.result.values?.paused === 'boolean');
    add('paused after keyboard action', observed ? (observed.result.values.paused ? 'pass' : 'fail') : 'unverified', observed ? `paused=${observed.result.values.paused}` : 'No paused property observed after the keyboard action');
  } else if (task === 'amazon') {
    requireUrl(/^https:\/\/(?:www\.)?amazon\.com\/(?:[^?#]*\/)?(?:dp|gp\/product)\/[^/?#]+(?:[/?#]|$)/);
    add('product title read', observedAnswer ? 'pass' : 'unverified', 'Exact answer must occur in a text-read result');
  } else if (task === 'maps') {
    requireUrl(/^https:\/\/(?:www\.)?google\.[a-z.]+\/maps\/place\//);
    const observations = new Set(['browser_find', 'browser_page_info', 'browser_get_url', 'browser_get_text', 'browser_get_property', 'browser_screenshot', 'browser_snapshot', 'browser_wait']);
    const title = answer.trim(), destination = mapState(finalPage?.url);
    const headingRead = /^(Monumen Nasional|Monas)$/.test(title) && finalPage?.nativeTitle &&
      finalPage.loading === false && !finalPage.pendingUrl && finalPage.title === title + ' - Google Maps' &&
      scoped.some((r, index) => {
        if (r.name !== 'browser_find' || !Array.isArray(r.result.matches)) return false;
        const before = pages.findLast(p => p.index < index), place = mapState(before?.url);
        if (!destination || !place || place.place !== destination.place || !before.nativeTitle ||
          before.loading !== false || before.pendingUrl || before.title !== title + ' - Google Maps') return false;
        if (scoped.slice(before.index + 1, index).some(call => !observations.has(call.name))) return false;
        return r.result.matches.some(m => m.visible === true && m.inViewport === true &&
          m.tag === 'h1' && m.role === 'heading' && m.name === title && m.text === title &&
          m.truncated !== true);
      });
    add('place name read', readTexts.some(text => /^(Monumen Nasional|Monas)$/i.test(text)) || headingRead ? 'pass' : 'unverified',
      'Visible untruncated get_text, or exact visible in-viewport h1 find after a committed matching native place/title observation; final native place/title must still agree');
    const motion = scoped.flatMap((r, index) => {
      if (r.name !== 'browser_drag' || r.result.ok !== true) return [];
      const beforePage = pages.findLast(p => p.index < index), afterPage = pages.find(p => p.index > index);
      const before = mapState(beforePage?.url), after = mapState(afterPage?.url);
      if (!before || !after || before.place !== after.place || before.scale !== after.scale || beforePage.loading === true || afterPage.loading === true || beforePage.pendingUrl || afterPage.pendingUrl) return [];
      const intervening = scoped.slice(beforePage.index + 1, afterPage.index).filter((_, offset) => beforePage.index + 1 + offset !== index);
      if (intervening.some(call => !observations.has(call.name))) return [];
      return before.center.some((value, i) => Math.abs(value - after.center[i]) > 0.000001)
        ? [{ before: before.center, after: after.center, place: before.place, scale: before.scale }] : [];
    }).at(0);
    add('map center changed after drag', motion ? 'pass' : 'unverified', motion ?? 'Requires nearest before/after centers for the same place and scale around a successful drag, without pending navigation or another intervening action');
  } else if (task === 'tradingview') {
    requireUrl(/^https:\/\/(?:www\.)?tradingview\.com\/chart\//);
    const observed = /^ETHUSDT(?:\s|$)/i.test(finalPage?.title ?? '');
    add('ETHUSDT displayed', observed ? 'pass' : 'unverified', 'Requires final native chart title; search field or result text is not chart state');
    add('chart pan independently verified', 'unverified', 'Successful drag or an after-only screenshot does not prove a time-axis shift');
  } else add('supported state contract', 'unverified', 'No state validator for this task');
  add('owned tab closed', target != null && scoped.some(r => r.name === 'browser_close' && (r.result.ok || r.result.closed)) ? 'pass' : 'unverified', 'Only the tab opened by this session is considered');
  return {
    version: EVIDENCE_VERSION,
    status: checks.some(c => c.state === 'fail') ? 'fail' : checks.every(c => c.state === 'pass') ? 'pass' : 'unverified',
    checks,
    scope: 'Recorded state checks only; first-result ranking and visual canvas motion are not inferred from tool dispatch or the agent final answer.',
  };
}

export function latencyGate(before, after) {
  const reasons = [];
  if (!before?.binaryHash || !after?.binaryHash) reasons.push('Missing build identity');
  if (![before, after].every(report => report?.checks?.length > 0 && report.checks.every(c => c.passed === true))) reasons.push('Correctness checks missing or failed');
  const av = before?.environment?.anbo, bv = after?.environment?.anbo;
  if (!av || !bv || av.width !== bv.width || av.height !== bv.height || av.userAgent !== bv.userAgent) reasons.push('Viewport or browser engine differs');
  const rows = (after?.summaries ?? []).filter(s => s.tool === 'anbo').map(current => {
    const previous = before?.summaries?.find(s => s.tool === 'anbo' && s.scenario === current.scenario);
    if (![previous, current].every(row => row?.wall?.n >= 20 && [row.wall.p50, row.wall.p95].every(v => Number.isFinite(v) && v > 0))) return { scenario: current.scenario, status: 'incomparable' };
    const p50 = current.wall.p50 / previous.wall.p50 - 1, p95 = current.wall.p95 / previous.wall.p95 - 1;
    return { scenario: current.scenario, p50Delta: p50, p95Delta: p95, status: p50 > .05 || p95 > .10 ? 'recheck' : 'within-threshold' };
  });
  for (const previous of (before?.summaries ?? []).filter(s => s.tool === 'anbo')) {
    if (!rows.some(r => r.scenario === previous.scenario)) rows.push({ scenario: previous.scenario, status: 'incomparable' });
  }
  if (!rows.length || rows.some(r => r.status === 'incomparable')) reasons.push('Missing comparable samples');
  return { status: reasons.length ? 'incomparable' : rows.some(r => r.status === 'recheck') ? 'recheck' : 'within-threshold', reasons, rows, note: 'Screening thresholds: +5% p50 or +10% p95 require repetition. A single sequential pair never proves causal improvement or absence of regressions.' };
}

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { auditSession, toolRecords, latencyGate } from './lib/browser-benchmark-evidence.mjs';

function transcript(calls) {
  return calls.flatMap(([name, args, result, error = false], index) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: String(index), name: 'mcp__anbo__' + name, input: args }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(index), is_error: error, content: [{ type: 'text', text: JSON.stringify(result) }] }] } },
  ]);
}
const open = ['browser_open', {}, { tabId: 1 }];
const close = ['browser_close', { tabId: 1 }, { ok: true }];
test('reported answer, echoed input, and errors cannot prove a state', () => {
  const audit = auditSession('tradingview', transcript([open,
    ['browser_type', { tabId: 1, text: 'ETHUSDT' }, { ok: true }],
    ['browser_get_text', { tabId: 1 }, { text: 'ETHUSDT' }, true], close,
  ]), 'ETHUSDT');
  assert.equal(audit.status, 'unverified');
  assert.equal(audit.checks.find(c => c.name === 'ETHUSDT displayed').state, 'unverified');
});
test('paused must be observed after a key in the same tab', () => {
  const base = [open,
    ['browser_page_info', { tabId: 1 }, { url: 'https://www.youtube.com/watch?v=x' }],
    ['browser_get_text', { tabId: 1 }, { text: 'Video' }],
    ['browser_get_property', { tabId: 1 }, { values: { paused: true } }],
    ['browser_press', { tabId: 1, key: 'k' }, { ok: true }],
  ];
  const state = calls => auditSession('youtube', transcript([...calls, close]), 'Video').checks.find(c => c.name === 'paused after keyboard action').state;
  assert.equal(state(base), 'unverified');
  assert.equal(state([...base, ['browser_get_property', { tabId: 2 }, { values: { paused: true } }]]), 'unverified');
  assert.equal(state([...base, ['browser_get_property', { tabId: 1 }, { values: { paused: false } }]]), 'fail');
  assert.equal(state([...base, ['browser_get_property', { tabId: 1 }, { values: { paused: true } }]]), 'pass');
});
test('map movement needs before and after centers around a successful drag', () => {
  const page = latitude => ['browser_page_info', { tabId: 1 }, { url: `https://www.google.com/maps/place/Monas/@${latitude},106.8,17z` }];
  const drag = ['browser_drag', { tabId: 1 }, { ok: true }];
  const state = calls => auditSession('maps', transcript([open, ...calls, close])).checks.find(c => c.name === 'map center changed after drag').state;
  assert.equal(state([page(-6.17), drag, page(-6.18)]), 'pass');
  assert.equal(state([page(-6.17), drag, page(-6.17)]), 'unverified');
  assert.equal(state([drag, page(-6.18)]), 'unverified');
  assert.equal(state([page(-6.17), ['browser_drag', { tabId: 1 }, {}, true], page(-6.18)]), 'unverified');
});
test('a before-only canvas screenshot never proves chart movement', () => {
  const audit = auditSession('tradingview', transcript([open,
    ['browser_page_info', { tabId: 1 }, { url: 'https://www.tradingview.com/chart/', title: 'ETHUSDT 2345' }],
    ['browser_drag', { tabId: 1 }, { ok: true }], close,
  ]));
  assert.equal(audit.checks.find(c => c.name === 'ETHUSDT displayed').state, 'pass');
  assert.equal(audit.status, 'unverified');
});
test('map search transitions and intervening actions cannot prove drag movement', () => {
  const page = url => ['browser_page_info', { tabId: 1 }, { url }];
  const a = page('https://www.google.com/maps/place/Monas/@-6.17,106.8,17z');
  const b = page('https://www.google.com/maps/place/Monas/@-6.18,106.8,17z');
  const drag = ['browser_drag', { tabId: 1 }, { ok: true }];
  const state = calls => auditSession('maps', transcript([open, ...calls, close])).checks.find(c => c.name === 'map center changed after drag').state;
  assert.equal(state([page('https://www.google.com/maps/@-6.2,106.9,17z'), drag, b]), 'unverified');
  assert.equal(state([page('https://www.google.com/maps/place/Elsewhere/@-6.2,106.9,17z'), drag, b]), 'unverified');
  assert.equal(state([page('https://www.google.com/maps/place/Monas/@-6.2,106.9,30888m'), drag, b]), 'unverified');
  assert.equal(state([['browser_page_info', { tabId: 1 }, { ...a[2], loading: true }], drag, b]), 'unverified');
  assert.equal(state([a, drag, ['browser_page_info', { tabId: 1 }, { ...b[2], pendingUrl: 'https://www.google.com/maps/' }]]), 'unverified');
  assert.equal(state([a, ['browser_click', { tabId: 1 }, { ok: true }], drag, b]), 'unverified');
  assert.equal(state([a, drag, ['browser_scroll', { tabId: 1 }, { ok: true }], b]), 'unverified');
  assert.equal(state([drag, a, drag, b]), 'pass');
  assert.equal(state([a, ['browser_drag', { tabId: 1 }, {}], b]), 'unverified');
});
test('unpaired results and image payloads are not state evidence', () => {
  assert.deepEqual(toolRecords([{ message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'true' }] } }]), []);
});
test('Amazon product URLs include root and titled product paths only', () => {
  for (const path of ['/dp/B123', '/gp/product/B123?x=1', '/USB-Hub/dp/B123/ref=x']) {
    const audit = auditSession('amazon', transcript([open, ['browser_page_info', { tabId: 1 }, { url: 'https://www.amazon.com' + path }], close]));
    assert.equal(audit.checks[0].state, 'pass', path);
  }
  const audit = auditSession('amazon', transcript([open, ['browser_page_info', { tabId: 1 }, { url: 'https://www.amazon.com/s?k=usb' }], close]));
  assert.equal(audit.checks[0].state, 'fail');
});
test('hidden, truncated or visibility-unknown text does not prove a heading', () => {
  for (const props of [{ visible: false }, { visible: true, truncated: true }, {}]) {
    const audit = auditSession('wikipedia', transcript([open, ['browser_get_text', { tabId: 1 }, { text: 'Tim Berners-Lee', ...props }], close]));
    assert.equal(audit.checks.find(c => c.name === 'article heading read').state, 'unverified');
  }
});

test('YouTube visible h1 find is corroborated by the committed native title', () => {
  const title = 'Lofi study radio';
  const page = ['browser_page_info', { tabId: 1 }, { url: 'https://www.youtube.com/watch?v=x', title: title + ' - YouTube' }];
  const match = { tag: 'h1', role: 'heading', visible: true, name: title, text: title };
  const find = ['browser_find', { tabId: 1, by: 'role', value: 'heading' }, { matches: [match], truncated: true }];
  const tail = [['browser_press', { tabId: 1, key: 'k' }, { ok: true }], ['browser_get_property', { tabId: 1 }, { values: { paused: true } }], close];
  assert.equal(auditSession('youtube', transcript([open, page, find, ...tail]), title).status, 'pass');
  const state = calls => auditSession('youtube', transcript([open, ...calls, ...tail]), title).checks.find(c => c.name === 'title read').state;
  for (const patch of [{ visible: false }, { visible: undefined }, { tag: 'input' }, { role: 'textbox' }, { name: 'Different' }, { text: 'Lofi study' }]) {
    assert.equal(state([page, ['browser_find', { tabId: 1 }, { matches: [{ ...match, ...patch }] }]]), 'unverified');
  }
  assert.equal(state([page, ['browser_find', { tabId: 2 }, find[2]]]), 'unverified');
  assert.equal(state([page, [...find, true]]), 'unverified');
  assert.equal(state([find, page]), 'unverified');
  assert.equal(state([page, find, ['browser_page_info', { tabId: 1 }, { url: page[2].url, title: 'Different - YouTube' }]]), 'unverified');
  assert.equal(state([page]), 'unverified');
});

test('a capped heading name cannot prove the entire video title', () => {
  const title = 'x'.repeat(300);
  const audit = auditSession('youtube', transcript([open,
    ['browser_page_info', { tabId: 1 }, { url: 'https://www.youtube.com/watch?v=x', title: title + ' - YouTube' }],
    ['browser_find', { tabId: 1 }, { matches: [{ tag: 'h1', role: 'heading', visible: true, name: title, text: title }] }], close,
  ]), title);
  assert.equal(audit.checks.find(c => c.name === 'title read').state, 'unverified');
});

test('Maps h1 find needs an earlier committed native place and matching final title', () => {
  const title = 'Monumen Nasional';
  const page = ['browser_page_info', { tabId: 1 }, { url: 'https://www.google.com/maps/place/Monumen+Nasional/@-6.17,106.8,17z', title: title + ' - Google Maps', titleSource: 'native', loading: false }];
  const match = { tag: 'h1', role: 'heading', visible: true, inViewport: true, name: title, text: title };
  const find = ['browser_find', { tabId: 1 }, { matches: [match], truncated: true }];
  const state = (calls, answer = title) => auditSession('maps', transcript([open, ...calls, close]), answer).checks.find(c => c.name === 'place name read').state;
  assert.equal(state([page, find, page]), 'pass');
  assert.equal(state([['browser_press', { tabId: 1 }, { ok: true, page: page[2] }], find, page]), 'pass');
  for (const patch of [{ visible: false }, { visible: undefined }, { inViewport: false }, { inViewport: undefined }, { tag: 'input' }, { role: 'textbox' }, { name: 'Monas' }, { text: 'Monumen' }, { truncated: true }]) {
    assert.equal(state([page, ['browser_find', { tabId: 1 }, { matches: [{ ...match, ...patch }] }], page]), 'unverified');
  }
  for (const patch of [{ title: 'Different - Google Maps' }, { titleSource: 'document' }, { titleSource: undefined }, { loading: true }, { loading: undefined }, { pendingUrl: 'https://www.google.com/maps/' }, { url: 'https://www.google.com/maps/search/Monas' }, { url: 'https://www.google.com/maps/place/Elsewhere/@-6.17,106.8,17z' }]) {
    const changed = [page[0], page[1], { ...page[2], ...patch }];
    assert.equal(state([changed, find, page]), 'unverified');
    assert.equal(state([page, find, changed]), 'unverified');
  }
  assert.equal(state([find, page]), 'unverified');
  assert.equal(state([page, ['browser_find', { tabId: 2 }, find[2]], page]), 'unverified');
  assert.equal(state([page, [...find, true], page]), 'unverified');
  assert.equal(state([page, ['browser_find', { tabId: 1 }, { ...find[2], ok: false }], page]), 'unverified');
  assert.equal(state([page, ['browser_click', { tabId: 1 }, { ok: true }], find, page]), 'unverified');
  assert.equal(state([page, find, page], 'Wrong answer'), 'unverified');
  assert.equal(state([page, find, page], 'x'.repeat(300)), 'unverified');
});

test('Maps visible text reads retain their existing contract independently of find', () => {
  const state = props => auditSession('maps', transcript([open, ['browser_get_text', { tabId: 1 }, { text: 'Monumen Nasional', ...props }], close])).checks.find(c => c.name === 'place name read').state;
  assert.equal(state({ visible: true, truncated: false }), 'pass');
  assert.equal(state({ visible: false }), 'unverified');
  assert.equal(state({ visible: true, truncated: true }), 'unverified');
  assert.equal(state({}), 'unverified');
});
test('an earlier chart title or a search-result text is not final chart state', () => {
  const audit = auditSession('tradingview', transcript([open,
    ['browser_page_info', { tabId: 1 }, { url: 'https://www.tradingview.com/chart/', title: 'ETHUSDT 2345' }],
    ['browser_get_text', { tabId: 1 }, { text: 'ETHUSDT', visible: true }],
    ['browser_page_info', { tabId: 1 }, { url: 'https://www.tradingview.com/chart/', title: 'BTCUSDT 6789' }], close,
  ]));
  assert.equal(audit.checks.find(c => c.name === 'ETHUSDT displayed').state, 'unverified');
});
test('regression screen refuses unmatched provenance and checks each operation', () => {
  const report = p95 => ({ binaryHash: 'hash', checks: [{ passed: true }], environment: { anbo: { width: 10, height: 10, userAgent: 'same' } }, summaries: [{ scenario: 'type', tool: 'anbo', wall: { n: 30, p50: 20, p95 } }] });
  assert.equal(latencyGate(report(30), report(31)).status, 'within-threshold');
  assert.equal(latencyGate(report(30), report(40)).status, 'recheck');
  const changed = report(30); changed.environment.anbo.height = 11;
  assert.equal(latencyGate(report(30), changed).status, 'incomparable');
  assert.equal(latencyGate({}, {}).status, 'incomparable');
  const missing = report(30); missing.checks = [];
  assert.equal(latencyGate(report(30), missing).status, 'incomparable');
  const incomplete = report(30); incomplete.summaries = [];
  assert.equal(latencyGate(report(30), incomplete).status, 'incomparable');
  const invalid = report(NaN);
  assert.equal(latencyGate(report(30), invalid).status, 'incomparable');
});

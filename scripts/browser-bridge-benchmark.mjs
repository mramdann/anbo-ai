import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createDispatcher } from "../extensions/anbo-browser/bridge.js";
import { createTabManager } from "../extensions/anbo-browser/tabs.js";

const iterations = Number(process.argv[2] ?? 1000);
if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 100_000) {
  throw new Error("Iterations must be an integer between 100 and 100000");
}
let replies = 0;
let calls = 0;
let tabQueries = 0;
let attachments = 0;
let failures = 0;
const api = {
  debugger: {
    sendCommand: async () => { calls += 1; return {}; },
    attach: async () => { attachments += 1; },
  },
  tabs: {
    query: async () => { tabQueries += 1; return []; },
    get: async (id) => ({ id, title: "Fixture", url: "https://example.com/" }),
  },
};
const profiles = Array.from({ length: 10 }, () => {
  const selected = new Map();
  const manager = createTabManager(api, selected, () => {});
  const dispatch = createDispatcher(api, selected, (reply) => { replies += 1; if (reply.error) failures += 1; }, () => true, manager);
  return { selected, dispatch };
});
for (const profile of profiles) {
  for (const tabId of [1, 2]) await profile.dispatch({ type: "command", id: tabId, tabId, method: "anbo.selectTab", params: { expectedUrl: "https://example.com/" }, expiresAt: Date.now() + 10_000 });
}
if (failures) throw new Error("Benchmark fixture could not connect");
calls = replies = tabQueries = attachments = 0;
const idleCpuStart = process.cpuUsage();
const idleStart = performance.now();
await delay(1000);
const idleCpu = process.cpuUsage(idleCpuStart);
const idle = { wallMs: performance.now() - idleStart, nodeCpuMs: (idleCpu.user + idleCpu.system) / 1000, bridgeCalls: calls, bridgeReplies: replies, tabQueries, attachments };
const samples = [];
const activeCpuStart = process.cpuUsage();
for (let index = 0; index < iterations; index += 1) {
  const start = performance.now();
  await Promise.all(profiles.map(({ dispatch, selected }) => dispatch({ type: "command", id: index + 3, tabId: index % 2 + 1, selectionId: selected.get(index % 2 + 1).selectionId, method: "Runtime.evaluate", params: {}, expiresAt: Date.now() + 10_000 })));
  samples.push(performance.now() - start);
}
const activeCpu = process.cpuUsage(activeCpuStart);
if (failures || calls !== iterations * profiles.length) throw new Error("Benchmark commands failed");
samples.sort((first, second) => first - second);
console.log(JSON.stringify({
  scope: "Synthetic dispatcher only. Mocked CDP, no browser, native host, UI, network, or real-page timing.",
  node: process.version,
  profiles: profiles.length,
  tabsPerProfile: 2,
  batches: iterations,
  calls,
  replies,
  idle,
  batchLatencyMs: { p50: samples[Math.floor(samples.length * 0.5)], p95: samples[Math.floor(samples.length * 0.95)], max: samples.at(-1) },
  activeNodeCpuMs: (activeCpu.user + activeCpu.system) / 1000,
}, null, 2));

import { describe, expect, it } from "vitest";
import { AgentSessionDiscoveryQueue } from "@/modules/agents/lib/sessionDiscoveryQueue";

describe("AgentSessionDiscoveryQueue", () => {
  it("starts the second Antigravity lookup while the first has no conversation", () => {
    const queue = new AgentSessionDiscoveryQueue();
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
    queue.request(2);
    expect(queue.begin(2, "antigravity")).toBe(true);
    expect(queue.begin(1, "antigravity")).toBe(false);
  });

  it("retains a new request received during an in-flight lookup", () => {
    const queue = new AgentSessionDiscoveryQueue();
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
    queue.request(1);
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(false);
    queue.finish(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
    queue.finish(1);
    expect(queue.begin(1, "antigravity")).toBe(false);
  });

  it("does not turn a completed or failed lookup into permanent polling", () => {
    const queue = new AgentSessionDiscoveryQueue();
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
    queue.finish(1);
    expect(queue.begin(1, "antigravity")).toBe(false);
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
  });

  it("serializes legacy providers without dropping their queued requests", () => {
    const queue = new AgentSessionDiscoveryQueue();
    for (const id of [1, 2, 3]) queue.request(id);
    expect(queue.begin(1, "claude")).toBe(true);
    expect(queue.begin(2, "codex")).toBe(false);
    expect(queue.begin(3, "antigravity")).toBe(true);
    queue.finish(1);
    expect(queue.begin(2, "codex")).toBe(true);
  });

  it("cancels stale requests without releasing a still-running lookup", () => {
    const queue = new AgentSessionDiscoveryQueue();
    queue.request(1);
    expect(queue.begin(1, "claude")).toBe(true);
    queue.cancel(1);
    queue.request(1);
    expect(queue.begin(1, "antigravity")).toBe(false);
    queue.finish(1);
    expect(queue.begin(1, "antigravity")).toBe(true);
    queue.cancel(1);
    queue.finish(1);
    expect(queue.begin(1, "antigravity")).toBe(false);
  });

  it("drops requests for closed or already-pinned leaves", () => {
    const queue = new AgentSessionDiscoveryQueue();
    queue.request(1);
    queue.request(2);
    queue.retain(new Set([2]));
    expect(queue.begin(1, "antigravity")).toBe(false);
    expect(queue.begin(2, "antigravity")).toBe(true);
  });
});

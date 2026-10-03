import { describe, expect, it } from "vitest";
import { createRequestListener } from "./requestListener";

function pendingSubscriptions() {
  const resolvers: Array<(dispose: () => void) => void> = [];
  const deliver: Array<(request: string) => void> = [];
  const subscribe = (handler: (request: string) => void) => {
    deliver.push(handler);
    return new Promise<() => void>((resolve) => resolvers.push(resolve));
  };
  return { resolvers, deliver, subscribe };
}

describe("createRequestListener", () => {
  it("keeps one subscription across a quick stop and restart", async () => {
    const { resolvers, subscribe } = pendingSubscriptions();
    const disposed: number[] = [];
    const listener = createRequestListener(subscribe);
    listener.setHandler(() => {});
    listener.stop();
    listener.setHandler(() => {});
    resolvers[0](() => disposed.push(0));
    await Promise.resolve();
    await Promise.resolve();
    listener.setHandler(() => {});
    expect(resolvers).toHaveLength(2);
    expect(disposed).toEqual([0]);
  });

  it("hands each request to the latest handler", async () => {
    const { resolvers, deliver, subscribe } = pendingSubscriptions();
    const seen: string[] = [];
    const listener = createRequestListener(subscribe);
    listener.setHandler((request) => seen.push(`first ${request}`));
    resolvers[0](() => {});
    await Promise.resolve();
    listener.setHandler((request) => seen.push(`second ${request}`));
    deliver[0]("open");
    expect(seen).toEqual(["second open"]);
  });
});

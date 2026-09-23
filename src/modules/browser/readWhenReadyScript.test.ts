import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL(
    "../../../src-tauri/src/modules/browser_automation/readWhenReady.js",
    import.meta.url,
  ),
  "utf8",
);
const run = (document: unknown, read: () => unknown) =>
  vm.runInNewContext(`${source}; readWhenReady(read)`, { document, read });

describe("same-call readiness and text read", () => {
  it.each(["interactive", "complete"])(
    "reads a %s document exactly once",
    (readyState) => {
      const read = vi.fn(() =>
        JSON.stringify({ ok: true, text: "Current value" }),
      );
      expect(JSON.parse(run({ readyState, body: {} }, read))).toEqual({
        ok: true,
        text: "Current value",
      });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { readyState: "loading", body: {} },
    { readyState: "interactive", body: null },
    { readyState: "complete", body: null },
  ])(
    "defers unready documents without reading or caching content: %j",
    (document) => {
      const read = vi.fn();
      expect(JSON.parse(run(document, read))).toEqual({
        ok: false,
        error: "document_not_ready",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("does not turn stale refs or script errors into automatic action retries", () => {
    const stale = vi.fn(() =>
      JSON.stringify({ ok: false, error: "stale_ref" }),
    );
    expect(
      JSON.parse(run({ readyState: "complete", body: {} }, stale)),
    ).toHaveProperty("error", "stale_ref");
    const throwing = vi.fn(() => {
      throw Error("context changed");
    });
    expect(() => run({ readyState: "complete", body: {} }, throwing)).toThrow(
      "context changed",
    );
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});

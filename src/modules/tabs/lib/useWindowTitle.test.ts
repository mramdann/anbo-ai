import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let inFlight = 0;
let mostInFlight = 0;
const setTitle = vi.fn(async (title: string) => {
  calls.push(title);
  inFlight += 1;
  mostInFlight = Math.max(mostInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 5));
  inFlight -= 1;
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle }),
}));

const { applyWindowTitle } = await import("./useWindowTitle");

describe("applyWindowTitle", () => {
  it("sends one title at a time and ends on the newest", async () => {
    // Switching to an empty space used to send "<space> — <old tab>" and then
    // "<space>" back to back; Tauri could apply them in either order.
    const first = applyWindowTitle("anbo-ai — notes.md");
    void applyWindowTitle("anbo-ai — other.md");
    void applyWindowTitle("anbo-ai");
    await first;
    expect(mostInFlight).toBe(1);
    expect(calls).toEqual(["anbo-ai — notes.md", "anbo-ai"]);
  });
});

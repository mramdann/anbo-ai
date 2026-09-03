import { describe, expect, it } from "vitest";
import { formatRuntimeBytes } from "./whisperRuntime";

describe("managed Whisper runtime formatting", () => {
  it("formats empty, megabyte, and gigabyte sizes", () => {
    expect(formatRuntimeBytes(0)).toBe("0 MB");
    expect(formatRuntimeBytes(147_951_465)).toBe("141.1 MB");
    expect(formatRuntimeBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });
});

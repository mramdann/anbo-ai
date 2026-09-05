import { describe, expect, it } from "vitest";
import {
  isNewer,
  isUpdaterPlatformSupported,
  shouldOfferUpdate,
  type UpdaterStatus,
} from "./useUpdater";

describe("isNewer", () => {
  it("treats a higher patch as newer", () => {
    expect(isNewer("0.12.1", "0.12.0")).toBe(true);
  });

  it("treats an equal version as not newer", () => {
    expect(isNewer("0.12.0", "0.12.0")).toBe(false);
  });

  it("treats a lower version as not newer", () => {
    expect(isNewer("0.11.9", "0.12.0")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    // "0.10.0" must be newer than "0.9.0" (lexical compare would say the opposite).
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("handles differing segment counts by padding with zeros", () => {
    expect(isNewer("1.0", "0.12.0")).toBe(true);
    expect(isNewer("0.12", "0.12.0")).toBe(false);
  });

  it("ignores a leading v and pre-release suffix", () => {
    expect(isNewer("v0.12.1-rc1", "0.12.0")).toBe(true);
    expect(isNewer("v0.12.0", "v0.12.0-beta")).toBe(false);
  });
});

describe("isUpdaterPlatformSupported", () => {
  it("matches the platform built by the release workflow", () => {
    expect(isUpdaterPlatformSupported("windows")).toBe(true);
    expect(isUpdaterPlatformSupported("linux")).toBe(false);
    expect(isUpdaterPlatformSupported("macos")).toBe(false);
  });
});

describe("shouldOfferUpdate", () => {
  const update = { version: "0.23.0" } as unknown as never;

  it("offers the button once a release is found", () => {
    expect(shouldOfferUpdate({ kind: "available", update })).toBe(true);
  });

  it("keeps the button through the download and the restart prompt", () => {
    // It is the only route back to the dialog, so losing it mid-update would
    // leave no way to see progress or to restart.
    expect(
      shouldOfferUpdate({
        kind: "downloading",
        downloaded: 1,
        contentLength: 2,
      }),
    ).toBe(true);
    expect(shouldOfferUpdate({ kind: "ready" })).toBe(true);
  });

  it("shows nothing when there is no update to offer", () => {
    const quiet: UpdaterStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "uptodate" },
      { kind: "unsupported" },
      { kind: "error", message: "boom" },
    ];
    for (const status of quiet) {
      expect(shouldOfferUpdate(status)).toBe(false);
    }
  });
});

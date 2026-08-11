import { describe, expect, it } from "vitest";
import { isNewer, shouldShowUpdate } from "./useUpdater";

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

describe("shouldShowUpdate", () => {
  it("surfaces an update when nothing has been dismissed", () => {
    expect(shouldShowUpdate("0.12.1", null, false)).toBe(true);
  });

  it("suppresses an automatic poll for the exact dismissed version", () => {
    // The core fix: polling every CHECK_INTERVAL_MS must not re-open the modal
    // for a version the user already deferred with "Later".
    expect(shouldShowUpdate("0.12.1", "0.12.1", false)).toBe(false);
  });

  it("re-arms when a newer version than the dismissed one ships", () => {
    expect(shouldShowUpdate("0.12.2", "0.12.1", false)).toBe(true);
  });

  it("always surfaces the update on a manual check, even if dismissed", () => {
    // The Settings "Check for updates" button calls check({ manual: true }) and
    // must never be silenced by a prior dismissal of the same version.
    expect(shouldShowUpdate("0.12.1", "0.12.1", true)).toBe(true);
  });
});

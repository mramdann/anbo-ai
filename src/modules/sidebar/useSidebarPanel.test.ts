import { describe, expect, it } from "vitest";
import {
  shouldPersistSidebarCollapsed,
  shouldPersistSidebarWidth,
} from "./useSidebarPanel";

describe("shouldPersistSidebarWidth", () => {
  it("only persists a positive width from direct user interaction", () => {
    expect(shouldPersistSidebarWidth(320, true)).toBe(true);
    expect(shouldPersistSidebarWidth(320, false)).toBe(false);
    expect(shouldPersistSidebarWidth(0, true)).toBe(false);
  });
});

describe("shouldPersistSidebarCollapsed", () => {
  it("ignores container-driven resize events such as window minimization", () => {
    expect(shouldPersistSidebarCollapsed(false)).toBe(false);
    expect(shouldPersistSidebarCollapsed(true)).toBe(true);
  });
});

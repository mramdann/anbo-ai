import { describe, expect, it } from "vitest";
import { faviconUrlForPage, resolveBrowserInput } from "./browserInput";

describe("resolveBrowserInput", () => {
  it("keeps complete HTTP(S) URLs", () => {
    expect(resolveBrowserInput("https://example.com/docs?q=1")).toBe(
      "https://example.com/docs?q=1",
    );
  });

  it("normalizes domains and local development addresses", () => {
    expect(resolveBrowserInput("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(resolveBrowserInput("localhost:5173")).toBe("http://localhost:5173");
    expect(resolveBrowserInput("127.0.0.1:3000/app")).toBe(
      "http://127.0.0.1:3000/app",
    );
    expect(resolveBrowserInput("192.168.1.20:8080")).toBe(
      "http://192.168.1.20:8080",
    );
  });

  it("uses Google for words and questions", () => {
    expect(resolveBrowserInput("anbo ai browser")).toBe(
      "https://www.google.com/search?q=anbo%20ai%20browser",
    );
    expect(resolveBrowserInput("cara memakai tauri? ")).toBe(
      "https://www.google.com/search?q=cara%20memakai%20tauri%3F",
    );
  });

  it("returns null for empty input", () => {
    expect(resolveBrowserInput("   ")).toBeNull();
  });
});

describe("faviconUrlForPage", () => {
  it("returns the conventional favicon on the page origin", () => {
    expect(faviconUrlForPage("https://example.com/path?q=1")).toBe(
      "https://example.com/favicon.ico",
    );
  });

  it("rejects non-web URLs", () => {
    expect(faviconUrlForPage("file:///tmp/a.html")).toBeNull();
  });
});

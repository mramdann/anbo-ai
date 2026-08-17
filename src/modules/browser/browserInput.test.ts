import { describe, expect, it } from "vitest";
import {
  filePathToBrowserUrl,
  faviconUrlForPage,
  googleFaviconUrlForPage,
  isBrowserPreviewablePath,
  resolveBrowserInput,
  windowsPathToFileUrl,
} from "./browserInput";

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

  it("converts Windows files into encoded file URLs", () => {
    expect(
      resolveBrowserInput("C:/Users/Admin/Documents/notaris-surat/index.html"),
    ).toBe("file:///C:/Users/Admin/Documents/notaris-surat/index.html");
    expect(windowsPathToFileUrl("C:\\work\\landing page#1.html")).toBe(
      "file:///C:/work/landing%20page%231.html",
    );
  });

  it("keeps explicit file URLs", () => {
    expect(resolveBrowserInput("file:///C:/work/index.html")).toBe(
      "file:///C:/work/index.html",
    );
  });
});

describe("filePathToBrowserUrl", () => {
  it("encodes local Windows, POSIX, and UNC paths", () => {
    expect(filePathToBrowserUrl("C:\\work\\landing page#1.html")).toBe(
      "file:///C:/work/landing%20page%231.html",
    );
    expect(filePathToBrowserUrl("/home/me/landing page.html")).toBe(
      "file:///home/me/landing%20page.html",
    );
    expect(filePathToBrowserUrl("\\\\server\\share\\index.html")).toBe(
      "file://server/share/index.html",
    );
  });

  it("rejects empty and relative paths", () => {
    expect(filePathToBrowserUrl(" ")).toBeNull();
    expect(filePathToBrowserUrl("src/index.html")).toBeNull();
  });
});

describe("isBrowserPreviewablePath", () => {
  it("accepts browser-renderable files case-insensitively", () => {
    expect(isBrowserPreviewablePath("C:/work/index.HTML")).toBe(true);
    expect(isBrowserPreviewablePath("C:/work/manual.pdf")).toBe(true);
    expect(isBrowserPreviewablePath("/tmp/cover.webp")).toBe(true);
    expect(isBrowserPreviewablePath("/tmp/movie.mp4")).toBe(true);
  });

  it("rejects directories and unsupported source or executable files", () => {
    expect(isBrowserPreviewablePath("C:/work/assets")).toBe(false);
    expect(isBrowserPreviewablePath("C:/work/app.tsx")).toBe(false);
    expect(isBrowserPreviewablePath("C:/work/tool.exe")).toBe(false);
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

describe("googleFaviconUrlForPage", () => {
  it("returns a Google favicon service URL for web pages", () => {
    expect(googleFaviconUrlForPage("https://example.com/path?q=1")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  it("rejects non-web URLs", () => {
    expect(googleFaviconUrlForPage("file:///tmp/a.html")).toBeNull();
  });
});

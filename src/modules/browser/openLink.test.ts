import { describe, expect, it } from "vitest";
import { shouldOpenInAnbo } from "./openLink";

describe("deciding where a link opens", () => {
  it("takes http and https, which is all a tab can show", () => {
    expect(shouldOpenInAnbo("https://example.com", true)).toBe(true);
    expect(shouldOpenInAnbo("http://127.0.0.1:5173/app", true)).toBe(true);
    expect(shouldOpenInAnbo("HTTPS://EXAMPLE.COM", true)).toBe(true);
  });

  it("leaves every other scheme to the system", () => {
    // Routing these into a tab would not open them at all, which is worse
    // than opening them outside Anbo.
    expect(shouldOpenInAnbo("mailto:someone@example.com", true)).toBe(false);
    expect(shouldOpenInAnbo("file:///C:/notes.txt", true)).toBe(false);
    expect(shouldOpenInAnbo("vscode://file/x", true)).toBe(false);
    expect(shouldOpenInAnbo("tel:+62211234567", true)).toBe(false);
  });

  it("refuses anything it cannot parse as a URL", () => {
    // A terminal link matcher can hand over text that only looks like one.
    expect(shouldOpenInAnbo("not a url", true)).toBe(false);
    expect(shouldOpenInAnbo("", true)).toBe(false);
    expect(shouldOpenInAnbo("example.com", true)).toBe(false);
  });

  it("sends everything outside when the preference is off", () => {
    expect(shouldOpenInAnbo("https://example.com", false)).toBe(false);
    expect(shouldOpenInAnbo("http://localhost:3000", false)).toBe(false);
  });

  it("does not treat a javascript: URL as openable", () => {
    // It parses, so the scheme check is the only thing standing between a
    // pasted javascript: link and a tab.
    expect(shouldOpenInAnbo("javascript:alert(1)", true)).toBe(false);
    expect(shouldOpenInAnbo("data:text/html,<h1>hi</h1>", true)).toBe(false);
  });
});

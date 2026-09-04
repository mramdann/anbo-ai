import { describe, expect, it } from "vitest";
import { findUrlAt, trimUrlPunctuation } from "./terminalLinks";

describe("finding a URL under a terminal click", () => {
  const line = "Berikut tautannya: https://www.youtube.com silakan dibuka";
  const start = line.indexOf("https://");

  it("matches anywhere inside the URL but not outside it", () => {
    expect(findUrlAt(line, start)).toBe("https://www.youtube.com");
    expect(findUrlAt(line, start + 10)).toBe("https://www.youtube.com");
    expect(findUrlAt(line, start - 1)).toBeNull();
    expect(findUrlAt(line, start + "https://www.youtube.com".length)).toBeNull();
  });

  it("ignores a line with no link and impossible columns", () => {
    expect(findUrlAt("just some output", 4)).toBeNull();
    expect(findUrlAt("", 0)).toBeNull();
    expect(findUrlAt(line, -1)).toBeNull();
    expect(findUrlAt(line, 9_999)).toBeNull();
  });

  it("picks the URL that was actually clicked when a line has several", () => {
    const two = "see https://a.example and https://b.example";
    expect(findUrlAt(two, two.indexOf("https://a"))).toBe("https://a.example");
    expect(findUrlAt(two, two.indexOf("https://b"))).toBe("https://b.example");
  });

  it("leaves sentence punctuation out of the URL", () => {
    // Trailing punctuation belongs to the prose, not the address.
    expect(trimUrlPunctuation("https://example.com.")).toBe(
      "https://example.com",
    );
    expect(trimUrlPunctuation("https://example.com),")).toBe(
      "https://example.com",
    );
    const prose = "buka https://example.com, lalu lanjutkan";
    expect(findUrlAt(prose, prose.indexOf("https"))).toBe("https://example.com");
  });

  it("keeps brackets that the URL itself opened", () => {
    // Wikipedia style paths really do carry parentheses.
    const wiki = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
    expect(trimUrlPunctuation(wiki)).toBe(wiki);
  });

  it("takes only http and https, never another scheme", () => {
    const other = "kirim ke mailto:me@example.com atau ftp://files.example";
    expect(findUrlAt(other, other.indexOf("mailto"))).toBeNull();
    expect(findUrlAt(other, other.indexOf("ftp"))).toBeNull();
  });
});

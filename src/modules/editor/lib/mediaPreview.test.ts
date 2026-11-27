import { describe, expect, it } from "vitest";
import { mediaPreviewFor } from "./mediaPreview";

describe("mediaPreviewFor", () => {
  it("frames a .pdf only when the file starts as a PDF", () => {
    expect(mediaPreviewFor("D:/work/report.pdf", true)).toBe("pdf");
    expect(mediaPreviewFor("D:/work/REPORT.PDF", true)).toBe("pdf");
    expect(mediaPreviewFor("D:/work/page.pdf", false)).toBeNull();
  });

  it("does not take the PDF mark for another kind of file", () => {
    expect(mediaPreviewFor("D:/work/notes.bin", true)).toBeNull();
  });

  it("names pictures, video and sound by their extension", () => {
    expect(mediaPreviewFor("a/b/logo.SVG", false)).toBe("image");
    expect(mediaPreviewFor("a/b/photo.jpeg", false)).toBe("image");
    expect(mediaPreviewFor("a/b/clip.webm", false)).toBe("video");
    expect(mediaPreviewFor("a/b/take.flac", false)).toBe("audio");
    expect(mediaPreviewFor("a/b/archive.zip", false)).toBeNull();
    expect(mediaPreviewFor("a/b/no-extension", false)).toBeNull();
  });
});

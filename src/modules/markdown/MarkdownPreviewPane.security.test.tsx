import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultUrlTransform, Streamdown } from "streamdown";
import { MARKDOWN_PREVIEW_MAX_BYTES } from "./policy";

function render(markdown: string): string {
  return renderToStaticMarkup(
    <Streamdown
      mode="static"
      parseIncompleteMarkdown={false}
      urlTransform={defaultUrlTransform}
    >
      {markdown}
    </Streamdown>,
  );
}

describe("Markdown preview policy", () => {
  it("strips executable HTML attributes", () => {
    const html = render('<img src="x" onerror="alert(1)"><script>alert(2)</script>');

    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(2)");
  });

  it("rejects executable URL schemes", () => {
    const html = render(
      '[click](javascript:alert(1)) <a href="javascript:alert(2)">raw</a>',
    );

    expect(html).not.toContain("javascript:");
  });

  it("keeps normal links and formatting", () => {
    const html = render("**safe** [docs](https://example.com/docs)");

    expect(html).toContain('data-streamdown="strong">safe</span>');
    expect(html).toContain('data-streamdown="link"');
    expect(
      defaultUrlTransform(
        "https://example.com/docs",
        "href",
        {} as never,
      ),
    ).toBe("https://example.com/docs");
  });

  it("bounds rendered files before they cross IPC", () => {
    expect(MARKDOWN_PREVIEW_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

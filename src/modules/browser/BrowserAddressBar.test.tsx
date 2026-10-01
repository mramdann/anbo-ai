import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserAddressBar } from "./BrowserAddressBar";

function render(
  externalBrowser?: Parameters<typeof BrowserAddressBar>[0]["externalBrowser"],
) {
  return renderToStaticMarkup(
    <BrowserAddressBar
      url="https://example.com/"
      onSubmit={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onReload={vi.fn()}
      externalBrowser={externalBrowser}
    />,
  );
}

describe("BrowserAddressBar", () => {
  it("offers the dev-server ports in Anbo's own browser", () => {
    const html = render();
    expect(html).toContain("Ports");
    expect(html).not.toContain("data-external-browser");
  });

  it("shows only the Chrome or Edge logo in an external tab", () => {
    const html = render({ browser: "edge", label: "Edge · Work" });
    expect(html).not.toContain("Ports");
    expect(html).toContain('data-external-browser="edge"');
    expect(html).toContain('src="/browser-icons/edge.svg"');
    expect(html).toContain('title="Edge · Work"');
  });
});

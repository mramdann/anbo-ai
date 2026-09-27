import { ExternalBrowserTabs } from "@/modules/browser/external/ExternalBrowserTabs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("external tab picker", () => {
  it("offers opening a URL and choosing tabs inside Anbo instead of popup sharing", () => {
    const markup = renderToStaticMarkup(
      <ExternalBrowserTabs
        connectionId="profile-one"
        selected={[]}
        disabled={false}
        onChanged={async () => {}}
      />,
    );
    expect(markup).toContain("Open tab");
    expect(markup).toContain("Available tabs");
    expect(markup).toContain("Refresh tabs");
    expect(markup).toContain("Only those tabs connect to Anbo");
    expect(markup).not.toContain("Share this tab");
    expect(markup).toContain('type="url"');
  });
});

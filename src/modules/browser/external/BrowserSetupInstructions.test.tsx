import { BrowserSetupInstructions } from "@/modules/browser/external/BrowserSetupInstructions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("browser setup instructions", () => {
  it.each(["chrome", "edge"] as const)(
    "keeps %s extension and tab consent explicit",
    (browser) => {
      const markup = renderToStaticMarkup(
        <BrowserSetupInstructions
          setup={{
            browser,
            extensionPath: "C:\\Users\\Test\\Anbo\\browser-bridge\\extension",
            extensionsUrl: `${browser}://extensions`,
            warning: null,
          }}
          copied={false}
          onCopy={() => {}}
        />,
      );
      expect(markup).toContain(`${browser}://extensions`);
      expect(markup).toContain("Load unpacked");
      expect(markup).toContain("Connect profile");
      expect(markup).toContain("approve that profile for your workspace");
      expect(markup).toContain("open a URL directly in Anbo");
      expect(markup).not.toContain("Share this tab");
      expect(markup).toContain("Setup does not grant tab control");
      expect(markup).not.toContain("PowerShell");
    },
  );

  it("reports the browser launch fallback without claiming a connection", () => {
    const markup = renderToStaticMarkup(
      <BrowserSetupInstructions
        setup={{
          browser: "edge",
          extensionPath: "C:\\Anbo",
          extensionsUrl: "edge://extensions",
          warning: "Open Edge manually",
        }}
        copied
        onCopy={() => {}}
      />,
    );
    expect(markup).toContain("Folder path copied");
    expect(markup).toContain("Open Edge manually");
    expect(markup).not.toContain("Profile connected");
  });
});

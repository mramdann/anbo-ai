import {
  MenuBody,
  otherTabs,
} from "@/modules/browser/external/ExternalBrowserMenu";
import { dockNotice } from "@/modules/browser/external/ExternalBrowserPane";
import type { ExternalConnection } from "@/modules/browser/external/model";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

const connection = (
  connectionId: string,
  workspace: string | null,
  tabs: ExternalConnection["tabs"] = [],
): ExternalConnection => ({
  connectionId,
  profile: {
    profileId: "00112233-4455-6677-8899-aabbccddeeff",
    browser: "chrome",
    name: "Your Chrome",
  },
  workspace,
  tabs,
});
const noop = () => {};

function body(connections: ExternalConnection[], workspaceRoot = "D:/anbo-ai") {
  return renderToStaticMarkup(
    <MenuBody
      connections={connections}
      workspaceRoot={workspaceRoot}
      onShowTab={noop}
      onCloseTab={noop}
    />,
  );
}

describe("browser menu", () => {
  it("puts a waiting profile first with approve and deny for this workspace", () => {
    const markup = body([connection("a", null)], "D:\\anbo-ai");
    expect(markup).toContain("Needs approval");
    expect(markup).toContain("Chrome wants to connect");
    expect(markup).toContain("Approve for anbo-ai");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Logins stay in Chrome");
  });

  it("lists what a connected profile shows in Anbo and what else it has", () => {
    const markup = body([
      connection("a", "D:/anbo-ai", [
        {
          id: 10,
          title: "Pull requests",
          url: "https://github.com/pulls",
          selectionId: "lease",
          loading: false,
        },
      ]),
    ]);
    expect(markup).toContain("In Anbo");
    expect(markup).toContain("Pull requests");
    expect(markup).toContain("github.com");
    expect(markup).toContain("Return Pull requests to Chrome");
    expect(markup).toContain("Other Chrome tabs");
    expect(markup).toContain("Loading tabs...");
    expect(markup).toContain("Disconnect");
    expect(markup).not.toContain("Needs approval");
    expect(markup).not.toContain("Dock");
  });

  it("names the workspace of a profile approved somewhere else", () => {
    expect(body([connection("a", "D:/other-project")])).toContain(
      "Chrome · other-project",
    );
  });

  it("offers setup when nothing is connected", () => {
    const markup = body([]);
    expect(markup).toContain("Use your Chrome or Edge logins in Anbo");
    expect(markup).toContain("Set up Chrome");
    expect(markup).toContain("Set up Edge");
  });

  it("offers only the tabs that are not in Anbo yet", () => {
    const profile = connection("a", "D:/anbo-ai", [
      {
        id: 10,
        title: "In",
        url: "https://a.test/",
        selectionId: "s",
        loading: false,
      },
    ]);
    expect(
      otherTabs(profile, [
        { id: 10, title: "In", url: "https://a.test/" },
        { id: 11, title: "Out", url: "https://b.test/" },
      ]).map((tab) => tab.id),
    ).toEqual([11]);
  });

  it("tells what the panel is waiting for instead of offering a dock button", () => {
    expect(dockNotice(null, "Chrome")).toBe("Opening the page from Chrome...");
    expect(dockNotice("panel-too-narrow", "Edge")).toContain(
      "Make this panel wider",
    );
    expect(dockNotice("browser-fullscreen", "Chrome")).toContain(
      "full screen in Chrome",
    );
  });
});

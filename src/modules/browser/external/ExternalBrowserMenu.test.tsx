import {
  MenuBody,
  menuLabel,
  otherTabs,
  profileSummary,
  TabRow,
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
    expect(markup).toContain('src="/browser-icons/chrome.svg" alt="Chrome"');
    expect(markup).toContain("Wants to connect");
    expect(markup).toContain("Approve for anbo-ai");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Logins stay in Chrome");
    expect(markup).toContain(">External browsers</span>");
    expect(markup).toContain(">1 waiting</span>");
    expect(markup).not.toContain("Chrome and Edge");
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
    // The logo names the browser, so the lists do not repeat it.
    expect(markup).toContain('alt="Chrome"');
    expect(markup).toContain("Other tabs");
    expect(markup).not.toContain(">Chrome<");
    expect(markup).toContain("Loading tabs...");
    expect(markup).toContain("Disconnect");
    expect(markup).not.toContain("Needs approval");
    expect(markup).not.toContain("Dock");
    expect(markup).toContain(">1 profile connected</span>");
  });

  it("names the workspace of a profile approved somewhere else", () => {
    const markup = body([connection("a", "D:/other-project")]);
    expect(markup).toContain('alt="Chrome"');
    expect(markup).toContain(">other-project</span>");
  });

  it("folds each profile when several are connected", () => {
    const edge = connection("a", "D:/anbo-ai");
    const markup = body([
      { ...edge, profile: { ...edge.profile, browser: "edge", name: "Work" } },
      connection("b", "D:/anbo-ai", [
        {
          id: 10,
          title: "Mail",
          url: "https://mail.test/",
          selectionId: "s",
          loading: false,
        },
      ]),
    ]);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2);
    // A folded profile keeps Disconnect in its row; the lists hold the rest.
    expect(markup.match(/>Disconnect<\/button>/g)).toHaveLength(2);
    expect(markup).not.toContain("1 in Anbo");
    expect(markup).not.toContain("In Anbo</div>");
    expect(markup).not.toContain("Mail");
    // With profiles connected, setup folds into one line.
    expect(markup).toContain("Connect Chrome or Edge");
    expect(markup).not.toContain("Set up Chrome");
    expect(markup).toContain(">2 profiles connected</span>");
  });

  it("puts the Open hint inside the row's own button", () => {
    const markup = renderToStaticMarkup(
      <TabRow
        title="Example Domain"
        url="https://example.com/"
        label="Open Example Domain in Anbo"
        disabled={false}
        onClick={noop}
        hint="Open"
      />,
    );
    expect(markup).toMatch(/Open<\/span><\/button>/);
  });

  it("offers setup when nothing is connected", () => {
    const markup = body([]);
    expect(markup).toContain("Use your Chrome or Edge logins in Anbo");
    expect(markup).toContain("Set up Chrome");
    expect(markup).toContain("Set up Edge");
    expect(markup).toContain(">Not connected</span>");
  });

  it("names the header button after what its badge or dot is for", () => {
    expect(menuLabel(0, 0)).toBe("External browsers: connect Chrome or Edge");
    expect(menuLabel(1, 0)).toBe("External browsers: 1 profile connected");
    expect(menuLabel(2, 1)).toBe(
      "External browsers: a profile is waiting for approval",
    );
    expect(menuLabel(0, 3)).toBe(
      "External browsers: 3 profiles are waiting for approval",
    );
    expect(profileSummary(2, 1)).toBe("2 profiles connected · 1 waiting");
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

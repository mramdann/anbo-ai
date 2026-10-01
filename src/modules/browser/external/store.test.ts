import type { ExternalConnection } from "@/modules/browser/external/model";
import {
  approvedHere,
  pendingConnections,
  profileLabel,
  useExternalBrowsers,
  workspaceName,
} from "@/modules/browser/external/store";
import { describe, expect, it } from "vitest";

const connection = (
  connectionId: string,
  workspace: string | null,
  browser: "chrome" | "edge" = "chrome",
): ExternalConnection => ({
  connectionId,
  profile: {
    profileId: "00112233-4455-6677-8899-aabbccddeeff",
    browser,
    name: "Work",
  },
  workspace,
  tabs: [],
});

describe("external browser store", () => {
  it("counts profiles that wait for approval", () => {
    expect(
      pendingConnections([
        connection("a", null),
        connection("b", "D:/work"),
        connection("c", null),
      ]).map((item) => item.connectionId),
    ).toEqual(["a", "c"]);
  });

  it("knows which workspace a profile's pages land in", () => {
    const work = connection("a", "D:/work");
    expect(approvedHere(work, "d:\\work\\")).toBe(true);
    expect(approvedHere(work, "D:/other")).toBe(false);
    expect(approvedHere(work, null)).toBe(false);
    expect(approvedHere(connection("b", null), "D:/work")).toBe(false);
    expect(profileLabel(connection("a", "D:/work", "edge").profile)).toBe(
      "Edge · Work",
    );
  });

  it("remembers which new tabs were started from a profile", () => {
    const { profile } = connection("a", "D:/work");
    const store = useExternalBrowsers.getState();
    store.setNewTabProfile(7, profile);
    expect(useExternalBrowsers.getState().newTabProfiles[7]).toBe(profile);
    const before = useExternalBrowsers.getState();
    store.setNewTabProfile(8, null);
    expect(useExternalBrowsers.getState()).toBe(before);
    store.setNewTabProfile(7, null);
    expect(useExternalBrowsers.getState().newTabProfiles).toEqual({});
  });

  it("keeps the same list when the browser reports nothing new", () => {
    const list = [connection("a", "D:/work")];
    useExternalBrowsers.getState().setConnections(list);
    const before = useExternalBrowsers.getState().connections;
    useExternalBrowsers.getState().setConnections([connection("a", "D:/work")]);
    expect(useExternalBrowsers.getState().connections).toBe(before);
    useExternalBrowsers.getState().setConnections([]);
    expect(useExternalBrowsers.getState().connections).toEqual([]);
  });

  it("names a workspace by its folder", () => {
    expect(workspaceName("D:\\anbo-dev-local\\sandbox\\")).toBe("sandbox");
    expect(workspaceName("/home/me/project")).toBe("project");
  });
});

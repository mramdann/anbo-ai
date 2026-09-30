import type { ExternalConnection } from "@/modules/browser/external/model";
import {
  approvedBrowserLabel,
  approvedConnection,
  pendingConnections,
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

  it("picks the workspace's profile only when exactly one is approved there", () => {
    const work = connection("a", "D:/work");
    expect(approvedConnection([work], "d:\\work\\")).toBe(work);
    expect(
      approvedConnection([work, connection("b", "D:/work")], "D:/work"),
    ).toBeNull();
    expect(approvedConnection([work], "D:/other")).toBeNull();
    expect(approvedConnection([work], null)).toBeNull();
    expect(
      approvedBrowserLabel([connection("a", "D:/work", "edge")], "D:/work"),
    ).toBe("Edge · Work");
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

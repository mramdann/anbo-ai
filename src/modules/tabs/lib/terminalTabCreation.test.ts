import { describe, expect, it } from "vitest";
import { createTerminalTab, labelFor } from "@/modules/tabs";

describe("terminal tab creation", () => {
  it("keeps the workspace-derived default for user terminals", () => {
    const tab = createTerminalTab(1, 2, "space-a", "C:/work/notaris-surat");

    expect(tab.title).toBe("notaris-surat");
    expect(tab.customTitle).toBeUndefined();
    expect(labelFor(tab)).toBe("notaris-surat");
  });

  it("uses the mandatory agent-provided title for opened terminals", () => {
    const tab = createTerminalTab(1, 2, "space-a", "C:/work/notaris-surat", {
      title: "Dev Server",
      cold: false,
    });

    expect(tab.title).toBe("Dev Server");
    expect(tab.customTitle).toBe("Dev Server");
    expect(tab.cold).toBe(false);
    expect(labelFor(tab)).toBe("Dev Server");
  });
});

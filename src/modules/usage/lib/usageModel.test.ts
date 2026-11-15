import type { Tab } from "@/modules/tabs/lib/useTabs";
import { describe, expect, it } from "vitest";
import {
  buildUsageModel,
  formatCpu,
  formatMemory,
  normalizePath,
  type UsageInputs,
  type UsageSnapshot,
} from "./usageModel";

const MB = 1024 * 1024;

function process(
  pid: number,
  name: string,
  mb: number,
  cpu: number | null = 1,
) {
  return { pid, parentPid: 1, name, memory: mb * MB, cpu };
}

const snapshot: UsageSnapshot = {
  supported: true,
  at: 0,
  cores: 4,
  appPid: 1,
  machine: { memoryTotal: 8192 * MB, memoryUsed: 6000 * MB, cpu: 40 },
  processes: [
    process(1, "anbo.exe", 30),
    process(2, "msedgewebview2.exe", 120),
    process(3, "msedgewebview2.exe", 60),
    process(30, "msedgewebview2.exe", 200),
    process(31, "msedgewebview2.exe", 100, 2),
    process(40, "powershell.exe", 50),
    process(41, "claude.exe", 300, 5),
    process(42, "node.exe", 80),
    process(50, "powershell.exe", 50),
    process(51, "python.exe", 70),
    process(60, "pwsh.exe", 40, 0),
    process(70, "conhost.exe", 6),
    process(71, "OpenConsole.exe", 6),
    process(80, "whisper-server.exe", 400),
    process(90, "node.exe", 150),
    process(91, "rust-analyzer.exe", 500),
    process(95, "cmd.exe", 4),
  ],
  terminals: [
    { ptyId: 101, shellPid: 40, pids: [40, 41, 42] },
    { ptyId: 102, shellPid: 50, pids: [50, 51, 70] },
    { ptyId: 103, shellPid: 60, pids: [60] },
    // A terminal no tab holds any more.
    { ptyId: 999, shellPid: 95, pids: [95] },
  ],
  browserTabs: [
    { tabId: 3, pids: [30, 31] },
    { tabId: 4, pids: [31] },
  ],
  browserEngine: [{ pid: 3, kind: "gpu" }],
  languageServers: [
    { root: "\\\\?\\D:\\work\\shop\\web", pids: [90] },
    { root: "E:\\other", pids: [91] },
  ],
};

const leaf = (id: number) => ({ kind: "leaf" as const, id });

const tabs = [
  {
    id: 1,
    kind: "terminal",
    title: "claude",
    spaceId: "a",
    paneTree: leaf(11),
    activeLeafId: 11,
    agent: {
      launcherId: "claude",
      icon: "claude",
      label: "Claude Code",
      name: "Lucian",
    },
  },
  {
    id: 2,
    kind: "terminal",
    title: "server",
    customTitle: "server",
    spaceId: "a",
    paneTree: {
      kind: "split",
      id: 20,
      dir: "row",
      children: [leaf(21), leaf(22)],
    },
    activeLeafId: 21,
  },
  {
    id: 3,
    kind: "browser",
    title: "Shop admin",
    url: "https://shop.test/admin",
    spaceId: "a",
  },
  {
    id: 4,
    kind: "browser",
    title: "",
    url: "https://shop.test/blog",
    spaceId: "b",
  },
  {
    id: 5,
    kind: "browser",
    title: "Docs",
    url: "https://docs.test/",
    spaceId: "b",
    external: { browser: "edge", profileId: "p", name: "Edge" },
  },
  {
    id: 6,
    kind: "terminal",
    title: "old",
    customTitle: "old",
    spaceId: "b",
    paneTree: leaf(61),
    activeLeafId: 61,
    cold: true,
  },
  {
    id: 7,
    kind: "editor",
    title: "a.ts",
    path: "D:/work/shop/a.ts",
    dirty: false,
    preview: false,
    spaceId: "a",
  },
] as unknown as Tab[];

const inputs: UsageInputs = {
  spaces: [
    { id: "a", name: "Shop", root: "D:/work/shop" },
    { id: "b", name: "Blog", root: "D:\\work\\blog" },
  ],
  tabs,
  ptyIdForLeaf: (leafId) =>
    ({ 11: 101, 21: 102, 22: 103, 61: 104 })[leafId] ?? null,
  agents: { 11: { name: "Lucian", agent: "claude", status: "working" } },
  servers: [{ root: "D:/work/shop/web", presetId: "typescript" }],
};

describe("usage by workspace", () => {
  const model = buildUsageModel(snapshot, inputs);
  const shop = model.workspaces.find((w) => w.spaceId === "a");
  const blog = model.workspaces.find((w) => w.spaceId === "b");

  it("gives each terminal its job's processes, an agent's included", () => {
    const agent = shop?.rows.find((row) => row.key === "leaf:11");
    expect(agent).toMatchObject({
      kind: "agent",
      label: "Lucian",
      detail: "claude · working",
      memory: (50 + 300 + 80) * MB,
      cpu: 7,
      processes: 3,
      running: true,
    });
    const pane1 = shop?.rows.find((row) => row.key === "leaf:21");
    // Its console host came with it; the shell and the host are no program.
    expect(pane1).toMatchObject({
      kind: "terminal",
      label: "server · pane 1",
      detail: "python",
      memory: (50 + 70 + 6) * MB,
    });
    expect(shop?.rows.find((row) => row.key === "leaf:22")).toMatchObject({
      detail: "idle",
      cpu: 0,
    });
  });

  it("splits a renderer two tabs share and names a tab of Chrome or Edge without numbers", () => {
    expect(shop?.rows.find((row) => row.key === "tab:3")).toMatchObject({
      kind: "browser",
      label: "Shop admin",
      detail: "shop.test",
      memory: (200 + 50) * MB,
      cpu: 2,
    });
    expect(blog?.rows.find((row) => row.key === "tab:4")).toMatchObject({
      label: "shop.test",
      memory: 50 * MB,
      cpu: 1,
    });
    expect(blog?.rows.find((row) => row.key === "tab:5")).toMatchObject({
      kind: "external",
      detail: "in Edge",
      memory: null,
      cpu: null,
    });
  });

  it("shows a paused terminal as not running", () => {
    expect(blog?.rows.find((row) => row.key === "leaf:61")).toMatchObject({
      detail: "not running",
      memory: 0,
      cpu: null,
      running: false,
    });
  });

  it("gives a language server to the workspace that holds its folder", () => {
    expect(shop?.rows.find((row) => row.kind === "server")).toMatchObject({
      label: "typescript",
      detail: "web",
      memory: 150 * MB,
    });
    expect(model.anbo.rows.find((row) => row.kind === "server")).toMatchObject({
      label: "Language server",
      detail: "other",
    });
  });

  it("counts each workspace's items and totals", () => {
    expect(shop?.counts).toEqual({
      agents: 1,
      terminals: 2,
      browserTabs: 1,
      notRunning: 0,
    });
    // The paused terminal is counted apart, not as a running one.
    expect(blog?.counts).toEqual({
      agents: 0,
      terminals: 0,
      browserTabs: 2,
      notRunning: 1,
    });
    expect(shop?.memory).toBe((430 + 126 + 40 + 250 + 150) * MB);
  });

  it("keeps what is left as Anbo's own, and every process counted once", () => {
    const labels = model.anbo.rows.map(
      (row) => `${row.label}:${row.memory === null ? "-" : row.memory / MB}`,
    );
    expect(labels).toEqual([
      "Language server:500",
      "Anbo:30",
      "Interface:120",
      "Browser engine:60",
      "Voice:400",
      "Console hosts:6",
      "Other terminals:4",
    ]);
    const counted =
      model.workspaces.reduce((sum, workspace) => sum + workspace.memory, 0) +
      model.anbo.memory;
    expect(counted).toBe(model.total.memory);
  });

  it("reads CPU as unknown on the first read", () => {
    const first = buildUsageModel(
      {
        ...snapshot,
        processes: snapshot.processes.map((p) => ({ ...p, cpu: null })),
      },
      inputs,
    );
    expect(first.total.cpu).toBeNull();
    expect(first.workspaces[0].cpu).toBeNull();
  });
});

describe("usage formatting", () => {
  it("writes memory in MB under a gigabyte and GB above", () => {
    expect(formatMemory(null)).toBe("–");
    expect(formatMemory(412 * MB)).toBe("412 MB");
    expect(formatMemory(1.62 * 1024 * MB)).toBe("1.6 GB");
  });

  it("writes CPU with one decimal below ten percent", () => {
    expect(formatCpu(null)).toBe("–");
    expect(formatCpu(0.01)).toBe("0%");
    expect(formatCpu(3.42)).toBe("3.4%");
    expect(formatCpu(23.4)).toBe("23%");
  });

  it("compares paths in one spelling", () => {
    expect(normalizePath("\\\\?\\D:\\Work\\Shop\\")).toBe("d:/work/shop");
    expect(normalizePath("D:/work/shop")).toBe("d:/work/shop");
  });
});

import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { leafIds } from "@/modules/terminal/lib/panes";

/** What Rust's `usage_snapshot` answers (src-tauri/src/modules/usage.rs). */
type ProcessUsage = {
  pid: number;
  parentPid: number;
  name: string;
  /** The private working set in bytes: the "Memory" Task Manager shows. */
  memory: number;
  /** Percent of all processors since the previous read; null on the first. */
  cpu: number | null;
};

export type UsageSnapshot = {
  supported: boolean;
  at: number;
  cores: number;
  appPid: number;
  machine: { memoryTotal: number; memoryUsed: number; cpu: number | null };
  processes: ProcessUsage[];
  terminals: { ptyId: number; shellPid: number; pids: number[] }[];
  browserTabs: { tabId: number; pids: number[] }[];
  browserEngine: { pid: number; kind: string }[];
  languageServers: { root: string; pids: number[] }[];
};

type UsageRowKind =
  | "agent"
  | "terminal"
  | "browser"
  | "external"
  | "server"
  | "anbo";

export type UsageRow = {
  key: string;
  kind: UsageRowKind;
  tabId?: number;
  leafId?: number;
  label: string;
  detail: string | null;
  /** Bytes; null where Anbo cannot tell (a Chrome or Edge tab). */
  memory: number | null;
  cpu: number | null;
  processes: number;
  /** False for a tab that is not running: paused, or not opened yet. */
  running: boolean;
};

export type WorkspaceUsage = {
  spaceId: string;
  name: string;
  memory: number;
  cpu: number | null;
  rows: UsageRow[];
  counts: {
    agents: number;
    terminals: number;
    browserTabs: number;
    notRunning: number;
  };
};

export type UsageModel = {
  supported: boolean;
  workspaces: WorkspaceUsage[];
  anbo: { memory: number; cpu: number | null; rows: UsageRow[] };
  total: { memory: number; cpu: number | null };
  machine: UsageSnapshot["machine"];
};

export type AgentInfo = {
  name: string;
  /** The CLI, as detected from the terminal (e.g. "claude"). */
  agent: string;
  status: "working" | "waiting";
};

export type UsageInputs = {
  spaces: readonly { id: string; name: string; root: string | null }[];
  tabs: readonly Tab[];
  ptyIdForLeaf: (leafId: number) => number | null;
  /** Live agents by terminal leaf (useAgentStore's sessions). */
  agents: Readonly<Record<number, AgentInfo | undefined>>;
  /** Live language servers by root (useLspRuntimeStore), for their names. */
  servers: readonly { root: string; presetId: string }[];
};

type Totals = { memory: number; cpu: number | null; processes: number };

const SHELLS = new Set([
  "powershell.exe",
  "pwsh.exe",
  "cmd.exe",
  "bash.exe",
  "sh.exe",
  "zsh.exe",
  "fish.exe",
  "wsl.exe",
  "conhost.exe",
  "openconsole.exe",
]);

/** A path in one spelling: forward slashes, no `\\?\`, no trailing slash, lower case. */
export function normalizePath(path: string): string {
  return path
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function addCpu(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** The programs a terminal runs, by name, without its shell and console host. */
function programsOf(
  pids: readonly number[],
  processes: ReadonlyMap<number, ProcessUsage>,
): string[] {
  const names: string[] = [];
  for (const pid of pids) {
    const name = processes.get(pid)?.name;
    if (!name || SHELLS.has(name.toLowerCase())) continue;
    const short = name.replace(/\.exe$/i, "");
    if (!names.includes(short)) names.push(short);
  }
  return names;
}

/**
 * Anbo's processes by workspace: each terminal (its job: the shell and all it
 * runs), each agent (its terminal), each tab of Anbo's own browser (its
 * renderers, a renderer several tabs share split between them) and each
 * language server (by the folder it serves). What is left is Anbo's own: the
 * app, the browser engine, the voice runtime, the console hosts.
 */
export function buildUsageModel(
  snapshot: UsageSnapshot,
  inputs: UsageInputs,
): UsageModel {
  const processes = new Map(
    snapshot.processes.map((process) => [process.pid, process]),
  );
  const claimed = new Set<number>();
  const sum = (
    pids: readonly number[],
    share: (pid: number) => number = () => 1,
  ): Totals => {
    const totals: Totals = { memory: 0, cpu: null, processes: 0 };
    for (const pid of pids) {
      const process = processes.get(pid);
      if (!process) continue;
      const part = share(pid);
      totals.memory += process.memory * part;
      totals.cpu = addCpu(
        totals.cpu,
        process.cpu === null ? null : process.cpu * part,
      );
      totals.processes += 1;
      claimed.add(pid);
    }
    return totals;
  };
  const terminals = new Map(
    snapshot.terminals.map((terminal) => [terminal.ptyId, terminal]),
  );
  const browserTabs = new Map(
    snapshot.browserTabs.map((tab) => [tab.tabId, tab]),
  );
  const tabsSharing = new Map<number, number>();
  for (const tab of snapshot.browserTabs) {
    for (const pid of tab.pids)
      tabsSharing.set(pid, (tabsSharing.get(pid) ?? 0) + 1);
  }
  const knownSpaces = new Set(inputs.spaces.map((space) => space.id));
  const rowsBySpace = new Map<string, UsageRow[]>();
  const push = (spaceId: string, row: UsageRow) => {
    const rows = rowsBySpace.get(spaceId);
    if (rows) rows.push(row);
    else rowsBySpace.set(spaceId, [row]);
  };

  for (const tab of inputs.tabs) {
    if (!knownSpaces.has(tab.spaceId)) continue;
    if (tab.kind === "terminal") {
      const leaves = leafIds((tab as TerminalTab).paneTree);
      leaves.forEach((leafId, index) => {
        const ptyId = tab.cold ? null : inputs.ptyIdForLeaf(leafId);
        const terminal = ptyId === null ? undefined : terminals.get(ptyId);
        const pids = terminal?.pids ?? [];
        const totals = sum(pids);
        const agent = inputs.agents[leafId];
        const identity = (tab as TerminalTab).agent;
        const running = terminal !== undefined;
        const pane = leaves.length > 1 ? ` · pane ${index + 1}` : "";
        if (agent || identity) {
          const cli = agent?.agent || identity?.label || "agent";
          const state = !running
            ? "not running"
            : agent?.status === "working"
              ? "working"
              : "waiting";
          push(tab.spaceId, {
            key: `leaf:${leafId}`,
            kind: "agent",
            tabId: tab.id,
            leafId,
            label: `${agent?.name || identity?.name || labelFor(tab)}${pane}`,
            detail: `${cli} · ${state}`,
            memory: totals.memory,
            cpu: totals.cpu,
            processes: totals.processes,
            running,
          });
          return;
        }
        const programs = programsOf(pids, processes);
        push(tab.spaceId, {
          key: `leaf:${leafId}`,
          kind: "terminal",
          tabId: tab.id,
          leafId,
          label: `${labelFor(tab)}${pane}`,
          detail: !running
            ? "not running"
            : programs.length
              ? programs.join(", ")
              : "idle",
          memory: totals.memory,
          cpu: totals.cpu,
          processes: totals.processes,
          running,
        });
      });
      continue;
    }
    if (tab.kind === "browser") {
      if (tab.external) {
        push(tab.spaceId, {
          key: `tab:${tab.id}`,
          kind: "external",
          tabId: tab.id,
          label: tab.title || tab.url,
          detail: `in ${tab.external.browser === "edge" ? "Edge" : "Chrome"}`,
          memory: null,
          cpu: null,
          processes: 0,
          running: true,
        });
        continue;
      }
      const pids = browserTabs.get(tab.id)?.pids ?? [];
      const totals = sum(pids, (pid) => 1 / (tabsSharing.get(pid) ?? 1));
      const running = !tab.cold && pids.length > 0;
      push(tab.spaceId, {
        key: `tab:${tab.id}`,
        kind: "browser",
        tabId: tab.id,
        label: tab.title || hostOf(tab.url) || tab.url,
        detail: tab.cold ? "not loaded" : hostOf(tab.url),
        memory: totals.memory,
        cpu: totals.cpu,
        processes: totals.processes,
        running,
      });
    }
  }

  // Language servers go to the workspace whose folder holds theirs.
  const roots = inputs.spaces
    .filter((space) => space.root)
    .map((space) => ({
      id: space.id,
      root: normalizePath(space.root as string),
    }))
    .sort((a, b) => b.root.length - a.root.length);
  const serverNames = new Map(
    inputs.servers.map((server) => [
      normalizePath(server.root),
      server.presetId,
    ]),
  );
  const anboRows: UsageRow[] = [];
  snapshot.languageServers.forEach((server, index) => {
    const root = normalizePath(server.root);
    const owner = roots.find((space) => within(root, space.root));
    const totals = sum(server.pids);
    if (totals.processes === 0) return;
    const folder = root.split("/").filter(Boolean).pop() ?? root;
    const row: UsageRow = {
      key: `server:${index}:${root}`,
      kind: "server",
      label: serverNames.get(root) ?? "Language server",
      detail: folder,
      memory: totals.memory,
      cpu: totals.cpu,
      processes: totals.processes,
      running: true,
    };
    if (owner) push(owner.id, row);
    else anboRows.push(row);
  });

  // A terminal no workspace tab holds (one still closing, say).
  const looseTerminals = snapshot.terminals.flatMap((terminal) =>
    terminal.pids.filter((pid) => !claimed.has(pid)),
  );

  // What is left is Anbo's own.
  const engine = new Set(snapshot.browserEngine.map((process) => process.pid));
  const groups: {
    key: string;
    label: string;
    detail: string | null;
    pids: number[];
  }[] = [
    { key: "app", label: "Anbo", detail: "the app", pids: [] },
    {
      key: "interface",
      label: "Interface",
      detail: "Anbo's windows (WebView2)",
      pids: [],
    },
    {
      key: "engine",
      label: "Browser engine",
      detail: "shared by Anbo's browser tabs",
      pids: [],
    },
    { key: "voice", label: "Voice", detail: "Whisper", pids: [] },
    { key: "consoles", label: "Console hosts", detail: null, pids: [] },
    {
      key: "terminals",
      label: "Other terminals",
      detail: "not in a workspace tab",
      pids: looseTerminals,
    },
  ];
  const group = (key: string) =>
    groups.find((entry) => entry.key === key) as (typeof groups)[number];
  const loose = new Set(looseTerminals);
  const others = new Map<string, number[]>();
  for (const process of snapshot.processes) {
    if (claimed.has(process.pid) || loose.has(process.pid)) continue;
    const name = process.name.toLowerCase();
    if (process.pid === snapshot.appPid) group("app").pids.push(process.pid);
    else if (engine.has(process.pid)) group("engine").pids.push(process.pid);
    else if (name === "whisper-server.exe")
      group("voice").pids.push(process.pid);
    else if (name === "msedgewebview2.exe")
      group("interface").pids.push(process.pid);
    else if (name === "conhost.exe" || name === "openconsole.exe")
      group("consoles").pids.push(process.pid);
    else {
      const pids = others.get(process.name);
      if (pids) pids.push(process.pid);
      else others.set(process.name, [process.pid]);
    }
  }
  for (const entry of groups) {
    const totals = sum(entry.pids);
    if (totals.processes === 0) continue;
    anboRows.push({
      key: `anbo:${entry.key}`,
      kind: "anbo",
      label: entry.label,
      detail:
        entry.key === "consoles"
          ? `${totals.processes} terminal${totals.processes === 1 ? "" : "s"}`
          : entry.detail,
      memory: totals.memory,
      cpu: totals.cpu,
      processes: totals.processes,
      running: true,
    });
  }
  for (const [name, pids] of others) {
    const totals = sum(pids);
    anboRows.push({
      key: `anbo:other:${name}`,
      kind: "anbo",
      label: name.replace(/\.exe$/i, ""),
      detail: null,
      memory: totals.memory,
      cpu: totals.cpu,
      processes: totals.processes,
      running: true,
    });
  }

  const rowTotals = (rows: readonly UsageRow[]) =>
    rows.reduce(
      (acc, row) => ({
        memory: acc.memory + (row.memory ?? 0),
        cpu: addCpu(acc.cpu, row.cpu),
      }),
      { memory: 0, cpu: null as number | null },
    );
  const workspaces: WorkspaceUsage[] = inputs.spaces.map((space) => {
    const rows = rowsBySpace.get(space.id) ?? [];
    const totals = rowTotals(rows);
    return {
      spaceId: space.id,
      name: space.name,
      memory: totals.memory,
      cpu: totals.cpu,
      rows,
      // What runs; a paused or not yet opened tab is counted apart.
      counts: {
        agents: rows.filter((row) => row.running && row.kind === "agent")
          .length,
        terminals: rows.filter((row) => row.running && row.kind === "terminal")
          .length,
        browserTabs: rows.filter(
          (row) =>
            row.running && (row.kind === "browser" || row.kind === "external"),
        ).length,
        notRunning: rows.filter((row) => !row.running).length,
      },
    };
  });
  const anbo = rowTotals(anboRows);
  const total = snapshot.processes.reduce(
    (acc, process) => ({
      memory: acc.memory + process.memory,
      cpu: addCpu(acc.cpu, process.cpu),
    }),
    { memory: 0, cpu: null as number | null },
  );
  return {
    supported: snapshot.supported,
    workspaces,
    anbo: { memory: anbo.memory, cpu: anbo.cpu, rows: anboRows },
    total,
    machine: snapshot.machine,
  };
}

/** Bytes as the usage view shows them: "412 MB", "1.6 GB". */
export function formatMemory(bytes: number | null): string {
  if (bytes === null) return "–";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "0 MB";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** A share of all processors: "0%", "3.4%", "23%". */
export function formatCpu(percent: number | null): string {
  if (percent === null) return "–";
  if (percent < 0.05) return "0%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

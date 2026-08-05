import type { SearchAddon } from "@xterm/addon-search";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  dockviewLayoutKey,
  paneTreeToDockviewLayout,
  terminalPanelId,
} from "./lib/dockviewLayout";
import { useTerminalDropStore } from "./lib/dropStore";
import { findLeafCwd, type PaneNode } from "./lib/panes";
import type { TerminalPaneHandle } from "./TerminalPane";
import { TerminalPane } from "./TerminalPane";
import "./DockviewTerminalSpike.css";

type LeafBundle = {
  setRef: (handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

type SpikeContextValue = {
  paneTree: PaneNode;
  activeLeafId: number;
  tabVisible: boolean;
  blocks: boolean;
  getBundle: (leafId: number) => LeafBundle;
  onFocusLeaf: (leafId: number) => void;
};

const SpikeContext = createContext<SpikeContextValue | null>(null);
const components = { terminal: DockviewTerminalPanel };
const spikeTheme = {
  name: "anbo-spike",
  className: "dockview-theme-anbo-spike",
};

function DockviewTerminalPanel(props: IDockviewPanelProps<{ leafId: number }>) {
  const context = useContext(SpikeContext);
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);

  useEffect(() => {
    const visibility = props.api.onDidVisibilityChange((event) =>
      setPanelVisible(event.isVisible),
    );
    return () => visibility.dispose();
  }, [props.api]);

  if (!context) return null;

  const leafId = props.params.leafId;
  const visible = context.tabVisible && panelVisible;
  const focused = visible && context.activeLeafId === leafId;
  const bundle = context.getBundle(leafId);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: terminal surface mirrors PaneTreeView focus tracking
    <div
      className="relative h-full w-full"
      data-pane-leaf={leafId}
      data-dockview-spike="terminal"
      onMouseDownCapture={() => context.onFocusLeaf(leafId)}
      onFocus={() => context.onFocusLeaf(leafId)}
    >
      <TerminalPane
        leafId={leafId}
        visible={visible}
        focused={focused}
        initialCwd={findLeafCwd(context.paneTree, leafId)}
        blocks={context.blocks}
        ref={bundle.setRef}
        onSearchReady={bundle.onSearchReady}
        onCwd={bundle.onCwd}
        onExit={bundle.onExit}
      />
      <DropOverlay leafId={leafId} />
    </div>
  );
}

function SpikeTab(props: IDockviewPanelHeaderProps) {
  return (
    <div className="anbo-dockview-spike-tab">
      {props.api.title ?? "Terminal"}
    </div>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const active = useTerminalDropStore((state) => state.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      Drop file path here
    </div>
  );
}

type Props = SpikeContextValue;

export function DockviewTerminalSpike({
  paneTree,
  activeLeafId,
  tabVisible,
  blocks,
  onFocusLeaf,
  getBundle,
}: Props) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const latestLayoutInput = useRef({ paneTree, activeLeafId });
  const latestFocusInput = useRef({ activeLeafId, onFocusLeaf });
  const applyingLayout = useRef(false);
  const layoutKey = dockviewLayoutKey(paneTree);

  useEffect(() => {
    latestLayoutInput.current = { paneTree, activeLeafId };
  }, [paneTree, activeLeafId]);

  useEffect(() => {
    latestFocusInput.current = { activeLeafId, onFocusLeaf };
  }, [activeLeafId, onFocusLeaf]);

  useEffect(() => {
    if (!api) return;
    const input = latestLayoutInput.current;
    if (dockviewLayoutKey(input.paneTree) !== layoutKey) return;
    applyingLayout.current = true;
    try {
      api.fromJSON(
        paneTreeToDockviewLayout(input.paneTree, input.activeLeafId),
        { reuseExistingPanels: true },
      );
    } finally {
      applyingLayout.current = false;
    }
  }, [api, layoutKey]);

  useEffect(() => {
    if (!api) return;
    const panel = api.getPanel(terminalPanelId(activeLeafId));
    if (panel && !panel.api.isGroupActive) panel.api.setActive();
  }, [api, activeLeafId]);

  useEffect(() => {
    if (!api) return;
    const activePanel = api.onDidActivePanelChange((panel) => {
      if (applyingLayout.current || !panel) return;
      const leafId = panel.api.getParameters<{ leafId?: unknown }>().leafId;
      const focusInput = latestFocusInput.current;
      if (typeof leafId === "number" && leafId !== focusInput.activeLeafId) {
        focusInput.onFocusLeaf(leafId);
      }
    });
    return () => activePanel.dispose();
  }, [api]);

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
  };

  return (
    <SpikeContext.Provider
      value={{
        paneTree,
        activeLeafId,
        tabVisible,
        blocks,
        getBundle,
        onFocusLeaf,
      }}
    >
      <div className="h-full w-full" data-dockview-spike-host>
        <DockviewReact
          components={components}
          defaultTabComponent={SpikeTab}
          disableDnd
          disableFloatingGroups
          theme={spikeTheme}
          onReady={onReady}
        />
      </div>
    </SpikeContext.Provider>
  );
}

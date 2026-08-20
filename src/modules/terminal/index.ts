export { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
export {
  collectRetainedTerminalLeafIds,
  selectBackgroundTerminalTabs,
} from "./lib/liveTerminals";
export {
  clearFocusedTerminal,
  disposeSession,
  disposeSessionsOutside,
  leafHasForegroundProcess,
  leafIdForPty,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  readTerminalBuffer,
  respawnSession,
  subscribeTerminalInput,
  whenSessionReady,
  writeToReadySession,
  writeToSession,
} from "./lib/useTerminalSession";
export {
  clearAgentActivity,
  setAgentActivity,
  type AgentTabStatus,
  tabAgentStatus,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export {
  findLeafCwd,
  hasLeaf,
  isLeaf,
  leafIds,
  type PaneBounds,
  type PaneId,
  type PaneNode,
  type SplitDir,
} from "./lib/panes";

export {
  clearAgentActivity,
  setAgentActivity,
  tabAgentStatus,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  collectRetainedTerminalLeafIds,
  selectBackgroundTerminalTabs,
} from "./lib/liveTerminals";
export { findLeafCwd, hasLeaf, leafIds, type PaneBounds } from "./lib/panes";
export { refitVisibleTerminalSlots } from "./lib/rendererPool";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export {
  clearFocusedTerminal,
  disposeSession,
  disposeSessionsOutside,
  leafHasForegroundProcess,
  leafIdForPty,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  prepareTerminalAutomationSession,
  readTerminalBuffer,
  readTerminalScreen,
  getTerminalSessionState,
  subscribeTerminalInput,
  writeToReadySession,
  writeToSession,
} from "./lib/useTerminalSession";
export { setTerminalAutomationHandler } from "./lib/terminalAutomationBridge";
export type { TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";

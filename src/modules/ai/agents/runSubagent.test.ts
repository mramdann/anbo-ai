import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { runSubagent } from "./runSubagent";

const mocks = vi.hoisted(() => ({
  buildConfiguredLanguageModel: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../lib/agent", () => ({
  buildConfiguredLanguageModel: mocks.buildConfiguredLanguageModel,
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  stepCountIs: vi.fn(() => vi.fn()),
  tool: vi.fn((definition) => definition),
}));

describe("runSubagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildConfiguredLanguageModel.mockResolvedValue({});
    mocks.generateText.mockResolvedValue({
      text: "done",
      steps: [{}],
    });
  });

  it("resolves a custom endpoint with the same runtime configuration as the panel", async () => {
    const keys = {} as ProviderKeys;
    const local = {
      customEndpoints: [
        {
          id: "endpoint-1",
          name: "Local gateway",
          baseURL: "https://models.example.test/v1",
          modelId: "example-model",
          contextLimit: 128_000,
        },
      ],
      customEndpointKeys: { "endpoint-1": "endpoint-key" },
    };

    const result = await runSubagent({
      type: "explore",
      prompt: "Find the entry point",
      keys,
      modelId: "compat-endpoint-1",
      local,
      toolContext: {
        getCwd: () => "C:/workspace",
        getWorkspaceRoot: () => "C:/workspace",
        getWorkspaceEnv: () => ({ kind: "local" }),
        getTerminalContext: () => null,
        isActiveTerminalPrivate: () => false,
        injectIntoActivePty: () => false,
        openBrowser: () => false,
        navigateBrowser: () => false,
        getActiveBrowserTabId: () => null,
        switchBrowserTab: () => false,
        closeBrowserTab: () => false,
        spawnAgent: () => null,
        readAgentOutput: () => null,
        readCache: new Map(),
        getSessionId: () => "session-1",
      } satisfies ToolContext,
    });

    expect(mocks.buildConfiguredLanguageModel).toHaveBeenCalledWith(
      "compat-endpoint-1",
      keys,
      local,
    );
    expect(result.summary).toBe("done");
  });
});

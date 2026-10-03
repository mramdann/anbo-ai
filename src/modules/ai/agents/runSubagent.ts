import { generateText, isStepCount } from "ai";
import { DEFAULT_MODEL_ID, type ModelId } from "../config";
import {
  buildConfiguredLanguageModel,
  type LocalProviderConfig,
} from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: string;
  local?: LocalProviderConfig;
  toolContext: ToolContext;
  onStep?: (label: string) => void;
  abortSignal?: AbortSignal;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  local,
  toolContext,
  onStep,
  abortSignal,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  // A subagent has no user to ask, so a tool that needs approval is never
  // handed to one, whatever its definition lists.
  const fs = buildFsTools(toolContext);
  const readOnly: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...fs.tools, ...buildSearchTools(toolContext) }).filter(
      ([name]) => !(name in fs.approval),
    ),
  );
  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) tools[t] = readOnly[t];
  }

  const model = await buildConfiguredLanguageModel(modelId, keys, local);

  const start = Date.now();
  const result = await generateText({
    model,
    instructions: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: isStepCount(SUBAGENT_MAX_STEPS),
    abortSignal,
    onStepEnd: (step) => {
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}

export const DEFAULT_SUBAGENT_MODEL: ModelId = DEFAULT_MODEL_ID;

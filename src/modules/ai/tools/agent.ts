import {
  sanitizeAgentMessage,
  submitAgentMessage,
} from "@/modules/agents/lib/agentAutomation";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { readTerminalBuffer, writeToSession } from "@/modules/terminal";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

function tailLines(text: string, n: number): string {
  const parts = text.split("\n");
  return parts.length <= n ? text : parts.slice(parts.length - n).join("\n");
}

export function buildManagedAgentTools(ctx: ToolContext) {
  return {
    spawn_coding_agent: tool({
      description:
        "Delegate to a new Claude Code terminal after user approval of a self-contained prompt. Only when requested and this session has no active agent; otherwise use send_to_agent.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            "The full, self-contained task prompt for the Claude Code agent.",
          ),
      }),
      needsApproval: true,
      execute: async ({ prompt }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        const store = useManagedAgentsStore.getState();
        if (store.getBySessionId(sessionId)) {
          return {
            error: "agent already active; use send_to_agent",
          };
        }
        const spawned = ctx.spawnAgent(prompt);
        if (!spawned) return { error: "could not spawn the agent" };
        return {
          ok: true,
          tab_id: spawned.tabId,
          message: "Claude Code agent spawned.",
        };
      },
    }),

    send_to_agent: tool({
      description:
        "After reading current output, send the active Claude Code agent one self-contained follow-up. Requires user approval before submission.",
      inputSchema: z.object({
        instruction: z
          .string()
          .min(1)
          .describe(
            "One clear, self-contained instruction for the agent. No control characters.",
          ),
      }),
      needsApproval: true,
      execute: async ({ instruction }) => {
        const sessionId = ctx.getSessionId();
        const store = useManagedAgentsStore.getState();
        const managed = sessionId ? store.getBySessionId(sessionId) : undefined;
        if (!managed) {
          return {
            error: "no active agent; use spawn_coding_agent",
          };
        }
        const normalized = sanitizeAgentMessage(instruction);
        if (!normalized.ok) return { error: normalized.error };
        if (
          !(await submitAgentMessage(
            writeToSession,
            readTerminalBuffer,
            managed.leafId,
            normalized.message,
          ))
        ) {
          store.remove(managed.leafId);
          return { error: "agent terminal is no longer available (closed?)" };
        }
        store.bumpRound(managed.leafId);
        return {
          ok: true,
          sent: normalized.message,
          round: store.get(managed.leafId)?.rounds,
        };
      },
    }),

    read_agent_output: tool({
      description:
        "Read this session's Claude Code status and terminal tail. Call first for /claude-code requests to choose spawn versus follow-up and verify reported work.",
      inputSchema: z.object({
        lines: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe(
            "Trailing lines of the agent terminal to return. Default 120.",
          ),
      }),
      execute: async ({ lines }) => {
        const sessionId = ctx.getSessionId();
        const managed = sessionId
          ? useManagedAgentsStore.getState().getBySessionId(sessionId)
          : undefined;
        if (!managed) return { active: false };
        const raw = ctx.readAgentOutput(managed.leafId);
        return {
          active: true,
          phase: managed.phase,
          rounds: managed.rounds,
          max_rounds: managed.maxRounds,
          pending_task:
            managed.phase === "attention" && managed.rounds === 0
              ? managed.task
              : undefined,
          message:
            managed.phase === "attention"
              ? "Agent not ready. Complete startup, trust, or authentication in its tab. Original task remains pending."
              : undefined,
          output: raw ? tailLines(raw, lines ?? 120) : "",
        };
      },
    }),
  } as const;
}

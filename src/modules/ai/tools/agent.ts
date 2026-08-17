import {
  sanitizeAgentMessage,
  submitAgentMessage,
} from "@/modules/agents/lib/agentAutomation";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { writeToSession } from "@/modules/terminal";
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
        "Spawn a Claude Code agent in a new terminal tab and give it the prompt. Use this when the user (via /claude-code) wants work delegated and no agent is active yet in this session. Craft a complete, self-contained prompt first; the user approves it before the agent starts. Do not call this if an agent is already active — use send_to_agent instead.",
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
            error:
              "a Claude Code agent is already active in this session; use send_to_agent to give it more work",
          };
        }
        const spawned = ctx.spawnAgent(prompt);
        if (!spawned) return { error: "could not spawn the agent" };
        return {
          ok: true,
          tab_id: spawned.tabId,
          message: "Claude Code agent spawned. It will start working shortly.",
        };
      },
    }),

    send_to_agent: tool({
      description:
        "Send a follow-up instruction to the active Claude Code agent in this session. Use after reviewing its output to request fixes or the next unit of work. The instruction is typed into the agent's prompt and submitted once the user approves. Read its latest output first so the follow-up is informed.",
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
            error:
              "no Claude Code agent is active in this session; spawn one with spawn_coding_agent",
          };
        }
        const normalized = sanitizeAgentMessage(instruction);
        if (!normalized.ok) return { error: normalized.error };
        if (
          !(await submitAgentMessage(
            writeToSession,
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
        "Inspect the Claude Code agent in this session: whether one is active, its status, and the tail of its terminal output. Call this first when handling a /claude-code request so you know whether to spawn a new agent or follow up with the existing one, and to see what it has done and reported.",
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
              ? "Claude Code has not reached a ready prompt. Open its tab and complete any startup, trust, or authentication prompt. The original task remains pending."
              : undefined,
          output: raw ? tailLines(raw, lines ?? 120) : "",
        };
      },
    }),
  } as const;
}

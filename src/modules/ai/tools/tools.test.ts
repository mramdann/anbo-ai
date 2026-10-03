import { isStepCount, type ModelMessage, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => path),
  readFile: vi.fn(async () => ({
    kind: "text" as const,
    content: "old",
    size: 3,
    mtime: 1,
    version: "disk-version",
  })),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../lib/native", () => ({
  EXPECTED_MISSING_VERSION: "missing",
  native: nativeMock,
}));

import { buildTools } from "./tools";
import { makeToolContext } from "./tools.fixtures";

const FILE = "/workspace/notes.txt";
const WRITE = { path: FILE, content: "new" };

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** What a model streams, read off the mock's own signature. */
type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer P>
    ? P
    : never;

/** A model that answers every call with `parts`, then finishes. */
function model(parts: StreamPart[], unified: "stop" | "tool-calls") {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const part of parts) controller.enqueue(part);
          controller.enqueue({
            type: "finish",
            finishReason: { unified, raw: undefined },
            usage,
          });
          controller.close();
        },
      }),
    }),
  });
}

function calling(toolName: string, input: Record<string, unknown>) {
  return model(
    [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName,
        input: JSON.stringify(input),
      },
    ],
    "tool-calls",
  );
}

async function run(
  llm: MockLanguageModelV4,
  prompt: { prompt: string } | { messages: ModelMessage[] },
) {
  const { tools, approval } = buildTools(makeToolContext());
  const result = streamText({
    model: llm,
    ...prompt,
    tools,
    toolApproval: approval,
    stopWhen: isStepCount(1),
    onError: () => {},
  });
  const types: string[] = [];
  for await (const part of result.stream) types.push(part.type);
  return types;
}

describe("tool approval through the SDK", () => {
  beforeEach(() => {
    nativeMock.writeFile.mockClear();
    nativeMock.readFile.mockClear();
  });

  it("asks before write_file runs and writes nothing", async () => {
    const llm = calling("write_file", WRITE);
    const types = await run(llm, { prompt: "write the notes" });

    expect(types).toContain("tool-approval-request");
    expect(types).not.toContain("tool-result");
    expect(nativeMock.writeFile).not.toHaveBeenCalled();
    expect(llm.doStreamCalls).toHaveLength(1);
  });

  it("runs read_file without asking", async () => {
    const types = await run(calling("read_file", { path: FILE }), {
      prompt: "read the notes",
    });

    expect(types).not.toContain("tool-approval-request");
    expect(types).toContain("tool-result");
    expect(nativeMock.readFile).toHaveBeenCalled();
  });

  it("writes once the user approves", async () => {
    const types = await run(
      model(
        [
          { type: "text-start", id: "t" },
          { type: "text-end", id: "t" },
        ],
        "stop",
      ),
      {
        messages: [
          { role: "user", content: "write the notes" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: WRITE,
              },
              {
                type: "tool-approval-request",
                approvalId: "approval-1",
                toolCallId: "call-1",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "approval-1",
                approved: true,
              },
            ],
          },
        ],
      },
    );

    expect(types).toContain("tool-result");
    expect(nativeMock.writeFile).toHaveBeenCalledWith(
      FILE,
      "new",
      { kind: "local" },
      "disk-version",
    );
  });

  it("names only tools that exist", () => {
    const { tools, approval } = buildTools(makeToolContext());
    expect(Object.keys(approval).sort()).toEqual([
      "bash_background",
      "bash_run",
      "browser_close_tab",
      "create_directory",
      "edit",
      "multi_edit",
      "send_to_agent",
      "spawn_coding_agent",
      "terminal_close",
      "terminal_execute",
      "terminal_insert",
      "terminal_interrupt",
      "terminal_open",
      "write_file",
    ]);
    for (const name of Object.keys(approval))
      expect(tools).toHaveProperty(name);
  });
});

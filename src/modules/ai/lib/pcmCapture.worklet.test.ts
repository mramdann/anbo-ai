import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./pcmCapture.worklet.js", import.meta.url),
  "utf8",
);

/**
 * Loads the worklet the way an AudioWorkletGlobalScope would, with a port
 * whose postMessage transfers the buffer as the browser does: the array
 * posted is left with a length of 0. `run` drives the processor inside the
 * sandbox with a time limit, so a loop that stops advancing fails the test
 * instead of hanging the run.
 */
function load(sampleRate: number) {
  const posted: number[] = [];
  const context = vm.createContext({
    registerProcessor(name: string, processor: unknown) {
      context.registered = { name, processor };
    },
    sampleRate,
    structuredClone,
    record: (length: number) => posted.push(length),
  });
  vm.runInContext(
    `class AudioWorkletProcessor {
      port = {
        postMessage(block, transfer) {
          record(block.length);
          structuredClone(block, { transfer });
        },
      };
    }`,
    context,
  );
  vm.runInContext(source, context);
  vm.runInContext(
    "const processor = new registered.processor(); var results = [];",
    context,
  );
  const run = (script: string) =>
    vm.runInContext(script, context, { timeout: 2_000 });
  return { name: context.registered.name as string, posted, run };
}

describe("the capture worklet", () => {
  it("posts one 100 ms block each time one fills, after a transfer too", () => {
    const { name, posted, run } = load(48_000);
    expect(name).toBe("anbo-pcm-capture");
    // 100 render quanta are 12,800 samples: two full blocks and a part.
    run(`
      const quantum = [[new Float32Array(128).fill(0.1)]];
      for (let index = 0; index < 100; index += 1) {
        results.push(processor.process(quantum));
      }
    `);
    expect(run("results.every((result) => result === true)")).toBe(true);
    expect(posted).toEqual([4_800, 4_800]);
  });

  it("waits quietly while the input has no channel", () => {
    const { posted, run } = load(44_100);
    expect(run("processor.process([[]]) && processor.process([])")).toBe(true);
    expect(posted).toEqual([]);
  });
});

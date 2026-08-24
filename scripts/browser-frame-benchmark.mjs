import http from "node:http";

const MCP_URL = "http://127.0.0.1:7331/mcp";
const FRAME_COUNTS = [1, 10, 32];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

async function callTool(name, args) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}-${Math.random()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${name}: ${payload.error.message}`);
  }
  const text = payload.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text result`);
  const result = JSON.parse(text);
  if (typeof result.durationMs !== "number") {
    throw new Error(`${name} did not return durationMs`);
  }
  return result;
}

function benchmarkPage(frameCount) {
  const children = Array.from(
    { length: Math.max(0, frameCount - 1) },
    (_, index) => `<iframe src="/frame?index=${index + 1}&total=${frameCount}"></iframe>`,
  ).join("");
  const target =
    frameCount === 1
      ? `<button data-anbo-bench-target>frame-1 target</button>`
      : "";
  return `<!doctype html><html><body><h1>Frame benchmark ${frameCount}</h1>${target}${children}</body></html>`;
}

function framePage(index, total) {
  const target = index === total - 1;
  return `<!doctype html><html><body><p>frame-${index}</p>${
    target
      ? `<button data-anbo-bench-target>frame-${total} target</button>`
      : ""
  }</body></html>`;
}

async function main() {
  const workspace = argument("workspace");
  const repeats = Number.parseInt(argument("repeats", "10"), 10);
  if (!workspace) {
    throw new Error(
      "Pass an open Anbo workspace, for example: pnpm benchmark:browser-frames -- --workspace C:/project",
    );
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) {
    throw new Error("--repeats must be an integer from 1 to 100");
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/frame") {
      const index = Number(url.searchParams.get("index"));
      const total = Number(url.searchParams.get("total"));
      response.end(framePage(index, total));
      return;
    }
    const frameCount = Number(url.searchParams.get("frames") ?? "1");
    response.end(benchmarkPage(frameCount));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server failed");

  const rows = [];
  const openedTabs = [];
  try {
    for (const frameCount of FRAME_COUNTS) {
      const opened = await callTool("browser_open", {
        workspace,
        url: `http://127.0.0.1:${address.port}/?frames=${frameCount}`,
      });
      openedTabs.push(opened.tabId);
      await callTool("browser_wait", {
        tabId: opened.tabId,
        condition: "load",
        loadState: "complete",
        timeout: 10_000,
      });

      const measurements = { find: [], snapshot: [], wait: [] };
      for (let run = 0; run < repeats + 2; run += 1) {
        const find = await callTool("browser_find", {
          tabId: opened.tabId,
          by: "css",
          value: "[data-anbo-bench-target]",
          limit: 1,
          timeout: 5_000,
        });
        const snapshot = await callTool("browser_snapshot", {
          tabId: opened.tabId,
          maxChars: 2_000,
        });
        const wait = await callTool("browser_wait", {
          tabId: opened.tabId,
          condition: "text",
          text: `frame-${frameCount} target`,
          timeout: 5_000,
        });
        if (run >= 2) {
          measurements.find.push(find.durationMs);
          measurements.snapshot.push(snapshot.durationMs);
          measurements.wait.push(wait.durationMs);
        }
      }
      for (const [operation, values] of Object.entries(measurements)) {
        rows.push({
          frames: frameCount,
          operation,
          samples: values.length,
          p50Ms: percentile(values, 0.5),
          p95Ms: percentile(values, 0.95),
        });
      }
      await callTool("browser_close", { tabId: opened.tabId, workspace });
      openedTabs.pop();
    }
  } finally {
    for (const tabId of openedTabs) {
      try {
        await callTool("browser_close", { tabId, workspace });
      } catch {
        // Best-effort cleanup must not hide the benchmark failure.
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
  console.table(rows);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

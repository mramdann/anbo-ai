import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { assertNoStaticChunkCycles } from "./production-chunk-graph.mjs";

const distRoot = resolve("dist");
const indexPath = join(distRoot, "index.html");

if (!existsSync(indexPath)) {
  throw new Error("dist/index.html is missing; run the production build first");
}

assertNoStaticChunkCycles(join(distRoot, "assets"));

const browserCandidates = [
  process.env.CHROME_PATH,
  process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : null,
  process.platform === "win32"
    ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    : null,
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : null,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const browser = browserCandidates.find((candidate) => existsSync(candidate));
if (!browser) {
  throw new Error(
    "Chrome/Chromium was not found; set CHROME_PATH for the production smoke test",
  );
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

const server = createServer((request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(`${distRoot}${sep}`) || !statSync(filePath).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
    });
    response.end(readFileSync(filePath));
  } catch {
    response.writeHead(404).end("not found");
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const address = server.address();
if (!address || typeof address === "string") {
  server.close();
  throw new Error("production smoke server did not expose a TCP address");
}

const url = `http://127.0.0.1:${address.port}/`;

async function dumpPage(pageUrl, label) {
  const profile = mkdtempSync(join(tmpdir(), "anbo-production-smoke-"));
  let stdout = "";
  let stderr = "";

  try {
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-background-networking",
        "--disable-extensions",
        "--disable-gpu",
        "--no-first-run",
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000",
        "--enable-logging=stderr",
        "--v=0",
        "--dump-dom",
        pageUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill();
        rejectExit(new Error(`${label} headless browser timed out`));
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectExit(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });

    if (exitCode !== 0) {
      throw new Error(
        `${label} headless browser exited with ${exitCode}\n${stderr}`,
      );
    }
    if (!stdout.includes('data-anbo-bundle-ready="true"')) {
      throw new Error(
        `${label} production entry bundle did not finish evaluating\n${stderr.slice(-4000)}`,
      );
    }
    if (stdout.includes('id="anbo-startup"')) {
      throw new Error(
        `${label} startup surface remained after bundle evaluation\n${stderr.slice(-4000)}`,
      );
    }
    if (stderr.includes("Class extends value undefined")) {
      throw new Error(
        `${label} production bundle contains a chunk cycle\n${stderr.slice(-4000)}`,
      );
    }
    return { stdout, stderr };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  await dumpPage(url, "main window");
  const editor = await dumpPage(
    `${url}?anbo-production-editor-smoke=1`,
    "editor",
  );
  if (!editor.stdout.includes('data-anbo-editor-smoke="pass"')) {
    const detail = editor.stdout.match(
      /data-anbo-editor-smoke-error="([^"]*)"/,
    )?.[1];
    throw new Error(
      `production editor layout smoke failed${detail ? `: ${detail}` : ""}\n${editor.stderr.slice(-4000)}`,
    );
  }

  console.log("Production bundle and editor layout smoke tests passed");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

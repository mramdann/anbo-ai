import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
    if (pathname === "/__anbo-icon-smoke") {
      const icons = readdirSync(join(distRoot, "material-icons"));
      if (!icons.length || icons.some(name => !/^[a-z0-9-]+\.svg$/.test(name))) throw new Error("invalid icon assets");
      response.writeHead(200, {"content-type":"text/html"});
      response.end(`<!doctype html><title>Local icon decoding</title><script>
        Promise.all(${JSON.stringify(icons)}.map(name => new Promise((resolve, reject) => {
          const image = new Image(16,16);
          image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(name);
          image.onerror = () => reject(name);
          image.src = '/material-icons/' + name;
          document.documentElement.append(image);
        }))).then(() => { document.documentElement.dataset.anboBundleReady = 'true'; document.documentElement.dataset.anboIcons = '${icons.length}'; });
      </script>`);
      return;
    }
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

const BROWSER_TIMEOUT_MS = 30_000;
// A launch slower than this prints Chrome's own log, so a CI run shows what
// the browser waited on.
const SLOW_LAUNCH_MS = 10_000;

// Chrome's log lines start with [pid:tid:MMDD/HHMMSS.fraction:...] in local
// time (milliseconds on Windows, microseconds on Linux). The widest gap
// between two of them shows where a slow launch waited.
function chromeLogReport(log, started) {
  const clock = (date) =>
    [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join("");
  let previous = null;
  let widest = null;
  for (const line of log.split("\n")) {
    const stamp = /^\[\d+:\d+:\d{4}\/(\d{2})(\d{2})(\d{2})\.(\d+):/.exec(line);
    if (!stamp) continue;
    const at =
      Number(stamp[1]) * 3600 +
      Number(stamp[2]) * 60 +
      Number(stamp[3]) +
      Number(`0.${stamp[4]}`);
    if (previous && (!widest || at - previous.at > widest.seconds)) {
      widest = { seconds: at - previous.at, before: previous.line, after: line };
    }
    previous = { at, line };
  }
  return [
    `Chrome was launched at ${clock(new Date(started))}. Its first output:`,
    log.slice(0, 1500),
    widest
      ? `Its log was quiet longest for ${widest.seconds.toFixed(1)} s, between:\n${widest.before.slice(0, 300)}\n${widest.after.slice(0, 300)}`
      : "Its log has no timestamped lines.",
    "Its last output:",
    log.slice(-1500),
  ].join("\n");
}

async function dumpPage(pageUrl, label) {
  // A headless launch on a CI runner now and then stalls past the timeout;
  // one fresh try tells that apart from a page that never finishes.
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const { code, timedOut, stdout, stderr } = await runBrowser(pageUrl, label);
    const elapsed = Date.now() - started;
    if (timedOut) {
      const message = `${label} headless browser timed out after ${BROWSER_TIMEOUT_MS / 1000} s`;
      if (attempt > 1) {
        throw new Error(`${message} twice\n${chromeLogReport(stderr, started)}`);
      }
      console.warn(
        `${message}; trying once more.\n${chromeLogReport(stderr, started)}`,
      );
      continue;
    }
    console.log(
      `${label}: ${(elapsed / 1000).toFixed(1)} s${attempt > 1 ? " (second try)" : ""}`,
    );
    if (elapsed > SLOW_LAUNCH_MS) {
      console.warn(`${label} was slow.\n${chromeLogReport(stderr, started)}`);
    }

    if (code !== 0) {
      throw new Error(`${label} headless browser exited with ${code}\n${stderr}`);
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
  }
}

// One headless Chrome run of the page in a fresh profile. Resolves with what
// Chrome printed; timedOut is set when it had to be killed.
async function runBrowser(pageUrl, label) {
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
        // As Puppeteer and Playwright do: a fresh profile must not wait on
        // the system keyring, which goes through D-Bus on Linux.
        "--password-store=basic",
        "--use-mock-keychain",
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

    const exit = await new Promise((resolveExit, rejectExit) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A browser that ignores the kill must not hold the smoke forever.
        setTimeout(() => resolveExit({ code: null, timedOut }), 5_000).unref();
      }, BROWSER_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectExit(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveExit({ code, timedOut });
      });
    });
    return { ...exit, stdout, stderr };
  } finally {
    // Chrome's helper processes can still write into the profile for a moment
    // after the browser exits (ENOTEMPTY on the Linux runner), and a failed
    // cleanup must not replace the smoke's own result.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`${label}: could not remove ${profile}: ${error.message}`);
    }
  }
}

try {
  await dumpPage(url, "main window");
  const editor = await dumpPage(
    `${url}?anbo-production-editor-smoke=1`,
    "editor",
  );
  // How many 100 ms looks the editor needed, so a CI log shows how close the
  // page came to its deadline.
  const looks = editor.stdout.match(/data-anbo-editor-smoke-looks="(\d+)"/)?.[1];
  const firstLook = editor.stdout.match(/data-anbo-editor-smoke-first-look="([^"]*)"/)?.[1];
  if (firstLook) console.log(`editor smoke, first look: ${firstLook}`);
  if (!editor.stdout.includes('data-anbo-editor-smoke="pass"')) {
    const detail = editor.stdout.match(
      /data-anbo-editor-smoke-error="([^"]*)"/,
    )?.[1];
    throw new Error(
      `production editor layout smoke failed${detail ? `: ${detail}` : ""}${looks ? ` (after ${looks} looks)` : ""}\n${editor.stderr.slice(-4000)}`,
    );
  }

  const icons = await dumpPage(`${url}__anbo-icon-smoke`, "local icon assets");
  if (!icons.stdout.includes('data-anbo-icons="')) throw new Error("local icon decoding failed");
  console.log(
    `Production bundle, editor layout (ready after ${looks ?? "?"} looks), and local icon decoding smoke tests passed`,
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

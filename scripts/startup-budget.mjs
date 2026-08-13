import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const KIB = 1024;

export const STARTUP_BUDGETS = [
  {
    name: "main window",
    html: "index.html",
    gzipLimitBytes: 670 * KIB,
  },
  {
    name: "settings window",
    html: "settings.html",
    gzipLimitBytes: 305 * KIB,
  },
];

const LAZY_AI_CHUNK_PREFIXES = [
  "assets/ai-anthropic-",
  "assets/ai-cerebras-",
  "assets/ai-google-",
  "assets/ai-groq-",
  "assets/ai-openai-",
  "assets/ai-openai-compat-",
  "assets/ai-sdk-shared-",
  "assets/ai-xai-",
];

function parseAttributes(tag) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes.set(
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

function relTokens(attributes) {
  return new Set(
    (attributes.get("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

export function collectStartupAssetReferences(html) {
  const references = [];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const withoutScriptBodies = withoutComments.replace(
    /(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi,
    "$1</script>",
  );
  const pattern = /<(script|link)\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(withoutScriptBodies))) {
    const tagName = match[1].toLowerCase();
    const attributes = parseAttributes(match[0]);
    if (
      tagName === "script" &&
      (attributes.get("type") ?? "").toLowerCase() === "module" &&
      attributes.has("src")
    ) {
      references.push({ kind: "script", url: attributes.get("src") });
      continue;
    }
    if (tagName !== "link" || !attributes.has("href")) continue;
    const rel = relTokens(attributes);
    if (rel.has("modulepreload")) {
      references.push({ kind: "modulepreload", url: attributes.get("href") });
    } else if (rel.has("stylesheet")) {
      references.push({ kind: "stylesheet", url: attributes.get("href") });
    }
  }
  return references;
}

function resolveLocalAsset(distDir, htmlFile, url) {
  if (!url) throw new Error("startup asset URL is empty");
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) {
    throw new Error(`external startup asset cannot be measured: ${url}`);
  }
  const withoutSuffix = url.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutSuffix).replaceAll("\\", "/");
  } catch {
    throw new Error(`invalid asset URL encoding: ${url}`);
  }
  const assetPath = decoded.startsWith("/")
    ? resolve(distDir, `.${decoded}`)
    : resolve(dirname(htmlFile), decoded);
  const fromDist = relative(distDir, assetPath);
  if (
    fromDist === "" ||
    fromDist === ".." ||
    fromDist.startsWith(`..\\`) ||
    fromDist.startsWith("../") ||
    isAbsolute(fromDist)
  ) {
    throw new Error(`startup asset escapes dist: ${url}`);
  }
  return assetPath;
}

function assetKind(path) {
  if (/\.css$/i.test(path)) return "css";
  if (/\.(?:m?js)$/i.test(path)) return "js";
  return "other";
}

export function measureStartupClosure(distDirectory, htmlName) {
  const distDir = resolve(distDirectory);
  const htmlFile = resolve(distDir, htmlName);
  const htmlRelative = relative(distDir, htmlFile);
  if (
    htmlRelative === ".." ||
    htmlRelative.startsWith(`..\\`) ||
    htmlRelative.startsWith("../") ||
    isAbsolute(htmlRelative) ||
    !existsSync(htmlFile)
  ) {
    throw new Error(`startup HTML not found inside dist: ${htmlName}`);
  }

  const html = readFileSync(htmlFile, "utf8");
  const seen = new Set();
  const assets = [];
  for (const reference of collectStartupAssetReferences(html)) {
    const path = resolveLocalAsset(distDir, htmlFile, reference.url);
    if (seen.has(path)) continue;
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`startup asset not found for ${htmlName}: ${reference.url}`);
    }
    seen.add(path);
    const content = readFileSync(path);
    assets.push({
      path: relative(distDir, path).replaceAll("\\", "/"),
      kind: assetKind(path),
      rawBytes: content.byteLength,
      gzipBytes: gzipSync(content).byteLength,
    });
  }
  if (!assets.some((asset) => asset.kind === "js")) {
    throw new Error(`no local startup module assets found for ${htmlName}`);
  }

  const rawBytes = assets.reduce((total, asset) => total + asset.rawBytes, 0);
  const gzipBytes = assets.reduce(
    (total, asset) => total + asset.gzipBytes,
    0,
  );
  return { html: htmlName, assets, rawBytes, gzipBytes };
}

export function evaluateStartupBudget(report, budget) {
  const forbiddenAssets = report.assets
    .map((asset) => asset.path)
    .filter((path) =>
      LAZY_AI_CHUNK_PREFIXES.some((prefix) => path.startsWith(prefix)),
    );
  return {
    ...budget,
    report,
    exceeded:
      report.gzipBytes > budget.gzipLimitBytes || forbiddenAssets.length > 0,
    remainingBytes: budget.gzipLimitBytes - report.gzipBytes,
    forbiddenAssets,
  };
}

function kib(bytes) {
  return `${(bytes / KIB).toFixed(2)} KiB`;
}

function printResult(result) {
  const counts = result.report.assets.reduce(
    (value, asset) => {
      value[asset.kind] = (value[asset.kind] ?? 0) + 1;
      return value;
    },
    {},
  );
  const status = result.exceeded ? "FAIL" : "PASS";
  const assetSummary = Object.entries(counts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  console.log(
    `${status} ${result.name}: ${kib(result.report.gzipBytes)} gzip / ${kib(result.gzipLimitBytes)} (${assetSummary})`,
  );
  console.log(`     raw: ${kib(result.report.rawBytes)}`);
  const largest = [...result.report.assets]
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, 5);
  for (const asset of largest) {
    console.log(`     ${kib(asset.gzipBytes).padStart(11)}  ${asset.path}`);
  }
  for (const path of result.forbiddenAssets) {
    console.log(`     forbidden eager AI chunk: ${path}`);
  }
}

export function runStartupBudgetCheck(
  distDir = resolve(projectRoot, "dist"),
  budgets = STARTUP_BUDGETS,
) {
  const results = budgets.map((budget) =>
    evaluateStartupBudget(
      measureStartupClosure(distDir, budget.html),
      budget,
    ),
  );
  for (const result of results) printResult(result);
  return results;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const results = runStartupBudgetCheck();
    if (results.some((result) => result.exceeded)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

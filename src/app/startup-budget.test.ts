import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStartupAssetReferences,
  evaluateStartupBudget,
  measureStartupClosure,
} from "../../scripts/startup-budget.mjs";

const temporaryDirectories: string[] = [];

function temporaryDist(): string {
  const path = mkdtempSync(join(tmpdir(), "anbo-startup-budget-"));
  temporaryDirectories.push(path);
  mkdirSync(join(path, "assets"));
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("startup closure budget", () => {
  it("collects module entries, preloads, and stylesheets only", () => {
    const references = collectStartupAssetReferences(`
      <!-- <link rel="modulepreload" href="/ignored.js"> -->
      <script src="/classic.js"></script>
      <script TYPE="module" src="/entry.js"></script>
      <link crossorigin rel="preload modulepreload" href="/shared.js">
      <link href="/app.css" rel="stylesheet">
      <link rel="icon" href="/icon.svg">
      <script>const template = '<link rel="modulepreload" href="/fake.js">';</script>
    `);

    expect(references).toEqual([
      { kind: "script", url: "/entry.js" },
      { kind: "modulepreload", url: "/shared.js" },
      { kind: "stylesheet", url: "/app.css" },
    ]);
  });

  it("measures each local startup asset once using per-file gzip", () => {
    const dist = temporaryDist();
    const entry = "export const answer = 42;";
    const shared = "export const shared = 'shared';";
    const css = ".root { color: red; }";
    writeFileSync(join(dist, "assets", "entry.js"), entry);
    writeFileSync(join(dist, "assets", "shared.js"), shared);
    writeFileSync(join(dist, "assets", "app.css"), css);
    writeFileSync(
      join(dist, "index.html"),
      `<script type="module" src="/assets/entry.js"></script>
       <link rel="modulepreload" href="/assets/shared.js">
       <link rel="modulepreload" href="/assets/shared.js?duplicate=true">
       <link rel="stylesheet" href="/assets/app.css">`,
    );

    const report = measureStartupClosure(dist, "index.html");

    expect(report.assets.map((asset) => asset.path)).toEqual([
      "assets/entry.js",
      "assets/shared.js",
      "assets/app.css",
    ]);
    expect(report.rawBytes).toBe(
      Buffer.byteLength(entry) +
        Buffer.byteLength(shared) +
        Buffer.byteLength(css),
    );
    expect(report.gzipBytes).toBe(
      gzipSync(entry).byteLength +
        gzipSync(shared).byteLength +
        gzipSync(css).byteLength,
    );
  });

  it("fails closed for missing assets and paths outside dist", () => {
    const dist = temporaryDist();
    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="/assets/missing.js"></script>',
    );
    expect(() => measureStartupClosure(dist, "index.html")).toThrow(
      "startup asset not found",
    );

    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="../outside.js"></script>',
    );
    expect(() => measureStartupClosure(dist, "index.html")).toThrow(
      "startup asset escapes dist",
    );

    writeFileSync(
      join(dist, "index.html"),
      '<script type="module" src="https://cdn.example/entry.js"></script>',
    );
    expect(() => measureStartupClosure(dist, "index.html")).toThrow(
      "external startup asset cannot be measured",
    );

    writeFileSync(join(dist, "index.html"), "<main>No module entry</main>");
    expect(() => measureStartupClosure(dist, "index.html")).toThrow(
      "no local startup module assets found",
    );
  });

  it("reports whether the complete closure exceeds its budget", () => {
    const report = {
      html: "index.html",
      assets: [],
      rawBytes: 12,
      gzipBytes: 8,
    };
    expect(
      evaluateStartupBudget(report, {
        name: "main",
        html: "index.html",
        gzipLimitBytes: 7,
      }),
    ).toMatchObject({ exceeded: true, remainingBytes: -1 });
    expect(
      evaluateStartupBudget(report, {
        name: "main",
        html: "index.html",
        gzipLimitBytes: 8,
      }),
    ).toMatchObject({ exceeded: false, remainingBytes: 0 });
  });

  it("rejects AI SDK chunks even when the byte budget still passes", () => {
    const report = {
      html: "index.html",
      assets: [
        {
          path: "assets/ai-anthropic-hash.js",
          kind: "js" as const,
          rawBytes: 4,
          gzipBytes: 4,
        },
      ],
      rawBytes: 4,
      gzipBytes: 4,
    };

    expect(
      evaluateStartupBudget(report, {
        name: "main",
        html: "index.html",
        gzipLimitBytes: 100,
      }),
    ).toMatchObject({
      exceeded: true,
      forbiddenAssets: ["assets/ai-anthropic-hash.js"],
    });
  });
});

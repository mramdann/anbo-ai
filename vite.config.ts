import babel from "@rolldown/plugin-babel";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type PluginOption, type UserConfig } from "vite";
import Inspect from "vite-plugin-inspect";
import { configDefaults } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

// The startup screen is plain HTML that renders before any module evaluates,
// so the version has to be baked in rather than read at runtime. This is the
// same field release-please keeps in step with the installer.
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
) as { version: string; repository?: { url?: string } };
const appVersion: string = manifest.version;
// The owner segment of the repository URL, which is the GitHub username. Read
// from the manifest rather than from `git remote`, so a build from a tarball
// with no .git still names the author.
const appAuthor: string =
  manifest.repository?.url?.match(/github\.com\/([^/]+)\//)?.[1] ?? "";

// Bundle/treemap analysis is opt-in: `ANALYZE=true pnpm build` emits stats.html.
const analyze = process.env.ANALYZE === "true";

// Module-graph inspector is opt-in via `pnpm dev:inspect`; keeps plain
// `pnpm dev` from paying its transform-tracking overhead on every run.
const inspectGraph = process.env.INSPECT === "true";

// https://vite.dev/config/
export default defineConfig(async ({ mode }): Promise<UserConfig> => ({
  plugins: [
    babel({
      presets: [reactCompilerPreset({ target: "19" })],
    }),
    react(),
    tailwindcss(),
    {
      name: "anbo-startup-version",
      transformIndexHtml(html: string) {
        // A dev build carries the last released number, so without this the
        // splash would claim to be a release it is not.
        const label =
          mode === "development" ? `${appVersion} dev` : appVersion;
        return html
          .replaceAll("%ANBO_VERSION%", label)
          .replaceAll("%ANBO_AUTHOR%", appAuthor);
      },
    },
    // Module-graph inspector at /__inspect (who-imports-what, per-plugin
    // transforms). Opt-in via `pnpm dev:inspect`, never in a production build.
    ...(mode === "development" && inspectGraph
      ? [Inspect() as PluginOption]
      : []),
    ...(analyze
      ? [
          (await import("rollup-plugin-visualizer")).visualizer({
            filename: "stats.html",
            template: "treemap",
            gzipSize: true,
            brotliSize: true,
            open: true,
          }) as PluginOption,
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shim keeps the ~117 kB CJS protocol package out of the bundle.
      "vscode-languageserver-protocol": path.resolve(
        __dirname,
        "./src/modules/lsp/lib/protocolShim.ts",
      ),
    },
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "es2022",
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        settings: path.resolve(__dirname, "settings.html"),
        voice: path.resolve(__dirname, "voice.html"),
      },
      // Oxc drops `debugger` by default. These calls return undefined, so
      // marking them pure lets DCE strip them from production builds.
      treeshake: {
        manualPureFunctions: [
          "console.debug",
          "console.info",
          "console.trace",
        ],
      },
    },
  },
  clearScreen: false,
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/lib/boundedMap.ts",
        "src/modules/ai/lib/compact.ts",
        "src/modules/ai/lib/security.ts",
        "src/modules/editor/lib/aiDiffPolicy.ts",
        "src/modules/markdown/policy.ts",
      ],
      thresholds: {
        perFile: true,
        statements: 65,
        branches: 50,
        functions: 85,
        lines: 70,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

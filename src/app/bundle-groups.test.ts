import { describe, expect, it } from "vitest";
import {
  bundleChunkName,
  packageNameFromModuleId,
} from "../../scripts/bundle-groups.mjs";

describe("production bundle groups", () => {
  it("finds the actual package after the final pnpm node_modules segment", () => {
    expect(
      packageNameFromModuleId(
        "C:/repo/node_modules/.pnpm/@ai-sdk+react@3/node_modules/react/compiler-runtime.js",
      ),
    ).toBe("react");
    expect(
      packageNameFromModuleId(
        "C:\\repo\\node_modules\\.pnpm\\@ai-sdk+anthropic@3\\node_modules\\@ai-sdk\\anthropic\\dist\\index.mjs",
      ),
    ).toBe("@ai-sdk/anthropic");
  });

  it("does not assign transitive React to an AI provider chunk", () => {
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/@ai-sdk+react@3/node_modules/react/compiler-runtime.js",
      ),
    ).toBe("react");
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/@ai-sdk+anthropic@3/node_modules/@ai-sdk/anthropic/dist/index.mjs",
      ),
    ).toBe("ai-anthropic");
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/@ai-sdk+anthropic@3/node_modules/@ai-sdk/provider-utils/dist/index.mjs",
      ),
    ).toBe("ai-sdk-shared");
  });

  it("keeps named lazy language chunks and core groups stable", () => {
    expect(
      bundleChunkName(
        "/repo/node_modules/@codemirror/legacy-modes/mode/powershell.js",
      ),
    ).toBe("cm-legacy-powershell");
    expect(
      bundleChunkName("/repo/node_modules/@codemirror/lang-rust/dist/index.js"),
    ).toBe("cm-lang-rust");
    expect(
      bundleChunkName("/repo/node_modules/@xterm/xterm/lib/xterm.js"),
    ).toBe("xterm");
    expect(bundleChunkName("/repo/src/App.tsx")).toBeNull();
  });
});

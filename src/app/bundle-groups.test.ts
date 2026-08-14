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
    ).toBeNull();
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/@ai-sdk+anthropic@3/node_modules/@ai-sdk/provider-utils/dist/index.mjs",
      ),
    ).toBeNull();
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/ai@6/node_modules/ai/dist/index.mjs",
      ),
    ).toBeNull();
    expect(
      bundleChunkName(
        "C:/repo/node_modules/.pnpm/throttleit@2/node_modules/throttleit/index.js",
      ),
    ).toBeNull();
  });

  it("keeps one editor runtime while language implementations stay lazy", () => {
    expect(
      bundleChunkName(
        "/repo/node_modules/@codemirror/legacy-modes/mode/powershell.js",
      ),
    ).toBeNull();
    expect(
      bundleChunkName("/repo/node_modules/@codemirror/lang-rust/dist/index.js"),
    ).toBeNull();
    expect(
      bundleChunkName("/repo/node_modules/@codemirror/state/dist/index.js"),
    ).toBe("editor-runtime");
    expect(
      bundleChunkName("/repo/node_modules/@uiw/react-codemirror/esm/index.js"),
    ).toBe("editor-runtime");
    expect(
      bundleChunkName("/repo/node_modules/@lezer/highlight/dist/index.js"),
    ).toBe("editor-runtime");
    expect(
      bundleChunkName("/repo/src/modules/editor/lib/useEditorThemeExt.ts"),
    ).toBe("editor-runtime");
    expect(bundleChunkName("/repo/src/modules/editor/EditorStack.tsx")).toBe(
      "editor-runtime",
    );
    expect(bundleChunkName("/repo/src/modules/lsp/useLspExtension.ts")).toBe(
      "editor-runtime",
    );
    expect(
      bundleChunkName("/repo/node_modules/@xterm/xterm/lib/xterm.js"),
    ).toBe("xterm");
    expect(
      bundleChunkName("/repo/node_modules/dockview/dist/esm/dockview.js"),
    ).toBeNull();
    expect(
      bundleChunkName(
        "/repo/node_modules/dockview-react/dist/esm/dockview-react.js",
      ),
    ).toBeNull();
    expect(bundleChunkName("/repo/src/App.tsx")).toBeNull();
  });
});

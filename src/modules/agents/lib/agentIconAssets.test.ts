import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_BRAND_ASSETS,
  resolveAgentBrandAsset,
  resolveAgentBrandId,
} from "@/modules/agents/lib/agentIconAssets";
import { AGENT_LAUNCHERS } from "@/modules/agents/lib/launcher";
import { describe, expect, it } from "vitest";

describe("terminal agent icon assets", () => {
  it("keeps every built-in launcher on the central brand registry", () => {
    for (const launcher of AGENT_LAUNCHERS) {
      expect(resolveAgentBrandId(launcher.icon)).toBe(launcher.id);
      expect(resolveAgentBrandAsset(launcher.icon)).not.toBeNull();
    }
  });

  it("stores every registered CLI asset under public/agent-icons", () => {
    for (const asset of Object.values(AGENT_BRAND_ASSETS)) {
      for (const path of [asset.light, "dark" in asset ? asset.dark : null]) {
        if (!path) continue;
        expect(path).toMatch(/^\/agent-icons\//);
        expect(existsSync(join(process.cwd(), "public", path.slice(1)))).toBe(
          true,
        );
      }
    }
  });
});

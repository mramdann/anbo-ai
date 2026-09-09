import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const embed = readFileSync(
  new URL("../../../src-tauri/src/modules/browser/embed.rs", import.meta.url),
  "utf8",
);
const section = (start: string, end: string) =>
  embed.slice(embed.indexOf(start), embed.indexOf(end, embed.indexOf(start)));

describe("native browser navigation ownership", () => {
  it("updates an existing child's bounds without replaying a renderer URL", () => {
    const update = section(
      "pub async fn browser_embed_update(",
      "pub async fn browser_embed_navigate(",
    );
    expect(update).toContain(".set_bounds(");
    expect(update).toContain("spawn_browser_child(");
    expect(update).not.toContain("webview.navigate(");
    expect(update).not.toContain("read_url(");
    expect(update).toContain("Some(target.to_string())");
  });
  it("retains explicit navigation and clears a failed pending target", () => {
    const navigate = section(
      "pub async fn browser_embed_navigate(",
      "pub async fn browser_embed_dispatch(",
    );
    expect(navigate).toContain("webview.navigate(target)");
    expect(navigate).toContain("set_active_pending_url(tab_id, None)");
  });
  it("observes native SPA source changes without page scripts or a polling timer", () => {
    const observer = section(
      "fn register_source_handler(",
      "type SnapshotResult",
    );
    expect(observer).toContain("SourceChangedEventHandler");
    expect(observer).toContain("core.Source(");
    expect(observer).toContain('kind: "source"');
    expect(observer).toContain("navigation_allowed(");
    expect(observer).not.toMatch(
      /execute_script|\.eval\(|setInterval|fetch_add|loading\.store/,
    );
  });
});

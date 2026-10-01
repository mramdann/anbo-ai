import { useShortcutLabel } from "@/modules/shortcuts/lib/useShortcutLabel";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

function BrowserKey({ separator }: { separator?: string }) {
  return <>{useShortcutLabel("tab.newBrowser", separator)}</>;
}

describe("shortcut labels", () => {
  it("names the browser tab's real binding, joined the way the caller asks", () => {
    const binding = SHORTCUTS.find(
      (shortcut) => shortcut.id === "tab.newBrowser",
    )?.defaultBindings[0];
    const tokens = getBindingTokens(binding);
    // Ctrl+P opens the command palette; the + menu once said otherwise.
    expect(tokens[tokens.length - 1]).toBe("O");
    expect(renderToStaticMarkup(<BrowserKey />)).toBe(tokens.join(" "));
    expect(renderToStaticMarkup(<BrowserKey separator="+" />)).toBe(
      tokens.join("+"),
    );
  });
});

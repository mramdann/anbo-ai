type Pressed = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/** The keys a webview takes for "reload this page". */
export function isReloadKey(event: Pressed): boolean {
  if (event.key === "F5") return true;
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "r"
  );
}

function inCodeEditor(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return (
    typeof element?.closest === "function" &&
    element.closest(".cm-editor") !== null
  );
}

/**
 * A reload of Anbo's page closes every terminal, agents at work included, so
 * the page cancels the keys that ask for one. Only the default is cancelled:
 * a terminal program still gets F5, and Anbo's own Ctrl+R still runs. The
 * code editor ignores a cancelled key, so its Ctrl+R is cancelled on the way
 * back up, after it had its turn.
 */
export function blockPageReloadKeys(page: Window = window): void {
  page.addEventListener(
    "keydown",
    (event) => {
      if (!isReloadKey(event)) return;
      if (event.key === "F5" || !inCodeEditor(event.target)) {
        event.preventDefault();
      }
    },
    { capture: true },
  );
  page.addEventListener("keydown", (event) => {
    if (isReloadKey(event)) event.preventDefault();
  });
}

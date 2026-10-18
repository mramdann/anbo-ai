// The opener plugin's link script (tauri-plugin-opener 2.7, init-iife.js),
// kept out of Anbo's browser tabs (app_links.rs).
(() => {
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  if (typeof label !== "string" || label.startsWith("browser-embed-")) return;
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return;
    const link = event.composedPath().find((node) => node instanceof Node && node.nodeName.toUpperCase() === "A");
    if (!link || !link.href || (link.target !== "_blank" && !event.ctrlKey && !event.shiftKey)) return;
    const url = new URL(link.href);
    if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return;
    event.preventDefault();
    window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: url.href });
  });
})();

# Changelog

## [0.12.1](https://github.com/mramdann/anbo-ai/compare/v0.12.0...v0.12.1) (2026-08-11)


### Bug Fixes

* **ci:** auto-sync Cargo.lock in check-version instead of failing ([99879d9](https://github.com/mramdann/anbo-ai/commit/99879d9f897663bf081abe9f6c4b3a3a1a2d6ec5))
* **updater:** persist dismissed version and enable periodic auto-check ([02f372c](https://github.com/mramdann/anbo-ai/commit/02f372ceb99915a3db37bb37524b961c9cfdc5a4))

## [0.12.0](https://github.com/mramdann/anbo-ai/compare/v0.11.0...v0.12.0) (2026-08-11)


### Features

* **browser:** AI driving pulse, tab loading indicator, favicon fallback ([6d4b7fc](https://github.com/mramdann/anbo-ai/commit/6d4b7fc39d6c054c984c8415e03901c1449ab504))
* **browser:** zoom controls and AI mini-window punch-through ([bbd70ed](https://github.com/mramdann/anbo-ai/commit/bbd70ed5d16de81f38d96a7e22161e2cb0fe47f8))


### Bug Fixes

* **browser:** resilient automation, readiness gates, opaque webview bg ([7788dde](https://github.com/mramdann/anbo-ai/commit/7788dde2c6ad4a8e68bc95921c198ec217a15dad))
* **startup:** render window controls on the preparing-workspace screen ([a39a8cc](https://github.com/mramdann/anbo-ai/commit/a39a8cc7ad10e1f544de74a8dc7a3e200a5601ad))

## [0.11.0](https://github.com/mramdann/anbo-ai/compare/v0.10.0...v0.11.0) (2026-08-09)

### Features

* rename the web "preview" surface to a built-in **browser** end-to-end — the tab, panes, native webview, Tauri commands (`browser_embed_*`), AI tools, and UI labels now all say "browser", reflecting that it navigates any HTTP/HTTPS URL with history and is drivable by AI automation
* redesign the **Default model** picker as a collapsible per-provider accordion: each configured provider shows its icon, name, and model count, and expands inline to let you pick a model
* add **search** to the Default model picker — live filtering across providers and models
* allow **custom OpenAI-compatible endpoints** (e.g. 9router) to be selected as the default chat model
* add **model detection** for custom endpoints — a "Detect" button fetches the endpoint's `/models` list so you can pick from the models it actually offers; detected models are cached and surfaced (with counts) in the Default model picker
* rebrand the README to **Anbo** as a fork of Terax, with a clear fork notice and upstream attribution
* polish the **startup loading screen** — drop the redundant mark, keep just the wordmark + status, and make the progress bar theme-aware (light/dark)

### Improvements

* persist detected custom-endpoint model lists on the endpoint so counts and selections survive restarts
* keep the default chat model backed by a custom endpoint across restarts (the default model id is widened to accept custom-endpoint models)
* update ROADMAP, CONTRIBUTING, SECURITY, and the ANBO architecture docs to "browser" terminology and the Anbo fork identity; rewrite the now-outdated "not a browser" disclaimers

### Bug Fixes

* stop the **Settings window** from floating above every other app — always-on-top is now macOS-only; on Windows/Linux it stays above the main app window (via parenting) without covering unrelated apps
* prevent a crash when sending a message while a custom-endpoint model is the active/default model (`sendMessage` no longer runs the built-in-only model resolver on a custom-endpoint id)
* migrate workspace tabs persisted with the legacy `preview` kind so they restore correctly as `browser` tabs

### Refactor

* rename internal identifiers across the stack: `src/modules/preview/` → `src/modules/browser/` (`PreviewPane`→`BrowserPane`, etc.), tab kind `preview`→`browser`, `preview_embed_*` Tauri commands → `browser_embed_*`, the `anbo:preview-nav` event → `anbo:browser-nav`, and the AI tool `open_preview` → `open_browser`

## [0.10.0](https://github.com/mramdann/anbo-ai/compare/v0.9.0...v0.10.0) (2026-08-08)

### Features

* add native Windows browser automation for Side-Panel AI, the bundled `anbo-browser` CLI, and MCP clients
* add accessibility snapshots with stable element refs for browser click and type actions
* allow AI browser navigation to open external HTTP and HTTPS pages or reuse the active browser tab
* add authenticated named-pipe transport, per-tab action serialization, and browser artifact retention
* add a polished startup loading surface before the React workspace initializes

### Improvements

* keep native browser tabs and media live while React menus and dialogs overlap them
* preserve hidden browser bounds so pending navigation can complete before a tab becomes visible
* use a single JPEG freeze frame while dragging native browser tabs to reduce capture overhead
* expand Side-Panel AI instructions for browser, task-tracking, subagent, and coding-agent tools
* use the full workspace surface for native browser tabs
* show the actual clipped-tab count in a compact, centered `+N` overflow control
* improve the inline Ask Anbo selection control sizing and wrapping
* accept `tabs`, `list_tabs`, and `list-tabs` aliases in the browser CLI

### Fixes

* pass the active browser tab ID and snapshot refs correctly to AI click, type, and scroll actions
* validate browser refs before script execution and safely serialize browser action input
* update React-controlled inputs through their native value setter before dispatching input events
* capture real native WebView screenshots instead of writing an empty canvas image
* generate browser transport tokens with the operating system CSPRNG
* report the synchronized application version from the MCP server
* restore release version synchronization for `Cargo.lock`
* keep browser overlay z-order changes isolated to live native browser tabs without parking or repeatedly hiding them

### Testing

* add coverage for browser AI tools, browser overlay visibility, startup markup, native browser behavior, and clipped-tab counting

## [0.9.0](https://github.com/mramdann/anbo-ai/compare/v0.8.9...v0.9.0) (2026-08-05)


### Features

* improve empty workspace launcher ([#12](https://github.com/mramdann/anbo-ai/issues/12)) ([2a8bcb8](https://github.com/mramdann/anbo-ai/commit/2a8bcb827daee43ec8b2fc9abf6f4501fdc3bb5f))

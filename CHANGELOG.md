# Changelog

## [0.14.1](https://github.com/mramdann/anbo-ai/compare/v0.14.0...v0.14.1) (2026-08-13)


### Bug Fixes

* **ai:** enforce final context budgets ([60ad481](https://github.com/mramdann/anbo-ai/commit/60ad481a382cb5924487df33af653a7a63c76178))
* **ai:** freeze run scope and propagate cancellation ([910220c](https://github.com/mramdann/anbo-ai/commit/910220c151172b274a69f05c1d76d6ff1498fda9))
* **ai:** retain latest bounded turn ([fd52116](https://github.com/mramdann/anbo-ai/commit/fd52116519446b6750d0205a5422e7860d7cc0f6))
* **browser:** clear stale URL validation state ([b1d633d](https://github.com/mramdann/anbo-ai/commit/b1d633d96bcf6e7530718146a0b8b389992a01c6))
* **browser:** eliminate tab switching flicker ([39a384b](https://github.com/mramdann/anbo-ai/commit/39a384b048a67e02654e5eceb66f38db3bf38f7a))
* **browser:** harden parallel automation lifecycle ([c7315cc](https://github.com/mramdann/anbo-ai/commit/c7315cc271e91060155b86035860224f6f16979e))
* **browser:** preserve foreground z order under overlays ([f6e522a](https://github.com/mramdann/anbo-ai/commit/f6e522a1aa14fabe7a5500b7968e09907101ef0e))
* **ci:** preserve release OIDC permission ([6ba43ad](https://github.com/mramdann/anbo-ai/commit/6ba43ad504cde60492e945c35de152afc732b208))
* **lifecycle:** terminate managed process trees ([b2f7898](https://github.com/mramdann/anbo-ai/commit/b2f7898b7c9341efaba398afde7b4a2b80d2f23a))
* **markdown:** bound and harden previews ([dc040dd](https://github.com/mramdann/anbo-ai/commit/dc040dd80fed9db71eafdc820d2afa451ff4029c))
* **net:** normalize bracketed IPv6 hosts ([6f81666](https://github.com/mramdann/anbo-ai/commit/6f8166639b66c3a3390b5ae6b53fda0a5979303a))
* **security:** complete P0 boundaries ([33626f7](https://github.com/mramdann/anbo-ai/commit/33626f7e055a4d5ecb17f6f861cf183474069f09))
* **updater:** scope checks to Windows releases ([03b87c9](https://github.com/mramdann/anbo-ai/commit/03b87c93894ccfbb46d80a3bec703547c6815c1b))
* **workspace:** preserve independent space runtimes ([4a852a4](https://github.com/mramdann/anbo-ai/commit/4a852a4934f036b594172ee15b35fd442a34d0aa))


### Performance Improvements

* **ai:** bound active conversation rendering ([25ca69b](https://github.com/mramdann/anbo-ai/commit/25ca69b3baed40cdf50f74fb0d0b3a07107330f8))
* **browser:** make native layout sync event driven ([07fcad8](https://github.com/mramdann/anbo-ai/commit/07fcad865c00fa86cf04602a75c5cd2886ec5079))
* **content:** defer expensive large previews ([f81f98b](https://github.com/mramdann/anbo-ai/commit/f81f98bb0693737cf008f728ccb2fb306f5e7280))
* **startup:** keep provider SDKs lazy ([7d38780](https://github.com/mramdann/anbo-ai/commit/7d38780df664e0efb38db7a214cb89e7e742c092))
* **startup:** measure generated preload closures ([80c36d7](https://github.com/mramdann/anbo-ai/commit/80c36d7643bd251ae12b323af19307996da56505))
* **state:** bound caches and stale async work ([92bd2fa](https://github.com/mramdann/anbo-ai/commit/92bd2fadd1ecd38ae5f588ac3823cc947d40ac42))

## [0.14.0](https://github.com/mramdann/anbo-ai/compare/v0.13.1...v0.14.0) (2026-08-12)


### Features

* **browser:** add workspace-scoped background automation ([87b6b07](https://github.com/mramdann/anbo-ai/commit/87b6b074a575c385b2975358c6bd9e87c41e5665))

## [0.13.1](https://github.com/mramdann/anbo-ai/compare/v0.13.0...v0.13.1) (2026-08-12)


### Bug Fixes

* **browser:** isolate automation target from UI focus and scope per workspace ([52e5cf4](https://github.com/mramdann/anbo-ai/commit/52e5cf47d2f191134e68c9b2691e27df3ae8c4a0))

## [0.13.0](https://github.com/mramdann/anbo-ai/compare/v0.12.2...v0.13.0) (2026-08-12)


### Features

* **browser:** expose MCP over Streamable HTTP ([c872960](https://github.com/mramdann/anbo-ai/commit/c872960aa49584ecee464e921372888fa8622e0f))

## [0.12.2](https://github.com/mramdann/anbo-ai/compare/v0.12.1...v0.12.2) (2026-08-11)


### Bug Fixes

* **settings:** drop experimental label from browser automation ([2eafe42](https://github.com/mramdann/anbo-ai/commit/2eafe429089f623b6224c835b61bccf6be3b659e))
* **ui:** make modal dialogs follow the UI zoom setting ([37c3159](https://github.com/mramdann/anbo-ai/commit/37c3159975fd39c9b1ac7e58874fef375b7ece94))
* **ui:** render updater release notes as markdown ([dcb24f4](https://github.com/mramdann/anbo-ai/commit/dcb24f49129f51c59bfedebca38bf0698141e71b))

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

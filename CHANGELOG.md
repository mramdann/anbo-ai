# Changelog

## [0.17.2](https://github.com/mramdann/anbo-ai/compare/v0.17.1...v0.17.2) (2026-08-20)


### Bug Fixes

* **agents:** wait for Antigravity prompt after login ([8c369cd](https://github.com/mramdann/anbo-ai/commit/8c369cdc5e0f0030364d4cfdff01f11d8d22aa35))

## [0.17.1](https://github.com/mramdann/anbo-ai/compare/v0.17.0...v0.17.1) (2026-08-20)


### Bug Fixes

* **agents:** settle Antigravity input before submit ([02e4be2](https://github.com/mramdann/anbo-ai/commit/02e4be2aa7d1fedd196838923a873c4c683bddc9))

## [0.17.0](https://github.com/mramdann/anbo-ai/compare/v0.16.2...v0.17.0) (2026-08-20)


### Features

* **agents:** replace hook status tracking with screen observation ([602ca1c](https://github.com/mramdann/anbo-ai/commit/602ca1c0c25fb312136f60c743b1d9258152710e))


### Bug Fixes

* **agents:** match lexical Antigravity workspace paths ([53c50a9](https://github.com/mramdann/anbo-ai/commit/53c50a974c768c63a36884d459f674de2f62ab64))
* **agents:** poll terminal screens only inside Tauri ([f5daf4e](https://github.com/mramdann/anbo-ai/commit/f5daf4ec127e17a6ef943147b499fcbcbebb296b))
* **agents:** preserve case in Antigravity session matching ([634fb42](https://github.com/mramdann/anbo-ai/commit/634fb423a130a00424cb75b1daebbcab6bc97872))
* **browser:** keep Windows browser surfaces opaque ([8b81f20](https://github.com/mramdann/anbo-ai/commit/8b81f20a913bc3265b6e8f42b5301476528dbac5))
* **release:** finalize Release Please metadata ([62a82fd](https://github.com/mramdann/anbo-ai/commit/62a82fdabba91e8912b3607061438176a39533b9))
* **release:** normalize Anbo product and artifact casing ([a732268](https://github.com/mramdann/anbo-ai/commit/a732268047ad0595244a10339976169948fd755e))
* **ui:** stabilize restored window and pane presentation ([cf907f2](https://github.com/mramdann/anbo-ai/commit/cf907f25cfdd6ea4c5eafd93f408b2d9a3bcd468))

## [0.16.2](https://github.com/mramdann/anbo-ai/compare/v0.16.1...v0.16.2) (2026-08-18)


### Bug Fixes

* **release:** automate updater publication ([61feac8](https://github.com/mramdann/anbo-ai/commit/61feac85c27df5ce6b5410d73fbe8aba96e53099))

## [0.16.1](https://github.com/mramdann/anbo-ai/compare/v0.16.0...v0.16.1) (2026-08-18)


### Bug Fixes

* **agents:** reject unrendered Codex input ([ed66391](https://github.com/mramdann/anbo-ai/commit/ed66391b680f9e49ee8642cddefc175fea5bbe94))

## [0.16.0](https://github.com/mramdann/anbo-ai/compare/v0.15.1...v0.16.0) (2026-08-18)


### Features

* add MCP agent orchestration ([f2e94cd](https://github.com/mramdann/anbo-ai/commit/f2e94cdd21d51ac9b222a4f525a5e3c254cd1a06))
* add workspace agent MCP and harden lifecycle ([083588e](https://github.com/mramdann/anbo-ai/commit/083588e486c24e14a5b3360a0ff4657e7d3b919c))
* **browser:** open workspace files from explorer ([4dd60e5](https://github.com/mramdann/anbo-ai/commit/4dd60e571fb5f9c169d6725f1d22adeb18297826))


### Bug Fixes

* **agents:** harden lifecycle notifications and routing ([29da08a](https://github.com/mramdann/anbo-ai/commit/29da08a1ae644830fdbd9212f16073c2c03845db))
* **agents:** migrate legacy Claude MCP config ([169ff9d](https://github.com/mramdann/anbo-ai/commit/169ff9db634f0d37ba27f2fba42316d5b74f10b2))
* **ci:** gate sidecar token helpers to Windows ([ef49f8e](https://github.com/mramdann/anbo-ai/commit/ef49f8eb6424f004d5600ee0c97d26b02b48b3d9))
* **release:** restore Cargo lock version annotation ([2689d88](https://github.com/mramdann/anbo-ai/commit/2689d8809cd7d65a79f965794bba2d4cb6a147f0))
* **tabs:** preserve runtime ids across remounts ([c1885e5](https://github.com/mramdann/anbo-ai/commit/c1885e517f81cd5751ebaf8599f5351f0a2f7241))

## [0.15.1](https://github.com/mramdann/anbo-ai/compare/v0.15.0...v0.15.1) (2026-08-16)


### Bug Fixes

* **notifications:** bundle Sonner's official stylesheet with the main application CSS so agent `needs_input` alerts remain compact, theme-aware floating toasts instead of rendering as unstyled full-width content below the workspace in production WebView2 builds


## [0.15.0](https://github.com/mramdann/anbo-ai/compare/v0.14.7...v0.15.0) (2026-08-16)


### Features

* **browser:** add a useful new-tab surface with a bounded 100-entry browsing history, per-entry removal, isolated-profile size reporting, and clear browsing data controls
* **browser:** support local HTML files through workspace-authorized `file:` navigation while preserving relative assets and same-workspace links
* **browser:** keep native browser tabs, media, and automation alive across background workspaces without activating or stealing focus from the user's workspace
* **agents:** replace the retired Gemini launcher with Antigravity CLI and centralize the official Claude, Codex, Antigravity, Pi, OpenCode, and Grok brand assets
* **agents:** assign stable workspace-scoped callsigns to agent tabs, keeping the canonical CLI name for the first instance and choosing collision-safe random aliases for later instances
* **agents:** launch every requested agent instance in its own independent tab and preserve its identity when layouts are restored or tabs move between workspaces
* **agents:** scope Claude, Codex, Antigravity, Pi, and OpenCode integrations to the authorized project instead of modifying global CLI configuration


### Bug Fixes

* **browser:** treat domains, localhost addresses, Windows paths, and explicit `file:` URLs correctly instead of sending valid destinations to Google or leaving the native view on `about:blank`
* **browser:** harden native WebView2 ownership, z-order, overlay, visibility, and geometry handoffs so rapid tab and workspace switches do not expose stale pages or transparent desktop frames
* **browser:** keep automation targets isolated per workspace, reject cross-workspace tab reuse, and close only browser tabs owned by the requesting workspace
* **window:** prevent minimize and restore transitions from collapsing the sidebar, fitting terminals to thumbnail geometry, displacing editor content, or flashing browser surfaces
* **startup:** replace indefinite splash-screen failures with phase-aware progress, actionable module and React render errors, and a readiness signal emitted only after the application root commits
* **agents:** use each tab's callsign in status rows, retained alerts, in-app toasts, and OS notifications while avoiding duplicated needs-input history
* **agents:** preserve exact Claude, Codex, OpenCode, Antigravity, and Pi sessions without injecting a fabricated session ID into a fresh CLI launch
* **agents:** discover concurrent Codex rollout sessions with workspace, launch-time, claimed-session, and UUID v7 filtering so restored tabs cannot resume one another's conversation
* **agents:** keep slow Claude startup, trust, login, and interactive prompts visible with the original managed task still pending instead of creating an inactive or late zombie command
* **ai:** resolve subagents through the same runtime model configuration as the AI panel, including custom OpenAI-compatible endpoints and endpoint-scoped keys
* **shell:** load Fish integration from Anbo's private runtime path and preserve user shell configuration across supported platforms


### Security and Privacy

* authorize agent integration writes against an exact registered workspace root, reject symlink escapes, preserve foreign hooks and plugins, and remove only historical Anbo-owned global entries
* isolate native browser data from the main Anbo webview and limit local-file navigation to the browser tab's authorized workspace root
* gate project agent signals on the Anbo terminal environment so ordinary CLI sessions outside Anbo remain unaffected


### Reliability

* coordinate browser, Dockview, editor, terminal renderer, and sidebar recovery through one stable window-presentation lifecycle
* perform a final Codex discovery scan at the timeout boundary and retry only the explicitly pending leaf
* preserve workspace roots independently from a terminal's changing current directory
* validate Fish launch arguments without depending on application data initialization during Unix CI
* add regression coverage for browser history and local files, background automation routing, WebView2 ownership, minimize and restore behavior, agent callsigns, cross-space moves, project integrations, exact-session resume, notifications, startup failures, and custom subagent models


### Documentation

* update the architecture, contributor, security, Nix, and project documentation from the historical Terax identity to Anbo
* document project-scoped integrations, stable agent identity, exact-session resume, isolated browser data, and the window-presentation lifecycle

## [0.14.7](https://github.com/mramdann/anbo-ai/compare/v0.14.6...v0.14.7) (2026-08-14)


### Bug Fixes

* **editor:** restore bounded text selection ([573acbc](https://github.com/mramdann/anbo-ai/commit/573acbc0489f27c6d4887a17817db3a896879e6a))

## [0.14.6](https://github.com/mramdann/anbo-ai/compare/v0.14.5...v0.14.6) (2026-08-14)


### Bug Fixes

* **editor:** preserve production theme styling ([8d42f88](https://github.com/mramdann/anbo-ai/commit/8d42f88a77a274427cf2ec64c4295bec289b0744))

## [0.14.5](https://github.com/mramdann/anbo-ai/compare/v0.14.4...v0.14.5) (2026-08-14)


### Bug Fixes

* **editor:** restore visible file contents in production WebView2 by anchoring CodeMirror's layout-critical styles globally, keeping gutters beside the document instead of stacking above it ([6b53390](https://github.com/mramdann/anbo-ai/commit/6b53390f9eb394203b372b0561cbdfdbe4870d00))
* **startup:** include the production chunk-cycle and root render fallback fixes prepared in v0.14.3 and v0.14.4, preventing restored workspaces from remaining on the splash screen without a useful error


### Reliability

* strengthen the production editor smoke test to verify horizontal gutter/content flex direction and viewport geometry
* retain static JavaScript chunk-cycle detection so an invalid installer cannot pass CI

## [0.14.4](https://github.com/mramdann/anbo-ai/compare/v0.14.3...v0.14.4) (2026-08-14)


### Bug Fixes

* **editor:** restore visible file contents and correct CodeMirror layout in production installers by keeping its runtime in Rolldown's natural module graph ([1b195d5](https://github.com/mramdann/anbo-ai/commit/1b195d5e1f551cd859123257a8b55199368eba85))
* **startup:** include the production chunk-cycle and root render fallback fixes prepared in v0.14.3, preventing the workspace from remaining on the splash screen without a useful error


### Reliability

* execute a real CodeMirror production smoke test that verifies rendered text, base flex styles, and first-line viewport geometry
* retain the static JavaScript chunk-cycle gate so invalid production bundles fail CI before an installer is published

## [0.14.3](https://github.com/mramdann/anbo-ai/compare/v0.14.2...v0.14.3) (2026-08-14)


### Bug Fixes

* **startup:** eliminate production-only Dockview, AI SDK, and CodeMirror chunk initialization cycles that blocked restored workspaces
* **editor:** preserve one CodeMirror runtime so editor base styles and theme facets render content correctly while language implementations remain lazy
* **build:** add AST-based static chunk-cycle detection and a root render fallback to prevent blank production windows

## [0.14.2](https://github.com/mramdann/anbo-ai/compare/v0.14.1...v0.14.2) (2026-08-14)


### Bug Fixes

* **startup:** prevent production dockview chunk cycle ([f7fca80](https://github.com/mramdann/anbo-ai/commit/f7fca807bb700c2cf5bb138b73e372966760b2da))

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

# Changelog

## [0.10.0](https://github.com/mramdann/anbo-ai/compare/v0.9.0...v0.10.0) (2026-08-08)

### Features

* add native Windows browser automation for Side-Panel AI, the bundled `anbo-browser` CLI, and MCP clients
* add accessibility snapshots with stable element refs for browser click and type actions
* allow AI browser navigation to open external HTTP and HTTPS pages or reuse the active preview tab
* add authenticated named-pipe transport, per-tab action serialization, and browser artifact retention
* add a polished startup loading surface before the React workspace initializes

### Improvements

* keep native browser previews and media live while React menus and dialogs overlap them
* preserve hidden preview bounds so pending navigation can complete before a tab becomes visible
* use a single JPEG freeze frame while dragging native previews to reduce capture overhead
* expand Side-Panel AI instructions for browser, task-tracking, subagent, and coding-agent tools
* use the full workspace surface for native previews
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
* keep browser overlay z-order changes isolated to live native previews without parking or repeatedly hiding them

### Testing

* add coverage for browser AI tools, preview overlay visibility, startup markup, native preview behavior, and clipped-tab counting

## [0.9.0](https://github.com/mramdann/anbo-ai/compare/v0.8.9...v0.9.0) (2026-08-05)


### Features

* improve empty workspace launcher ([#12](https://github.com/mramdann/anbo-ai/issues/12)) ([2a8bcb8](https://github.com/mramdann/anbo-ai/commit/2a8bcb827daee43ec8b2fc9abf6f4501fdc3bb5f))

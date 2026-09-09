# Testing

This guide elaborates on `ANBO.md` and `CONTRIBUTING.md`. If anything conflicts with `ANBO.md`, `ANBO.md` wins.

## Running checks locally

The canonical commands are what CI runs (`.github/workflows/ci.yml`):

```bash
pnpm lint
pnpm check-types
pnpm test:coverage

cd src-tauri
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked        # CI uses nextest
```

If you do not have `cargo-nextest` installed, `cargo test --locked` is the local fallback. Install nextest with `cargo install cargo-nextest`.

Frontend coverage is intentionally scoped to selected security and lifecycle policy files, with per-file thresholds configured in `vite.config.ts`. Rust CI generates LCOV with `cargo llvm-cov nextest` and enforces the backend line threshold in `.github/workflows/ci.yml`.

## Live browser readiness checks

With an isolated Windows Anbo instance running, exercise input guards, stable page postconditions, native phase timings, and text cleanup:

```powershell
node scripts/browser-readiness-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/readiness-run.json
```

Use the endpoint and explicit workspace of your test instance, not another user's session. The script creates loopback fixtures and background tabs, closes only its own tabs in `finally`, and refuses to overwrite an existing report. Run `scripts/browser-automation-benchmark.mjs` with the same arguments to cover legacy Enter behavior, refs, frames, and output caps. Avoid builds or CPU-heavy tests while collecting latency samples.

For dynamic pages, prefer `browser_press` with a fresh input `ref`, `expectedValue`, and `waitFor: { url, title, text, timeout, stableFor }`. All supplied postconditions must match; omit conditions you do not need. The text check searches a bounded main-document prefix, and stability is sampled, not a guarantee that every frame was visually painted. If a dispatched action times out, inspect the resulting page before deciding whether to submit again. Opt-in `diagnostics: true` reports bounded per-phase durations; it does not enable automatic input retries.

Use fresh background tabs to catch native input regressions that a warmed-up YouTube page can hide:

```powershell
node scripts/browser-input-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --repeats 10 --output .anbo/local-dev/native-input-run.json
```

Each round tests two native clicks, default Enter, and zero-observation Enter in separate new tabs. Assertions verify actual DOM counters, not only successful DevTools responses. Failures remain in the report while later independent cases continue; the script never retries a failed action to obtain a passing result. Existing tabs are preserved and cleanup checks the owned loopback origin before closing. Windows presentation changes also require a minimize/restore check: background hosts must stay outside the parent's client area with their viewport dimensions intact, and foreground UI focus must not be stolen. Do not reduce CDP timeouts or add input retries to conceal delivery failures.

## Native browser navigation

Direct single-target locators and locator-state waits have a dedicated native suite:

```powershell
node scripts/browser-locator-target-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/locator-target-run.json
```

It checks ref/locator exclusivity, strict fields, trusted input, value and submit guards, exactly-once behavior after a postcondition timeout, ambiguity across frames, richer element metadata, password redaction, and absent/hidden waits on a capped 50,000-node document. It also covers focus, hover, double click, check/uncheck, select, dialog handling, scrolling, and delayed removal through the same locator entry point. It never changes window geometry. Use a fresh output path and run resource-heavy suites sequentially. Repeated close/open must release destroyed children's startup reservations without weakening concurrent startup admission.

The Claude-audit regressions have reusable native fixtures:

```powershell
node scripts/browser-page-info-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/page-info-run.json
node scripts/browser-audit-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/browser-audit-run.json
node scripts/browser-network-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/network-run.json
```

Use new output files. These clients initialize HTTP sessions and forward the returned session header. They preserve original tabs/focus, close only owned loopback tabs, and remove their MCP sessions. Page-info checks hold navigation headers while reading committed title and URL. Audit checks verify DOM counters and values for hover, shortcut suppression, Shift text, accessible names, offscreen/no-match diagnostics, all console levels, and a slow response body. Network checks cover initial fetch/XHR, redirect, cross-origin same-site frames, reload, cancellation, and a never-ending stream. Idle requires request completion plus a continuous quiet window, not just response headers or document readiness. WebSockets and separate CDP targets are outside its documented page-target scope; do not infer full application readiness.

`accessibleNameScript.test.ts` and `consoleCaptureScript.test.ts` execute the shipped JavaScript helpers. Keep label precedence, password-value exclusion, bounded traversal/logging, original console calls, false-only assertions, and early-document/error capture covered. Rust network tests verify exact request-id accounting, redirects, quiet timing, and fail-closed bounds.

The audit smoke also covers native drag in both directions after scrolling, rejection before press when endpoints cannot share a viewport, canonical download status/wait with a different-root denial, no-dialog exactly-once click semantics, and nonempty bounded wait diagnostics on success and timeout. `dragProbeScript.test.ts` executes the shipped paired-geometry probe. Keep download identity separate from response formatting in lifecycle tests. Never resize, reposition, maximize, minimize, or restore the user's Dev window for these tests; viewport/DPI and animation sampling use the separate headless fixture instead.

Browser navigation changes also require a held-response check:

```powershell
node scripts/browser-navigation-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/navigation-run.json
```

The fixture deliberately withholds response headers until `browser_get_url` returns. That read must not depend on JavaScript in the pending document. The test also checks that the pending target remains reported, layout updates do not replay the request, explicit navigation still works, and original tabs and focus remain unchanged. Timing thresholds are local regression ceilings; run without builds or CPU-heavy tests in parallel. Never increase navigation deadlines or retry submitted input merely to turn this test green.

## What must have a test

Codex completion fallback is hookless and event-driven. Keep the exact rollout
workspace/session match, bounded appended reads, partial-record handling,
matching turn ids, input epochs, watcher disposal and late-callback rejection
covered. Real CLI checks must include a no-tool turn without a completion row,
a first input after session discovery has expired, a normal follow-up, and
normal `/exit` with readiness guards still enabled. Never change CLI hooks,
plugins, trust or global configuration to make the test pass.

Explorer icon generation must preserve all lookup mappings and exact SVG
viewBox/body data. `iconResolver.test.ts` verifies generated content revisions
and safe fallback names; `pnpm smoke:production` decodes every built local icon
alongside the real main-entry and editor layout checks. Keep the aggregate and
startup bundle ceilings unchanged.

Native browser creation must keep `WebviewBuilder.focused(false)` so creating
a child never depends on the user's OS window accepting focus. Pair the
source contract test with live rapid open/close, native child enumeration,
and log inspection. Do not resize, minimize or activate the user's Dev window
to reproduce an upstream focus failure.

The two native Windows voice focus tests share a desktop resource. An in-process
mutex serializes `cargo test`, and `src-tauri/.config/nextest.toml` assigns both
to a single-slot group for nextest's separate processes. Test windows are destroyed
on assertion failure. Setup verifies foreground and keyboard focus without moving
or clicking the system cursor; it fails before global input when focus is unavailable.
Run them only on an available interactive desktop, not while someone is typing.
This is test-only isolation, not a production voice-input lock.

Browser automation branding and effects require `automationState.test.ts`, `automationActivity.test.ts`, and Rust `browser_automation::caller` / `activity` tests. Cover separate concurrent callers, stale completion ordering, bounded session expiry, generic legacy fallback, redacted payloads, and timer cleanup. `node scripts/browser-effects-smoke.mjs` exercises the actual overlay in an isolated Chromium profile: click-through, native input, untouched layout/text, closed Shadow DOM, screenshots, reduced motion, viewport/DPI changes, and repeated mount/dispose. `--measure` records alternating off/on renderer task time and frame intervals on the same fixture. Keep builds and other CPU-heavy tests stopped during timing, and do not equate a headless or debug result with packaged-release performance.

Native verification must additionally use owned browser tabs in an explicitly designated workspace, two MCP sessions with distinct client names, navigation/reload, visible/background panes, the effects switch, native screenshots, and a dynamic page such as YouTube. No overlay DOM or arguments may enter snapshots; no old request may replace another caller's badge. Child-frame operations must retain the frame-label fallback unless their root-viewport position has been verified. Never enable remote debugging in tracked app configuration or modify an installed production profile for these checks.

The cursor-card smoke additionally checks below-right anchoring with left/above flips, all four viewport corners across DPI sizes, a 14 by 18 pixel neutral pointer, the two-row identity/tool/action layout, every canonical brand asset, generic and restrictive-CSP icon fallbacks, public tool-name aliases, actor changes, reduced-motion transitions, and a stable anchor through completion. Rust coverage keeps icons out of ordinary activity events and sends embedded assets only on install or actor changes. Arbitrary asset URLs and raw arguments must never enter the card. Activity must not cover the address input or add an activity subscription to `BrowserPane`. No per-mousemove DOM measurement, extra IPC, or polling should be introduced to position the badge.

The same smoke loads the shipped tab CSS to verify two outward circular pulses, stationary agent-logo geometry, clipping clearance, theme-token colors, and idle/reduced-motion stop. Motion checks cover distance-aware travel and mid-flight retargeting with matching cursor/card durations. `--measure` reports overlay and tab-pulse off/on samples separately; these are not old-code/new-code comparisons. Optional `--screenshot=<fresh-path>` and `--tab-screenshot=<fresh-path>` capture the separate fixture, not the user's app. Download registry lifecycle tests serialize only their shared test state; this must not add a production-wide download lock.

Cursor motion regressions must sample actual intermediate positions between separate requests, with a read-only request in between, rather than only assert the final transform. Cover persistence beyond the old 2.7-second disposal window, no running idle animations, explicit session end, late-event rejection, same-brand connection isolation, invalid coordinates, frame resets, screenshot restoration, and immediate reduced-motion positioning. Fake-clock state tests also advance ten minutes without expiring a live browser task. The native renderer suppresses queued pointer preflight events; model real rendered events such as `move`, `done`, and the next read's `running` phase. Native input counters must remain exact, without action retries or added input delays. External/unbound clients must call `browser_end_session` with the returned `controlId` in task cleanup. Local Windows clients can additionally use exact transport-PID-to-PTY-Job ownership plus the stable turn observer; a generic prompt or brand match is not sufficient. `browserTurnObserver.test.ts` covers background-server completion without changing global working status, permission waits, long thinking gaps, separate same-brand PTYs, in-flight requests, stale events, and no added reads when inactive. Rust tests verify native TCP PID resolution, exact job membership, private ownership serialization, and compare-and-end race guards.

`src/startupTheme.test.ts` runs the actual pre-bundle splash script without React or IPC; `src/modules/theme/startupTheme.test.ts` covers bounded palette snapshots, built-in and single-variant custom themes, preview exclusion, and unavailable storage. Check explicit and system modes, invalid or mismatched caches, rejected CSS values, and default-token parity. Visual checks should use the real startup HTML in an isolated browser profile with app modules withheld, verify computed colors in both modes and reduced motion, and avoid changing the user's saved theme. Startup changes also require a production build, `pnpm size:startup`, and `pnpm smoke:production`.

Explicit hover positions require `actionRectScript.test.ts`, AI tool forwarding, and Rust position/schema tests. Run `node scripts/browser-hover-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/hover-run.json` against the current Dev binary with a fresh output filename. It reproduces cached mouseover coordinates, verifies one trusted move per successful native call, rejects invalid/covered/stale targets without input, checks child-frame coordinates and explicit fallback reporting, and preserves the user's selected tab and workspace. Center-versus-position timings are same-build debug measurements, not a production speed claim. Real media QA additionally needs visible clock progression on the same playback item across repeated fresh loads; fixture counters and CSS hover are insufficient. Do not change the user's window geometry or add automatic input replay to make this pass.

First-tab selection is shared by MCP browser, shared-terminal and CLI-agent opens. `automationTabPlacement.test.ts` covers pending reservations, any existing tab kind, inactive workspaces and cleanup. Agent and terminal service tests verify selected-first reporting while preserving background defaults. On an explicitly empty active test workspace, add `--first-tab` to the hover smoke to check first/later/concurrent browser opens. Native QA must also check a first terminal, mixed browser/terminal opens, and one real configured CLI at a time. Do not override user selection for later opens or activate an inactive workspace. Retest actual window geometry and close only owned idle fixtures.

`src/app/lib/terminalCloseCopy.test.ts` covers retained close-dialog copy across confirm, Cancel, Escape, missing targets, pane closure, and reopening the same tab. UI regressions must also sample actual dialog exit-animation frames: only the original dialog should remain, with its original title and description until unmount. Cancel/Escape must preserve the target; confirmation disposes it once. Use fixture tabs rather than terminating user-owned agents.

Explorer mutations are covered by `pathMutations.test.ts` and `rename.test.ts`: guards run before rename/move/trash IPC, failed operations retain document paths, trash never invokes permanent delete, and Markdown/editor path updates respect descendant boundaries. Browser UI checks should also exercise right-click rename from search, focus after the menu closes, create-name correction, native pointer drag with an unsaved source, collision feedback, and trash failure followed by a deliberate retry.

`cargo test --lib modules::fs::recycle::tests --locked` checks authorization, workspace-root/WSL rejection, Windows recycle flags, and preservation when the recycle backend fails. The ignored Windows smoke can be run explicitly with `cargo test --lib modules::fs::recycle::tests::live_windows_recycles_owned_fixture --locked -- --ignored --exact`. It sends only an owned temporary folder into the real Recycle Bin; that fixture remains recoverable there. It must never use a project directory as its target. macOS/Linux trash behavior requires verification on those platforms before claiming cross-platform runtime coverage.

Visibility changes also require `node scripts/browser-visibility-smoke.mjs --mcp-url http://127.0.0.1:7332/mcp --workspace D:/anbo-dev-local/sandbox --output .anbo/local-dev/visibility-run.json`. It verifies consistent find/read/snapshot/wait/actionability behavior for transparent ancestors, Shadow DOM hosts, and slots, including refusal to dispatch a hidden click and successful interaction after reveal. Use a new output filename per run; only owned fixture tabs are closed.

`CONTRIBUTING.md` requires a test for any change that touches behavior in these load-bearing paths:

- Shell / terminal spawn (what shell launches, with which cwd, env, and login flags)
- Workspace authorization (both the allow and deny side)
- Git command layer (repo-root resolution, pathspec/argument guards, status parsing)
- Filesystem mutation (atomic writes, symlink handling, no-data-loss on partial failure)
- IPC command surface and AI tool surface
- Pure logic with wide reach (cwd inheritance, tab/split tree transforms, OSC/prompt parsing, command guard)

The bar is real coverage of the contract, not a placeholder. Test the edge, the deny path, the "what happens one level above home".

## What does not need a test

UI rendering, themes, syntax-highlight tables, and anything the type-checker already guarantees do not need tests.

## Writing a good test

A good test locks the invariant you are relying on. Examples from the codebase:

- `src-tauri/src/modules/workspace.rs` `auth_tests` verify that an authorized path, a subdir of an authorized root, an unauthorized path, a missing path, and a symlink escape all behave correctly.
- `src-tauri/src/modules/pty/job.rs` tests verify that dropping the Job Object kills the assigned process tree on Windows.
- `src-tauri/src/modules/pty/session.rs` tests verify that dropping a `Session` kills the child process.
- `src-tauri/src/modules/pty/shell_init.rs` tests verify shell classification and WSL fish launch specs.
- `src/modules/ai/lib/security.ts` is exercised by tests that assert specific paths are refused and that canonicalization catches symlink traversal.

## Cross-platform PTY tests

Platform-specific behavior must be gated:

```rust
#[cfg(unix)]
fn shell_has_children(shell_pid: u32) -> bool { ... }

#[cfg(windows)]
fn shell_has_children(shell_pid: u32) -> bool { ... }
```

Tests for ConPTY/Job Object belong behind `#[cfg(windows)]`; tests for Unix PTY lifecycle belong behind `#[cfg(unix)]`. Do not assume a helper that works on one platform works on the other.

## Security function tests

When testing `src/modules/ai/lib/security.ts` or the Rust equivalents, cover:

1. The literal path is refused.
2. The canonicalized path is re-refused (symlink case).
3. Case variants match on case-insensitive filesystems.
4. NTFS alternate data streams and trailing dot/space variants are normalized.
5. Write-only deny prefixes block writes but allow reads where appropriate.

## Invariants

- A local fix with global blast radius must be caught by a test; review alone is not enough.
- Test the deny path and the edge, not just the happy path.
- Keep platform-specific tests behind the right `#[cfg(...)]` gate.

## See also

- [`ANBO.md`](../../ANBO.md) - the architecture source of truth
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) - quality bar, project layout, how to contribute
- [`docs/README.md`](../README.md) - index of contributor guides

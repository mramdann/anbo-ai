# External browser development preview

## Status

Extension 0.4.3 / protocol 3 connects real Chrome and Edge profiles on Windows.
Selected pages now appear as Anbo tabs, with an address bar, navigation, viewport
controls, design controls, and an explicitly requested screenshot. The live page,
mouse/cursor effects, and design surface remain in the original browser window.
Without docking this is not a live embedded page or video stream. Windows DEV also
has the optional native-window prototype below.

Existing `browser_*` agent actions use a shared transport for embedded and external
targets. This includes page/ref reads, input, screenshots, cross-origin/out-of-process
frames, console/network observation, workspace-confined uploads/artifacts, cursor
effects, and the existing isolated-world design layer. Workspace switching leaves
bound targets and ongoing automation running without focusing their browser window.

This is a preview in production builds as well (Windows, from the header's
browser menu), opened on 2026-10-05 at the user's request with docking included.
Extension 0.5.0 refuses every cookie method, so agents drive signed-in pages
without reading or changing their sessions; forwarded network events carry only
request ids. The native host and the `anbo-browser` CLI verify the pipe server's
process id before sending a token. The acceptance gates below are known limits.
Managed agent downloads are explicitly unsupported on external targets, and no
profile-wide download behavior is changed. Downloads through Chrome/Edge's own UI
still work. Embedded start-page history is not imported from the browser profile.
Do not claim full parity or production readiness before the acceptance gates below.

## Native-window docking prototype (Windows DEV)

This first stage supports **one docked tab** at a time in an isolated development
build compiled from the current sources. Use **Setup Chrome/Edge** again to extract
extension 0.4.3 and native host 2,
then reload the extension and reconnect/approve the profile. Select an ordinary,
unpinned, ungrouped tab outside split view, open its Anbo tab, and press
**Dock in this panel (preview)**. The panel needs at least 400 x 300 physical pixels.
**Release to browser** returns the selected tab to its original window/index.

A dedicated normal browser window contains only that selected tab, preserving
the original profile and page. Its native title bar and browser controls remain.
It is aligned over the content region, not reparented into WebView2; the user
interacts with the actual browser. There is no frame capture/encoding/streaming
loop. Chrome's [tabs.move API requires normal windows](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-move),
so this does not use a popup-type window.

A random bootstrap challenge, native window class, browser executable, process
identity and window property bind the HWND before anything is hidden. A separate
native-host guardian must acknowledge recovery before the selected tab is moved.
The host restores that exact window's visibility/bounds on bridge EOF; normal
release/disconnect also attempts to return the tab. If its original window was
closed, the page stays open in a regular browser window. Existing user tabs are
never closed. A last-tab placeholder is removed only while it remains an untouched
owned blank tab. Adding another tab to the dedicated window or manually moving
the selected tab releases docking rather than presenting unrelated content.
Manually dragging/resizing the dedicated native frame also releases docking;
resize the Anbo panel to keep it docked. Repeated native location notifications
never resubmit identical placement requests, preventing resize feedback loops.

Resize/move/focus use Win32 events and coalesced layout changes, not an idle timer.
No topmost or owner/parent relationship is installed. Backgrounding/minimizing
Anbo, switching panels/workspaces, or showing an overlapping Anbo dialog hides the
docked window without detaching its automation target. Showing a panel requires a
fresh revision, so stale cleanup cannot hide a newer panel. Browser background
throttling and OS compositing still exist; this is not a zero-latency/zero-cost claim.

**Not finished:** Anbo-owned native cursor/highlight/design overlays, multi-dock,
automatic post-restart attachment, input arbitration, and live docking acceptance.
Existing page cursor effects are suppressed while docked, and design mode is
disabled there. Do not present this first stage as complete feature parity.

## Connection model

The extension uses a random profile ID kept in `storage.local`, not sync storage.
The user supplies a profile label; this is not an automatically verified OS profile
name. Chrome and Edge use the same extension sources. No cookie/password import
or profile-directory discovery is implemented. Approval explicitly allows Anbo to
list regular tab titles and URLs for the connected profile. The extension uses the
[`tabs` permission](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions)
for this metadata; listing does not attach a debugger or grant page control.
Incognito, internal browser pages, extension pages, and local files are excluded.

The tab picker queries once when opened after approval and when **Refresh tabs**
is pressed. It never polls. **Use in Anbo** checks that the tab still has the URL
shown in the picker, then attaches only that tab. **Open tab** creates a web tab in
a regular window of the same connected profile and attaches it. If opening succeeds
but attachment fails, the tab remains open; the operation is not retried. Anbo never
falls back to another tab, browser, profile, or incognito window.

**Release tab** revokes queued commands and detaches without closing the tab.
Closing its Anbo tab releases an adopted existing browser tab; an Anbo-created
browser tab is closed in Chrome/Edge as well. Cleanup removes Anbo cursor/design
surfaces and viewport overrides when the debugger is still available.
Closing a tab, stopping the browser's debugger session, and navigation to a
restricted page also revoke control. Disconnect during attachment cleans up the
late debugger connection. Already-dispatched browser actions cannot be undone.

Each native connection has its own random Anbo connection ID, request counter,
bounded command queue, replies, tab list, and approved workspace. Browser tab IDs
are never treated as globally unique. Disconnect clears approval and pending
requests. Reconnect requires approval again and never silently switches profiles.
Cloned profile IDs are refused while an identical browser/profile is connected.

Each selection has a random lease. UI input/close requests carry that lease so a
late request cannot control a replacement selection under the same Anbo tab ID.
Document generations invalidate refs on navigation, release, and reconnect.
Saved tabs persist only profile identity and panel layout, not live tab IDs,
connections or permissions. After explicit reapproval and selection, a unique
matching saved panel can reconnect; duplicate URL panels are not guessed.

Agent-created tabs use the workspace's unique approved profile and open in the
background. Multiple approved profiles require explicit disambiguation. A workspace
with disconnected external tabs fails instead of falling back to WebView2 or another
login. Selected tabs remain live across workspace switches, not cross-workspace moves.

A tab the user opens from the + menu or Ctrl+P is Anbo's own browser. New tab on a
profile in the header menu starts a new tab page whose first web page opens in that
profile while it stays approved for the workspace; no other profile is substituted.

Queues, frames and retained data are bounded: 64 bound Anbo tabs, 64 child debugger
sessions and 256 execution contexts/objects per selected page, and 128 console rows
or 128 KiB per bound tab. Captures are requested on demand, not while idle.

Transport is extension -> native messaging host -> authenticated Anbo named pipe.
The existing `anbo-browser` sidecar recognizes an extension-origin launch and uses
native messaging framing instead of its normal CLI/MCP mode. The native host is
registered for one explicit descriptor path and extension origin. It never falls
back to the production descriptor or opens a network debugging port.

There is no bridge heartbeat, interval, screenshot stream, automatic idle browser launch, or idle
DOM scan. The tab synchronizer listens to connection changes while Anbo runs; the connection dialog subscribes only while open. Closing it or switching
workspace does not disconnect the native session. Commands are serialized per tab,
bounded across tabs, and checked again for approval, tab consent, and expiry before
dispatch. Input is never automatically replayed after failure or timeout.
Each long-lived native host uses a single-thread Tokio scheduler; the normal
CLI/MCP sidecar runtime remains unchanged.

## Development setup (Windows)

Use a dedicated development Anbo data directory and disposable Chrome/Edge
profiles. Do not point this setup at a production instance during validation.

### Guided setup

1. From the repository root, start the development instance with
   `pnpm tauri dev --config src-tauri/tauri.browser-preview.conf.json`.
   Startup prepares the debug sidecar automatically. This uses
   `com.anbo.desktop.browser-preview`, separate from production data. Other custom
   development launchers must also prepare the current sidecar beside Anbo's executable.
2. In Anbo, choose **Connect Chrome / Edge (preview)**, then **Setup Chrome** or
   **Setup Edge**. Anbo extracts the extension, starts its bridge, and registers
   the native host for the current Windows user. No admin prompt or manual commands.
3. In the intended browser profile, enable **Developer mode** on the extensions
   page, choose **Load unpacked**, and paste the folder from **Copy extension folder**.
   This browser consent cannot be bypassed. Check the profile: opening the extensions
   page does not select or discover your intended signed-in account.
4. Open the extension, enter a label, and choose **Connect profile**. Approve the
   exact profile for the current workspace in Anbo, including its tab-list metadata.
5. Choose **Use in Anbo** beside an available tab, or enter an HTTP(S) URL and
   **Open tab**. There is no per-tab step in the extension.
6. Use **Check connection**, **Show in browser**, or **Release tab**. Neither
   releasing nor disconnecting closes browser tabs.

Upgrading from preview 0.1/0.2: run Setup once to refresh the extracted extension,
then reload it on the browser's Extensions page and accept updated permissions
if prompted. Version 0.3 uses protocol 3; old handshakes are rejected with an update
message. Reconnect and approve the profile, then choose its tabs in Anbo. Selection
creates a normal workspace tab in Anbo without copying cookies or login data.

Setup pins the development extension's ID with its public manifest key, derives a
native host name from the current application identifier, and binds it only to the
current instance's descriptor. Files live under that instance's
`browser-bridge/extension` and `browser-bridge/native-host` directories. Registrations
use `com.anbo.browser_bridge.<instance-hash>` under HKCU for the selected browser's
32-bit and 64-bit registry views. Setup refuses foreign registrations and reparse
points, verifies the native host protocol, and never installs browser policies or
reads/copies browser profiles. Release builds and the production identifier refuse
this preview setup. Browser launch failures leave instructions for opening the
extensions page manually, not a false claim of connection.

Setup is repeatable. Unchanged sidecars are not overwritten, so setting up Edge
after Chrome does not replace a running host. If the sidecar changes, disconnect
extension profiles before updating. Reload the unpacked extension after an update
when needed. The same development extension ID cannot be loaded twice into one
browser profile for two different Anbo instances; use separate test profiles.
If you installed the earlier unpinned preview manually, remove that extension before
loading the guided folder. Do not load the repository folder for guided setup:
the extracted `host.js` selects the correct instance-specific native host.

For removal, uninstall the unpacked extension and remove only the matching hashed
host registrations and that instance's `browser-bridge` directory. Verify the
registration's manifest path first. Profile approval remains explicit on reconnect.

### Manual fallback

The standalone installer remains available for explicit developer-controlled setup:

1. Build the sidecar with `cargo build --locked --bin anbo-browser` in `src-tauri`.
2. Start an isolated development instance and enable Browser Automation, or use
   its guided setup to start the server.
3. Load `extensions/anbo-browser` as an unpacked extension. Its pinned ID is
   `ikadkplcmlaopjecapgimjecabpnilnj`.
4. Identify the development instance's exact descriptor, normally
   `%LOCALAPPDATA%\com.anbo.desktop.browser-preview\runtime\browser\instance.json`.
   Check that its PID
   belongs to the development instance. The installer deliberately has no default
   descriptor path.
5. Run the installer with explicit paths, first using `-WhatIf`:

```powershell
.\scripts\install-browser-bridge.ps1 `
  -ExtensionId '<32-character extension ID>' `
  -SidecarPath 'D:\anbo-ai\src-tauri\target\debug\anbo-browser.exe' `
  -DescriptorPath '<development data root>\runtime\browser\instance.json' `
  -InstallDirectory '<dedicated development bridge directory>' `
  -Browser Both `
  -WhatIf
```

The installer copies the sidecar into the chosen directory and registers a
current-user native messaging host. It refuses to overwrite a registration for a
different bridge path or reuse a configuration pointing at another descriptor.
It does not launch a browser or copy profile data. Remove `-WhatIf` only after
verifying the paths. Restart/reconnect the extension after replacing the sidecar.
To uninstall, remove only the matching `com.anbo.browser_bridge` keys under
`HKCU\Software\Google\Chrome\NativeMessagingHosts` and/or
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts`, then remove the dedicated
installation directory and unpacked extension. Verify each key's manifest path
before removing it.
If Chrome and Edge report different extension IDs, pass both IDs to
`-ExtensionId` as a PowerShell string array; only those exact origins are allowed.

6. Connect, approve, and choose/open a tab as described in guided setup.

The original isolated implementation checks did not install the native host.
The later installed Chrome/Work acceptance session is recorded below.
Guided-setup checks cover pinned IDs, dev/production isolation, repeatable asset
extraction, shell argument handling with spaces/quotes, and atomic file replacement.
The installer subprocess test uses `-WhatIf`; its separate file-write test exercises
only the text-writing function in a temporary directory. Neither test registers a
host, opens Chrome/Edge, or connects a browser profile. Real installation and browser
pairing still require an interactive acceptance check in the development instance.

## Validation and benchmark boundaries

Run from the repository root (Rust commands use the `src-tauri` directory):

```text
pnpm check-types
pnpm test
pnpm lint
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked --lib modules::browser_automation -- --test-threads=1
cargo test --locked --lib modules::browser_external -- --test-threads=1
cargo test --locked --bin anbo-browser -- --test-threads=1
pnpm benchmark:browser-bridge
node scripts/browser-external-smoke.mjs chrome
node scripts/browser-external-smoke.mjs edge
```

The synthetic benchmark initializes the real JS dispatcher, tab manager and frame
adapter with mocked CDP: ten profile connections, two tabs each, 1,000 batches /
10,000 calls. Latest local sample: all replies received, zero failures; 1,010.916 ms
idle observation with zero CDP calls, replies, tab queries or attachments and 0 ms
Node CPU. Active ten-call batch p50/p95: 0.0266/0.1152 ms, maximum 1.0358 ms,
79 ms Node CPU. Command deadlines add active-call bookkeeping, not idle polling. This sample overlapped local Rust compilation. These are dispatcher measurements, not browser/system CPU results.

The real-browser smoke script uses a temporary empty profile under the workspace
and its own headless browser, never an existing login/profile. Its loopback fixture
checks cross-origin out-of-process iframe input, trusted root clicks, screenshot,
the actual cursor overlay and isolated-world design layer, and their cleanup.
Chrome 153.0.8010.54 passed all checks. Fifty frame reads: p50 0.780 ms, p95
4.690 ms, maximum 14.613 ms; zero adapter commands during the one-second idle
observation. The script removes only its verified owned profile directory.

This smoke check tests the real CDP frame adapter, not installed-extension native
messaging or complete Anbo UI/agent integration. Edge was not found in standard
installation locations here, so no live Edge result is claimed. Neither run
measures ten-workspace production CPU/RAM or proves feature parity.

Implementation checks: 207 frontend test files / 1,772 tests passed, including
the reconnect-coalescing and native dock lifecycle regressions. TypeScript and focused lint are clean.
Full lint retains 81 existing warnings and one informational diagnostic.
Rust passed 236 automation,
27 bridge/setup/dock and ten sidecar tests; all-target Clippy passed with warnings
denied.

The Windows library harness currently requires Tauri's Common Controls v6 resource.
Plain `cargo test --lib` exited before executing tests with `0xc0000139` after the
native window lifecycle pulled in the dialog runtime. For this validation the
unchanged Tauri-generated `target/debug/build/anbo-*/out/resource.lib` was linked
using `cargo rustc --locked --lib --profile test -- -C link-arg=<resource.lib>`;
the Cargo-reported harness then ran only the two browser filters above. No global
input/voice tests were run. Sidecar tests use the standard Cargo command. Making
the default library test harness include this resource remains a build-system task.

These checks do not exercise installed-extension/native-HWND docking end-to-end.
Live acceptance must still cover direct mouse/keyboard input, DPI/monitor moves,
minimize/restore, dialogs, manual tab movement, extension disconnect and Anbo crash.

The original full Rust library run had four unrelated failures: two Windows
symlink-privilege tests and two global-voice tests requiring interactive desktop
focus. Those tests are not changed or rerun against the user's production desktop.

## Installed Chrome/Work check (2026-09-27)

The approved real profile was exercised through Anbo DEV's HTTP MCP endpoint,
using Node fetch/Undici transport and a disposable loopback fixture. Reported
durations are the tools' `durationMs`, not total client wall time. Open, snapshot, type,
checkbox, select, property/text reads and trusted click verification passed.
Representative single samples: open 958 ms, snapshot 18 ms, type 14 ms, checkbox
221 ms, select 16 ms and click 1,123 ms. The click's native mouse-move phase alone
was 1,002 ms. These are individual observed tool timings, not p50/p95 benchmarks
or a claim of zero latency. No account actions or external submissions were made.

Two failures stopped acceptance. The user's dock action returned `Anbo main window
is unavailable`: Tauri's single-WebView convenience lookup excludes windows that
already contain embedded browser children. Docking now looks up the native window;
a mock-runtime regression covers the exact child-WebView transition, not Win32
placement. No successful live docking is claimed yet.

Screenshot also timed out, after which a DOM read timed out behind it. The selected
tab dispatcher now enforces the supplied command deadline, revokes that exact
selection and detaches before allowing explicit reselection. Queued input is never
replayed, late completion cannot revoke a new lease, and other tabs remain live.
Tests cover stuck capture, pending detach, late completion and zero leftover timers.
This prevents a stuck command from permanently occupying its queue; the underlying
live Chrome screenshot timeout still needs a successful retest. The disposable tab
was closed after the failure, without closing the user's browser or other pages.

Reload extension 0.4.1 after Setup Chrome to test the updated dispatcher. Live dock,
workspace/background continuity, screenshot, resize/focus/crash behavior and total
process CPU/RAM remain acceptance gates; none is implied by passing unit tests.

The subsequent installed 0.4.1 Chrome/W check passed input, trusted clicks, checkbox,
selection and text reads. A screenshot on a separate background test tab still
timed out. That selection was retired, while the original tab remained readable
(55 ms sample): timeout isolation worked, but screenshot capture did not pass.
The user's docking screenshot now shows `Release to browser`, without the original
main-window lookup error, but the native Chrome window is absent from that image.
Visibility while Anbo is foreground still needs confirmation. Reads, another
trusted click and link/back navigation continued after the UI reported attachment.
Do not equate successful attachment or CDP input with verified native placement.

Repeated empty-panel reports now have on-demand native diagnostics in
each `browser_tabs` entry's `nativeDock`: requested layout, native client bounds, foreground and
minimized/visibility flags, actual/requested browser bounds, the last reconciliation
sample and any failed placement/raise call. This reports no HWND or lease token,
does not focus or move a window, and installs no polling. A successful asynchronous
placement request is not proof that Chrome applied the requested bounds.

A bounded 45-second live diagnostic run (Node HTTP transport) observed correct
1247 x 771 native bounds and visibility while foreground, but also zero-sized hidden
layouts arriving during panel replacement. Monotonic revisions alone did not stop
an old component from scheduling a newer cleanup after the visible replacement.
Only the current visible presenter may now publish layout. Its replacement takes
ownership; late cleanup and resize callbacks from the old presenter are ignored.
Hidden/background copies do not publish layouts or install layout observers.
The browser's automation selection is unchanged. Three ownership regressions cover
late cleanup, independent docks, and in-flight hide ordering.

After the hot update, native diagnostics reported the active layout as visible
with matching requested/actual 1247 x 771 bounds and no window-call error. When
another app was active, the native window was hidden but the layout stayed valid;
a trusted fixture click (775 ms) and DOM read (34 ms) still passed. These state
checks do not establish pixel-level visibility or stacking order; user confirmation
of the final displayed result and workspace-switch acceptance is still pending.

A further self-test on the docked Chrome/W tab passed verified typing, checkbox,
selection, trusted click, End/Backspace, viewport scroll, scroll-to-element, reload,
back/forward and link navigation with document/URL postconditions. The disposable
fixture expired during the first navigation attempt; restarting that local server
and reloading recovered it. This was a fixture lifecycle failure, not a passing
navigation attempt. Native navigation replies briefly retained the previous UI
title/URL, so the separate document snapshots were the verification source.

The final PNG screenshot succeeded in 93 ms (18,961 bytes), and its page pixels
were inspected. This establishes one successful capture, not resolution of the
earlier intermittent timeout or proof of native-panel visibility. Diagnostics still
reported `another-application-is-active` with valid layout and matching bounds.
This run used Node fetch/Undici; type was 29 ms, checkbox 923 ms, select 41 ms,
trusted click 1,075 ms and reads 13-49 ms. These remain individual tool-side samples.
The desktop-control helper was checked again and returned `native pipe unavailable`
with Windows error 2, preventing direct UI testing of workspace switches, resize,
minimize/restore and final stacking order. No production acceptance is claimed.

## Dock reliability follow-up (2026-09-28)

The layout publisher now caches only acknowledged layouts, drains the latest hide
after a failed in-flight resize, ignores replaced presenters, and preserves updates
arriving during promise completion. Unrelated terminal mutations no longer schedule
panel measurement. Regression coverage checks failed delivery, resize coalescing,
workspace departure/reveal, late replies, idempotent cleanup, and zero idle timers.
A ten-workspace synchronization regression retains every selection without
rebinding, focusing, or unbinding. These are model tests, not native UI acceptance.

The repeated live run on installed extension 0.4.1 passed its first trusted click
(166 ms) and counter read (60 ms), but its first screenshot timed out. The old
dispatcher retired the selection and released its dock. The run stopped immediately;
there is no ten-sample benchmark or screenshot reliability pass.

Extension 0.4.2 contains timeout isolation for the explicit unclipped viewport
capture used by Anbo. A timeout returns an error without retiring the selection or
focusing the browser. Only one unresolved capture per tab and 32 per connection
are allowed; late completion is discarded, while fresh DOM/input requests remain
available. Expired queued input is still rejected. Other command timeouts, including
clipped/full-page captures, retain revocation and recovery. Dispatcher and real
tab-manager regression tests cover these distinctions. This does not guarantee
that Chrome renders or captures a hidden native window.

The verified 0.4.2 files are staged in the existing DEV extension directory with
the same extension identity and unchanged permissions. The running browser still
needs an extension reload and profile reconnect before live validation of this
change. No production profile, login data or permission was changed.

## Resumed installed-profile check (2026-09-28)

Anbo DEV remained running with its existing agent session. Opening a disposable
loopback fixture through MCP selected the already-approved Chrome/dewa profile;
there was no embedded-browser fallback, login-data copy, or new profile approval.
Typing, checkbox, select, trusted click and separate value/text verification passed.
One further type/click/read cycle passed. In cycle two, typing and clicking returned
success, but the verification read failed with `browser tab closed`, and the tab
was no longer listed. The test stopped without replaying input. The cause of that
selection loss is not established; the message alone does not prove that Chrome's
window closed. Navigation and screenshots were not reached, and no ten-sample
latency or reliability result is claimed.

The transport was Node fetch/Undici. Initial tool-side samples were type 81 ms,
property read 56 ms, checkbox 1,226 ms, select 40 ms, click 1,135 ms, and text read
45 ms. They are not total client wall time or native-docking measurements.
The four focused dispatcher/tab-manager/layout/synchronization suites passed all
65 tests. The synthetic ten-profile dispatcher benchmark completed 10,000 commands
with no idle bridge requests; its mocked timings are not real-browser latency or
ten-workspace application CPU/RAM.

The installed DEV extension files had reverted to 0.4.1 on disk. The current
handshake does not report the extension build, so the loaded version cannot be
verified from MCP. Matching-identity 0.4.2 files were staged again, without changing
permissions or restarting Chrome or Anbo. The running DEV binary still embeds the
older bundle: rebuild it before using Setup again, otherwise Setup can overwrite
the staged update. Extension reload remains necessary. Windows Computer Use still
returns native-pipe error 2; native placement and desktop lifecycle checks remain
unverified.

## Synchronization lifecycle follow-up (2026-09-28)

Four initially failing regressions reproduced independent frontend lifecycle bugs:
late binding responses reconnected a moved panel, warmed an already closed panel,
mutated a stopped service's panel, and dropped a metadata refresh arriving during
promise completion. Binding success and failure now reconcile the latest panel
state and verify ownership before publishing. Stopped services cannot open new
tabs, reconcile away a replacement service's bindings, or publish late results.
Refresh completion drains already-requested updates without polling or automatic
input replay. Moving a panel between workspaces still requires an explicit profile
reconnection; merely switching which workspace is foreground retains its lease.

Eight added regressions cover those races, delayed reconciliation, and stopping
before or after an open dispatch. All 1,772 frontend tests passed; the focused
external-browser suites passed 94 tests. TypeScript passed after replacing an
unsupported test-only Promise API with the existing deferred-promise pattern.
Full lint retains the same 81 warnings and one informational diagnostic. Rust and
the extension protocol were unchanged in this follow-up.

The next live open attempt returned `Anbo UI did not create the browser tab in
time`; no bound tab appeared in the subsequent tab list. That does not establish
whether Chrome briefly created an unbound tab, and the open was not replayed.
The earlier selection loss has not been attributed to these reproduced races.
Anbo DEV's process was not restarted, the on-disk extension remains 0.4.2, and
native placement plus ten-workspace production performance remain unverified.

## Isolated DEV rebuild (2026-09-28)

After explicit approval, the DEV application was rebuilt and restarted with the
0.4.2 extension assets and the synchronization fixes. The old DEV process was
terminated separately before stopping its launcher: Chrome was a descendant of
that process, so recursively killing the original launcher tree would also have
closed the user's browser. The original Chrome process remained running. No
production application or browser profile was stopped or changed.

The new DEV instance could not bind its HTTP MCP port 7332: Windows still reported
the listener against the exited DEV PID. The process or handle retaining that
listener has not been identified; Chrome was not closed to force a port release.
The separately rebuilt `anbo-browser-dev mcp --stdio` successfully reached the new
instance through Anbo's authenticated native pipe. The HTTP endpoint remains
unavailable, including for clients still configured to use port 7332; native MCP
is the available test transport, not evidence that HTTP recovery is fixed.

A loopback-only acceptance harness is staged under the ignored local DEV helpers.
It verifies real input results, repeated trusted clicks, navigation, screenshots
and post-capture reads, and never replays failed input or guesses a tab to close.
Its first run correctly refused to open a fixture until the Chrome/Edge profile is
reconnected and approved after restart. No embedded or alternate-account fallback
occurred. Reloading the staged extension and profile approval still require user
interaction; Computer Use continues to report native-pipe error 2. No new live
action-latency, screenshot, native-placement or CPU/RAM result is claimed.

## Installed-profile acceptance and loading race (2026-09-28)

The approved Chrome profile completed the native-MCP loopback harness through the
current DEV process. The unmodified workflow passed 29 checks: external-backend
identity, verified checkbox/select values, ten trusted type/click/read cycles,
keyboard editing, scrolling, link/back/forward/reload navigation, a screenshot,
post-capture DOM access, and closing only the owned fixture tab. The screenshot
was visually inspected and showed the expected second fixture page. It took
7,298 ms. The test never switched to the embedded backend or another account.

With ten samples per action, tool-duration p50/p95 was 38/61 ms for type,
1,932/2,344 ms for click, and 34/47 ms for text. Transport was one MCP stdio session
through the authenticated native pipe, not HTTP or Node fetch. This is neither a
matched embedded/external benchmark nor a ten-workspace CPU/RAM measurement.

Every click incorrectly reported `loading: true`, adding 1,508-1,566 ms beyond
recorded action phases. Selection read metadata before asynchronous debugger
setup, ignored completion events before insertion into the selected map, and
validated only the URL on its final read. Extension 0.4.3 now publishes that final
existing snapshot and verifies authority after the read. Four regression cases
failed before the fix and pass afterward, covering both loading transitions and
revocation/removal while the final read is pending. No new request, timer, focus
change, or input retry was added.

An explicit reload before a separate diagnostic measurement cleared the stale
loading flag on the installed implementation. The unexplained click gap fell to
4-20 ms, but click p50/p95 was still 853/2,780 ms due to variable action phases.
This is evidence for the false navigation wait, not a deployed-patch speedup or a
p95 improvement. That run passed 30 checks but failed overall because screenshot
capture timed out. DOM access still succeeded afterward in 139 ms, followed by
successful owned-tab cleanup. Real capture-timeout isolation is verified;
screenshot reliability is not.

Local evidence is retained in the ignored DEV helper directory:
`external-live-1790533946730.json` and
`external-live-1790534201634.json`. All 1,776 frontend tests in 207 files and
TypeScript passed. Full lint passed with the existing 81 warnings and one
informational diagnostic; no Rust source changed in this follow-up.

Source and staged DEV extension files are now 0.4.3 with unchanged extension
identity and permissions. The running DEV binary still bundles 0.4.2, and the
handshake does not expose the loaded extension build. Reload the extension and
reconnect/approve before claiming a live 0.4.3 result. Do not run Setup from that
older binary: it would overwrite the staged update. No browser or application was
restarted for staging. Native placement, desktop workspace switching, overlays,
and ten-workspace production performance remain unverified.

## Post-reload installed-profile verification (2026-09-28)

After the user reloaded the staged extension and approved the profile, two fresh
loopback runs used the original workflow without the diagnostic reload workaround.
Both passed all 29 input/navigation/DOM assertions, including ten verified trusted
clicks per run, and successfully closed only their own fixture tabs. Each new open
and all 20 measured clicks reported `loading: false`. The unaccounted click time
was 5-7 ms in the first run and 4-9 ms in the second, rather than the previous
1.5-second false navigation wait. The browser and DEV application stayed running.

Tool-duration p50/p95 in milliseconds, ten samples per action per run:

| Run | Type | Click | Text |
| --- | --- | --- | --- |
| First | 45 / 53 | 902 / 920 | 44 / 74 |
| Second | 37 / 54 | 925 / 957 | 35 / 56 |

These are installed-profile native-MCP observations, not a controlled general
speedup claim or an embedded/external comparison. Mouse-move dispatch remained a
large part of click time. The on-disk extension matches source 0.4.3 and the user
confirmed reload; the runtime handshake still does not independently report the
loaded extension build.

The first run passed overall. Its screenshot completed in 142 ms and was visually
checked against the expected second fixture page. The second run failed overall:
capture timed out after about 10 seconds. Subsequent DOM access completed in 33 ms
and owned-tab cleanup succeeded, without replaying the capture or activating
Chrome. Thus capture-timeout isolation remains working, but screenshot reliability
is still an open issue. Do not count these as two fully successful smoke runs or
treat a page screenshot as evidence of native docking placement.

Evidence: `.anbo/local-dev/external-live-1790534714397.json` and
`.anbo/local-dev/external-live-1790534776436.json`. The earlier attempt before
approval correctly refused the open rather than substituting another account.
No application code or runtime configuration changed during these verification
runs. Native visual docking and ten-workspace CPU/RAM acceptance remain pending.

The existing user-selected GitHub tab also reported a live native dock lease.
Requested and actual native bounds matched at 1247 x 771 pixels, with no recorded
window error. Windows diagnostics reported the browser hidden because another
application was foreground. A read-only DOM snapshot still completed in 97 ms
without focusing, navigating, clicking, or closing that tab. This verifies a
background-app read on a docked target, not pixel-level placement, background input,
or a desktop workspace-switch acceptance test.

## Remaining release gates

- Managed agent downloads with workspace-confined output and no profile-global
  download preference changes. Current external download actions fail before input.
- Installed-extension/native-host/Anbo end-to-end checks on both Chrome and Edge,
  including navigation, redirects, file uploads, dialogs, viewport changes, design
  export, screenshots and per-agent contention/ownership.
- Two profiles logged into the same site: verify no account substitution on release,
  debugger detach, restricted navigation, browser close, reconnect and restart.
- Verify restored panel placement across ten workspaces, duplicate saved URLs, and
  workspace switching while automation remains active elsewhere.
- Matched embedded/external runs with ten-workspace idle CPU, total process-tree
  CPU/RAM, p50/p95 action latency, four/eight concurrent agents and error counts.
  Include browser and native-host processes, not only Anbo.
- Resolve the remaining feature matrix. The dev-only gate was lifted on 2026-10-05
  with these items still open; they are the preview's known limits.

## Dock window handover and extension self-reload (2026-10-07/08)

- **Handover (extension 0.5.2).** Showing another tab of the same profile moves its page into the dock window that is already in place (`anbo.dockSwap`), and the page shown before goes back to its own window and index. Measured in Dev and prod with disposable Chrome 154 and Edge 156: 23 of 23 switches swapped in 90-101 ms on average (prod: 24 of 24, 71 ms), with no dark frame, where each switch used to be dark for 0.4-0.7 s. Another profile, a pinned or grouped tab, a closed original window, or older extension code falls back to release and attach.
- **Frame without the page window.** After agent input Chromium often keeps the docked page's render window hidden at 1x1, which used to leave the panel on "Opening the page from Chrome..." for good. The frame now also comes from the page's own size, and the last frame per browser and scale seeds the next dock window.
- **Focus emulation.** An agent's input turns on `Emulation.setFocusEmulationEnabled`; for Chrome and Edge tabs it is turned off when the agent's session ends and no other session holds the tab. A page counts as shown before pointer input only while its tab is in front of its window (`anbo.tabState`).
- **Self-reload (extension 0.5.3).** After an update the browser keeps running the old extension code until it reloads. Anbo asks an approved profile whose code reports an older version to reload itself (`anbo.reloadExtension`), once per profile and session. The extension lets go of its tabs and dock, reloads, and connects again within 60 s; Anbo approves the same profile for the same workspace again. Extension 0.5.2 and older do not know the request: those need one manual Reload at chrome://extensions or edge://extensions (the browser menu says so), and later updates reload on their own.

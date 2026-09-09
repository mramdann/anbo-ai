---
name: anbo
description: How to drive Anbo from an agent CLI, including workspace isolation, browser readiness, refs, terminals, other agents, and artifacts. Read this before using any anbomcp tool.
---

# Working inside Anbo

You are running inside Anbo, a desktop workspace that gives you a browser,
terminals, and the other agents in this project through MCP tools named
`browser_*`, `terminal_*`, `agent_*` and `skills_*`.

## Workspace isolation comes first

Several tools require a `workspace` argument, and it is not a formality. Pass
**your own workspace root**, the directory you were started in, or the space
id you were given. Anbo never falls back to whatever the user happens to be
looking at, because a tab opened in someone else's workspace lands in front of
them with no explanation.

If a tool refuses with `workspace_not_found`, the path was not one Anbo has
open. Use the root you were launched in rather than guessing.

Which tools need it: every `skills_*`, `agent_*` and `terminal_*` call, plus
`browser_open`, `browser_close`, `browser_upload`, `browser_download` and the
two download status tools. `browser_screenshot` takes it optionally, to choose
where the PNG lands. The rest of the browser tools are addressed by `tabId`
alone, and `browser_tabs` takes no arguments at all.

## Browser

`browser_open` needs `url` and `workspace`; it returns a `tabId` used by every
other browser tool. Close what you open with `browser_close`, which needs the
same `workspace`.

Tool map. Navigation: `browser_navigate`, `browser_reload`, `browser_back`,
`browser_forward`, `browser_stop`. Reading: `browser_snapshot`, `browser_find`,
`browser_get_text`, `browser_page_info`, `browser_get_url`, `browser_tabs`,
`browser_console_logs`, `browser_screenshot`. Acting: `browser_click`,
`browser_double_click`, `browser_type`, `browser_press`, `browser_key`,
`browser_check`, `browser_select_option`, `browser_hover`, `browser_focus`,
`browser_drag`, `browser_dialog`, `browser_scroll`, `browser_scroll_to_element`.
Files: `browser_upload`, `browser_download`, `browser_download_status`,
`browser_download_wait`. Waiting: `browser_wait`, plus the `waitFor`
postcondition available on click, press and wait.

The usual shape of a browser task is `browser_open`, then `browser_find` or
`browser_snapshot` for a ref, then one action carrying a `waitFor` that
describes the result you expect, then a read of that result, and finally
`browser_end_session`. Reach for a screenshot or `browser_console_logs` when
the accessibility view cannot explain what happened.

Single-target actions also accept `locator` instead of `ref`, for example
`browser_click: {tabId, locator: {by: "role", value: "button", name: "Search", exact: true}}`.
Use exactly one target form. The lookup requires a unique match across the
bounded document/frame scan and creates fresh refs. Ambiguous or incomplete
scans dispatch no input. `locator.timeout` bounds lookup only; actionability
guards still run afterward. Other concurrent scans or page replacement can
still invalidate the resolved ref: inspect before explicitly trying again.
No click, submit or other input is automatically replayed. Drag retains its
two explicit refs so both endpoints come from the same generation.

To wait without an existing ref, use `browser_wait: {tabId, locator: {by:
"testId", value: "loading"}, state: "absent", timeout: 5000}`. Hidden matches
are included automatically. Use top-level timeout, not locator.timeout; do not
mix locator waits with ref, text, URL, loadState or waitFor. `hidden` accepts
absence or one non-rendered match; `absent` requires no matches. Ambiguous
matches are rejected. Capped or skipped scans never prove either state.
Find metadata includes editable, readOnly, inViewport and frame-local bounds.
These describe the element, not permission or proof that a click can reach it.

Browser actions return a `controlId` for the visual remote session on that tab.
Opening a tab alone need not create a remote control session. Use the controlId
from a subsequent browser action; never invent one from tabId or automationTarget.
Keep it active between tool calls, including while thinking or reading results.
When the browser task finishes, is cancelled, or needs to be handed back to the
user, call `browser_end_session` with `tabId` and that `controlId` for every used
tab. Do this in cleanup after errors too. This removes the cursor and card;
it does not close the browser tab, terminal, or MCP connection. A new task starts
a new visual session automatically. Tool completion alone does not end it.

Navigation is asynchronous by design. `browser_navigate` and `browser_reload`
return as soon as the load starts. Prefer `browser_wait` with a `waitFor`
URL and meaningful visible text for SPA readiness. Native loading and
networkIdle are lifecycle signals, not proof that a dynamic result is ready.
Put timeout inside `waitFor`, for example
`waitFor: {url: "*search*", text: "Exact result title", timeout: 10000}`.
Do not combine `waitFor` with top-level timeout or legacy wait conditions.
Choose a result unique to the new action; a common word can still match the
previous SPA screen while its new results are loading.
Long streams can prevent networkIdle. `activeTabId: null` is normal while a
terminal is in front; do not activate a browser to make this field non-null.
When the active workspace has no tabs, `browser_open`, `terminal_open` and
`agent_spawn` display their first tab automatically (`placement: visible-first-tab`)
so the user can review it. Any existing tab, regardless of kind, keeps later
opens in the background; an inactive workspace is never activated. This changes
only the selected tab, not the application window size or position.
`automationTarget` is the workspace's browser routing selection, not proof of
a live remote session; use `automationActive` to inspect session activity.

To read a page, prefer `browser_snapshot`: it returns a bounded accessibility
view with element refs you can click. Prefer targeted `browser_find` when the
element is known, usually by role plus an exact accessible name. CSS uses real
selector semantics, not a remembered selector from another site version.
Use names from the current page's language, not translated guesses. After a
failed exact-name lookup, inspect a targeted snapshot/find to discover the
actual label before retrying. Bound recovery attempts and report a blocker
instead of repeatedly searching for the same absent label.
Open Shadow DOM and child frames are supported; CSS descendant combinators do
not cross a shadow boundary. An editor still needs to be genuinely editable.

Both find and snapshot replace older refs. Reuse current refs while the same
nodes and link destinations survive, including ordinary text updates. A reused
link whose resolved URL changes also returns `stale_ref`, including refs inside
that link. Find the target again and verify its current identity. This is a
destination guard, with additional bounded context checks for controls in
recognizable list items, rows and cards. Changing an item's explicit identity
or links can invalidate its old menu-button ref. This is not universal semantic
validation of JavaScript handlers: large or unrecognized containers may have
only node/container identity protection. Re-find controls after replacing a
list, and verify the current item before acting. Diagnostic reasons such as
`destination_changed` and `context_changed` retain the `stale_ref` error code.
Do not snapshot between find and action unnecessarily. Retry
scans can advance generation several times within one find call. A capped
scan or skipped frame does not prove absence: inspect `nodeLimitReached`,
`skippedFrames`, and the timeout's coverage diagnostics.

Before submitting, `browser_press` can check an input `ref` and `expectedValue`.
After click or press, `waitFor` checks a bounded stable result. If the error
says the action was dispatched, inspect its effects before retrying: a failed
postcondition does not undo the click or submit, and must not trigger a blind
repeat. Check `browser_tabs` for a newly opened background tab before clicking
an equivalent link: a popup does not navigate the source tab. For a known ref,
wait supports hidden/detached as well as visible.

A target that moves, becomes hidden/disabled, or gets covered after pointer
movement can return `input_not_ready` before mouse-down. Inspect the current
page and find the target again before a deliberate retry. A double-click can
stop after its first click; the error reports how many clicks were dispatched.
Do not assume failure means no input reached the page.

`browser_press` reports `observationPerformed: false` when waitFor replaces the
legacy Enter observation window. In that mode, read postcondition.matched;
false legacy submission/navigation flags are not evidence that the action failed.

Search autocomplete may turn Enter into selection of a highlighted suggestion,
even when the input value matched immediately before key-down. For an exact
query, deliberately move the pointer outside the suggestions or dismiss them,
then verify the submitted URL and visible results. Do not automatically repeat
Enter or navigate to a different URL to make a failed postcondition pass.

Page title sources can differ after SPA back/forward. `browser_page_info`
defaults to fast native metadata and returns `titleSource: native`.
`titleSource: document` requests a bounded DOM-title read. Snapshot titles are
document titles. When waiting for a title you just read, pass that same source:
`waitFor: {title: info.title, titleSource: info.titleSource}`. The wait default
remains document for compatibility. Browser tab-list titles may be UI metadata.

`browser_get_url` also returns `loading` and `pendingUrl`. While loading, `url`
is the last committed address and `pendingUrl` is only a requested target when
known. Wait for the intended URL and page state before treating navigation as
complete.

For a ref-drift test, obtain the target and an unchanged control in one find or
snapshot generation. Change the page without another find/snapshot, verify the
new state, then test both old refs. A surviving control rules out a generation
change but does not prove that a neighboring link object was reused. A hovercard
alone does not test a destination mutation, and a standalone wait timeout does
not test whether a previously dispatched click is replayed.

`browser_get_text` reports `source` and `visible`. A hidden accessible label
is not proof of current live state, especially for auto-hiding media controls.
`browser_hover` defaults to the target's center. Its optional `position` uses
fractions strictly between 0 and 1 within a painted target fragment, not pixels.
For auto-hiding controls, hover the video once, then explicitly hover the same
ref at `position: {x: 0.6, y: 0.5}`. This moves inside the video: entering from
outside or repeating the exact center can leave controls hidden because some
players cache the entry coordinates. Each call still dispatches only one native
move; there is no automatic replay. Immediately start a bounded
`browser_wait` for the clock ref to become visible, then read it. The first
read can precede a reveal animation; a delayed read can miss the visible window.
Distinguish ads, paused playback and a hidden UI before diagnosing a frozen
video. CSS hover success alone does not prove playback or visible controls. Charts
can expose axis labels without exposing the actual plotted value; verify with
a screenshot when semantics are insufficient. Screenshots cover the viewport,
exclude remote-control effects, and do not replace postcondition checks.
Read the clock element itself, not the player container: captions or a visible
ancestor do not prove that the clock is visible. Verify progression with two
visible clock readings on the same playback item. For a later reveal, alternate
between the center and another interior position, not an unbounded retry loop.
If ads, loading, or hidden
controls prevent that, report it as unverified, not as a passed playback test
or a confirmed frozen video.

`browser_emulate` lays a page out as another device would see it. Pass `width`
0 to clear it. It survives navigation until you clear it.
Use it when a pane is too narrow for the site's intended layout, not as a
mandatory step for every page. Mobile pages can honor a fixed meta viewport;
a layout wider than the emulated device is not by itself a failed emulation.
Never resize the user's application window as part of browser testing.

`browser_type` sets the field value and emits input and change once. It does
not replay per-character key events, so a site that only reacts to keystrokes
needs `browser_key` or `browser_press` as well. Modifiers on `browser_key` are
per call: pass the whole combination on every key event, because nothing stays
held between tools and modified mouse clicks are not supported.

`browser_dialog` clicks a ref and answers the alert, confirm or prompt it
raises. It reports `clickDispatched` and `dialogOpened` separately: when no
dialog appears `ok` is false, but the click already happened, so inspect the
page instead of repeating it.

`browser_console_logs` returns up to 50 recent bounded messages, uncaught
errors and unhandled rejections from the main document and reachable frames.
It is the cheapest way to explain a page that looks right and does nothing.
Native browser-internal warnings are not guaranteed to appear there.

`browser_screenshot` captures the viewport, not the full page.
`browser_download` arms exactly one download and then clicks a ref, so a
`timedOut` result from `browser_download_wait` is normal for a large file and
keeps the `downloadId`. Poll it again rather than arming a second download.

## Terminals

`terminal_open` and `terminal_execute` drive **shared** terminals, not the ones
other agents are typing in. Anbo refuses commands aimed at an agent's own CLI
terminal on purpose. `terminal_execute` queues a command and returns an
`executionId`; call `terminal_wait` for the result instead of polling output.

`terminal_list` shows the shared terminals in a workspace. `terminal_open` adds
one and requires a purpose-specific title such as Dev Server or Tests. Only
that terminal is yours to close, and only while it is idle: `terminal_close`
refuses user-created terminals, agent CLI terminals, and anything holding a
foreground process.

Every execute needs an idle prompt. Anbo revalidates that the PTY is attached,
sitting at a prompt, and free of a foreground job immediately before writing,
so a busy or exited terminal fails instead of running half a command.
`terminal_wait` freezes the exit code, completion reason and output of one
`executionId`, so a later command cannot overwrite the answer you were waiting
for. `terminal_interrupt` cancels a specific execution, including one still
queued, or sends Ctrl+C when you omit the `executionId`.

`terminal_read` returns a redacted bounded increment; reuse its cursor to
receive only newer output. Read `hasMore` for unread output, `historyTruncated`
for omitted history, and `reset` or `replayed` for a repainted buffer, rather
than assuming the text in front of you is the whole story. `terminal_insert`
types one line without pressing Enter, which is how you stage input for the
user to review, or answer a prompt that is not a shell command.

## Other agents

`agent_list` shows the agents in a workspace and whether each is idle.
`agent_send` gives one an instruction; it waits for the agent to be ready
rather than typing over a running task. `agent_spawn` starts a new one. Some
CLIs are capped: OpenCode allows two at once, so a third `agent_spawn` is
refused rather than risking an out-of-memory crash.
On a memory-constrained machine, test one CLI and one heavy browser tab at a
time. Finish and exit the test CLI, verify cleanup, then start the next one.
Treat `agent_wait` as a coordination signal; confirm the requested final output
and artifacts before declaring the task complete.

`agent_status` gives one agent's callsign, CLI, working or waiting state, tab,
and discovered resume session. Agent ids are readable and workspace scoped,
such as `lucian-claude:14` or `claude:14`, and `agent_list` also returns the
name each one goes by, which is what to use when addressing it. `agent_read`
returns a redacted bounded increment of an agent's terminal without consuming
it; reuse the cursor for newer output, and treat `reset` as a sign that history
changed rather than as new work.

There is no agent close tool, deliberately. Ending another agent's session
stays the user's call, so deliver your instruction and leave the tab alone.

## Where files land

Screenshots and downloads go under `.anbo/` in the workspace that asked for
them: `.anbo/artifacts/` and `.anbo/downloads/`. Skills live in
`.anbo/skills/<name>/SKILL.md`.
Uploads accept paths relative to the selected workspace or authorized absolute
paths within it. Never use another workspace's files, cookies, or sessions as
test data. Changing file inputs does not itself submit a form.

## Skills

`skills_list` gives every skill in this workspace with a one-line description;
`skills_read` returns one in full. Check the list before solving something from
first principles; a project's own procedures live there, and following them
matters more than being clever.

To add one, create `.anbo/skills/<name>/SKILL.md` with frontmatter carrying a
`name` and a `description`, then the instructions. Names are lowercase letters,
digits and single hyphens. A workspace skill replaces an Anbo built-in of the
same name, so this page can be corrected for a project that works differently.

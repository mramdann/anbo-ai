---
name: anbo
description: How to drive Anbo from an agent CLI. The essentials for browser work come first; workspace isolation, files, terminals, other agents and the finer browser behaviour are sections you read only when a task needs them.
sections: on-demand
---

# Working inside Anbo

You are running inside Anbo, a desktop workspace that gives you a browser,
terminals, and the other agents in this project through MCP tools named
`browser_*`, `terminal_*`, `agent_*` and `skills_*`.

**Workspace isolation.** Tools that take `workspace` need **your own
workspace root** (the directory you were started in) or the space id you were
given. Anbo never falls back to whatever the user is looking at. Needed by
every `skills_*`, `agent_*` and `terminal_*` call, plus `browser_open`,
`browser_close`, `browser_upload` and the download tools; the other browser
tools are addressed by `tabId`. `workspace_not_found` means the path is not one
Anbo has open: use the root you were launched in.

**A browser task.** `browser_open {url, workspace}` returns a `tabId` and the
`controlId` of your session, which opens itself on your first browser call.
Find a target with `browser_find {tabId, by: "role", value: "button", name:
"Search"}` (also `text`, `label`, `placeholder`, `testId`, `css`; implicit
roles include heading, searchbox, textbox, combobox, dialog, list, table and
landmarks), or read the page with `browser_snapshot` (viewport text first, then
interactive elements, paged with `offset`). Both return refs like `g3-e12` and
replace older refs; `stale_ref` means find it again. Act with `browser_click`,
`browser_type`, `browser_press`, `browser_key`, `browser_hover`, `browser_drag`,
`browser_select_option`, `browser_check`, `browser_scroll`; single-target actions
also take `locator` instead of `ref`. Every action reply carries `page`
(`url`, `title`, `loading`), so you never need a separate URL read after a
click or a key. Read results with `browser_get_text` (a ref, or the body) or
`browser_get_property` for live state such as `paused`, `currentTime`,
`value`, `checked`, `scrollTop` (a closed list of plain DOM properties, one
call, no page JavaScript). Close your last tab with `browser_close {tabId,
workspace, endSession: true}`, which also ends the session; `browser_end_session
{controlId}` ends it without closing tabs, for an abandoned task.

**Waiting.** Navigation is asynchronous: `browser_navigate`, `browser_reload`
and `browser_back` return at once. Put `waitFor: {url, title, text, timeout}`
on click, press or wait to verify the state you expect; `text` is a
case-insensitive substring of the visible page text, `url` a glob. A reply of
`matched: true, stable: false` means the condition held but the page kept
changing (a live price, a ticker, an advert): treat it as matched. A timed-out
postcondition never repeats the action, so inspect the page before retrying
instead of resubmitting. `browser_wait` also takes `locator` + `state`
(including `absent`) with a top-level `timeout`.

**Reading pages well.** Use names in the page's own language; after a failed
lookup, `browser_find` by text or a snapshot shows the real label. Bound your
retries and report a blocker rather than searching for the same absent label
again. A `confirmed absence` can come back well before your timeout once the
page has settled and stopped changing: treat it as final, not a wait cut
short, and switch to a snapshot or a different name instead of re-asking.
`browser_screenshot` returns the viewport image in its reply (use
`format: "jpeg"` to keep it small), and `browser_console_logs` is the cheapest
explanation for a page that looks right and does nothing.

**Typing.** `browser_type` sets the value once (input and change events); a
site that reacts per keystroke needs `browser_key` or `browser_press`. Enter in
a search box may pick a highlighted suggestion instead of submitting the typed
text, so verify the URL and results afterwards. `browser_press` accepts the
input `ref` plus `expectedValue` to refuse typing into a replaced field.

**Where files land.** Screenshots and downloads go under `.anbo/` in the
workspace that asked for them: `.anbo/artifacts/` and `.anbo/downloads/`.
Uploads accept paths inside the selected workspace only. Never use another
workspace's files, cookies or sessions as test data.

## Browser details

Refs are generation-scoped. A reused link whose resolved URL changes also
returns `stale_ref`, including refs inside that link, as do controls in
recognizable list items, rows and cards whose identity changed; large or
unrecognized containers keep only node identity protection. Re-find controls
after replacing a list and verify the current item before acting. A capped scan
or skipped frame does not prove absence: inspect `nodeLimitReached`,
`skippedFrames` and the timeout's coverage diagnostics. Open Shadow DOM and
child frames are searched; CSS descendant combinators do not cross a shadow
boundary.

`locator` on a single-target action, for example `browser_click: {tabId,
locator: {by: "role", value: "button", name: "Search", exact: true}}`, requires
one unique match across the bounded scan and creates fresh refs; ambiguous or
incomplete scans dispatch no input, and `locator.timeout` bounds the lookup only.
To wait without a ref: `browser_wait: {tabId, locator: {by: "testId", value:
"loading"}, state: "absent", timeout: 5000}`; hidden matches are included,
`hidden` accepts absence or one non-rendered match, `absent` requires none, and
`minCount` waits for several. Do not mix locator waits with ref, text, URL,
loadState or waitFor.

A control session is a contract with you, not with a tab: one `controlId`
covers every tab you open or act on, and browser results repeat it. Never
invent one from a tabId. `browser_start_session` is optional; pass `tabId` to it
to paint a tab as yours before any action runs. `browser_end_session` once at
the end (also after errors) removes the cursor and badge; it closes no tab,
terminal or connection, and a new task starts a new session by itself.

Postconditions: `browser_press` reports `observationPerformed: false` when
`waitFor` replaces the legacy Enter observation window; read
`postcondition.matched` then. A failed postcondition does not undo a click or
submit. Check `browser_tabs` for a newly opened background tab before clicking
an equivalent link: a popup does not navigate the source tab. A target that
moves, hides, disables or gets covered after pointer movement returns
`input_not_ready` before mouse-down; a double-click can stop after its first
click and reports how many clicks were dispatched. Failure never means no input
reached the page.

Page titles: `browser_page_info` defaults to fast native metadata
(`titleSource: native`); `titleSource: document` reads the DOM title. Snapshot
titles are document titles. When waiting for a title you just read, pass the
same source. `browser_get_url` returns `loading` and `pendingUrl`; while
loading, `url` is the last committed address.

`browser_get_text` reports `source` and `visible`; a hidden accessible label is
not proof of live state, especially for auto-hiding media controls. For those,
hover the video once, then hover the same ref at `position: {x: 0.6, y: 0.5}`
(entering from outside or repeating the exact center can leave controls
hidden), start a bounded `browser_wait` for the clock ref to become visible, and
read the clock element itself. Verify playback with two visible clock readings;
distinguish ads, paused playback and hidden UI before calling a video frozen.
Charts can expose axis labels without the plotted value: verify with a
screenshot when semantics are not enough. Screenshots cover the viewport,
exclude remote-control effects and do not replace postcondition checks.

`browser_drag` takes two refs, or the same ref twice with `sourcePosition` and
`targetPosition` as fractions of the element to pan inside it. Both points must
be visible; nothing is retried automatically. `browser_emulate` lays a page out
as another device would; `width: 0` clears it, it survives navigation, and it
never resizes the application window. `browser_key` modifiers are per call:
pass the whole combination on every key event. `browser_dialog` clicks a ref
and answers the alert, confirm or prompt it raises, reporting `clickDispatched`
and `dialogOpened` separately. `browser_download` arms exactly one download and
clicks a ref; a `timedOut` result from `browser_download_wait` is normal for a
large file and keeps the `downloadId`, so poll it again rather than arming a
second download. `browser_console_logs` returns up to 50 recent bounded
messages, uncaught errors and unhandled rejections from the main document and
reachable frames.

When the active workspace has no tabs, `browser_open`, `terminal_open` and
`agent_spawn` display their first tab automatically (`placement:
visible-first-tab`); any existing tab keeps later opens in the background, and
an inactive workspace is never activated. `activeTabId: null` is normal while a
terminal is in front. `automationTarget` is the workspace's routing selection,
not proof of a live session; `automationActive` says whether one is running.

## Design feedback

The user can mark up a page in Anbo's browser directly: boxes, arrows,
sketches and picked elements, each with a numbered badge and an optional note.
When they send it, you receive one message that names the page, the annotated
capture (`.anbo/artifacts/design/<name>.png`, or `.jpg` for a very large
viewport) and a JSON document next to it, followed by the numbered notes. Open
the image to see the marks; the numbers on it match the list in the message
and the `marks` array in the JSON.

Each JSON mark carries `kind` (`box`, `pick`, `arrow` or `pen`), `note`,
`rect` in document CSS pixels, `viewport` in viewport CSS pixels (multiply by
`viewport.dpr` for image pixels), `inViewport`, and for marks on an element an
`element` object with `tag`, `role`, `name`, `text`, `selector`, `testId` and
a ready-made `locator` you can pass straight to `browser_find` or a
single-target action. Prefer the locator over the raw pixel geometry; the
selector is a bounded path and may drift after your own edits.

While design mode is on, that tab's input tools return `input_not_ready` with
a `design_mode` reason, because the drawing layer sits over the page. Reading,
finding, navigating and reloading keep working, and `browser_screenshot`
captures the page without the marks. Do not retry input against it; act on
the feedback in the code, then reload the page and verify. Anbo's own overlay
elements never appear in snapshots or find results.

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

## Skills

`skills_list` gives every skill in this workspace with a one-line description
and, for skills read on demand, their section titles. `skills_read` returns a
skill in full, or its essentials plus a section index for one that reads on
demand, or one section when you pass `section`. Check the list before solving
something from first principles; a project's own procedures live there, and
following them matters more than being clever.

To add one, create `.anbo/skills/<name>/SKILL.md` with frontmatter carrying a
`name` and a `description`, then the instructions. Names are lowercase letters,
digits and single hyphens. Add `sections: on-demand` to the frontmatter to have
a long skill read as essentials plus sections. A workspace skill replaces an
Anbo built-in of the same name, so this page can be corrected for a project
that works differently.

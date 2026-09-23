---
name: anbo
description: How to drive Anbo from an agent CLI. The essentials for browser work come first; workspace isolation, files, terminals, other agents and the finer browser behaviour are sections you read only when a task needs them.
sections: on-demand
---

# Working inside Anbo

Anbo provides a real browser, terminals and other agents through MCP. Use your
own workspace root or assigned space id wherever `workspace` is required,
never whichever workspace the user is viewing. Other browser calls use `tabId`.

Five browser patterns:

1. **Open and read.** `browser_open {url, workspace}` returns `tabId` and
   `controlId`. Add `find: {by:"role", value:"heading"}` or `snapshot:true`
   for an initial read after document commit in the same call. Check `readOk`;
   `readError` keeps the new tab for recovery, so do not open a duplicate.
   One-shot research: `browser_open {url,workspace,snapshot:true,closeTab:true,endSession:true}`.
   Or replace snapshot with `find:{by:"text",value:"India",ancestors:"row"}`.
   Use this instead of open + read + close when no follow-up interaction is needed.
   `closeTab` only closes the new tab after a successful read; returned refs then
   cannot be reused. Omit it when you need to click, inspect more, or show the user.
2. **Discover once, act directly.** Use `browser_find` for unknown targets or
   `browser_snapshot` for unfamiliar structure (paged with `offset`). Otherwise
   pass one live `ref` or unique `locator`, e.g. `{by:"label",value:"Email",exact:true}`.
   Use observed names in the page's language, never guessed CSS or translations.
   `exact:true` requests a full name match. Ambiguous errors carry candidate refs;
   choose the intended one without another find, never blindly the first.
   Refs survive eight scans while their node and identity survive, not navigation
   or replacement. On `stale_ref`, rediscover; no similar target is clicked silently.
3. **Act and observe.** Type/click return menu or autocomplete items in `revealed`;
   use their refs. Type verifies the immediate value; autocomplete may use guarded
   native key events when a value-only fill opens nothing. Append is never replayed.
   To search, `browser_type {ref,text,submit:true,waitFor}` types and presses
   Enter in one call. A separate Enter uses `browser_press` with the input `ref`,
   `expectedValue` and a result `waitFor`.
   Navigation-shaped replies already carry `page.url` and `page.title`; a new page
   adds `page.hints` with its `heading` and `results` (title links with refs).
   `waitFor:{url,title,text,timeout}` checks the result; URL supports globs, text
   is a visible substring, title is exact (`*` is literal). A changing title can
   use `titleMatch:"prefix"`. Streaming pages need explicit readiness, not
   `networkIdle`. `matched:true,stable:false` means matched but not stable.
   A timeout after dispatch must not trigger blind resubmission.
4. **Read facts together.** `browser_find` and `browser_get_text` accept
   `ancestors:"row"` for the nearest table/ARIA row or `ancestors:N` for explicit
   levels. No row never means the whole page. Shared blocks use `blockRef`.
   `browser_get_property` reads live `paused`, `currentTime`, `value`, `checked`
   and other allowed properties without eval; a press or click on a player
   already returns them in `media`, and landing on a playing player adds
   `page.media`. Screenshot checks visual state;
   console logs help diagnose failures. Absence/hints describe observed state,
   not guaranteed future absence or unique substitute targets. Bound retries.
5. **Finish.** Put `endSession:true` on the last successful call. Use
   `browser_close {tabId,workspace,endSession:true}` to close a task tab, or a final
   read to leave it for the user. Ending control removes cursor/badge, not tabs.

Screenshots live in `.anbo/artifacts/browser/<task-folder>/`: reuse `context`
per task, `label` per image, and the returned path. Downloads use `.anbo/downloads/`;
uploads must stay inside your workspace. Never use another workspace's files,
cookies or sessions as test data. Read the relevant section below for details.

## Browser details

### Screenshot artifacts

For example, `browser_screenshot {tabId, context:"youtube-playback", label:"after-pause", format:"jpeg"}`
groups related captures in a readable task folder. Keep the context identical
throughout the task, and choose a short label for each state being verified.
Folders use `<UTC-date>_<task>_<run-id>` and contain numbered images and
`manifest.jsonl`. Optional `workspace` verifies the tab root, never redirects output.
Use a new context for a different task. Folder identity is scoped to the active
browser control session and workspace; a new session, app restart, ten minutes
without a capture, or bounded cache eviction starts a new run folder. Parallel
agents do not share runs. Calls without context group by host, not inferred intent.
Captures always write a file, even when returned inline. `inline:false` only
omits the reply image. Existing files are neither moved nor deleted. Grouping
does not reduce disk usage. Metadata stores source origin only, never URL
credentials, path, query or fragment; avoid putting secrets in context/label.
Read `metadataRecorded` and any warning: if the image saved but its manifest
failed, keep the returned path instead of automatically taking another shot.

### Form filling

`browser_fill_form {tabId, fields: [{locator, text}, {locator, checked: true},
{ref, option}]}` runs type, check or select per field in order. It stops at the
first failure and names the fields already done; submit separately with
`browser_click` or `browser_press`.

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
invent one from a tabId, and never look for a start tool: your first action
on a tab paints it as yours. `endSession: true` on a successful last call
releases it at once (an error leaves it, so you can recover). A session you
leave alone is drawn as idle after a minute and a half, released after ten
minutes of silence or when your terminal turn ends, and a new task starts a
new session by itself. Another agent acting on your tab takes it over: the
tab follows whoever acted last.

Postconditions: `browser_press` reports `observationPerformed: false` when
`waitFor` replaces the legacy Enter observation window; read
`postcondition.matched` then. A failed postcondition does not undo a click or
submit. Check `browser_tabs` for a newly opened background tab before clicking
an equivalent link: a popup does not navigate the source tab. A target that
moves, hides, disables or gets covered after pointer movement returns
`input_not_ready` before mouse-down; a double-click can stop after its first
click and reports how many clicks were dispatched. Failure never means no input
reached the page.
Use `browser_click` with `clickCount: 2` for a double-click.
Fill and select verify the final value without waiting for a stationary box;
visibility, enabled/editable and identity checks still apply. A mismatch after
dispatch is not permission to repeat the input.

Page titles: `browser_page_info` defaults to fast native metadata
(`titleSource: native`); `titleSource: document` reads the DOM title. Snapshot
titles are document titles. When waiting for a title you just read, pass the
same source. `browser_page_info` also returns `loading` and `pendingUrl`; while
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
`targetPosition` as fractions of the element to pan inside it, or a `locator`
with both positions to pan inside one element straight from a missed find.
Both points must be visible; nothing is retried automatically. `browser_emulate` lays a page out
as another device would; `width: 0` clears it, it survives navigation, and it
never resizes the application window. `browser_press` modifiers are per call:
pass the whole combination on every key event. `keyAction` is `press` by default,
or `down`/`up`; only `press` supports postconditions and Enter observation.
`browser_dialog` clicks a ref
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

---
name: anbo
description: How to drive Anbo from an agent CLI — workspace isolation, the browser, terminals, other agents, and where files land. Read this before using any anbomcp tool.
---

# Working inside Anbo

You are running inside Anbo, a desktop workspace that gives you a browser,
terminals, and the other agents in this project through MCP tools named
`browser_*`, `terminal_*`, `agent_*` and `skills_*`.

## Workspace isolation comes first

Several tools require a `workspace` argument, and it is not a formality. Pass
**your own workspace root** — the directory you were started in — or the space
id you were given. Anbo never falls back to whatever the user happens to be
looking at, because a tab opened in someone else's workspace lands in front of
them with no explanation.

If a tool refuses with `workspace_not_found`, the path was not one Anbo has
open. Use the root you were launched in rather than guessing.

## Browser

`browser_open` needs `url` and `workspace`; it returns a `tabId` used by every
other browser tool. Close what you open with `browser_close`, which needs the
same `workspace`.

Navigation is asynchronous by design. `browser_navigate` and `browser_reload`
return as soon as the load starts, so follow them with `browser_wait` or
`browser_tabs` rather than assuming the page is ready.

To read a page, prefer `browser_snapshot`: it returns a bounded accessibility
view with element refs you can click, and it will not flood your context the
way raw HTML does. Refs belong to the snapshot that produced them — take a
fresh snapshot after the page changes rather than reusing old ones.

`browser_emulate` lays a page out as another device would see it. Pass `width`
0 to clear it. It survives navigation until you clear it.

## Terminals

`terminal_open` and `terminal_execute` drive **shared** terminals, not the ones
other agents are typing in. Anbo refuses commands aimed at an agent's own CLI
terminal on purpose. `terminal_execute` queues a command and returns an
`executionId`; call `terminal_wait` for the result instead of polling output.

## Other agents

`agent_list` shows the agents in a workspace and whether each is idle.
`agent_send` gives one an instruction; it waits for the agent to be ready
rather than typing over a running task. `agent_spawn` starts a new one. Some
CLIs are capped: OpenCode allows two at once, so a third `agent_spawn` is
refused rather than risking an out-of-memory crash.

## Where files land

Screenshots and downloads go under `.anbo/` in the workspace that asked for
them — `.anbo/artifacts/` and `.anbo/downloads/`. Skills live in
`.anbo/skills/<name>/SKILL.md`.

## Skills

`skills_list` gives every skill in this workspace with a one-line description;
`skills_read` returns one in full. Check the list before solving something from
first principles — a project's own procedures live there, and following them
matters more than being clever.

To add one, create `.anbo/skills/<name>/SKILL.md` with frontmatter carrying a
`name` and a `description`, then the instructions. Names are lowercase letters,
digits and single hyphens. A workspace skill replaces an Anbo built-in of the
same name, so this page can be corrected for a project that works differently.

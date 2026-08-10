# NOTICE

## Attribution

**anbo** is a derivative of [Terax](https://github.com/crynta/terax-ai) by
**Crynta**, licensed under the Apache License, Version 2.0.

The original Terax software, its copyright notice, and the full Apache-2.0
license text are preserved in this distribution:

- Original license: [`LICENSE`](./LICENSE) (Apache-2.0, unchanged)
- Original copyright: `Copyright 2026 Crynta` (retained in this NOTICE per Apache-2.0 §4(b); `tauri.conf.json` carries the derivative copyright)

## Modifications

This distribution modifies the original Terax work. Per Apache-2.0 §4(b), the
following files have been changed or added. Files marked **added** are new and
not derived from Terax source; they are anbo-original and may be licensed
separately.

- `src-tauri/src/modules/anbo/` — **added**. anbo resume-strategy (session-id
  discovery for CLI agents) + Telegram bridge + multi-agent orchestration.
- `src-tauri/src/modules/mod.rs` — modified (registered `anbo` module).
- `src-tauri/src/lib.rs` — modified (registered `anbo_find_claude_session`
  Tauri command).
- `src-tauri/tauri.conf.json` — modified (productName/identifier → anbo).
- `src-tauri/Cargo.toml` — modified (description).

## Upstream

Terax is actively developed upstream. To incorporate upstream fixes, keep
anbo-specific code isolated under `src-tauri/src/modules/anbo/` and minimize
edits to Terax core files.

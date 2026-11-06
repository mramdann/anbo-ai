# tao 0.37.1, patched for Anbo

Unchanged from the crates.io release except:

- `src/platform_impl/windows/event_loop/runner.rs` and `event_loop.rs`: the
  runner is shared through an `Arc`, not an `Rc`.
- `Cargo.toml`: no `[[example]]` entries; the examples are left out.

Why: `tauri-runtime-wry` keeps tao's `EventLoopWindowTarget` in its `Context`
and marks that `Send`, and every `AppHandle`, window and webview handle clones
it on whatever thread it is on. That made the `Rc`'s count a data race. Under
load a lost count reached zero, so the runner, its event buffer and its handler
were freed while the event loop ran on them. Dev died within 2 minutes of many
agents opening tabs on a busy machine, as an access violation or as
`STATUS_HEAP_CORRUPTION` (`anbo-dev.exe` round 82; a dump showed the runner's
block free on the heap and a zeroed `Message` read from its freed buffer).

tao 0.37.2 still has the `Rc`. Drop this copy and the `[patch.crates-io]` entry
once tao shares the runner with an `Arc`, or tauri stops cloning it across
threads. To move to a newer tao before that, copy its release here and make the
same change; `scripts/check-native-patches.mjs` fails if the `Arc` goes missing.

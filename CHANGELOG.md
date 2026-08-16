# Changelog

## [0.16.0](https://github.com/mramdann/anbo-ai/compare/v0.15.1...v0.16.0) (2026-08-16)


### Features

* add directional pane swapping shortcuts ([#995](https://github.com/mramdann/anbo-ai/issues/995)) ([d6e3491](https://github.com/mramdann/anbo-ai/commit/d6e349191b47b479656ea314d70407cb398a1331))
* add preview tabs for git diffs ([40c4c89](https://github.com/mramdann/anbo-ai/commit/40c4c898523ab601b0104765734709c3f3d93fc2))
* **agents:** add Pi coding-agent notifications ([#1008](https://github.com/mramdann/anbo-ai/issues/1008)) ([7639523](https://github.com/mramdann/anbo-ai/commit/7639523c270d5e4d806be4c4ec15c71f4142d18a))
* **agents:** agent notifications and management ([#473](https://github.com/mramdann/anbo-ai/issues/473)) ([9da0d14](https://github.com/mramdann/anbo-ai/commit/9da0d14aae9b8bef80688d250e33b68f066ae7ab))
* **agents:** collapse the agent-alerts list behind a toggle ([332a0c2](https://github.com/mramdann/anbo-ai/commit/332a0c22d0cbd232d9860857a46634b824a2cf70))
* **agents:** detect agent state via OSC markers and install Claude Code hooks ([b021c07](https://github.com/mramdann/anbo-ai/commit/b021c0712eb24dc19c1939119c3080236d831a99))
* **agents:** keyboard shortcut to jump to agent needing attention ([68caf02](https://github.com/mramdann/anbo-ai/commit/68caf021895c2e6ea8865fa45d5f9152f0536332))
* **agents:** notification center with Sonner toasts and Terax agent integration ([21da75f](https://github.com/mramdann/anbo-ai/commit/21da75f3169590ad5332850d5b6c850d34c75d6a))
* **agents:** notification hooks for Codex and Gemini CLI ([89e399a](https://github.com/mramdann/anbo-ai/commit/89e399a48250f08a2aaf9a9356a7ab404aa4c0fc))
* **agents:** per-agent notification bell with clear action ([b23cd00](https://github.com/mramdann/anbo-ai/commit/b23cd0076a703e32e075c4156ac0e5daa385cf28))
* **ai:** /claude-code command to orchestrate agents via Terax AI ([9c9bac2](https://github.com/mramdann/anbo-ai/commit/9c9bac2466d5542bb4ae8d150b6c8c6128cf2e3e))
* **ai:** /claude-code command to orchestrate agents via Terax AI ([#489](https://github.com/mramdann/anbo-ai/issues/489)) ([d6dff57](https://github.com/mramdann/anbo-ai/commit/d6dff570e132e23ab4656d17e92063a2a68164e2))
* **ai:** add current frontier models ([9616cc8](https://github.com/mramdann/anbo-ai/commit/9616cc82d49f34da29bc5ea6a3db5bcdeefcbbbd))
* **ai:** add Grok 4.3, Grok Build 0.1, Claude Opus 4.8 and GPT-5.5 Pro ([9162109](https://github.com/mramdann/anbo-ai/commit/9162109e15c1fdd3e4d49bb288626597921fff4f))
* **ai:** add Groq and Whisper.cpp STT providers ([f24c90e](https://github.com/mramdann/anbo-ai/commit/f24c90e470af57cbc3a299b2ca589fbfa19b10f8)), closes [#548](https://github.com/mramdann/anbo-ai/issues/548)
* **ai:** add Mistral provider ([#355](https://github.com/mramdann/anbo-ai/issues/355)) ([dd92eff](https://github.com/mramdann/anbo-ai/commit/dd92eff7f95cb36c6f3fb3d3d25b7d705d2bf812))
* **ai:** add MLX as a local provider ([8958eca](https://github.com/mramdann/anbo-ai/commit/8958eca74502b803ba7d1062977b62436b1d822e))
* **ai:** add Ollama provider and local-model autocomplete ([7938432](https://github.com/mramdann/anbo-ai/commit/793843270cd83895f88a291d3b80ca075ce57ad8))
* **ai:** add shortcut to toggle AI chat mini window ([fe4e074](https://github.com/mramdann/anbo-ai/commit/fe4e074760a6176260d35e649cd9bd5bc0ac6cb5))
* **ai:** draggable and resizable AI mini window ([d95b76b](https://github.com/mramdann/anbo-ai/commit/d95b76ba0f0662bf1860c39ff5d55dea238e65cb))
* **ai:** free-form OpenRouter models, reasoning-aware history pruning, Gemini Flash models ([cd3e5be](https://github.com/mramdann/anbo-ai/commit/cd3e5beee77c4477cf6115ae444f8139af8218fc))
* **ai:** improve agents spawning logic and enhance snippet detection to include character type ([ba98115](https://github.com/mramdann/anbo-ai/commit/ba98115ba21b867b960ea9fd9e36790193ea66bb))
* **ai:** register native browser automation tools for Side-Panel AI Agent ([7f07890](https://github.com/mramdann/anbo-ai/commit/7f07890ea4552d919c58e961043f2856404e1db2))
* **ai:** support multiple OpenAI-compatible endpoints ([160dab4](https://github.com/mramdann/anbo-ai/commit/160dab404762443d63c5e29d5e7cade1bc5d5334))
* **autocomplete:** enable named openai-compatible endpoints ([a8b9481](https://github.com/mramdann/anbo-ai/commit/a8b948191f898576c78bd5b69f2a0d67c28ef61b))
* **blocks:** first-run watermark with shortcut hints ([b3000f2](https://github.com/mramdann/anbo-ai/commit/b3000f23372cb46af07c6c500368dab6d75285f4))
* **blocks:** toolbar actions dropdown, exit badge, block navigation ([cd2629d](https://github.com/mramdann/anbo-ai/commit/cd2629dab2493e521d3f43526b924bbaea810d54))
* **browser:** add workspace-scoped background automation ([87b6b07](https://github.com/mramdann/anbo-ai/commit/87b6b074a575c385b2975358c6bd9e87c41e5665))
* **browser:** AI driving pulse, tab loading indicator, favicon fallback ([6d4b7fc](https://github.com/mramdann/anbo-ai/commit/6d4b7fc39d6c054c984c8415e03901c1449ab504))
* **browser:** expose MCP over Streamable HTTP ([c872960](https://github.com/mramdann/anbo-ai/commit/c872960aa49584ecee464e921372888fa8622e0f))
* **browser:** zoom controls and AI mini-window punch-through ([bbd70ed](https://github.com/mramdann/anbo-ai/commit/bbd70ed5d16de81f38d96a7e22161e2cb0fe47f8))
* **bundle:** open files via the OS "Open With" action ([#980](https://github.com/mramdann/anbo-ai/issues/980)) ([b9d6039](https://github.com/mramdann/anbo-ai/commit/b9d60393f756de4f582895d9010e4467d11008a9))
* **bundle:** open multiple files via "Open With", add launch-parse tests ([a2c8329](https://github.com/mramdann/anbo-ai/commit/a2c8329662ade6fef8c1e11f7353a7231256937d))
* **command-palette:** fuzzy command launcher with content and history search ([3d8628d](https://github.com/mramdann/anbo-ai/commit/3d8628dc116b429e2e0c002ab8d7364a9fb30301))
* **command-palette:** fuzzy command launcher with content and history search ([#744](https://github.com/mramdann/anbo-ai/issues/744)) ([93cc029](https://github.com/mramdann/anbo-ai/commit/93cc029a53d1dc22b1091f561cf91c95dc2c6e90))
* **dnd:** pointer-based drag-and-drop foundation ([a81d3e0](https://github.com/mramdann/anbo-ai/commit/a81d3e06298d94822d7815d93b9e9ae626d8fde5))
* **editor:** add dotenv syntax highlighting ([ae9e690](https://github.com/mramdann/anbo-ai/commit/ae9e690bf68a919796a2501eb62c924566639ded))
* **editor:** add independent font sizing ([e63ca2f](https://github.com/mramdann/anbo-ai/commit/e63ca2fd53775359a2021cced6a6a32fd926db26))
* **editor:** add per-tab language override via icon dropdown ([#864](https://github.com/mramdann/anbo-ai/issues/864)) ([d77476e](https://github.com/mramdann/anbo-ai/commit/d77476e762b8ade438c643061723b9f494213600))
* **editor:** add Ruby syntax highlighting ([#294](https://github.com/mramdann/anbo-ai/issues/294)) ([ca8baa0](https://github.com/mramdann/anbo-ai/commit/ca8baa0fa7d8472c339cf8176c6aa38a5d85b941))
* **editor:** add sql (all dialects) and jsonc/json5 highlighting via legacy-modes ([ee1c9bb](https://github.com/mramdann/anbo-ai/commit/ee1c9bb5188b4c8cda40bb3301e9b9385debce28))
* **editor:** add Twig language support using html language mode ([5dc034d](https://github.com/mramdann/anbo-ai/commit/5dc034d5e4d994fb5ae4a07c5fc20153b5552908))
* **editor:** add Vue (.vue) syntax highlighting ([90aeab5](https://github.com/mramdann/anbo-ai/commit/90aeab53f85c645d065d09e82953642078ab27f8))
* **editor:** add word wrap toggle to editor settings ([8043cfa](https://github.com/mramdann/anbo-ai/commit/8043cfa106f7de9ee182b3dbd051e35cd2f1b273))
* **editor:** biome and prettier formatters with cursor-preserving format on save ([a25fb40](https://github.com/mramdann/anbo-ai/commit/a25fb4084c0a3b170f69b0ba6d2e8de922c0e383))
* **editor:** completion kind icons, themed lsp chrome and rounded vim cursor ([2219adb](https://github.com/mramdann/anbo-ai/commit/2219adb4b860845c4f8a26a40d50a65416447804))
* **editor:** find and replace panel, goto line, indent detection, large file open, formatter registry ([6980581](https://github.com/mramdann/anbo-ai/commit/6980581abfd590eeb3ebe68dac3d96dc148dcb99))
* **editor:** goto-line handle and live theme preview ([a672dce](https://github.com/mramdann/anbo-ai/commit/a672dce7ff5c7106a6ac3d0ac21fa6f5cbd329bc))
* **editor:** implement editor auto save with configurable delay ([#545](https://github.com/mramdann/anbo-ai/issues/545)) ([9219585](https://github.com/mramdann/anbo-ai/commit/92195858b9b4c71aa4767a9a7ec224e035bbaf72))
* **editor:** improve AI autocomplete placement, quality and trigger controls ([7b1fae6](https://github.com/mramdann/anbo-ai/commit/7b1fae64612b6f69b8d73175a9b7ac9afe51ce78))
* **editor:** inline image, audio, video and PDF preview ([#314](https://github.com/mramdann/anbo-ai/issues/314)) ([4d2e92d](https://github.com/mramdann/anbo-ai/commit/4d2e92da328ca06089b0fd621371d18c87ec0f1a))
* **editor:** LaTeX (.tex) syntax highlighting ([#482](https://github.com/mramdann/anbo-ai/issues/482)) ([56f1724](https://github.com/mramdann/anbo-ai/commit/56f1724a6f21e40813c385de083181d638bfb5a9))
* **editor:** markdown notes with GFM, fenced code highlighting and clickable tasks ([786ceb5](https://github.com/mramdann/anbo-ai/commit/786ceb5081c23bf2ee26ecf0df4305d7b110da42))
* **editor:** swift syntax highlighting in codemirror ([012b088](https://github.com/mramdann/anbo-ai/commit/012b0889e62d84bedca119687bc4cf4ae1fbdd57))
* **editor:** syntax highlighting for more formats and all Dockerfile variants ([b7eb8d6](https://github.com/mramdann/anbo-ai/commit/b7eb8d6240e8de245d54f44e131980296d37a329))
* **editor:** syntax highlighting for svelte files ([1fdbc50](https://github.com/mramdann/anbo-ai/commit/1fdbc50e53b3ac53db3ba80057805a2d54258545))
* **explorer:** accept files dropped from the OS ([82f6697](https://github.com/mramdann/anbo-ai/commit/82f66972845d0bc62fec436e2c43f2a0035c0f1b))
* **explorer:** add markdown preview tab via right-click 'Open Preview' ([#350](https://github.com/mramdann/anbo-ai/issues/350)) ([bb00567](https://github.com/mramdann/anbo-ai/commit/bb00567a8d1ecf46bbc15333bd271735179076be))
* **explorer:** drag and drop to move files ([cc8aba4](https://github.com/mramdann/anbo-ai/commit/cc8aba48bbb1a201949206db23ddb1924e8c31b5))
* **explorer:** git status decorations ([564d1ec](https://github.com/mramdann/anbo-ai/commit/564d1ecc069abddf12a7cf2688d088f9feeabbba))
* **fs:** async file commands with mtime, forced reads and symlink-aware stat ([40a8ef2](https://github.com/mramdann/anbo-ai/commit/40a8ef28d66f135446ba7d036c6dcacfc0376905))
* **fs:** cancellable interactive grep and fuzzy file ranking ([5411363](https://github.com/mramdann/anbo-ai/commit/54113638502df7378f2d3266343b66b6cf6783a3))
* **fs:** live filesystem watcher for explorer tree and open editors ([#488](https://github.com/mramdann/anbo-ai/issues/488)) ([1c8b885](https://github.com/mramdann/anbo-ai/commit/1c8b88531cfcaff80259550fcb093be8e0e59eec))
* **fs:** natural (numeric-aware) sort for the file tree ([#1079](https://github.com/mramdann/anbo-ai/issues/1079)) ([9f329a2](https://github.com/mramdann/anbo-ai/commit/9f329a27267d2d0e23f5ad74bc8da5b621384c8e))
* harden agent and browser workspace lifecycle ([378c5b6](https://github.com/mramdann/anbo-ai/commit/378c5b6eaa828f43a2257535790b40c776ec4ec9))
* **header:** command-button hover and divider cleanup ([731da51](https://github.com/mramdann/anbo-ai/commit/731da5132db5c64ef4480d766a2f50f93f736cf5))
* improve agent identity and startup recovery ([d340856](https://github.com/mramdann/anbo-ai/commit/d340856f95b0e3707b62adfa2c3a9756fee0c9d3))
* improve empty workspace launcher ([#12](https://github.com/mramdann/anbo-ai/issues/12)) ([2a8bcb8](https://github.com/mramdann/anbo-ai/commit/2a8bcb827daee43ec8b2fc9abf6f4501fdc3bb5f))
* launch coding agents in split panes ([c1ec0e6](https://github.com/mramdann/anbo-ai/commit/c1ec0e60d8d8b66410bca099c59986a97a40c377))
* **lsp:** cmd-hover link affordance, hover code highlighting and statusbar polish ([e874b39](https://github.com/mramdann/anbo-ai/commit/e874b3996f3ea25cb4473881be5ee76bab60b9ff))
* **lsp:** editor chrome, diagnostics counts and status pill states ([1ddf798](https://github.com/mramdann/anbo-ai/commit/1ddf798652a6c1d4b8e31c8e4ade14cfa6b7cff2))
* **lsp:** find references picker, ruff preset, activation-aware server choice ([42b51e7](https://github.com/mramdann/anbo-ai/commit/42b51e76d19a46d8016a8f42f57232966bdecbd1))
* **lsp:** frontend client, session manager and editor integration ([08d83e3](https://github.com/mramdann/anbo-ai/commit/08d83e3e70efa62c846a658dc891ad33bec94def))
* **lsp:** presets for 13 more languages ([3791846](https://github.com/mramdann/anbo-ai/commit/3791846b8283599ad8e6fefcc00c2b8d8f59d171))
* **lsp:** process-group kill, memory watchdog and exit cleanup ([033b7aa](https://github.com/mramdann/anbo-ai/commit/033b7aa3bd644ee01eeef938ed3d9ec5bf6d3d0c))
* **lsp:** resource-bounded sessions, cross-file navigation and formatting ([d401f3b](https://github.com/mramdann/anbo-ai/commit/d401f3b50eb4d16e2da1c5bd95578ccf8742f7e8))
* **lsp:** rust language server process host ([3c3ded3](https://github.com/mramdann/anbo-ai/commit/3c3ded35792c1bb6aaacddd0092f7ccf49e7604b))
* **lsp:** statusbar opt-in pill and settings section ([aa43406](https://github.com/mramdann/anbo-ai/commit/aa4340627c596948cc04527580c73d49fbdb7df9))
* **macos:** camera and microphone permissions for in-terminal programs ([#737](https://github.com/mramdann/anbo-ai/issues/737)) ([f80b70c](https://github.com/mramdann/anbo-ai/commit/f80b70c7a91bfdb61bdea20717e134f1b85c55c7))
* **markdown:** open rendered by default with raw toggle ([66f77c4](https://github.com/mramdann/anbo-ai/commit/66f77c47716eac0db0f8de5d534e016a3543c31c))
* **motion:** panel-swap and tab-enter keyframes ([88ec0bc](https://github.com/mramdann/anbo-ai/commit/88ec0bc99b2d32c13f6063363e24684b7f2707d0))
* **motion:** shared duration and easing tokens ([5a9f56f](https://github.com/mramdann/anbo-ai/commit/5a9f56f3a1f3f610991df6a5c63489a650b3474d))
* **motion:** UI transition polish across tabs, panels, header and sidebar ([#769](https://github.com/mramdann/anbo-ai/issues/769)) ([21e5ab7](https://github.com/mramdann/anbo-ai/commit/21e5ab732ace2624285bc2300cbd456dfdce0267))
* prototype browser automation bridge ([3547656](https://github.com/mramdann/anbo-ai/commit/3547656b349284ec0a6130543219a1e383175135))
* **pty:** block-mode env flag and minimal prompt ([68b8fed](https://github.com/mramdann/anbo-ai/commit/68b8fed0d8335cbe1196824910588e9d7a57aa85))
* **pty:** shell history index and block-mode shell integration ([014b962](https://github.com/mramdann/anbo-ai/commit/014b962ea9bbed034654ed336fefadee805802cc))
* resume terminal agent sessions ([6d941a8](https://github.com/mramdann/anbo-ai/commit/6d941a8e02263a0a71939016b731fc14b91d240a))
* **settings:** add configurable context limit for OpenAI-compatible … ([#370](https://github.com/mramdann/anbo-ai/issues/370)) ([69f00a5](https://github.com/mramdann/anbo-ai/commit/69f00a554bdbd3452b3e84148a32fd0ac19a5ef1))
* **settings:** dedicated editor tab ([653dd15](https://github.com/mramdann/anbo-ai/commit/653dd15c4f4dc57366769a09d02b47bf95afe93e))
* **settings:** guide LSP installation ([fa68ae3](https://github.com/mramdann/anbo-ai/commit/fa68ae37d5f5c389983622c79265f0b911b1bdc1))
* **shortcuts:** add command palette ([#109](https://github.com/mramdann/anbo-ai/issues/109)) ([5f853f8](https://github.com/mramdann/anbo-ai/commit/5f853f89e47634d5804d25d594d9b23df185cdaa))
* **sidebar:** animate explorer/source-control panel swap ([6ebb6b8](https://github.com/mramdann/anbo-ai/commit/6ebb6b8cfa903be611ef591bbad3e87e39aae13c))
* **sidebar:** persist collapsed state across sessions ([#903](https://github.com/mramdann/anbo-ai/issues/903)) ([3f4d680](https://github.com/mramdann/anbo-ai/commit/3f4d6803e90ca4a98bfb1fd8508e76d64963c57b))
* **sidebar:** smooth cross-fade on rail view switch ([a12377b](https://github.com/mramdann/anbo-ai/commit/a12377bf3bc2b2859a2d03b29a8b2911beae73a2))
* **source-control:** add right-click context menu on changed files ([#547](https://github.com/mramdann/anbo-ai/issues/547)) ([12fe8ed](https://github.com/mramdann/anbo-ai/commit/12fe8eddc92c8e521e1d850f7d2789e18f8c77bc))
* **source-control:** checkout branches in UI ([#866](https://github.com/mramdann/anbo-ai/issues/866)) ([bba1b5f](https://github.com/mramdann/anbo-ai/commit/bba1b5f340634188161bf28ef0b04b3173888419))
* **source-control:** git panel, history, lazy UI, perf and security pass ([d4abe40](https://github.com/mramdann/anbo-ai/commit/d4abe401d30291d5800a26b039f4e1a174782853))
* **spaces:** cleaner switcher trigger ([a908282](https://github.com/mramdann/anbo-ai/commit/a908282263316e4260287461ced332d67bf7312b))
* **spaces:** persisted spaces store with boot restore ([acd1b15](https://github.com/mramdann/anbo-ai/commit/acd1b157052297721aab6bedf66f9bc2da0b19a9))
* **spaces:** refine switcher dot with accent halo ([1f20fca](https://github.com/mramdann/anbo-ai/commit/1f20fca7edc1fb1a418be49d4ff8cfcfe51db48a))
* **spaces:** switcher and drag-to-organize manager ([3eeabc3](https://github.com/mramdann/anbo-ai/commit/3eeabc3c844d50536834fe4e756bb26a4310b38c))
* **tabs:** close tab on middle mouse button click ([#484](https://github.com/mramdann/anbo-ai/issues/484)) ([77c2fae](https://github.com/mramdann/anbo-ai/commit/77c2fae4a00ab4dba581ac0b102496b9dc44f2d2))
* **tabs:** cmd+shift+t blocks tab, focus input on open ([a9493ec](https://github.com/mramdann/anbo-ai/commit/a9493ecf62cbdc440b4da76416be14a9de05aae7))
* **tabs:** Ctrl+Tab MRU switcher, fix space-delete PTY leak ([c3e7269](https://github.com/mramdann/anbo-ai/commit/c3e72694ca82f73fa7d92f91031cfae973d68007))
* **tabs:** drag-to-reorder tabs via pointer events ([9f256cc](https://github.com/mramdann/anbo-ai/commit/9f256cce115c0d641d3fcd0ae83820ae68221666))
* **tabs:** enter animation and raised active pill ([bb155d2](https://github.com/mramdann/anbo-ai/commit/bb155d2798904890b96fa604b7637ee4663b28a2))
* **tabs:** rename terminal tabs via right-click ([#521](https://github.com/mramdann/anbo-ai/issues/521)) ([6287e16](https://github.com/mramdann/anbo-ai/commit/6287e167118d8866274f52eeb65d46631529245b))
* **tabs:** scope tabs to spaces with lazy cold restore ([98e07a4](https://github.com/mramdann/anbo-ai/commit/98e07a4ccbcd57e627c3d2e7d3fe88d4691278f4))
* **tabs:** show terminal agent status on tabs ([#976](https://github.com/mramdann/anbo-ai/issues/976)) ([3e9f374](https://github.com/mramdann/anbo-ai/commit/3e9f37453bb43b6b38429f11d4a93dbc3fdf904a))
* **tabs:** sliding active indicator ([fd814ff](https://github.com/mramdann/anbo-ai/commit/fd814ff9548a62664580367af9b27bd6950ebca1))
* **terminal:** add configurable font family setting ([#374](https://github.com/mramdann/anbo-ai/issues/374)) ([06ab145](https://github.com/mramdann/anbo-ai/commit/06ab145f6efa6cda190357d06131c9bb5f8acf6f)), closes [#373](https://github.com/mramdann/anbo-ai/issues/373)
* **terminal:** add cursor style setting ([4e2f7f7](https://github.com/mramdann/anbo-ai/commit/4e2f7f7fa0f53078d926be5591cad99fd0b74bd5))
* **terminal:** add font weight setting ([9fc0425](https://github.com/mramdann/anbo-ai/commit/9fc0425654f24a5ed31352c6d65e05ab12b72360))
* **terminal:** add OSC 52 clipboard handler ([0c647c4](https://github.com/mramdann/anbo-ai/commit/0c647c4a4788d92c98ea3c675a54fcdc8f8f65de))
* **terminal:** block command decorations and shell editor ([ac0f150](https://github.com/mramdann/anbo-ai/commit/ac0f150f646e7d2ce2c4d3ec7b904186d6c3d02b))
* **terminal:** block-mode terminal (Warp-style command blocks) ([#726](https://github.com/mramdann/anbo-ai/issues/726)) ([5204719](https://github.com/mramdann/anbo-ai/commit/520471988cb656a18ea9b69d2b559e35199eb244))
* **terminal:** block-mode terminal tab via the renderer pool ([d57e947](https://github.com/mramdann/anbo-ai/commit/d57e947a6fe1f12d413d52aa252e099d3c02c860))
* **terminal:** bracketed-paste dropped paths, quote only when needed ([#645](https://github.com/mramdann/anbo-ai/issues/645)) ([8a58568](https://github.com/mramdann/anbo-ai/commit/8a585685d47fefc74f371c3f58aee60967380507))
* **terminal:** clear scrollback with Cmd+K ([#522](https://github.com/mramdann/anbo-ai/issues/522)) ([fda82fb](https://github.com/mramdann/anbo-ai/commit/fda82fb5521db7400cfdf2d932ce4c80ec695be9))
* **terminal:** command-block decorations and input bar ([f129c6c](https://github.com/mramdann/anbo-ai/commit/f129c6c8e10aeb352a1bcf2794ae9d91757bb64e))
* **terminal:** confirm before closing a tab with a running process ([#648](https://github.com/mramdann/anbo-ai/issues/648)) ([21898b5](https://github.com/mramdann/anbo-ai/commit/21898b558e15035230b0ef3fd12d9f1a07ceaf89))
* **terminal:** confirm before closing tab with a running process ([d953667](https://github.com/mramdann/anbo-ai/commit/d95366779ee444de38db6cfa787629dc1aa9e6db))
* **terminal:** drag explorer paths into terminal ([#1038](https://github.com/mramdann/anbo-ai/issues/1038)) ([2e86730](https://github.com/mramdann/anbo-ai/commit/2e86730ae1edcc108f7375eb4bc926d918eb447f))
* **terminal:** drop overlay and DPI-correct hit detection ([#656](https://github.com/mramdann/anbo-ai/issues/656)) ([e5c5f72](https://github.com/mramdann/anbo-ai/commit/e5c5f72ce57781483ef8fc771b044422c2278fa7))
* **terminal:** insert dropped file paths into the active terminal pane ([#491](https://github.com/mramdann/anbo-ai/issues/491)) ([ae91820](https://github.com/mramdann/anbo-ai/commit/ae91820c65989fb086882c5411fe0abf57d6f263))
* **terminal:** macOS line/word readline bindings (Cmd+Arrow, Cmd/Opt+Backspace) ([2786cee](https://github.com/mramdann/anbo-ai/commit/2786cee11cfd84701a2ace9917142a76be959675))
* **terminal:** macOS line/word readline bindings (Cmd+Arrow, Cmd/Opt+Backspace) ([#493](https://github.com/mramdann/anbo-ai/issues/493)) ([9881aef](https://github.com/mramdann/anbo-ai/commit/9881aefd04a359d023565c51e943d00a3c492e45))
* **terminal:** unified shell/AI input bar ([d136348](https://github.com/mramdann/anbo-ai/commit/d136348cacbe514f9acab65824b98aade397269a))
* **terminal:** user-selectable default shell ([a770307](https://github.com/mramdann/anbo-ai/commit/a7703073baac2ca2e27f02cb30c08a7d9a9c34c7))
* **terminal:** Windows support for running-process close guard, simplify check ([2cf5db2](https://github.com/mramdann/anbo-ai/commit/2cf5db2e855c8587ca899045cdf9063e98972270))
* **terminal:** zsh Option+Right stops at word-end, matching Warp/iTerm2 ([#494](https://github.com/mramdann/anbo-ai/issues/494)) ([cb3410e](https://github.com/mramdann/anbo-ai/commit/cb3410e93feadeb9a781d3d4397bf14ded2ecf57))
* **theme:** add standalone editor theme picker and more themes ([35f8711](https://github.com/mramdann/anbo-ai/commit/35f87119f877e2c15e92fcab5b541c224fe68ab9))
* **themes:** custom themes, presets and background image ([1e1bd69](https://github.com/mramdann/anbo-ai/commit/1e1bd690224f7a21e49be6508b9f20b6acec6113))
* **themes:** editor-based custom themes, presets, terminal palette; fix text selection + linux copy/paste ([6d2d1f4](https://github.com/mramdann/anbo-ai/commit/6d2d1f46dd6475ad0d7185b4a80b06f99ef53571))
* **theme:** support terminal font overrides ([#1011](https://github.com/mramdann/anbo-ai/issues/1011)) ([89c65f0](https://github.com/mramdann/anbo-ai/commit/89c65f05411200c5e783c20fed7d742c1fe38312))
* transform workspace into Anbo ([12f01e0](https://github.com/mramdann/anbo-ai/commit/12f01e07447243051be08f26542407efe4a245b1))
* **ui:** redesign Models settings tab and fix model picker scroll ([a516a4f](https://github.com/mramdann/anbo-ai/commit/a516a4f0172e83167543f6b72928d80ada931fac))
* **ui:** redesign sidebar, source control and git graph ([31c9a79](https://github.com/mramdann/anbo-ai/commit/31c9a7973f0410abd62d889c4cbec0a62bd0d925))
* **view:** zen mode to hide header and status bar ([#654](https://github.com/mramdann/anbo-ai/issues/654)) ([593fed5](https://github.com/mramdann/anbo-ai/commit/593fed55dc1a05234bbf0a127231f91cc2f2c17f))
* **window:** confirm quit while a terminal process is running ([d782f7d](https://github.com/mramdann/anbo-ai/commit/d782f7d2e15d18e20daf137ffacb4097b98fa9b4))
* **window:** dynamic title from project folder + active terminal ([#612](https://github.com/mramdann/anbo-ai/issues/612)) ([e694580](https://github.com/mramdann/anbo-ai/commit/e694580235b8730a4faa5a3f9bc7455236559304))
* **windows:** add 'Open in Terax' shell integration ([#265](https://github.com/mramdann/anbo-ai/issues/265)) ([4f5dbe4](https://github.com/mramdann/anbo-ai/commit/4f5dbe452ae193f0aa152f421b8dccd2a322f11a))
* **workspace:** default environment for new spaces ([#869](https://github.com/mramdann/anbo-ai/issues/869)) ([3d1ba19](https://github.com/mramdann/anbo-ai/commit/3d1ba192c06bafcfff5a285e3896c9101bd3185f))


### Bug Fixes

* add missing ModelId import in AiMiniWindow ([df331ae](https://github.com/mramdann/anbo-ai/commit/df331ae1814d804aecfa719e531a311fb997508b))
* **agents:** harden self-arm and polish notification UX ([ef55e36](https://github.com/mramdann/anbo-ai/commit/ef55e36a38aec2f7ba3c791c8e5ed2b5d06927a2))
* **agents:** satisfy clippy collapsible_match in OSC detector ([ac7385c](https://github.com/mramdann/anbo-ai/commit/ac7385c28a27ae842eee3cd7d67f4cbe2df9c979))
* **ai:** add reasoning tag to deepseek-v4-flash ([#546](https://github.com/mramdann/anbo-ai/issues/546)) ([3ec57ac](https://github.com/mramdann/anbo-ai/commit/3ec57aced1fd1e2c3e0a407ffa4e9c78cce12b6a))
* **ai:** block rm -rf on ${HOME} and home subpaths in shell guard ([f66824b](https://github.com/mramdann/anbo-ai/commit/f66824b6651b0d271549f3d5caae801a7268659f))
* **ai:** enforce final context budgets ([60ad481](https://github.com/mramdann/anbo-ai/commit/60ad481a382cb5924487df33af653a7a63c76178))
* **ai:** freeze run scope and propagate cancellation ([910220c](https://github.com/mramdann/anbo-ai/commit/910220c151172b274a69f05c1d76d6ff1498fda9))
* **ai:** implement responsive scrollable todo list in mini-window ([#353](https://github.com/mramdann/anbo-ai/issues/353)) ([60df490](https://github.com/mramdann/anbo-ai/commit/60df490e39373555531ce008473623aaddcbc241))
* **ai:** only show Ask Terax popup when clicking inside terminal or editor ([#468](https://github.com/mramdann/anbo-ai/issues/468)) ([83afd75](https://github.com/mramdann/anbo-ai/commit/83afd7563fa2be2f7d9926518366fce6133569d4))
* **ai:** retain latest bounded turn ([fd52116](https://github.com/mramdann/anbo-ai/commit/fd52116519446b6750d0205a5422e7860d7cc0f6))
* **ai:** route status-bar AI button through the key-aware toggle ([5c2f4cd](https://github.com/mramdann/anbo-ai/commit/5c2f4cdc1290b390db067a832ede9bedf35085a7))
* **ai:** strip reasoning blocks from history before sending to LLM ([674187e](https://github.com/mramdann/anbo-ai/commit/674187e2e086e21f65cc497925b6f401c54225cb))
* **ai:** surface provider errors safely ([882641e](https://github.com/mramdann/anbo-ai/commit/882641e8a6627e18e1911de5ca44465728977c50))
* **blocks:** copy grid selection and restore input focus at the prompt ([cd3c85c](https://github.com/mramdann/anbo-ai/commit/cd3c85c78a064d703d7cecba77d25c09fb6cfe3e))
* **blocks:** hand fish osc 133 to one source, drop the greeting ([9fa9b6c](https://github.com/mramdann/anbo-ai/commit/9fa9b6c8d7108d788610131e327ba8e5249f45b3))
* **blocks:** re-assert fish prompt after config.fish, suppress greeting on all terax fish ([87caadc](https://github.com/mramdann/anbo-ai/commit/87caadcdf40c3da535d963403b546f15b1750bb3))
* **blocks:** shell integration for pwsh, bash and fish ([f254cd2](https://github.com/mramdann/anbo-ai/commit/f254cd21e24bfb4e8407b75e0cb831124e09ab39))
* **breadcrumb:** horizontal scroll to prevent path overflow ([6963d82](https://github.com/mramdann/anbo-ai/commit/6963d82785bdbadbb5f565eda18fa589e56fa920))
* **browser:** clear stale URL validation state ([b1d633d](https://github.com/mramdann/anbo-ai/commit/b1d633d96bcf6e7530718146a0b8b389992a01c6))
* **browser:** eliminate tab switching flicker ([39a384b](https://github.com/mramdann/anbo-ai/commit/39a384b048a67e02654e5eceb66f38db3bf38f7a))
* **browser:** harden parallel automation lifecycle ([c7315cc](https://github.com/mramdann/anbo-ai/commit/c7315cc271e91060155b86035860224f6f16979e))
* **browser:** isolate automation target from UI focus and scope per workspace ([52e5cf4](https://github.com/mramdann/anbo-ai/commit/52e5cf47d2f191134e68c9b2691e27df3ae8c4a0))
* **browser:** preserve foreground z order under overlays ([f6e522a](https://github.com/mramdann/anbo-ai/commit/f6e522a1aa14fabe7a5500b7968e09907101ef0e))
* **browser:** resilient automation, readiness gates, opaque webview bg ([7788dde](https://github.com/mramdann/anbo-ai/commit/7788dde2c6ad4a8e68bc95921c198ec217a15dad))
* **build:** capture editor dependencies atomically ([d8196a9](https://github.com/mramdann/anbo-ai/commit/d8196a9547a0449a3f0f2ebfabaa072e014155e4))
* **build:** isolate codemirror runtime ([1565d0e](https://github.com/mramdann/anbo-ai/commit/1565d0e44d337919635a8ab9f622a541d93d31ea))
* **ci:** auto-sync Cargo.lock in check-version instead of failing ([99879d9](https://github.com/mramdann/anbo-ai/commit/99879d9f897663bf081abe9f6c4b3a3a1a2d6ec5))
* **ci:** bootstrap browser sidecar validation ([949cd5f](https://github.com/mramdann/anbo-ai/commit/949cd5f2dd74b9e20a317775a5e0c14c625102bc))
* **ci:** compile browser automation on Unix ([8897555](https://github.com/mramdann/anbo-ai/commit/8897555482329b0c893790b19552bbec06a6bf4d))
* **ci:** preserve release OIDC permission ([6ba43ad](https://github.com/mramdann/anbo-ai/commit/6ba43ad504cde60492e945c35de152afc732b208))
* **ci:** scope browser sidecar to Windows ([e48ea1a](https://github.com/mramdann/anbo-ai/commit/e48ea1a3ae0cdb7c0b729f041dbedfcda82042cf))
* **ci:** strip bundled wayland libs from appimage to fix egl crash on newer mesa ([99adfc8](https://github.com/mramdann/anbo-ai/commit/99adfc855e307a960c14d3e26445583d0adc6ca2))
* **editor:** anchor webview layout styles ([6b53390](https://github.com/mramdann/anbo-ai/commit/6b53390f9eb394203b372b0561cbdfdbe4870d00))
* **editor:** auto-reload files when AI modifies them ([#362](https://github.com/mramdann/anbo-ai/issues/362)) ([0cd7673](https://github.com/mramdann/anbo-ai/commit/0cd7673e89b264ee6ce5c1c88acdc9abef2471e1))
* **editor:** close save/reload races, formatter mtime, lsp format style and preset rebinding ([85a5653](https://github.com/mramdann/anbo-ai/commit/85a5653cdc6843e70ec364e5df27382a19eeefa1))
* **editor:** co-locate lsp facets ([858285a](https://github.com/mramdann/anbo-ai/commit/858285abc8cef7cadb26df7270ab7b445e9f55e8))
* **editor:** correct cursor positioning on macOS when zoom is not 100% ([#764](https://github.com/mramdann/anbo-ai/issues/764)) ([7b82ffd](https://github.com/mramdann/anbo-ai/commit/7b82ffda46d34f8b768081016aeaaff9e1ac7288))
* **editor:** drop duplicate vue and swift language loaders ([b656fe3](https://github.com/mramdann/anbo-ai/commit/b656fe3816d0ddaefb17e7acff5e16889f6e939a))
* **editor:** freeze shared extension singletons and reuse autosave clamp ([1fd11b0](https://github.com/mramdann/anbo-ai/commit/1fd11b0a6f8b41ab808cd541eed815000632e501))
* **editor:** keep runtime chunk atomic ([556d251](https://github.com/mramdann/anbo-ai/commit/556d2519f1361ead7e823d0b27ea00b417261d41))
* **editor:** preserve line endings, detect save conflicts, block quit on unsaved changes ([662dbbb](https://github.com/mramdann/anbo-ai/commit/662dbbbc3312e44f2b32f52cf91842e1392c4589))
* **editor:** preserve production layout ([1b195d5](https://github.com/mramdann/anbo-ai/commit/1b195d5e1f551cd859123257a8b55199368eba85))
* **editor:** preserve production theme styling ([8d42f88](https://github.com/mramdann/anbo-ai/commit/8d42f88a77a274427cf2ec64c4295bec289b0744))
* **editor:** reapply language on document ready to keep preview-tab highlighting ([#753](https://github.com/mramdann/anbo-ai/issues/753)) ([7aa26fb](https://github.com/mramdann/anbo-ai/commit/7aa26fb4a7c75845fa6588aff5708af5118f9c30))
* **editor:** refine Kanagawa JSX colors ([7649926](https://github.com/mramdann/anbo-ai/commit/764992679d89915d3c80bd05923bb503b62bf3ae))
* **editor:** resolve diff pane language before CodeMirror mounts ([9ec7328](https://github.com/mramdann/anbo-ai/commit/9ec7328f96ea46e83ba184583a36d7698233de4f))
* **editor:** restore bounded text selection ([573acbc](https://github.com/mramdann/anbo-ai/commit/573acbc0489f27c6d4887a17817db3a896879e6a))
* **editor:** set the original file's permissions into the renamed tmp… ([#402](https://github.com/mramdann/anbo-ai/issues/402)) ([29d603c](https://github.com/mramdann/anbo-ai/commit/29d603ca34c5a0eda8b4445d58804d2c34bb07b5))
* **editor:** stabilize production runtime chunks ([2196405](https://github.com/mramdann/anbo-ai/commit/219640532cfe563488a880c1cae45ebcaa7ef626))
* **explorer:** close context menu after deleting an item ([7baee7c](https://github.com/mramdann/anbo-ai/commit/7baee7ccb8b0a299e23ba2c07ce6a887605bfa97))
* **explorer:** empty file tree on rapid root change ([#822](https://github.com/mramdann/anbo-ai/issues/822)) ([2930d8e](https://github.com/mramdann/anbo-ai/commit/2930d8e0cbb6fcc079a062d446f00b5b5a3d46d2))
* **explorer:** highlight active file ([#622](https://github.com/mramdann/anbo-ai/issues/622)) ([aa5e0e4](https://github.com/mramdann/anbo-ai/commit/aa5e0e439edd2eab314713a44cafa357dccab999))
* **explorer:** keep file tree static across InlineInput open/cancel cycles ([#123](https://github.com/mramdann/anbo-ai/issues/123)) ([#337](https://github.com/mramdann/anbo-ai/issues/337)) ([6b53098](https://github.com/mramdann/anbo-ai/commit/6b530983c895260106285347aa127287af1f11c2))
* **explorer:** preserve sidebar width across window resize ([#1082](https://github.com/mramdann/anbo-ai/issues/1082)) ([c1744ff](https://github.com/mramdann/anbo-ai/commit/c1744fffd76cabc2ec1ebc9410b05355b14e4899))
* **explorer:** prevent sidebar scroll bleed on long search results ([#1015](https://github.com/mramdann/anbo-ai/issues/1015)) ([7037d55](https://github.com/mramdann/anbo-ai/commit/7037d55f12b3f423c61fb0ae646d925cb046d79a))
* **fs:** skip gitignore walk outside a repo, avoids macOS folder prompts ([5a7a71f](https://github.com/mramdann/anbo-ai/commit/5a7a71f67a82796537df0794ea7219ff16c26e95))
* **fs:** use O_EXCL random tempfile for atomic writes ([e93a736](https://github.com/mramdann/anbo-ai/commit/e93a7364f647be72ab429b4dd6eb63af09c65aa1))
* **git:** resolve_repo falls back to symbolic-ref on unborn HEAD ([4e8363a](https://github.com/mramdann/anbo-ai/commit/4e8363a32a4bed7076293ff39c1cc2cf2fe8bd7c))
* **git:** stage paths whose parent directory was deleted ([0eac4a6](https://github.com/mramdann/anbo-ai/commit/0eac4a6be845302b5eb5264b4690f92edad73dac))
* harden agent integrations and session resume ([8b9e7d6](https://github.com/mramdann/anbo-ai/commit/8b9e7d63adb7576bc90f6b68e3ab1fa8940613b1))
* **lifecycle:** terminate managed process trees ([b2f7898](https://github.com/mramdann/anbo-ai/commit/b2f7898b7c9341efaba398afde7b4a2b80d2f23a))
* limit parallel OpenCode agents ([2bf1841](https://github.com/mramdann/anbo-ai/commit/2bf1841a0d00605126dfa6c318144c5a110e80c2))
* **linux:** strip AppImage env and mount cwd from spawned shells ([75fb139](https://github.com/mramdann/anbo-ai/commit/75fb139af34e32ebe83d11184c3985c6dd8bf555))
* load endpoint keys after preferences hydrate on startup ([e8d04e8](https://github.com/mramdann/anbo-ai/commit/e8d04e89b9d43ec1b6ee3d8cc47e99545549b338))
* **lsp:** age-guard idle eviction against concurrent multi-root opens ([fef9f22](https://github.com/mramdann/anbo-ai/commit/fef9f22c6bb7cf3b9100d666f7722c7098491c51))
* **macos:** correct microphone entitlement to audio-input ([ed6900f](https://github.com/mramdann/anbo-ai/commit/ed6900f679c307638fbfa5a013bdbf04955a93c0))
* **macos:** disable press-and-hold character popup ([2e93b11](https://github.com/mramdann/anbo-ai/commit/2e93b11be3d059dbb5af1fc0f743a42998a51884))
* make settings window resizable and increase default size ([#416](https://github.com/mramdann/anbo-ai/issues/416)) ([1c1cb6f](https://github.com/mramdann/anbo-ai/commit/1c1cb6fd3a92f7dd4d74f3cdd652613d3d8ec078))
* **markdown:** bound and harden previews ([dc040dd](https://github.com/mramdann/anbo-ai/commit/dc040dd80fed9db71eafdc820d2afa451ff4029c))
* **markdown:** preserve HTML-wrapped code block text ([#887](https://github.com/mramdann/anbo-ai/issues/887)) ([c0a51d5](https://github.com/mramdann/anbo-ai/commit/c0a51d54ce2924fe6e51a3b44c396f413d75964f))
* **markdown:** render file previews statically ([#913](https://github.com/mramdann/anbo-ai/issues/913)) ([cb75fae](https://github.com/mramdann/anbo-ai/commit/cb75faedcf746743b15baafc294c4f054543aa5b))
* **net:** normalize bracketed IPv6 hosts ([6f81666](https://github.com/mramdann/anbo-ai/commit/6f8166639b66c3a3390b5ae6b53fda0a5979303a))
* **notifications:** bundle toast styles statically ([688d87b](https://github.com/mramdann/anbo-ai/commit/688d87ba5d06944fc66f1bcd453c79b348c240ab))
* **pty:** authorize CLI launch directory in workspace registry on startup ([#413](https://github.com/mramdann/anbo-ai/issues/413)) ([cb79e29](https://github.com/mramdann/anbo-ai/commit/cb79e291f295f0283cfc179854ee68a676fce596))
* **pty:** auto-respawn on conpty output stall ([45aa9d7](https://github.com/mramdann/anbo-ai/commit/45aa9d7d50ec74db02809e4e899a4a1832a93b39))
* **pty:** avoid fish conda prompt recursion ([#1085](https://github.com/mramdann/anbo-ai/issues/1085)) ([70bfbde](https://github.com/mramdann/anbo-ai/commit/70bfbde84666562cdfca6414636202ea724b85d7))
* **pty:** gate fish integration to terax-spawned shells ([6113c28](https://github.com/mramdann/anbo-ai/commit/6113c28160638715d8c458e90a7f450869b2928f))
* **pty:** global scope for pwsh readline wrapper, self-heal on failure ([9ae51cd](https://github.com/mramdann/anbo-ai/commit/9ae51cd41e3eae21d39b29c4a82589cededec8a3))
* **pty:** prefer CLI launch dir over System32 cwd and reap orphaned sessions on reload ([5825cfc](https://github.com/mramdann/anbo-ai/commit/5825cfccba44d04386d93a414f22550fe3f662aa))
* **pty:** preserve fish cwd tracking with starship ([#798](https://github.com/mramdann/anbo-ai/issues/798)) ([2711841](https://github.com/mramdann/anbo-ai/commit/2711841da3fd4bb7bc68f617b4ec745e4083530c))
* **pty:** preserve terminal response order ([#1004](https://github.com/mramdann/anbo-ai/issues/1004)) ([ac88362](https://github.com/mramdann/anbo-ai/commit/ac88362fd87f779f5a1fc6e49ff813dba4c80fc0))
* **pty:** reap session on child exit to free stranded pseudoconsole ([1691e73](https://github.com/mramdann/anbo-ai/commit/1691e73a5861f5aeb3b7895f86aef5520860c36c))
* **pty:** remove conpty stall respawn watchdog band-aids ([3f2933a](https://github.com/mramdann/anbo-ai/commit/3f2933a9e7ddef407d0a2c1208f1aa38a608e237))
* **pty:** reply to pwsh startup cursor query so new tabs don't hang blank ([18187f4](https://github.com/mramdann/anbo-ai/commit/18187f4c7ee4446eb6190d82cee1f6884b1654c3))
* **pty:** rewrap fish prompt after config.fish on WSL/Windows ([#888](https://github.com/mramdann/anbo-ai/issues/888)) ([52b90c1](https://github.com/mramdann/anbo-ai/commit/52b90c1423224eedcee1161c2cf461f41bf3dc63))
* **pty:** skip redundant post-spawn resize, windows-only first-byte watchdog ([ffd2f6a](https://github.com/mramdann/anbo-ai/commit/ffd2f6a6298447d2b03cc0a4ce970b37ba8801e7))
* **pty:** snapshot launch cwd at startup so new terminals never drift ([#168](https://github.com/mramdann/anbo-ai/issues/168)) ([59d49d6](https://github.com/mramdann/anbo-ai/commit/59d49d67a8efd8600609460eeb557836df413d7b))
* **release:** rewrite updater urls for re-signed artifacts so latest.json survives asset-id changes ([d23e16f](https://github.com/mramdann/anbo-ai/commit/d23e16f61e08959ecb054079ac2692a66dae970f))
* resolve a11y and complexity lint issues ([1afe8d5](https://github.com/mramdann/anbo-ai/commit/1afe8d55aa143271d55e1405c594878757988473))
* **rust:** clippy needless_range_loop and cmp_owned ([0464c8e](https://github.com/mramdann/anbo-ai/commit/0464c8e771084d7ddb7bf742c4a5c71271f52304))
* scope agent resume to active workspace ([0731395](https://github.com/mramdann/anbo-ai/commit/073139576bd6dd73ed755d6b660aa351493ab619))
* **search:** refocus terminal after dismissing find ([#207](https://github.com/mramdann/anbo-ai/issues/207)) ([b9fef27](https://github.com/mramdann/anbo-ai/commit/b9fef279a61518d65da558ad0f952d80319d1539))
* **security:** block CR/LF and C0 controls in shell command guard ([b7ba0ee](https://github.com/mramdann/anbo-ai/commit/b7ba0eee39e4823992b7a1ba60efd764164f62b0))
* **security:** complete P0 boundaries ([33626f7](https://github.com/mramdann/anbo-ai/commit/33626f7e055a4d5ecb17f6f861cf183474069f09))
* **settings:** drop experimental label from browser automation ([2eafe42](https://github.com/mramdann/anbo-ai/commit/2eafe429089f623b6224c835b61bccf6be3b659e))
* **settings:** emit prefs-changed event from setShortcuts and resetShortcuts ([#252](https://github.com/mramdann/anbo-ai/issues/252)) ([dfd692a](https://github.com/mramdann/anbo-ai/commit/dfd692a4076680a6b7123a70c1eb3b8d175b2312))
* **settings:** fix settings window hidden behind main on macOS ([e0ddede](https://github.com/mramdann/anbo-ai/commit/e0ddede55c7af51ff68b370185729c8cfdbd61ed))
* **settings:** gate macOS settings-window lifecycle handler behind cfg(macos) ([93bfdf6](https://github.com/mramdann/anbo-ai/commit/93bfdf6bd05143a0518d0f2d38596140cee07bcf))
* **settings:** scroll long agent and snippet editor dialogs ([45eb76b](https://github.com/mramdann/anbo-ai/commit/45eb76b69ef6a2a341a44ac298ed4348969fbca5))
* **shell:** isolate agent harness to /bin/sh so fish/zsh users don't break wrapper ([#312](https://github.com/mramdann/anbo-ai/issues/312)) ([bc205ec](https://github.com/mramdann/anbo-ai/commit/bc205ec210b0c2389cff7e7cd872de541e134f74))
* **shell:** use to_canon for session cwd so unix backslashes are preserved ([4e8363a](https://github.com/mramdann/anbo-ai/commit/4e8363a32a4bed7076293ff39c1cc2cf2fe8bd7c))
* **shortcuts:** let Ctrl+B reach the terminal/Claude; sidebar toggle on Ctrl+Shift+B ([#629](https://github.com/mramdann/anbo-ai/issues/629)) ([16b29ba](https://github.com/mramdann/anbo-ai/commit/16b29ba2474681a1edc81be5ed4b78dcfc2217ef))
* **shortcuts:** let Ctrl+L reach xterm when no selection ([#358](https://github.com/mramdann/anbo-ai/issues/358)) ([90b8fb4](https://github.com/mramdann/anbo-ai/commit/90b8fb449b82e644c8f4cf56f8c46fbce9ef7ef1))
* **shortcuts:** move ai.askSelection from Mod+L to Mod+J so Ctrl+L passes to shell ([c1214bd](https://github.com/mramdann/anbo-ai/commit/c1214bdab273b06801726cbc8b014b48086d6180))
* **shortcuts:** move zen mode off editor's redo binding ([a71fcfc](https://github.com/mramdann/anbo-ai/commit/a71fcfc416d90ebbedb5c4dfdac4124ff4000e45))
* **shortcuts:** wire editor undo/redo and surface them in shortcuts dialog ([#221](https://github.com/mramdann/anbo-ai/issues/221)) ([930b913](https://github.com/mramdann/anbo-ai/commit/930b91312a54f5c9a3827f3d823c3f7722ab57e4))
* **source-control:** fix incomplete border class on commit message textarea ([#560](https://github.com/mramdann/anbo-ai/issues/560)) ([4f44703](https://github.com/mramdann/anbo-ai/commit/4f44703fb2c3d368e5ea5e37ab7a65030f8833e1))
* stabilize agent launcher menu handoff ([0b5e81b](https://github.com/mramdann/anbo-ai/commit/0b5e81b9196340fef4e0e7683c655b77709ca1a9))
* **startup:** prevent production dockview chunk cycle ([f7fca80](https://github.com/mramdann/anbo-ai/commit/f7fca807bb700c2cf5bb138b73e372966760b2da))
* **startup:** render window controls on the preparing-workspace screen ([a39a8cc](https://github.com/mramdann/anbo-ai/commit/a39a8cc7ad10e1f544de74a8dc7a3e200a5601ad))
* **statusbar:** split breadcrumb file path on Windows separators ([ba68fad](https://github.com/mramdann/anbo-ai/commit/ba68fade2a4629184cfa20adce2d556141b094df))
* **tabs:** center active pill, own focus colors across themes ([3ba94ac](https://github.com/mramdann/anbo-ai/commit/3ba94ac9b1aabec96e5ea19fe9ed62e394cc072c))
* **tabs:** clear agent attention on activation ([81e718c](https://github.com/mramdann/anbo-ai/commit/81e718ccc70836b3148ce5706ff257335dbc49cd))
* **tabs:** commit switcher on modifier release, id-based HUD highlight ([10af844](https://github.com/mramdann/anbo-ai/commit/10af8447fe451c09a5d76d77317db631b3744ffd))
* **tabs:** restore active-tab highlight and rename input focus ([47b2750](https://github.com/mramdann/anbo-ai/commit/47b2750b451de4a075fafd6d77f3b67d73d39f68))
* **tabs:** scope Cmd+number selection to the active space ([#881](https://github.com/mramdann/anbo-ai/issues/881)) ([4d3160d](https://github.com/mramdann/anbo-ai/commit/4d3160d1811cb200743d3c3383cd215489013c69))
* **tabs:** select on pointer release, smaller context menu ([ed6a1bf](https://github.com/mramdann/anbo-ai/commit/ed6a1bff0fd73d6b30c1760c43d4b219948bde4b))
* **tabs:** skip close dialog for last tab in space ([61b526a](https://github.com/mramdann/anbo-ai/commit/61b526aa5aae799930cb204be15c0a771c8d348a))
* terminal cwd above home, Windows verbatim paths, test/CI hardening ([#453](https://github.com/mramdann/anbo-ai/issues/453)) ([1bcd8f9](https://github.com/mramdann/anbo-ai/commit/1bcd8f9f887ed5808b4ac36a593df6c6a1fdf657))
* **terminal:** apply monospace fallback for custom fonts and fix family input ([6019e04](https://github.com/mramdann/anbo-ai/commit/6019e04daacf0ebf4bcf244c3aeea7894270badc))
* **terminal:** authorize user-navigated cwd so shells spawn outside home ([c1f190b](https://github.com/mramdann/anbo-ai/commit/c1f190b7df6656754ab85b46cb94f9eed9ac1802))
* **terminal:** block IME composition keydown events from reaching PTY ([#196](https://github.com/mramdann/anbo-ai/issues/196)) ([9f70bfb](https://github.com/mramdann/anbo-ai/commit/9f70bfb153a4394ba7754d02572bad38c787f63f))
* **terminal:** bound the pre-attach input buffer ([a1fca84](https://github.com/mramdann/anbo-ai/commit/a1fca8465b18b2884620c477d6fecaf92eb808e7))
* **terminal:** bracketed-paste multiline and repaint stale slot on wake ([1f22aee](https://github.com/mramdann/anbo-ai/commit/1f22aee1005436aeb4d7e255d88af3cbd78508a2))
* **terminal:** buffer input typed before the pty attaches ([7f972aa](https://github.com/mramdann/anbo-ai/commit/7f972aa975d09bae220200e60cd2eab7015d4743))
* **terminal:** coalesce dormant ring chunks, keep history on overflow ([4aa463d](https://github.com/mramdann/anbo-ai/commit/4aa463dff14c2173a05a38009fba9f70e0dc21ee))
* **terminal:** drop stolen slot webgl before reparent to stop cross-tab flash ([67a8f88](https://github.com/mramdann/anbo-ai/commit/67a8f88a6438108ce6e667546990e589fa0c3608))
* **terminal:** keep busy hidden tabs live, lazy slot serialize, spawn retry ([de6bab7](https://github.com/mramdann/anbo-ai/commit/de6bab7543e026641c4e2ed0d74643cc54d145bb))
* **terminal:** preserve native keys in alternate screen ([#1025](https://github.com/mramdann/anbo-ai/issues/1025)) ([4634739](https://github.com/mramdann/anbo-ai/commit/4634739554f77d912d733efa137d5d29060b7ded))
* **terminal:** preserve pane layout during swaps ([460657a](https://github.com/mramdann/anbo-ai/commit/460657aa68931362a475db4cfac117bce710cd87))
* **terminal:** repaint TUIs on resume instead of replaying dormant bytes ([#360](https://github.com/mramdann/anbo-ai/issues/360)) ([65209b3](https://github.com/mramdann/anbo-ai/commit/65209b3e87fca0138b0447bfd04266bc97e254b4))
* **terminal:** stable pane keys, flash-free fast rebind on split remount ([f958e08](https://github.com/mramdann/anbo-ai/commit/f958e08b6c3b809447adc177169e8c593dcc3e2f))
* **terminal:** support Option arrow word navigation ([#308](https://github.com/mramdann/anbo-ai/issues/308)) ([5f6cb1d](https://github.com/mramdann/anbo-ai/commit/5f6cb1dce8becaa46730dfb09bea79ed703b1a3c))
* **terminal:** use native clipboard for copy/paste on Linux ([#713](https://github.com/mramdann/anbo-ai/issues/713)) ([#895](https://github.com/mramdann/anbo-ai/issues/895)) ([a3ebccd](https://github.com/mramdann/anbo-ai/commit/a3ebccd2ca6e405b41cb864569e37920380e92a3))
* **test:** drop needless borrow flagged by clippy -D warnings ([6ae7e22](https://github.com/mramdann/anbo-ai/commit/6ae7e22ca4c3f448f49b23a7b4aac1895a52d31e))
* **theme:** expose font fields in starter theme ([#1011](https://github.com/mramdann/anbo-ai/issues/1011)) ([cf30c25](https://github.com/mramdann/anbo-ai/commit/cf30c25bdb8fd02c72c70177f91776b069809f08))
* **tooling:** remove shebang from eager-graph.mjs so vitest can import it ([#1036](https://github.com/mramdann/anbo-ai/issues/1036)) ([d630bb3](https://github.com/mramdann/anbo-ai/commit/d630bb331a83ac889206c5023886ffd98a2d0588))
* **ui:** improve tab overflow dropdown and inline Ask Anbo tooltip ([5a75ef0](https://github.com/mramdann/anbo-ai/commit/5a75ef00899a9a336f4048b2f174e2dc15b96b25))
* **ui:** make modal dialogs follow the UI zoom setting ([37c3159](https://github.com/mramdann/anbo-ai/commit/37c3159975fd39c9b1ac7e58874fef375b7ece94))
* **ui:** render updater release notes as markdown ([dcb24f4](https://github.com/mramdann/anbo-ai/commit/dcb24f49129f51c59bfedebca38bf0698141e71b))
* **ui:** restore composer focus and allow typing during agent's response ([#303](https://github.com/mramdann/anbo-ai/issues/303)) ([da28c85](https://github.com/mramdann/anbo-ai/commit/da28c8519911a97314f07c369e21a164eb20ffa5))
* **ui:** saner background defaults and dynamic todo panel height ([fc5e089](https://github.com/mramdann/anbo-ai/commit/fc5e0893690fe773937562f30fdac77bdeb6a0cc))
* **updater:** persist dismissed version and enable periodic auto-check ([02f372c](https://github.com/mramdann/anbo-ai/commit/02f372ceb99915a3db37bb37524b961c9cfdc5a4))
* **updater:** scope checks to Windows releases ([03b87c9](https://github.com/mramdann/anbo-ai/commit/03b87c93894ccfbb46d80a3bec703547c6815c1b))
* **window:** grant window destroy permission so close works with @tauri-apps/api 2.11 ([414ee17](https://github.com/mramdann/anbo-ai/commit/414ee1756cbf04c52860b5d0181179164c3cc4b6))
* **window:** quit on last-tab shell exit instead of respawning ([7a812ca](https://github.com/mramdann/anbo-ai/commit/7a812caf03afd742e4a06240184da00b2cb1d0d7))
* **windows,terminal:** System32 launch dir, PTY reload reap, paste + stale-render, CI ([#476](https://github.com/mramdann/anbo-ai/issues/476)) ([d2a41b6](https://github.com/mramdann/anbo-ai/commit/d2a41b65d7c08dc016a5c6df1845969ca37ce56f))
* **windows:** serialize ConPTY lifecycle and skip exe dir as launch cwd ([1876ddf](https://github.com/mramdann/anbo-ai/commit/1876ddf86708d109c96b7a21ef51b18e074cd300))
* **windows:** strip verbatim path prefix at a single canonical-to-display point ([bc9a6cb](https://github.com/mramdann/anbo-ai/commit/bc9a6cbd386a4841a15a19ec3861cf10577a5321))
* **windows:** suppress console window flash on subprocess spawns ([83727b9](https://github.com/mramdann/anbo-ai/commit/83727b94ceb7bc923cc78d3ccfe2391be4f67feb))
* **workspace:** preserve independent space runtimes ([4a852a4](https://github.com/mramdann/anbo-ai/commit/4a852a4934f036b594172ee15b35fd442a34d0aa))
* **wsl:** honor workspace env for git and shells ([#345](https://github.com/mramdann/anbo-ai/issues/345)) ([719de9b](https://github.com/mramdann/anbo-ai/commit/719de9b31058d2f87168206f288be2931e6a8f9b))
* **wsl:** restore per-space workspace env on reopen ([4a6d803](https://github.com/mramdann/anbo-ai/commit/4a6d803f4d901c3f03e33f57a744b0d3c638ee7e))


### Performance Improvements

* **ai:** bound active conversation rendering ([25ca69b](https://github.com/mramdann/anbo-ai/commit/25ca69b3baed40cdf50f74fb0d0b3a07107330f8))
* **browser:** make native layout sync event driven ([07fcad8](https://github.com/mramdann/anbo-ai/commit/07fcad865c00fa86cf04602a75c5cd2886ec5079))
* **bundle:** drop tokenlens dep and woff font duplicates ([cbe1ad4](https://github.com/mramdann/anbo-ai/commit/cbe1ad4cd5fbc10b46af9cd4cdfed46e59de8453))
* **content:** defer expensive large previews ([f81f98b](https://github.com/mramdann/anbo-ai/commit/f81f98bb0693737cf008f728ccb2fb306f5e7280))
* **editor:** skip language resolve until the document is ready ([8200938](https://github.com/mramdann/anbo-ai/commit/8200938397ec31f89119bec808a3355d80e90d0e))
* **explorer:** stop redundant row rerenders and no-op refetches ([d00d20f](https://github.com/mramdann/anbo-ai/commit/d00d20f48eb9b5a547105c8d319ba195dcdc6b19))
* **fs:** skip auto-reload on editor's own saves via source discriminator ([5deb865](https://github.com/mramdann/anbo-ai/commit/5deb865101eda56014c65c7df4d3efd23c68fdef))
* **git:** spawn_blocking, porcelain v2, lazy git ui, lift diff content out of tabs ([17b8059](https://github.com/mramdann/anbo-ai/commit/17b8059f614d6a7668820a57eac09f0430b6f6b7))
* **pty:** raw-body pty_write, tcgetpgrp foreground check, conpty stall watchdog ([62162f4](https://github.com/mramdann/anbo-ai/commit/62162f4a43e3be8701bc7020c506ce94fb4425db))
* **startup:** keep provider SDKs lazy ([7d38780](https://github.com/mramdann/anbo-ai/commit/7d38780df664e0efb38db7a214cb89e7e742c092))
* **startup:** measure generated preload closures ([80c36d7](https://github.com/mramdann/anbo-ai/commit/80c36d7643bd251ae12b323af19307996da56505))
* **state:** bound caches and stale async work ([92bd2fa](https://github.com/mramdann/anbo-ai/commit/92bd2fadd1ecd38ae5f588ac3823cc947d40ac42))
* **terminal,git:** async pty_open, canonical cache, recv_timeout, ring slices ([760e776](https://github.com/mramdann/anbo-ai/commit/760e77681a4e5c4c8ff2282da9ea107e813f2d95))
* **terminal,git:** pty resize on rebind, condvar flusher, fold unstage probe ([4050996](https://github.com/mramdann/anbo-ai/commit/4050996a4618a851a7c6a0729b1d6fa8b127c2be))
* **terminal,workspace:** fix flusher latency, tighten canonical TTL, parallel pty spawn on unix ([6266ea8](https://github.com/mramdann/anbo-ai/commit/6266ea80a3264ab6cd747a4e335c34e7c1fd700a))
* **terminal:** memoize panes with stable leaf callbacks ([a1ce28e](https://github.com/mramdann/anbo-ai/commit/a1ce28e38a4b673b5c356377fec3cf49d3c8314e))
* **terminal:** static cursor default, WebGL/slot reaping, TUI keep-alive ([#725](https://github.com/mramdann/anbo-ai/issues/725)) ([fb33a01](https://github.com/mramdann/anbo-ai/commit/fb33a0149ecfe08c918659e233fd2119562f68c4))
* **themes:** tune background image overhead ([9d0f811](https://github.com/mramdann/anbo-ai/commit/9d0f811946ccb6dda10662ff4eb9193382be8959))

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

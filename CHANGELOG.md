# Changelog

## [0.39.0](https://github.com/mramdann/anbo-ai/compare/v0.38.0...v0.39.0) (2026-11-13)


### Features

* **browser:** click, check, hover and drag on a Chrome/Edge page that cannot be shown ([4ea8067](https://github.com/mramdann/anbo-ai/commit/4ea80678424e5b2ba320abbb415fcf627f62aea7))
* **browser:** close Anbo's tab with its Chrome/Edge page and open embedded new tabs beside their opener ([7a2a211](https://github.com/mramdann/anbo-ai/commit/7a2a211b6c51a00191570d1bc3d6549bded2dcc3))
* **browser:** close Chrome/Edge tabs with their Anbo tab and open their new tabs in Anbo ([5d723d4](https://github.com/mramdann/anbo-ai/commit/5d723d4497c79d5e692381ada147701cbd9414a5))
* **browser:** let one Chrome/Edge profile serve several workspaces ([c79eb62](https://github.com/mramdann/anbo-ai/commit/c79eb62f52b809cbb7e041e0c277f0271ecc37d8))
* **browser:** name the element a pan moved inside in the drag reply ([7b02817](https://github.com/mramdann/anbo-ai/commit/7b02817809cbffd307ebdc0c2e9825b2c7bc1fd7))
* **dev:** write a minidump of a native crash in Dev builds ([36a8d19](https://github.com/mramdann/anbo-ai/commit/36a8d191a4a0b5c5dc0ff2fde641b850151ebda9))
* **spaces:** pause and resume a space by hand ([9e9adc4](https://github.com/mramdann/anbo-ai/commit/9e9adc43c3c9d8b9d377bf9d7b208282000b67cf))


### Bug Fixes

* **agents:** answer a spawn that never starts, and let the spawner close it ([e88f124](https://github.com/mramdann/anbo-ai/commit/e88f1247486f1491cf95947f8ef57fb8c0d1c11d))
* **agents:** end a Codex turn on its dated row, so a resumed Codex takes agent_send ([1bcd683](https://github.com/mramdann/anbo-ai/commit/1bcd683df598c93ccbd01f5bf438a11ca1b6d76d))
* **agents:** end an Antigravity turn its changing idle screen held open ([4e3cbd0](https://github.com/mramdann/anbo-ai/commit/4e3cbd07a24df9544b80fe904d829b2d70724018))
* **agents:** give a busy UI's answer time to arrive after the deadline ([48d3bb1](https://github.com/mramdann/anbo-ai/commit/48d3bb1da5eefe0b190930829ea76bef972702d5))
* **agents:** keep finding an agy session once agy has left 512 locks behind ([df1dcf6](https://github.com/mramdann/anbo-ai/commit/df1dcf6c753520f666c9dc4b2a5efe73199ef6ed))
* **agents:** keep the session of an agy that updated itself while running ([cd24ee7](https://github.com/mramdann/anbo-ai/commit/cd24ee76ceb6964ad2220943a8e558a3b906d147))
* **agents:** keep typing a long message a CPU-starved agent is still taking ([8fc14c9](https://github.com/mramdann/anbo-ai/commit/8fc14c98216befa459302ee811c503732c5ef755))
* **agents:** let a fired Antigravity timer end the turn's working state ([4a39943](https://github.com/mramdann/anbo-ai/commit/4a3994309f4763b1d098fc3abccdb8f7cd847de7))
* **agents:** let a read right after a turn ended wait for the screen ([c658af4](https://github.com/mramdann/anbo-ai/commit/c658af4e799b49c9a0c59c3ee61a12999d10afd3))
* **agents:** list a hidden workspace's restored agents and resume one a tool uses ([68f798d](https://github.com/mramdann/anbo-ai/commit/68f798d98bc8c93b174a2a919b6ac31da77eed3f))
* **agents:** never press Enter on a question the agent put up itself ([9ca7790](https://github.com/mramdann/anbo-ai/commit/9ca779006b23ea1628d98ed8e7e4178296e05e45))
* **agents:** read a fresh Codex's startup notice as no turn, so agent_send reaches it ([9325eb3](https://github.com/mramdann/anbo-ai/commit/9325eb33933121494ab62afedd982f9c22db86b6))
* **agents:** read Antigravity waiting on its own timer as working ([9f22c24](https://github.com/mramdann/anbo-ai/commit/9f22c2495d9c82a036f679a611584a6103bec081))
* **agents:** start a spawned Codex without its update question ([ea4291b](https://github.com/mramdann/anbo-ai/commit/ea4291b13ddb3da24c4de0f35fe25c77d24297b1))
* **agents:** start no agent or terminal request after its caller gave up ([0bf3a2a](https://github.com/mramdann/anbo-ai/commit/0bf3a2a1df50ce67b84ae43721f4c0f7435783ec))
* **agents:** stop losing the UI's answers to overlapping requests ([0857901](https://github.com/mramdann/anbo-ai/commit/0857901d15b33c29c3b0d884c5847b97c40c812c))
* **agents:** wait for Claude to draw a message before pressing Enter ([4863c8c](https://github.com/mramdann/anbo-ai/commit/4863c8ce61aca4b963ec576ca0870ce61cf31fb6))
* **app:** give the async workers an 8 MiB stack ([feca999](https://github.com/mramdann/anbo-ai/commit/feca999b526b25fb5138ebda44a7086aeedfed3a))
* **app:** keep every Rust panic, with its place and backtrace, in panic.log ([cbb7000](https://github.com/mramdann/anbo-ai/commit/cbb70005983d610987e262a0f9b5885bab571707))
* **app:** stop App's renders chaining and keep no addon outside the pool ([aa569d5](https://github.com/mramdann/anbo-ai/commit/aa569d52e57373ef0a868788db266cd13500a0c2))
* **app:** stop old App renders keeping disposed terminals alive ([368821d](https://github.com/mramdann/anbo-ai/commit/368821df3108171097b697c1795bc400f62d895d))
* **browser-ext:** bring in a tab an agent's key opened from a page behind the user's tab ([70960e8](https://github.com/mramdann/anbo-ai/commit/70960e8dafea53c8b691e1c2c7710d31c0e8df72))
* **browser:** an agent's first call after an embedded open no longer meets a gone page context ([a3da8c7](https://github.com/mramdann/anbo-ai/commit/a3da8c74bd70ff89188bb7b9c4ca1cc4c391f87f))
* **browser:** answer a screenshot of an unshown Chrome/Edge tab in 3 s ([de836d4](https://github.com/mramdann/anbo-ai/commit/de836d46f04edf2e8b900c82f53a32c76b664966))
* **browser:** answer a settled miss as not_found, and take numbers written as strings ([c0b1517](https://github.com/mramdann/anbo-ai/commit/c0b15170dc6adf57ec83da6d0fb70a83642ec9bf))
* **browser:** answer a submit whose waitFor was met without the search look ([48eb97b](https://github.com/mramdann/anbo-ai/commit/48eb97bc152ce4ea20f1488d492afaf920f8e8ff))
* **browser:** answer dialog clicks on a hidden Chrome/Edge tab ([548f6db](https://github.com/mramdann/anbo-ai/commit/548f6db69f5273e318c735e4260958eadf49ac39))
* **browser:** answer resource_exhausted for a tab whose page could not start ([62aa474](https://github.com/mramdann/anbo-ai/commit/62aa4740b924e9317fe8faba66065ed12ded83f2))
* **browser:** bind Chrome and Edge tabs again after a page reload ([6362636](https://github.com/mramdann/anbo-ai/commit/636263648b2898555a4dc20c0928ef7677c370ea))
* **browser:** bring an unshown Chrome/Edge tab forward for a screenshot ([cf4859b](https://github.com/mramdann/anbo-ai/commit/cf4859b1664cdce4b2a9dd64aa0734c66248ca99))
* **browser:** call a Chrome/Edge tab being bound connecting, not gone ([0cb3614](https://github.com/mramdann/anbo-ai/commit/0cb361475b592b1e9185f3ba6a1bd4985f02326f))
* **browser:** close a select's open option list before choosing ([39cf45b](https://github.com/mramdann/anbo-ai/commit/39cf45b12f24a271c391d374ad39b7d2e49851bb))
* **browser:** compare a Chrome/Edge tab's workspace in canonical form ([899a9bd](https://github.com/mramdann/anbo-ai/commit/899a9bd8a188ff4607f267072ce9b092cc96d44b))
* **browser:** declare browser_click's clickCount as a range, not an integer enum ([e986610](https://github.com/mramdann/anbo-ai/commit/e9866101000ab249edff1838dc6d61880ebed715))
* **browser:** dismiss and report a dialog an agent's click opens ([6880259](https://github.com/mramdann/anbo-ai/commit/6880259334de86f43bb341992cf9302f0855ff39))
* **browser:** dock a Chrome/Edge page by itself only while the user is in Anbo ([dc60a1f](https://github.com/mramdann/anbo-ai/commit/dc60a1f1452ac7338b4cac184e72a398f5f2a9bd))
* **browser:** fill a field the hit test finds no element at instead of calling it covered ([7592b98](https://github.com/mramdann/anbo-ai/commit/7592b982ca91d91acca7359a81bc12f9fd5d14a1))
* **browser:** forget embedded tabs whose browser never started, and say why an open failed ([eb10636](https://github.com/mramdann/anbo-ai/commit/eb106364f4ee74d7044d46d4cd205a684b60a7df))
* **browser:** give a capture refusal the capture's reason ([3611eb5](https://github.com/mramdann/anbo-ai/commit/3611eb5007206c26a56b80f781899bb8572ec282))
* **browser:** give a hidden Chrome/Edge page 8 s to draw for a capture ([157be01](https://github.com/mramdann/anbo-ai/commit/157be01f58a2f8737155415f2f3eedc37a1558b9))
* **browser:** give a page-opened tab to the clearly last input of two workspaces ([faeb9e7](https://github.com/mramdann/anbo-ai/commit/faeb9e782bf6a81f01509f2d72c3a5c4b6d23640))
* **browser:** give a short find on hidden text the not_found verdict ([3511591](https://github.com/mramdann/anbo-ai/commit/3511591d3a867dd13509021d897ee2947ee17315))
* **browser:** give the shared WebView2 environment back on the main thread ([2a22f4c](https://github.com/mramdann/anbo-ai/commit/2a22f4cee9bc9812d13c5c067e003528eadf69ff))
* **browser:** have a hidden Chrome/Edge page draw for a capture ([197bff7](https://github.com/mramdann/anbo-ai/commit/197bff7c251b02b9434e1febd18d52e25bef6b64))
* **browser:** hold an agent's link however late its key arrives, and put a late tab's window back ([3865579](https://github.com/mramdann/anbo-ai/commit/386557925bdf0af2a38f0f718656592f1123eebd))
* **browser:** keep a busy Chrome/Edge page's tab past a command's deadline ([949c954](https://github.com/mramdann/anbo-ai/commit/949c9543b0e2eb3cfcfb11d6f49628dbcdf0dcc8))
* **browser:** keep a Chrome/Edge page's refs across its iframes' navigations ([bf79eac](https://github.com/mramdann/anbo-ai/commit/bf79eacff84d740d4a1e5ad35f6e08bb01073509))
* **browser:** keep a closed tab from leaving four OLE drop targets behind ([6816e38](https://github.com/mramdann/anbo-ai/commit/6816e38ee25414700faa761a3034de05d5d42013))
* **browser:** keep a hidden page's new tab from taking the user's focus ([cecdaee](https://github.com/mramdann/anbo-ai/commit/cecdaee7f692f46f724fe11507cc196f75d34044))
* **browser:** keep a tab an agent just opened out of the embed reconcile ([261e725](https://github.com/mramdann/anbo-ai/commit/261e7254e7ae5175d9e2755dd49b671c97a3e5cf))
* **browser:** keep agent tabs' renderers scheduled on a busy machine ([37bc870](https://github.com/mramdann/anbo-ai/commit/37bc870a2d2da0eba6cfe6b9c65c07deb32bcea8))
* **browser:** keep Chrome/Edge agents working side by side ([0fc346a](https://github.com/mramdann/anbo-ai/commit/0fc346a5a6114f490985a2237c34d8824b41510e))
* **browser:** keep closing an old page's tabs when one close fails ([164e3cd](https://github.com/mramdann/anbo-ai/commit/164e3cd932965191182ef2cbd41b03dc48cae645))
* **browser:** keep every connected profile's extension scheduled ([7428506](https://github.com/mramdann/anbo-ai/commit/742850639bdc2d8856f71ea9396bfa77d1d07cfe))
* **browser:** keep refs for 32 scans, not 8 ([d153748](https://github.com/mramdann/anbo-ai/commit/d153748158a8786649dc15e5d5d6fc6a4857763a))
* **browser:** keep tab calls inside the caller's workspace ([3684a6f](https://github.com/mramdann/anbo-ai/commit/3684a6f357599bdf90ca2d4babb9dbf214580afe))
* **browser:** keep the network observer's helpers off the dead-code lint off Windows ([035cb7a](https://github.com/mramdann/anbo-ai/commit/035cb7a797908afb4b82575f449ee508c71e3a75))
* **browser:** keep the new-tab click helpers off the dead-code lint off Windows ([0bb1e7b](https://github.com/mramdann/anbo-ai/commit/0bb1e7bfe780fdfe898ef4e51e8b704c001c2b56))
* **browser:** keep the warm browser host five minutes after the last tab ([4732795](https://github.com/mramdann/anbo-ai/commit/473279567ecc45c4bb6a133e44b97d6ad312deff))
* **browser:** leave a tab Anbo is opening out of the tabs a page opened ([dec3f1b](https://github.com/mramdann/anbo-ai/commit/dec3f1b5cd1d7d1e65ec3ad4b5d36356a21261a5))
* **browser:** let a find read text kept only for screen readers ([923c5a0](https://github.com/mramdann/anbo-ai/commit/923c5a03255b61940a42d8323616c4719d0e132d))
* **browser:** let a page in Anbo's own browser take drops ([8f55804](https://github.com/mramdann/anbo-ai/commit/8f558048632ca634a15cc85bff3da9afe1f51700))
* **browser:** let a pan inside one element end under a panel drawn over it ([4479267](https://github.com/mramdann/anbo-ai/commit/447926706e0c1d78d606a6cbec1408f5aa5e9ee8))
* **browser:** let a type wait out a load in flight before it fills ([a895c38](https://github.com/mramdann/anbo-ai/commit/a895c380756d460538b34a1d1f9886c996d3a61d))
* **browser:** let an agent open a tab in the profile it names ([6cdb8d6](https://github.com/mramdann/anbo-ai/commit/6cdb8d633dedab99a955d6e3bdb03e84a80fb13e))
* **browser:** let an agent's Chrome or Edge tab clear a lower memory bar ([556faf4](https://github.com/mramdann/anbo-ai/commit/556faf48dd2af02bd3dc6d5fba70ac569222cd17))
* **browser:** let browser_close find the tab's workspace when the call leaves it out ([3d693f5](https://github.com/mramdann/anbo-ai/commit/3d693f5c2aef62493b45a3662749f5438b4922bb))
* **browser:** list failed requests with the console, leave Anbo's icon out of the network ([863f230](https://github.com/mramdann/anbo-ai/commit/863f2300479c4daf4388e1c363af5f169fb8dbaf))
* **browser:** list only the current page's console for a Chrome/Edge tab ([d0c172b](https://github.com/mramdann/anbo-ai/commit/d0c172b2d31b3c35d79f33705d98e73ee10e3b6a))
* **browser:** list only the current page's failed requests with its console ([eca6b72](https://github.com/mramdann/anbo-ai/commit/eca6b72f46117cc5de030dbadf704c9b1cfd1f7e))
* **browser:** list restored tabs that are not loaded yet ([42151a6](https://github.com/mramdann/anbo-ai/commit/42151a6853ad11031c3ab9a1e6b82e025e5de788))
* **browser:** log why a profile's extension process goes unkept ([cce9851](https://github.com/mramdann/anbo-ai/commit/cce98514c3987d5adcbfb7133d60ac3b80dddafb))
* **browser:** look at the foreground again whenever the dock asks where the user is ([879c0a9](https://github.com/mramdann/anbo-ai/commit/879c0a9a178eba3ec0cda64c87828ea4d5cc2d6d))
* **browser:** make an emulate reset on a hidden Chrome/Edge page true ([2d98c1f](https://github.com/mramdann/anbo-ai/commit/2d98c1f817653064c75660382f47715e2e06f5af))
* **browser:** make tabs an agent's click opened its own, and list tabs in strip order ([e2f9d90](https://github.com/mramdann/anbo-ai/commit/e2f9d90d9cf5e0b8f11485fb6764178a2889a59e))
* **browser:** name a data: download by its type and length ([12e71ae](https://github.com/mramdann/anbo-ai/commit/12e71ae141c92ee4a5c42dd5f2087ea28666dd6d))
* **browser:** name a select's options when none matches ([2ad3dba](https://github.com/mramdann/anbo-ai/commit/2ad3dba998eaa9095864dd50fe31c41155b37688))
* **browser:** name an agent-opened tab's opener in its bind ([eabd7b2](https://github.com/mramdann/anbo-ai/commit/eabd7b2b0aa0a93dc56b43d64daaf47dc5d65033))
* **browser:** name controls in their labels as a reader does, and match roles whole ([5f8a971](https://github.com/mramdann/anbo-ai/commit/5f8a971d5ad60feb7f43b784147edde4c71c9467))
* **browser:** never send a full-page capture a hidden page cannot draw ([0e4de94](https://github.com/mramdann/anbo-ai/commit/0e4de94a1ee3bb2d18311e989e8d9e7ac9a13f71))
* **browser:** number scans across tabs so a ref names its tab ([ed910af](https://github.com/mramdann/anbo-ai/commit/ed910af69f8c52582cf30a3b4239f147a8afd541))
* **browser:** open an agent's link without bringing its window up ([90a6c62](https://github.com/mramdann/anbo-ai/commit/90a6c62ed9c4cc55f663af643a7ebbb68bd55b52))
* **browser:** open one tab for one click on a new-tab link ([dfab8ec](https://github.com/mramdann/anbo-ai/commit/dfab8ec6021558d6de70fe0413a5f16f1afd88a8))
* **browser:** put a browser window back after an agent's input opened a tab ([8ebd9f3](https://github.com/mramdann/anbo-ai/commit/8ebd9f35295dcc1ae5e4d601208e57f7c462f8df))
* **browser:** put a browser window back as soon as it comes up ([4e47c3e](https://github.com/mramdann/anbo-ai/commit/4e47c3eb0853f730273da322c4149e8d0e914aa5))
* **browser:** read page answers that hold a lone surrogate ([783b014](https://github.com/mramdann/anbo-ai/commit/783b0140c3a59c44209be9e7f45376ea530f6d82))
* **browser:** release a docked page through the extension on a new page ([ba15d8d](https://github.com/mramdann/anbo-ai/commit/ba15d8d6157cbf7201f4d87fc22d6bdc31bbb712))
* **browser:** run a refused action once more when nothing reached the page ([b87011a](https://github.com/mramdann/anbo-ai/commit/b87011aab18ac6da0e202f09a1abf0a776749d65))
* **browser:** say a tab closed while it opened instead of ok or a timeout ([d76a93e](https://github.com/mramdann/anbo-ai/commit/d76a93ed9ce7b7f89f8a28bfff0ca898714692e7))
* **browser:** say when a lookup timed out on a hidden Chrome/Edge tab ([72956fc](https://github.com/mramdann/anbo-ai/commit/72956fce8238c5c2f3cb28f3c49407659ed739d7))
* **browser:** say when the page threw while handling a click ([243455f](https://github.com/mramdann/anbo-ai/commit/243455f104b5555fd1a22eed41d41c24bf77ccf2))
* **browser:** say where a scroll went, and read a snapshot's text in its drawn order ([a5f9ea1](https://github.com/mramdann/anbo-ai/commit/a5f9ea1ba5d965c1c26688eaa48f7c75f647b9d3))
* **browser:** say why a hidden page took stand-in input ([683f0ed](https://github.com/mramdann/anbo-ai/commit/683f0ed9be33cf02f9a0da7a73d8cc09dd080250))
* **browser:** say why a tab's page is not there, and let agents find a Chrome tab that lost it ([83a7ed6](https://github.com/mramdann/anbo-ai/commit/83a7ed683891ce566af24f921a345d0097993c7f))
* **browser:** stop overlay requests filling a Chrome/Edge connection ([59da389](https://github.com/mramdann/anbo-ai/commit/59da3890eab930764c22b870da953a699d8997e7))
* **browser:** stop reloading a page that changed its own URL ([68a1249](https://github.com/mramdann/anbo-ai/commit/68a1249a154c043de9a7a7b3ac62a64a522d25a7))
* **browser:** try a click again when a new tab takes the dock first ([22f50f4](https://github.com/mramdann/anbo-ai/commit/22f50f4d6425a82a2f895085e9f09cf675b39445))
* **browser:** wait for a search's landing again when the page retitled itself ([b11508c](https://github.com/mramdann/anbo-ai/commit/b11508c215ea87f4b6c6e971abc8a5f15ea6b673))
* **browser:** write the browser history one write at a time ([1685cb6](https://github.com/mramdann/anbo-ai/commit/1685cb60a5d452b69feaf76da22f8adbf78d6b48))
* **extension:** place a page-opened tab by the page its navigation came from ([530c5ac](https://github.com/mramdann/anbo-ai/commit/530c5aca68df40bf782770665636462cacc1add0))
* **mcp:** let Antigravity load every Anbo tool at once ([4334ee8](https://github.com/mramdann/anbo-ai/commit/4334ee8a8de5f4310080a056843252d17f055fcc))
* **pty:** keep a terminal's output reaching the UI after a lost message ([158c7cb](https://github.com/mramdann/anbo-ai/commit/158c7cba329d8bfb68c634ae15fe46fd4776cfc7))
* **pty:** take a command line's agent only from where it runs as the program ([0d163a8](https://github.com/mramdann/anbo-ai/commit/0d163a8cd455bd22441fcfd2a615976368141214))
* **settings:** let Settings hide itself when a theme opens in the editor ([9398a70](https://github.com/mramdann/anbo-ai/commit/9398a707e5351ca65147a7fd5263283ca909eec0))
* **tabs:** go on numbering tabs after a page reload ([397ce73](https://github.com/mramdann/anbo-ai/commit/397ce7375f8cf3041b00fda34750c3f6b7b03649))
* **tabs:** stop a workspace switch from leaking Dockview groups ([6afbacc](https://github.com/mramdann/anbo-ai/commit/6afbaccead119d4fffd31efd522f646dcd1181bb))
* **terminal:** answer waits whole and in time, and free a terminal a command left stuck ([26fb893](https://github.com/mramdann/anbo-ai/commit/26fb893c16359e3d52e8d247aa339e401ef22668))
* **terminal:** bind a live buffer again for a command whose terminal lost its own ([1db1caa](https://github.com/mramdann/anbo-ai/commit/1db1caa027f0594ee155ecdf4c9fa1a838fb5308))
* **terminal:** count a grid's resizes as its layout, not its width ([6b3cadd](https://github.com/mramdann/anbo-ai/commit/6b3caddc4db45000384154d7b3c245b977deee5e))
* **terminal:** count terminal text in characters, as its schema says ([082325f](https://github.com/mramdann/anbo-ai/commit/082325f7d4fa768cccd5597a046ce3796d15ad38))
* **terminal:** end a command only at the D of a command that started ([b227c06](https://github.com/mramdann/anbo-ai/commit/b227c060651fb0f20de535639e37a14d51dcb54d))
* **terminal:** end no command at the prompt a cleared input draws again ([46acce7](https://github.com/mramdann/anbo-ai/commit/46acce7a0f9386576b530b11bbcd1a3289fdb307))
* **terminal:** find less's prompt under a full-width row, so terminal_interrupt quits the pager ([3d888ff](https://github.com/mramdann/anbo-ai/commit/3d888ff8f4cbcd37e5828ee2872277b6e4a11745))
* **terminal:** flag left-out history only on a read without a cursor ([9ae96f9](https://github.com/mramdann/anbo-ai/commit/9ae96f9f6161994b71cae2eb7863206448ffcd0f))
* **terminal:** keep a hidden terminal's PTY at its own size ([73c6ea9](https://github.com/mramdann/anbo-ai/commit/73c6ea906056835be885ccfbefa224e2e7f6f6ce))
* **terminal:** keep a new terminal starting until its first prompt ([c633b39](https://github.com/mramdann/anbo-ai/commit/c633b39435e02dc00028b24a9da56877b962faeb))
* **terminal:** keep a terminal's buffer from a command's send until its start mark ([a49db12](https://github.com/mramdann/anbo-ai/commit/a49db12a86b41f70e0002f272a7552bc8e885b15))
* **terminal:** keep an interrupted command open while its late start is watched ([3c01696](https://github.com/mramdann/anbo-ai/commit/3c0169688757dd1e0acfb50779dd187317eac5eb))
* **terminal:** keep the record of a command still out when a hundred newer ones came ([931fbc6](https://github.com/mramdann/anbo-ai/commit/931fbc6fbc0ea76bd3bdf4a6d98764fd7551c3a8))
* **terminal:** keep typed input in order while Anbo is busy ([c467675](https://github.com/mramdann/anbo-ai/commit/c467675140b4bd55c804d302637cbd6328f2f9fc))
* **terminal:** leave a dormant terminal asleep on terminal_read ([62c03af](https://github.com/mramdann/anbo-ai/commit/62c03af3af586ec25bc42573a22240acb64020a5))
* **terminal:** leave an agent_spawn terminal to its agent until it ends ([6c50dcf](https://github.com/mramdann/anbo-ai/commit/6c50dcf7fb60ec375d84235c9b5052bc746531f1))
* **terminal:** let Ctrl+C stop commands when Anbo was started from Git Bash ([81512e3](https://github.com/mramdann/anbo-ai/commit/81512e3bfcf2e46a5c3d31d41b8e58557923120b))
* **terminal:** let terminal_close end a stuck agent_spawn agent by force ([6d4975e](https://github.com/mramdann/anbo-ai/commit/6d4975e938ac49df81c9bdf3cc78909773f47a41))
* **terminal:** let terminal_close take back a terminal an agent CLI ran in ([d0abf74](https://github.com/mramdann/anbo-ai/commit/d0abf74ba296095c5a70db6bf284090b92177dc2))
* **terminal:** let terminal_interrupt clear an unfinished line ([7a31446](https://github.com/mramdann/anbo-ai/commit/7a314462088abfd38be8983840938197bc56e292))
* **terminal:** let the UI end the agent a forced terminal_close names ([b0d1b05](https://github.com/mramdann/anbo-ai/commit/b0d1b05ef54f6b8b853ec73937735b724afa50c1))
* **terminal:** never leave an agent locked out of its own terminal ([0975e81](https://github.com/mramdann/anbo-ai/commit/0975e81462e4044969078cd2bfee18a8c15c225a))
* **terminal:** quit a pager on terminal_interrupt ([57b4c24](https://github.com/mramdann/anbo-ai/commit/57b4c2418b08aa0cd8c9b15425573409236f3115))
* **terminal:** read a command its Ctrl+C stopped as interrupted when its end is read late ([cf6ff6a](https://github.com/mramdann/anbo-ai/commit/cf6ff6ae78fc6aa12c990baa7396258a7b19bcbf))
* **terminal:** read a re-wrapped terminal as a repaint, not as new output ([3b1cd96](https://github.com/mramdann/anbo-ai/commit/3b1cd969dd3dd203de940748a5d171663ed53626))
* **terminal:** report how an interrupted command ended and stop batch files ([f410797](https://github.com/mramdann/anbo-ai/commit/f41079764e678f40d1ebb8835f3ce884a5a56623))
* **terminal:** run agents' commands in Git Bash terminals ([7a579ec](https://github.com/mramdann/anbo-ai/commit/7a579ec2b6e9ee33579f88ef2d32c45b3438eff4))
* **terminal:** say why a terminal command was never sent ([c6aef03](https://github.com/mramdann/anbo-ai/commit/c6aef037731ef53a0225ce4862ce8b45cd940f39))
* **terminal:** send a late command its Ctrl+C, however late its shell starts it ([100848a](https://github.com/mramdann/anbo-ai/commit/100848af15af03f77f3a1bb91ba3f4f5388d51de))
* **terminal:** send an interrupt's Ctrl+C once the shell started the command ([150dbda](https://github.com/mramdann/anbo-ai/commit/150dbda8a036d11274ac24910d8c2070e5e02428))
* **terminal:** send one more Ctrl+C to a program made just before the first ([f473e1a](https://github.com/mramdann/anbo-ai/commit/f473e1a8b31b40a3b9de862a301996a30fbef6f6))
* **terminal:** send one more Ctrl+C to a program that started too late for the first ([ec1c9f8](https://github.com/mramdann/anbo-ai/commit/ec1c9f8ea1ea80b747832b4a9ad0121cc3d945e6))
* **terminal:** size the live buffer pool by memory and say who holds it ([4c795c2](https://github.com/mramdann/anbo-ai/commit/4c795c240484e6d1818b441c6068668a7a480368))
* **terminal:** start a wait's output at the command's echo ([4839835](https://github.com/mramdann/anbo-ai/commit/4839835187e2c25e95170268bb6851af083570d7))
* **terminal:** start terminals that had not started instead of waiting on them ([94e8152](https://github.com/mramdann/anbo-ai/commit/94e815244817629fa07b75015054b2256a1648a2))
* **terminal:** stop PowerShell reporting an earlier program's exit code ([b6814e9](https://github.com/mramdann/anbo-ai/commit/b6814e9c029fb3c8c3859e275af690606846304e))
* **terminal:** stop replaying an old window as new output ([33a70b7](https://github.com/mramdann/anbo-ai/commit/33a70b78c9a44157e92d690cd54c619911012f5a))
* **terminal:** stop stacking a shell prompt in the scrollback on each restore ([779211a](https://github.com/mramdann/anbo-ai/commit/779211a01fc9e07cef7bf5a691011f2157b50835))
* **terminal:** tell the PTY a held resize when a terminal leaves its slot ([9405ebe](https://github.com/mramdann/anbo-ai/commit/9405ebec62dbf9dddff2fefae8565a8994fa7db3))
* **terminal:** wait a minute for a new shell's first prompt ([6bf8104](https://github.com/mramdann/anbo-ai/commit/6bf81042741757e52aab354b2ae0b87f6ec0930a))
* **voice:** copy a kept transcript through the native clipboard ([44d0086](https://github.com/mramdann/anbo-ai/commit/44d00862cc19463bdefd99bdba231393a4329926))
* **webview:** wake WebView2's pump only after the UI queue refused a post ([40b5a1d](https://github.com/mramdann/anbo-ai/commit/40b5a1deda52a0c64bdeb928c2244d4627e7463f))
* **windows:** give later WebView2 environments the main window's runtime ([93bad62](https://github.com/mramdann/anbo-ai/commit/93bad62bdac62528876d96fb23f0a688c07abde6))
* **windows:** stop the event loop runner being freed while it runs ([ba683ce](https://github.com/mramdann/anbo-ai/commit/ba683ceff84c81a4220faac21984fd2230fbd229))
* **windows:** wake WebView2's pump after a full message queue ([87d1207](https://github.com/mramdann/anbo-ai/commit/87d1207fe7b9904dc43a04998366642ccf5f698d))
* **window:** tell every webview when its window moves ([6c4285a](https://github.com/mramdann/anbo-ai/commit/6c4285adf2ae1e941ef37966454784047e80580a))

## [0.38.0](https://github.com/mramdann/anbo-ai/compare/v0.37.1...v0.38.0) (2026-10-11)


### Features

* **browser:** `browser_navigate` can wait for the page it opens (`waitFor`) ([ec11b0e](https://github.com/mramdann/anbo-ai/commit/ec11b0edc0a63f18c52cb9e0849cbb8a6408498d))
* **browser:** `browser_screenshot` can capture the whole page (`fullPage`) ([8ef0b73](https://github.com/mramdann/anbo-ai/commit/8ef0b73edbbe8e2b20f423419b21fae1692ac22d), [a305c46](https://github.com/mramdann/anbo-ai/commit/a305c462345fc89de7237305c939bd7d56c68eae))
* **browser:** `browser_network_requests` lists the requests a tab made, in Anbo's own tabs and in Chrome and Edge tabs (Anbo Browser Bridge 0.5.4, which a connected profile reloads to by itself); credential-shaped values in their URLs show as `<REDACTED>` ([faf1266](https://github.com/mramdann/anbo-ai/commit/faf1266c1fee9c83122a1c9af93844ac391dda2c), [0054076](https://github.com/mramdann/anbo-ai/commit/0054076188c4034bb839a2f87e4efd7f7c1d7480), [152e659](https://github.com/mramdann/anbo-ai/commit/152e659c8d2b6c3f9e42ea78f125db4b4b3ab4af))
* **browser:** `browser_emulate` says what size the page sees ([f4afd5b](https://github.com/mramdann/anbo-ai/commit/f4afd5bb31e48322befd35e27109e25328cb760c), [319f51d](https://github.com/mramdann/anbo-ai/commit/319f51da2361e8b3a202f51e9202df3986fdd6e0))
* **browser:** a find or a locator that waits out its whole deadline says why ([18f351a](https://github.com/mramdann/anbo-ai/commit/18f351ae3f83ab553171599a8e6507d9bdda053c))


### Bug Fixes

* **windows:** pressing Alt on its own no longer leaves Anbo unresponsive until the next key ([faab76c](https://github.com/mramdann/anbo-ai/commit/faab76cff07ae60d27b7c8f7a7b36508ad33af68))
* **launch:** a folder opened with Anbo while it is still starting now opens ([8763709](https://github.com/mramdann/anbo-ai/commit/87637095386c65929d01ab20894f3eadd9dd04eb))
* **browser:** browser tabs keep opening after Windows updates WebView2 in the background ([dad1830](https://github.com/mramdann/anbo-ai/commit/dad18304c0a66eba058380b08073b9a808fe497f))
* **browser:** `browser_press` presses combos such as Control+A and the key names agents write, and takes `keys` ([5f72138](https://github.com/mramdann/anbo-ai/commit/5f72138b83a7300556aed03edf5f31306c3b2d87))
* **browser:** a blocked click, hover or drag names what covers the element and where it is free, and a drag under a cover that stays answers sooner ([7c32756](https://github.com/mramdann/anbo-ai/commit/7c32756c9a9cbdc8b13906a3adc4c3aac65c462a), [bf03cb0](https://github.com/mramdann/anbo-ai/commit/bf03cb048ba43b51a98a971d7aa2abb7908d8de6))
* **browser:** hidden browser tabs keep the size they will be shown at, so switching workspaces no longer resizes their pages ([9818627](https://github.com/mramdann/anbo-ai/commit/98186279bb448a5eab263bd7b8a9d9f4552edb7f), [63fd6f3](https://github.com/mramdann/anbo-ai/commit/63fd6f3955f8bd0c0d45eadd050e26ac8e9ee98c))
* **voice:** the AnboVoice orb no longer grows in memory while browser tabs open and close; the browser history and the workspace layouts move out of the window's local storage once, on the first start ([4991cb9](https://github.com/mramdann/anbo-ai/commit/4991cb931286a032ba94ecfa5e9e4e89a2d70b49), [fcdd51a](https://github.com/mramdann/anbo-ai/commit/fcdd51a874bc7a4ee2944208d5a33b11badc9b93), [539ae3a](https://github.com/mramdann/anbo-ai/commit/539ae3a5de95598979de36c140f0996c74197ddc))
* **voice:** Settings writes the hands-free shortcut as Windows does ([9cd8c3d](https://github.com/mramdann/anbo-ai/commit/9cd8c3d9d31f1a7001e6648c9e00540aaa4158f2))

## [0.37.1](https://github.com/mramdann/anbo-ai/compare/v0.37.0...v0.37.1) (2026-10-10)


### Bug Fixes

* **voice:** show a hidden orb while it listens, without taking focus ([618ae90](https://github.com/mramdann/anbo-ai/commit/618ae90dc8284d44c8acafa7fe69097083fc9510))
* **windows:** open Settings and the voice orb after WebView2 updates itself ([d05fac8](https://github.com/mramdann/anbo-ai/commit/d05fac8a598e279d169d848cbe057bf6e2fb7c18))

## [0.37.0](https://github.com/mramdann/anbo-ai/compare/v0.36.2...v0.37.0) (2026-10-10)


### Features

* **voice:** hold Win to talk with the global AnboVoice orb ([e918f45](https://github.com/mramdann/anbo-ai/commit/e918f45b791e5506eb416eb529efeee50f69d98f))
* **voice:** type a hands-free take sentence by sentence ([7309822](https://github.com/mramdann/anbo-ai/commit/7309822d943e2aef73c9ba92f4b80b30c10ee50e))
* **voice:** choose the language voice input listens for ([11f8cdb](https://github.com/mramdann/anbo-ai/commit/11f8cdb102ff0c5353dd0ad05111df6a9d3d8c60))

## [0.36.2](https://github.com/mramdann/anbo-ai/compare/v0.36.1...v0.36.2) (2026-10-09)


### Bug Fixes

* **dev:** reload the page once when a module the entry imports changes ([c409043](https://github.com/mramdann/anbo-ai/commit/c409043852fb63b21ef732aa4113faac43348ba9))
* **explorer:** use Windows names for the file manager and Recycle Bin ([80451f1](https://github.com/mramdann/anbo-ai/commit/80451f15d4dd8410d7c970d4fddc981c5d8da6ca))
* hand a second Anbo launch to the running window ([fd2a3a0](https://github.com/mramdann/anbo-ai/commit/fd2a3a0368f9f77e073420eef562dd4f13b7f47f))
* keep the window title on the shown space ([954a835](https://github.com/mramdann/anbo-ai/commit/954a83551723f462e4f9f1327b3021d62e566d81))
* open launch files after the saved spaces come back ([e314eb4](https://github.com/mramdann/anbo-ai/commit/e314eb41323fbfe8af3f18dddeee99b0ff70871e))
* **shortcuts:** match Shift symbol shortcuts by the physical key ([ffc4939](https://github.com/mramdann/anbo-ai/commit/ffc4939534233730cbfc31ad46a2e4c1dd517818))
* **tabs:** activate a file tab opened while another update is pending ([09e55b3](https://github.com/mramdann/anbo-ai/commit/09e55b327d81cb3d3fcf71070274d19fca93c38c))

## [0.36.1](https://github.com/mramdann/anbo-ai/compare/v0.36.0...v0.36.1) (2026-10-08)


### Bug Fixes

* **window:** keep the main window and Settings inside the screen ([40dc4d7](https://github.com/mramdann/anbo-ai/commit/40dc4d726ca2f08b2e98f9288abd6c30dc258299))


### Performance Improvements

* **build:** ship one marked instead of two ([898ad3e](https://github.com/mramdann/anbo-ai/commit/898ad3e0259b36f3e173b271a0c4d127581f80c9))

## [0.36.0](https://github.com/mramdann/anbo-ai/compare/v0.35.3...v0.36.0) (2026-10-08)


### Features

* **browser:** reload the extension by itself after an update ([877a9c5](https://github.com/mramdann/anbo-ai/commit/877a9c5a319238af6149f5d316ff0def966a8963))


### Bug Fixes

* **settings:** log why Settings or the AnboVoice orb does not open ([49dfd53](https://github.com/mramdann/anbo-ai/commit/49dfd530a25bf717f47296960b7e9d7c522ff15c))
* **terminal:** paste once and reliably on Windows ([9950ccd](https://github.com/mramdann/anbo-ai/commit/9950ccda9ebf76a71923e9ac3ea96f665a18a244))
* **window:** square the window when maximized and round it by 8 px on Windows ([3e8d96f](https://github.com/mramdann/anbo-ai/commit/3e8d96f234b61b55968a807b68cbb189c595090b))


### Performance Improvements

* **browser:** let an open's own find run before the dock takes the tab ([a0cb8f3](https://github.com/mramdann/anbo-ai/commit/a0cb8f3af3630075c491d83dd4d070183051eae8))

## [0.35.3](https://github.com/mramdann/anbo-ai/compare/v0.35.2...v0.35.3) (2026-10-07)


### Bug Fixes

* **agents:** never restart an agent the user just exited ([7a95465](https://github.com/mramdann/anbo-ai/commit/7a954651efd7cdb8fb8794ec959c220414c09717))
* **browser:** build the outdated-extension check on every host ([7186b03](https://github.com/mramdann/anbo-ai/commit/7186b03c99edcdffbfd2281f7d3cd8fa5b19fc98))
* **browser:** end an agent's focus emulation in Chrome and Edge tabs ([3181e42](https://github.com/mramdann/anbo-ai/commit/3181e423641f3484d881b9ec9ca9f075848e349d))
* **browser:** keep the dock window when another tab of the same profile shows ([36ddec6](https://github.com/mramdann/anbo-ai/commit/36ddec6ecae0c05ff7c47c6dd33303322f85a2e4))
* **browser:** keep the docked page in its panel when another panel shows one ([0cd7ca3](https://github.com/mramdann/anbo-ai/commit/0cd7ca3bc2e429fe7b9013588df429718dd7129a))
* **browser:** show a docked Chrome page whose page window stays hidden ([70dcf06](https://github.com/mramdann/anbo-ai/commit/70dcf0641ab41313e23c067e2b80fb64bc9eb391))

## [0.35.2](https://github.com/mramdann/anbo-ai/compare/v0.35.1...v0.35.2) (2026-10-06)


### Bug Fixes

* **browser:** bring a hidden Chrome or Edge tab forward before pointer input ([d4a6067](https://github.com/mramdann/anbo-ai/commit/d4a60673bd14514f87b641f8b76399148f50cb2a))
* **browser:** keep Anbo from staying on top after a dock opens ([1f0654f](https://github.com/mramdann/anbo-ai/commit/1f0654f7d8ee9923096d981f86642600d72e40d5))
* **browser:** leave citation links out of snapshots and clip text at a word ([db72366](https://github.com/mramdann/anbo-ai/commit/db72366d909376da3bcf4e4a2d049e48ef586452))
* **browser:** name the element that replaced a stale ref ([47fc27c](https://github.com/mramdann/anbo-ai/commit/47fc27c22f573bb421d667ec3285f9819c668127))
* **browser:** never replace the native host with an empty sidecar ([9239e13](https://github.com/mramdann/anbo-ai/commit/9239e1375ee8c969c8947e44807328b2dd56109f))
* **browser:** report what a click posts to a live region ([6b76b46](https://github.com/mramdann/anbo-ai/commit/6b76b46c1cdbf2af6ff4e454e72ca502f6ad2163))
* **browser:** say which tabs are the caller's in browser_tabs ([152812c](https://github.com/mramdann/anbo-ai/commit/152812c32d80b76e2f6972b5d3f5856aaf2ec4ef))
* **browser:** wait out a loading message before an open's snapshot closes the tab ([48d25e6](https://github.com/mramdann/anbo-ai/commit/48d25e65a7fc16d1991fe0f1f107afae98065e2f))
* **installer:** close a lingering Anbo by name and time the update wait by the clock ([2768cb0](https://github.com/mramdann/anbo-ai/commit/2768cb0ffcfc2987fff1fc9e0598e32bf0d14429))
* **installer:** give the hook's functions the real anbo.exe path and end leftovers without the plugin ([b44ea4b](https://github.com/mramdann/anbo-ai/commit/b44ea4bfb99a83dede39601455ca20264117b508))
* **installer:** move the old executables aside so an update gets past "Failed to kill Anbo" ([737dd3b](https://github.com/mramdann/anbo-ai/commit/737dd3be7a2934e321b017bf0b97b3d48cf0f1d3))

## [0.35.1](https://github.com/mramdann/anbo-ai/compare/v0.35.0...v0.35.1) (2026-10-05)


### Bug Fixes

* **agents:** keep a custom launcher's own name, resume command and MCP switch ([483cef8](https://github.com/mramdann/anbo-ai/commit/483cef8979a1e4450bad056782f56b034b46a0d4))
* **browser:** bring an earlier browser Setup up to date after an update ([dca31f3](https://github.com/mramdann/anbo-ai/commit/dca31f38550731bc1a6c27865a02a8409925e54a))
* **browser:** drop the development wording from the bridge setup error ([f4bde4e](https://github.com/mramdann/anbo-ai/commit/f4bde4e68bb98831134f60e0856943728a5e9f50))
* **browser:** let agents open pages while the Chrome/Edge service is down ([9d4f6d3](https://github.com/mramdann/anbo-ai/commit/9d4f6d34f9165f451f1e5664b4d3bfaea6539d99))

## [0.35.0](https://github.com/mramdann/anbo-ai/compare/v0.34.0...v0.35.0) (2026-10-05)


### Features

* **browser:** open the Chrome and Edge preview in production builds ([bbb0d69](https://github.com/mramdann/anbo-ai/commit/bbb0d690af09dcb8561876520e8f56f9850b0d01))


### Bug Fixes

* **browser:** drop the development wording from the browser extension ([b5a56ab](https://github.com/mramdann/anbo-ai/commit/b5a56abfb8ff5841519c2fc405a50deb801047c4))
* **installer:** name what still holds anbo.exe when an update cannot start ([cebc2ae](https://github.com/mramdann/anbo-ai/commit/cebc2aea7007422e54d2b5333fdb8bce53600974))
* **installer:** wait for Anbo to exit before an update's running-app check ([e50165e](https://github.com/mramdann/anbo-ai/commit/e50165e7af85f26dba4148ef355b74a9bf0a1e33))

## [0.34.0](https://github.com/mramdann/anbo-ai/compare/v0.33.7...v0.34.0) (2026-10-05)


### Features

* **header:** show the AnboVoice toggle with a speech-to-text icon ([daee749](https://github.com/mramdann/anbo-ai/commit/daee7491376cb6ac22989c1538979a983915de17))
* **tabs:** give hidden browser tabs the browser panel's size ([8ec59b8](https://github.com/mramdann/anbo-ai/commit/8ec59b82e96e5c982663e1f5f0f89616f34b0801))
* **tabs:** tidy workspace layouts that keep browser tabs in one panel ([36718a1](https://github.com/mramdann/anbo-ai/commit/36718a152788d9e205e24c0b802d0744f7f4065e))

## [0.33.7](https://github.com/mramdann/anbo-ai/compare/v0.33.6...v0.33.7) (2026-10-04)


### Bug Fixes

* find the main window while it hosts browser tabs ([900a392](https://github.com/mramdann/anbo-ai/commit/900a39245b3074dc60ec7e83b82b20cc9a930c0d))
* **settings:** open Settings over the main window on Windows ([2a49e6a](https://github.com/mramdann/anbo-ai/commit/2a49e6abaedfbb6c6ae6f7d574d0cd23386ec245))
* **settings:** stop the Settings window growing each time it opens ([e2d9f29](https://github.com/mramdann/anbo-ai/commit/e2d9f297e82509972097e930800c8c086ac185cd))
* **tabs:** lay out background tabs at the size they get once shown ([6337b37](https://github.com/mramdann/anbo-ai/commit/6337b37acf88d436d7ec09d39dbfd5dffc013897))
* **voice:** keep the global voice orb at its 122x42 design size ([d5abb1a](https://github.com/mramdann/anbo-ai/commit/d5abb1ae7a3ca5713aa773c04f6a0d2d76739bfc))

## [0.33.6](https://github.com/mramdann/anbo-ai/compare/v0.33.5...v0.33.6) (2026-10-04)


### Bug Fixes

* **browser:** end connected agents when browser automation is turned off ([caad4c5](https://github.com/mramdann/anbo-ai/commit/caad4c5878c369b6d417c1d3d0ccd8ce6de27e92))

## [0.33.5](https://github.com/mramdann/anbo-ai/compare/v0.33.4...v0.33.5) (2026-10-04)


### Bug Fixes

* **ai:** keep custom endpoint models and retire Groq's withdrawn ones ([bee5c50](https://github.com/mramdann/anbo-ai/commit/bee5c50e8c89ea50d9f9443f1a3f4b1bafcd59a5))
* **ai:** let go of a removed custom endpoint in every window ([76369d0](https://github.com/mramdann/anbo-ai/commit/76369d0d70152e0812334b364449779b52a80268))
* **browser:** hold keys until a new document or viewport settles ([27107c3](https://github.com/mramdann/anbo-ai/commit/27107c35e44154ca3d5a9387ec48a686a51acc95))
* **browser:** say which app holds the MCP port, and offer a retry ([ac684e5](https://github.com/mramdann/anbo-ai/commit/ac684e53d17e18397f12a697d1241c7e3aa6b63b))
* **settings:** show the browser automation switch as it was set ([e6f5bb3](https://github.com/mramdann/anbo-ai/commit/e6f5bb316814c3565e10a2b004a652b0b681e22b))
* **source-control:** build the commit message model with custom endpoints ([023a501](https://github.com/mramdann/anbo-ai/commit/023a501739c9422fd0d474f151a029423c903aac))

## [0.33.4](https://github.com/mramdann/anbo-ai/compare/v0.33.3...v0.33.4) (2026-10-03)


### Bug Fixes

* **browser:** reap a leftover browser host only when it is the same process ([2256425](https://github.com/mramdann/anbo-ai/commit/2256425adf3db5e58032eed78ff176d68fe2e9ff))


### Performance Improvements

* **ai:** bundle only the SDK calls the lazy paths take ([64461dd](https://github.com/mramdann/anbo-ai/commit/64461dd1186ccb87589c863d39679a8a8092bc88))

## [0.33.3](https://github.com/mramdann/anbo-ai/compare/v0.33.2...v0.33.3) (2026-10-02)


### Bug Fixes

* **browser:** keep text a slot does not render out of the snapshot ([b3c628a](https://github.com/mramdann/anbo-ai/commit/b3c628aa71e94aa5669e5c71ced4a091fd464e54))
* **browser:** wait out a timeout the caller wrote before giving up ([46c57bd](https://github.com/mramdann/anbo-ai/commit/46c57bdd0cd4b854bc7c1c1ec1cc5eba5ea3cb3a))

## [0.33.2](https://github.com/mramdann/anbo-ai/compare/v0.33.1...v0.33.2) (2026-10-02)


### Bug Fixes

* **agents:** stop counting Antigravity's sign-in as a turn ([bb8cfbe](https://github.com/mramdann/anbo-ai/commit/bb8cfbe19c6017e3ab6b7f2319eaeb3c6f1f28a5))
* **browser:** describe press, type and session ending the way they work ([093112f](https://github.com/mramdann/anbo-ai/commit/093112f84f6d96c5443df946145b1c7b9a1f9737))

## [0.33.1](https://github.com/mramdann/anbo-ai/compare/v0.33.0...v0.33.1) (2026-10-01)


### Bug Fixes

* **agents:** read Kimi's trust chooser when its MCP list pushes the title away ([2e7d859](https://github.com/mramdann/anbo-ai/commit/2e7d8592ef5f95fcda537481d065d187fb962fb8))
* **tabs:** show the + menu's real shortcuts ([c2c83e7](https://github.com/mramdann/anbo-ai/commit/c2c83e707560dc8c62634d3feb8a548af471c2d1))

## [0.33.0](https://github.com/mramdann/anbo-ai/compare/v0.32.0...v0.33.0) (2026-10-01)


### Features

* **agents:** choose the sound that plays with an agent alert ([8b74570](https://github.com/mramdann/anbo-ai/commit/8b74570edf6ac7329a3533d917e49b0fd7f7b472))
* **agents:** show how long a turn runs and count only what needs you ([1d7cd0b](https://github.com/mramdann/anbo-ai/commit/1d7cd0bb44fc6169a3a94909dc068f9e771a3526))
* **browser:** dock external Chrome and Edge tabs under Anbo ([68bcd1a](https://github.com/mramdann/anbo-ai/commit/68bcd1a8508b9549110398d2794c972d543c8a94))
* **browser:** fold profiles in the browser menu and show browser logos ([3d3a630](https://github.com/mramdann/anbo-ai/commit/3d3a630f5f67f6742f453e91867de43995dc3fdf))
* **browser:** keep new tabs in Anbo's browser and give each profile a New tab ([b6ed038](https://github.com/mramdann/anbo-ai/commit/b6ed0382822542cc03225549be2743ab0f23873e))
* **browser:** name a connecting profile the way its browser does ([614b19a](https://github.com/mramdann/anbo-ai/commit/614b19a5570691099d51dd8e7d1367bdf22b7433))
* **browser:** name the external browser menu by what it holds ([4b135ea](https://github.com/mramdann/anbo-ai/commit/4b135ea9079d823d71410912fa38a618669ee07d))
* **browser:** show connected Chrome and Edge pages by themselves ([1fe2499](https://github.com/mramdann/anbo-ai/commit/1fe2499665ceb442d2f14d60824b035d869a2e7b))
* **browser:** show the browser's logo in place of Ports in an external tab ([d62404c](https://github.com/mramdann/anbo-ai/commit/d62404c7431b8ce5e81ecf7935af77757a072ad9))
* **extension:** Anbo icons, a clearer popup, and redirects on open ([2878300](https://github.com/mramdann/anbo-ai/commit/2878300bacc30e8f7c03391ca2c42cbf56931e92))
* **extension:** keep a docked page in Anbo when it opens a tab ([bb5023a](https://github.com/mramdann/anbo-ai/commit/bb5023adda8f1e538910e8b8a0b8c0f2e4388d81))


### Bug Fixes

* **agents:** read agent status from the rows the terminal draws ([6cef98e](https://github.com/mramdann/anbo-ai/commit/6cef98e032aba007f182035fabe4f01241699608))
* **agents:** read Codex 0.159, agy's command list and OpenCode's start screen ([deb043a](https://github.com/mramdann/anbo-ai/commit/deb043afd9c9d00e1dea100ca4c95bce9c2470f1))
* **agents:** show turn time in one unit ([f74a7ba](https://github.com/mramdann/anbo-ai/commit/f74a7ba7c4aea0f2e8581ddcb6f7e2e85afed956))
* **browser:** cut no hole for a toast that is still transparent ([cd27f7e](https://github.com/mramdann/anbo-ai/commit/cd27f7eb5940275ddaacc80b2899a7edc77cf304))
* **browser:** drop the Chrome or Edge link from the start page ([200a9c5](https://github.com/mramdann/anbo-ai/commit/200a9c5bd722224aff0d9a2fce7813f0b6309ba0))
* **browser:** keep a connected browser's extension process scheduled ([a0647b9](https://github.com/mramdann/anbo-ai/commit/a0647b9bd4beb9f33bd8703f69a878de71606cf4))
* **browser:** keep a new page's about:blank out of its tab ([ec588e2](https://github.com/mramdann/anbo-ai/commit/ec588e2f0f1fe99f589ae89cf2f879f85f8f8670))
* **browser:** keep the dock window out of the topmost band during attach ([4e3810b](https://github.com/mramdann/anbo-ai/commit/4e3810b34636e3170c203a63e33bf2e32ebf58b4))
* **browser:** keep the external browser's Windows-only code from failing other platforms ([e085412](https://github.com/mramdann/anbo-ai/commit/e08541272fd84d48bdbbeb7a393a3faa5877c042))
* **browser:** keep the native host module out of the bundler's binaries ([1e96a36](https://github.com/mramdann/anbo-ai/commit/1e96a3640146389e6f5e40dfae3d2cc5d8368d89))
* **browser:** keep the page through a hot update of the browser pane ([6986431](https://github.com/mramdann/anbo-ai/commit/698643177d68e1c42f6db37239a983abdb997b5d))
* **browser:** put a reopened workspace's pages up before the voice orb ([0faaed6](https://github.com/mramdann/anbo-ai/commit/0faaed632dfdcf07da76bc3c0e323323d6b3fc7c))
* **browser:** show toasts over the native browser without flashes ([27347d5](https://github.com/mramdann/anbo-ai/commit/27347d5e17e4ba5a09b08f6bce0d4de4c1883534))
* **browser:** start the setup browser through the shell and explain extension pages ([e9f743b](https://github.com/mramdann/anbo-ai/commit/e9f743b5e9489caf1e0fa0317c1207f53bc230b3))
* **browser:** stop losing Chrome and Edge tabs to slow commands ([bfc7058](https://github.com/mramdann/anbo-ai/commit/bfc70587c94b01dc60651e6182a3f4a5ed465591))
* **sidebar:** give the sidebar its width back after a minimize squeezes it ([478aa57](https://github.com/mramdann/anbo-ai/commit/478aa57139ac310aad4d6bdff335142a89fa2708))
* **tabs:** keep a workspace's split when its Dockview is put up again ([1af0881](https://github.com/mramdann/anbo-ai/commit/1af0881204e098e3e160ecbed3afc572f874b084))
* **voice:** retry a Groq upload lost to a dead connection and log every failure ([6ed324d](https://github.com/mramdann/anbo-ai/commit/6ed324d8f4688062e37c92c30a574c19bdd83538))


### Performance Improvements

* **agents:** load the alert sounds with the first alert or preview ([db58c4a](https://github.com/mramdann/anbo-ai/commit/db58c4a94de3500095fe44fe5e6cf5ddf4af8238))

## [0.32.0](https://github.com/mramdann/anbo-ai/compare/v0.31.0...v0.32.0) (2026-09-26)


### Features

* **browser:** carry navigation hints and settle submits in action replies ([ed2e3bc](https://github.com/mramdann/anbo-ai/commit/ed2e3bc3fb98d016b99762086030bde0d8b4b595))
* **browser:** land with result titles, a visible heading and SPA routes ([7976175](https://github.com/mramdann/anbo-ai/commit/797617574eb29963e5ea2536917f53d97de314e0))
* **browser:** let agents in several workspaces drive the browser at once ([7bb3893](https://github.com/mramdann/anbo-ai/commit/7bb389350499a53fc04ee9d007ce2ccab4b3cae3))
* **browser:** read an enclosing block via browser_get_text ancestors ([94b58e6](https://github.com/mramdann/anbo-ai/commit/94b58e674d8b97b4ebba2bc96b2232c46ff01279))
* **browser:** read the page in the same browser_open call ([b47fd3f](https://github.com/mramdann/anbo-ai/commit/b47fd3f7e031e1c3578c991f72dd5f2bd9d0cb73))
* **browser:** register hint controls as live refs ([3925f0c](https://github.com/mramdann/anbo-ai/commit/3925f0cee2e667a98124dcbaccbf3e62e8a71e6d))
* **browser:** return what the next call would have asked for ([a81ea0d](https://github.com/mramdann/anbo-ai/commit/a81ea0d1b333fa39b1847730d4dd562914d9b367))
* **browser:** reveal from a pre-fill baseline and guard the native retype ([2d9ee4d](https://github.com/mramdann/anbo-ai/commit/2d9ee4d1de453f4030eaa2866bbb5e991f94a9e2))
* **browser:** reveal opened surfaces + native re-type + find ancestors ([df2d688](https://github.com/mramdann/anbo-ai/commit/df2d688d1de9687261a43c4687336bf7512f142e))
* **browser:** settle locator ambiguity from what the page shows ([73da562](https://github.com/mramdann/anbo-ai/commit/73da5629661f94598dda8ee69ab172ec3cb2b4d5))
* **browser:** verify hover delivery and read text in one ready call ([ae5a5be](https://github.com/mramdann/anbo-ai/commit/ae5a5be839b7906773e6c7c926b98a14ce1f48be))
* **browser:** verifyValue canvas, force off-viewport type, focused-bypass, fast-fail hidden finds ([faf7a20](https://github.com/mramdann/anbo-ai/commit/faf7a20c00ac7ead94ff432a6d8b197365e704b0))


### Bug Fixes

* **agents:** lazy resume-on-reopen with a tab indicator ([f73df95](https://github.com/mramdann/anbo-ai/commit/f73df95d1b35e5cc356a44ad2faea6b2707e04d2))
* **agents:** read Kimi 2.0.2 and Antigravity subagents as working ([7574fbc](https://github.com/mramdann/anbo-ai/commit/7574fbc72d531b0c63de10a687ded4646eb9ef97))
* **browser:** act on what real agents tripped over in the moment of truth ([398c7e1](https://github.com/mramdann/anbo-ai/commit/398c7e154dbfadf28d43b18ebc1b2711332a4ada))
* **browser:** collapse the cursor card detail after a successful action ([851318b](https://github.com/mramdann/anbo-ai/commit/851318b17b9c528953f90bded02e48ce64e78406))
* **browser:** keep WebView2 155 live streams from killing the tab's network ([a466f06](https://github.com/mramdann/anbo-ai/commit/a466f06f33fcb1e2e44709755a722063b83cff19))
* **browser:** let a searchbox lookup reach editable comboboxes ([4e30cda](https://github.com/mramdann/anbo-ai/commit/4e30cda2b0939aab0cf1530125dc1eb763a813f1))
* **browser:** point a stale get_text ref at the locator path ([ccb05a9](https://github.com/mramdann/anbo-ai/commit/ccb05a9f209241f20671f065a1072d186edb2f22))
* **browser:** wait for the navigation commit behind a submit and in-flight hints ([32c7e66](https://github.com/mramdann/anbo-ai/commit/32c7e66c24437147eef5d814ad6d11d9e7fdb523))
* **tabs:** keep tab layouts across launches and stop idle repaints ([b1d4c47](https://github.com/mramdann/anbo-ai/commit/b1d4c47f408ca9ca7b81304d4765f0970a45292c))
* **voice:** log every dictation failure and keep a moved xterm input ([7d2fef5](https://github.com/mramdann/anbo-ai/commit/7d2fef551ceb8cfdb724f538ada0045ac71f25dd))


### Performance Improvements

* **browser:** keep the WebView2 host warm between tabs ([ad2a35b](https://github.com/mramdann/anbo-ai/commit/ad2a35b0f603918b1155bf8449a7174aad57e55c))
* **browser:** let click stability reuse the call-time sample ([de79f8e](https://github.com/mramdann/anbo-ai/commit/de79f8e5a1cb5ab55450b3733685cf819e698fcd))
* **browser:** skip geometry sampling for a check already in its state ([b7a84f5](https://github.com/mramdann/anbo-ai/commit/b7a84f58988d17dde9dd76c2493937ef2c19de31))
* **browser:** time open and action phases under diagnostics ([0a2dfb6](https://github.com/mramdann/anbo-ai/commit/0a2dfb650bcda52e135cd790028111a86a3ad604))

## [0.31.0](https://github.com/mramdann/anbo-ai/compare/v0.30.0...v0.31.0) (2026-09-15)


### Features

* **browser:** group screenshots into task folders and sample actionability in-page ([23e790f](https://github.com/mramdann/anbo-ai/commit/23e790f53416d255a73f61087be537aea220c588))

## [0.30.0](https://github.com/mramdann/anbo-ai/compare/v0.29.0...v0.30.0) (2026-09-13)


### Features

* **browser:** let a session follow the agent instead of two tools ([8b8f4a4](https://github.com/mramdann/anbo-ai/commit/8b8f4a42a241d48353d3108b2b7f4dc38f26f7c0))
* **browser:** steer locators to observed targets and wait on a title prefix ([f570cff](https://github.com/mramdann/anbo-ai/commit/f570cff4da47c1f9cd8082e8a3222dcb42e5e49d))


### Bug Fixes

* **browser:** keep accepting MCP clients after the 128th session ([fcf837a](https://github.com/mramdann/anbo-ai/commit/fcf837ac6c0d8677368766bed64d797bdb003313))
* **browser:** keep the session sweep alive across a panicking pass ([a1835ab](https://github.com/mramdann/anbo-ai/commit/a1835ab80b6e5098d2462f651b52128972f2d8c2))
* **browser:** read a labelled odometer as its number, not aria-hidden digits ([eefb0ab](https://github.com/mramdann/anbo-ai/commit/eefb0ab25bccd6b504d33040846f1eb8ba8a19c1))
* **markdown:** show the rendered preview's scrollbar ([357e9e9](https://github.com/mramdann/anbo-ai/commit/357e9e98eff668a8d2b416a444873c63b13f5cfe))


### Performance Improvements

* **browser:** keep refs alive through later finds, and fill a form in one call ([38b4fbb](https://github.com/mramdann/anbo-ai/commit/38b4fbbe9455be8690cfd71a338c208591f67b51))
* **browser:** let a missed find hand back the controls it walked past ([0d12117](https://github.com/mramdann/anbo-ai/commit/0d121176a30cab59493c43990ae68d8ba4331f76))
* **browser:** tell a missed css find what the page has, and let drag pan by locator ([9bbb67c](https://github.com/mramdann/anbo-ai/commit/9bbb67ced1197eda4b8d1d4583fde6ec3cd880f8))

## [0.29.0](https://github.com/mramdann/anbo-ai/compare/v0.28.0...v0.29.0) (2026-09-12)


### Features

* **browser:** give design mode the app's theme and a pen icon ([c10da5e](https://github.com/mramdann/anbo-ai/commit/c10da5ea30fab0768426b2ba4d5cf5172db06664))
* **browser:** let the user mark up a page and hand it to an agent ([09579ca](https://github.com/mramdann/anbo-ai/commit/09579ca580ed617c79c93031177e2587195e9506))


### Bug Fixes

* **agents:** adopt a hand-started Kimi into resume ([3dd55f3](https://github.com/mramdann/anbo-ai/commit/3dd55f3b220f4954b038900094681065827eeb8d))
* **agents:** give Kimi the echoed-input path Codex already uses ([100df5a](https://github.com/mramdann/anbo-ai/commit/100df5a23aa8c007ccaed81801b5c803af4b7992))
* **agents:** press Enter on a prompt that has stopped moving ([e8797a9](https://github.com/mramdann/anbo-ai/commit/e8797a9def97f29995ec04297ded6664bd0ae295))
* **agents:** read a bypass-mode Claude prompt as ready ([2ae4991](https://github.com/mramdann/anbo-ai/commit/2ae499160ba59f3beecfae71164992c03c4276e7))
* **agents:** retry a restore-time resume the memory guard refused ([aeda244](https://github.com/mramdann/anbo-ai/commit/aeda2449b9ca6767650a7d0c4aa31cfa2263cfc0))
* **agents:** stop announcing a finished turn mid-answer ([9483c15](https://github.com/mramdann/anbo-ai/commit/9483c159402a3983a6cfdd26363c12cb54996dd6))
* **browser:** draw the note's remove control as an icon ([cca2c32](https://github.com/mramdann/anbo-ai/commit/cca2c32583ed0a3dde1d70cec2c9560d85f44ab8))
* **browser:** give design-mode restore a real tail on every platform ([bb4762c](https://github.com/mramdann/anbo-ai/commit/bb4762c7e78635e0afb4eb9a75651e39ba374b47))
* **browser:** keep the note editor on one line each ([03b13ce](https://github.com/mramdann/anbo-ai/commit/03b13ce1be506e9c857b7212fb6788694830090c))
* **browser:** keep the Windows-only screenshot path out of other platforms ([7c7789a](https://github.com/mramdann/anbo-ai/commit/7c7789adcf1e3dc155286f1c93f5731b20b8cc58))
* **browser:** name the agent driving a tab, not its CLI ([4721e86](https://github.com/mramdann/anbo-ai/commit/4721e8601d1570db28354e48a66d3cda7fdf19b4))
* **browser:** read an element's text the same way everywhere ([f2e98fe](https://github.com/mramdann/anbo-ai/commit/f2e98febaa32495f15f7403c52f2c260a3413564))
* **browser:** stop a failed lookup from costing the caller its refs ([38938d9](https://github.com/mramdann/anbo-ai/commit/38938d92fac199c4bfaa6465f5459ca148b89141))
* **browser:** tell a locator caller what actually happened ([3d060f4](https://github.com/mramdann/anbo-ai/commit/3d060f49dd93e31b00e486a32f350dd45df2a066))
* **browser:** work through the rest of the tool benchmark ([6e6c879](https://github.com/mramdann/anbo-ai/commit/6e6c879f022d445615fbe7f7e3255adbfbd29220))
* **pty:** strip Claude Code's session markers from spawned shells ([3d775e3](https://github.com/mramdann/anbo-ai/commit/3d775e3fdd3ca27bce27619802646a71a304b8a7))


### Performance Improvements

* **browser:** cut what an agent pays per task through MCP ([c6c5a19](https://github.com/mramdann/anbo-ai/commit/c6c5a19532ea42cefbf03d2a6c1d44f30dd690e0))
* **browser:** let one reply answer where the page landed and what state it holds ([e3a63a0](https://github.com/mramdann/anbo-ai/commit/e3a63a0423cdb97509c389f785f9db1cdd18513b))
* **browser:** stop a doomed find from burning its whole timeout ([b4fa576](https://github.com/mramdann/anbo-ai/commit/b4fa5765f300a67c275e8cfdcb1ce8643572c598))
* **browser:** stop re-walking a page that has not moved ([1e58e1c](https://github.com/mramdann/anbo-ai/commit/1e58e1cb1749bd92120bdcdbb1462b7dfbc75e39))

## [0.28.0](https://github.com/mramdann/anbo-ai/compare/v0.27.1...v0.28.0) (2026-09-10)


### Features

* **agents:** drive Kimi Code ([a0b69ec](https://github.com/mramdann/anbo-ai/commit/a0b69ec8f0c536b31c1453bd5b688b2062c749ae))
* **agents:** show the whole bench and say which CLIs this machine has ([9aaad19](https://github.com/mramdann/anbo-ai/commit/9aaad196ff45d4e0a4f952e145a6633e69bc1bd3))
* **browser:** give a controlling agent one session, visible on the tab and in the page ([99e00f3](https://github.com/mramdann/anbo-ai/commit/99e00f34d48f2996e876609c1d20fe0f2983de06))
* **browser:** make the session a gate, not a courtesy ([1368fb7](https://github.com/mramdann/anbo-ai/commit/1368fb7fee63334192755368fad3fc5e3381455b))


### Bug Fixes

* **agents:** assert a bool the way clippy asks ([0467ccf](https://github.com/mramdann/anbo-ai/commit/0467ccf62632a1df289117a5426f41228e166e03))
* **agents:** keep the status honest while an agent is working ([752b180](https://github.com/mramdann/anbo-ai/commit/752b180c1b30c0ae612ad57b1541df6854cb2444))
* **browser:** stop a tab from claiming an agent it cannot name ([1f95185](https://github.com/mramdann/anbo-ai/commit/1f951851dc9e1d02e5afcca9603f17febfb69a0b))
* **terminal:** stop Tailwind's invisible utility from hiding xterm's scrollbar ([ff373bd](https://github.com/mramdann/anbo-ai/commit/ff373bdd9ab6e3731d3b534507fa56a04cea147c))

## [0.27.1](https://github.com/mramdann/anbo-ai/compare/v0.27.0...v0.27.1) (2026-09-09)


### Bug Fixes

* **editor:** reach the whole file again in a packaged build ([bfdaf08](https://github.com/mramdann/anbo-ai/commit/bfdaf08a195abb62899e709142a18968bfd02983))
* **terminal:** restore the scrollbar on scrolled-back output ([11e9f14](https://github.com/mramdann/anbo-ai/commit/11e9f14d3fd4d8e21bb66969852a63885d541acb))

## [0.27.0](https://github.com/mramdann/anbo-ai/compare/v0.26.0...v0.27.0) (2026-09-09)


### Features

* **browser:** add guarded locators and resilient native lifecycle ([df7f47c](https://github.com/mramdann/anbo-ai/commit/df7f47cfdb06ed4d6f8a377d8a05a68bba3152b6))


### Bug Fixes

* **runtime:** preserve agent sessions and bound terminal resource usage ([f78b1e8](https://github.com/mramdann/anbo-ai/commit/f78b1e8b736cd49492b9e5629c1aeeb20e82b46b))
* **ui:** unify scrollbars and polish activity feedback ([2845d21](https://github.com/mramdann/anbo-ai/commit/2845d219152b4596ad93d2fee2c7957959972574))


### Performance Improvements

* **icons:** externalize Material assets and unify agent branding ([fa26709](https://github.com/mramdann/anbo-ai/commit/fa26709c8d637d348e793897d94bbb46e18bb470))

## [0.26.0](https://github.com/mramdann/anbo-ai/compare/v0.25.0...v0.26.0) (2026-09-08)


### Features

* **browser:** harden MCP execution and owned control sessions ([e846fda](https://github.com/mramdann/anbo-ai/commit/e846fdaaabdb81b988dbd153822cf057e92ccceb))
* **browser:** show branded control activity and outward tab pulses ([f3be87f](https://github.com/mramdann/anbo-ai/commit/f3be87fb46363c602512e93d824e4667bb1c08a9))
* **explorer:** add safe rename and recoverable file operations ([ec90ea9](https://github.com/mramdann/anbo-ai/commit/ec90ea91c4352537f770c45901cf6be058f16a74))
* **startup:** polish the theme-aware launch splash ([fd05a31](https://github.com/mramdann/anbo-ai/commit/fd05a319e3d660158be38b2881417b371cf4e515))


### Bug Fixes

* **tabs:** retain agent close-dialog copy during exit ([fbc6971](https://github.com/mramdann/anbo-ai/commit/fbc697134644fe127e208ade40f519910dd3e747))

## [0.25.0](https://github.com/mramdann/anbo-ai/compare/v0.24.0...v0.25.0) (2026-09-06)


### Features

* **agents:** the notification popover on the chrome's scale ([48b5d1a](https://github.com/mramdann/anbo-ai/commit/48b5d1ad72be0d7ea5cf8f139de77bbcd49223d7))
* **browser:** device emulation beside zoom, and tighter zoom controls ([405346c](https://github.com/mramdann/anbo-ai/commit/405346c57a862ad836cabb87d1debe4e54c0e151))
* **browser:** follow focus into the page ([0bfb5d4](https://github.com/mramdann/anbo-ai/commit/0bfb5d4e23fd1279208e0cc471625dfd5ba719a9))
* **header:** a quieter search field that counts its matches ([8c5d160](https://github.com/mramdann/anbo-ai/commit/8c5d160b1f6ee05526fbe31ae905993e04e326ba))
* **header:** the mark, search in the middle, one run of controls ([d9b5cc1](https://github.com/mramdann/anbo-ai/commit/d9b5cc14fda60e82af5a2be4f478aab6fc3536da))
* **landing:** introduce Anbo before asking for a folder ([bd158d7](https://github.com/mramdann/anbo-ai/commit/bd158d7b4dcaa3c6e6876a5427f4d72f73c4c49c))
* **statusbar:** menus and breadcrumb on the bar's own scale ([e57bc4e](https://github.com/mramdann/anbo-ai/commit/e57bc4ec7496953dbd087314e55ef86387c7b75b))
* **tabs:** a shorter tab strip with its actions centred ([8f1f6f5](https://github.com/mramdann/anbo-ai/commit/8f1f6f5409ac8676ead12c259c5e5e23b33ad19b))
* **terminal:** repaint glyphs once the fonts arrive ([a49b98f](https://github.com/mramdann/anbo-ai/commit/a49b98fde4b28750ad7cf265eec33e3923ebd651))
* **updater:** a solid update button with a light crossing it ([d02b9bf](https://github.com/mramdann/anbo-ai/commit/d02b9bfb3364da5f30ce23675d95975d5065b0ea))
* **workspace:** a launch deck for an empty workspace ([7d35a0e](https://github.com/mramdann/anbo-ai/commit/7d35a0e37526c64501a2f313e70e2c9a4513d4d6))


### Bug Fixes

* **spaces:** let the last workspace be deleted ([f60e62e](https://github.com/mramdann/anbo-ai/commit/f60e62ea6d5d3e058f935340389098afbd6d23f4))
* **spaces:** stop opening a shell nobody asked for ([1cb559d](https://github.com/mramdann/anbo-ai/commit/1cb559d18b09e45bf0da6cccd818662de4131bd0))
* **tabs:** dress only the focused group's active tab, whole at both ends ([e89814f](https://github.com/mramdann/anbo-ai/commit/e89814f789c0fb0e181030143aa6915da34a4867))
* **updater:** a sheen the CSS minifier can pass through ([bd1d064](https://github.com/mramdann/anbo-ai/commit/bd1d064cb003b2e0b8e72639dbefbc17bd19e46b))
* **voice:** the header toggle hides and shows the global orb ([4dcbaba](https://github.com/mramdann/anbo-ai/commit/4dcbabaaa9b143ab0426c2d6fa106576775bff82))


### Performance Improvements

* **startup:** keep the launch deck and landing page out of the startup bundle ([7f239b7](https://github.com/mramdann/anbo-ai/commit/7f239b7fe999eeebd79944e2f5d763666c6f925f))

## [0.24.0](https://github.com/mramdann/anbo-ai/compare/v0.23.0...v0.24.0) (2026-09-05)


### Features

* **agents:** call an agent by its name, not its address ([22f5f75](https://github.com/mramdann/anbo-ai/commit/22f5f750f04133ea1af3d98e0db8833e8d5f8723))
* **mcp:** give agents skills, and one that explains Anbo ([c2ef515](https://github.com/mramdann/anbo-ai/commit/c2ef51585938cbfa050edb179f5f6727019784e5))
* **mcp:** tell every agent about its skills on connect ([9e0050f](https://github.com/mramdann/anbo-ai/commit/9e0050fcb32aa23b6d7afa05b59eddc550bd5d69))
* **voice:** fit the local runtime to the machine it runs on ([ad5e32a](https://github.com/mramdann/anbo-ai/commit/ad5e32abaabcff69889c3930a9bd84e4e39bcaf6))
* **voice:** let the model follow the machine by default ([2758c25](https://github.com/mramdann/anbo-ai/commit/2758c25936ff19e201d0dc21a870aacc66283da2))


### Bug Fixes

* **release:** restore the version marker cargo stripped from Cargo.lock ([4d3b06d](https://github.com/mramdann/anbo-ai/commit/4d3b06d15d670447e8f35a42d841dc1d939ee4c7))


### Performance Improvements

* **voice:** stop paying for the same answer every two seconds ([1f0387c](https://github.com/mramdann/anbo-ai/commit/1f0387c115d0bcbe11fc6e9bbc27d6bd062aa0a3))

## [0.23.0](https://github.com/mramdann/anbo-ai/compare/v0.22.0...v0.23.0) (2026-09-05)


### Features

* **updater:** announce updates with a button, not a popup ([98ee285](https://github.com/mramdann/anbo-ai/commit/98ee285119ea769d4157826547459d0fd3bf03b0))


### Bug Fixes

* **header:** keep the update button out of the startup budget ([f84f20e](https://github.com/mramdann/anbo-ai/commit/f84f20e44115e9598c54c9d1d26460fa618abce5))
* **release:** put the changelog in the update the user sees ([7553cae](https://github.com/mramdann/anbo-ai/commit/7553cae388f260625d843065302e2cd644a221b4))

## [0.22.0](https://github.com/mramdann/anbo-ai/compare/v0.21.0...v0.22.0) (2026-09-04)


### Features

* **app:** stamp the build version on the startup screen ([c8593ee](https://github.com/mramdann/anbo-ai/commit/c8593eeed5b5ef93e6eedaf75277c879f400b58e))
* **browser:** emulate a device viewport in a tab ([eef40da](https://github.com/mramdann/anbo-ai/commit/eef40da718159405269251f575673adab440e8db))
* **browser:** open links in Anbo, and hide voice until it works ([10fef47](https://github.com/mramdann/anbo-ai/commit/10fef47eabcaf15c4de8ef95aa5fb26c00d62ca8))
* **voice:** give local Whisper a home, a GPU, and honest feedback ([20d8ed9](https://github.com/mramdann/anbo-ai/commit/20d8ed989e5dc3a3b5255ea67dbf7c7cbf6c5c7b))


### Bug Fixes

* **agents:** stop cancelling long first messages to OpenCode ([cf3c50a](https://github.com/mramdann/anbo-ai/commit/cf3c50a19d74cf0288e3020cae0508b4b3074314))
* **browser:** make tab lifecycle survive churn and workspace switching ([e4dab59](https://github.com/mramdann/anbo-ai/commit/e4dab59fed0b04ff648d87a55a32c57141f89cc0))
* **logging:** keep enough log history to diagnose a long session ([2530f9c](https://github.com/mramdann/anbo-ai/commit/2530f9c51d52051dacd0497624cba551573c67b3))


### Performance Improvements

* **browser:** stop repeating work on every geometry update ([120e159](https://github.com/mramdann/anbo-ai/commit/120e1594eb17fb8fa7281e82b9a51d347a8b6604))

## [0.21.0](https://github.com/mramdann/anbo-ai/compare/v0.20.0...v0.21.0) (2026-09-04)


### Features

* **agents:** split in-app and system notifications ([fb9ef35](https://github.com/mramdann/anbo-ai/commit/fb9ef3569f143a9e8ef710bba9deb23dbf6afe6d))
* **voice:** add floating voice prompt input ([cc89596](https://github.com/mramdann/anbo-ai/commit/cc895966428335f3340497464d030d11c3fda662))
* **voice:** add responsive floating voice control ([63f35de](https://github.com/mramdann/anbo-ai/commit/63f35de01705f399a3c903f87138fc00a21d2b17))
* **voice:** add system-wide dictation window ([bbfc193](https://github.com/mramdann/anbo-ai/commit/bbfc1933a76fd0e36f64aeb6bc20a90b0b59131a))
* **voice:** manage local whisper runtime ([30d7e9b](https://github.com/mramdann/anbo-ai/commit/30d7e9b97aa883feb75ba221aafdcade24ebf715))


### Bug Fixes

* **editor:** show thin scrollbars for long files ([164d8c6](https://github.com/mramdann/anbo-ai/commit/164d8c6b02dd531f14ea87afccee2be4f4ea89fb))
* **terminal:** harden automation renderer synchronization ([de1d632](https://github.com/mramdann/anbo-ai/commit/de1d6329c22014dceee8153f6161afa3a7834c35))
* **voice:** allow free orb positioning ([457846f](https://github.com/mramdann/anbo-ai/commit/457846fdc6014ca2a50f134b5a165cce86d944b6))
* **voice:** build the voice window on macOS ([fd19f75](https://github.com/mramdann/anbo-ai/commit/fd19f75ead329172e3ddbd86570cf35ef80cd3cc))
* **voice:** detect CodeMirror inputs that carry several classes ([c770976](https://github.com/mramdann/anbo-ai/commit/c7709764fcb6539749c862b3a0321ed1fd6bb519))
* **voice:** keep the in-app microphone working and normalize global transcripts ([14a6a7b](https://github.com/mramdann/anbo-ai/commit/14a6a7b59e4a7ac7ffa6df428748e1545846a98d))
* **voice:** keep the in-app orb out of the settings startup closure ([8363de3](https://github.com/mramdann/anbo-ai/commit/8363de3bb2bd33d044a443a1960881cea00a888f))
* **voice:** stop dictation landing in a pane the user did not pick ([045c442](https://github.com/mramdann/anbo-ai/commit/045c442439d2d2d64b9972e6f5762bce8e9b0cf4))
* **voice:** stop losing the press that ends a recording ([d046b75](https://github.com/mramdann/anbo-ai/commit/d046b755ab1749c9b7c999eb482893c49bc248de))

## [0.20.0](https://github.com/mramdann/anbo-ai/compare/v0.19.2...v0.20.0) (2026-08-28)


### Features

* **terminal:** add reliable shared terminal automation ([c38d3a9](https://github.com/mramdann/anbo-ai/commit/c38d3a9b8844cbebd483009b49a3fae37f0b5698))


### Bug Fixes

* **terminal:** harden automation resume and rendering ([26a47dc](https://github.com/mramdann/anbo-ai/commit/26a47dc3f9c8cf504120664f87b92bbadb88680f))
* **terminal:** synchronize first background command ([bd3eee6](https://github.com/mramdann/anbo-ai/commit/bd3eee6702862cea45e15f5a3cbf73d2d6653259))

## [0.19.2](https://github.com/mramdann/anbo-ai/compare/v0.19.1...v0.19.2) (2026-08-26)


### Bug Fixes

* **agent:** restore sessions before discovery completes ([68bd09e](https://github.com/mramdann/anbo-ai/commit/68bd09e0cb0287e52e3a1a91c771557787585f80))
* **windows:** prevent input deadlock after display changes ([7a6d36d](https://github.com/mramdann/anbo-ai/commit/7a6d36d8720a94f33d74374a481f36e7b312534f))

## [0.19.1](https://github.com/mramdann/anbo-ai/compare/v0.19.0...v0.19.1) (2026-08-26)


### Bug Fixes

* **agent:** replace stale identity when CLI changes ([52ed6c0](https://github.com/mramdann/anbo-ai/commit/52ed6c0721aaadb9eff6f12408fc75c26442c3e4))
* **spaces:** preserve explicit disclosure state ([f290b11](https://github.com/mramdann/anbo-ai/commit/f290b116cd9e1cb97f7ef480ae4cb744074ebb4d))
* **spaces:** show scrollbar for overflowing workspace list ([0724513](https://github.com/mramdann/anbo-ai/commit/0724513f61a123717666300828572b521efec5fd))
* **terminal:** repair parked renderer on reveal ([7b93b6f](https://github.com/mramdann/anbo-ai/commit/7b93b6fef4cb2b9ea9e767dac1939acdd4f30942))
* **window:** stabilize restore after display changes ([5d97513](https://github.com/mramdann/anbo-ai/commit/5d97513074f791284cc2c4faac12b2a348501b55))

## [0.19.0](https://github.com/mramdann/anbo-ai/compare/v0.18.2...v0.19.0) (2026-08-25)


### Features

* **ui:** refine explorer and sidebar navigation ([fe08862](https://github.com/mramdann/anbo-ai/commit/fe0886214004a7f2024abe1dec99f096368bca9e))


### Bug Fixes

* **agent:** prevent duplicate delegated input ([e62be65](https://github.com/mramdann/anbo-ai/commit/e62be65687e94134fe5da091656cb299e3998b48))
* **tabs:** place fullscreen control last ([f2c21b2](https://github.com/mramdann/anbo-ai/commit/f2c21b2dab24c0dc2744e1b7e228610bd8637299))

## [0.18.2](https://github.com/mramdann/anbo-ai/compare/v0.18.1...v0.18.2) (2026-08-25)


### Bug Fixes

* **agents:** prevent premature completion alerts ([47a815e](https://github.com/mramdann/anbo-ai/commit/47a815e150ae31c4497441ec8baf626fc8729022))


### Performance Improvements

* **agents:** keep status detection within budget ([76793a1](https://github.com/mramdann/anbo-ai/commit/76793a1e4d16e5dbe76fa217ec2ed046223b59bc))

## [0.18.1](https://github.com/mramdann/anbo-ai/compare/v0.18.0...v0.18.1) (2026-08-25)


### Bug Fixes

* **workspace:** authorize roots before activation ([e3be4e3](https://github.com/mramdann/anbo-ai/commit/e3be4e35ecd156c24aebd404a89b350fb1a84082))


### Performance Improvements

* **settings:** keep agent controls within bundle budget ([2c42cab](https://github.com/mramdann/anbo-ai/commit/2c42cab7a472cfc833d3fb7c1b59199e62ce4812))


### User Interface

* **settings:** group coding agent notifications and CLI configuration in the Agents tab ([e4a8cae](https://github.com/mramdann/anbo-ai/commit/e4a8cae))
* **settings:** move browser automation controls into Agent runtime ([c32c9a1](https://github.com/mramdann/anbo-ai/commit/c32c9a1))

## [0.18.0](https://github.com/mramdann/anbo-ai/compare/v0.17.3...v0.18.0) (2026-08-24)


### Features

* add workspace-safe browser file automation ([9fbc11c](https://github.com/mramdann/anbo-ai/commit/9fbc11c5a175494489b9f287133ea22ed7991102))
* **browser:** expand automation primitives ([f6d165a](https://github.com/mramdann/anbo-ai/commit/f6d165aca64a85884c2b994b151dc6474ad7753a))
* require trusted Windows release signing ([0adbd44](https://github.com/mramdann/anbo-ai/commit/0adbd44f33658c66cb9ef3da69410eaa36b5532a))


### Bug Fixes

* **agents:** adopt manually launched cli sessions ([07bc5c1](https://github.com/mramdann/anbo-ai/commit/07bc5c1c3bcc7a8c77fd6e905cedf7df4352464f))
* **agents:** honor completed repaint boundaries ([ac0a5f3](https://github.com/mramdann/anbo-ai/commit/ac0a5f353a22dd962ad3c424ad3b51575af67dca))
* **agents:** preserve manually resumed sessions ([20b77bd](https://github.com/mramdann/anbo-ai/commit/20b77bd11931ad3340c7383ed7b47dad2e15a05f))
* **agents:** settle completed hookless turns ([534848d](https://github.com/mramdann/anbo-ai/commit/534848d6950079629ceaa22335c200e89cd9e53b))
* **browser:** harden navigation and frame automation ([ee3912a](https://github.com/mramdann/anbo-ai/commit/ee3912ab6b9f85f2d7d25590a8e175bfc28e2b6c))
* **browser:** sanitize download names across hosts ([b31ed0a](https://github.com/mramdann/anbo-ai/commit/b31ed0a53d2bd7a9cf0d58501714d62c07d32b63))
* improve live agent status detection ([faabff7](https://github.com/mramdann/anbo-ai/commit/faabff7fcbdcae37530227d078d80c1d738f066b))


### Performance Improvements

* **browser:** improve automation responsiveness ([519bfab](https://github.com/mramdann/anbo-ai/commit/519bfab80ff20893009f0f9519d64be084279767))

## [0.17.3](https://github.com/mramdann/anbo-ai/compare/v0.17.2...v0.17.3) (2026-08-21)


### Bug Fixes

* **notifications:** remove implementation footer ([dd0526d](https://github.com/mramdann/anbo-ai/commit/dd0526dc8529cc2c40e93061c2449546ed129ba0))
* **spaces:** scale workspace switcher with UI ([67087ba](https://github.com/mramdann/anbo-ai/commit/67087bae3c147b306ced8d1007c06ad88165d8c4))
* **terminal:** balance agent panes and scrollbars ([aa412a6](https://github.com/mramdann/anbo-ai/commit/aa412a603ab8851f6f712022161d742e1342acbb))
* **terminal:** synchronize sizing after layout ([880fef2](https://github.com/mramdann/anbo-ai/commit/880fef252e73226c13d88dc79bf1f2b6f65cbb3b))

## [0.17.2](https://github.com/mramdann/anbo-ai/compare/v0.17.1...v0.17.2) (2026-08-20)


### Bug Fixes

* **agents:** wait for Antigravity prompt after login ([8c369cd](https://github.com/mramdann/anbo-ai/commit/8c369cdc5e0f0030364d4cfdff01f11d8d22aa35))

## [0.17.1](https://github.com/mramdann/anbo-ai/compare/v0.17.0...v0.17.1) (2026-08-20)


### Bug Fixes

* **agents:** settle Antigravity input before submit ([02e4be2](https://github.com/mramdann/anbo-ai/commit/02e4be2aa7d1fedd196838923a873c4c683bddc9))

## [0.17.0](https://github.com/mramdann/anbo-ai/compare/v0.16.2...v0.17.0) (2026-08-20)


### Features

* **agents:** replace hook status tracking with screen observation ([602ca1c](https://github.com/mramdann/anbo-ai/commit/602ca1c0c25fb312136f60c743b1d9258152710e))


### Bug Fixes

* **agents:** match lexical Antigravity workspace paths ([53c50a9](https://github.com/mramdann/anbo-ai/commit/53c50a974c768c63a36884d459f674de2f62ab64))
* **agents:** poll terminal screens only inside Tauri ([f5daf4e](https://github.com/mramdann/anbo-ai/commit/f5daf4ec127e17a6ef943147b499fcbcbebb296b))
* **agents:** preserve case in Antigravity session matching ([634fb42](https://github.com/mramdann/anbo-ai/commit/634fb423a130a00424cb75b1daebbcab6bc97872))
* **browser:** keep Windows browser surfaces opaque ([8b81f20](https://github.com/mramdann/anbo-ai/commit/8b81f20a913bc3265b6e8f42b5301476528dbac5))
* **release:** finalize Release Please metadata ([62a82fd](https://github.com/mramdann/anbo-ai/commit/62a82fdabba91e8912b3607061438176a39533b9))
* **release:** normalize Anbo product and artifact casing ([a732268](https://github.com/mramdann/anbo-ai/commit/a732268047ad0595244a10339976169948fd755e))
* **ui:** stabilize restored window and pane presentation ([cf907f2](https://github.com/mramdann/anbo-ai/commit/cf907f25cfdd6ea4c5eafd93f408b2d9a3bcd468))

## [0.16.2](https://github.com/mramdann/anbo-ai/compare/v0.16.1...v0.16.2) (2026-08-18)


### Bug Fixes

* **release:** automate updater publication ([61feac8](https://github.com/mramdann/anbo-ai/commit/61feac85c27df5ce6b5410d73fbe8aba96e53099))

## [0.16.1](https://github.com/mramdann/anbo-ai/compare/v0.16.0...v0.16.1) (2026-08-18)


### Bug Fixes

* **agents:** reject unrendered Codex input ([ed66391](https://github.com/mramdann/anbo-ai/commit/ed66391b680f9e49ee8642cddefc175fea5bbe94))

## [0.16.0](https://github.com/mramdann/anbo-ai/compare/v0.15.1...v0.16.0) (2026-08-18)


### Features

* add MCP agent orchestration ([f2e94cd](https://github.com/mramdann/anbo-ai/commit/f2e94cdd21d51ac9b222a4f525a5e3c254cd1a06))
* add workspace agent MCP and harden lifecycle ([083588e](https://github.com/mramdann/anbo-ai/commit/083588e486c24e14a5b3360a0ff4657e7d3b919c))
* **browser:** open workspace files from explorer ([4dd60e5](https://github.com/mramdann/anbo-ai/commit/4dd60e571fb5f9c169d6725f1d22adeb18297826))


### Bug Fixes

* **agents:** harden lifecycle notifications and routing ([29da08a](https://github.com/mramdann/anbo-ai/commit/29da08a1ae644830fdbd9212f16073c2c03845db))
* **agents:** migrate legacy Claude MCP config ([169ff9d](https://github.com/mramdann/anbo-ai/commit/169ff9db634f0d37ba27f2fba42316d5b74f10b2))
* **ci:** gate sidecar token helpers to Windows ([ef49f8e](https://github.com/mramdann/anbo-ai/commit/ef49f8eb6424f004d5600ee0c97d26b02b48b3d9))
* **release:** restore Cargo lock version annotation ([2689d88](https://github.com/mramdann/anbo-ai/commit/2689d8809cd7d65a79f965794bba2d4cb6a147f0))
* **tabs:** preserve runtime ids across remounts ([c1885e5](https://github.com/mramdann/anbo-ai/commit/c1885e517f81cd5751ebaf8599f5351f0a2f7241))

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

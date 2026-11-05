# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Inkference** (formerly rsd), a Firefox **Manifest V2** extension that bridges the browser to the self-hosted **lmgw**
LLM gateway (default `http://127.0.0.1:8787`, OpenAI/Anthropic-compatible). No build/transpile step
for the extension itself — `src/` ships as-is and the browser runs the ES modules directly.

## Commands

```sh
npm install
npm run vendor   # bundle @mozilla/readability (IIFE) + marked/dompurify (ESM) into src/vendor/.
                 # Only on first checkout or when bumping those deps — the bundles are committed.
npm run dev      # web-ext run: launches Firefox with a temp profile + auto-reload. Sidebar: Ctrl+Shift+L
npm run lint     # web-ext lint. Prefer: npx web-ext lint --source-dir=src --self-hosted
                 # (addons-linter gates the build — it flags real JS syntax errors node --check misses)
npm run build    # web-ext build -> dist/inkference-<ver>.zip
npm run sign -- --api-key=… --api-secret=…   # unlisted AMO signature -> dist/*.xpi (release Firefox runs signed add-ons only)
# release: push a tag vX.Y.Z -> .github/workflows/release.yml signs (unlisted, AMO secrets) and publishes
#          a GitHub Release with the XPI + updates.json; version + update_url are injected into a staged
#          copy of src/, never committed (src/manifest.json's version is not the released one)
npm run mock     # serve mock/ (a fake locked-down device) on http://localhost:8088 for agent testing
npm run ground-check -- --model gemma4-12b   # measure a model's screen-vision aim (see feature 1)
npm run dark-check -- [--model gemma4-12b] <url…>   # measure AI dark mode on real pages (see feature 4)
npm run script-check -- [--rules mock/feed-rules.json] [--scrolls N] <url…>   # Script mode: overlays over videos, rule health
npm run script-e2e -- --model gemma4-12b [--prompt "…"|--turns f.json] [--approve yes|no]   # Script mode end to end: real extension + model, transcript, deploy-2 check
npm run script-e2e -- --model gemma4-12b --scenario repair   # Script mode health check → stale → repair, on feed.html?rename=1
# ground-check / dark-check / script-e2e read the gateway key from the env (LMGW_API_KEY), never an argv flag
```

There is **no automated test suite and no test runner.** Validate with `web-ext lint` plus manual
testing in `npm run dev`. For pure-logic checks, run the function against stubs in plain Node — e.g.
the [content/extract.js](src/content/extract.js) IIFE was verified by evaluating it with a fake
`document`/`Readability` (`new Function("document","Readability","var r=" + src + ";return r")`).
The **unlock/save-gate flow** (below) is tested against [mock/](mock/) — `npm run mock` serves a
pretend router admin over HTTP (the agent refuses non-http(s) tabs and `webRequest` needs real
requests) with three sections, one per lock depth: a cosmetic `disabled` field, a page that strips
the field from its save payload, and a value the device backend enforces server-side. The same
server also serves `game.html`, a pure-canvas game with zero DOM controls, for testing the
screen-vision tools (`screenshot`/`click_screen`), and `dark.html`, a light page whose stylesheet is
loaded cross-origin (127.0.0.1 vs localhost) for testing AI dark mode's fetched-sheet path, and `feed.html`, an infinite video wall (inner scroller, recycled virtualized tiles, per-deploy hashed class names via `?deploy=N`, transparent/pointer-events:none overlays plus a sticker layer outside the tiles, per-item `data-item-id` content ids, one hashed-class ACTIVE tile and a ~4 Hz ticking countdown) for testing per-site overlay hiding — with `?rename=1`, a redesign that renames two stable hooks, for the health check and repair.
**Headless Firefox is scriptable without geckodriver:** [tools/lib/firefox-bidi.mjs](tools/lib/firefox-bidi.mjs)
drives it over WebDriver BiDi (`--remote-debugging-port 0`, Node's own WebSocket) — navigate, evaluate
an expression (JSON round-trip), screenshot — which is how `dark-check` runs the real content scripts
against live pages.

## Architecture

### Background page is the single source of truth
[background/main.js](src/background/main.js) is a **persistent** MV2 background page that owns ALL
state: prefs, the normalized model cache, the active conversation, and the streaming/abort loop.
Sidebars are **stateless views** — they connect a long-lived port ([common/messages.js](src/common/messages.js)
`PORT_SIDEBAR`), say `HELLO`, and get a full `snapshot()`; thereafter the background broadcasts deltas
to every connected sidebar via [background/ports.js](src/background/ports.js). Because streamed text is
appended straight into the conversation object, a sidebar that reloads mid-stream re-hydrates from the
snapshot (which carries the partial assistant message + a `streaming` flag) and keeps receiving deltas —
no lost responses. Conversation state is global (one active chat); multiple windows mirror it.

**The connect is a race, so both ends defend it.** At browser startup Firefox restores an open
sidebar alongside the background page; a `runtime.connect` that lands before the background has an
`onConnect` listener is dropped outright (silently — the doomed port even accepts a `postMessage`),
which used to leave the sidebar mute with an empty model picker until you hid and re-showed it.
So main.js registers `onConnect` **synchronously at module load** and holds port messages on a
`ready` promise resolved once prefs/cache/agent exist, and sidebar.js **auto-reconnects** with
backoff, treating an unanswered `HELLO` as a failure and queueing user actions until a `STATE`
snapshot proves the port. Re-hydration is idempotent, so reconnecting at any moment is safe.

**The port protocol in [common/messages.js](src/common/messages.js) (`C2B` / `B2C`) is the contract.**
Any change to sidebar↔background communication must update it on both ends (sidebar.js + main.js).

### All gateway I/O lives in [background/gateway.js](src/background/gateway.js)
It runs only in the background page, where the host permission waives CORS and HTTPS→HTTP-localhost
mixed-content blocking. Everything throws `GatewayError` (carries `status` + upstream `detail`).
**Auth:** every request carries `Authorization: Bearer <gatewayKey>` (`gatewayHeaders`; omitted when the
pref is empty) — lmgw answers 401 without a key once "Require API key" is on. The key is the `gatewayKey`
pref (Options → under the base URL), threaded next to `gatewayUrl` everywhere, **never** in `snapshot()` or
any port message; changing it reloads the model list like a URL change. Non-ok responses go through
`gatewayFailure`, which promotes lmgw's `error.message` into the headline and, for code `auth` (or no key
sent), appends "set the gateway API key in Inkference settings (lmgw: Usage → Keys)".
- `streamChat` — SSE chat (the normal sidebar reply path).
- `chatWithTools` — one **non-streaming** tool-calling turn. Non-streaming on purpose: weak local
  models emit cleaner `tool_calls` without streamed reassembly. This is why the page agent's final
  answer is delivered as one block, not token-streamed.
- `chatOnce` — one-shot non-streaming (dark-mode compile).
- `speech` — POST `/v1/audio/speech`, returns the finished clip as a Blob (audiocpp answers
  `audio/wav` whatever `response_format` says). Not streamed: fish-audio is an `offline`-mode
  model, and audiocpp rejects `stream_format` unless the model runs in `mode: "streaming"`.
- `countTokens`, `fetchModels`, `fetchVoices`.

### Four features, all routed through the gateway
1. **Page-aware mode** (the main surface). One **"Use page"** toggle in the sidebar. When on, a send
   routes to `runPageTurn` → [background/agent.js](src/background/agent.js), a tool loop that can both
   **read** the page (`read_page`) and **act** on it (observe/find/click/type/select/scroll). Its final
   prose is committed as a normal assistant turn; step notes stream as ephemeral lines. When off, it's a
   plain streamed chat. **Critical constraint:** page content goes to the model as a **`tool` message,
   never `system`** — Gemma-family chat templates reject the `system` role (raises in the Jinja template →
   llama-server 500 → gateway 502). Keep at most ONE leading system message in any request.
   - **Going off page** (the second sidebar checkbox, live only while "Use page" is on). Adds
     `navigate`/`go_back` plus a prompt section. Without it the agent is confined to the tab it
     started in and can only move by clicking links already on it, so a multi-site errand ("find the
     part id of my macbook, then look it up on amazon") ended in "I don't see that on this page" —
     which was true. The nav prompt also states the tab's CURRENT url/title, because a run almost
     always starts on the user's new-tab/start page and the model otherwise combs that dashboard for
     an answer that was never going to be there. When the run **begins on the start page** — the
     `startPage` pref (Options → Browsing; empty by default; any path under
     it counts) or Firefox's own `about:newtab`/`about:home` — the hedging is dropped: the prompt says
     flatly that this is the page every new tab opens on, not the subject of the request, and that
     the first step is `navigate` (`isStartPage` in agent.js). A `navigate` to a site that is neither the tab's current one nor
     approved earlier in the run asks first (`siteOf`/`sameSite`, `approvedSites` per run): the model
     writes the URL, and a page can steer it into carrying data out. `navigate` waits for the load to actually BEGIN
     (`tabs.update` resolves while the tab still reports the old url as `complete`) before waiting for
     `complete`, and its result tells the model the earlier element ids are now dead. **The loop has no
     step cap**: it streams a note per step and Stop aborts it, so a genuinely long multi-site task is
     never cut off by a guessed constant (a "still working" note every 25 steps keeps it legible).
   - **Unlock / verify / patch** (for tech you own, e.g. a router setting greyed out in the consumer
     firmware tier). `observe` marks disabled/read-only controls `(locked)`; `unlock` strips the client
     gate (`disabled`/`readonly`/`<fieldset disabled>`/aria/inline dimming) so `type`/`select` can set the
     real value. When `unlock` runs it **arms a save-gate**: a Firefox async-blocking `webRequest`
     listener HOLDS every write (POST/PUT/PATCH/DELETE) from the agent's tab until the user Approves,
     showing the real method/URL/body — this is why it catches `fetch`, XHR, **and** native `<form>` POSTs
     that an in-page hook would miss. `last_request` reports what the page actually sent + the device's
     HTTP verdict (2xx accepted, 4xx/5xx = enforced on the device, not just hidden in the page). When the
     page **strips** the value from its own payload, `patch_request(field,value)` rewrites the outgoing
     body via [content/net-hook.js](src/content/net-hook.js) (webRequest can't modify bodies). Autonomous
     up to the wire; the user gates the actual write. Gate/patch teardown clears on run end so the hook
     can't touch the user's later manual saves. Needs `webRequest`+`webRequestBlocking` (in the manifest).
   - **Screen vision** (canvas/WebGL/WASM pages, where `observe` lists nothing). Gated on the
     `groundingModel` pref (Options → Screen vision); off = the tools and their prompt section don't
     exist. `screenshot` attaches the capture as a **user** message after the batch's tool results —
     OpenAI `tool` messages are text-only, and a user turn *between* tool results breaks strict chat
     templates — with older shots collapsed to text stubs (only the newest screen matters; images are
     the heaviest transcript rows). Verified against gemma4-12b: that exact shape (system → user →
     tool_calls → tool → user-with-image, `tools` declared) is accepted, and the model answers an
     empty `observe` by screenshotting and then calling `click_screen` on its own.
     - **The format is what grounds, not a bigger model** ([background/vision.js](src/background/vision.js)).
       `click_screen(target)` takes a verbal description and resolves it in a **separate temp-0 call**,
       because the same model answers the same screenshot two very different ways: asked for pixels in
       prose, gemma4-12b put the mock's Buy button 260px off (outside it); asked in its trained
       detection phrasing — `detect <target>, output only \`\`\`json` — it lands **within ~5px,
       byte-identically across runs, in ~0.8s**. So the grounder may simply BE the chat model
       (`GROUNDING_SAME`, the recommended setting) and no second model is needed; a dedicated one
       stays swappable for planners that can't detect. Small models are not a substitute (gemma4-e4b:
       13–47px, one outright miss, non-deterministic).
     - **Coordinate conventions are read off the KEY, never guessed**, because getting it wrong lands a
       plausible click in the wrong place: `box_2d` = Gemma/Gemini `[y1,x1,y2,x2]` **Y FIRST** on a
       1000×1000 grid (descaled per axis); `bbox_2d`/`bbox` = Qwen-VL absolute pixels, x-first. A box
       collapses to its center; values in (0,1] are fractions. Which convention was used is printed in
       the step note (`[grid1000]`). Absent targets are a real answer, not a parse failure — Gemma
       replies "I did not find any bounding box detections for X", others return `[]`; both become
       `found:false` so the model can rephrase instead of clicking nothing.
     - The point maps to CSS px by the **measured** image↔viewport ratio (never assume dpr — zoom
       changes it) and is dispatched by content/agent.js `clickAt`: a full untrusted pointer+mouse
       sequence with real clientX/Y (canvas apps read coordinates off events; `el.click()` sends 0,0).
       An iframe hit returns the frame url + translated point and the background descends via the frame
       list; SENSITIVE names confirm as usual.
     - **`highlight` / `highlight_screen` point at things for the USER** — the only tools here that
       communicate instead of acting. `highlight(id)` needs no model call at all (the element's own
       `getBoundingClientRect()` is exact and free); `highlight_screen(target)` reuses the *same*
       detection call as `click_screen`, which is why `groundTarget` keeps the box's `w`/`h` instead
       of collapsing to a center. The ellipse through a rect's corners has semi-axes 0.707·w/0.707·h.
       Lifetime is deliberately **inverted** from the rest of the runtime: a marker must OUTLIVE the
       run (one cleared at task end would vanish before it was read), so it fades itself via a WAAPI
       animation — owned by the document, so it survives the injection sandbox being torn down — and
       leftovers are cleared at the *start* of the next run, plus before any grounding capture (a red
       ring is a conspicuous object the detector will happily find). It is `pointer-events:none` in a
       shadow root with inline `!important` styles, so it can't intercept the next `clickAt`
       (`elementFromPoint`) and the site's CSS can't restyle it — both verified in a real browser.
     - Ids do not exist on a canvas page, and a model handed an empty observation **will still guess
       one** (observed: gemma4-12b called `highlight {"id":1}` after `observe` returned nothing), so
       the "no element with id N" error says so explicitly when `collect()` is empty and names the
       screen tools — after which the same model recovers on the next step.
     - `npm run ground-check -- --model <id>` measures any model against
       [mock/public/game.html](mock/public/game.html) (a pure-canvas page, invisible to the DOM tools)
       through the **real** vision.js path — prompt, parser and mapping — reporting px error, hit/miss,
       determinism and hallucinated boxes, and exiting non-zero on a miss. The page also draws a
       crosshair for the last click, so aim is visible in the browser too.
2. **Right-click context actions** (Summarize/Explain/Rewrite/Translate/Ask…) — [background/menus.js](src/background/menus.js)
   → `handleMenuAction`, which appends page/selection text to the **user** message (not system) and uses
   the plain `runTurn` streaming path.
3. **Read aloud (TTS)** — [background/tts.js](src/background/tts.js). Right-click a selection →
   *Ask LLM → Read aloud* (speaks immediately) or *Read aloud in sidebar…* (opens the reader panel,
   below); *Stop reading* sits in the same menu and is `visible:false` until it talks. All three live
   under the **one** existing top-level item on purpose: a second top-level menu entry makes
   Firefox bury them all in an extension submenu. **Playback runs in the background page** — the one
   document that outlives the tab and the sidebar, and the only one Firefox exempts from autoplay
   blocking (`media.autoplay.allow-extension-background-pages`, default true; a `NotAllowedError` is
   reported with that pref name). **One request per read — never split the text.** audio.cpp chunks
   long input server-side (fish-audio: `text_chunk_size` 200) and holds ONE speaker across those
   chunks; a client-side split can't, because with no reference voice each request samples a new
   random speaker (verified: same `seed` + same text is byte-identical, same `seed` + different text
   is a different speaker — the voice is per request, not per seed). Chunked playback therefore
   changed voice every few sentences, which is why the pipelined chunker was removed. The cost is
   latency — ~0.04 s of synthesis per character (RTF ≈ 0.5), so nothing is heard until the whole
   clip is done — so `B2C.TTS_STATE` reports `phase` + `elapsed` + `total` once a second, and the
   spoken/synthesis rates are re-measured from every clip over 200 chars instead of trusting the
   shipped constants. **Stop can't cancel upstream:** audiocpp has no cancel endpoint and finishes
   an abandoned generation before serving the next request, so Stop → read something else can wait
   out the orphan. The selection comes from `tabs.executeScript` in the clicked frame, **not**
   `info.selectionText` (Gecko trims that to ~150 chars for menu labels). Errors go to the sidebar
   when one is connected, else to a desktop notification (`notifications` permission) — the feature
   is used with no sidebar open, which is also why a wait estimated over `QUIET_WAIT_SECONDS`
   announces itself there: with no panel to show the clock, silence reads as failure.
   - **Text cleanup** — [common/speechtext.js](src/common/speechtext.js), pure functions used by both
     paths. Web text is full of marks that a TTS model pronounces ("bracket twenty three"): `[23]`,
     `[citation needed]`, `[edit]`, markdown asterisks, bare URLs, emoji. Each rule is separately
     switchable and **nothing is dropped but marks** — code blocks keep their content, only the fence
     goes. Two rules are deliberately narrow because they were caught over-reaching: bracketed letters
     only match a single letter or a roman numeral (else `[was]` disappears), and superscript
     stripping is its own rule, **off by default**, because the same characters are units (`12 m²`).
   - **Reader panel** — [sidebar/reader.js](src/sidebar/reader.js), a view laid over the chat
     (`position:fixed`, its own header/footer). The menu action sends the **raw** selection
     (`B2C.READER`); the panel cleans it live, so every toggle is reversible — it keeps the original
     and re-derives. The textarea wins: `C2B.TTS_SPEAK` carries the final text and the background
     speaks it **verbatim** (no second cleanup, and only the ends are trimmed — interior line
     breaks reach the model, which some audio.cpp chunk modes split on). It shows chars, spoken
     length **and the synthesis wait** (from the rates in `B2C.TTS_STATE`, seeded by
     `SECONDS_PER_CHAR`/`SYNTH_RTF` in tts.js) — the wait is the number that decides whether a
     passage is worth starting. Playback is mirrored as a clock. Because the panel covers the
     chat's error banner, `B2C.ERROR` is repeated inside it.
   - **Choosing a voice** is a server-side setting, not a request field: fish-audio exposes no
     built-in voices (`/v1/audio/voices` → `[]`) and pocket-tts refuses to run without one
     (`PocketTTS session prepare() requires a session voice`). lmgw renders audio.cpp's
     `voice_presets` / `default_voice_preset` per model (a `voice_id`, or a `voice_ref` clip from
     its voice library) — a request's `voice` names one of those presets. Without a preset every
     read gets a different random speaker.
4. **AI dark mode** — [background/darkmode.js](src/background/darkmode.js), the toolbar button. Compile-once
   per origin: probe the page, census what it paints, ask the LLM **once** for a PLAN, compile the sheet
   from the plan, apply, **verify** by censusing again, cache keyed by origin, re-apply instantly on every
   later visit. CSS is injected `cssOrigin:"user"` so its `!important` beats the site's author rules.
   Right-click the toolbar button → recompile / forget. **No model needed:** with no chat model
   picked, `plan()` returns the default plan (built-in theme, no error) and the entry is marked `generic`;
   the tooltip says so, and the next toggle with a model available upgrades it once per origin per session.
   A (re)compile takes our own sheet off BEFORE probe/census — they read computed colours. The button tooltip carries the verdict
   (`on — recolor (76% → 0% of the viewport light)` plus the model's rationale).
   - **The model designs, the compiler writes** ([background/darkcss.js](src/background/darkcss.js), pure —
     runs under Node too). The first design handed the model a bag of colours and asked for the stylesheet:
     it guessed selectors it had never seen (`.block-container` on XenForo was luck), local models broke
     the JSON typing 200 lines of CSS into a string, and the old probe's colour list was `["rgb","rgba"]`
     (Firefox serialises colours as `rgb(…)`, the tokenizer split on parens) — so "worked" meant "a sheet
     was produced", not "the page went dark". Now [content/restyle-probe.js](src/content/restyle-probe.js)
     records EVERY colour declaration WITH its selector and @media/@supports/@container wrap (the paint
     list — never sent to the model; colours canonicalised through a canvas `fillStyle`), colour tokens
     with the role their `var()` consumers give them, and native-theme hooks weighted by the rules they
     back; [content/paint-census.js](src/content/paint-census.js) samples a 32×20 grid with
     `elementsFromPoint` and reports what fraction of the viewport reads light and which colours/elements
     paint it (inline styles and unreadable sheets included — it measures the paint, not the CSS). The model
     gets the bounded summary (`summarize`; every capped list prints its total) and returns a small JSON
     plan: `strategy` + `theme` (base/surface/raised/text/muted/border/link) + optional `palette` (exact
     source→target) + a few extra rules. `compileSheet` rewrites each recorded declaration by ROLE: light
     backgrounds onto the theme tones by lightness band, dark text onto text/muted, light borders onto
     border; chromatic colours keep their hue (decided on chroma, not HSL saturation — `#f0eee6` reads as
     25% saturated); already-dark backgrounds and already-light text are left alone. An unparsable reply
     compiles with `DEFAULT_THEME` and says so in the rationale — never CSS made of garbage.
   - **Tokens are the trap.** A raw palette token (`--color-ivory-light`) is a background in light
     sections and text in dark ones; recolouring its definition inverts half the site. So a token's role
     comes from its consumers, a token with real bg AND text use is `mixed` and its definition is left
     alone — its consumers (`background: var(--color-ivory-light)`, recorded by the probe as `{p, var}`)
     are rewritten in place from the token's computed root value. Chain tokens (`--body-bg: var(--white)`)
     have no literal to rewrite, so their consumers are always rewritten in place; roles propagate down
     chains (`propagateRoles`), which is what makes `light-dark(var(--gray-90), var(--gray-10))` come out
     right (both greys become bg-role, the dark one is untouched). A token with NO evidence — no consumer,
     no telling name — is not touched: guessing from lightness inverted MDN's dark palette. A palette entry
     is honoured only in the right direction for its role (a background target must be dark, a text target
     light): gemma wrote `"#141413":"#faf9f5"` meaning text, and applied to a background it turned the
     cookie banner light.
   - **native-theme** is for a real site-wide hook: a root-level class/attribute backing dozens of
     descendant rules (Stack Overflow's `body.theme-dark`, 204 rules), `light-dark()` pairs (MDN — the
     `color-scheme:dark` the compiler always sets flips them), or a big prefers-dark block, which is
     re-emitted unconditionally (a stylesheet cannot flip that media query). Hooks go on BOTH `<html>` and
     `<body>`. A `[data-theme=dark]` backing one token block is a *section* palette (anthropic.com: the
     wrapper carries `data-theme="ivory"`, a root attribute never reaches it) — the summary's
     `sectionThemes` says so, and if the model picks it anyway, **verify** catches it: a native theme that
     left more than `STILL_LIGHT_FRACTION` of the viewport light is swapped for a recolour built from the
     same plan, no second model call.
   - **Inline colours are in no sheet**: each distinct `style` attribute (and `bgcolor`) becomes a paint
     rule keyed on its exact text (`[style="…"]`, `[bgcolor="…"]`), else the text on Wikipedia's
     infobox headers went light on a still-light box and Hacker News stayed 49% light. Values that
     would need CSS-string escapes are skipped (page text goes into our sheet). Known gap: tokens
     re-pointed inside a section (GitHub's dark header sets `--…-bgColor-rest: var(--…-text-default)`)
     are mapped from the ROOT value, so its "Sign up" button comes out white on white.
   - **Cross-origin sheets** throw on `.cssRules`; the background fetches them (host permission) and
     re-runs the probe with their text in `globalThis.__rsdDarkExtraSheets` (parsed into constructed
     sheets — content scripts of one extension share a global per frame, so a `code` injection can hand
     data to the next `file` injection). Tested by `mock/public/dark.html`.
   - **Measure, don't assume:** `npm run dark-check -- [--model <id>] <url…>` runs the REAL
     probe/census/prompt/compiler in headless Firefox and prints light fraction before → after, what still
     paints light, and screenshots; without `--model` it measures the mechanical compiler alone. Default
     theme: pyra 76→0, anthropic 84→0, github 90→0, wikipedia 99→0, MDN 100→0, Stack Overflow 100→15;
     with gemma4-12b Stack Overflow picks its native theme (100→1). The census freezes transitions while it
     samples: XenForo's `transition: all .25s` had the verify census reading rows mid-fade as still light.
5. **Script mode** — the third sidebar toggle (live only with "Use page"). The agent and the user build a
   per-site **script**: rules that hide, fade, move or make click-through the UI on top of videos.
   [background/userscripts.js](src/background/userscripts.js) is the browser half (storage, insertCSS, census,
   test run); [background/scriptcore.js](src/background/scriptcore.js) the pure half (draft model, which CSS
   goes in which frame, every text the model reads). A page-action icon says a script is changing the page and
   opens the **Script panel** ([sidebar/scriptpanel.js](src/sidebar/scriptpanel.js)) — in that window only;
   `SCRIPT_STATE.windows` gives each window's panel its own tab and "saved for this site" list.
   - **Rules, not CSS** ([background/rulecss.js](src/background/rulecss.js), pure). The model picks
     `{selector, action, params, why}` (hide · hide-until-hover · click-through · dim · move · restyle) and the
     compiler writes the user-origin `!important` sheet — dark mode's lesson (a local model typing CSS into JSON
     breaks the JSON), and every rule keeps a selector whose match count can be re-measured on any visit. What
     covers the videos is measured by the census — **Script mode's eyes**, below.
   - **Draft vs saved.** ONE draft, shared by agent and panel, persisted and bound to one tab, where it is live
     and REPLACES the saved script it was loaded from. Its tab id is not restored (ids are per session):
     `draftFor()` rebinds it on a matching tab. Saved scripts apply per FRAME, matched on the frame's own url,
     via `tabs.insertCSS({cssOrigin:"user", runAt:"document_start"})` from `webNavigation.onCommitted`.
     `injected` records which exact text sits in which frame (`removeCSS` needs the text). A **bfcache**
     restore (`forward_back`) brings a document back WITH its old sheets but not their record, so `ever` keeps
     every text ever inserted per frame and each fresh commit removes those not wanted now — a no-op on a new
     document; re-inserting a present text adds no copy (both measured).
   - **The flash trade-off:** onCommitted + insertCSS lands ~1 animation frame late on an instant page
     (overlays at ~30 ms, gone at ~40 ms; pages that build tiles after a fetch never show it).
     `contentScripts.register` is frame-exact, but its sheet can't be removed from a loaded document, so live
     disable/edit/delete couldn't be built on it — the owner chose insertCSS.
   - **Agent tools:** `overlays_of` (groups g1… + ranked candidates) → `inspect` g#/p#/selector →
     `test_selector` → `add_rule`/`update_rule`/`remove_rule` (each measured: matches, coverage before → after,
     "covers all of gN" / "MISSES k of n", what still covers) → `test_script` (reload + scroll, per-step
     counts; a step with no video on screen is no evidence) → `save_script`. p# are the user's picks. The draft
     block rides on the USER message (it quotes the page). gemma4-12b (3/3 on script-e2e) needed: `match` left
     out and refused unless it covers this page; the gN candidate to copy on a miss; "Not tested yet — call
     test_script" closing every change result; double-escaped selectors unescaped; repeats → update_rule.
   - **Security model.** The sidebar port is accepted only from the sidebar page (`sender.url`). Restyle values
     may call no function that fetches (allowlist; backslashes refused); names and `why` are one line and
     comment-safe; unbalanced brackets/quotes are refused, and every rule goes through Firefox's own
     `CSSStyleSheet.replaceSync` — all its blocks must survive and a sentinel after it too — so no sheet that
     parses short is ever applied. Patterns need a host, no port; `isBroadMatch` ones are refused to the agent
     and need the panel's warned second click. Every confirm carries an id (a leftover or mirrored card can't
     approve the current one; settled cards go inert in every window), and a save is pinned to the draft the
     card showed. Stop ends a tool batch, a test and a pending card at once.
   - **Health + repair.** Each visit (one document in a tab) counts every enabled saved script's rule
     selectors (census `count`, each frame it applied to) at `load`+settle, +10 s and +60 s (cancelled on
     navigation/close); matched in ANY check = alive for the visit, no target in any frame = no evidence
     (redgifs: only the ACTIVE item has content). Missed on the last `STALE_VISITS` = 3 visits with
     evidence = **stale**, and every warning says that number. `userScriptHealth` keys each rule's record
     to the selector it measured; a save resets the script. Stale shows as an orange dot on the page-action
     icon + a title naming the rules, in the panel's saved list and on the draft's rows. Repair (that click,
     or the panel's button) loads the draft and PREFILLs that window's composer (Use page + Script on, not
     sent); the briefing marks the rules STALE → update_rule the same id, selector only. The check waits
     for the tab's CSS queue — on an instant page `load` beat the commit's insertCSS and nothing looked
     applied. Mock: `feed.html?rename=1` (rail `actions-v2`, badge `data-kind`); `--scenario repair`: 3/3.
   - **Measure:** `npm run script-check` (census + compiler on any page, no model) and
     `npm run script-e2e -- --model <id>` (the real extension + model through a recording proxy: transcript,
     fresh-load and `?deploy=2` checks; exit 3 on gpu_hold).

**Script mode's eyes: [content/overlay-census.js](src/content/overlay-census.js)** (`window.__rsdOverlay({op})`:
overlays · inspect · test · count · scroll · settle · pick · pickKey · unpick). A point on a video is covered
when the hit test puts something above it there AND that thing paints at that point (opacity chain,
background/gradient/media/border/own text runs/pseudo) — so feed.html's transparent click-catcher counts
for nothing, while its pointer-events:none scrim is reached by forcing pointer events during sampling.
Painters are grouped by ROLE (tile children, unwrapped through non-painting wrappers; "outside" = a layer
holding no video) and each group gets ranked selector **candidates** checked against every same-role
element: exact role coverage first, then stable (no hashed class, CSS-module prefix or nth-child — feed.html
re-rolls even `Name_part__` prefixes per `?deploy=N`), then length. Traps already hit, each fixed in code:
a click-through rule's user-origin `pointer-events:none !important` beats the forcing sheet (→ approximate
paint-order placement); a hide-until-hover rule's `transition !important` beats the freeze (→ `finish()`);
Gecko lists a tile ABOVE its video where its `::after` paints; on redgifs only the ACTIVE item has content,
so a role is often one element and a content id (`data-feed-item-id`) looked "constant across the role" —
identity attributes (name or mostly-distinct values) are presence-only now, and state classes
(`GifPreview_isActive`) stay out of role signatures; a 0 px-tall overlay box with overflowing children —
`where` uses the union of what actually paints; a ticking countdown kept `settle` from going quiet — text-only
mutations are noise (`ignoreText:false` opts out). Every `path` ships with a `sig`; `inspect`/`test` take
`{path, sig}` and relocate or answer `stale:true` when a recycled feed moved the element. The picker obeys
trusted input only (the page must not complete the user's pick); a pseudo-element-only selector is refused,
not counted as `*`. Known gap: a pseudo-element made click-through has no box to place and drops out.
`npm run script-check` runs it in headless Firefox: discovery, or `--rules` → coverage before/after, per-rule
counts across scroll+settle steps, non-zero exit on a stale (0-match) or uncompilable rule. feed.html with
[mock/feed-rules.json](mock/feed-rules.json): 45% → 40% (only the click-through scrim left), 5 groups in
~60–100 ms; an 11k-node page with 64 videos censuses in ~150–190 ms.

### Content scripts are injected on demand, not declared in the manifest
The background re-injects them via `tabs.executeScript` per use:
- [content/extract.js](src/content/extract.js) — `read_page`/Tokenize. Injected **after**
  `vendor/readability.js` (which sets the `Readability` global as the namespace
  `{ Readability, isProbablyReaderable }`). Returns one of two shapes: **article** (Readability's cleaned
  body) or **index** (a deduped headline+link digest for front/section/feed pages, which Readability would
  otherwise discard). The choice is by **content weight** — article when the body text outweighs the page's
  total headline text, else index. Do not reach for page-wide link density: it conflates the article with
  nav/related/footer chrome.
- [content/agent.js](src/content/agent.js) — the DOM agent runtime, **re-injected before EVERY command**
  so navigation is free (a fresh page gets a fresh runtime) and it stays stateless. Element ids are
  **positional**: 1-based indices into document-order actionable elements, recomputed on every call — an
  id is only valid against the observation that produced it. **Sub-frames (iframes) are in scope:** the
  runtime is injected per-frame and `observe`/`find` run across every injectable frame (the `webNavigation`
  permission enumerates them — [background/agent.js](src/background/agent.js) `listFrames`). To keep one flat
  id space, each frame's local ids are offset by `ordinal*FRAME_STRIDE` (top frame = ordinal 0 → base 0, so a
  frameless page is unchanged); an id therefore encodes its frame, and the loop routes an action back to the
  owning frame via that frame's `frameId`. The model still sees one numbered list — sub-frame elements just sit
  under a `--- FRAME […] ---` header. Cross-origin iframes are reachable because we inject *into* each frame
  (same-origin within it); a `<canvas>`-rendered widget still exposes nothing, since this is DOM, not vision.
  Money/irreversible clicks (`SENSITIVE` regex) return `needsConfirm`, which the loop turns into a sidebar
  Approve/Decline round-trip. `collect()` deliberately **includes disabled/read-only controls** (so a locked
  field has a stable id to target); `describe()` tags them `(locked:…)`, and the `unlock` op strips the gate.
- [content/net-hook.js](src/content/net-hook.js) — the outgoing-body rewriter for `patch_request` (feature 1's
  unlock flow). Unlike the stateless per-command runtimes it installs **once** and persists: the fetch/XHR
  wrapper runs in the **page's own world** (injected as a `<script>` so it reads `init.body`/`send(body)`
  natively, no Xray), and this content-sandbox half bridges the patch list into a page global via
  `wrappedJSObject` + `cloneInto` (the [content/cheat-hud.js](src/content/cheat-hud.js) trick). A strict CSP
  that blocks the inline `<script>` is detected (install flag stays unset) and surfaced to the model.
- [content/restyle-probe.js](src/content/restyle-probe.js) — dark-mode stylesheet probe (the paint list,
  tokens, hooks); [content/paint-census.js](src/content/paint-census.js) — what the viewport paints right
  now, run before a compile and again after to verify it. Both stateless: read and return.

### Model list normalization — [background/models.js](src/background/models.js)
From lmgw's `/v1/models`: `owned_by === "llama-embed"` dropped (embeddings); `owned_by === "audiocpp"`
(alias prefix `audio/`) dropped too and re-normalized by `normalizeAudioModels` into its own
`audioModelCache` — those speak `/v1/audio/*`, never `/v1/chat/completions`, and their `/` would
otherwise read as a bogus "audio" cloud prefix in the picker. TTS vs ASR is read off the id
(`…-asr…`/whisper/stt = ASR). Then: an id containing `/` is a **cloud** model (prefix = segment before
the first `/`); otherwise **local**. Cloud prefixes are opt-in checkboxes in the picker. Pricing
`-1`/missing → `null` (rendered "?"), `0` kept as free.

## Notes
- The browser runs `src/` as native ES modules — write browser-ready ESM, no transpilation.
- Assistant replies render through DOMPurify with media, SVG/MathML, `<style>`, forms and every url-bearing
  attribute (`src`, `srcset`, `style`, `poster`, …) forbidden ([sidebar/chat.js](src/sidebar/chat.js)): the
  agent reads pages, a page can steer the answer, and an `<img>` would beacon from this privileged page.
- **`sidebar_action.browser_style` must stay `false`.** It defaults to **true** in MV2, and Firefox
  then loads `chrome://browser/content/extension.css` into the sidebar panel
  (`webext-panels.js`); that sheet sets `html, body { user-select: none }`, which inherits into the
  whole transcript — replies could not be selected or copied (the composer/reader textareas still
  worked, since the UA sheet gives form controls `user-select: text`). sidebar.css already overrode
  every other thing that sheet sets, which is why this was the only visible symptom. The sheet is
  wrapped in `@layer`, so the unlayered `html, body { user-select: text }` in sidebar.css is a second
  line of defence.

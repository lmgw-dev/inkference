# AMO listing: Inkference

Copy-paste material for the addons.mozilla.org submission. Not shipped in the extension.

**These fields are edited in the AMO developer hub, not in the repo.** Changing this file changes
nothing on the listing — paste from here. As of the last check the live listing had **no tags set
at all** and carried `language-support` as its second category, which is how the Tags and
Categories sections below came to be written out explicitly.

## Name

```
Inkference – AI Dark Mode
```

Not just "Inkference". AMO's search ranks hard on name matches: a query for `dark mode` returns
3320 add-ons and the top results are, without exception, ones carrying "Dark Mode" in the NAME.
A bare product name contains no word anyone searches for. (AMO allows 50 characters.)

What NOT to do: a competitor's name ("Dark Reader") anywhere in the metadata. It is someone else's
trademark, Mozilla routes third-party marks through a legal process rather than the listing rules,
and misleading metadata is itself grounds for takedown. The measured upside is nil anyway — that
query is dominated by the trademark holder (1.36M users) and by add-ons matching "reader".

## Summary (≤ 250 characters)

```
A dark mode that checks its own work: it reads every colour the site sets, rewrites them by role, then measures the result — including text contrast, so nothing ends up dark-on-dark. Optional: your own local models via lmgw for per-site AI themes.
```

Leads with what no other dark mode does (measuring the result, grading readability) and still
contains "dark mode" for the search. The local models stay in, but second: the dark mode is what
people install, lmgw is why they stay.

## Categories

**Appearance**, and nothing else. Up to 3 are allowed, but there is no "Other" in the list — the
options are Alerts & Updates, Appearance, Bookmarks, Download Management, Feeds/News/Blogging,
Games & Entertainment, Language Support, Photos/Music/Videos, Privacy & Security, Search Tools,
Shopping, Social & Communication, Tabs, Web Development, plus a "doesn't fit any of these" box.
None of the rest describes this add-on without stretching, and a stretched category is a thing
reviewers and users can hold against the listing, so one accurate beats two padded.

Removed: `language-support`, which the listing carried and which describes nothing it does.

## Tags

```
chat, dark mode, privacy, translate
```

**Tags are a FIXED LIST of checkboxes, not free text** (max 10 of ~39). An earlier version of this
file listed `dark theme, night mode, darkmode, contrast, accessibility, ai, local ai` — of those
only `dark mode` exists. There is no tag for AI, contrast or accessibility at all.

The four chosen are the ones that name something the add-on actually does: `dark mode`, `chat`
(the sidebar is one), `translate` (a context-menu action), `privacy` (no account, no telemetry,
data goes only to the gateway you run). The rest of the list is products and verticals — youtube,
roblox, torrent, password manager, vpn — none of which apply.

## Homepage / support

- Homepage: https://github.com/lmgw-dev/inkference
- Support site: https://github.com/lmgw-dev/inkference/issues
- License: MIT
- Privacy policy: paste the contents of [PRIVACY.md](../../PRIVACY.md)

## Description

Inkference is a dark mode that checks its own work, plus a sidebar that brings your own local LLMs
into the browser.

**AI dark mode (works without any LLM)**
Click the toolbar button. Inkference reads every colour rule the site sets, measures how much of
the screen is light, rewrites the colours by role (backgrounds, text, borders, accents keep their
hue) and measures again. The result is cached per site and applied instantly on every later visit.
If the site ships its own dark theme, Inkference switches that on instead of imitating it.

**It grades readability, not just darkness.** Turning a surface dark without lightening the text on
it looks perfect to any measure of "how dark is this page" and is unreadable to a person. So after
applying a theme Inkference compares every piece of text against the surface actually painted
behind it, by WCAG contrast, and counts what falls below 3:1. That number is what catches the
failures a light-fraction reading cannot see.

- The tooltip shows the result, e.g. "76% → 0% of the viewport light".
- No script keeps running in the page: each theme is a plain user stylesheet.
- Right-click the button to recompile or forget a site.

With a local model connected via lmgw, the model designs the plan for each site; the compiler still
writes the CSS.

**With lmgw (free, self-hosted: https://github.com/lmgw-dev/lmgw)**

- Sidebar chat (Ctrl+Shift+L) with a "Use page" mode: the agent reads the page and can click, type
  and scroll for you. Purchases and other irreversible clicks wait for your approval; opening a new
  site asks first.
- Right-click: summarize, explain, rewrite, translate or ask about a selection or the whole page.
- Read aloud through lmgw's text-to-speech models.
- Script mode: hide or fade the overlays on top of videos, per site.

**Privacy**
No account, no analytics, no telemetry. Data goes only to the gateway you configure, by default
127.0.0.1 on your own machine.

---

## Where the users are

Not AMO search. Measured: the listing has 2 daily users against Dark Reader's 1.36M, and user count
is itself a ranking input — the search result is a consequence of reach, not a route to it. Someone
querying "dark mode" also already has a working one.

The reachable audience is the one that wants its own models in the browser without pages going to a
third party: r/LocalLLaMA, r/selfhosted, Hacker News, llama.cpp-adjacent communities, and lmgw's own
users. There the dark mode is the hook that needs no setup, and the readability grading is a
concrete, checkable claim rather than a slogan.

---

## Notes to reviewer

Paste into "Notes to Reviewer" (AMO caps it at 3000 characters; this is ~2800).

```
Inkference connects the browser to a self-hosted LLM gateway (lmgw, MIT, https://github.com/lmgw-dev/lmgw) on the user's own machine, default http://127.0.0.1:8787. There is no server of ours. The dark mode works without the gateway, so it can be tested without any setup.

Testing without lmgw: open any light site (e.g. en.wikipedia.org) and click the toolbar button. The tooltip reports the light fraction before -> after. On addons.mozilla.org and other restricted Mozilla hosts the button is greyed out by design.

The LLM features need an OpenAI-compatible endpoint; set its URL in the options page. mock/ in the source archive (npm run mock) is a local test site.

Source / build:
- All code in src/ is hand-written ES modules, not built or minified.
- src/vendor/{readability,marked,dompurify}.js are esbuild bundles of @mozilla/readability, marked and dompurify (pinned in package-lock.json). Reproduce with Node 22 / npm 10+:
    npm ci
    npm run vendor
  The output is byte-identical to the shipped files.

Permissions:
- <all_urls>: the dark mode probes the page's CSS and applies a per-site stylesheet (tabs.insertCSS) on sites the user clicks it on; the sidebar agent reads and operates the tab the user asks it to; cross-origin stylesheets are fetched by the background because .cssRules throws on them.
- http://127.0.0.1:8787/*: the default gateway address.
- webRequest + webRequestBlocking: an approval gate. When the user lets the agent change a setting in a page form (e.g. their router's admin page), every write request (POST/PUT/PATCH/DELETE) from that tab is held until the user approves it in the sidebar, showing method, URL and body. Armed only during such a task, removed when it ends.
- webNavigation: enumerates frames so the agent and per-site scripts reach iframes; re-applies per-site stylesheets on navigation.
- tabs, activeTab, menus, notifications, storage: tab access, right-click actions, read-aloud errors when no sidebar is open, settings.

innerHTML warnings: sidebar/chat.js renders model replies via marked, then DOMPurify (media, forms, <style> and URL-bearing attributes forbidden), before assigning innerHTML. The rest are inside Readability and DOMPurify.

Data collection: websiteContent and browsingActivity are declared because page text, URLs and titles go to the user-configured gateway when the user runs a sidebar/agent task. Nothing goes anywhere else, and nothing is sent before the user configures a gateway and uses such a feature.

Page-world scripts: content/net-hook.js injects a small fetch/XHR wrapper only when the user approves rewriting an outgoing form value during an agent task; content/cheat-hud.js (Ctrl+Shift+G) is a developer console for reading/writing a single-player browser game's JS state via wrappedJSObject.
```

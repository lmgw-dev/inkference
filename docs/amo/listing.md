# AMO listing: Inkference

Copy-paste material for the addons.mozilla.org submission. Not shipped in the extension.

## Name

Inkference

## Summary (≤ 250 characters)

A dark mode that measures each site and compiles a theme for it, no LLM needed. Connect your own
local models via lmgw for per-site AI themes, a page-aware sidebar agent and read-aloud.

## Categories

**Appearance**, **Other**

## Tags

dark mode, dark theme, ai, llm, local ai, sidebar, accessibility, text to speech

## Homepage / support

- Homepage: https://github.com/lmgw-dev/inkference
- Support site: https://github.com/lmgw-dev/inkference/issues
- License: MIT
- Privacy policy: paste the contents of [PRIVACY.md](../../PRIVACY.md)

## Description

Inkference is a dark mode that checks its own work, plus a sidebar that brings your own local LLMs
into the browser.

**AI dark mode (works without any LLM)**
Click the toolbar button. Inkference reads every colour rule the site sets, measures how much of the
screen is light, rewrites the colours by role (backgrounds, text, borders, accents keep their hue)
and measures again. The result is cached per site and applied instantly on every later visit. If the
site ships its own dark theme, Inkference switches that on instead of imitating it.

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

## Notes to reviewer

Paste into "Notes to Reviewer".

```
Inkference connects the browser to a self-hosted LLM gateway (lmgw, MIT, https://github.com/lmgw-dev/lmgw)
running on the user's own machine, default http://127.0.0.1:8787. There is no server of ours.
The dark mode works without the gateway, so it can be tested without any setup.

Testing without lmgw:
- Open any light site (e.g. en.wikipedia.org), click the toolbar button. The tooltip reports the
  light fraction before -> after.

Testing with a fake gateway: the source archive contains mock/ (npm run mock), a local test site.
The LLM features need a real OpenAI-compatible endpoint; set its URL in the options page.

Source code / build:
- All extension code in src/ is hand-written ES modules, not built or minified.
- src/vendor/readability.js, src/vendor/marked.js and src/vendor/dompurify.js are esbuild bundles of
  the npm packages @mozilla/readability, marked and dompurify (versions pinned in package-lock.json).
  Reproduce with Node 22 / npm 10+:
      npm ci
      npm run vendor
  The output is byte-identical to the shipped files.

Permissions:
- <all_urls>: the dark mode applies a per-site stylesheet (tabs.insertCSS) and probes the page's CSS
  on any site the user clicks it on; the sidebar agent reads and operates the tab the user asks it
  to; cross-origin stylesheets are fetched by the background because .cssRules throws on them.
- http://127.0.0.1:8787/*: the default gateway address.
- webRequest + webRequestBlocking: an approval gate. When the user lets the agent change a setting
  in a page form (e.g. their router's admin page), every write request (POST/PUT/PATCH/DELETE) from
  that tab is held until the user approves it in the sidebar, showing method, URL and body. It is
  only armed during such a task and removed when the task ends.
- webNavigation: enumerates frames so the agent and per-site scripts reach iframes; re-applies
  per-site stylesheets on navigation.
- tabs, activeTab, menus, notifications, storage: tab access, the right-click actions, read-aloud
  errors when no sidebar is open, settings.

innerHTML (linter warnings):
- sidebar/chat.js renders model replies as markdown via marked and then DOMPurify (media, forms,
  <style> and all URL-bearing attributes forbidden) before assigning innerHTML.
- vendor/*: inside Readability and DOMPurify themselves.

Data collection: websiteContent and browsingActivity are declared because page text, URLs and
titles are sent to the user-configured gateway when the user runs a sidebar/agent task. Nothing is
sent anywhere else, and nothing is sent until the user configures a gateway and uses such a feature.

Page-world scripts: content/net-hook.js injects a small fetch/XHR wrapper into the page only when the
user approves rewriting an outgoing form value during an agent task; content/cheat-hud.js (Ctrl+Shift+G)
is a developer console for reading/writing a single-player browser game's JS state via wrappedJSObject.
```

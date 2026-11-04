// AI dark mode — the "compile once, cache forever" engine.
//
// The toolbar button toggles a per-origin dark theme. On the FIRST visit to an origin we
// probe its stylesheets (content/restyle-probe.js — every colour declaration with its
// selector, colour tokens, native-theme hooks) and census what it paints
// (content/paint-census.js), hand the bounded summary to the LLM once for a PLAN (strategy +
// palette), compile the sheet from the plan in darkcss.js, apply it, and then census AGAIN
// to verify: a native theme that left the page light falls back to recolouring, without a
// second model call. The result is cached keyed by origin; every later visit applies the
// cached sheet instantly — no LLM call, no per-element runtime work, no MutationObserver.
// Steady-state cost is one storage read + one insertCSS.
//
// Why a static sheet can win the cascade: we inject with cssOrigin:"user", so the
// generator's `!important` declarations beat the site's own author `!important` rules. That
// is the lever that lets "compile once" hold up against pages built to resist restyling.
//
// State:
//   cache   — { [origin]: entry }            persisted (darkCache)
//   enabled — Set<origin> toggled on         persisted (darkEnabledOrigins); drives re-apply
//   applied — Map<tabId, { origin, css, rootRevert, done }>   in-memory, per live document

import { get, set } from "../common/storage.js";
import { chatOnce } from "./gateway.js";
import { DARK_MODE_SYSTEM_PROMPT, buildDarkUserMessage } from "../common/prompts.js";
import { STILL_LIGHT_FRACTION, compileSheet, defaultPlan, hashProbe, parsePlan, summarize } from "./darkcss.js";

let cfg = () => ({ gatewayUrl: "", gatewayKey: "", model: null });
let notifyError = () => {};

const cache = new Map();
const enabled = new Set();
const applied = new Map();
const genToken = new Map(); // tabId -> token object; guards against stale compiles

const BADGE = {
  busy: { text: "…", color: "#b58900" },
  on: { text: "on", color: "#268bd2" },
  err: { text: "!", color: "#dc322f" },
  na: { text: "—", color: "#586e75" },
  off: { text: "", color: "#000000" },
};

function isStylable(url) {
  return /^https?:/.test(url || "");
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function setBadge(tabId, kind, title) {
  const b = BADGE[kind];
  try {
    browser.browserAction.setBadgeText({ tabId, text: b.text });
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: b.color });
    browser.browserAction.setTitle({ tabId, title: title || null }); // null = manifest default
  } catch {
    /* tab gone */
  }
}
// A sheet compiled without a model is the built-in theme: good on most sites, but generic.
// It works with no gateway at all (dark mode is the one feature that needs none), and says
// how to get the designed version. Such entries are marked `generic` and upgraded the next
// time the button turns them on while a model is available.
const NO_MODEL_NOTE = "built-in theme (no LLM connected)";
const UPGRADE_HINT = "Connect an lmgw gateway with a local model (rsd options) for a theme designed per site; it upgrades on the next toggle, or right-click → recompile.";
const upgradeTried = new Set(); // origins whose generic sheet was already retried this session

const pct = (f) => (f == null ? "?" : Math.round(f * 100) + "%");
// The tooltip on the toolbar button is where the compile explains itself: strategy, how much
// of the viewport was light before and after, and whether it had to fall back.
function describe(entry) {
  const v = entry.verify;
  let s = "AI dark mode: on — " + entry.strategy;
  if (v) s += ` (${pct(v.before)} → ${pct(v.after)} of the viewport light${v.fellBack ? `; native theme left ${pct(v.nativeLeft)}, recoloured instead` : ""})`;
  if (entry.rationale) s += "\n" + entry.rationale;
  if (entry.generic) s += "\n" + UPGRADE_HINT;
  return s;
}

// ---- apply / remove --------------------------------------------------------

// CSS goes in as a USER-origin sheet so its !important wins. Remove-then-insert keeps it
// idempotent: a duplicate `complete` event nets exactly one copy.
async function applyCss(tabId, css) {
  if (!css) return;
  try {
    await browser.tabs.removeCSS(tabId, { code: css, cssOrigin: "user" });
  } catch {
    /* not present yet — fine */
  }
  await browser.tabs.insertCSS(tabId, { code: css, cssOrigin: "user" });
}
async function removeCss(tabId, css) {
  if (!css) return;
  try {
    await browser.tabs.removeCSS(tabId, { code: css, cssOrigin: "user" });
  } catch {
    /* doc already gone */
  }
}

// Native-theme activation sets root classes/attributes — on <html> AND <body>, because sites
// hang their hook on either (`html.dark`, `[data-theme=dark]` on the root, `body.theme-dark`)
// and the model cannot set one without the other matching. The injected snippet captures
// prior values and returns them, so we can revert cleanly without clobbering a value the
// site set.
async function applyRoot(tabId, rootAttributes, rootClasses) {
  const attrs = rootAttributes && typeof rootAttributes === "object" ? rootAttributes : {};
  const classes = Array.isArray(rootClasses) ? rootClasses : [];
  if (!Object.keys(attrs).length && !classes.length) return null;
  const code =
    "(function(attrs, classes){var els=[document.documentElement,document.body].filter(Boolean),prev=[],added=[];try{" +
    "els.forEach(function(el,i){prev[i]={};added[i]=[];" +
    "for(var k in attrs){prev[i][k]=el.hasAttribute(k)?el.getAttribute(k):null;el.setAttribute(k,attrs[k]);}" +
    "for(var j=0;j<classes.length;j++){if(!el.classList.contains(classes[j])){el.classList.add(classes[j]);added[i].push(classes[j]);}}});" +
    "}catch(e){}return{prevAttrs:prev,addedClasses:added};})(" +
    JSON.stringify(attrs) +
    "," +
    JSON.stringify(classes) +
    ")";
  try {
    const r = await browser.tabs.executeScript(tabId, { code });
    return (r && r[0]) || null;
  } catch {
    return null;
  }
}
async function revertRoot(tabId, rootRevert) {
  if (!rootRevert) return;
  const code =
    "(function(prev, added){var els=[document.documentElement,document.body];try{" +
    "els.forEach(function(el,i){if(!el||!prev[i])return;" +
    "for(var k in prev[i]){if(prev[i][k]===null)el.removeAttribute(k);else el.setAttribute(k,prev[i][k]);}" +
    "for(var j=0;j<(added[i]||[]).length;j++)el.classList.remove(added[i][j]);});" +
    "}catch(e){}})(" +
    JSON.stringify(rootRevert.prevAttrs || []) +
    "," +
    JSON.stringify(rootRevert.addedClasses || []) +
    ")";
  try {
    await browser.tabs.executeScript(tabId, { code });
  } catch {
    /* doc gone */
  }
}

async function applyEntry(tabId, origin, entry) {
  await applyCss(tabId, entry.css);
  const rootRevert = await applyRoot(tabId, entry.rootAttributes, entry.rootClasses);
  applied.set(tabId, { origin, css: entry.css, rootRevert, done: true });
}
async function removeFromTab(tabId) {
  const rec = applied.get(tabId);
  if (!rec) return;
  await removeCss(tabId, rec.css);
  await revertRoot(tabId, rec.rootRevert);
  applied.delete(tabId);
}

// ---- probe + census + compile ----------------------------------------------

async function execFile(tabId, file) {
  const r = await browser.tabs.executeScript(tabId, { file });
  return r && r[0];
}

// Cross-origin sheets are unreadable from the page (SecurityError on .cssRules) but the
// background can fetch them under the host permission; the probe then parses the text into
// constructed sheets and walks them like the rest.
//
// The hrefs come from the page, and this fetch runs with the extension's host permission and
// returns the body to us — so a public page must not be able to point it at the user's LAN or
// loopback (router, NAS, the lmgw gateway itself). A page that is itself on a private host may
// load private sheets: that is an intranet site (or the mock: localhost ↔ 127.0.0.1).
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;
export function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || PRIVATE_SUFFIX.test(h)) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h);
  return false;
}
export function sheetAllowed(href, pageUrl) {
  let u, page;
  try { u = new URL(href); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (!isPrivateHost(u.hostname)) return true;
  try { page = new URL(pageUrl); } catch { return false; }
  return isPrivateHost(page.hostname);
}

async function fetchSheets(hrefs, pageUrl) {
  const out = [];
  await Promise.all(
    hrefs.filter((href) => sheetAllowed(href, pageUrl)).map(async (href) => {
      try {
        const res = await fetch(href, { credentials: "omit" });
        // A public href may redirect into the LAN; the request is already sent by then, but the
        // body of a disallowed final hop is never read. (Firefox hides Location on a manual
        // redirect, so hops can't be vetted one by one.)
        if (res.redirected && !sheetAllowed(res.url, pageUrl)) return;
        if (!res.ok) return;
        const ct = res.headers.get("content-type") || "";
        if (ct && !/css|text\/plain|octet-stream/i.test(ct)) return;
        out.push({ href, text: await res.text() });
      } catch {
        /* unreachable sheet — the census still sees what it paints */
      }
    })
  );
  return out;
}

async function probe(tabId) {
  let seam = await execFile(tabId, "/content/restyle-probe.js");
  if (!seam || !seam.ok) throw new Error((seam && seam.reason) || "couldn't read this page's styles");
  if (seam.blockedHrefs && seam.blockedHrefs.length) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const extra = await fetchSheets(seam.blockedHrefs, tab && tab.url);
    if (extra.length) {
      await browser.tabs.executeScript(tabId, { code: "globalThis.__rsdDarkExtraSheets = " + JSON.stringify(extra) + "; true;" });
      const again = await execFile(tabId, "/content/restyle-probe.js");
      if (again && again.ok) seam = again;
    }
  }
  return seam;
}

async function census(tabId) {
  try {
    const r = await execFile(tabId, "/content/paint-census.js");
    return r && r.ok ? r : null;
  } catch {
    return null;
  }
}

// Ask the model for a plan. A gateway failure is NOT fatal: the compiler can build a sheet
// from the default theme, and the reason is carried in the rationale (visible in the button
// tooltip) so a dark-but-generic page is never mistaken for a designed one.
async function plan(seam, painted) {
  const { gatewayUrl, gatewayKey, model } = cfg();
  if (!model) return { ...defaultPlan(NO_MODEL_NOTE), generic: true }; // no gateway is not an error here
  const summary = summarize(seam, painted);
  try {
    const text = await chatOnce({
      gatewayUrl,
      gatewayKey,
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: DARK_MODE_SYSTEM_PROMPT },
        { role: "user", content: buildDarkUserMessage(summary) },
      ],
    });
    return parsePlan(text);
  } catch (e) {
    const p = defaultPlan("model unavailable (" + ((e && e.message) || e) + ") — compiled with the default theme");
    notifyError("AI dark mode: " + p.rationale, (e && e.detail) || "");
    return { ...p, generic: true };
  }
}

function build(seam, painted, p) {
  const { css, stats } = compileSheet(seam, painted, p);
  return {
    strategy: stats.strategy,
    css,
    rootAttributes: p.strategy === "native-theme" ? p.rootAttributes : {},
    rootClasses: p.strategy === "native-theme" ? p.rootClasses : [],
    rationale: p.rationale,
    plan: p, // kept so a fallback can recompile without the model
    generic: !!p.generic,
    stats,
    seamHash: hashProbe(seam),
    createdAt: Date.now(),
  };
}

// Measure, don't assume: census the page with the sheet applied. A native theme that left
// most of the viewport light (a section palette the root attribute could not reach) is
// swapped for a recolour built from the same plan.
async function verify(tabId, origin, entry, seam, painted) {
  const before = painted ? painted.lightFraction : null;
  const after = await census(tabId);
  entry.verify = { before, after: after ? after.lightFraction : null, fellBack: false };
  if (after && entry.strategy === "native-theme" && after.lightFraction > STILL_LIGHT_FRACTION) {
    const e2 = build(seam, painted, { ...entry.plan, strategy: "recolor" });
    e2.rationale = (entry.rationale ? entry.rationale + " " : "") + `Native theme left ${pct(after.lightFraction)} of the viewport light; recoloured instead.`;
    await removeFromTab(tabId);
    await applyEntry(tabId, origin, e2);
    const again = await census(tabId);
    e2.verify = { before, after: again ? again.lightFraction : null, fellBack: true, nativeLeft: after.lightFraction };
    return e2;
  }
  return entry;
}

// The whole first-visit pipeline for one tab: probe → census → plan → compile → apply → verify.
async function compileFor(tabId, origin, isCurrent) {
  // Drop a previous sheet FIRST: probe and census read computed colours, so measuring with our
  // own dark sheet still applied would describe (and verify against) an already-dark page.
  await removeFromTab(tabId);
  const seam = await probe(tabId);
  const painted = await census(tabId);
  const p = await plan(seam, painted);
  if (!isCurrent()) return null;
  let entry = build(seam, painted, p);
  await applyEntry(tabId, origin, entry);
  entry = await verify(tabId, origin, entry, seam, painted);
  return entry;
}

async function persistCache() {
  await set({ darkCache: Object.fromEntries(cache) });
}
async function persistEnabled() {
  await set({ darkEnabledOrigins: Array.from(enabled) });
}

// ---- public: toggle / regenerate / re-apply --------------------------------

export async function toggleDark(tab) {
  if (!tab || !isStylable(tab.url)) {
    if (tab) setBadge(tab.id, "na");
    notifyError("AI dark mode can't run on this page type.", tab ? tab.url : "");
    return;
  }
  const tabId = tab.id;
  const origin = originOf(tab.url);

  // Currently on for this document → turn off (and stop re-applying this origin).
  if (applied.has(tabId)) {
    enabled.delete(origin);
    await persistEnabled();
    await removeFromTab(tabId);
    genToken.delete(tabId);
    setBadge(tabId, "off");
    return;
  }

  enabled.add(origin);
  await persistEnabled();

  // Cache hit → instant, zero-latency apply. This is the whole point of compile-once.
  const hit = cache.get(origin);
  if (hit) {
    try {
      await applyEntry(tabId, origin, hit);
      setBadge(tabId, "on", describe(hit));
    } catch (e) {
      setBadge(tabId, "err");
      notifyError("Couldn't apply the cached dark theme.", (e && e.message) || "");
      return;
    }
    // The generic sheet stays on instantly; a model connected since then designs the real one.
    // Once per origin per session, so a gateway that is still down isn't retried on every toggle.
    if (hit.generic && cfg().model && !upgradeTried.has(origin)) {
      upgradeTried.add(origin);
      await regenerate(tab);
    }
    return;
  }

  // Cache miss → compile once. Guard against the user toggling off mid-compile.
  const token = {};
  genToken.set(tabId, token);
  setBadge(tabId, "busy", "AI dark mode: compiling…");
  try {
    const entry = await compileFor(tabId, origin, () => genToken.get(tabId) === token && enabled.has(origin));
    if (!entry) return; // toggled off while compiling
    cache.set(origin, entry);
    await persistCache();
    setBadge(tabId, "on", describe(entry));
  } catch (e) {
    if (genToken.get(tabId) === token) {
      setBadge(tabId, "err");
      notifyError("AI dark mode failed: " + ((e && e.message) || "unknown error"), (e && e.detail) || "");
    }
  } finally {
    if (genToken.get(tabId) === token) genToken.delete(tabId);
  }
}

// Delete the cached theme for this origin and turn it off. Use when a site compiled badly:
// the next toggle starts from a clean slate (a fresh compile) instead of re-applying the bad
// sheet from cache. Strips styling from the current document immediately; other open tabs of
// the same origin clear on their next load (they're no longer enabled, so won't re-apply).
export async function forget(tab) {
  if (!tab) return;
  const tabId = tab.id;
  const origin = originOf(tab.url);
  if (!origin) return;
  genToken.delete(tabId); // cancel any in-flight compile for this tab
  await removeFromTab(tabId); // no-op if nothing is currently applied here
  const had = cache.delete(origin);
  enabled.delete(origin);
  await persistCache();
  await persistEnabled();
  setBadge(tabId, "off");
  if (!had) notifyError("No saved dark theme for this site to forget.", origin);
}

// Force a fresh probe + compile for the active tab's origin, ignoring the cache. Useful
// after a site redesign or to iterate on the generator. Applies the result if toggled on.
export async function regenerate(tab) {
  if (!tab || !isStylable(tab.url)) return;
  const tabId = tab.id;
  const origin = originOf(tab.url);
  const token = {};
  genToken.set(tabId, token);
  setBadge(tabId, "busy", "AI dark mode: recompiling…");
  try {
    const entry = await compileFor(tabId, origin, () => genToken.get(tabId) === token);
    if (!entry) return;
    cache.set(origin, entry);
    await persistCache();
    enabled.add(origin);
    await persistEnabled();
    setBadge(tabId, "on", describe(entry));
  } catch (e) {
    if (genToken.get(tabId) === token) {
      setBadge(tabId, "err");
      notifyError("Recompile failed: " + ((e && e.message) || "unknown error"), (e && e.detail) || "");
      // compileFor took the old sheet off before measuring; put the cached one back.
      const prev = cache.get(origin);
      if (prev && enabled.has(origin)) await applyEntry(tabId, origin, prev).catch(() => {});
    }
  } finally {
    if (genToken.get(tabId) === token) genToken.delete(tabId);
  }
}

// ---- init ------------------------------------------------------------------

const REGEN_MENU_ID = "rsd-dark-regen";
const FORGET_MENU_ID = "rsd-dark-forget";

export async function initDarkmode({ getConfig, onError }) {
  if (typeof getConfig === "function") cfg = getConfig;
  if (typeof onError === "function") notifyError = onError;

  const storedCache = (await get("darkCache")) || {};
  for (const [origin, entry] of Object.entries(storedCache)) cache.set(origin, entry);
  for (const origin of (await get("darkEnabledOrigins")) || []) enabled.add(origin);

  try {
    browser.browserAction.setBadgeTextColor({ color: "#fff" });
  } catch {
    /* older Firefox: badge text color not settable — ignore */
  }

  browser.browserAction.onClicked.addListener((tab) => toggleDark(tab));

  // Right-click the toolbar button → recompile (try a new theme) or forget (delete the bad
  // one). (browser_action context menus live on the button itself.)
  browser.menus.create({
    id: REGEN_MENU_ID,
    title: "AI dark mode: recompile this site (new theme)",
    contexts: ["browser_action"],
  });
  browser.menus.create({
    id: FORGET_MENU_ID,
    title: "AI dark mode: forget this site (delete saved theme)",
    contexts: ["browser_action"],
  });
  browser.menus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    if (id === REGEN_MENU_ID) regenerate(tab);
    else if (id === FORGET_MENU_ID) forget(tab);
  });

  // Re-apply on navigation so an enabled origin stays dark across loads and new tabs.
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") {
      // New document is replacing the old one; its injected CSS/attrs are gone with it.
      applied.delete(tabId);
      return;
    }
    if (changeInfo.status !== "complete") return;
    const origin = originOf(tab.url);
    if (!origin || !isStylable(tab.url)) return;
    if (!enabled.has(origin) || !cache.has(origin)) return;
    const rec = applied.get(tabId);
    if (rec && rec.done && rec.origin === origin) return; // already applied to this document
    try {
      const entry = cache.get(origin);
      await applyEntry(tabId, origin, entry);
      setBadge(tabId, "on", describe(entry));
    } catch {
      /* page raced us / not injectable */
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    applied.delete(tabId);
    genToken.delete(tabId);
  });
}

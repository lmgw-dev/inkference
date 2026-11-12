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
  off: { text: "", color: "#000000" },
};

function isStylable(url) {
  return /^https?:/.test(url || "");
}

// Firefox keeps every extension off these hosts (extensions.webextensions.restrictedDomains), so
// an injection there fails by design. Shown as "not available here", not as an error: the first
// place a store reviewer clicks the button may well be addons.mozilla.org.
const RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net", "accounts.firefox.com", "addons.cdn.mozilla.net", "addons.mozilla.org",
  "api.accounts.firefox.com", "content.cdn.mozilla.net", "discovery.addons.mozilla.org", "install.mozilla.org",
  "oauth.accounts.firefox.com", "profile.accounts.firefox.com", "support.mozilla.org", "sync.services.mozilla.com",
]);
const NA_RESTRICTED = "AI dark mode: Firefox doesn't let extensions change this site";
const NA_PAGE = "AI dark mode: not available on this kind of page";
function isRestricted(url) {
  try {
    return RESTRICTED_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
// Where it can't run, the whole button greys out (disabled for that tab; the tooltip still says
// why) instead of carrying a badge. Set on every navigation, so it is grey before anyone clicks.
const greyed = new Set(); // tab ids whose button is disabled
function markUnavailable(tabId, title) {
  greyed.add(tabId);
  try {
    browser.browserAction.setBadgeText({ tabId, text: "" });
    browser.browserAction.setTitle({ tabId, title });
    browser.browserAction.disable(tabId);
  } catch {
    /* tab gone */
  }
}
function updateAvailability(tabId, url) {
  if (!isStylable(url)) markUnavailable(tabId, NA_PAGE);
  else if (isRestricted(url)) markUnavailable(tabId, NA_RESTRICTED);
  else if (greyed.delete(tabId)) {
    try {
      browser.browserAction.enable(tabId);
      browser.browserAction.setTitle({ tabId, title: null }); // back to the manifest default
    } catch {
      /* tab gone */
    }
  }
}

// The badge for a failed compile/apply: a refused injection (a restricted host this list doesn't
// know, a privileged page) is "not available"; anything else is a real error, named in the tooltip.
function failBadge(tabId, what, e) {
  const msg = (e && e.message) || "unknown error";
  if (/missing host permission|cannot access|non-structured-clonable|can't access/i.test(msg)) {
    markUnavailable(tabId, NA_PAGE);
    return false;
  }
  setBadge(tabId, "err", `${what}: ${msg}\nRight-click: recompile / forget`);
  return true;
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
const UPGRADE_HINT = "Connect an lmgw gateway with a local model (Inkference options) for a theme designed per site; it upgrades on the next toggle, or right-click → recompile.";
const upgradeTried = new Set(); // origins whose generic sheet was already retried this session

const pct = (f) => (f == null ? "?" : Math.round(f * 100) + "%");
// The tooltip on the toolbar button is where the compile explains itself: strategy, how much was
// light before and after, and whether it had to fall back. BOTH readings are named, because the
// one page shape where the viewport number is meaningless — a tall dark hero over a light body —
// is exactly the shape whose tooltip someone reads when asking why nothing happened.
function describe(entry) {
  const v = entry.verify;
  let s = "AI dark mode: on — " + entry.strategy;
  if (v)
    s +=
      ` (viewport ${pct(v.before)} → ${pct(v.after)} light, page ${pct(v.beforeDoc)} → ${pct(v.afterDoc)}` +
      `${v.fellBack ? `; native theme left ${pct(v.nativeLeft)}, recoloured instead` : ""})`;
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

// Amazon-class pages inject their widget stylesheets AND their DOM late — after the document
// is `complete` — so a probe fired the instant the button is clicked sees only a fraction of
// the page's CSS (measured on amazon.de: 14 of the 30 stylesheets it finally settles to) and
// the compiler darkens only that fraction, leaving whole widgets (grey card frames, white
// product tiles, carousel arrows) light. So before the FIRST compile we wait for the document
// to go QUIET: no new stylesheet and no structural DOM change (childList/attributes — pure
// text ticks like a countdown are ignored, or a live clock would never settle) for
// SETTLE_QUIET ms, capped at SETTLE_MAX. Cheap (one short-lived observer + a poll), and it
// runs once per origin — the cached sheet re-applies instantly on every later visit, so steady
// state is untouched. A recompile on an already-settled page returns almost immediately.
const SETTLE_QUIET = 600;
const SETTLE_MAX = 8000;
async function settle(tabId) {
  const code =
    "new Promise(function(resolve){" +
    "var QUIET=" + SETTLE_QUIET + ",MAX=" + SETTLE_MAX + ",t0=Date.now(),last=Date.now(),sheets=document.styleSheets.length;" +
    "var mo=new MutationObserver(function(){last=Date.now();});" +
    "try{mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true});}catch(e){}" +
    "var iv=setInterval(function(){var now=Date.now(),s=document.styleSheets.length;" +
    "if(s!==sheets){sheets=s;last=now;}" +
    "var quiet=now-last,ready=document.readyState==='complete';" +
    "if((ready&&quiet>=QUIET)||now-t0>=MAX){clearInterval(iv);mo.disconnect();resolve({waited:now-t0,sheets:s});}" +
    "},150);});";
  try {
    const r = await browser.tabs.executeScript(tabId, { code });
    return (r && r[0]) || null;
  } catch {
    return null; // not injectable / page raced us — compile with whatever the probe sees
  }
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
  // A trailing dot is the same host to the resolver ("localhost." is localhost).
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!h || PRIVATE_SUFFIX.test(h)) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6: anything in ::/96 (::, ::1, v4-compatible ::7f00:1, v4-mapped ::ffff:…) embeds or is
  // a local address; plus unique-local fc00::/7, link-local fe80::/10 and NAT64 64:ff9b::/96.
  if (h.includes(":")) return h.startsWith("::") || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("64:ff9b:");
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

// A conspicuous light surface, in CSS px² — about 200×200. The point of an AREA and not another
// fraction is that a fraction asks the wrong question: the same infobox is 5.7% of a 2000px-wide
// window and 11% of a 1000px one, so a share-based gate decides on window size rather than on
// what the reader is looking at. Measured on de.wikipedia.org: with the sheet compiled on the
// main page, an article's taxobox is a 335×920 white box — 308,000 px², unmistakable — and it
// came to 5.7% of the viewport against the 6% gate, so `topUp` returned at its first test and
// the box stayed light for good. It only cleared 6% in my own measurements because the white
// fundraising banner happened to be on screen and carried 152 of the 182 light samples.
const LIGHT_SURFACE_PX = 40000;
// Unreadable text is a STRICTLY worse failure than a light surface and is measured anyway, so it
// triggers a top-up too — but not on a single stray run, because a site ships low-contrast text
// of its own and re-probing every load for someone else's grey-on-grey is not worth it.
const TOPUP_UNREADABLE = 5;
// `unreadableSettled` switches the third trigger off for an origin where a top-up has already
// been tried and did not reduce the count. THE TRIGGER MUST CONVERGE, and this one stopped
// converging the moment the census learned to read `lab()`/`oklch()`: it then saw unreadable
// text it had been blind to, on pages where a re-probe cannot fix it (react.dev 20, dev.to 9,
// mediamarkt.de 47 — the site's own low-contrast text, and gaps of ours that a per-page sheet
// does not close). Every navigation therefore pulled our sheet off, re-probed, and rebuilt to
// the same result: the cache looked broken, each load flashed for the length of a probe, and
// nothing improved. The other two triggers are unaffected — a light surface that is still there
// after a top-up is a different matter, and those were measured to converge.
export function needsTopUp(c, unreadableSettled) {
  if (!c) return false;
  if (Math.max(c.lightFraction || 0, c.docLightFraction || 0) > RELIGHT_FRACTION) return true;
  if (c.lightSurface && c.lightSurface.area > LIGHT_SURFACE_PX) return true;
  if (unreadableSettled) return false;
  return (c.unreadable || 0) >= TOPUP_UNREADABLE;
}

// A sheet is compiled once per ORIGIN, but it is a list of the SELECTORS that existed on the
// page it was compiled from. Another page of the same origin brings widgets that sheet never
// heard of, while its generic text rules still fire — so the text goes light and the surface
// under it stays white. Measured on amazon.de: the sheet compiled on the home page, applied to
// a category page, left 459 pieces of light text on a light surface (the category cards, the
// "Empfehlungen" band, 418 prices); the same page compiled for itself left 0.
//
// So the cached sheet is applied first, exactly as before — it is instant and it is right for
// everything the two pages share — and then this tops it up: re-probe THIS document and
// rebuild from the plan already cached for the origin. No model call, no new plan; the theme,
// palette and strategy are the origin's and do not change. The cache keeps the origin's own
// sheet, because a per-page sheet must not become what the next page inherits.
async function topUp(tabId, origin, entry) {
  if (!entry || !entry.plan) return;
  // MEASURE FIRST. Two reasons. It is cheaper: a page the origin's sheet already covers needs no
  // work at all, and a census is far less than a probe on a heavy document, so the common case
  // now costs less than it did when this always re-probed. And it is the only way to catch a
  // NATIVE THEME that does not reach this page: the hook was verified once, on the page it was
  // compiled from, and `verify` never runs again — so an origin whose home page the hook covers
  // and whose article pages it does not stayed half light for good, with nothing in the pipeline
  // able to notice. Both census readings count, as everywhere else.
  const c = await census(tabId);
  if (!c) return;
  if (!needsTopUp(c, entry.unreadableSettled)) return;
  const rec = applied.get(tabId);
  if (!rec || rec.origin !== origin) return;

  // OUR SHEET COMES OFF BEFORE WE PROBE. `compileFor` and the relight loop both do this and say
  // why — probe and census read COMPUTED colours — and this was the one call site that did not.
  // The cost is not cosmetic: the probe reads each token's value in force at the root, so with
  // our sheet applied every token reads back as the dark colour WE put there, `mapByRole` finds
  // nothing to darken, and the root-token pass emits nothing at all. Measured on an IMDb title
  // page: the origin's sheet carried 35 root pins and held the page at 0% light; a top-up
  // probing through it produced 0 pins, and swapping that sheet in put the page back to 93%
  // document-light with 10 unreadable runs. The top-up undid the only thing darkening the page.
  // Wikipedia hid this, because its light surfaces are literal declarations rather than tokens —
  // there the dirty probe lost 123 of 129 pins and still looked identical.
  //
  // The page is light for as long as the probe takes, which is why the sheet is pulled only
  // AFTER the census above has decided there is work to do: on a page the origin's sheet already
  // covers nothing is removed and nothing flickers. `settle` is not repeated — the caller
  // already waited for it.
  await removeCss(tabId, rec.css).catch(() => {});
  let seam = null;
  let painted = null;
  try {
    seam = await probe(tabId);
    painted = await census(tabId);
  } catch (e) {
    seam = null;
  }
  // Any failure from here on must put the origin's sheet back, or the page is left bare — a far
  // worse outcome than the half-covered page we were trying to improve.
  const restore = async (why) => {
    await applyCss(tabId, rec.css).catch(() => {});
    if (why) noteTopUp(tabId, entry, why);
  };
  if (!seam || !painted) return restore("could not re-read this page");

  // The theme is still right for the pages the hook covers, so the ORIGIN keeps it and the hook
  // stays on; this page alone also gets a recolour built from the same plan, over the top.
  const planHere = entry.strategy === "native-theme" ? { ...entry.plan, strategy: "recolor" } : entry.plan;
  let fresh = null;
  try {
    fresh = build(seam, painted, planHere);
  } catch (e) {
    return restore("could not compile rules for this page");
  }
  if (!fresh.css || fresh.css === rec.css) return restore(null); // nothing to add; back as it was
  const still = applied.get(tabId);
  if (!still || still.origin !== origin) return; // navigated away; that document is gone anyway
  await applyCss(tabId, fresh.css);
  applied.set(tabId, { ...still, css: fresh.css, toppedUp: true });

  // Did it actually help? Only asked when unreadable text is what brought us here, and only to
  // decide whether to try again on the NEXT page of this origin. A top-up that leaves the count
  // where it was will leave it there next time too — the per-page sheet is not what those runs
  // are missing — so the trigger is retired for the origin rather than re-run on every load.
  // Retired on the ORIGIN, not the tab: the tab record is rebuilt by the next navigation, which
  // is exactly the loop this is meant to break. The light-surface and light-fraction triggers
  // stay live, so a page that really is still light is still picked up.
  if (!entry.unreadableSettled && (c.unreadable || 0) >= TOPUP_UNREADABLE) {
    const after = await census(tabId).catch(() => null);
    if (after && (after.unreadable || 0) >= (c.unreadable || 0)) entry.unreadableSettled = true;
  }
}

// A top-up that fails is invisible: it runs detached from the toggle, so a thrown probe left the
// origin's half-covered sheet on the page with nothing anywhere saying why. The tooltip is where
// this pipeline explains itself, so it says so there too.
function noteTopUp(tabId, entry, why) {
  const rec = applied.get(tabId);
  if (rec) applied.set(tabId, { ...rec, topUpFailed: why });
  setBadge(tabId, "on", describe(entry) + "\nThis page: " + why + " — showing the rules compiled for the site's other pages.");
}

// Measure, don't assume: census the page with the sheet applied. A native theme that left
// most of the page light (a section palette the root attribute could not reach) is swapped
// for a recolour built from the same plan.
//
// BOTH readings count, because the hit-tested one only sees the current screenful. A page
// whose hero is taller than the window and natively dark, with its real content white below
// it, measures 0% light at the top however little the theme achieved — so the viewport alone
// would certify a theme that never reached the body. docLightFraction walks the document's
// own surfaces and answers the other half of the question: is there a lot of light further
// down? Either one over the threshold sends us to a recolour, which rewrites declarations and
// so does not care what is currently on screen.
async function verify(tabId, origin, entry, seam, painted) {
  const before = painted ? painted.lightFraction : null;
  const beforeDoc = painted ? painted.docLightFraction : null;
  const after = await census(tabId);
  const stillLight = (c) => !!c && Math.max(c.lightFraction || 0, c.docLightFraction || 0);
  entry.verify = { before, beforeDoc, after: after ? after.lightFraction : null, afterDoc: after ? after.docLightFraction : null, fellBack: false };
  if (after && entry.strategy === "native-theme" && stillLight(after) > STILL_LIGHT_FRACTION) {
    const left = stillLight(after);
    const where = (after.docLightFraction || 0) > (after.lightFraction || 0) ? "the page" : "the viewport";
    const e2 = build(seam, painted, { ...entry.plan, strategy: "recolor" });
    e2.rationale = (entry.rationale ? entry.rationale + " " : "") + `Native theme left ${pct(left)} of ${where} light; recoloured instead.`;
    await removeFromTab(tabId);
    await applyEntry(tabId, origin, e2);
    const again = await census(tabId);
    e2.verify = { before, beforeDoc, after: again ? again.lightFraction : null, afterDoc: again ? again.docLightFraction : null, fellBack: true, nativeLeft: left };
    return e2;
  }
  return entry;
}

// A page that keeps injecting widget CSS after it first goes quiet (amazon.de loads its "SFS"
// design tokens and card stylesheets seconds after `complete`) can pass settle and still have
// whole tiles paint light, because the token definitions the compiler needed weren't in the DOM
// yet. So when the verify census still finds more than RELIGHT_FRACTION of the viewport light,
// re-probe (more sheets have landed) and recompile with the SAME plan — no extra model call —
// up to RELIGHT_ROUNDS times, keeping the darkest result. This is measure-don't-assume: the
// actual paint measurement, not a guessed wait, decides whether another pass is worth it.
const RELIGHT_FRACTION = 0.06;
const RELIGHT_ROUNDS = 2;

// The whole first-visit pipeline for one tab: probe → census → plan → compile → apply → verify,
// then re-probe/recompile while the page still paints light (late-loading CSS).
async function compileFor(tabId, origin, isCurrent) {
  // Drop a previous sheet FIRST: probe and census read computed colours, so measuring with our
  // own dark sheet still applied would describe (and verify against) an already-dark page.
  await removeFromTab(tabId);
  // Then let late-loading stylesheets/widgets land, or the probe sees half the page (see settle).
  await settle(tabId);
  if (!isCurrent()) return null; // toggled off during the wait
  const seam = await probe(tabId);
  const painted = await census(tabId);
  const p = await plan(seam, painted);
  if (!isCurrent()) return null;
  let best = build(seam, painted, p);
  await applyEntry(tabId, origin, best);
  best = await verify(tabId, origin, best, seam, painted);

  // Both readings again: on a page whose first screenful is natively dark the viewport says 0%
  // however much white is below it, so a viewport-only test never asks for another round on the
  // one page shape that needs it most. Measured after the sheet on the reference pages, the
  // document reading is 0–2%, well under RELIGHT_FRACTION, so this asks for no extra round there.
  const lightLeft = (e) => (e.verify ? Math.max(e.verify.after || 0, e.verify.afterDoc || 0) : 0);
  for (let round = 0; round < RELIGHT_ROUNDS && lightLeft(best) > RELIGHT_FRACTION; round++) {
    await removeFromTab(tabId); // off before re-probing: probe/census read computed colours
    await settle(tabId);
    if (!isCurrent()) break;
    const seam2 = await probe(tabId);
    const painted2 = await census(tabId);
    let e2 = build(seam2, painted2, p); // reuse the plan — only coverage changed, not the design
    await applyEntry(tabId, origin, e2);
    e2 = await verify(tabId, origin, e2, seam2, painted2);
    if (lightLeft(e2) <= lightLeft(best)) {
      best = e2; // improved (or tied) — it's the one now applied
    } else {
      await removeFromTab(tabId); // a rare worse pass: put the darker sheet back
      await applyEntry(tabId, origin, best);
      break;
    }
  }
  return best;
}

async function persistCache() {
  await set({ darkCache: Object.fromEntries(cache) });
}
async function persistEnabled() {
  await set({ darkEnabledOrigins: Array.from(enabled) });
}

// ---- public: toggle / regenerate / re-apply --------------------------------

export async function toggleDark(tab) {
  if (!tab) return;
  if (!isStylable(tab.url) || isRestricted(tab.url)) {
    updateAvailability(tab.id, tab.url);
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
      if (failBadge(tabId, "Couldn't apply the cached dark theme", e)) notifyError("Couldn't apply the cached dark theme.", (e && e.message) || "");
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
      if (failBadge(tabId, "AI dark mode failed", e)) notifyError("AI dark mode failed: " + ((e && e.message) || "unknown error"), (e && e.detail) || "");
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
  if (!tab) return;
  if (!isStylable(tab.url) || isRestricted(tab.url)) {
    updateAvailability(tab.id, tab.url);
    return;
  }
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
      if (failBadge(tabId, "Recompile failed", e)) notifyError("Recompile failed: " + ((e && e.message) || "unknown error"), (e && e.detail) || "");
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
  for (const t of await browser.tabs.query({}).catch(() => [])) updateAvailability(t.id, t.url);

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
    if (changeInfo.url) updateAvailability(tabId, changeInfo.url);
    if (changeInfo.status === "loading") {
      // New document is replacing the old one; its injected CSS/attrs are gone with it.
      applied.delete(tabId);
      return;
    }
    if (changeInfo.status !== "complete") return;
    const origin = originOf(tab.url);
    if (!origin || !isStylable(tab.url) || isRestricted(tab.url)) return;
    if (!enabled.has(origin) || !cache.has(origin)) return;
    const rec = applied.get(tabId);
    if (rec && rec.done && rec.origin === origin) return; // already applied to this document
    try {
      const entry = cache.get(origin);
      await applyEntry(tabId, origin, entry);
      setBadge(tabId, "on", describe(entry));
      // The origin's sheet is on; now give THIS page the rules it needs. Deliberately after
      // the badge and never awaited by the caller: the page is already dark, and a slow probe
      // on a heavy document must not hold up the apply. It waits for the page to stop
      // injecting widget CSS first, for the same reason a compile does.
      settle(tabId)
        .catch(() => {})
        .then(() => topUp(tabId, origin, entry))
        .catch((e) => {
          // The origin's sheet is still applied, but say so rather than swallowing it: a silent
          // catch here is why a page that topped up badly looked like a compiler bug.
          noteTopUp(tabId, entry, (e && e.message) || "top-up failed");
        });
    } catch {
      /* page raced us / not injectable */
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    applied.delete(tabId);
    greyed.delete(tabId);
    genToken.delete(tabId);
  });
}

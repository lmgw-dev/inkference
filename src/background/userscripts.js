// Script mode — per-site scripts that hide, fade or move the UI sitting on top of videos,
// built WITH the user by the page agent (or by hand in the Script panel) and re-applied on
// every visit with no model call.
//
// This is the browser half; the data model, the "which CSS belongs in which frame" decision
// and the text the agent reads are pure functions in scriptcore.js.
//
// State:
//   scripts  — { [id]: script }  persisted (userScripts); every save keeps the previous
//              version in script.versions — they are a few hundred bytes each, so all are kept
//   draft    — the ONE script being worked on, bound to one tab  persisted (userScriptDraft),
//              but not its tabId: tab ids are per session, so a restored draft is unbound
//              until the next draftFor() on a tab its patterns match
//   injected — Map<tabId, Map<frameId, Map<key, css>>>  in memory: exactly what we inserted
//              where, because tabs.removeCSS only removes a sheet given its EXACT text
//   ever     — Map<tabId, Map<frameId, Set<css>>>  every sheet ever inserted in that frame (all
//              of ours are cssOrigin "user"), for documents the back/forward cache restores
//   health   — { [scriptId]: record }  persisted (userScriptHealth): do the saved rules still
//              match on the user's visits (see "health" below, and scriptcore.js recordCheck)
//   visits   — Map<tabId, { id, timers }>  in memory: the document each tab shows, being checked
//
// Unlike dark mode (which applies at `complete`, top frame only), CSS goes in from
// webNavigation.onCommitted with runAt document_start, per frame, and frames are matched on
// their own url, the way a registered content script would be. The draft's tab gets the DRAFT
// instead of the saved version it was loaded from — which is what makes test_script's reload
// test the draft.
//
// Measured (Firefox 157, mock/public/feed.html served from localhost): the sheet lands ONE
// animation frame late — the overlays are on screen at ~30ms and gone at ~40ms — because the
// insert is a round-trip through this page while the content process keeps parsing. Pages that
// build their tiles from script after a fetch never show it; an instant page with inline
// markup does, for a frame. contentScripts.register({css, cssOrigin:"user", runAt:
// "document_start"}) IS frame-exact, but neither unregister() nor tabs.removeCSS takes its
// sheet out of an already-loaded document, so live disable/edit/delete in open tabs could not
// be built on it alone (it would need a per-document opt-out switch in every saved sheet).
//
// Measurement runs in the page: content/overlay-census.js, injected on demand into each frame
// and driven as `window.__rsdOverlay({op, …})` (the agent.js callFrame pattern).

import { get, set } from "../common/storage.js";
import * as core from "./scriptcore.js";
import { compileRules, isBroadMatch, validateLabel } from "./rulecss.js";

const CENSUS_FILE = "/content/overlay-census.js";
export const DEFAULT_TEST_SCROLLS = 3;
// A reload that has not reached `complete` by then is measured anyway, and the result says so
// (long-polling pages never complete). Not a cap on the test — just how long we wait for `load`.
const LOAD_WAIT_MS = 30000;
// hide-until-hover fades over .15s; measuring sooner would read the overlay mid-fade.
const CSS_SETTLE_MS = 300;
// Health re-checks after the one at load (see "health" below): feeds and hover UI build what a
// rule targets late, and a count costs ~20 ms.
const HEALTH_RECHECK_MS = [10000, 60000];

let hooks = { onState: () => {}, onOpen: () => {}, onPicked: () => {}, onRepair: () => {}, onError: () => {} };

const scripts = new Map();
let draft = null;
// g1, g2… from the last overlays_of → { frameId, path, sig, desc, key, candidates }. Paths are
// positions in ONE document, so a top-frame commit in the draft's tab clears them.
let groupRefs = {};
let primaryFrame = 0; // the frame holding most of the videos — where scroll/settle run
let testing = false;
let picking = null; // the tab a pick is running in, while the user points at something
// windowId → { id, url, title }: the tab each window's Script panel is about (its active tab, or
// the one whose page-action icon was clicked) — one per window, so a panel never lists "saved
// for this site" for a tab in another window.
const contexts = new Map();

const injected = new Map();
const ever = new Map();
const queues = new Map(); // tabId -> tail of that tab's serialized insert/remove work
let health = {};
const visits = new Map();
let recheckMs = HEALTH_RECHECK_MS;
let visitSeq = 0;

// ---- persistence -------------------------------------------------------------------------

async function persistScripts() {
  await set({ userScripts: Object.fromEntries(scripts) });
}
async function persistDraft() {
  await set({ userScriptDraft: draft });
}
async function persistHealth() {
  await set({ userScriptHealth: health });
}

function normalizeScript(s) {
  return {
    ...s,
    matches: Array.isArray(s.matches) ? s.matches : [],
    rules: Array.isArray(s.rules) ? s.rules : [],
    target: s.target || core.DEFAULT_TARGET,
    enabled: s.enabled !== false,
    versions: Array.isArray(s.versions) ? s.versions : [],
  };
}

function newScriptId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function savedFor(url) {
  return [...scripts.values()].filter((s) => core.matchesAny(s.matches, url));
}

// ---- injection ---------------------------------------------------------------------------

// All CSS work for one tab runs in order: two edits in quick succession (the user typing in
// the panel, the agent adding rules) must not interleave their insert/remove pairs.
function serial(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(tabId, tail);
  tail.then(() => {
    if (queues.get(tabId) === tail) queues.delete(tabId);
  });
  return next;
}

function everIn(tabId, frameId) {
  let frames = ever.get(tabId);
  if (!frames) ever.set(tabId, (frames = new Map()));
  let codes = frames.get(frameId);
  if (!codes) frames.set(frameId, (codes = new Set()));
  return codes;
}

// Bring one frame to exactly the sheets it should carry. `fresh` = a new document just
// committed, so the record of what is in it starts empty (a top-frame commit takes every
// sub-frame with it).
//
// A fresh commit is not always an EMPTY document: one restored from the back/forward cache
// (onCommitted with transitionQualifiers "forward_back") still carries every sheet it had when
// the user left — measured on feed.html — while its record went with the commit that replaced
// it. Those sheets would be unremovable, and an edited version would stack on top. So on every
// fresh commit, each sheet this frame EVER carried that is not wanted now is removed too:
// removing a sheet that isn't there is a no-op, and inserting one that is already there adds
// no second copy (Firefox keeps one sheet per text — measured: one removeCSS after two
// identical insertCSS leaves none), so the wanted ones still go in first, at document_start.
async function syncFrameNow(tabId, frameId, frameUrl, fresh) {
  let frames = injected.get(tabId);
  if (!frames) injected.set(tabId, (frames = new Map()));
  if (fresh) {
    if (frameId === 0) frames.clear();
    else frames.delete(frameId);
  }
  const have = frames.get(frameId) || new Map();
  const want = /^https?:/.test(frameUrl || "") ? core.wantedCss({ scripts: scripts.values(), draft, tabId, frameUrl, accept: sheetParses }) : new Map();
  const { insert, remove } = core.diffCss(have, want);
  const seen = everIn(tabId, frameId);
  const failed = new Set();
  for (const { code } of insert) {
    try {
      await browser.tabs.insertCSS(tabId, { code, cssOrigin: "user", frameId, runAt: "document_start" });
      seen.add(code);
    } catch {
      failed.add(code); // frame gone or not injectable (about:, AMO) — the next sync retries
    }
  }
  const wanted = new Set(want.values());
  const out = new Set(remove.map((x) => x.code));
  if (fresh) for (const code of seen) if (!wanted.has(code)) out.add(code);
  for (const code of out) {
    try {
      await browser.tabs.removeCSS(tabId, { code, cssOrigin: "user", frameId });
    } catch {
      /* the document is already gone */
    }
  }
  const now = new Map([...want].filter(([, code]) => !failed.has(code)));
  if (now.size) frames.set(frameId, now);
  else frames.delete(frameId);
}

// ---- the browser's own parse ---------------------------------------------------------------
// rulecss.js keeps every string it emits inside its own block, but only the browser's CSS
// parser knows what it will keep: one selector in a list it rejects drops the whole block
// (click-through on `x::after` compiles to `x::after, x::after *`), and anything that slipped
// past validation and left a block open would swallow every later rule while each selector
// still counts fine on its own. This page has a DOM, so every sheet is parsed here first
// (CSSStyleSheet.replaceSync) and must come out with exactly the style rules compileRules
// emitted — a sheet that does not is never applied.

const parseMemo = new Map(); // css text → null | what is wrong with it (scripts repeat on every load)

function parsedRules(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet.cssRules.length;
}

// One rule alone, then a sentinel block: all of the rule's own blocks must survive, and so must
// the sentinel — which is what proves the rule cannot swallow the rules after it.
function ruleSheetError(rule) {
  if (typeof CSSStyleSheet !== "function") return null;
  const { css, errors, blocks } = compileRules([rule]);
  if (errors.length) return errors[0].error;
  let own;
  let withNext;
  try {
    own = parsedRules(css);
    withNext = parsedRules(css + "\n.rsd-sentinel {}\n");
  } catch (e) {
    return `the browser's CSS parser rejects it (${(e && e.message) || e})`;
  }
  if (own < blocks) {
    return (
      `the browser drops ${blocks - own} of the ${blocks} CSS block${blocks === 1 ? "" : "s"} this ${rule.action} rule compiles to — ` +
      "part of the selector is not allowed where this action puts it (a pseudo-element like ::before/::after cannot take " +
      "click-through or hide-until-hover). Target the element itself — inspect shows its candidates — or use hide, dim or restyle"
    );
  }
  if (withNext < own + 1) return "its CSS leaves a block open and would swallow every rule after it — write the selector and values plainly";
  return null;
}

// The whole sheet of a script (its compileScript result): null when it parses into exactly
// `blocks` style rules, else what is wrong, naming the rule when one alone shows it.
function sheetProblem(compiled, rules) {
  if (typeof CSSStyleSheet !== "function") return null;
  if (parseMemo.has(compiled.css)) return parseMemo.get(compiled.css);
  let problem = null;
  let n = -1;
  try {
    n = parsedRules(compiled.css);
  } catch (e) {
    problem = `the browser's CSS parser rejects it (${(e && e.message) || e})`;
  }
  if (!problem && n !== compiled.blocks) {
    let culprit = null;
    for (const r of rules || []) {
      if (compileRules([r]).errors.length) continue; // skipped by compileRules, not in the sheet
      const e = ruleSheetError(r);
      if (e) {
        culprit = `${r.id}: ${e}`;
        break;
      }
    }
    problem = culprit || `the browser parses its CSS into ${n} style rules instead of ${compiled.blocks}`;
  }
  parseMemo.set(compiled.css, problem);
  return problem;
}

const sheetParses = (compiled, script) => !sheetProblem(compiled, script.rules);

function scriptSheetProblem(script) {
  return script && script.rules.length ? sheetProblem(core.compileScript(script), script.rules) : null;
}

async function syncTab(tabId) {
  if (tabId == null) return;
  await serial(tabId, async () => {
    let frames = null;
    try {
      frames = await browser.webNavigation.getAllFrames({ tabId });
    } catch {
      /* tab gone */
    }
    if (!frames) {
      injected.delete(tabId);
      return;
    }
    const live = new Set(frames.map((f) => f.frameId));
    const rec = injected.get(tabId);
    if (rec) for (const id of [...rec.keys()]) if (!live.has(id)) rec.delete(id);
    for (const f of frames) await syncFrameNow(tabId, f.frameId, f.url, false);
  });
  updatePageAction(tabId);
}

// After a save, an enable/disable or a delete: every tab that matches — or carried the old CSS.
async function syncAll() {
  let tabs = [];
  try {
    tabs = await browser.tabs.query({});
  } catch {
    /* ignore */
  }
  await Promise.all(tabs.filter((t) => /^https?:/.test(t.url || "") || injected.has(t.id)).map((t) => syncTab(t.id)));
}

function onCommitted(d) {
  if (d.tabId < 0) return;
  // A new document is a new visit: the last one's pending health checks are about a page that
  // is gone (a bfcache restore counts as a visit too — the user came back to it).
  if (d.frameId === 0) newVisit(d.tabId);
  // Group paths point into the document that was just replaced; the census's `sig` check would
  // catch most reuse, but a fresh page is a fresh overlays_of.
  if (d.frameId === 0 && draft && draft.tabId === d.tabId) groupRefs = {};
  const restored = d.frameId === 0 && (d.transitionQualifiers || []).includes("forward_back");
  serial(d.tabId, async () => {
    await syncFrameNow(d.tabId, d.frameId, d.url, true);
    // A page restored from the back/forward cache brings its sub-frame documents back with it,
    // carrying their old sheets, and they need not commit again on their own.
    if (restored) for (const f of await liveFrames(d.tabId)) if (f.frameId !== 0) await syncFrameNow(d.tabId, f.frameId, f.url, true);
  }).then(() => {
    if (d.frameId !== 0) return;
    updatePageAction(d.tabId);
    let shown = draft && draft.tabId === d.tabId;
    for (const [wid, c] of contexts) {
      if (c.id !== d.tabId) continue;
      contexts.set(wid, { ...c, url: d.url });
      shown = true;
    }
    if (shown) emitState();
  });
}

async function liveFrames(tabId) {
  try {
    return (await browser.webNavigation.getAllFrames({ tabId })) || [];
  } catch {
    return [];
  }
}

// pushState / #hash: same document, so the CSS stays — but a pattern with a path may no
// longer match (or start to).
function onSameDocument(d) {
  if (d.tabId < 0) return;
  serial(d.tabId, () => syncFrameNow(d.tabId, d.frameId, d.url, false)).then(() => {
    if (d.frameId === 0) updatePageAction(d.tabId);
  });
}

// ---- page action ---------------------------------------------------------------------------
// The address-bar icon says "a script is changing this page" — which one, how many rules —
// and opens the Script panel. When a saved script applied here has stale rules (health, below)
// it says so instead: an orange dot on the icon, a title naming the script and the rules, and a
// click that starts the repair.

const DEFAULT_ICON = { 48: "/icons/icon-48.png", 96: "/icons/icon-96.png" };
let warnIcon = null; // Promise<{ 16: ImageData, 32: ImageData } | null>, drawn once
const iconWant = new Map(); // tabId -> the icon last asked for (the drawing is async)

function tabKeys(tabId) {
  const keys = new Set();
  for (const frame of (injected.get(tabId) || new Map()).values()) for (const k of frame.keys()) keys.add(k);
  return keys;
}

// The saved scripts applied in this tab that have stale rules, with those rules.
function staleIn(tabId) {
  const out = [];
  for (const k of tabKeys(tabId)) {
    const s = k !== core.DRAFT_KEY && scripts.get(k);
    const stale = s ? core.staleRules(s, health[k]) : [];
    if (stale.length) out.push({ script: s, stale });
  }
  return out;
}

function updatePageAction(tabId) {
  if (!browser.pageAction) return;
  const keys = tabKeys(tabId);
  if (!keys.size) {
    quiet(() => browser.pageAction.hide(tabId));
    return;
  }
  const parts = [];
  for (const k of keys) {
    const s = k === core.DRAFT_KEY ? draft : scripts.get(k);
    if (!s) continue;
    const draftNote = k === core.DRAFT_KEY && draft.dirty ? ", draft — unsaved" : "";
    parts.push(`"${s.name}" — ${s.rules.length} rule${s.rules.length === 1 ? "" : "s"}${draftNote}`);
  }
  const warn = staleIn(tabId).map((x) => core.fmtStaleTitle(x.script, x.stale));
  const title = warn.length ? `${warn.join("\n")}\n(Inkference script: ${parts.join("; ")})` : `Inkference script: ${parts.join("; ")}\nClick to open the Script panel`;
  quiet(() => browser.pageAction.setTitle({ tabId, title }));
  setIcon(tabId, warn.length > 0);
  quiet(() => browser.pageAction.show(tabId));
}

function setIcon(tabId, warning) {
  if (!browser.pageAction.setIcon) return;
  iconWant.set(tabId, warning);
  (warning ? warnIconData() : Promise.resolve(null)).then((imageData) => {
    if (iconWant.get(tabId) !== warning) return; // asked for the other one meanwhile
    quiet(() => browser.pageAction.setIcon(imageData ? { tabId, imageData } : { tabId, path: DEFAULT_ICON }));
  });
}

// The extension's icon with an orange dot in the corner, at the sizes the address bar uses.
function warnIconData() {
  if (!warnIcon) warnIcon = drawWarnIcon().catch(() => null);
  return warnIcon;
}

async function drawWarnIcon() {
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return null;
  const bmp = await createImageBitmap(await (await fetch(browser.runtime.getURL("icons/icon-96.png"))).blob());
  const out = {};
  for (const size of [16, 32]) {
    const g = new OffscreenCanvas(size, size).getContext("2d");
    g.drawImage(bmp, 0, 0, size, size);
    const r = size * 0.26;
    const c = size - r - size / 32; // the outline stays inside the canvas
    g.beginPath();
    g.arc(c, c, r, 0, 2 * Math.PI);
    g.fillStyle = "#ff8a00";
    g.fill();
    g.lineWidth = size / 16;
    g.strokeStyle = "#1b1d23";
    g.stroke();
    out[size] = g.getImageData(0, 0, size, size);
  }
  return out;
}

// Page-action and sidebar calls on a tab that just closed throw (sync or async) — nothing to do.
function quiet(fn) {
  try {
    Promise.resolve(fn()).catch(() => {});
  } catch {
    /* tab gone */
  }
}

function onPageAction(tab) {
  // First, synchronously: the click is the user gesture sidebarAction.open() requires.
  quiet(() => browser.sidebarAction.open());
  setContextTab(tab);
  // A stale script on this page: the click is "repair it" (its title says so). If that can't
  // start (an unsaved draft of another script), the panel opens with the reason.
  const st = staleIn(tab.id)[0];
  if (st) {
    repairScript(st.script.id, tab.windowId).then(
      (r) => {
        if (!r.error) return;
        hooks.onOpen(tab.windowId);
        hooks.onError(r.error);
      },
      (e) => hooks.onError((e && e.message) || String(e)),
    );
    return;
  }
  hooks.onOpen(tab.windowId);
  emitState();
}

// ---- the panel's view model --------------------------------------------------------------

// The draft, the test and the flags are global; what the panel lists as "saved for this site"
// is per window (`windows[windowId]`), and each sidebar renders its own window's entry.
export function scriptState() {
  const d = draft;
  const windows = {};
  for (const [wid, tab] of contexts) {
    windows[wid] = {
      tab,
      saved: savedFor(tab.url).map((s) => ({
        id: s.id,
        name: s.name,
        matches: s.matches,
        rules: s.rules.length,
        enabled: s.enabled,
        updated: s.updated,
        versions: s.versions.length,
        editing: !!d && d.scriptId === s.id,
        sheetError: scriptSheetProblem(s),
        health: core.healthSummary(s, health[s.id]),
      })),
    };
  }
  return {
    windows,
    draft: d && {
      tabId: d.tabId,
      url: d.url,
      scriptId: d.scriptId,
      name: d.name,
      matches: d.matches,
      target: d.target,
      rules: d.rules,
      counts: d.counts,
      dirty: d.dirty,
      baseline: d.baseline,
      css: d.rules.length ? core.scriptCss(d) : "",
      sheetError: scriptSheetProblem(d),
      // The saved script's verdicts, for the rules the draft has not changed yet.
      health: core.draftHealth(d, d.scriptId && health[d.scriptId]),
      picks: d.picks.map((p) => ({ id: p.id, desc: p.desc, best: (p.candidates && p.candidates[0]) || null })),
    },
    lastTest: d ? d.lastTest : null,
    testing,
    picking: picking != null,
  };
}

function emitState() {
  hooks.onState(scriptState());
}

function setContextTab(tab) {
  if (tab && tab.windowId != null) contexts.set(tab.windowId, { id: tab.id, url: tab.url || "", title: tab.title || "" });
}

async function setContext(tabId) {
  try {
    setContextTab(await browser.tabs.get(tabId));
  } catch {
    /* closed already */
  }
  emitState();
}

async function activeTab(windowId) {
  const q = windowId != null ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  try {
    return (await browser.tabs.query(q))[0] || null;
  } catch {
    return null;
  }
}

// ---- the census ----------------------------------------------------------------------------

function jsonArg(o) {
  // JSON.stringify leaves U+2028/U+2029 raw, which are illegal in a JS string literal — and
  // this string becomes executeScript source, not a parsed JSON value.
  return JSON.stringify(o).replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
}

async function census(tabId, frameId, cmd) {
  await browser.tabs.executeScript(tabId, { file: CENSUS_FILE, frameId });
  const r = await browser.tabs.executeScript(tabId, { code: `window.__rsdOverlay(${jsonArg(cmd)})`, frameId });
  return (r && r[0]) || { ok: false, error: "no result from page" };
}

async function safeCensus(tabId, frameId, cmd) {
  try {
    return await census(tabId, frameId, cmd);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// The tab's injectable frames, top first. about:blank / data: shims are skipped (we can't
// inject into them, and nothing there is a video wall).
async function pageFrames(tabId) {
  let frames = null;
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId });
  } catch {
    /* no webNavigation */
  }
  if (!frames || !frames.length) return [{ frameId: 0, url: "", top: true }];
  return frames
    .filter((f) => f.frameId === 0 || /^https?:/.test(f.url || ""))
    .sort((a, b) => a.frameId - b.frameId)
    .map((f) => ({ frameId: f.frameId, url: f.url || "", top: f.frameId === 0 }));
}

// Frames the draft's rules actually reach — where match counts mean something.
async function draftFrames(tabId) {
  const all = await pageFrames(tabId);
  const mine = all.filter((f) => core.draftApplies(draft, tabId, f.url));
  return mine.length ? mine : all.filter((f) => f.top);
}

async function censusAll(tabId, cmd, frames) {
  const out = [];
  for (const f of frames || (await pageFrames(tabId))) out.push({ ...f, r: await safeCensus(tabId, f.frameId, cmd) });
  return out;
}

function notePrimary(perFrame) {
  let best = null;
  for (const f of perFrame) if (f.r && f.r.ok && f.r.targets > 0 && (!best || f.r.targets > best.r.targets)) best = f;
  if (best) primaryFrame = best.frameId;
}

async function coverage(tabId, target) {
  const per = await censusAll(tabId, { op: "overlays", target });
  notePrimary(per);
  return { ...core.mergeCoverage(per), covering: core.coveringOf(per) };
}

async function countRules(tabId, d) {
  const ids = d.rules.map((r) => r.id);
  if (!ids.length) return {};
  const per = await censusAll(tabId, { op: "count", selectors: d.rules.map((r) => r.selector), target: d.target }, await draftFrames(tabId));
  const m = core.mergeCounts(per, ids.length);
  return m ? Object.fromEntries(ids.map((id, i) => [id, m.counts[i]])) : null;
}

// The panel shows what each rule matches right now; refreshed after every change.
async function refreshCounts() {
  const d = draft;
  if (!d || d.tabId == null) return;
  const counts = await countRules(d.tabId, d).catch(() => null);
  if (draft === d) d.counts = counts;
}

// The only parser that knows what this browser accepts.
function selectorError(sel) {
  try {
    document.createDocumentFragment().querySelector(sel);
    return null;
  } catch {
    return `"${sel}" is not a valid CSS selector`;
  }
}

// ---- the draft -------------------------------------------------------------------------------

// Bind the draft to `tab`: keep it, move it (same site, another tab), or start one — loading
// the site's most recently saved script, so "also hide the badge" extends what exists instead
// of growing a second script. An unsaved draft for ANOTHER site is the user's work and is
// never replaced behind their back.
async function draftFor(tab) {
  if (!tab || !/^https?:/.test(tab.url || "")) return { error: "Script mode works on web pages — open the site first." };
  if (draft && core.matchesAny(draft.matches, tab.url)) {
    if (draft.tabId !== tab.id) {
      const old = draft.tabId;
      draft.tabId = tab.id;
      draft.url = tab.url;
      await persistDraft();
      await syncTab(old);
      await syncTab(tab.id);
      await refreshCounts();
      emitState();
    }
    return { draft };
  }
  if (draft && draft.dirty) {
    return { error: `There is an unsaved script draft for ${hostOf(draft.url)} ("${draft.name}", ${draft.rules.length} rules). Save or discard it in the Script panel first.` };
  }
  const old = draft ? draft.tabId : null;
  const base = savedFor(tab.url)
    .filter((s) => s.enabled)
    .sort((a, b) => b.updated - a.updated)[0];
  draft = core.newDraft({ tabId: tab.id, url: tab.url, script: base || null });
  groupRefs = {};
  await persistDraft();
  if (old !== tab.id) await syncTab(old);
  await syncTab(tab.id);
  await refreshCounts();
  emitState();
  return { draft };
}

// The draft's tab, alive and still on a page the draft matches — or, failing that, the active
// tab if it is on the site (the draft moves there). Used by the panel's buttons.
async function liveDraftTab() {
  if (!draft) throw new Error("There is no script draft.");
  let tab = null;
  try {
    tab = draft.tabId != null ? await browser.tabs.get(draft.tabId) : null;
  } catch {
    /* closed */
  }
  if (tab && core.matchesAny(draft.matches, tab.url)) return tab;
  const act = await activeTab(null);
  if (act && core.matchesAny(draft.matches, act.url)) {
    await draftFor(act);
    return act;
  }
  throw new Error(`The draft's page is not open — open ${draft.url} first.`);
}

// After any change: persist, re-apply in the draft's tab, re-count, tell the panel. `d` is the
// draft the change was made to — the user can discard it (or load another) during any await.
async function applyDraft(d = draft) {
  if (!d || draft !== d) return;
  await persistDraft();
  await syncTab(d.tabId);
  await refreshCounts();
  emitState();
}

// Said to the model when the draft it was changing went away mid-change (Discard, or Edit of
// another script, in the Script panel).
const DRAFT_GONE =
  "the user discarded or replaced the script draft in the Script panel while this was running, so nothing was applied. " +
  "Tell the user, and ask before starting again.";

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

// ---- agent tools ---------------------------------------------------------------------------
// Each returns { text } for the model (formatted in scriptcore.js) and, where a one-line step
// note helps the user follow along, { note }. Errors throw; agent.js turns them into "Error: …".

async function agentDraft(tabId) {
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    /* gone */
  }
  const r = await draftFor(tab);
  if (r.error) throw new Error(r.error);
  return r.draft;
}

// The live block that goes with the user's message at the start of a Script-mode turn (not
// the system prompt — see agent.js). Binding happens here, so the model starts from the rules
// and picks already in the draft.
export async function scriptBriefing(tabId) {
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    /* gone */
  }
  if (!tab || !/^https?:/.test(tab.url || "")) return core.fmtDraftLine(null);
  const r = await draftFor(tab);
  if (r.error) return core.fmtDraftLine(null, { blocked: r.error + " Until then the script tools refuse — tell the user." });
  return core.fmtDraftLine(r.draft, { saved: savedFor(tab.url), health: core.draftHealth(r.draft, r.draft.scriptId && health[r.draft.scriptId]) });
}

export async function overlaysOf(tabId, target) {
  const d = await agentDraft(tabId);
  if (target && String(target).trim() && String(target).trim() !== d.target) {
    const e = selectorError(String(target).trim());
    if (e) throw new Error(e);
    d.target = String(target).trim();
    await persistDraft();
  }
  const per = await censusAll(tabId, { op: "overlays", target: d.target });
  if (draft !== d) throw new Error(DRAFT_GONE);
  notePrimary(per);
  const { text, groups } = core.fmtOverlays(per, { target: d.target, matches: d.matches });
  groupRefs = groups;
  const cov = core.mergeCoverage(per);
  if (!d.rules.length && !d.scriptId && cov.coverage != null) {
    d.baseline = cov.coverage; // nothing of ours is applied yet: this is the page as the site made it
    await persistDraft();
  }
  return { text, note: `overlays_of ${d.target}: ${cov.targets} found, coverage ${core.pct(cov.coverage)}, ${Object.keys(groups).length} groups` };
}

export async function inspectRef(tabId, ref, index) {
  const d = await agentDraft(tabId);
  const key = String(ref || "").trim();
  if (!key) throw new Error("inspect needs a ref: a group id (g1), a pick id (p1) or a CSS selector.");
  // Group and pick refs are positional paths plus the role `sig` the census emitted with them:
  // in a recycling feed the path can point at a different element by now, and the census
  // either finds another element playing the same role (relocated) or says the ref is stale.
  if (/^g\d+$/i.test(key)) {
    const id = key.toLowerCase();
    const g = groupRefs[id];
    if (!g) {
      const known = Object.keys(groupRefs);
      throw new Error(`there is no ${key} — group ids come from the latest overlays_of${known.length ? ` (${known.join(", ")})` : "; call it first (a reload or navigation clears them)"}.`);
    }
    const r = await safeCensus(tabId, g.frameId, { op: "inspect", path: g.path, sig: g.sig, target: d.target });
    if (r.stale) throw new Error(`${id} was recycled by the page and nothing on screen plays its role now — call overlays_of again for fresh group ids.`);
    if (!r.ok) throw new Error(`${r.error || "inspect failed"} — the page changed since overlays_of (scrolled or re-rendered); call overlays_of again for fresh group ids.`);
    return { text: core.fmtInspect(r, r.relocated ? `${id} (the page recycled its first element — this is another element playing the same role)` : id) };
  }
  if (/^p\d+$/i.test(key)) {
    const p = d.picks.find((x) => x.id === key.toLowerCase());
    if (!p) throw new Error(`there is no pick ${key}${d.picks.length ? ` — the user's picks are ${d.picks.map((x) => x.id).join(", ")}` : " — the user hasn't picked anything"}.`);
    // Live if the element (or another playing its role) is still there; otherwise what the
    // user pointed at, as it was.
    const r = await safeCensus(tabId, 0, { op: "inspect", path: p.path, sig: p.sig || undefined, target: d.target });
    if (r.ok) return { text: core.fmtInspect(r, r.relocated ? `${p.id} (picked by the user; the page recycled that element — this is another one playing the same role)` : `${p.id} (picked by the user)`) };
    const why = r.stale ? `${p.id} was recycled by the page — re-pick it or use overlays_of` : "the page has changed since it was picked";
    if (p.inspect) return { text: core.fmtInspect({ ok: true, ...p.inspect, candidates: p.inspect.candidates || p.candidates }, `${p.id} (as picked — ${why})`) };
    return { text: [`${p.id}: ${p.desc} (${why})`, "Selector candidates:", ...(p.candidates || []).map((c) => "  " + core.fmtCandidate(c))].join("\n") };
  }
  const e = selectorError(key);
  if (e) throw new Error(e);
  let last = null;
  for (const f of await pageFrames(tabId)) {
    const r = await safeCensus(tabId, f.frameId, { op: "inspect", selector: key, index: Number(index) || 0, target: d.target });
    if (r.ok) return { text: core.fmtInspect(r, f.top ? key : `${key} (in frame ${f.url})`) };
    last = r;
  }
  throw new Error((last && last.error) || `nothing matches ${key}`);
}

export async function testSelector(tabId, selector) {
  const d = await agentDraft(tabId);
  const sel = String(selector || "").trim();
  const e = sel ? selectorError(sel) : "test_selector needs a selector";
  if (e) throw new Error(e);
  const m = core.mergeTests(await censusAll(tabId, { op: "test", selector: sel, target: d.target }));
  return { text: core.fmtTestSelector(sel, m) };
}

// How many elements the selector matches that ARE or CONTAIN a target — hiding those hides
// the video. null when the browser can't express it (e.g. a pseudo-element inside :is()).
async function wrapCount(tabId, d, selector) {
  const probe = `:is(${selector}):is(${d.target}), :is(${selector}):has(${d.target})`;
  if (selectorError(probe)) return null;
  const m = core.mergeCounts(await censusAll(tabId, { op: "count", selectors: [probe], target: d.target }, await draftFrames(tabId)), 1);
  return m && typeof m.counts[0] === "number" ? m.counts[0] : null;
}

// Which overlay groups from the last overlays_of the selector reaches, and how much of each.
// A hand-written selector can look right by its match count and still skip part of a group
// (gemma4-12b wrote [data-k="hd"] for the HD/LIVE badges: 21 of 24, every LIVE one missed);
// the census answers it against the group's own exemplar (`test` with `path`). Only refs the
// census can vouch for count — with its `sig`, an exemplar the page recycled is relocated to
// one still playing the role or reported stale — so "MISSES k of n of gN" never comes from
// whatever element happens to sit at an old path.
async function groupReach(tabId, d, selector) {
  const out = [];
  for (const [id, g] of Object.entries(groupRefs)) {
    if (!g.sig) continue;
    const r = await safeCensus(tabId, g.frameId, { op: "test", selector, path: g.path, sig: g.sig, target: d.target });
    if (r.ok && !r.stale && r.roleCount && r.sameRole) out.push({ id, roleCount: r.roleCount, sameRole: r.sameRole, candidates: g.candidates });
  }
  return out;
}

// Apply a rule change and measure it: coverage before → after, what the rule touches now.
// `change` only edits the draft object (and validates); the page still shows the old sheet
// until applyDraft, which is what makes the "before" measurement honest.
//
// Every await is a window for the user: Discard (or Edit of another script) in the panel makes
// `d` a dead object — checked after each one, said to the model — and Stop before the change
// is applied takes the edit back out of the draft (a stopped run changes nothing it had not
// already applied). Once applied, Stop just skips the after-measurement.
async function measuredChange(tabId, d, change, verb, signal) {
  const undo = { rules: d.rules.slice(), nextRuleId: d.nextRuleId, dirty: d.dirty };
  const r = change();
  if (r.error) throw new Error(r.error + ". Nothing was changed.");
  const still = () => {
    if (draft !== d) throw new Error(DRAFT_GONE);
    if (signal && signal.aborted) {
      Object.assign(d, undo);
      throw abortError();
    }
  };
  const before = await coverage(tabId, d.target);
  still();
  // What the selector targets, measured before the rule acts on it (see fmtRuleEffect).
  const test = verb === "removed" ? null : core.mergeTests(await censusAll(tabId, { op: "test", selector: r.rule.selector, target: d.target }, await draftFrames(tabId)));
  still();
  const groups = verb === "removed" ? [] : await groupReach(tabId, d, r.rule.selector);
  still();
  await applyDraft(d);
  const applied = () => {
    if (draft !== d) throw new Error(DRAFT_GONE.replace("nothing was applied", "the draft is gone"));
    if (signal && signal.aborted) throw abortError();
  };
  applied();
  await sleep(CSS_SETTLE_MS);
  const after = await coverage(tabId, d.target);
  applied();
  // A sheet the browser parses short is not applied at all (sheetProblem); the rule checks make
  // that unreachable for a single rule, so this is the combined sheet's last word.
  const sheet = scriptSheetProblem(d);
  const refused = sheet ? `WARNING: the draft's CSS is NOT applied — ${sheet}. Fix or remove that rule.` : "";
  if (verb === "removed") {
    return {
      text: [`${r.rule.id} removed. Video coverage ${core.pct(before.coverage)} → ${core.pct(after.coverage)}.`, refused, core.fmtCovering(after.covering, groupRefs), core.UNTESTED].filter(Boolean).join("\n"),
      note: `${r.rule.id} removed · coverage ${core.pct(before.coverage)} → ${core.pct(after.coverage)}`,
    };
  }
  const wraps = await wrapCount(tabId, d, r.rule.selector);
  applied();
  return {
    text: [refused, core.fmtRuleEffect({ verb, rule: r.rule, test, before, after, wraps, groups, still: core.fmtCovering(after.covering, groupRefs) })].filter(Boolean).join("\n"),
    note: `${r.rule.id} ${verb} — ${r.rule.action} ${r.rule.selector} · ${test.matches} match${test.matches === 1 ? "" : "es"} · coverage ${core.pct(before.coverage)} → ${core.pct(after.coverage)}`,
  };
}

export async function addRuleMeasured(tabId, input, { signal } = {}) {
  const d = await agentDraft(tabId);
  return measuredChange(tabId, d, () => core.addRule(d, input, selectorError, ruleSheetError), "added", signal);
}

export async function updateRuleMeasured(tabId, id, patch, { signal } = {}) {
  const d = await agentDraft(tabId);
  return measuredChange(tabId, d, () => core.updateRule(d, String(id || "").trim().toLowerCase(), patch, selectorError, ruleSheetError), "updated", signal);
}

export async function removeRuleMeasured(tabId, id, { signal } = {}) {
  const d = await agentDraft(tabId);
  return measuredChange(tabId, d, () => core.removeRule(d, String(id || "").trim().toLowerCase()), "removed", signal);
}

// What save_script asks the user to approve — and the values it will then save.
// A `match` the model makes up is refused unless it covers the page the rules were built and
// tested on: gemma4-12b, told "*" was not a pattern, tried "*://*" and then saved the localhost
// script for https://www.youtube.com/*. The way out it is offered is to leave match alone.
// A pattern that reaches every site is refused outright here — even one the user typed into the
// panel's Match field: only the panel's own Save (which warns first) may store one.
// `expect` pins the approval to THIS draft as the card showed it (see saveDraft).
export async function savePlan(tabId, { name, match }) {
  const d = await agentDraft(tabId);
  if (!d.rules.length) throw new Error("the draft has no rules yet — nothing to save.");
  const nm = String(name || "").trim() || d.name;
  const le = validateLabel(nm, "name");
  if (le) throw new Error(`the script ${le}. Give it a short one-line name.`);
  const custom = !!(match && String(match).trim());
  const matches = custom ? core.parseMatches(match) : d.matches;
  const keep = d.matches.some(isBroadMatch)
    ? `The draft's own Match (${d.matches.join(" ")}) was set in the Script panel and reaches every site too — ask the user which site to save it for, or let them save it from the panel, which warns first.`
    : `Leave match out to save for ${d.matches.join(" ")}, this site.`;
  const e = core.checkMatches(matches);
  if (e) throw new Error(`${e}. ${keep}`);
  const broad = matches.filter(isBroadMatch);
  if (broad.length) throw new Error(`${broad.join(" ")} reaches every site (or every local file), and a script built on one site is not saved for all of them from here. ${keep}`);
  let url = d.url;
  try {
    url = (await browser.tabs.get(tabId)).url || url;
  } catch {
    /* the draft's own url will do */
  }
  if (custom && !core.matchesAny(matches, url)) throw new Error(`${matches.join(" ")} does not cover this page (${url}), where the rules were made and tested. ${keep}`);
  return { name: nm, matches, text: core.fmtSaveConfirm(d, nm, matches), expect: { draft: d, css: core.scriptCss(d) } };
}

// ---- test run ------------------------------------------------------------------------------

function waitForLoad(tabId, ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(false); // no listener would ever fire for it
    let timer = null;
    const done = (ok) => {
      clearTimeout(timer);
      browser.webNavigation.onCompleted.removeListener(onDone);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onDone = (d) => {
      if (d.tabId === tabId && d.frameId === 0) done(true);
    };
    const onAbort = () => done(false);
    timer = setTimeout(() => done(false), ms);
    browser.webNavigation.onCompleted.addListener(onDone);
    if (signal) signal.addEventListener("abort", onAbort);
  });
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
}

// Reload with the draft (it goes in at document_start through onCommitted), let the page
// settle, measure; then scroll, settle, measure — `scrolls` times. Measures coverage and what
// every rule matches at each step, so a rule that only fits the first tiles shows up.
//
// `tabId` is the agent's: the test runs in the tab the run drives, binding the draft there (or
// refusing) like every other script tool — never by reloading wherever the draft happens to
// live, which may be another site, another window, or a half-filled form. The panel passes no
// tab and tests the draft's own.
export async function testDraft({ scrolls = DEFAULT_TEST_SCROLLS, signal, tabId = null } = {}) {
  // Claimed before the first await: two Re-test clicks (or the panel and the agent at once)
  // would otherwise both get past the check and reload the tab twice.
  if (testing) throw new Error("A test is already running — wait for it to finish.");
  testing = true;
  emitState();
  try {
    const n = Number.isFinite(Number(scrolls)) && Number(scrolls) >= 0 ? Math.floor(Number(scrolls)) : DEFAULT_TEST_SCROLLS;
    let tab;
    if (tabId != null) {
      await agentDraft(tabId);
      tab = await browser.tabs.get(tabId);
    } else tab = await liveDraftTab();
    const d = draft;
    throwIfAborted(signal);
    const notes = [];
    const loaded = waitForLoad(tab.id, LOAD_WAIT_MS, signal);
    await browser.tabs.reload(tab.id);
    if (!(await loaded)) {
      throwIfAborted(signal);
      notes.push(`the page had not finished loading after ${LOAD_WAIT_MS / 1000}s — measured anyway`);
    }
    primaryFrame = 0; // frame ids are new after a reload
    const steps = [];
    const measure = async (label, settled, scrolled) => {
      throwIfAborted(signal);
      const cov = await coverage(tab.id, d.target);
      const counts = await countRules(tab.id, d);
      steps.push({
        label,
        covering: cov.covering,
        coverage: cov.coverage,
        targets: cov.targets,
        measured: cov.measured,
        counts,
        settleTimedOut: !!(settled && settled.timedOut),
        atEnd: !!(scrolled && scrolled.atEnd),
      });
    };
    throwIfAborted(signal);
    await measure("load", await safeCensus(tab.id, 0, { op: "settle" }));
    for (let i = 1; i <= n; i++) {
      throwIfAborted(signal);
      const sc = await safeCensus(tab.id, primaryFrame, { op: "scroll", by: 1 });
      if (!sc.ok) {
        notes.push(`couldn't scroll at step ${i}: ${sc.error || "no scrollable feed found"}`);
        break;
      }
      const settled = await safeCensus(tab.id, primaryFrame, { op: "settle" });
      await measure(`scroll ${i}`, settled, sc);
      if (sc.after === sc.before) {
        notes.push(`scrolling did not move the page at step ${i} — the feed ended`);
        break;
      }
    }
    const last = steps[steps.length - 1];
    const still = last ? core.fmtCovering(last.covering, groupRefs) : "";
    const result = { at: Date.now(), url: tab.url, scrolls: n, steps, baseline: d.baseline, notes, still, ...core.summarizeTest(steps, d.rules) };
    if (draft === d) {
      d.lastTest = result;
      await persistDraft();
    }
    return result;
  } finally {
    testing = false;
    emitState();
  }
}

// ---- health: do the saved rules still match? -------------------------------------------------
// A redesign that renames a script's hooks leaves its rules matching nothing — the overlays are
// back, and nothing said why. So every visit (one document in one tab: newVisit) checks each
// enabled saved script that applied there: once the page has loaded and settled, then again
// HEALTH_RECHECK_MS later while the tab still shows that document, with the census `count` op —
// the script's rule selectors and its target, in every frame where it applied. scriptcore.js
// decides what the numbers mean (checkOutcomes: no target in any frame = no evidence) and folds
// them into the visit (recordCheck: matched in ANY check = alive). Each check is recorded as it
// comes, so a rule shows as stale from the load check of its STALE_VISITS-th missed visit — a
// later check of that visit that finds it takes the verdict back.
// Not checked: the draft (a work in progress, and where it governs, the saved script it was
// loaded from is not applied), disabled scripts, and pages that never fire `load`.

function newVisit(tabId) {
  endVisit(tabId);
  visits.set(tabId, { id: Date.now().toString(36) + "-" + ++visitSeq, timers: [] });
}

function endVisit(tabId) {
  const v = visits.get(tabId);
  if (v) for (const t of v.timers) clearTimeout(t);
  visits.delete(tabId);
}

function onLoaded(d) {
  if (d.tabId < 0 || d.frameId !== 0) return;
  if (!visits.has(d.tabId)) newVisit(d.tabId); // a tab that was loading when we started listening
  const v = visits.get(d.tabId);
  // After the commit's CSS work: until it is done, the record of what applies in the tab is
  // empty (a fresh commit clears it first) — and on an instant page `load` beats it (measured on
  // feed.html: every check found nothing to check).
  serial(d.tabId, () => {})
    .then(() => checkHealth(d.tabId, v.id, true))
    .then((checked) => {
      // Re-checks only where a saved script applied, and once per document.
      if (!checked || visits.get(d.tabId) !== v || v.timers.length) return;
      v.timers = recheckMs.map((ms) => setTimeout(() => checkHealth(d.tabId, v.id, false), ms));
    });
}

// The enabled saved scripts applied in this tab right now → the frames each one is in.
function appliedSaved(tabId) {
  const out = new Map();
  for (const [frameId, keys] of injected.get(tabId) || new Map()) {
    for (const key of keys.keys()) {
      const s = key !== core.DRAFT_KEY && scripts.get(key);
      if (!s || !s.enabled || !s.rules.length) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(frameId);
    }
  }
  return out;
}

// One check of every saved script applied in the tab; true if there was one to check.
async function checkHealth(tabId, visit, settle) {
  const current = () => !!visits.get(tabId) && visits.get(tabId).id === visit;
  if (!current() || !appliedSaved(tabId).size) return false;
  if (settle) {
    const frames = new Set([...appliedSaved(tabId).values()].flat());
    await Promise.all([...frames].map((f) => safeCensus(tabId, f, { op: "settle" })));
  }
  const summary = (id) => (scripts.has(id) ? JSON.stringify(core.healthSummary(scripts.get(id), health[id]), ["stale", "id", "missing", "misses", "ok", "unknown"]) : "");
  const changed = [];
  let recorded = false;
  for (const [id, frameIds] of appliedSaved(tabId)) {
    const s = scripts.get(id);
    const rules = s.rules;
    const per = [];
    for (const frameId of frameIds) per.push({ frameId, r: await safeCensus(tabId, frameId, { op: "count", selectors: rules.map((r) => r.selector), target: s.target }) });
    if (!current()) break; // navigated meanwhile: these numbers may be the next document's, mid-load
    if (scripts.get(id) !== s || s.rules !== rules || !s.enabled) continue; // saved again, or switched off, meanwhile
    const out = core.checkOutcomes(per, rules);
    if (!out) continue;
    const was = summary(id);
    health[id] = core.recordCheck(health[id], rules, visit, out);
    recorded = true;
    if (summary(id) !== was) changed.push(id);
  }
  if (recorded) await persistHealth();
  if (changed.length) {
    for (const t of injected.keys()) if (changed.some((id) => tabKeys(t).has(id))) updatePageAction(t);
    emitState();
  }
  return true;
}

// The repair: load the stale script into the draft (in this window's active tab, which must be
// on its site), and hand the window's sidebar a request for the agent naming the stale rules —
// written into the composer with "Use page" and "Script" on, NOT sent: the user reads it first.
export async function repairScript(id, windowId) {
  const s = scripts.get(id);
  if (!s) return { error: "That script no longer exists." };
  const stale = core.staleRules(s, health[id]);
  if (!stale.length) return { error: `"${s.name}" has no stale rules — every rule matched on a recent visit.` };
  const r = await loadScript(id, windowId);
  if (r.error) return r;
  hooks.onRepair({ windowId, text: core.fmtRepairRequest(s, stale) });
  return {};
}

// ---- panel + agent actions -------------------------------------------------------------------
// The panel's handlers return { error } for the sidebar's banner instead of throwing.

// `allowBroad`: only the panel's Save sets it, after its own warning and second click.
// `expect` (from savePlan): the agent's save is approved for the draft the card showed — if the
// user discarded it, loaded another, or changed it while the card waited, this is not that.
export async function saveDraft({ name, matches, allowBroad = false, expect = null } = {}) {
  if (!draft) return { error: "There is no script draft to save." };
  if (expect && (draft !== expect.draft || core.scriptCss(draft) !== expect.css)) {
    return { error: "The draft changed while the save was waiting for approval, so nothing was saved. Show the user the current rules and ask again." };
  }
  if (!draft.rules.length) return { error: "The draft has no rules yet — nothing to save." };
  const nm = String(name == null ? draft.name : name).trim() || draft.name;
  const le = validateLabel(nm, "name");
  if (le) return { error: `The script ${le}.` };
  const ms = matches != null ? core.parseMatches(matches) : draft.matches;
  const err = core.checkMatches(ms);
  if (err) return { error: err };
  const broad = ms.filter(isBroadMatch);
  if (broad.length && !allowBroad) return { error: `${broad.join(" ")} reaches every site — saving it needs the Script panel's Save, which asks first.` };
  const now = Date.now();
  const rules = draft.rules.map((r) => ({ ...r, params: { ...(r.params || {}) } }));
  let s = draft.scriptId ? scripts.get(draft.scriptId) : null;
  if (s) {
    s.versions.push({ at: s.updated, name: s.name, matches: s.matches, rules: s.rules, target: s.target });
    Object.assign(s, { name: nm, matches: ms, rules, target: draft.target, enabled: true, updated: now });
  } else {
    s = { id: newScriptId(), name: nm, matches: ms, rules, target: draft.target, enabled: true, created: now, updated: now, versions: [] };
    scripts.set(s.id, s);
  }
  await persistScripts();
  // Saved again = measured afresh: a repair must not stay "stale" on the old rules' misses.
  if (health[s.id]) {
    delete health[s.id];
    await persistHealth();
  }
  // The saved script takes over from the draft: same rules, so the hand-over in the draft's
  // tab is insert-then-remove of identical CSS — nothing flickers.
  draft = null;
  groupRefs = {};
  await persistDraft();
  await syncAll();
  emitState();
  return { script: s };
}

export async function discardDraft() {
  if (!draft) return {};
  const tabId = draft.tabId;
  draft = null;
  groupRefs = {};
  await persistDraft();
  await syncTab(tabId); // drops the draft's CSS; a saved script it was editing comes back
  emitState();
  return {};
}

export async function editDraft(msg) {
  if (!draft) return { error: "There is no script draft." };
  let r = {};
  if (msg.op === "update") r = core.updateRule(draft, msg.id, msg, selectorError, ruleSheetError);
  else if (msg.op === "remove") r = core.removeRule(draft, msg.id);
  else if (msg.op === "setMatch") {
    const ms = core.parseMatches(msg.matches);
    const e = core.checkMatches(ms);
    if (e) r = { error: e };
    else {
      draft.matches = ms;
      draft.dirty = true;
    }
  } else if (msg.op === "setName") {
    const nm = String(msg.name || "").trim();
    const le = validateLabel(nm, "name");
    if (!nm) r = { error: "A script needs a name." };
    else if (le) r = { error: le };
    else {
      draft.name = nm;
      draft.dirty = true;
    }
  } else r = { error: `unknown edit "${msg.op}"` };
  if (r.error) {
    emitState(); // re-render the panel back to the real value
    return { error: `Script: ${r.error}` };
  }
  await applyDraft();
  return {};
}

export async function loadScript(id, windowId) {
  const s = scripts.get(id);
  if (!s) return { error: "That script no longer exists." };
  if (draft && draft.scriptId === id) return {};
  if (draft && draft.dirty) return { error: `Save or discard the current draft ("${draft.name}") first.` };
  const tab = await activeTab(windowId);
  if (!tab || !core.matchesAny(s.matches, tab.url || "")) return { error: `Open a page "${s.name}" applies to (${s.matches.join(" ")}) to edit it there.` };
  const old = draft ? draft.tabId : null;
  draft = core.newDraft({ tabId: tab.id, url: tab.url, script: s });
  groupRefs = {};
  setContextTab(tab);
  await persistDraft();
  if (old !== tab.id) await syncTab(old);
  await syncTab(tab.id);
  await refreshCounts();
  emitState();
  return {};
}

export async function setScriptEnabled(id, enabled) {
  const s = scripts.get(id);
  if (!s) return { error: "That script no longer exists." };
  s.enabled = !!enabled;
  await persistScripts();
  await syncAll();
  emitState();
  return {};
}

// Deleting the script the draft was loaded from leaves the draft as a new, unsaved script —
// the rules on screen are not thrown away with it.
export async function deleteScript(id) {
  if (!scripts.has(id)) return {};
  scripts.delete(id);
  if (health[id]) {
    delete health[id];
    await persistHealth();
  }
  if (draft && draft.scriptId === id) {
    draft.scriptId = null;
    draft.dirty = true;
    await persistDraft();
  }
  await persistScripts();
  await syncAll();
  emitState();
  return {};
}

// The user points at an element; it becomes p1, p2… in the draft, and a reference goes into
// their composer. Asking again while a pick runs cancels it (the Pick button toggles).
export async function pickElement(windowId) {
  if (picking != null) {
    await safeCensus(picking, 0, { op: "unpick", reason: "cancelled from the sidebar" });
    return {};
  }
  const tab = await activeTab(windowId);
  const b = await draftFor(tab);
  if (b.error) return b;
  const d = b.draft;
  setContextTab(tab);
  picking = tab.id;
  emitState();
  try {
    const r = await safeCensus(tab.id, 0, { op: "pick", target: d.target });
    if (r.cancelled) return {};
    if (!r.ok) return { error: "Pick failed: " + (r.error || "no result from the page") };
    if (draft !== d) return { error: "The draft changed while you were picking — pick again." };
    const p = core.addPick(d, r);
    await persistDraft();
    hooks.onPicked({ windowId: tab.windowId, ref: core.pickRef(p) });
    return {};
  } finally {
    picking = null;
    emitState();
  }
}

// The picker's keys ([ ] layers, ↑ ↓ parent/child, Enter, Esc) only reach the page while it
// has focus — after clicking Pick, focus is in the sidebar, which forwards them here.
export async function pickKey(key) {
  if (picking == null) return {};
  const r = await safeCensus(picking, 0, { op: "pickKey", key: String(key || "") });
  return r.ok || /no pick in progress/.test(r.error || "") ? {} : { error: "Pick: " + r.error };
}

// An agent run starting while the user is mid-pick: the picker would sit over the page the
// agent drives (and land a p# in the draft mid-run when the user clicks), so the pick is
// cancelled — the user just pressed Send, which is moving on from it. True if one was running.
export async function cancelPick(reason) {
  if (picking == null) return false;
  await safeCensus(picking, 0, { op: "unpick", reason: reason || "cancelled" });
  return true;
}

export const isTesting = () => testing;

// ---- init ------------------------------------------------------------------------------------

// `healthRecheckMs` replaces HEALTH_RECHECK_MS (the Node harness runs the same code in ms).
export async function initUserScripts({ onState, onOpen, onPicked, onRepair, onError, healthRecheckMs }) {
  hooks = {
    onState: onState || hooks.onState,
    onOpen: onOpen || hooks.onOpen,
    onPicked: onPicked || hooks.onPicked,
    onRepair: onRepair || hooks.onRepair,
    onError: onError || hooks.onError,
  };
  if (Array.isArray(healthRecheckMs)) recheckMs = healthRecheckMs;

  const stored = (await get("userScripts")) || {};
  for (const s of Object.values(stored)) if (s && s.id) scripts.set(s.id, normalizeScript(s));
  const h = (await get("userScriptHealth")) || {};
  health = Object.fromEntries(Object.entries(h).filter(([id, rec]) => scripts.has(id) && rec && rec.rules));
  // Tab ids are per session: after a restart the stored one names an unrelated tab (or none),
  // so the draft comes back unbound and draftFor() binds it again on a tab it matches.
  const d = await get("userScriptDraft");
  if (d && Array.isArray(d.rules) && Array.isArray(d.matches)) draft = { picks: [], nextPickId: 1, ...d, tabId: null };

  browser.webNavigation.onCommitted.addListener(onCommitted);
  browser.webNavigation.onCompleted.addListener(onLoaded);
  browser.webNavigation.onHistoryStateUpdated.addListener(onSameDocument);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocument);
  if (browser.pageAction) browser.pageAction.onClicked.addListener(onPageAction);

  // Each window's panel lists "saved for this site" for the tab the user is looking at there.
  browser.tabs.onActivated.addListener(({ tabId }) => setContext(tabId));
  if (browser.windows.onRemoved) browser.windows.onRemoved.addListener((windowId) => contexts.delete(windowId));
  browser.tabs.onUpdated.addListener((tabId, info) => {
    // Firefox resets a page action when the tab navigates; put it back once the load is done.
    if (info.status === "complete") updatePageAction(tabId);
    if (!(info.url || info.title)) return;
    for (const [wid, c] of contexts) {
      if (c.id !== tabId) continue;
      contexts.set(wid, { ...c, ...(info.url ? { url: info.url } : {}), ...(info.title ? { title: info.title } : {}) });
      if (info.url) emitState();
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    injected.delete(tabId);
    ever.delete(tabId);
    endVisit(tabId);
    iconWant.delete(tabId);
    if (draft && draft.tabId === tabId) emitState();
  });

  let actives = [];
  try {
    actives = await browser.tabs.query({ active: true });
  } catch {
    /* none yet */
  }
  for (const t of actives) setContextTab(t);

  // Tabs that were open before we were listening (browser start, extension reload).
  syncAll();
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

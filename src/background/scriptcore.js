// Script mode — the pure half: the draft's data model, which CSS belongs in which frame, and
// the compact text the agent reads. No browser globals, so it runs under Node too (the
// browser half — storage, insertCSS, the census, the test run — is background/userscripts.js).
//
// A script is a list of rules, each {id, selector, action, params, why}; rulecss.js turns them
// into a user-origin stylesheet. The DRAFT is the one script being worked on — by the agent and
// the Script panel together — bound to one tab, where it is applied live. Rule ids (r1, r2…)
// and pick ids (p1, p2…) are the handles the model and the user both use, so they are never
// reused within a draft and survive a save (editing a saved script keeps its ids).
//
// The text formatters are written for a weak local model (gemma4-12b): short lines, one fact
// per line, numbers instead of adjectives, and short ids it can echo back (g1 for an overlay
// group, r3 for a rule, p1 for something the user pointed at).

import { compileRules, validateRule, validateMatch, matchPattern, defaultMatchFor, isBroadMatch } from "./rulecss.js";

export const DEFAULT_TARGET = "video";

// ---- the draft ---------------------------------------------------------------------------

// A fresh draft for `url`, or a working copy of a saved `script` (same rules, same ids — the
// draft replaces that script's CSS in its tab until it is saved or discarded).
export function newDraft({ tabId, url, script = null }) {
  const rules = script ? script.rules.map((r) => ({ ...r, params: { ...(r.params || {}) } })) : [];
  return {
    tabId,
    url,
    scriptId: script ? script.id : null,
    name: script ? script.name : nameFor(url),
    matches: script ? [...script.matches] : [defaultMatchFor(url)],
    target: (script && script.target) || DEFAULT_TARGET,
    rules,
    nextRuleId: nextNumber(rules, "r"),
    picks: [],
    nextPickId: 1,
    dirty: false,
    counts: null, // { [ruleId]: number | "error text" } — what each rule matches right now
    baseline: null, // video coverage measured before the draft had any rules
    lastTest: null,
    created: Date.now(),
  };
}

function nameFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "script";
  }
}

function nextNumber(items, prefix) {
  let n = 0;
  for (const it of items) {
    const m = new RegExp("^" + prefix + "(\\d+)$").exec(it.id || "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}

// The params any action reads (rulecss.js ACTIONS). Anything else would be stored, shown in the
// save card and never compiled — so it is not kept.
const PARAM_KEYS = new Set(["hover", "opacity", "to", "unclip", "declarations"]);

// Models emit `params` as an object, a JSON string, or not at all; and they fill every
// optional field with "" or null. Keep only what a rule can use.
export function normalizeParams(raw) {
  let p = raw;
  if (typeof p === "string") {
    try {
      p = p.trim() ? JSON.parse(p) : {};
    } catch {
      return { _invalid: raw };
    }
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === "" || v === null || v === undefined || !PARAM_KEYS.has(k)) continue;
    if (k === "declarations" && typeof v === "string") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v; // validateRule says what is wrong with it
      }
    } else out[k] = (k === "hover" || k === "unclip") && typeof v === "string" ? cleanSelector(v) : v;
  }
  return out;
}

// Every selector a rule depends on: the target itself plus the ones its params name.
export function selectorsOf(rule) {
  const p = rule.params || {};
  return [rule.selector, p.hover, p.unclip].filter((s) => typeof s === "string" && s.trim());
}

// Full check of a rule before it touches the page: rulecss's own validation, then a real
// selector parse (`checkSelector(sel)` → error text or null; the background page does it with
// querySelector, which is the only parser that knows what the browser accepts), then the
// compiled CSS through the browser's stylesheet parser (`checkSheet(rule)` → error text or
// null — every block it compiles to must survive, and it must not swallow what follows).
export function checkRule(rule, checkSelector, checkSheet) {
  if (rule.params && rule.params._invalid !== undefined) return "params is not valid JSON";
  const err = validateRule(rule);
  if (err) return err;
  if (checkSelector) {
    for (const s of selectorsOf(rule)) {
      const e = checkSelector(s);
      if (e) return e;
    }
  }
  return checkSheet ? checkSheet(rule) : null;
}

// A JSON string escaped twice reaches us as [data-testid=\"action-rail\"] — valid CSS that
// matches nothing (the value then includes the quotes). gemma4-12b did it once in nine runs and
// spent two steps finding out; an attribute value wrapped in \" is that, never intent.
export function cleanSelector(sel) {
  return String(sel || "")
    .trim()
    .replace(/=\\"([^"\\]*)\\"/g, '="$1"');
}

function cleanRule({ selector, action, params, why }) {
  const r = { selector: cleanSelector(selector), action: String(action || "").trim(), params: normalizeParams(params) };
  const w = String(why || "").trim();
  if (w) r.why = w;
  return r;
}

// A second rule on the same selector is a repeat (gemma4-e4b issued every call twice and saved
// two copies of each rule) or a fight (hide beside hide-until-hover: the hide wins and the
// buttons never come back on hover). Either way the fix is the rule that already exists.
function clashOf(draft, rule) {
  const same = draft.rules.find((r) => r.selector === rule.selector && (r.action === rule.action || r.action === "hide" || rule.action === "hide"));
  if (!same) return null;
  if (same.action === rule.action && JSON.stringify(same.params || {}) === JSON.stringify(rule.params || {})) return `${same.id} already does exactly this (${fmtRule(same)})`;
  return `${same.id} already applies ${same.action} to ${rule.selector}, and a second rule on it would fight that one — change ${same.id} with update_rule instead`;
}

export function addRule(draft, input, checkSelector, checkSheet) {
  const rule = cleanRule(input);
  const err = checkRule(rule, checkSelector, checkSheet) || clashOf(draft, rule);
  if (err) return { error: err };
  rule.id = "r" + draft.nextRuleId++;
  draft.rules.push(rule);
  draft.dirty = true;
  return { rule };
}

// A patch replaces only the fields it carries. Changing the action drops params that belonged
// to the old one unless new ones are given (a `move`'s `to` means nothing to `dim`).
export function updateRule(draft, id, patch, checkSelector, checkSheet) {
  const i = draft.rules.findIndex((r) => r.id === id);
  if (i < 0) return { error: `there is no rule ${id} — the rules are ${draft.rules.map((r) => r.id).join(", ") || "(none)"}` };
  const cur = draft.rules[i];
  const has = (k) => patch[k] !== undefined && patch[k] !== null && !(k !== "why" && patch[k] === "");
  const next = {
    id,
    selector: has("selector") ? cleanSelector(patch.selector) : cur.selector,
    action: has("action") ? String(patch.action).trim() : cur.action,
    params: has("params") ? normalizeParams(patch.params) : has("action") && patch.action !== cur.action ? {} : { ...(cur.params || {}) },
  };
  const why = has("why") ? String(patch.why).trim() : cur.why;
  if (why) next.why = why;
  const err = checkRule(next, checkSelector, checkSheet);
  if (err) return { error: err };
  draft.rules[i] = next;
  draft.dirty = true;
  return { rule: next, before: cur };
}

export function removeRule(draft, id) {
  const i = draft.rules.findIndex((r) => r.id === id);
  if (i < 0) return { error: `there is no rule ${id}` };
  const [rule] = draft.rules.splice(i, 1);
  draft.dirty = true;
  return { rule };
}

// The panel's match field is free text: one pattern per line, or separated by spaces/commas.
export function parseMatches(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

export function checkMatches(list) {
  if (!list.length) return "a script needs at least one match pattern";
  for (const m of list) {
    const e = validateMatch(m);
    if (e) return e;
  }
  return null;
}

export function matchesAny(patterns, url) {
  return (patterns || []).some((p) => matchPattern(p, url));
}

// Keep what the user pointed at: the census `pick` result, minus nothing — the candidates and
// the inspect snapshot are what the model reads when the user says "hide p1". `sig` (its role
// signature) goes along with the positional `path`, so a later inspect can tell when a
// recycling feed has put another element at that path.
export function addPick(draft, r) {
  const pick = { id: "p" + draft.nextPickId++, desc: r.desc || "(element)", path: r.path, sig: r.sig || null, candidates: r.candidates || [], inspect: r.inspect || null, at: Date.now() };
  draft.picks.push(pick);
  return pick;
}

// What goes into the composer: short enough to write a sentence around.
export function pickRef(pick) {
  return `[${pick.id}: ${clip(pick.desc, 60)}]`;
}

// ---- which CSS goes where ------------------------------------------------------------------

export const DRAFT_KEY = "draft";

// { css, errors, blocks } — `blocks` is how many style rules the css must parse into.
export function compileScript(script) {
  return compileRules(script.rules, script.name);
}

export function scriptCss(script) {
  return compileScript(script).css;
}

// Does the draft govern this frame? Only in its own tab, and only in frames its patterns
// match — the same per-frame rule a saved script follows, so a test never passes on a frame
// the saved script would not reach.
export function draftApplies(draft, tabId, frameUrl) {
  return !!draft && draft.tabId === tabId && matchesAny(draft.matches, frameUrl);
}

// The stylesheets one frame should carry right now: key → exact CSS text. Saved scripts
// match on the frame's url; where the draft governs, it REPLACES the saved script it was
// loaded from (never both — editing a rule must not leave the old version showing through),
// and an empty draft still replaces it: removing every rule means "none of these rules".
// `accept(compiled, script)` may veto a sheet (the background page refuses one the browser
// parses into fewer rules than were compiled) — a vetoed script applies nothing, not part.
export function wantedCss({ scripts, draft, tabId, frameUrl, accept = null }) {
  const want = new Map();
  const governs = draftApplies(draft, tabId, frameUrl);
  const add = (key, s) => {
    const c = compileScript(s);
    if (!accept || accept(c, s)) want.set(key, c.css);
  };
  for (const s of scripts) {
    if (!s.enabled || !s.rules.length) continue;
    if (governs && draft.scriptId === s.id) continue;
    if (!matchesAny(s.matches, frameUrl)) continue;
    add(s.id, s);
  }
  if (governs && draft.rules.length) add(DRAFT_KEY, draft);
  return want;
}

// Reconcile one frame: what to insert and what to remove to get from `have` to `want`. Keyed
// by the CSS TEXT, not the script: what a frame carries is a set of sheets, and removeCSS
// finds a sheet by its text. So a saved script loaded unchanged into the draft (same rules,
// same name → same text under another key) is neither inserted twice nor removed and
// re-added. Callers insert before they remove, so a real hand-over (old rule → edited rule)
// never leaves the frame unstyled for a moment.
export function diffCss(have, want) {
  const haveCodes = new Set(have.values());
  const wantCodes = new Set(want.values());
  const insert = [];
  const remove = [];
  for (const [key, code] of want) if (!haveCodes.has(code)) insert.push({ key, code }), haveCodes.add(code);
  for (const [key, code] of have) if (!wantCodes.has(code)) remove.push({ key, code }), wantCodes.add(code);
  return { insert, remove };
}

// ---- results ---------------------------------------------------------------------------

// Test-run verdict per rule: matched nothing anywhere (wrong selector, or the element appears
// later than we looked), or matched at some steps and not others (fits the first tiles only).
// A step with no video on screen is no evidence either way: on a feed where only the ACTIVE
// item has content (the owner's real site: ~120 item shells, one <video> in the playing one) a
// scroll can land between items, and a correct rule matches 0 there because there is nothing
// to cover. Those steps are listed in `empty` and never make a rule `partial` (or `zero`);
// `partialAt` names, per partial rule, the steps where it matched 0 WITH a video on screen.
export function summarizeTest(steps, rules) {
  const zero = [];
  const partial = [];
  const partialAt = {};
  const present = (s) => s.measured == null || s.measured > 0; // older results carry no `measured`
  for (const r of rules) {
    const ns = steps.filter((s) => s.counts && typeof s.counts[r.id] === "number").map((s) => ({ n: s.counts[r.id], present: present(s), label: s.label }));
    if (!ns.length) continue;
    const misses = ns.filter((x) => x.n === 0 && x.present).map((x) => x.label);
    if (ns.every((x) => x.n === 0)) {
      if (misses.length) zero.push(r.id);
    } else if (misses.length) {
      partial.push(r.id);
      partialAt[r.id] = misses;
    }
  }
  return { zero, partial, partialAt, empty: steps.filter((s) => !present(s)).map((s) => s.label), timeouts: steps.filter((s) => s.settleTimedOut).map((s) => s.label) };
}

// Sum a `test` op over frames. `overTarget` = matched elements above a video; `paintsOver` =
// those that also paint there (a transparent click-catcher is above without painting).
// Frames other than the top one are labelled in the samples.
export function mergeTests(perFrame) {
  const out = { matches: 0, visible: 0, overTarget: 0, paintsOver: 0, clickThrough: 0, samples: [], errors: [] };
  for (const { r, top, url } of perFrame) {
    if (!r || !r.ok) {
      if (r && r.error) out.errors.push(r.error);
      continue;
    }
    out.matches += r.matches || 0;
    out.visible += r.visible || 0;
    out.overTarget += r.overTarget || 0;
    out.paintsOver += r.paintsOver || 0;
    out.clickThrough += r.clickThrough || 0;
    for (const s of r.samples || []) out.samples.push(top ? s : `${s} (in frame ${clipUrl(url)})`);
  }
  return out;
}

// Sum a `count` op over frames: per selector, a number, or the error text.
export function mergeCounts(perFrame, n) {
  const counts = new Array(n).fill(0);
  let targets = 0;
  let any = false;
  for (const { r } of perFrame) {
    if (!r || !r.ok) continue;
    any = true;
    targets += r.targets || 0;
    (r.counts || []).forEach((c, i) => {
      if (typeof counts[i] !== "number") return;
      if (typeof c === "number") counts[i] += c;
      else counts[i] = (c && c.error) || "error";
    });
  }
  return any ? { counts, targets } : null;
}

// Coverage over several frames, weighted by how many targets each measured.
export function mergeCoverage(perFrame) {
  let measured = 0;
  let weighted = 0;
  let targets = 0;
  for (const { r } of perFrame) {
    if (!r || !r.ok) continue;
    targets += r.targets || 0;
    measured += r.measured || 0;
    weighted += (r.coverage || 0) * (r.measured || 0);
  }
  return { targets, measured, coverage: measured ? weighted / measured : null };
}

// ---- health: do the saved rules still match? ----------------------------------------------
// A saved script dies quietly when the site ships a redesign that renames its hooks (a
// data-testid changes, a class is renamed): the rule matches nothing and the overlay is back.
// So each visit counts every rule's selector (userscripts.js runs the checks). A VISIT is one
// document in one tab; its checks are folded into it, and a rule that matched in ANY of them is
// alive for that visit. A rule is STALE when it matched nothing on the last STALE_VISITS visits
// that had evidence — shown in every warning (staleNote), so the threshold is never hidden.
export const STALE_VISITS = 3;

export const targetNoun = (target) => (!target || target === DEFAULT_TARGET ? "videos" : `"${target}" elements`);
export const staleNote = (target) => `matched nothing on the last ${STALE_VISITS} visits that had ${targetNoun(target)}`;

// One check of one script — the census `count` op in each frame it applies to — per rule:
// "matched" (>0 in some frame), "missed" (0, while a frame had a target), or "none": no target in
// any of them, which is no evidence either way. A page without videos, or a feed between items:
// on the owner's real site only the ACTIVE item has content, so counts of 1–2 and transient zeros
// are normal for a rule that is fine. null when no frame answered.
export function checkOutcomes(perFrame, rules) {
  const m = mergeCounts(perFrame, rules.length);
  if (!m) return null;
  return Object.fromEntries(rules.map((r, i) => [r.id, typeof m.counts[i] !== "number" ? "none" : m.counts[i] > 0 ? "matched" : m.targets > 0 ? "missed" : "none"]));
}

// Fold one check into a script's health record:
//   { rules: { [ruleId]: { sel, visits: [{ v, ok, at }], lastOk } }, checked }
// `visits` holds the rule's last STALE_VISITS visits WITH evidence (all a verdict needs); a
// second check of the same visit can only turn its miss into a match. Each record is keyed to the
// selector it measured (`sel`): a rule whose selector was edited starts a fresh one, and a rule no
// longer in the script loses its record. (Saving a script drops its whole record — userscripts.js.)
export function recordCheck(rec, rules, visit, outcomes, now = Date.now()) {
  const old = (rec && rec.rules) || {};
  const out = {};
  for (const r of rules) {
    const prev = old[r.id] && old[r.id].sel === r.selector ? old[r.id] : null;
    const h = prev ? { ...prev, visits: prev.visits.slice() } : { sel: r.selector, visits: [], lastOk: null };
    const o = outcomes[r.id];
    if (o === "matched" || o === "missed") {
      const ok = o === "matched";
      const i = h.visits.findIndex((x) => x.v === visit);
      if (i >= 0) h.visits[i] = { ...h.visits[i], ok: h.visits[i].ok || ok };
      else h.visits = [...h.visits, { v: visit, ok, at: now }].slice(-STALE_VISITS);
      if (ok) h.lastOk = now;
    }
    if (prev || h.visits.length) out[r.id] = h;
  }
  return { rules: out, checked: now };
}

// One rule's verdict from its record: "unknown" (no visit with evidence yet, or the selector
// changed since), "ok" (matched on the last one), "missing" (missed on the last `misses`, fewer
// than STALE_VISITS) or "stale". `since` = when the first of those misses was.
export function ruleHealth(rec, rule) {
  const h = rec && rec.rules && rec.rules[rule.id];
  if (!h || h.sel !== rule.selector || !h.visits.length) return { state: "unknown", misses: 0 };
  let misses = 0;
  for (let i = h.visits.length - 1; i >= 0 && !h.visits[i].ok; i--) misses++;
  if (!misses) return { state: "ok", misses: 0, lastOk: h.lastOk };
  return { state: misses >= STALE_VISITS ? "stale" : "missing", misses, since: h.visits[h.visits.length - misses].at, lastOk: h.lastOk };
}

export function staleRules(script, rec) {
  return (script.rules || []).filter((r) => ruleHealth(rec, r).state === "stale");
}

// What the Script panel lists under a saved script.
export function healthSummary(script, rec) {
  const out = { stale: [], missing: [], ok: 0, unknown: 0, checked: (rec && rec.checked) || null };
  for (const r of script.rules || []) {
    const h = ruleHealth(rec, r);
    if (h.state === "stale") out.stale.push({ id: r.id, selector: r.selector, action: r.action, since: h.since });
    else if (h.state === "missing") out.missing.push({ id: r.id, misses: h.misses });
    else out[h.state]++;
  }
  return out;
}

// Verdicts for the draft's rules, when it was loaded from a saved script — only for rules whose
// selector is still the one that was measured (an edited rule is a new rule).
export function draftHealth(draft, rec) {
  if (!draft || !draft.scriptId || !rec) return {};
  const out = {};
  for (const r of draft.rules) {
    const h = ruleHealth(rec, r);
    if (h.state !== "unknown") out[r.id] = h;
  }
  return out;
}

function fmtStaleList(stale) {
  return stale.map((r) => `${r.id} ${oneLine(r.selector)}`).join(", ");
}

// The page-action title for a saved script with stale rules — one line, names and selectors shown
// in full (a tooltip wraps; nothing is cut).
export function fmtStaleTitle(script, stale) {
  const n = (script.rules || []).length;
  return `⚠ "${oneLine(script.name)}": ${stale.length} of ${n} rule${n === 1 ? "" : "s"} ${stale.length === 1 ? "matches" : "match"} nothing anymore — ${fmtStaleList(stale)} ${staleNote(script.target)}. Click to repair.`;
}

// The request the repair flow writes into the user's composer (they read it and press Send):
// which rules, what each did, and the order of work.
export function fmtRepairRequest(script, stale) {
  const what = stale.map((r) => {
    const to = r.action === "move" && r.params && r.params.to ? ` → ${r.params.to}` : "";
    return `${r.id} (${r.action} ${r.selector}${to}${r.why ? ": " + oneLine(r.why) : ""})`;
  });
  const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}` : what[0];
  const one = stale.length === 1;
  return `The site changed: ${list} stopped matching — ${one ? "it" : "they"} ${staleNote(script.target)}. Find what ${one ? "that element is" : "those elements are"} now and update ${one ? "the rule" : "those rules"} (keep the ids), then test.`;
}

// ---- text for the agent ----------------------------------------------------------------

export const pct =(f) => (typeof f === "number" && Number.isFinite(f) ? Math.round(f * 100) + "%" : "?");

const SHOWN_CANDIDATES = 3; // per group in overlays_of; the rest are one inspect away (and say so)

// The census's flags already say what is wrong with a candidate ("hashed: breaks on site
// update", "extra matches: 4 (e.g. …)", "misses 2 of 8 same-role elements") — pass them on.
export function fmtCandidate(c) {
  const bits = [`${c.matches} match${c.matches === 1 ? "" : "es"}`];
  if (c.kind && !(c.flags || []).some((f) => f.startsWith(c.kind))) bits.push(c.kind);
  if (c.stable) bits.push("stable");
  for (const f of c.flags || []) bits.push(f);
  return `${c.selector}  (${bits.join(", ")})`;
}

function fmtCandidates(cands, indent, limit) {
  const list = cands || [];
  if (!list.length) return [`${indent}no selector candidates — inspect it to see its ancestors`];
  const shown = limit ? list.slice(0, limit) : list;
  const lines = shown.map((c, i) => `${indent}${i === 0 ? "best: " : "or:   "}${fmtCandidate(c)}`);
  if (list.length > shown.length) lines.push(`${indent}(+${list.length - shown.length} more candidates — inspect for all)`);
  return lines;
}

// overlays_of over one or more frames → { text, groups } where `groups` maps g1, g2… to what
// inspect needs (frame + path). Ids are per call: a new overlays_of renumbers.
export function fmtOverlays(perFrame, { target = DEFAULT_TARGET, matches = null } = {}) {
  const lines = [];
  const groups = {};
  let g = 0;
  const withTargets = perFrame.filter((f) => f.r && f.r.ok && f.r.targets > 0);
  if (!withTargets.length) {
    const top = perFrame.find((f) => f.top) || perFrame[0];
    const r = (top && top.r) || {};
    const why = r.reason || r.error;
    return {
      text: [
        `No "${target}" found on this page${why ? ` (${why})` : ""}. If the videos are drawn differently (e.g. a <canvas>), call overlays_of with that selector as the target.`,
        ...(r.hints || []).map((h) => `hint: ${h}`),
      ].join("\n"),
      groups,
    };
  }
  for (const f of withTargets) {
    const r = f.r;
    const what = r.target || target;
    if (!f.top) {
      lines.push(`--- FRAME ${clipUrl(f.url)} ---`);
      if (matches && !matchesAny(matches, f.url)) lines.push(`NOTE: this frame is outside the script's match pattern (${matches.join(" ")}); rules won't apply here unless the user adds a pattern for it in the Script panel.`);
    }
    if (!r.measured) {
      lines.push(`${r.targets} "${what}" here, none visible${r.reason ? ` (${r.reason})` : ""}.`);
      for (const h of r.hints || []) lines.push(`hint: ${h}`);
      continue;
    }
    lines.push(`${r.targets} "${what}" on the page, ${r.measured} visible and measured. Covered: ${pct(r.coverage)} of the visible ${what} area is painted over.`);
    if (!r.groups || !r.groups.length) lines.push("Nothing paints over them.");
    else lines.push("What covers them, grouped by role (the same element across all tiles):");
    for (const grp of r.groups || []) {
      const id = "g" + ++g;
      groups[id] = { frameId: f.frameId, path: grp.path, sig: grp.sig || null, desc: grp.desc, key: grp.key, candidates: grp.candidates || [] };
      const layer = grp.relation === "outside" ? "a separate layer, not inside the tile" : "inside the tile";
      const paints = grp.paints && grp.paints.length ? ` · paints ${grp.paints.join("+")}` : "";
      // A pointer-events:none overlay already lets clicks through: click-through would do nothing.
      const clicks = grp.clicks === false ? " · already lets clicks through" : grp.clicks ? " · catches clicks" : "";
      lines.push(`${id}: ${grp.desc}`);
      lines.push(`  covers ${pct(grp.share)} of the ${what} area · on ${grp.targetsCovered}/${r.measured} · ${grp.count} element${grp.count === 1 ? "" : "s"} · ${grp.where}${grp.placedBy ? " (position approximate)" : ""} · ${layer}${paints}${clicks}`);
      lines.push(...fmtCandidates(grp.candidates, "  ", SHOWN_CANDIDATES));
    }
    for (const h of r.hints || []) lines.push(`hint: ${h}`);
  }
  return { text: lines.join("\n"), groups };
}

// What paints over the videos right now, per group, from an `overlays` census over frames.
export function coveringOf(perFrame) {
  const out = [];
  for (const { r } of perFrame) if (r && r.ok) for (const g of r.groups || []) out.push({ key: g.key, share: g.share, desc: g.desc });
  return out.sort((a, b) => b.share - a.share);
}

// Said after every change, named by the group ids of the last overlays_of (a group that was not
// in it is described instead), so the model knows what is left: without it gemma4-12b ended a
// turn with a gradient over 40% of every video untouched and unmentioned.
export function fmtCovering(covering, refs = {}) {
  if (!covering) return "";
  if (!covering.length) return "Nothing covers the videos any more.";
  const ids = new Map(Object.entries(refs).filter(([, g]) => g.key).map(([id, g]) => [g.key, id]));
  const parts = covering.map((c) => `${ids.has(c.key) ? ids.get(c.key) + " " : ""}${pct(c.share)} ${clip(c.desc, 60)}`);
  return `Still covering the videos: ${parts.join(" · ")}.`;
}

function fmtStyle(style) {
  if (!style || typeof style !== "object") return "";
  return Object.entries(style)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
}

function fmtRect(r) {
  if (!r) return "";
  const n = (x) => Math.round(x || 0);
  return `${n(r.w ?? r.width)}x${n(r.h ?? r.height)} at ${n(r.x ?? r.left)},${n(r.y ?? r.top)}`;
}

export function fmtInspect(r, label = "") {
  if (!r || !r.ok) return `Error: ${(r && r.error) || "inspect failed"}`;
  const lines = [`${label ? label + ": " : ""}${r.desc}  ${fmtRect(r.rect)}`];
  const st = fmtStyle(r.style);
  if (st) lines.push(`  style: ${st}`);
  if (r.paints && r.paints.length) lines.push(`  paints: ${r.paints.join(", ")}`);
  else if (r.paints) lines.push("  paints nothing itself (transparent)");
  if (r.roleCount) lines.push(`  ${r.roleCount} element${r.roleCount === 1 ? "" : "s"} on the page play this same role`);
  if (r.ancestors && r.ancestors.length) {
    lines.push("Ancestors (nearest first):");
    for (const a of r.ancestors) {
      lines.push(`  ${a.desc}  ${fmtRect(a.rect)}${a.containsTarget ? "  ← contains the video" : ""}`);
      const s = fmtStyle(a.style);
      if (s) lines.push(`    style: ${s}`);
    }
  }
  lines.push("Selector candidates (best first):");
  lines.push(...fmtCandidates(r.candidates, "  ", 0));
  return lines.join("\n");
}

// "above a video" without painting = transparent (a click-catcher): hiding it changes nothing
// anyone can see, and click-through is the action that matters for it.
function overLine(m) {
  const s = `${m.overTarget} above a video, ${m.paintsOver} of them painting over it`;
  const clear = m.overTarget - m.paintsOver;
  const through = m.clickThrough ? `; ${m.clickThrough} already let clicks through` : "";
  return (clear > 0 ? `${s} (the other ${clear} ${clear === 1 ? "is" : "are"} transparent there — only click-through changes anything for ${clear === 1 ? "it" : "those"})` : s) + through;
}

export function fmtTestSelector(selector, m) {
  if (m.errors.length && !m.matches) return `Error: ${m.errors[0]}`;
  const lines = [`${selector} matches ${m.matches} element${m.matches === 1 ? "" : "s"}: ${m.visible} visible, ${overLine(m)}.`];
  if (!m.matches) lines.push("It matches nothing — check the spelling, or inspect the element again for real candidates.");
  if (m.samples.length) lines.push(`Examples${m.samples.length < m.matches ? ` (${m.samples.length} of ${m.matches})` : ""}:`, ...m.samples.map((s) => "  " + s));
  return lines.join("\n");
}

export function fmtRule(r) {
  const p = r.params || {};
  const extra = Object.entries(p)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(", ");
  return `${r.id} ${r.action} ${r.selector}${extra ? ` (${extra})` : ""}${r.why ? ` — ${r.why}` : ""}`;
}

// Every change ends on the step that comes after the last one. Said in the prompt alone, it was
// skipped: with two inspects before the rules, gemma4-12b answered untested 3 runs out of 3.
export const UNTESTED = "Not tested yet — after your last change, call test_script before you answer.";

// add_rule / update_rule result: what the selector targeted and what the rule did to the
// coverage. `test` is measured BEFORE the change is applied — afterwards a hidden element sits
// above nothing and paints nothing, which would read as "this rule targets nothing". `wraps`
// counts matched elements that ARE or CONTAIN a video — a rule that hides those hides the
// video too, which is the one mistake worth shouting about.
export function fmtRuleEffect({ verb, rule, test, before, after, wraps, groups, still }) {
  const lines = [`${verb}: ${fmtRule(rule)}`];
  if (test) {
    const videos = after && after.targets ? ` (${after.targets} video${after.targets === 1 ? "" : "s"} on the page)` : "";
    if (test.errors.length && !test.matches) lines.push(`Error measuring it: ${test.errors[0]}`);
    else if (!test.matches) lines.push(`It matches NOTHING right now — check the selector with test_selector, or remove_rule ${rule.id}.`);
    else lines.push(`Matches ${test.matches} element${test.matches === 1 ? "" : "s"}${videos}; before this ${verb === "added" ? "rule" : "change"}: ${overLine(test)}.`);
  }
  // `groups`: the overlays_of groups this selector reaches — all of one, or only part of it.
  for (const g of groups || []) {
    if (g.sameRole >= g.roleCount) {
      lines.push(`Covers all of ${g.id} (${g.roleCount} element${g.roleCount === 1 ? "" : "s"}).`);
      continue;
    }
    const whole = (g.candidates || []).find((c) => c.extra === 0 && !(c.flags || []).some((f) => f.startsWith("misses")));
    const fix = whole && whole.selector !== rule.selector ? `use ${g.id}'s candidate ${whole.selector}, which covers them all: update_rule ${rule.id}.` : "find a selector that covers them all.";
    lines.push(`It MISSES ${g.roleCount - g.sameRole} of the ${g.roleCount} elements of ${g.id} (covers ${g.sameRole}). Unless the user wants only some of them, ${fix}`);
  }
  if (typeof wraps === "number" && wraps > 0 && rule.action !== "click-through") {
    lines.push(`WARNING: ${wraps} of the matched elements ARE or CONTAIN a video — this rule changes the videos too. Use a narrower selector unless that is what the user wants.`);
  }
  if (before && after && before.coverage != null && after.coverage != null) {
    lines.push(`Video coverage ${pct(before.coverage)} → ${pct(after.coverage)}.`);
  } else if (after && after.coverage != null) lines.push(`Video coverage now ${pct(after.coverage)}.`);
  if (still) lines.push(still);
  lines.push(UNTESTED);
  return lines.join("\n");
}

export function fmtTest(t) {
  if (!t) return "No test result.";
  if (t.error) return `Error: the test run failed — ${t.error}`;
  const n = t.steps.length - 1;
  const empty = new Set(t.empty || []);
  const lines = [`Reloaded the page with the draft applied, then scrolled ${n} time${n === 1 ? "" : "s"}.`];
  for (const s of t.steps) {
    const counts = Object.entries(s.counts || {})
      .map(([id, n]) => `${id} ${n}`)
      .join(" · ");
    // Said on the step itself, as a fact and not under Problems: a weak model reads any 0 as a
    // broken rule, and would "fix" one that is right.
    const none = empty.has(s.label) ? " · no video on screen here, so 0 matches at this step are expected (not a problem)" : "";
    lines.push(`${s.label}: ${s.targets} videos, coverage ${pct(s.coverage)}${counts ? " · " + counts : ""}${s.atEnd ? " · end of the feed" : ""}${none}`);
  }
  if (t.baseline != null) lines.push(`Before any rules, coverage was ${pct(t.baseline)}.`);
  if (t.still) lines.push(t.still);
  const probs = [];
  for (const id of t.zero || []) probs.push(`${id} matched NOTHING at any step — the selector is wrong, or the element appears later. Check it with test_selector or inspect.`);
  for (const id of t.partial || []) {
    const at = t.partialAt && t.partialAt[id];
    probs.push(`${id} matched at some steps and 0 at ${at && at.length ? `${at.join(", ")}, with a video on screen there` : "others"} — it only fits some tiles. Find a selector every tile shares.`);
  }
  for (const label of t.timeouts || []) probs.push(`the page kept changing at "${label}" (did not settle in time) — those numbers may be mid-load.`);
  if (t.notes) probs.push(...t.notes);
  if (empty.size && empty.size === t.steps.length) probs.push("no video was on screen at any step, so this test could not check the rules.");
  if (probs.length) lines.push("Problems:", ...probs.map((p) => "- " + p));
  else lines.push(empty.size ? "Every rule matched at every step that had a video on screen." : "Every rule matched at every step.");
  return lines.join("\n");
}

// The live block added to the user's message at the start of a Script-mode turn (never the
// system prompt: pick descriptions quote the page's own text): where the draft stands right
// now. Within the turn the tool results carry every change. `health` (draftHealth) marks the
// rules of a saved script that went stale, and says how a repair is done: the rule KEEPS its id
// (update_rule) — a replacement added beside it would leave the dead rule in the script.
export function fmtDraftLine(draft, { saved = [], blocked = null, health = {} } = {}) {
  if (blocked) return `SCRIPT DRAFT: ${blocked}`;
  if (!draft) return "SCRIPT DRAFT: none yet — it is created on the current site when you use a script tool.";
  const state = draft.scriptId ? `editing the saved script "${draft.name}"${draft.dirty ? " (unsaved changes)" : ""}` : `a new script "${draft.name}"${draft.rules.length ? " (not saved yet)" : ""}`;
  const lines = [`SCRIPT DRAFT — ${state}, applied live in this tab.`, `Match: ${draft.matches.join(" ")} · target: ${draft.target}`];
  const stale = draft.rules.filter((r) => health[r.id] && health[r.id].state === "stale");
  if (draft.rules.length) {
    lines.push("Rules:");
    for (const r of draft.rules) {
      const n = draft.counts && typeof draft.counts[r.id] === "number" ? ` [matches ${draft.counts[r.id]}]` : "";
      lines.push(`  ${fmtRule(r)}${n}${stale.includes(r) ? ` — STALE: ${staleNote(draft.target)}` : ""}`);
    }
  } else lines.push("Rules: none yet.");
  if (stale.length) {
    const ids = stale.map((r) => r.id).join(", ");
    lines.push(
      `REPAIR: ${ids} stopped matching — the site renamed what ${stale.length === 1 ? "it targets" : "they target"}, so ${stale.length === 1 ? "that element is" : "those elements are"} back over the videos. ` +
        `For each: find the element again (overlays_of lists it as a group; inspect for its candidates), then update_rule THAT id with only the new selector — its action and why stay as they are. Never add_rule a replacement and never remove the stale rule. Then test_script.`,
    );
  }
  if (draft.picks.length) {
    lines.push("Elements the user picked (they refer to them as p1, p2…):");
    for (const p of draft.picks) {
      const best = p.candidates && p.candidates[0];
      lines.push(`  ${p.id}: ${p.desc}${best ? ` — best selector ${best.selector}${best.stable ? " (stable)" : ""}` : ""}`);
    }
  }
  const others = saved.filter((s) => s.id !== draft.scriptId);
  if (others.length) lines.push(`Other saved scripts on this site: ${others.map((s) => `"${s.name}" (${s.enabled ? "on — applied too" : "off"})`).join(", ")}.`);
  if (draft.lastTest && !draft.lastTest.error) {
    const t = draft.lastTest;
    const last = t.steps[t.steps.length - 1];
    const n = t.steps.length - 1;
    lines.push(`Last test_script: coverage ${pct(last && last.coverage)} after ${n} scroll${n === 1 ? "" : "s"}${t.zero.length ? `; ${t.zero.join(", ")} matched nothing` : ""}.`);
  }
  return lines.join("\n");
}

// One line of display text. A line break or control character inside a field is SHOWN (⏎)
// rather than acted on, and bidi overrides are dropped (they can make a line read backwards):
// the save card is pre-wrap text, and a name or a value that could start a line of its own
// could lay out a fake "Applies to:" under the real one. Validation refuses these at every
// entry point; this is the card's own guarantee for whatever got stored before that.
const LINE_BREAKS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function oneLine(v) {
  return String(v == null ? "" : v)
    .replace(BIDI, "")
    .replace(LINE_BREAKS, " ⏎ ")
    .trim();
}

// What the user approves when the agent asks to save: every line built from one field, made
// single-line, so the card's layout is ours and no field can add a line to it.
export function fmtSaveConfirm(draft, name, matches) {
  const broad = matches.filter(isBroadMatch);
  const lines = [
    `Save script "${oneLine(name)}"${draft.scriptId ? " (replacing the saved version — the old one is kept in its history)" : ""}?`,
    `Applies to: ${matches.map(oneLine).join(" ")}`,
    ...(broad.length ? [`WARNING: ${broad.map(oneLine).join(" ")} reaches every site (or every local file) — the script would run on all of them.`] : []),
    `${draft.rules.length} rule${draft.rules.length === 1 ? "" : "s"}:`,
    ...draft.rules.map((r) => "  " + oneLine(fmtRule(r))),
    "It re-applies on every visit, with no model call.",
  ];
  return lines.join("\n");
}

function clip(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function clipUrl(u) {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).slice(0, 60);
  } catch {
    return String(u || "").slice(0, 60);
  }
}

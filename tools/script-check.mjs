#!/usr/bin/env node
// Measure what Script mode sees and does on a page — the Script-mode analogue of dark-check.
// Two questions, both answered by the REAL code the extension runs (content/overlay-census.js
// in the page, background/rulecss.js for the sheet), never by reading markup:
//
//   1. Discovery: what paints on top of the videos, grouped by role, and which selector for each
//      group will survive the site's next deploy (ranked candidates, hashed ones flagged).
//   2. With --rules: does a saved script still WORK — coverage before → after its sheet, every
//      rule's match count, and whether those counts hold while an infinite feed scrolls and
//      recycles its tiles. A rule matching 0 elements on a page that has targets is STALE (the
//      criterion the extension's health check uses) and fails the run, as does a rule that does
//      not compile.
//
//   npm run script-check -- http://localhost:8088/feed.html                       # discovery
//   npm run script-check -- --rules mock/feed-rules.json --scrolls 5 http://localhost:8088/feed.html
//   npm run script-check -- --rules r.json --target 'video, canvas' --shots /tmp/sc <url…>
//
// Options: --rules FILE (a JSON array of rules, or {name, rules}) · --target SEL (default video)
// · --scrolls N viewport-heights to scroll with --rules (default 3) · --settle MS of DOM quiet
// to wait for after load/scroll (default 500; the wait gives up at --timeout, default 5000)
// · --shots DIR before/after screenshots · --size WxH (default 1280x900) · --top N candidates
// shown per group (default 3; the rest are counted, not dropped silently).
//
// A localhost URL whose server is down gets `mock/server.mjs` started on its port (and stopped
// afterwards), so `npm run script-check -- http://localhost:8088/feed.html` just works.
//
// One difference from the extension: the sheet goes in as the LAST AUTHOR sheet — BiDi cannot
// inject user-origin CSS. Author !important in the last sheet beats every earlier author rule,
// so it matches the extension's user-origin sheet except against the page's own inline-style
// !important — the after-census shows it if that happens. The census also runs in the top frame
// only; the extension runs it per frame.

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileRules } from "../src/background/rulecss.js";
import { launchFirefox } from "./lib/firefox-bidi.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const urls = [];
let rulesFile = null;
let target = "video";
let scrolls = 3;
let quietMs = 500;
let timeoutMs = 5000;
let shots = null;
let top = 3;
let width = 1280;
let height = 900;
for (let i = 0; i < args.length; i++) {
  const next = () => args[++i];
  if (args[i] === "--rules") rulesFile = next();
  else if (args[i] === "--target") target = next();
  else if (args[i] === "--scrolls") scrolls = Number(next());
  else if (args[i] === "--settle") quietMs = Number(next());
  else if (args[i] === "--timeout") timeoutMs = Number(next());
  else if (args[i] === "--shots") shots = next();
  else if (args[i] === "--top") top = Number(next());
  else if (args[i] === "--size") {
    const [w, h] = next().split("x").map(Number);
    width = w;
    height = h;
  } else if (/^https?:/.test(args[i])) urls.push(args[i]);
  else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
}
if (!urls.length) {
  console.error("usage: npm run script-check -- [--rules rules.json] [--target video] [--scrolls N] [--settle MS] [--timeout MS] [--shots DIR] [--size WxH] [--top N] <url> [url…]");
  process.exit(2);
}

const iife = (src) => src.trim().replace(/;\s*$/, ""); // `(() => {…})();` → an expression
const censusSrc = iife(await readFile(join(ROOT, "src/content/overlay-census.js"), "utf8"));
const pct = (f) => (f == null ? "  ?" : String(Math.round(f * 100)).padStart(3) + "%");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rules = null;
let scriptName = "";
if (rulesFile) {
  const parsed = JSON.parse(await readFile(rulesFile, "utf8"));
  rules = Array.isArray(parsed) ? parsed : parsed.rules;
  scriptName = Array.isArray(parsed) ? "" : parsed.name || "";
  if (!Array.isArray(rules)) {
    console.error(`${rulesFile}: expected a JSON array of rules or {name, rules}`);
    process.exit(2);
  }
  rules = rules.map((r, i) => ({ ...r, id: r.id || `r${i + 1}` }));
}

// firefox-bidi's evaluate() JSON-stringifies the expression's value as-is, which turns a Promise
// into "{}" — the waiting ops (settle) need the value awaited first.
async function call(ff, expr) {
  const r = await ff.send("script.evaluate", { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context: ff.context }, awaitPromise: true });
  if (r.type !== "success") throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 800));
  return r.result.value == null ? undefined : JSON.parse(r.result.value);
}
const census = (ff, cmd) => call(ff, `window.__rsdOverlay(${JSON.stringify(cmd)})`);

const injectCode = (css) =>
  `(() => { let s = document.getElementById("rsd-script-check"); if (!s) { s = document.createElement("style"); s.id = "rsd-script-check"; document.documentElement.appendChild(s); } s.textContent = ${JSON.stringify(css)}; return true; })()`;

// --- mock server ----------------------------------------------------------------
async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}
async function ensureServers() {
  const started = [];
  for (const port of new Set(urls.map((u) => new URL(u)).filter((u) => /^(localhost|127\.0\.0\.1)$/.test(u.hostname)).map((u) => u.port || "80"))) {
    const probe = urls.find((u) => (new URL(u).port || "80") === port);
    if (await reachable(probe)) continue;
    const p = spawn(process.execPath, [join(ROOT, "mock/server.mjs")], { env: { ...process.env, PORT: port }, stdio: "ignore" });
    started.push(p);
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(100);
      up = await reachable(probe);
    }
    if (!up) throw new Error(`nothing answers on :${port} and mock/server.mjs did not come up there`);
    console.log(`(started mock/server.mjs on :${port})`);
  }
  return started;
}

// --- reporting ---------------------------------------------------------------------
function printGroups(groups, label) {
  if (!groups.length) {
    console.log(`    ${label}: nothing paints over the ${target}s`);
    return;
  }
  for (const g of groups) {
    console.log(`    ${pct(g.share)}  ${g.desc}`);
    console.log(`          ${g.relation} · ${g.where} · ${g.count} on screen over ${g.targetsCovered} ${target}(s), ${g.roleCount} in the page · paints ${g.paints.join(", ")}`);
    for (const c of g.candidates.slice(0, top)) {
      const mark = c.extra === 0 && c.sameRole === g.roleCount ? (c.stable ? "✓" : "~") : "·";
      console.log(`          ${mark} ${c.selector}   ${c.matches} match / ${c.sameRole} same-role / ${c.extra} extra${c.stable ? "" : " · UNSTABLE"}${c.flags.length ? " · " + c.flags.join("; ") : ""}`);
    }
    if (g.candidates.length > top) console.log(`          (+${g.candidates.length - top} more candidates)`);
  }
}

function slug(url) {
  const u = new URL(url);
  return (u.hostname + u.pathname + u.search).replace(/[^\w.-]+/g, "_").replace(/_+$/, "");
}

// --- one URL ---------------------------------------------------------------------------
async function checkUrl(ff, url) {
  const res = { url, failures: [] };
  await ff.navigate(url);
  await call(ff, censusSrc);
  const loaded = await census(ff, { op: "settle", quietMs, timeoutMs });
  const before = await census(ff, { op: "overlays", target });
  if (!before || !before.ok) throw new Error((before && before.reason) || "overlay census failed");
  console.log(`\n${url}`);
  console.log(`    ${before.targets} ${target}(s), ${before.measured} on screen, ${before.points} points sampled · covered ${pct(before.coverage).trim()} · census ${before.ms} ms · settled in ${loaded.waitedMs} ms${loaded.timedOut ? " (TIMED OUT — the page never went quiet)" : ""}`);
  if (before.reason) console.log(`    ${before.reason}`);
  for (const h of before.hints || []) console.log(`    hint: ${h}`);
  const shot = async (tag) => shots && ff.screenshot(join(shots, `${slug(url)}.${tag}.png`));
  await shot("before");

  if (!rules) {
    printGroups(before.groups, "overlays");
    return res;
  }

  const { css, errors } = compileRules(rules, scriptName);
  for (const e of errors) res.failures.push(`rule ${e.id} does not compile: ${e.error}`);
  await call(ff, injectCode(css));
  await sleep(50);
  const after = await census(ff, { op: "overlays", target });
  await shot("after");
  const selectors = rules.map((r) => String(r.selector || ""));
  const counts0 = await census(ff, { op: "count", selectors, target });

  console.log(`    script${scriptName ? ` "${scriptName}"` : ""}: ${rules.length} rule(s), ${css.length} bytes of CSS${errors.length ? `, ${errors.length} NOT COMPILED` : ""}`);
  console.log(`    coverage ${pct(before.coverage)} → ${pct(after.coverage)}   (census ${after.ms} ms)`);
  const afterBy = new Map(after.groups.map((g) => [g.key, g]));
  for (const g of before.groups) {
    const a = afterBy.get(g.key);
    console.log(`      ${pct(g.share)} → ${a ? pct(a.share) : "gone"}  ${g.desc.slice(0, 100)}`);
  }
  for (const g of after.groups) if (!before.groups.some((b) => b.key === g.key)) console.log(`         new ${pct(g.share)}  ${g.desc.slice(0, 100)}  (now painting over the ${target})`);

  const failed = new Set(errors.map((e) => e.id));
  const stale = (counts, where) =>
    counts.counts.forEach((n, i) => {
      const r = rules[i];
      if (typeof n === "object") res.failures.push(`rule ${r.id}: invalid selector ${r.selector} — ${n.error}`);
      else if (n === 0 && counts.targets > 0) res.failures.push(`rule ${r.id} matches nothing ${where} (${r.selector})`);
    });
  console.log(`    rules:`);
  rules.forEach((r, i) => {
    const n = counts0.counts[i];
    const bad = failed.has(r.id) || typeof n === "object" || (n === 0 && counts0.targets > 0);
    console.log(`      ${bad ? "✗" : "✓"} ${String(r.id).padEnd(10)} ${String(r.action).padEnd(17)} ${typeof n === "object" ? "ERROR " + n.error : String(n).padStart(4) + " match"}   ${r.selector}`);
  });
  stale(counts0, "after load");

  if (scrolls > 0) {
    const ids = rules.map((r) => String(r.id).slice(0, 9));
    console.log(`    scroll (${scrolls} × one viewport, settle ${quietMs} ms):`);
    console.log(`      ${"step".padEnd(5)} ${"scrollTop".padEnd(15)} ${"settled".padEnd(9)} ${target.slice(0, 7).padStart(7)} ${"covered".padStart(7)} ${"census".padStart(6)}  ${ids.map((s) => s.padStart(9)).join(" ")}`);
    for (let step = 1; step <= scrolls; step++) {
      const sc = await census(ff, { op: "scroll", by: 1, target });
      if (!sc.ok) {
        console.log(`      ${sc.error}`);
        break;
      }
      const st = await census(ff, { op: "settle", quietMs, timeoutMs });
      const cn = await census(ff, { op: "count", selectors, target });
      const ov = await census(ff, { op: "overlays", target });
      stale(cn, `after scroll ${step}`);
      const cells = cn.counts.map((n) => (typeof n === "object" ? "ERR" : n === 0 && cn.targets > 0 ? "0 ✗" : String(n)).padStart(9));
      console.log(`      ${String(step).padEnd(5)} ${`${sc.before}→${sc.after}`.padEnd(15)} ${`${st.waitedMs}ms${st.timedOut ? "!" : ""}`.padEnd(9)} ${String(cn.targets).padStart(7)} ${pct(ov.coverage).padStart(7)} ${`${ov.ms}ms`.padStart(6)}  ${cells.join(" ")}${sc.atEnd ? "   (end of scroller)" : ""}`);
      if (step === 1 && sc.scroller) console.log(`            scroller: ${sc.scroller}`);
    }
  }
  return res;
}

async function main() {
  if (shots) await mkdir(shots, { recursive: true });
  const servers = await ensureServers();
  const ff = await launchFirefox({ width, height });
  let failures = 0;
  try {
    for (const url of urls) {
      try {
        const r = await checkUrl(ff, url);
        for (const f of new Set(r.failures)) console.log(`    ✗ ${f}`);
        if (r.failures.length) failures++;
      } catch (e) {
        failures++;
        console.log(`\n✗ ${url}\n    ERROR ${e.message}`);
      }
    }
  } finally {
    await ff.close();
    for (const s of servers) s.kill();
  }
  if (rules) console.log(`\n${urls.length - failures}/${urls.length} page(s) with every rule matching and compiling.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

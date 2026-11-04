#!/usr/bin/env node
// Measure how well AI dark mode DARKENS a page — the number that decides whether the feature
// works on a site, and one that was not visible before: a compile that produced a sheet
// counted as success even when the sheet did nothing (the model had guessed selectors, or
// activated a section palette that never reached the page).
//
//   npm run dark-check -- https://pyra-handheld.com/boards/                # default theme, no model
//   npm run dark-check -- --model gemma4-12b https://a.example https://b.example
//   npm run dark-check -- --model gemma4-12b --out /tmp/dc --max-light 0.25 <url…>
//
// It loads each URL in headless Firefox (tools/lib/firefox-bidi.mjs) and runs the REAL
// pipeline the extension runs: content/paint-census.js (how much of the viewport is light),
// content/restyle-probe.js (every colour rule, tokens, hooks — with cross-origin sheets
// fetched and handed back, as the background does), the real prompt → the model's plan
// (or the default theme without --model), background/darkcss.js compileSheet, and the same
// verify-and-fall-back rule as the extension. Then it censuses again and screenshots. So a
// site that scores well here turns dark in the browser, and a regression in the probe or
// compiler fails here first.
//
// One difference from the extension: the sheet goes in as a LAST AUTHOR sheet (BiDi cannot
// inject user-origin CSS). Author !important in the last sheet beats every earlier author
// rule, so it matches the extension's user-origin sheet except against inline-style
// !important — rare, and the census shows it if it happens.
//
// Per URL it prints: strategy, light fraction before → after, rules emitted, sheet size,
// model time; writes <out>/<host>.{before,after}.png, .summary.json, .plan.json, .css; and
// exits non-zero if any page is still lighter than --max-light after the theme.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STILL_LIGHT_FRACTION, compileSheet, defaultPlan, parsePlan, summarize } from "../src/background/darkcss.js";
import { chatOnce } from "../src/background/gateway.js";
import { DARK_MODE_SYSTEM_PROMPT, buildDarkUserMessage } from "../src/common/prompts.js";
import { launchFirefox } from "./lib/firefox-bidi.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const urls = [];
let model = null;
let gatewayUrl = "http://127.0.0.1:8001";
const gatewayKey = (process.env.LMGW_API_KEY || "").trim(); // env only: never an argv flag (shell history, ps)
let out = "/tmp/rsd-dark-check";
let maxLight = 0.25; // a page still lighter than this after the theme is a failure
let settle = 1500; // ms to let late-loading styles land before probing
let width = 1280;
let height = 900;
for (let i = 0; i < args.length; i++) {
  const next = () => args[++i];
  if (args[i] === "--model" || args[i] === "-m") model = next();
  else if (args[i] === "--gateway") gatewayUrl = next();
  else if (args[i] === "--out") out = next();
  else if (args[i] === "--max-light") maxLight = Number(next());
  else if (args[i] === "--settle") settle = Number(next());
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
  console.error("usage: npm run dark-check -- [--model <id>] [--out DIR] [--max-light 0.25] [--settle MS] [--size WxH] <url> [url…]");
  process.exit(2);
}

const iife = (src) => src.trim().replace(/;\s*$/, ""); // the content scripts are `(() => {…})();` — drop the `;` to use them as expressions
const probeSrc = iife(await readFile(join(ROOT, "src/content/restyle-probe.js"), "utf8"));
const censusSrc = iife(await readFile(join(ROOT, "src/content/paint-census.js"), "utf8"));
const pct = (f) => (f == null ? "  ?" : String(Math.round(f * 100)).padStart(3) + "%");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSheets(hrefs) {
  const got = [];
  await Promise.all(
    hrefs.map(async (href) => {
      try {
        const res = await fetch(href);
        if (res.ok) got.push({ href, text: await res.text() });
      } catch {
        /* unreachable */
      }
    })
  );
  return got;
}

async function planFor(summary) {
  if (!model) return { plan: defaultPlan("no --model: default theme"), ms: 0 };
  const t0 = Date.now();
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
    return { plan: parsePlan(text), ms: Date.now() - t0, raw: text };
  } catch (e) {
    return { plan: defaultPlan("model unavailable (" + e.message + ") — default theme"), ms: Date.now() - t0 };
  }
}

// Inject the compiled sheet as the page's last author stylesheet + the plan's root hooks.
const injectCode = (css, entry) =>
  `(function(){var s=document.getElementById("rsd-dark-check");if(s)s.remove();s=document.createElement("style");s.id="rsd-dark-check";s.textContent=${JSON.stringify(css)};document.documentElement.appendChild(s);` +
  `var a=${JSON.stringify(entry.rootAttributes || {})},c=${JSON.stringify(entry.rootClasses || [])};[document.documentElement,document.body].forEach(function(el){for(var k in a)el.setAttribute(k,a[k]);for(var i=0;i<c.length;i++)el.classList.add(c[i]);});return true;})()`;
const removeCode = (entry) =>
  `(function(){var s=document.getElementById("rsd-dark-check");if(s)s.remove();var a=${JSON.stringify(entry.rootAttributes || {})},c=${JSON.stringify(entry.rootClasses || [])};[document.documentElement,document.body].forEach(function(el){for(var k in a)el.removeAttribute(k);for(var i=0;i<c.length;i++)el.classList.remove(c[i]);});return true;})()`;

async function checkUrl(ff, url) {
  const host = new URL(url).hostname;
  const t0 = Date.now();
  await ff.navigate(url);
  await sleep(settle);
  const before = await ff.evaluate(censusSrc);
  let seam = await ff.evaluate(probeSrc);
  if (!seam || !seam.ok) throw new Error((seam && seam.reason) || "probe failed");
  if (seam.blockedHrefs && seam.blockedHrefs.length) {
    const extra = await fetchSheets(seam.blockedHrefs);
    if (extra.length) {
      await ff.evaluate(`(globalThis.__rsdDarkExtraSheets = ${JSON.stringify(extra)}, true)`);
      const again = await ff.evaluate(probeSrc);
      if (again && again.ok) seam = again;
    }
  }
  await ff.screenshot(join(out, host + ".before.png"));
  const summary = summarize(seam, before);
  const { plan, ms, raw } = await planFor(summary);
  await writeFile(join(out, host + ".summary.json"), JSON.stringify(summary, null, 1));
  await writeFile(join(out, host + ".plan.json"), JSON.stringify({ plan, raw }, null, 1));

  const apply = async (p) => {
    const { css, stats } = compileSheet(seam, before, p);
    const entry = { css, stats, rootAttributes: p.strategy === "native-theme" ? p.rootAttributes : {}, rootClasses: p.strategy === "native-theme" ? p.rootClasses : [] };
    await ff.evaluate(injectCode(css, entry));
    await sleep(200);
    entry.after = await ff.evaluate(censusSrc);
    return entry;
  };
  let entry = await apply(plan);
  let note = plan.rationale || "";
  if (plan.strategy === "native-theme" && entry.after && entry.after.lightFraction > STILL_LIGHT_FRACTION) {
    // Same rule as the extension's verify(): the native theme did not reach the page.
    const nativeLeft = entry.after.lightFraction;
    await ff.evaluate(removeCode(entry));
    entry = await apply({ ...plan, strategy: "recolor" });
    note = `native theme left ${pct(nativeLeft).trim()} light → recoloured. ` + note;
  }
  await ff.screenshot(join(out, host + ".after.png"));
  await writeFile(join(out, host + ".css"), entry.css);
  await writeFile(join(out, host + ".after.json"), JSON.stringify(entry.after, null, 1));
  await ff.evaluate(removeCode(entry));
  // What still paints light, by share and painter — the next thing to fix, right in the output.
  const stillLight = ((entry.after && entry.after.backgrounds) || []).filter((b) => b.light).slice(0, 4).map((b) => `${b.color} ${Math.round(b.share * 100)}% (${b.by.join(", ")})`);
  return {
    url,
    host,
    strategy: entry.stats.strategy,
    before: before ? before.lightFraction : null,
    after: entry.after ? entry.after.lightFraction : null,
    rules: entry.stats.rules,
    bytes: entry.css.length,
    sheets: seam.sheets,
    modelMs: ms,
    parsed: plan.parsed,
    totalMs: Date.now() - t0,
    note,
    stillLight,
  };
}

async function main() {
  await mkdir(out, { recursive: true });
  const ff = await launchFirefox({ width, height });
  const rows = [];
  try {
    for (const url of urls) {
      try {
        rows.push(await checkUrl(ff, url));
      } catch (e) {
        rows.push({ url, host: new URL(url).hostname, error: e.message });
      }
    }
  } finally {
    await ff.close();
  }
  console.log(`model ${model || "(none: default theme)"}   viewport ${width}x${height}   output ${out}\n`);
  let failed = 0;
  for (const r of rows) {
    if (r.error) {
      failed++;
      console.log(`✗ ${r.url}\n    ERROR ${r.error}`);
      continue;
    }
    const ok = r.after != null && r.after <= maxLight;
    if (!ok) failed++;
    const sheets = r.sheets ? `sheets ${r.sheets.readable}+${r.sheets.extra} readable, ${r.sheets.blocked} blocked` : "";
    console.log(`${ok ? "✓" : "✗"} ${r.url}\n    ${r.strategy.padEnd(12)} light ${pct(r.before)} → ${pct(r.after)}   ${String(r.rules).padStart(4)} rules  ${String(Math.round(r.bytes / 1024)).padStart(3)} KB   model ${(r.modelMs / 1000).toFixed(1)}s${r.parsed ? "" : " (plan unparsed → default theme)"}   total ${(r.totalMs / 1000).toFixed(1)}s   ${sheets}${r.note ? "\n    " + r.note : ""}`);
    if (r.stillLight && r.stillLight.length) console.log("    still light: " + r.stillLight.join("; "));
  }
  console.log(`\n${rows.length - failed}/${rows.length} pages ≤ ${Math.round(maxLight * 100)}% light after the theme.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

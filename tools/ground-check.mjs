#!/usr/bin/env node
// Measure how well a model GROUNDS — how close it puts a click to a target it was asked for
// in words. This is the number that decides whether screen vision (the page agent's
// screenshot/click_screen tools) works with a given model, and it is not predictable from
// model size or "has vision": a model can describe a button perfectly and still point 260px
// away. So measure, don't guess.
//
//   npm run ground-check -- --model gemma4-12b
//   npm run ground-check -- --model gemma4-12b --model gemma4-31b --repeat 3
//   npm run ground-check -- --model gemma4-12b --dpr 2      # non-1 device pixel ratio
//
// It renders mock/public/game.html (a pure-canvas page — nothing here is reachable by the DOM
// tools, which is the case screen vision exists for) with headless Firefox, then runs the REAL
// grounding path from src/background/vision.js against it: same prompt, same reply parser,
// same coordinate mapping the extension uses. So a model that scores well here works in the
// sidebar, and a regression in the parser fails here first.
//
// Ground truth comes from game.html's own layout maths (mirrored below — keep in sync if the
// mock's buttons move). Absent targets are tested too: a model that invents a box for
// something not on screen is worse than useless, because the agent will confidently click it.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { groundTarget } from "../src/background/vision.js";
import { gatewayHeaders } from "../src/background/gateway.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function dirname(p) { return p.slice(0, p.lastIndexOf("/")); }

const PORT = Number(process.env.PORT) || 8088;
const PAGE = `http://localhost:${PORT}/game.html`;

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const models = [];
let gatewayUrl = "http://127.0.0.1:8001";
const gatewayKey = (process.env.LMGW_API_KEY || "").trim(); // env only: never an argv flag (shell history, ps)
let width = 1280, height = 800, dpr = 1, repeat = 1;
for (let i = 0; i < args.length; i++) {
  const next = () => args[++i];
  if (args[i] === "--model" || args[i] === "-m") models.push(next());
  else if (args[i] === "--gateway") gatewayUrl = next();
  else if (args[i] === "--size") { const [w, h] = next().split("x").map(Number); width = w; height = h; }
  else if (args[i] === "--dpr") dpr = Number(next());
  else if (args[i] === "--repeat") repeat = Number(next());
  else { console.error(`unknown argument: ${args[i]}`); process.exit(2); }
}

// The buttons game.html draws, in CSS pixels — mirrors its BTN.place() functions.
const TARGETS = [
  { name: "Buy Engine Upgrade", ask: 'the "Buy Engine Upgrade" button, top right', rect: [width - 240, 24, width - 24, 72] },
  { name: "Collect Ore", ask: 'the "Collect Ore" button, bottom left', rect: [24, height - 72, 194, height - 24] },
  // Not on the page. The right answer is "not found" — a box here is a hallucination.
  { name: "Sell Ship (absent)", ask: 'the "Sell Ship" button', rect: null },
  { name: "shopping cart (absent)", ask: "the shopping cart icon", rect: null },
];

async function main() {
  if (!models.length) {
    console.error("usage: npm run ground-check -- --model <id> [--model <id2>] [--repeat N] [--dpr N] [--size WxH]\n");
    console.error(await listModels());
    process.exit(2);
  }

  const server = await ensureMock();
  let shot;
  try {
    shot = await screenshot();
  } finally {
    if (server) server.kill();
  }
  const actualDpr = shot.imgW / shot.cssW;
  console.log(`page ${PAGE}  viewport ${shot.cssW}x${shot.cssH} css  image ${shot.imgW}x${shot.imgH} px  ratio ${actualDpr}`);
  if (actualDpr !== dpr) {
    // Say it rather than reporting a dpr we didn't get: headless Firefox ignores
    // layout.css.devPixelsPerPx in --screenshot mode, so the scaling path is exercised at 1:1
    // and a mapping bug that only shows at dpr>1 would slip through this run.
    console.log(`NOTE: --dpr ${dpr} did not take effect (headless Firefox rendered at ${actualDpr}:1); image↔CSS scaling is untested here.`);
  }
  console.log(`gateway ${gatewayUrl}\n`);

  let failures = 0;
  for (const model of models) {
    console.log(`=== ${model} ===`);
    for (const t of TARGETS) {
      const runs = [];
      for (let i = 0; i < repeat; i++) runs.push(await measure(model, t, shot));
      failures += report(t, runs);
    }
    console.log("");
  }
  // A miss or a hallucination means this model cannot drive canvas pages — say so in the exit
  // code so this doubles as a regression check, not just a report.
  process.exit(failures ? 1 : 0);
}

async function measure(model, target, shot) {
  const t0 = Date.now();
  try {
    const hit = await groundTarget({ gatewayUrl, gatewayKey, model, shot, target: target.ask });
    return { ...hit, ms: Date.now() - t0 };
  } catch (e) {
    return { error: (e && e.message) || String(e), ms: Date.now() - t0 };
  }
}

function report(target, runs) {
  const label = target.name.padEnd(24);
  const ms = Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length);
  const errored = runs.find((r) => r.error);
  if (errored) {
    console.log(`  ${label} ERROR  ${errored.error.slice(0, 120)}`);
    return 1;
  }
  if (!target.rect) {
    const invented = runs.filter((r) => r.found);
    const ok = invented.length === 0;
    const detail = ok ? runs[0].reason || "reported not found" : `invented a box at (${invented[0].x}, ${invented[0].y})`;
    console.log(`  ${label} ${ok ? "ok  " : "FAIL"}  [${ms}ms]  ${clip(detail, 90)}`);
    return ok ? 0 : 1;
  }
  const [x1, y1, x2, y2] = target.rect;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const missing = runs.filter((r) => !r.found);
  if (missing.length) {
    console.log(`  ${label} FAIL  [${ms}ms]  not found: ${clip(missing[0].reason || "", 80)}`);
    return 1;
  }
  const errs = runs.map((r) => Math.hypot(r.x - cx, r.y - cy));
  const hits = runs.filter((r) => r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2).length;
  const spread = Math.max(...errs) - Math.min(...errs);
  const worst = Math.max(...errs).toFixed(1);
  const ok = hits === runs.length;
  console.log(
    `  ${label} ${ok ? "HIT " : "MISS"}  [${ms}ms]  err ${errs.map((e) => e.toFixed(1)).join("/")}px` +
    ` (worst ${worst}, spread ${spread.toFixed(1)})  at (${Math.round(runs[0].x)},${Math.round(runs[0].y)})` +
    ` [${runs[0].space}]  target center (${cx},${cy})`
  );
  return ok ? 0 : 1;
}

// --- mock server + capture --------------------------------------------------

// Reuse a running `npm run mock`; otherwise start one for the duration of this check.
async function ensureMock() {
  if (await alive()) return null;
  const p = spawn(process.execPath, [join(ROOT, "mock/server.mjs")], { stdio: "ignore", detached: false });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await alive()) return p;
  }
  p.kill();
  throw new Error(`mock server did not come up on :${PORT}`);
}

async function alive() {
  try {
    const r = await fetch(PAGE, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch { return false; }
}

// Headless Firefox screenshot, in a throwaway profile so it never touches (or is blocked by)
// the running browser. `layout.css.devPixelsPerPx` forces a device pixel ratio, which is what
// makes the image↔CSS scaling in vision.js observable rather than an identity mapping.
async function screenshot() {
  const profile = await mkdtemp(join(tmpdir(), "rsd-ground-"));
  const out = join(profile, "shot.png");
  await writeFile(join(profile, "user.js"), `user_pref("layout.css.devPixelsPerPx", "${dpr}");\n`);
  await run("firefox", ["--headless", "--profile", profile, "--window-size", `${width},${height}`, "--screenshot", out, PAGE]);
  const png = await readFile(out);
  const imgW = png.readUInt32BE(16); // IHDR width/height, always at this offset in a PNG
  const imgH = png.readUInt32BE(20);
  await rm(profile, { recursive: true, force: true });
  return { dataUrl: "data:image/png;base64," + png.toString("base64"), imgW, imgH, cssW: width, cssH: height };
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function listModels() {
  try {
    const r = await fetch(gatewayUrl + "/v1/models", { headers: gatewayHeaders(gatewayKey) });
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter((id) => !/^(embed|audio)\//.test(id));
    return "models this gateway can route:\n  " + ids.join("\n  ");
  } catch (e) {
    return `(couldn't list models from ${gatewayUrl}: ${(e && e.message) || e} — is lmgw running?)`;
  }
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(2);
});

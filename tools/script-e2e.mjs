#!/usr/bin/env node
// Script mode end to end, with a REAL model: the extension itself runs in headless Firefox,
// the user's requests go in through the sidebar's port protocol exactly as the sidebar sends
// them (Use page + Script on), and every gateway exchange passes through a recording proxy —
// so the transcript shows what the model was actually given and what it actually did: each
// tool call with its arguments, each tool result, the step notes the user sees, the answer.
// Then it measures the outcome with the overlay census: coverage before → after, whether the
// script applies on a fresh load, and whether its rules survive a site deploy (?deploy=2
// re-hashes every class name in the mock feed).
//
//   npm run script-e2e -- --model gemma4-12b
//   npm run script-e2e -- --model gemma4-12b --prompt "hide the badges" --approve no
//   npm run script-e2e -- --model gemma4-12b --turns my-turns.json --log /tmp/e2e.json
//   npm run script-e2e -- --model gemma4-12b --url https://example.com/feed --redeploy https://example.com/feed?v=2
//   npm run script-e2e -- --model gemma4-12b --scenario repair
//
// Without --prompt/--turns it plays the reference scenario (DEFAULT_TURNS below): clear the
// overlays but keep like/share on hover → also the Subscribe stickers → "Save it." (approved).
//
// --scenario repair plays Script mode's health check + repair on the mock feed instead: a saved
// script (mock/feed-rules.json, built and saved through the real tools by a SCRIPTED turn — the
// proxy answers it itself, no model call) → STALE_VISITS loads of feed.html?rename=1 (a redesign
// that renames two of its hooks) → the page action and the Script panel must name exactly the
// rules that broke → the panel's own "Repair with the agent" button (clicked in the real sidebar
// page) must load the draft and prefill the composer → that request goes to the model, then
// "Save it." → the script must keep its rule ids (update, not add), and every rule must match on
// ?rename=1 and on ?rename=1&deploy=2.
// --turns FILE is a JSON array of strings or {text, approve: "yes"|"no"}; a turn without its
// own `approve` uses --approve (default no), and every save the model asks for in a turn with
// approve:no is declined and reported — the model is meant to ask the user first.
//
// Options: --gateway URL (default http://127.0.0.1:8787) · --url PAGE (default: mock/server.mjs
// started on --port, or a free port, serving feed.html) · --redeploy URL (default for the mock:
// feed.html?deploy=2; skipped for other pages unless given) · --full (no trimming of tool results
// in the transcript; by default each is cut at --trim chars, default 1500, and says how much was
// cut) · --show-prompt (print the system prompt's Script-mode part and the draft block on the
// user's message, per turn) · --log FILE (every
// gateway exchange and port message as JSON) · --ff-log FILE (Firefox/extension console) ·
// --size WxH (default 1280x900) · --turn-timeout SEC (default 900; on expiry the turn is
// stopped with C2B.CANCEL and the run fails, saying so).
//
// Exit 0 when: no turn errored, the script has at least one rule, every rule matches on the
// redeploy page at load and after scrolling, and (if the model saved) the saved script is in
// effect after a fresh load — or, for --scenario repair, every check it prints passed. Exit 1 otherwise, 2 on bad usage, 3 when lmgw reports "gpu_hold"
// (the owner paused local models on purpose — nothing is retried).
//
// Firefox needs --remote-allow-system-access: BiDi will not navigate a content tab to a
// moz-extension: page, so the sidebar page is opened as a tab from the chrome window, and the
// harness talks to the background from there (main.js accepts the sidebar port only from that
// page). The census runs in the page's own world (like script-check), the extension's in its
// content-script sandbox — they don't share state.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as netServer } from "node:net";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { B2C, C2B, PORT_SIDEBAR } from "../src/common/messages.js";
import { STALE_VISITS } from "../src/background/scriptcore.js";
import { launchFirefox } from "./lib/firefox-bidi.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const DEFAULT_TURNS = [
  { text: "The buttons and text on top of the videos annoy me. Remove them, but I still want the like/share buttons when I hover a video.", approve: "no" },
  { text: "Also get rid of the Subscribe stickers.", approve: "no" },
  { text: "Save it.", approve: "yes" },
];

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let model = null;
let gatewayUrl = "http://127.0.0.1:8787";
const gatewayKey = (process.env.LMGW_API_KEY || "").trim(); // env only: never an argv flag (shell history, ps)
let pageUrl = null;
let port = null;
let redeployUrl = null;
const prompts = [];
let turnsFile = null;
let approveDefault = "no";
let full = false;
let trim = 1500;
let showPrompt = false;
let logFile = null;
let ffLogFile = null;
let width = 1280;
let height = 900;
let turnTimeoutS = 900;
let scenario = "default";
for (let i = 0; i < argv.length; i++) {
  const next = () => argv[++i];
  const a = argv[i];
  if (a === "--model" || a === "-m") model = next();
  else if (a === "--gateway") gatewayUrl = next().replace(/\/+$/, "").replace(/\/v1$/, "");
  else if (a === "--url") pageUrl = next();
  else if (a === "--port") port = Number(next());
  else if (a === "--redeploy") redeployUrl = next();
  else if (a === "--prompt") prompts.push(next());
  else if (a === "--turns") turnsFile = next();
  else if (a === "--approve") approveDefault = next();
  else if (a === "--full") full = true;
  else if (a === "--trim") trim = Number(next());
  else if (a === "--show-prompt") showPrompt = true;
  else if (a === "--log") logFile = next();
  else if (a === "--ff-log") ffLogFile = next();
  else if (a === "--turn-timeout") turnTimeoutS = Number(next());
  else if (a === "--size") [width, height] = next().split("x").map(Number);
  else if (a === "--scenario") scenario = next();
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
if (!model || !/^(yes|no)$/.test(approveDefault) || !/^(default|repair)$/.test(scenario)) {
  console.error('usage: npm run script-e2e -- --model <id> [--scenario default|repair] [--gateway URL] [--url PAGE] [--port N] [--redeploy URL] [--prompt "…"]… [--turns FILE] [--approve yes|no] [--full | --trim N] [--show-prompt] [--log FILE] [--ff-log FILE] [--size WxH] [--turn-timeout SEC]');
  process.exit(2);
}
if (scenario === "repair" && (pageUrl || redeployUrl || prompts.length || turnsFile)) {
  console.error("--scenario repair plays its own turns on the mock feed (its ?rename=1 redesign): --url, --redeploy, --prompt and --turns don't apply");
  process.exit(2);
}

let turns;
if (turnsFile) {
  const parsed = JSON.parse(await readFile(turnsFile, "utf8"));
  if (!Array.isArray(parsed)) {
    console.error(`${turnsFile}: expected a JSON array of strings or {text, approve}`);
    process.exit(2);
  }
  turns = parsed.map((t) => (typeof t === "string" ? { text: t } : t));
} else if (prompts.length) turns = prompts.map((text) => ({ text }));
else turns = DEFAULT_TURNS;
turns = turns.map((t) => ({ text: String(t.text), approve: t.approve || approveDefault }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (f) => (typeof f === "number" && Number.isFinite(f) ? Math.round(f * 100) + "%" : "?");
const secs = (ms) => (ms / 1000).toFixed(1) + "s";
const iife = (src) => src.trim().replace(/;\s*$/, "");
const censusSrc = iife(await readFile(join(ROOT, "src/content/overlay-census.js"), "utf8"));
const manifest = JSON.parse(await readFile(join(ROOT, "src/manifest.json"), "utf8"));
const EXT_ID = manifest.browser_specific_settings.gecko.id;

// --- output -------------------------------------------------------------------------------
// Port messages are stamped in the sidebar page, gateway exchanges in the proxy; both go
// through one queue printed in time order a moment behind real time, so a step note emitted
// during a tool lands between the call and its result rather than wherever polling put it.
const queue = [];
const emit = (t, text) => queue.push({ t, text });
function flush(all = false) {
  const cutoff = all ? Infinity : Date.now() - 600;
  queue.sort((a, b) => a.t - b.t);
  while (queue.length && queue[0].t <= cutoff) console.log(queue.shift().text);
}
const indent = (s, pad) => String(s).split("\n").map((l) => pad + l).join("\n");
function shown(text) {
  const s = String(text == null ? "" : text);
  if (full || s.length <= trim) return s;
  return s.slice(0, trim) + `\n[… ${s.length - trim} of ${s.length} chars trimmed for display — --full shows all]`;
}
const log = { turns: [], exchanges: [], messages: [] };

// --- recording proxy in front of the gateway -------------------------------------------------
// The extension's gatewayUrl points here. Nothing is altered: the request and response go
// through byte for byte; we parse copies to print the transcript and catch gpu_hold.
// `scripted`: replies the proxy gives itself instead of asking the gateway — { tool_calls: [[name,
// args], …] } or { content } — one per chat request while any are queued (the repair scenario's
// seed turn).
const state = { turn: 0, firstOfTurn: false, calls: 0, gpuHold: null, fallbacks: new Set(), httpErrors: [], seenModels: false, lastAssistantIdx: -1, pendingCalls: [], scripted: [] };

function forward(req, body) {
  const target = new URL(req.url, gatewayUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"];
  if (body.length) headers["content-length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const r = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end(body);
  });
}

function onChatRequest(j, t) {
  const msgs = j.messages || [];
  // Tool results (and any nudge the agent added) since the assistant turn we last printed.
  let lastA = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { lastA = i; break; }
  if (lastA >= 0 && !state.firstOfTurn) {
    const after = msgs.slice(lastA + 1);
    after.filter((m) => m.role === "tool").forEach((m, i) => {
      const call = state.pendingCalls[i];
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      emit(t, `       ← ${call ? call.name : "?"}: ${content.length} chars\n${indent(shown(content), "         ")}`);
    });
    // A nudge after a reasoning-only reply, or a screenshot: the agent speaking as the user.
    for (const m of after.filter((x) => x.role === "user")) emit(t + 1, `       (agent → model, as user)\n${indent(shown(typeof m.content === "string" ? m.content : "[non-text content]"), "         ")}`);
  }
  state.firstOfTurn = false;
  state.pendingCalls = [];
  if (showPrompt && msgs.length && msgs[0].role === "system" && !msgs.some((m) => m.role === "tool" || m.role === "assistant")) {
    const sys = String(msgs[0].content);
    const at = sys.indexOf("SCRIPT MODE");
    // The draft block rides on the user's message (agent.js), not in the system prompt.
    const user = msgs.filter((m) => m.role === "user").pop();
    const utext = user && typeof user.content === "string" ? user.content : "";
    const bat = utext.indexOf("SCRIPT DRAFT");
    const brief = bat >= 0 ? `\n   ├ draft block on the user message:\n${indent(utext.slice(bat), "   │ ")}` : "";
    emit(t, `   ┌ system prompt (${sys.length} chars; Script part):\n${indent(at >= 0 ? sys.slice(at) : sys, "   │ ")}${brief}\n   └ ${(j.tools || []).length} tools: ${(j.tools || []).map((x) => x.function.name).join(", ")}`);
  }
}

function onChatResponse(ex) {
  const n = ++state.calls;
  const dt = ex.t1 - ex.t0;
  const fb = ex.fallback ? `  [answered by FALLBACK alias ${ex.fallback}]` : ex.scripted ? "  [scripted by the harness — no model call]" : "";
  if (ex.status !== 200) {
    emit(ex.t1, `  #${n} ${secs(dt)} HTTP ${ex.status}: ${shown(ex.text)}${fb}`);
    return;
  }
  const j = ex.json || {};
  const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const u = j.usage || {};
  const tok = u.prompt_tokens != null ? ` · ${u.prompt_tokens} in / ${u.completion_tokens} out tok` : "";
  const head = `  #${n} ${secs(dt)}${tok}${fb}`;
  const calls = m.tool_calls || [];
  const content = typeof m.content === "string" ? m.content.trim() : "";
  const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
  const lines = [head];
  if (reasoning) lines.push(`     reasoning:\n${indent(shown(reasoning), "       ")}`);
  if (calls.length) {
    if (content) lines.push(`     says:\n${indent(shown(content), "       ")}`);
    for (const c of calls) {
      const name = c.function && c.function.name;
      lines.push(`     → ${name} ${(c.function && c.function.arguments) || ""}`);
      state.pendingCalls.push({ name });
    }
  } else lines.push(content ? `     → ANSWER:\n${indent(content, "       ")}` : "     → (no tool call and no content)");
  emit(ex.t1, lines.join("\n"));
}

async function startProxy() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const t0 = Date.now();
    const isChat = req.url.startsWith("/v1/chat/completions");
    // With a key configured only a fetch that CARRIED it counts: it proves the key reached the
    // background too, not just the url (the headers are forwarded below, never logged or recorded).
    if (req.url.startsWith("/v1/models") && (!gatewayKey || req.headers.authorization === "Bearer " + gatewayKey)) state.seenModels = true;
    let reqJson = null;
    if (isChat) {
      try {
        reqJson = JSON.parse(body.toString("utf8"));
        onChatRequest(reqJson, t0);
      } catch {
        /* forwarded as-is */
      }
    }
    if (isChat && state.scripted.length) {
      const next = state.scripted.shift();
      const message = next.tool_calls
        ? { role: "assistant", content: null, tool_calls: next.tool_calls.map(([name, args], i) => ({ id: `scripted${state.calls}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
        : { role: "assistant", content: next.content };
      const json = { choices: [{ index: 0, message, finish_reason: next.tool_calls ? "tool_calls" : "stop" }] };
      const ex = { turn: state.turn, t0, t1: Date.now(), status: 200, scripted: true, request: reqJson, response: json };
      log.exchanges.push(ex);
      onChatResponse({ ...ex, json });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
      return;
    }
    let up;
    try {
      up = await forward(req, body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `script-e2e proxy: gateway unreachable — ${e.message}` } }));
      state.httpErrors.push(`${req.method} ${req.url}: gateway unreachable (${e.message})`);
      return;
    }
    const t1 = Date.now();
    const text = up.body.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (an SSE stream, audio) */
    }
    const fallback = up.headers["x-lmgw-fallback"] || null;
    if (fallback) state.fallbacks.add(fallback);
    const code = json && (json.code || (json.error && json.error.code));
    if (up.status === 503 && code === "gpu_hold") state.gpuHold = (json.error && json.error.message) || "gpu_hold";
    else if (up.status >= 400) state.httpErrors.push(`${req.method} ${req.url}: HTTP ${up.status} ${text.slice(0, 300)}`);
    if (isChat) {
      const ex = { turn: state.turn, t0, t1, status: up.status, fallback, request: reqJson, response: json, text: json ? undefined : text };
      log.exchanges.push(ex);
      onChatResponse({ ...ex, json, text });
    }
    const out = { "content-type": up.headers["content-type"] || "application/octet-stream" };
    if (fallback) out["x-lmgw-fallback"] = fallback;
    res.writeHead(up.status, out);
    res.end(up.body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// --- mock feed ---------------------------------------------------------------------------------
async function freePort() {
  const s = netServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}
async function startMock() {
  const p = port || (await freePort());
  const url = `http://localhost:${p}/feed.html`;
  if (port && (await reachable(url))) return { url, proc: null };
  const proc = spawn(process.execPath, [join(ROOT, "mock/server.mjs")], { env: { ...process.env, PORT: String(p) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await reachable(url)) return { url, proc };
  }
  proc.kill();
  throw new Error(`mock/server.mjs did not come up on :${p}`);
}

// --- BiDi helpers ---------------------------------------------------------------------------
let ff;
async function evalIn(context, expr) {
  const r = await ff.send("script.evaluate", { expression: `(async () => JSON.stringify(await (${expr})))()`, target: { context }, awaitPromise: true });
  if (r.type !== "success") throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 800));
  return r.result.value == null ? undefined : JSON.parse(r.result.value);
}
async function waitFor(context, expr, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(context, expr);
    if (v || Date.now() - t0 > ms) return v;
    await sleep(200);
  }
}
const census = (context, cmd) => evalIn(context, `window.__rsdOverlay(${JSON.stringify(cmd)})`);
async function loadAndSettle(context, url) {
  await ff.send("browsingContext.navigate", { context, url, wait: "complete" });
  await evalIn(context, censusSrc);
  return census(context, { op: "settle", quietMs: 500, timeoutMs: 5000 });
}

// Is each rule visibly in force on its first match? Proves the extension's sheet is in this
// document (the census only says what is covered, not why). A move to a side is judged by the
// box landing outside its containing block; corner moves and restyle are not judged.
const effectExpr = (rules) => `(() => {
  const out = {};
  for (const r of ${JSON.stringify(rules)}) {
    let els;
    try { els = [...document.querySelectorAll(r.selector)]; } catch (e) { out[r.id] = "invalid selector"; continue; }
    if (!els.length) { out[r.id] = "no element"; continue; }
    const el = els[0];
    const cs = getComputedStyle(el);
    const p = r.params || {};
    if (r.action === "hide") out[r.id] = cs.display === "none" ? "ok" : "display " + cs.display;
    else if (r.action === "hide-until-hover") out[r.id] = cs.opacity === "0" ? "ok" : "opacity " + cs.opacity;
    else if (r.action === "dim") out[r.id] = Math.abs(Number(cs.opacity) - (p.opacity == null ? 0.3 : Number(p.opacity))) < 0.01 ? "ok" : "opacity " + cs.opacity;
    else if (r.action === "click-through") out[r.id] = cs.pointerEvents === "none" ? "ok" : "pointer-events " + cs.pointerEvents;
    else if (r.action === "move" && ["right", "left", "below", "above"].includes(p.to) && el.offsetParent) {
      const a = el.getBoundingClientRect(), b = el.offsetParent.getBoundingClientRect();
      const outside = { right: a.left >= b.right - 1, left: a.right <= b.left + 1, below: a.top >= b.bottom - 1, above: a.bottom <= b.top + 1 }[p.to];
      out[r.id] = outside ? "ok" : "still inside its " + el.offsetParent.localName;
    } else out[r.id] = "not judged";
  }
  return out;
})()`;

// --- main -----------------------------------------------------------------------------------
async function main() {
  const t00 = Date.now();
  const checks = [];
  const check = (ok, what) => checks.push({ ok, what });
  const proxy = await startProxy();
  const mock = pageUrl ? null : await startMock();
  const url = pageUrl || mock.url;
  if (!redeployUrl && !pageUrl) redeployUrl = url + "?deploy=2";
  console.log(`script-e2e · model ${model} via ${gatewayUrl} (recorded through ${proxy.url})`);
  if (scenario === "repair") console.log(`page ${url} · scenario repair: seed a script, ${STALE_VISITS} visits to ?rename=1, repair, save`);
  else console.log(`page ${url}${redeployUrl ? ` · redeploy check on ${redeployUrl}` : " · no redeploy check (pass --redeploy URL)"}`);
  console.log(`${scenario === "repair" ? 3 : turns.length} turn(s) · tool results ${full ? "untrimmed" : `trimmed at ${trim} chars`} · turn timeout ${turnTimeoutS}s`);

  const ffPrefs = ffLogFile ? { "devtools.console.stdout.content": true, "devtools.console.stdout.chrome": true } : {};
  if (ffLogFile) await writeFile(ffLogFile, "");
  ff = await launchFirefox({ width, height, args: ["--remote-allow-system-access"], prefs: ffPrefs, onOutput: ffLogFile ? (s) => appendFile(ffLogFile, s).catch(() => {}) : null });
  let exit = 0;
  try {
    const inst = await ff.send("webExtension.install", { extensionData: { type: "path", path: join(ROOT, "src") } });
    if (inst.extension !== EXT_ID) throw new Error(`installed ${JSON.stringify(inst)}, expected ${EXT_ID}`);
    const feed = ff.context;
    const settled0 = await loadAndSettle(feed, url);

    // The sidebar page, as a tab of the same window (the chrome window is the only place that
    // may open a moz-extension: URL).
    const chrome = (await ff.send("browsingContext.getTree", { "moz:scope": "chrome" })).contexts[0].context;
    const chromeEval = async (expr) => {
      const r = await ff.send("script.evaluate", { expression: expr, target: { context: chrome }, awaitPromise: true });
      if (r.type !== "success") throw new Error("chrome evaluate failed: " + JSON.stringify(r.exceptionDetails || r).slice(0, 600));
      return r.result.value;
    };
    const sidebarUrl = await chromeEval(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).getURL("sidebar/sidebar.html")`);
    await chromeEval(`(gBrowser.selectedTab = gBrowser.addTab(${JSON.stringify(sidebarUrl)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), "ok")`);
    let sb = null;
    for (let i = 0; i < 100 && !sb; i++) {
      await sleep(100);
      const c = (await ff.send("browsingContext.getTree", {})).contexts.find((x) => x.url === sidebarUrl);
      if (c) sb = c.context;
    }
    if (!sb) throw new Error("the sidebar page did not open");
    await waitFor(sb, `document.readyState === "complete"`, 10000);
    await evalIn(sb, `(async () => {
      await browser.storage.local.set({ gatewayUrl: ${JSON.stringify(proxy.url)}, gatewayKey: ${JSON.stringify(gatewayKey)}, defaultModel: ${JSON.stringify(model)} });
      window.__wid = (await browser.windows.getCurrent()).id;
      window.__msgs = [];
      window.__approve = false;
      window.__port = browser.runtime.connect({ name: ${JSON.stringify(PORT_SIDEBAR)} });
      __port.onMessage.addListener((m) => {
        m.__t = Date.now();
        __msgs.push(m);
        if (m.type === ${JSON.stringify(B2C.AGENT_STEP)} && m.kind === "confirm") {
          m.__answer = window.__approve;
          __port.postMessage({ type: ${JSON.stringify(C2B.AGENT_CONFIRM)}, id: m.id, approved: window.__approve });
        }
      });
      __port.postMessage({ type: ${JSON.stringify(C2B.HELLO)}, windowId: __wid });
      return true;
    })()`);
    if (!(await waitFor(sb, `__msgs.some((m) => m.type === ${JSON.stringify(B2C.STATE)})`, 15000))) throw new Error("the background never answered HELLO");
    // storage.onChanged → the background re-reads the model list from the new gateway url:
    // seeing that request is the proof the prefs reached it before the first turn.
    // A set that lands after the background read its prefs but before it registered
    // storage.onChanged is missed, and the turns would go straight to the gateway, unrecorded —
    // so the url is set again (alternating a trailing slash, which joinUrl ignores, so that it
    // is a change) until the proxy sees the fetch, and the run stops if it never does. The key is
    // re-sent in the same set: the background only adopts a pref that is in the change set, and the
    // proxy counts a /v1/models fetch only if it carried the key. (Measured in this Firefox:
    // storage.onChanged also fires for a key re-set to an unchanged value.)
    for (let i = 0; i < 50 && !state.seenModels; i++) await sleep(100);
    for (let i = 0; i < 10 && !state.seenModels; i++) {
      await evalIn(sb, `browser.storage.local.set({ gatewayUrl: ${JSON.stringify(proxy.url)} + (${i} % 2 ? "" : "/"), gatewayKey: ${JSON.stringify(gatewayKey)} }).then(() => true)`);
      for (let k = 0; k < 10 && !state.seenModels; k++) await sleep(100);
    }
    if (!state.seenModels) throw new Error("the background never fetched /v1/models through the recording proxy — its gateway pref did not take; not running turns that would bypass the proxy");
    // A missed first set also lost the model, and the background's first-run default (the first
    // local model) may have overwritten it in storage since: set it again — a change if so.
    await evalIn(sb, `browser.storage.local.set({ defaultModel: ${JSON.stringify(model)} }).then(() => true)`);
    await sleep(300);

    // Baseline: the page as the site made it.
    const before = await census(feed, { op: "overlays", target: "video" });
    if (!before || !before.ok) throw new Error("baseline census failed: " + JSON.stringify(before));
    console.log(`\nbaseline: ${before.targets} videos, ${before.measured} on screen · covered ${pct(before.coverage)}${settled0.timedOut ? " · page never went quiet" : ""}`);
    for (const g of before.groups) console.log(`   ${pct(g.share).padStart(4)}  ${g.desc.slice(0, 110)}`);

    // --- turns ---
    let seen = 0;
    const pollMessages = async () => {
      const ms = await evalIn(sb, `__msgs.slice(${seen})`);
      seen += ms.length;
      for (const m of ms) {
        log.messages.push(m);
        if (m.type === B2C.AGENT_STEP) {
          if (m.kind === "confirm") emit(m.__t, `     ? CONFIRM shown to the user → ${m.__answer ? "APPROVED" : "DECLINED"} by the harness\n${indent(m.text, "       ")}`);
          else emit(m.__t, `     · ${m.kind}: ${String(m.text).replace(/\n/g, "\n       ")}`);
        } else if (m.type === B2C.ERROR) emit(m.__t, `     ✗ ERROR: ${m.message}${m.detail ? ` — ${String(m.detail).slice(0, 500)}` : ""}`);
      }
      return ms;
    };
    let unaskedSaves = 0;
    let saved = false;
    let turnNo = 0;
    // One user message through the port, as the sidebar sends it (Use page + Script on), until
    // the run is over; confirms are answered per the turn's `approve`.
    const runTurn = async (turn, of) => {
      const ti = turnNo++;
      state.turn = ti + 1;
      state.firstOfTurn = true;
      await ff.send("browsingContext.activate", { context: feed });
      await evalIn(sb, `(window.__approve = ${turn.approve === "yes"}, true)`);
      const callsBefore = state.calls;
      console.log(`\n── turn ${ti + 1}/${of} (confirms → ${turn.approve === "yes" ? "approve" : "decline"}) ──\n  USER: ${turn.text}`);
      const t0 = Date.now();
      await evalIn(sb, `(__port.postMessage({ type: ${JSON.stringify(C2B.SEND)}, windowId: __wid, text: ${JSON.stringify(turn.text)}, model: ${JSON.stringify(model)}, includePage: true, allowNav: false, scriptMode: true }), true)`);
      let started = false;
      let done = false;
      let timedOut = false;
      let errored = [];
      let answer = null;
      let confirms = [];
      while (!done) {
        await sleep(250);
        for (const m of await pollMessages()) {
          if (m.type === B2C.BUSY && m.active) started = true;
          if (m.type === B2C.BUSY && !m.active && started) done = true;
          if (m.type === B2C.ERROR) errored.push(m.message);
          if (m.type === B2C.AGENT_STEP && m.kind === "error") errored.push(m.text);
          if (m.type === B2C.AGENT_STEP && m.kind === "confirm") confirms.push(m);
          if (m.type === B2C.DELTA) answer = (answer || "") + m.text;
        }
        if (!started && errored.length && Date.now() - t0 > 3000) done = true;
        if (state.gpuHold && !done) {
          await evalIn(sb, `(__port.postMessage({ type: ${JSON.stringify(C2B.CANCEL)} }), true)`);
        }
        if (!done && Date.now() - t0 > turnTimeoutS * 1000) {
          timedOut = true;
          emit(Date.now(), `     ✗ TURN TIMEOUT after ${turnTimeoutS}s (--turn-timeout) — sending Stop`);
          await evalIn(sb, `(__port.postMessage({ type: ${JSON.stringify(C2B.CANCEL)} }), true)`);
          await waitFor(sb, `__msgs.slice(${seen}).some((m) => m.type === ${JSON.stringify(B2C.BUSY)} && !m.active)`, 30000);
          await pollMessages();
          done = true;
        }
        flush();
      }
      await sleep(700);
      await pollMessages();
      flush(true);
      const wall = Date.now() - t0;
      const ex = log.exchanges.filter((e) => e.turn === ti + 1);
      const modelMs = ex.reduce((s, e) => s + (e.t1 - e.t0), 0);
      const names = ex.flatMap((e) => ((e.response && e.response.choices && e.response.choices[0].message.tool_calls) || []).map((c) => c.function && c.function.name));
      const toolCalls = names.length;
      const tally = [...new Set(names)].map((n) => { const k = names.filter((x) => x === n).length; return k > 1 ? `${n}×${k}` : n; }).join(", ");
      const lastChange = names.map((n) => /^(add|update|remove)_rule$/.test(n)).lastIndexOf(true);
      const untested = lastChange >= 0 && names.lastIndexOf("test_script") < lastChange;
      const saveConfirms = confirms.filter((c) => /^Save script/.test(c.text));
      if (saveConfirms.length && turn.approve === "yes") saved = true;
      if (saveConfirms.length && turn.approve !== "yes") unaskedSaves += saveConfirms.length;
      const summary = { turn: ti + 1, text: turn.text, wallMs: wall, modelMs, modelCalls: state.calls - callsBefore, toolCalls, tools: names, untested, errors: errored, timedOut, answer, saveConfirms: saveConfirms.length };
      log.turns.push(summary);
      console.log(`  turn ${ti + 1}: ${secs(wall)} wall · ${summary.modelCalls} model call(s), ${secs(modelMs)} in the model · ${toolCalls} tool call(s)${tally ? ` (${tally})` : ""}${untested ? " · rules changed after the last test_script" : ""}${saveConfirms.length ? ` · save asked ${saveConfirms.length}× (${turn.approve === "yes" ? "approved" : "declined — not asked for in this turn"})` : ""}${errored.length ? ` · ERRORS: ${errored.join(" | ")}` : ""}${timedOut ? " · TIMED OUT" : ""}`);
      check(!errored.length && !timedOut, `turn ${ti + 1} ran without errors${errored.length ? ` (${errored.join(" | ")})` : ""}${timedOut ? " (timed out)" : ""}`);
      return summary;
    };
    const holdExit = () => {
      console.log(`\nlmgw answered 503 gpu_hold: ${state.gpuHold}\nLocal models are paused on purpose (GPU hold). Nothing was retried; release the hold yourself if you want this run.`);
      exit = 3;
      return exit;
    };
    const store = (keys) => evalIn(sb, `browser.storage.local.get(${JSON.stringify(keys)})`);
    const fmtRule = (r) => {
      const p = Object.entries(r.params || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
      return `${r.id} ${r.action} ${r.selector}${p ? ` (${p})` : ""}${r.why ? ` — ${r.why}` : ""}`;
    };

    // Fresh load: the script goes in at document_start through the extension, as on any visit.
    const measure = async (label, pageUrl2, script) => {
      const rules = script.rules;
      const target = script.target || "video";
      const st = await loadAndSettle(feed, pageUrl2);
      const ov = await census(feed, { op: "overlays", target });
      const cn = await census(feed, { op: "count", selectors: rules.map((r) => r.selector), target });
      const eff = await evalIn(feed, effectExpr(rules));
      console.log(`\n${label}: ${pageUrl2}${st.timedOut ? " (page never went quiet)" : ""}`);
      console.log(`  coverage ${pct(before.coverage)} (baseline, no script) → ${pct(ov.coverage)} with the ${script.kind}`);
      for (const g of ov.groups || []) console.log(`    still covering ${pct(g.share).padStart(4)}  ${g.desc.slice(0, 100)}`);
      const zero = [];
      rules.forEach((r, i) => {
        const n = cn.counts[i];
        const stale = typeof n !== "number" || (n === 0 && cn.targets > 0);
        if (stale) zero.push(r.id);
        const off = eff[r.id] !== "ok" && eff[r.id] !== "not judged";
        console.log(`  ${stale || off ? "✗" : "✓"} ${r.id.padEnd(4)} ${String(typeof n === "number" ? n : "ERR " + JSON.stringify(n)).padStart(4)} match · ${eff[r.id] === "ok" ? "in effect" : off ? `NOT in effect (${eff[r.id]})` : eff[r.id]}  ${r.selector}`);
      });
      const inEffect = rules.filter((r) => eff[r.id] === "ok" || eff[r.id] === "not judged").length;
      return { ov, cn, eff, zero, inEffect };
    };
    // A load, then 2 scrolls: the rules that matched 0 with a video on the page at any step.
    const staleAcrossScrolls = async (label, pageUrl2, script) => {
      const rules = script.rules;
      const target = script.target || "video";
      const re = await measure(label, pageUrl2, script);
      const stale = new Set(re.zero);
      for (let s = 1; s <= 2; s++) {
        const sc = await census(feed, { op: "scroll", by: 1, target });
        if (!sc.ok) break;
        await census(feed, { op: "settle", quietMs: 500, timeoutMs: 5000 });
        const cn = await census(feed, { op: "count", selectors: rules.map((r) => r.selector), target });
        cn.counts.forEach((n, i) => {
          if (typeof n !== "number" || (n === 0 && cn.targets > 0)) stale.add(rules[i].id);
        });
        console.log(`  after scroll ${s}: ${rules.map((r, i) => `${r.id} ${cn.counts[i]}`).join(" · ")}`);
      }
      return stale;
    };

    if (scenario === "repair") {
      // --- the repair scenario (see the header) ---
      // 1. Seed: the reference script, built and saved through the real tool path — the proxy plays
      //    the model for this one turn (add_rule × n, save_script), so no model time is spent on it.
      const seed = JSON.parse(await readFile(join(ROOT, "mock/feed-rules.json"), "utf8"));
      state.scripted = [
        { tool_calls: seed.rules.map((r) => ["add_rule", { selector: r.selector, action: r.action, ...(r.params ? { params: r.params } : {}), why: r.why }]) },
        { tool_calls: [["save_script", { name: seed.name }]] },
        { content: "Saved the reference script." },
      ];
      await runTurn({ text: "(seed — answered by the harness, not the model) clear the video wall and save it", approve: "yes" }, 3);
      let all = await store(["userScripts", "userScriptDraft"]);
      const seeded = Object.values(all.userScripts || {})[0];
      check(!!seeded && seeded.rules.length === seed.rules.length && !all.userScriptDraft, `the seed script is saved (${seeded ? seeded.rules.length : 0}/${seed.rules.length} rules)`);
      if (!seeded) return 1;
      console.log(`seeded "${seeded.name}" ${seeded.id}:`);
      for (const r of seeded.rules) console.log(`  ${fmtRule(r)}`);

      // 2. The redesign: which rules ?rename=1 breaks, measured in the page (nothing assumed).
      const renamed = url + "?rename=1";
      const probe = await measure("the redesign, before any repair (?rename=1)", renamed, { ...seeded, kind: "saved script" });
      const expectStale = probe.zero.slice().sort();
      check(expectStale.length > 0 && expectStale.length < seeded.rules.length, `?rename=1 breaks some rules, not all (${expectStale.join(", ") || "none"})`);

      // 3. Visits: the health check runs at load + settle; after STALE_VISITS visits that had
      //    videos, those rules are stale. (The probe load above was visit 1.)
      const feedTab = await evalIn(sb, `browser.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").startsWith(${JSON.stringify(url)})).id)`);
      const trailing = (rec, id) => {
        const v = (rec && rec.rules && rec.rules[id] && rec.rules[id].visits) || [];
        let n = 0;
        for (let i = v.length - 1; i >= 0 && !v[i].ok; i--) n++;
        return n;
      };
      for (let i = 1; i <= STALE_VISITS; i++) {
        if (i > 1) await loadAndSettle(feed, renamed);
        const t0 = Date.now();
        let rec = null;
        while (Date.now() - t0 < 20000) {
          rec = ((await store(["userScriptHealth"])).userScriptHealth || {})[seeded.id];
          if (expectStale.every((id) => trailing(rec, id) >= i)) break;
          await sleep(250);
        }
        console.log(`visit ${i}: ${seeded.rules.map((r) => `${r.id} ${trailing(rec, r.id) ? `missed ×${trailing(rec, r.id)}` : rec && rec.rules && rec.rules[r.id] ? "ok" : "–"}`).join(" · ")} (${secs(Date.now() - t0)} after load)`);
      }
      const title = await evalIn(sb, `browser.pageAction.getTitle({ tabId: ${feedTab} })`);
      console.log(`\npage action:\n${indent(title, "  ")}`);
      const named = expectStale.every((id) => title.includes(`${id} ${seeded.rules.find((r) => r.id === id).selector}`));
      const others = seeded.rules.filter((r) => !expectStale.includes(r.id)).every((r) => !title.includes(`${r.id} ${r.selector}`));
      check(title.startsWith(`⚠ "${seeded.name}": ${expectStale.length} of ${seeded.rules.length}`) && named && others && title.includes(`last ${STALE_VISITS} visits`), `after ${STALE_VISITS} visits the page action names exactly the stale rules (${expectStale.join(", ")})`);
      // 4. Repair, through the Script panel's own button: the sidebar page in that tab is the real
      //    one (sidebar.js renders every SCRIPT_STATE for its window, whose context follows the
      //    active tab), so its saved list must show the stale rules and the button must work.
      await ff.send("browsingContext.activate", { context: feed });
      const ui = await waitFor(sb, `(() => { const b = document.querySelector("#script-saved .sc-repair"); const p = b && b.closest(".sc-saved").querySelector(".sc-problem"); return b ? (p ? p.textContent : "") : null; })()`, 10000);
      console.log(`\nScript panel, saved list: ${ui == null ? "(no Repair button)" : ui}`);
      check(ui != null && expectStale.every((id) => ui.includes(`${id} ${seeded.rules.find((r) => r.id === id).selector}`)) && ui.includes(`last ${STALE_VISITS} visits`), "the Script panel marks the stale rules and offers the repair");
      const mark = await evalIn(sb, `__msgs.length`);
      await evalIn(sb, `(document.querySelector("#script-saved .sc-repair").click(), true)`);
      const prefill = await waitFor(sb, `__msgs.slice(${mark}).find((m) => m.type === ${JSON.stringify(B2C.PREFILL)} || m.type === ${JSON.stringify(B2C.ERROR)})`, 10000);
      console.log(`repair → ${prefill ? prefill.type : "nothing"}:\n${indent(prefill ? prefill.text || prefill.message : "", "  ")}`);
      const pText = (prefill && prefill.text) || "";
      check(
        !!prefill && prefill.type === B2C.PREFILL && prefill.enableScript && prefill.enablePage && expectStale.every((id) => pText.includes(`${id} (`) && pText.includes(seeded.rules.find((r) => r.id === id).selector)) && /keep the ids/.test(pText),
        "the repair request names the stale rules, their selectors and what they did",
      );
      const composer = await waitFor(sb, `(() => { const i = document.getElementById("input"); return i.value === ${JSON.stringify(pText)} && document.getElementById("include-page").checked && document.getElementById("script-mode").checked && document.getElementById("script").hidden; })()`, 5000);
      check(!!pText && composer, "…written into the sidebar's composer (not sent), Use page + Script on, the panel closed");
      all = await store(["userScriptDraft"]);
      const rows = await waitFor(sb, `(() => { const ids = [...document.querySelectorAll("#script-rules .sc-rule.stale .sc-id")].map((e) => e.textContent).sort(); return ids.length ? ids : null; })()`, 5000);
      check(!!all.userScriptDraft && all.userScriptDraft.scriptId === seeded.id && JSON.stringify(rows) === JSON.stringify(expectStale), `the stale script is loaded into the draft, its stale rule rows marked (${rows ? rows.join(", ") : "none"})`);
      if (!pText) return 1;

      // 5. The user sends it; then asks to save.
      for (const t of [{ text: pText, approve: "no" }, { text: "Save it.", approve: "yes" }]) {
        await runTurn(t, 3);
        if (state.gpuHold) return holdExit();
      }

      // 6. The outcome: same ids, the broken ones changed, every rule matching on the redesign.
      all = await store(["userScripts", "userScriptDraft", "userScriptHealth"]);
      console.log("\n══ outcome ══");
      if (state.fallbacks.size) console.log(`NOTE: some calls were answered by lmgw fallback alias(es): ${[...state.fallbacks].join(", ")} — not ${model}`);
      if (state.httpErrors.length) console.log(`gateway errors:\n${state.httpErrors.map((e) => "  " + e).join("\n")}`);
      const after = (all.userScripts || {})[seeded.id];
      const draft = all.userScriptDraft;
      const script = draft && draft.rules && draft.rules.length ? { ...draft, kind: "unsaved draft" } : after ? { ...after, kind: "saved script" } : null;
      if (!script) {
        console.log("the script is gone — nothing to measure.");
        return 1;
      }
      console.log(`rules (${script.kind} "${script.name}"):`);
      for (const r of script.rules) console.log(`  ${fmtRule(r)}`);
      const ids = (x) => x.rules.map((r) => r.id).sort().join(",");
      check(ids(script) === ids(seeded), `rule ids kept — updated, not added (${script.rules.map((r) => r.id).join(", ")})`);
      const changed = expectStale.filter((id) => (script.rules.find((r) => r.id === id) || {}).selector !== seeded.rules.find((r) => r.id === id).selector);
      check(changed.length === expectStale.length, `every stale rule got a new selector (${changed.join(", ") || "none"})`);
      check(saved && !draft && script.kind === "saved script", "the repaired script was saved");
      check(!(all.userScriptHealth || {})[seeded.id] || !expectStale.some((id) => trailing(all.userScriptHealth[seeded.id], id)), "saving reset the script's health");
      const fresh = await measure("fresh load (renamed hooks)", renamed, script);
      check(!fresh.zero.length && fresh.inEffect === script.rules.length, `every rule matches and is in effect on ?rename=1 (${fresh.inEffect}/${script.rules.length}${fresh.zero.length ? `; 0 matches: ${fresh.zero.join(", ")}` : ""})`);
      // That load is a visit too: once checked, the warning must be gone.
      let ok = false;
      for (let t0 = Date.now(); Date.now() - t0 < 20000 && !ok; await sleep(250)) {
        const rec = ((await store(["userScriptHealth"])).userScriptHealth || {})[seeded.id];
        ok = !!rec && script.rules.every((r) => rec.rules[r.id] && rec.rules[r.id].visits.length && rec.rules[r.id].visits.at(-1).ok);
      }
      const title2 = await evalIn(sb, `browser.pageAction.getTitle({ tabId: ${feedTab} })`);
      check(ok && !title2.startsWith("⚠"), `after the repair, a visit finds every rule and the page action is back to normal ("${title2.split("\n")[0]}")`);
      const stale = await staleAcrossScrolls("repaired script after a deploy (?rename=1&deploy=2 re-hashes every class)", renamed + "&deploy=2", script);
      check(!stale.size, `every rule matches on ?rename=1&deploy=2 at load and after 2 scrolls${stale.size ? ` (0 matches: ${[...stale].join(", ")})` : ""}`);
      return exit;
    }

    for (let ti = 0; ti < turns.length; ti++) {
      await runTurn(turns[ti], turns.length);
      if (state.gpuHold) break;
    }

    if (state.gpuHold) return holdExit();

    // --- outcome ---
    const st = await store(["userScripts", "userScriptDraft"]);
    const savedScripts = Object.values(st.userScripts || {}).sort((a, b) => b.updated - a.updated);
    const draft = st.userScriptDraft || null;
    const script = draft && draft.rules && draft.rules.length ? { ...draft, kind: "unsaved draft" } : savedScripts[0] ? { ...savedScripts[0], kind: "saved script" } : null;
    console.log("\n══ outcome ══");
    if (state.fallbacks.size) console.log(`NOTE: some calls were answered by lmgw fallback alias(es): ${[...state.fallbacks].join(", ")} — not ${model}`);
    if (state.httpErrors.length) console.log(`gateway errors:\n${state.httpErrors.map((e) => "  " + e).join("\n")}`);
    if (savedScripts.length) console.log(`saved: ${savedScripts.map((s) => `"${s.name}" (${s.rules.length} rules, ${s.matches.join(" ")})`).join(", ")}`);
    if (draft) console.log(`draft: "${draft.name}" — ${draft.rules.length} rule(s)${draft.dirty ? ", unsaved changes" : ""}`);
    if (unaskedSaves) console.log(`WARN: the model asked to save ${unaskedSaves}× in turns where the user had not asked for it (declined).`);
    const rules = script ? script.rules : [];
    check(rules.length > 0, `the script has rules (${rules.length})`);
    if (!script) {
      console.log("no rules were added — nothing to measure.");
      return 1;
    }
    console.log(`rules (${script.kind} "${script.name}", ${(script.matches || []).join(" ")}, target ${script.target || "video"}):`);
    for (const r of rules) console.log(`  ${fmtRule(r)}`);

    const fresh = await measure("fresh load", url, script);
    if (saved) check(savedScripts.length > 0 && !draft && fresh.inEffect === rules.length && fresh.ov.coverage < before.coverage, `the saved script applies after a fresh load (${fresh.inEffect}/${rules.length} rules in effect, coverage ${pct(before.coverage)} → ${pct(fresh.ov.coverage)})`);
    else console.log(`  (not saved in this run — the ${script.kind} applies because this is its tab)`);

    if (redeployUrl) {
      const stale = await staleAcrossScrolls("redeploy (every class name re-hashed)", redeployUrl, script);
      check(!stale.size, `every rule matches on the redeployed page at load and after 2 scrolls${stale.size ? ` (0 matches: ${[...stale].join(", ")})` : ""}`);
    }
  } finally {
    flush(true);
    if (exit !== 3) {
      console.log("\n══ checks ══");
      for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.what}`);
      const totals = log.turns.map((t) => `turn ${t.turn} ${secs(t.wallMs)}`).join(" · ");
      console.log(`  time: ${totals}${totals ? " · " : ""}total ${secs(Date.now() - t00)}`);
      exit = checks.length && checks.every((c) => c.ok) ? 0 : 1;
    }
    if (logFile) await writeFile(logFile, JSON.stringify(log, null, 1));
    await ff.close();
    proxy.server.close();
    if (mock && mock.proc) mock.proc.kill();
    process.exitCode = exit;
  }
  return exit;
}

main().then(
  () => process.exit(process.exitCode),
  (e) => {
    flush(true);
    console.error(e);
    process.exit(1);
  }
);

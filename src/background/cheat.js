// Cheat Lab — background orchestrator.
//
// Two jobs:
//   1. Toggle the in-page HUD (content/cheat-hud.js) on a command / context-menu click. The
//      toolbar button is taken by AI dark mode, so the HUD has its own command + menu item.
//   2. Drive the LLM "ask to cheat" loop. The HUD opens a PORT_CHEAT port and is BOTH the heap
//      executor and the renderer: this loop plans with the model, then runs each tool by sending
//      the HUD an OP and awaiting its OP_RESULT (op-RPC). So the wrappedJSObject engine lives only
//      in the HUD; the background never touches the page heap directly.
//
// This mirrors background/agent.js's tool loop (chatWithTools → run tool → feed result back), but
// the "tools" reach the game's live JS state instead of the DOM. `freeze`/`unfreeze` are the first
// PERSISTENT cheats — the HUD re-asserts a value every tick so the game can't change it (money that
// never drops as you buy). Per-origin trainer-spec caching and the page-world tier (auto-buy /
// speedhack, which need injected code) are the next increments.

import { PORT_CHEAT, CHEAT } from "../common/messages.js";
import { CHEAT_SYSTEM_PROMPT } from "../common/prompts.js";
import { chatWithTools, chatOnce } from "./gateway.js";

const HUD_FILE = "/content/cheat-hud.js";
const MENU_ID = "rsd-cheat-hud";
const COMMAND = "toggle-cheat-hud";
const MAX_STEPS = 24; // surfaced to the user when hit — never a silent truncation
const MAX_STALLS = 3; // consecutive reasoning-only (no tool call) turns we nudge before giving up

let getConfig = () => ({ gatewayUrl: "", gatewayKey: "", model: null });
let notifyError = () => {};

// ---- tool schema (OpenAI function-calling shape, like agent.js) ------------
function fn(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, ...(required ? { required } : {}) } } };
}
const TOOLS = [
  fn("scan", "List JavaScript state on the page. With no path: the top-level page globals, most-populated first (the game's state object is usually among the largest). With a path: the keys of that one object, so you can drill in (e.g. scan 'Game', then scan 'Game.Objects').", { path: { type: "string" } }),
  fn("read", "Read the exact current value at a dotted path, e.g. 'Game.cookies' or 'player.resources[0].amount'.", { path: { type: "string" } }, ["path"]),
  fn("set", "Write a value at a dotted path. Pass value as a JSON literal: 1e12, true, \"text\", [1,2].", { path: { type: "string" }, value: { type: "string" } }, ["path", "value"]),
  fn("call", "Call a function the game exposes, e.g. a method that grants resources (addCandies, buyUpgrade, give). Use this when the thing you want is produced by a FUNCTION rather than stored in a writable field — scan shows functions as ƒ(). path is the dotted path to the function; the function is invoked on its owning object so `this` binds correctly (call 'Game.addCandies', not the bare name, when it lives under Game). args is a JSON array of arguments, e.g. [50] or [\"gold\", 100] — omit it or pass [] for none. If the call returns an object (e.g. a getState()/getGame() accessor), it is parked at a `$ret` path you can then scan/read/set into. After calling, read the value you were targeting to confirm it moved.", { path: { type: "string" }, args: { type: "string" } }, ["path"]),
  fn("storage", "Inspect the page's localStorage — where many games persist their save (resource counts, flags, slots). With NO key: lists every stored key with a value preview, so you can spot the save (keys often look like 'gameCandiesCurrent', 'save', 'playerGold', 'slot1.…'). With a key: returns that key's exact stored value. Crucial when the live state is closure-bound and the globals scan finds nothing — state hidden from `window` is usually still SAVED here.", { key: { type: "string" } }),
  fn("storageSet", "Write a value into the page's localStorage at a key (use the exact key names from `storage`). localStorage values are TEXT — a number like 1000000000 is stored as its string. This edits the SAVE, not the live game, so it usually only takes effect after the page reloads and the game re-reads its save: end by telling the user to reload.", { key: { type: "string" }, value: { type: "string" } }, ["key", "value"]),
  fn("watch", "Pin a path to the user's on-screen HUD so they see it update live.", { path: { type: "string" } }, ["path"]),
  fn("freeze", "Persistently pin a value: the HUD re-asserts it ~4×/second so the game can't change it — the idle-game staple for money that must not drop as you spend, or a multiplier kept high. Pass value as a JSON literal (1e12, true) to pin a specific number, or omit it to pin the current value. Only works on a single number/text/boolean, not an object, and only on a value the game STORES (one it recomputes each frame is overwritten back).", { path: { type: "string" }, value: { type: "string" } }, ["path"]),
  fn("unfreeze", "Stop persistently pinning a value previously frozen.", { path: { type: "string" } }, ["path"]),
  fn("done", "Call this to FINISH — it is the ONLY way to end the task. Use it the moment the goal is achieved (value set and confirmed with a read) or if you genuinely cannot proceed. Pass a short summary for the user: what you changed (each path → new value) and any next step (e.g. \"reload the page\"). Do not keep re-reading once a value is confirmed — set, confirm, then done.", { summary: { type: "string" } }, ["summary"]),
];

// ---- HUD toggle ------------------------------------------------------------
async function toggleHud(tab) {
  if (!tab || !/^https?:/.test(tab.url || "")) {
    notifyError("Cheat HUD only runs on normal web pages.", (tab && tab.url) || "");
    return;
  }
  try {
    await browser.tabs.executeScript(tab.id, { file: HUD_FILE });
  } catch (e) {
    notifyError("Couldn't open the Cheat HUD on this page.", (e && e.message) || "");
  }
}
async function activeTab() {
  try { return (await browser.tabs.query({ active: true, currentWindow: true }))[0]; }
  catch { return null; }
}

// ---- per-HUD session + op-RPC ----------------------------------------------
// One session per connected HUD (one per tab). `pending` resolves OP requests when the HUD replies.
function attachSession(port) {
  const session = { port, seq: 0, pending: new Map(), controller: null, busy: false };
  port.onMessage.addListener((msg) => onMessage(session, msg));
  port.onDisconnect.addListener(() => {
    if (session.controller) session.controller.abort();
    for (const p of session.pending.values()) p.reject(new Error("HUD closed"));
    session.pending.clear();
  });
}

function op(session, name, extra) {
  return new Promise((resolve, reject) => {
    const id = ++session.seq;
    session.pending.set(id, { resolve, reject });
    try { session.port.postMessage({ type: CHEAT.OP, id, op: name, ...extra }); }
    catch (e) { session.pending.delete(id); reject(e); }
  });
}

function onMessage(session, msg) {
  switch (msg.type) {
    case CHEAT.OP_RESULT: {
      const p = session.pending.get(msg.id);
      if (!p) return;
      session.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || "op failed"));
      break;
    }
    case CHEAT.RUN:
      runCheat(session, msg.goal);
      break;
    case CHEAT.CANCEL:
      if (session.controller) session.controller.abort();
      break;
  }
}

function step(session, kind, text) {
  try { session.port.postMessage({ type: CHEAT.STEP, kind, text }); } catch { /* HUD gone */ }
}
function watch(session, path) {
  try { session.port.postMessage({ type: CHEAT.WATCH, path }); } catch { /* HUD gone */ }
}

// ---- the loop --------------------------------------------------------------
async function runCheat(session, goal) {
  if (session.busy) { step(session, "error", "A cheat task is already running — stop it first."); return; }
  if (!goal || !goal.trim()) return;
  const { gatewayUrl, gatewayKey, model } = getConfig();
  if (!model) { step(session, "error", "Pick a model in the sidebar first."); return; }

  session.busy = true;
  session.controller = new AbortController();
  try { session.port.postMessage({ type: CHEAT.BUSY, active: true }); } catch { /* gone */ }

  const messages = [
    { role: "system", content: CHEAT_SYSTEM_PROMPT },
    { role: "user", content: goal.trim() },
  ];

  let stalls = 0;
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      // tool_choice "required" forces every turn to BE a tool call (an action, or `done` to finish),
      // so weak local models can't narrate a plan and stop. Completion is the explicit `done` tool.
      const reply = await chatWithTools({ gatewayUrl, gatewayKey, model, messages, tools: TOOLS, signal: session.controller.signal, toolChoice: "required" });

      // Gemma/LFM2.5 via llama.cpp put prose in EITHER `content` or `reasoning_content`, and they
      // narrate plans in both — so "no tool call" can't be read as "done". Completion is an explicit
      // `done` tool call; every other no-tool-call turn is a stall (the model described an action
      // instead of performing it) and gets nudged.
      const content = (reply.content || "").trim();
      const reasoning = (reply.reasoning || "").trim();

      const doneCall = reply.toolCalls.find((tc) => tc.function && tc.function.name === "done");
      if (doneCall) {
        let summary = "";
        try { summary = String(JSON.parse(doneCall.function.arguments || "{}").summary || "").trim(); } catch { /* keep empty */ }
        finish(session, summary || content || reasoning || "Done.");
        return;
      }

      if (!reply.toolCalls.length) {
        if (content || reasoning) step(session, "think", content || reasoning); // show the plan
        if (stalls < MAX_STALLS) {
          stalls++;
          messages.push({ role: "assistant", content: content || reasoning || "" });
          messages.push({ role: "user", content: "You didn't call a tool. Perform the next action by calling a tool now — or, if the task is fully done, call `done` with a short summary. Don't just describe what you'll do; do it." });
          continue;
        }
        finish(session, content || reasoning || "(the model returned no answer)");
        return;
      }

      stalls = 0; // a tool call = real progress
      if (content || reasoning) step(session, "think", content || reasoning);
      // Echo only the real content (not reasoning) back, to avoid bloating context every turn.
      messages.push({ role: "assistant", content: reply.content || "", tool_calls: reply.toolCalls });
      for (const tc of reply.toolCalls) {
        const result = await execTool(session, tc.function && tc.function.name, tc.function && tc.function.arguments);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    step(session, "note", `Reached the ${MAX_STEPS}-step limit — summarizing what I changed.`);
    messages.push({ role: "user", content: "Stop using tools now and tell me exactly what you changed (each path → new value)." });
    finish(session, (await chatOnce({ gatewayUrl, gatewayKey, model, messages, signal: session.controller.signal })) || "(no answer after the step limit)");
  } catch (e) {
    if (e && e.name === "AbortError") step(session, "note", "Stopped.");
    else step(session, "error", (e && e.message) || "Cheat task failed");
  } finally {
    session.busy = false;
    session.controller = null;
    try { session.port.postMessage({ type: CHEAT.BUSY, active: false }); } catch { /* gone */ }
  }
}

function finish(session, text) {
  try { session.port.postMessage({ type: CHEAT.DONE, text }); } catch { /* gone */ }
}

// Run one tool call; return the string fed back to the model as the tool result.
async function execTool(session, name, argsRaw) {
  let a = {};
  try { a = argsRaw ? JSON.parse(argsRaw) : {}; } catch { return "Error: tool arguments were not valid JSON."; }

  try {
    if (name === "scan") {
      step(session, "act", a.path ? `scan ${a.path}` : "scan globals");
      const r = await op(session, "scan", { path: a.path || null });
      return formatScan(r);
    }
    if (name === "read") {
      if (!a.path) return "Error: read needs a path.";
      step(session, "act", `read ${a.path}`);
      return formatRead(await op(session, "read", { path: a.path }));
    }
    if (name === "set") {
      if (!a.path) return "Error: set needs a path.";
      let value = a.value;
      if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* keep as string */ } }
      step(session, "act", `set ${a.path} = ${clip(JSON.stringify(value), 60)}`);
      const r = await op(session, "set", { path: a.path, value });
      if (r && r.error) return "Error: " + r.error;
      watch(session, a.path);
      return `OK: ${a.path} is now ${r.after} (was ${r.before}).`;
    }
    if (name === "call") {
      if (!a.path) return "Error: call needs a path.";
      let args = a.args;
      if (typeof args === "string") {
        const t = args.trim();
        try { args = t ? JSON.parse(t) : []; } catch { return "Error: call args must be a JSON array literal, e.g. [50] or [\"gold\",100]."; }
      }
      if (args == null) args = [];
      if (!Array.isArray(args)) args = [args];
      step(session, "act", `call ${a.path}(${args.map((x) => clip(JSON.stringify(x), 20)).join(", ")})`);
      const r = await op(session, "call", { path: a.path, args });
      if (r && r.error) return "Error: " + r.error;
      if (r.stashed) {
        const keys = r.keys && r.keys.length ? ` Keys: ${r.keys.join(", ")}${r.keysTotal > r.keys.length ? ` …(+${r.keysTotal - r.keys.length})` : ""}.` : "";
        return `OK: called ${a.path}(…) → returned a ${r.type}, parked at ${r.stashed} (and ${"$ret"}.last). Drill in with scan '${r.stashed}', read '${r.stashed}.<key>', or set '${r.stashed}.<key>' to cheat a field on it.${keys}`;
      }
      const ret = r.type === "undefined" ? "no value" : `${JSON.stringify(r.result)} (${r.type})`;
      return `OK: called ${a.path}(…) → returned ${ret}. Now read the field you were targeting to confirm it changed.`;
    }
    if (name === "storage") {
      step(session, "act", a.key ? `storage get ${a.key}` : "storage list");
      const r = await op(session, "storage", { key: a.key || null });
      return formatStorage(r);
    }
    if (name === "storageSet") {
      if (!a.key) return "Error: storageSet needs a key.";
      const text = String(a.value == null ? "" : a.value);
      step(session, "act", `storageSet ${a.key} = ${clip(text, 60)}`);
      const r = await op(session, "storageSet", { key: a.key, value: text });
      if (r && r.error) return "Error: " + r.error;
      const was = r.before === null || r.before === undefined ? "unset" : JSON.stringify(clip(r.before, 40));
      return `OK: localStorage["${a.key}"] = ${JSON.stringify(clip(r.after, 80))} (was ${was}). Tell the user to RELOAD the page so the game loads it.`;
    }
    if (name === "watch") {
      if (!a.path) return "Error: watch needs a path.";
      step(session, "act", `watch ${a.path}`);
      watch(session, a.path);
      return `OK: watching ${a.path} on the HUD.`;
    }
    if (name === "freeze") {
      if (!a.path) return "Error: freeze needs a path.";
      const hasValue = a.value != null && String(a.value).trim() !== "";
      let value = a.value;
      if (hasValue && typeof value === "string") { try { value = JSON.parse(value); } catch { /* keep as string */ } }
      step(session, "act", hasValue ? `freeze ${a.path} = ${clip(JSON.stringify(value), 40)}` : `freeze ${a.path}`);
      const r = await op(session, "freeze", hasValue ? { path: a.path, value } : { path: a.path });
      if (r && r.error) return "Error: " + r.error;
      return `OK: ${a.path} is frozen at ${JSON.stringify(r.value)} — re-asserted ~4×/second until you unfreeze it.`;
    }
    if (name === "unfreeze") {
      if (!a.path) return "Error: unfreeze needs a path.";
      step(session, "act", `unfreeze ${a.path}`);
      const r = await op(session, "unfreeze", { path: a.path });
      if (r && r.error) return "Error: " + r.error;
      return `OK: stopped freezing ${a.path}.`;
    }
    return "Error: unknown tool " + name;
  } catch (e) {
    return "Error: " + ((e && e.message) || "op failed");
  }
}

// ---- format op results for the model ---------------------------------------
function clip(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function rowLine(r) {
  return `${r.name}: ${r.type}${r.size ? "(" + r.size + ")" : ""} ${r.preview}`;
}
function formatScan(r) {
  if (!r || r.error) return "Error: " + ((r && r.error) || "scan failed");
  if (r.kind === "leaf") return `${r.path} = ${JSON.stringify(r.value)} (${r.type}) — not an object, nothing to drill into.`;
  const header = r.kind === "object" ? `Keys of ${r.path} (${r.type})` : "Top-level page globals";
  const shown = r.rows.length;
  const more = r.total > shown ? `, showing ${shown} of ${r.total} most-populated` : `, ${shown} total`;
  return `${header}${more}:\n` + r.rows.map(rowLine).join("\n");
}
function formatRead(r) {
  if (!r || r.error) return "Error: " + ((r && r.error) || "read failed");
  if (Object.prototype.hasOwnProperty.call(r, "value")) return `${r.path} = ${JSON.stringify(r.value)} (${r.type})`;
  const keys = r.keys && r.keys.length ? ` keys: ${r.keys.join(", ")}${r.keysTotal > r.keys.length ? ` …(+${r.keysTotal - r.keys.length})` : ""}` : "";
  return `${r.path} is ${r.type} ${r.preview} —${keys || " (no enumerable keys)"}. Use scan '${r.path}' to drill in or read a child path.`;
}
function formatStorage(r) {
  if (!r || r.error) return "Error: " + ((r && r.error) || "storage failed");
  if (r.kind === "value") return r.value === null ? `localStorage["${r.key}"] is not set.` : `localStorage["${r.key}"] = ${JSON.stringify(r.value)}`;
  if (!r.rows.length) return "localStorage is empty on this page.";
  const more = r.total > r.rows.length ? `, showing ${r.rows.length} of ${r.total}` : `, ${r.rows.length} total`;
  return `localStorage keys${more}:\n` + r.rows.map((x) => `${x.key} = ${x.preview}`).join("\n");
}

// ---- init ------------------------------------------------------------------
export function initCheat({ getConfig: gc, onError } = {}) {
  if (typeof gc === "function") getConfig = gc;
  if (typeof onError === "function") notifyError = onError;

  browser.commands.onCommand.addListener(async (name) => {
    if (name === COMMAND) toggleHud(await activeTab());
  });

  browser.menus.create({ id: MENU_ID, title: "Cheat HUD (toggle)", contexts: ["page"] });
  browser.menus.onClicked.addListener((info, tab) => {
    if (String(info.menuItemId) === MENU_ID) toggleHud(tab);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_CHEAT) attachSession(port);
  });
}

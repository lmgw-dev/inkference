// Background orchestrator — the single source of truth.
//
// Owns: prefs, the normalized model cache, the active conversation, and the streaming /
// abort loop. Sidebars are stateless views: they connect a port, say HELLO, and get a
// full snapshot; thereafter we broadcast deltas. Because we append streamed text straight
// into the conversation object, a sidebar that reloads mid-stream re-hydrates from the
// snapshot (which carries the partial assistant message + a `streaming` flag) and keeps
// receiving deltas — no lost responses.

import { PORT_SIDEBAR, C2B, B2C } from "../common/messages.js";
import { getPrefs, set, pushRecent } from "../common/storage.js";
import { estimateTokens, estimateMessagesTokens } from "../common/util.js";
import { cleanForSpeech } from "../common/speechtext.js";
import { normalizeModels, normalizeAudioModels, ttsModels, cloudPrefixes, findModel } from "./models.js";
import { fetchModels, streamChat, countTokens } from "./gateway.js";
import { registerMenus, setMenuSpeaking } from "./menus.js";
import { initDarkmode } from "./darkmode.js";
import { initCheat } from "./cheat.js";
import {
  initUserScripts, scriptState, pickElement, pickKey, editDraft, testDraft, saveDraft, discardDraft,
  loadScript, setScriptEnabled, deleteScript, repairScript,
} from "./userscripts.js";
import { createAgent } from "./agent.js";
import { createTts } from "./tts.js";
import { addPort, removePort, broadcast, hasPorts, setPortWindow, sendToWindow } from "./ports.js";

const SYNCED_PREF_KEYS = [
  "gatewayUrl",
  "gatewayKey", // a secret: synced into state.prefs for gateway calls, NEVER copied into snapshot()/port messages
  "defaultModel",
  "systemPrompt",
  "enabledCloudPrefixes",
  "recentModels",
  "ttsModel",
  "ttsVoice",
  "ttsSpeed",
  "ttsClean",
  "groundingModel",
  "startPage",
];

const state = {
  prefs: null,
  models: [],
  audioModels: [],
  modelsError: null,
  conversation: { messages: [] },
  stream: null, // { controller, assistantIndex }
  busy: false,
  pendingControl: [], // one-shot control msgs queued while no sidebar is connected
  pendingOpen: new Set(), // windows whose page-action click asked for the Script panel before their sidebar connected
  pendingPrefill: new Map(), // windowId -> a repair request (B2C.PREFILL) waiting for that window's sidebar
};

// Page agent loop (read + computer-use over the DOM). Created in init; drives the active tab.
let agent = null;

// Read aloud: owns the speech queue + the <audio> element that lives in this page.
let tts = null;

// Init is async (prefs, model cache), but a sidebar that Firefox restores at browser startup
// can connect BEFORE it finishes — and a connect that finds no onConnect listener is dropped
// on the spot, leaving that sidebar mute forever (the "empty model picker until you hide and
// re-show the sidebar" bug). So the listener is registered synchronously at module load, and
// port messages simply wait on `ready` before they're handled.
let markReady;
const ready = new Promise((resolve) => (markReady = resolve));

// The port name alone is not proof of a sidebar: any content script of this extension can
// runtime.connect with any name, and Script mode runs LLM-written code as content scripts on
// sites the model has read. A port that drives the agent must come from the sidebar page.
const SIDEBAR_URL = browser.runtime.getURL("sidebar/");

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_SIDEBAR) return;
  if (!port.sender?.url?.startsWith(SIDEBAR_URL)) {
    port.disconnect();
    return;
  }
  addPort(port);
  port.onMessage.addListener(async (msg) => {
    await ready;
    handleMessage(msg, port);
  });
  port.onDisconnect.addListener(() => removePort(port));
});

// A page-grounded turn: the user's message is carried out against the current tab. The agent
// reads (read_page) and/or acts (observe/click/…), then its final prose is committed as a
// normal assistant message. The page never goes in as a system message, so this also sidesteps
// the Gemma "system role not supported" 502 the old include-page path hit.
async function runPageTurn(msg) {
  if (state.busy) {
    notify({ type: B2C.ERROR, message: "Busy — stop the current task first.", detail: "" });
    return;
  }
  const model = msg.model || state.prefs.defaultModel;
  if (!model) {
    notify({ type: B2C.ERROR, message: "Pick a model first.", detail: "" });
    return;
  }

  // Snapshot prior turns (user/assistant) before we add this one — that's the agent's history.
  const history = state.conversation.messages.map((m) => ({ role: m.role, content: m.content }));
  const userMsg = { role: "user", content: msg.text };
  state.conversation.messages.push(userMsg);
  broadcast({ type: B2C.USER_MSG, message: userMsg });
  await persist();

  state.prefs.recentModels = pushRecent(state.prefs.recentModels, model);
  await set({ recentModels: state.prefs.recentModels });

  setBusy(true);
  let answer = null;
  let err = null;
  let aborted = false;
  try {
    answer = await agent.run({
      userText: msg.text, history, windowId: msg.windowId, allowNav: !!msg.allowNav, scriptMode: !!msg.scriptMode,
    });
  } catch (e) {
    if (e && e.name === "AbortError") aborted = true;
    else err = e;
  }

  // The agent's final prose becomes a real assistant turn. The decision turns are non-streaming
  // (gateway.js avoids streamed tool-call reassembly for weak local models), so we deliver the
  // answer as one delta into a normal assistant bubble.
  if (answer != null) {
    const assistant = { role: "assistant", content: answer };
    state.conversation.messages.push(assistant);
    broadcast({ type: B2C.MSG_START });
    broadcast({ type: B2C.DELTA, text: answer });
    broadcast({ type: B2C.MSG_END, finishReason: "stop", usage: null });
  } else if (aborted) {
    broadcast({ type: B2C.AGENT_STEP, kind: "done", text: "Stopped." });
  } else if (err) {
    broadcast({ type: B2C.ERROR, message: err.message || "Page task failed", detail: (err && err.detail) || "" });
  }
  // answer==null with no err/abort means the agent already emitted an error step (no model,
  // un-drivable tab) — nothing more to say.

  setBusy(false);
  await persist();
}

// ---- snapshot / notify -----------------------------------------------------

function snapshot() {
  return {
    type: B2C.STATE,
    prefs: {
      gatewayUrl: state.prefs.gatewayUrl,
      defaultModel: state.prefs.defaultModel,
      systemPrompt: state.prefs.systemPrompt,
      enabledCloudPrefixes: state.prefs.enabledCloudPrefixes,
      recentModels: state.prefs.recentModels,
    },
    models: state.models,
    prefixes: cloudPrefixes(state.models),
    modelsError: state.modelsError,
    conversation: state.conversation,
    busy: state.busy,
    streaming: !!state.stream,
    // Read aloud: the panel needs the voice list and the saved settings to render itself.
    ttsModels: ttsModels(state.audioModels),
    tts: {
      model: state.prefs.ttsModel,
      voice: state.prefs.ttsVoice,
      speed: state.prefs.ttsSpeed,
      clean: state.prefs.ttsClean,
      // Playback state and the measured synthesis rates, so a sidebar opened mid-read shows
      // the running clock instead of an idle panel.
      ...(tts ? tts.getState() : { speaking: false }),
    },
    // Script mode: the draft, the scripts saved for the active tab, the last test — so a
    // reloaded sidebar re-renders the Script panel exactly as it was.
    script: scriptState(),
  };
}

// Deliver a one-shot control message; queue it if no sidebar is listening yet so the
// next sidebar to connect still sees it (e.g. a menu action that opened the sidebar).
function notify(msg) {
  if (hasPorts()) broadcast(msg);
  else state.pendingControl.push(msg);
}

// The page-action icon opens the Script panel in ITS window only. The same click opens that
// window's sidebar, which may not have connected yet — then the request waits for its HELLO
// (another window's connected sidebar must neither take it nor swallow it).
function openScriptPanel(windowId) {
  const msg = { type: B2C.SCRIPT_OPEN, windowId };
  if (windowId == null) notify(msg);
  else if (!sendToWindow(windowId, msg)) state.pendingOpen.add(windowId);
}

// A script repair writes its request into ONE window's composer — the one whose page-action icon
// or panel button started it. Same wait as above when that sidebar is still opening.
function prefillWindow(windowId, text) {
  const msg = { type: B2C.PREFILL, windowId, text, enablePage: true, enableScript: true };
  if (windowId == null) notify(msg);
  else if (!sendToWindow(windowId, msg)) state.pendingPrefill.set(windowId, msg);
}

function setBusy(active) {
  state.busy = active;
  broadcast({ type: B2C.BUSY, active });
}

async function persist() {
  await set({ conversation: state.conversation });
}

// ---- models ----------------------------------------------------------------

async function loadModels() {
  try {
    const raw = await fetchModels({ gatewayUrl: state.prefs.gatewayUrl, gatewayKey: state.prefs.gatewayKey });
    state.models = normalizeModels(raw);
    state.audioModels = normalizeAudioModels(raw);
    state.modelsError = null;
    await set({
      modelCache: { fetchedAt: Date.now(), models: state.models },
      audioModelCache: { fetchedAt: Date.now(), models: state.audioModels },
    });
  } catch (e) {
    state.modelsError = e.message || "Failed to load models";
  }
  broadcast({ type: B2C.MODELS, models: state.models, prefixes: cloudPrefixes(state.models), error: state.modelsError });

  // First run: default to the first local model so the picker isn't empty.
  if (!state.prefs.defaultModel && state.models.length) {
    const first = state.models.find((m) => m.kind === "local") || state.models[0];
    state.prefs.defaultModel = first.id;
    await set({ defaultModel: first.id });
    broadcast(snapshot());
  }
  // Likewise for Read aloud — first TTS model the gateway offers, changeable in options.
  if (!state.prefs.ttsModel) {
    const voice = ttsModels(state.audioModels)[0];
    if (voice) {
      state.prefs.ttsModel = voice.id;
      await set({ ttsModel: voice.id });
    }
  }
}

// ---- read aloud ------------------------------------------------------------

// Speech is driven from the page, not the sidebar, so a failure has to be visible even with
// no sidebar open — otherwise notify() would queue the error and surface it minutes later,
// out of context. Prefer the sidebar when one is connected, else a desktop notification.
function reportTts(message, detail) {
  if (hasPorts()) {
    broadcast({ type: B2C.ERROR, message, detail: detail || "" });
    return;
  }
  desktopNote(message, detail);
}

function desktopNote(message, detail) {
  browser.notifications
    .create({
      type: "basic",
      title: "Inkference — read aloud",
      message: detail ? `${message}\n${detail}` : message,
      iconUrl: browser.runtime.getURL("icons/icon-96.png"),
    })
    .catch(() => {
      /* notifications unavailable — nothing left to surface it on */
    });
}

// A read is one request for the whole selection, so a long one is a long silence before the
// first word. The reader panel shows that as a clock — but the menu action works with no
// sidebar open at all, where an unannounced half-minute of nothing reads as "it didn't work".
// So say it once, when the estimate is long enough to be mistaken for a failure.
const QUIET_WAIT_SECONDS = 20;
let ttsPhase = "idle";

function onTtsState(s) {
  setMenuSpeaking(s.speaking);
  broadcast({ type: B2C.TTS_STATE, ...s });
  const started = s.phase === "synthesizing" && ttsPhase !== "synthesizing";
  ttsPhase = s.phase;
  if (started && !hasPorts() && s.total >= QUIET_WAIT_SECONDS) {
    desktopNote(`Synthesizing — about ${Math.round(s.total)}s until it starts speaking.`);
  }
}

// The menus API hands over a shortened, whitespace-collapsed copy of the selection (Gecko
// trims it to ~150 chars for menu labels), so read the live selection out of the frame that
// was right-clicked and keep info.selectionText only as a fallback for pages we can't inject
// into (about:, view-source, the PDF viewer).
async function selectionText(info, tab) {
  if (tab && tab.id != null && /^https?:/.test(tab.url || "")) {
    try {
      const details = { code: "String(window.getSelection ? window.getSelection() : '')" };
      if (info.frameId != null) details.frameId = info.frameId;
      const results = await browser.tabs.executeScript(tab.id, details);
      const text = ((results && results[0]) || "").trim();
      if (text) return text;
    } catch {
      /* not injectable — fall through to the menu's copy */
    }
  }
  return (info.selectionText || "").trim();
}

// kind: "read" speaks the selection straight away (cleaned with the saved rules); "panel"
// hands the RAW selection to the sidebar's reader, which cleans it live and lets the user
// adjust the rules, edit the text and pick a voice before playing.
async function handleTts(kind, info, tab) {
  if (kind === "stop") {
    tts.stop();
    return;
  }
  const raw = await selectionText(info, tab);
  if (!raw) {
    reportTts("Nothing selected to read.", "");
    return;
  }
  if (kind === "panel") {
    try {
      await browser.sidebarAction.open();
    } catch {
      /* not a user gesture / already open */
    }
    notify({ type: B2C.READER, text: raw, title: (tab && tab.title) || "" });
    return;
  }
  const text = cleanForSpeech(raw, state.prefs.ttsClean);
  if (!text) {
    reportTts("Nothing left to read after cleanup.", "Turn a cleanup rule off in the reader panel.");
    return;
  }
  tts.speak(text);
}

// ---- page extraction (on-demand Readability injection) ---------------------

// Inject Readability + extract.js into a known tab and return its cleaned article. Shared by
// the agent's read_page tool, the context-menu actions, and the Tokenize button.
async function extractFromTab(tabId) {
  try {
    await browser.tabs.executeScript(tabId, { file: "/vendor/readability.js" });
    const results = await browser.tabs.executeScript(tabId, { file: "/content/extract.js" });
    const r = results && results[0];
    if (!r || !r.ok) return { available: false, reason: (r && r.reason) || "no readable text" };
    return { available: true, title: r.title || "", text: r.text, mode: r.mode, count: r.count, length: r.text.length };
  } catch (e) {
    return { available: false, reason: "can't inject into this page (" + (e.message || "blocked") + ")" };
  }
}

// Extract the active tab in a window (resolves the tab, then delegates to extractFromTab).
async function extractPage(windowId) {
  let tab;
  try {
    const q = windowId != null ? { active: true, windowId } : { active: true, currentWindow: true };
    tab = (await browser.tabs.query(q))[0];
  } catch {
    /* ignore */
  }
  if (!tab) return { available: false, reason: "no active tab" };
  if (!/^https?:/.test(tab.url || "")) return { available: false, reason: "this page type can't be read" };
  const r = await extractFromTab(tab.id);
  if (!r.available) return r;
  return { ...r, url: tab.url, title: r.title || tab.title || "" };
}

// read_page tool backend: the agent already holds the target tab id, so extract that tab and
// attach its url for the model's grounding header.
async function readPageForAgent(tabId) {
  let url = "";
  try { url = (await browser.tabs.get(tabId)).url || ""; } catch { /* ignore */ }
  const r = await extractFromTab(tabId);
  return { ...r, url };
}

// ---- the turn --------------------------------------------------------------

async function runTurn({ userContent, display, model }) {
  if (state.busy) {
    notify({ type: B2C.ERROR, message: "Already generating — stop the current response first.", detail: "" });
    return;
  }
  if (!model) {
    notify({ type: B2C.ERROR, message: "Pick a model first.", detail: "" });
    return;
  }

  // Build the prospective request (system + history + new user turn).
  const messages = [{ role: "system", content: state.prefs.systemPrompt }];
  for (const m of state.conversation.messages) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: userContent });

  // Budget gate — surface, never silently truncate.
  const info = findModel(state.models, model);
  const ctx = info && info.contextLength;
  const estimated = estimateMessagesTokens(messages);
  if (ctx && estimated > ctx) {
    notify({
      type: B2C.OVER_BUDGET,
      estimated,
      contextLength: ctx,
      model,
      breakdown: {
        system: estimateTokens(state.prefs.systemPrompt),
        history: estimateMessagesTokens(state.conversation.messages),
        draft: estimateTokens(userContent),
      },
    });
    return;
  }

  // Commit the user turn + an empty assistant turn we stream into.
  const userMsg = { role: "user", content: userContent };
  if (display) userMsg.display = display;
  state.conversation.messages.push(userMsg);
  broadcast({ type: B2C.USER_MSG, message: userMsg });

  const assistant = { role: "assistant", content: "", incomplete: true };
  state.conversation.messages.push(assistant);
  await persist();

  setBusy(true);
  broadcast({ type: B2C.MSG_START });
  const controller = new AbortController();
  state.stream = { controller };

  state.prefs.recentModels = pushRecent(state.prefs.recentModels, model);
  await set({ recentModels: state.prefs.recentModels });

  try {
    const { finishReason, usage } = await streamChat({
      gatewayUrl: state.prefs.gatewayUrl,
      gatewayKey: state.prefs.gatewayKey,
      model,
      messages,
      signal: controller.signal,
      onDelta: (t) => {
        assistant.content += t;
        broadcast({ type: B2C.DELTA, text: t });
      },
    });
    assistant.finishReason = finishReason;
    broadcast({ type: B2C.MSG_END, finishReason, usage });
  } catch (e) {
    if (e && e.name === "AbortError") {
      assistant.finishReason = "cancelled";
      broadcast({ type: B2C.MSG_END, finishReason: "cancelled", usage: null });
    } else {
      assistant.error = e.message || "Request failed";
      broadcast({ type: B2C.ERROR, message: e.message || "Request failed", detail: (e && e.detail) || "" });
      broadcast({ type: B2C.MSG_END, finishReason: "error", usage: null });
    }
  } finally {
    assistant.incomplete = false;
    state.stream = null;
    setBusy(false);
    await persist();
  }
}

// "Use page" routes to the page agent (read + act); plain chat is a normal streamed turn.
async function handleSend(msg) {
  if (msg.includePage) {
    await runPageTurn(msg);
    return;
  }
  await runTurn({ userContent: msg.text, display: null, model: msg.model || state.prefs.defaultModel });
}

// Exact page token count for the "Tokenize" button — extracts the current page and counts
// its body via the gateway tokenizer (not the ~4 chars/token estimate).
async function countPage(windowId, model) {
  const useModel = model || state.prefs.defaultModel;
  const page = await extractPage(windowId);
  if (!page.available) {
    notify({ type: B2C.PAGE_TOKENS, available: false, reason: page.reason || "unreadable", title: "" });
    return;
  }
  if (!useModel) {
    notify({ type: B2C.PAGE_TOKENS, available: false, reason: "pick a model first", title: page.title || "" });
    return;
  }
  try {
    const tokens = await countTokens({ gatewayUrl: state.prefs.gatewayUrl, gatewayKey: state.prefs.gatewayKey, model: useModel, input: page.text });
    const info = findModel(state.models, useModel);
    notify({ type: B2C.PAGE_TOKENS, available: true, tokens, title: page.title || "", contextLength: (info && info.contextLength) || null, model: useModel });
  } catch (e) {
    notify({ type: B2C.PAGE_TOKENS, available: false, reason: e.message || "token count failed", detail: (e && e.detail) || "", title: page.title || "" });
  }
}

async function handleMenuAction(action, info, tab) {
  try {
    await browser.sidebarAction.open();
  } catch {
    /* not a user gesture / already open */
  }
  const sel = info.selectionText && info.selectionText.trim();

  if (action.id === "custom") {
    // Prefill the input rather than sending: the user supplies the question.
    notify({ type: B2C.PREFILL, text: sel || null, enablePage: !sel });
    return;
  }

  let target = sel;
  let display;
  if (sel) {
    display = `${action.title}: “${excerpt(sel)}”`;
  } else {
    const page = await extractPage(tab && tab.windowId);
    if (!page.available) {
      notify({ type: B2C.ERROR, message: "Couldn't read the page: " + page.reason, detail: "" });
      return;
    }
    target = page.text;
    display = `${action.title} (page: ${page.title || page.url})`;
  }
  await runTurn({
    userContent: `${action.prompt}\n\n${target}`,
    display,
    model: state.prefs.defaultModel,
  });
}

function newChat() {
  if (state.stream) state.stream.controller.abort();
  state.conversation = { messages: [] };
  persist();
  broadcast(snapshot());
}

// ---- messaging -------------------------------------------------------------

function handleMessage(msg, port) {
  switch (msg.type) {
    case C2B.HELLO:
      setPortWindow(port, msg.windowId);
      port.postMessage(snapshot());
      // flush queued one-shot control messages to the freshly-connected sidebar
      for (const m of state.pendingControl) port.postMessage(m);
      state.pendingControl = [];
      if (state.pendingOpen.delete(msg.windowId)) port.postMessage({ type: B2C.SCRIPT_OPEN, windowId: msg.windowId });
      if (state.pendingPrefill.has(msg.windowId)) {
        port.postMessage(state.pendingPrefill.get(msg.windowId));
        state.pendingPrefill.delete(msg.windowId);
      }
      break;
    case C2B.SEND:
      handleSend(msg);
      break;
    case C2B.CANCEL:
      if (state.stream) state.stream.controller.abort();
      if (agent && agent.isBusy()) agent.cancel();
      break;
    case C2B.AGENT_CONFIRM:
      if (agent) agent.resolveConfirm(msg.id, !!msg.approved);
      break;
    case C2B.NEW_CHAT:
      newChat();
      break;
    case C2B.SET_MODEL:
      state.prefs.defaultModel = msg.model;
      set({ defaultModel: msg.model });
      break;
    case C2B.SET_PREFIXES:
      state.prefs.enabledCloudPrefixes = msg.prefixes;
      set({ enabledCloudPrefixes: msg.prefixes });
      break;
    case C2B.REFRESH_MODELS:
      loadModels();
      break;
    case C2B.COUNT_PAGE:
      countPage(msg.windowId, msg.model);
      break;
    case C2B.TTS_SPEAK:
      // Already cleaned (and possibly hand-edited) in the panel — speak it as given.
      tts.speak(msg.text || "");
      break;
    case C2B.TTS_STOP:
      tts.stop();
      break;
    case C2B.SET_TTS:
      for (const k of ["model", "voice", "speed", "clean"]) {
        if (msg[k] === undefined) continue;
        const pref = "tts" + k[0].toUpperCase() + k.slice(1);
        state.prefs[pref] = msg[k];
        set({ [pref]: msg[k] });
      }
      break;
    case C2B.SCRIPT_PICK:
      scriptAction(pickElement(msg.windowId));
      break;
    case C2B.SCRIPT_PICK_KEY:
      scriptAction(pickKey(msg.key));
      break;
    case C2B.SCRIPT_EDIT:
      scriptAction(editDraft(msg));
      break;
    case C2B.SCRIPT_TEST:
      // A test reloads the tab — not while the agent is driving it.
      if (agent && agent.isBusy()) {
        notify({ type: B2C.ERROR, message: "The agent is working on the page — wait for it or Stop it, then re-test.", detail: "" });
      } else {
        // A second Re-test while one runs gets testDraft's own "already running" in the banner.
        scriptAction(testDraft({ scrolls: msg.scrolls }).then(() => ({})));
      }
      break;
    case C2B.SCRIPT_SAVE:
      scriptAction(saveDraft({ name: msg.name, matches: msg.matches, allowBroad: !!msg.allowBroad }));
      break;
    case C2B.SCRIPT_DISCARD:
      scriptAction(discardDraft());
      break;
    case C2B.SCRIPT_LOAD:
      scriptAction(loadScript(msg.id, msg.windowId));
      break;
    case C2B.SCRIPT_SET_ENABLED:
      scriptAction(setScriptEnabled(msg.id, !!msg.enabled));
      break;
    case C2B.SCRIPT_DELETE:
      scriptAction(deleteScript(msg.id));
      break;
    case C2B.SCRIPT_REPAIR:
      scriptAction(repairScript(msg.id, msg.windowId));
      break;
  }
}

// Script panel actions resolve to {} or { error } — the error goes to the banner (and into the
// panel, which covers it). The agent's own script tools report through its tool results instead.
function scriptAction(p) {
  Promise.resolve(p)
    .then((r) => {
      if (r && r.error) notify({ type: B2C.ERROR, message: r.error, detail: "" });
    })
    .catch((e) => notify({ type: B2C.ERROR, message: (e && e.message) || "Script action failed", detail: "" }));
}

function excerpt(s, n = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ---- init ------------------------------------------------------------------

(async () => {
  state.prefs = await getPrefs();
  state.conversation = state.prefs.conversation || { messages: [] };
  state.models = (state.prefs.modelCache && state.prefs.modelCache.models) || [];
  state.audioModels = (state.prefs.audioModelCache && state.prefs.audioModelCache.models) || [];

  // Page agent — reads (read_page) and drives (observe/click/…) the active tab. Step notes
  // stream to the sidebar as they happen; the final prose is committed as an assistant turn
  // by runPageTurn, so a page Q&A lands in the conversation like any other reply.
  agent = createAgent({
    getConfig: () => ({
      gatewayUrl: state.prefs.gatewayUrl, gatewayKey: state.prefs.gatewayKey, model: state.prefs.defaultModel,
      groundingModel: state.prefs.groundingModel, startPage: state.prefs.startPage,
    }),
    emit: (s) => broadcast({ type: B2C.AGENT_STEP, ...s }),
    readPage: (tabId) => readPageForAgent(tabId),
    closeConfirm: (id, approved) => broadcast({ type: B2C.AGENT_CONFIRM_CLOSED, id, approved }),
  });

  // Read aloud — right-click a selection and it is synthesized by the gateway and played
  // here, in the background page (see tts.js for why playback lives in this document).
  tts = createTts({
    getConfig: () => ({
      gatewayUrl: state.prefs.gatewayUrl,
      gatewayKey: state.prefs.gatewayKey,
      model: state.prefs.ttsModel,
      voice: state.prefs.ttsVoice,
      speed: state.prefs.ttsSpeed,
    }),
    onError: reportTts,
    onState: onTtsState,
  });

  // Script mode — saved per-site scripts (re-applied at document_start on every visit) and the
  // one draft the agent and the Script panel work on. Loaded before `ready` because the
  // snapshot carries its state; applying to already-open tabs runs on in the background.
  await initUserScripts({
    onState: (s) => broadcast({ type: B2C.SCRIPT_STATE, ...s }),
    onOpen: (windowId) => openScriptPanel(windowId),
    onPicked: (p) => broadcast({ type: B2C.SCRIPT_PICKED, ...p }),
    onRepair: ({ windowId, text }) => prefillWindow(windowId, text),
    onError: (message) => notify({ type: B2C.ERROR, message, detail: "" }),
  });

  // Everything a sidebar message can touch now exists — release any HELLO that beat us here.
  // The rest of init (menus, dark mode, the live model fetch) is independent of that snapshot.
  markReady();

  await registerMenus({ onAction: handleMenuAction, onTts: handleTts });

  // AI dark mode — toolbar toggle. Reads the live gateway/model from prefs each compile;
  // surfaces failures through the same error channel the sidebar already renders.
  await initDarkmode({
    getConfig: () => ({ gatewayUrl: state.prefs.gatewayUrl, gatewayKey: state.prefs.gatewayKey, model: state.prefs.defaultModel }),
    onError: (message, detail) => notify({ type: B2C.ERROR, message, detail: detail || "" }),
  });

  // Cheat Lab — keyboard/menu-toggled in-page HUD that reads/writes a game's live JS heap
  // (wrappedJSObject), plus an LLM "ask to cheat" loop driven over the HUD's own port.
  initCheat({
    getConfig: () => ({ gatewayUrl: state.prefs.gatewayUrl, gatewayKey: state.prefs.gatewayKey, model: state.prefs.defaultModel }),
    onError: (message, detail) => notify({ type: B2C.ERROR, message, detail: detail || "" }),
  });

  // Pick up options-page edits without a reload.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let reloadModels = false;
    for (const [k, change] of Object.entries(changes)) {
      if (SYNCED_PREF_KEYS.includes(k)) state.prefs[k] = change.newValue;
      if (k === "gatewayUrl" || k === "gatewayKey") reloadModels = true;
    }
    if (reloadModels) loadModels();
  });

  await loadModels();
})();

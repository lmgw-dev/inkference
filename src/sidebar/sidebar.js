// Sidebar controller. Connects a long-lived port to the background (the source of truth),
// hydrates from the STATE snapshot, then reacts to broadcasts. All sends/cancels are just
// messages — the background runs the actual request, so closing/reloading this sidebar
// never loses an in-flight response.

import { PORT_SIDEBAR, C2B, B2C } from "../common/messages.js";
import { estimateTokens, estimateMessagesTokens, formatTokens } from "../common/util.js";
import { createChat } from "./chat.js";
import { createModelPicker } from "./modelpicker.js";
import { createReader } from "./reader.js";
import { createScriptPanel } from "./scriptpanel.js";

const $ = (id) => document.getElementById(id);
const els = {
  banner: $("banner"),
  transcript: $("transcript"),
  overbudget: $("overbudget"),
  budget: $("budget"),
  budgetFill: $("budget-fill"),
  budgetText: $("budget-text"),
  includePage: $("include-page"),
  allowNav: $("allow-nav"),
  navToggle: $("nav-toggle"),
  scriptMode: $("script-mode"),
  scriptToggle: $("script-toggle"),
  pickBtn: $("pick-btn"),
  scriptBtn: $("script-btn"),
  tokenizeBtn: $("tokenize-btn"),
  tokenizeResult: $("tokenize-result"),
  newBtn: $("new-btn"),
  input: $("input"),
  sendBtn: $("send-btn"),
  stopBtn: $("stop-btn"),
};

const st = {
  prefs: { systemPrompt: "", enabledCloudPrefixes: [], recentModels: [], defaultModel: null },
  conversation: { messages: [] },
  busy: false,
  script: null, // the background's Script-mode view model (B2C.SCRIPT_STATE)
};

let windowId = null;
const chat = createChat(els.transcript);
const picker = createModelPicker($("picker"), {
  onModelChange: () => updateBudget(),
  onPrefixesChange: (prefixes) => post({ type: C2B.SET_PREFIXES, prefixes }),
  onRefresh: () => post({ type: C2B.REFRESH_MODELS }),
});

// Read-aloud panel. It only speaks what the user sees in it, so Play sends the textarea's
// text verbatim; the background does no further cleanup.
const reader = createReader($("reader"), {
  onSpeak: (text) => post({ type: C2B.TTS_SPEAK, text }),
  onStop: () => post({ type: C2B.TTS_STOP }),
  onSettings: (settings) => post({ type: C2B.SET_TTS, ...settings }),
});

// Script panel. Every edit is a message; the background re-applies the draft to the page and
// answers with SCRIPT_STATE, which re-renders the panel.
const scriptPanel = createScriptPanel($("script"), {
  onEdit: (edit) => post({ type: C2B.SCRIPT_EDIT, ...edit }),
  onTest: () => post({ type: C2B.SCRIPT_TEST }),
  onSave: ({ name, matches }) => post({ type: C2B.SCRIPT_SAVE, name, matches }),
  onDiscard: () => post({ type: C2B.SCRIPT_DISCARD }),
  onLoad: (id) => post({ type: C2B.SCRIPT_LOAD, id, windowId }),
  onSetEnabled: (id, enabled) => post({ type: C2B.SCRIPT_SET_ENABLED, id, enabled }),
  onDelete: (id) => post({ type: C2B.SCRIPT_DELETE, id }),
  onRepair: (id) => post({ type: C2B.SCRIPT_REPAIR, id, windowId }),
});

// Persist model selection on change (separate from budget recompute above).
$("picker").querySelector(".mp-select").addEventListener("change", (e) => {
  post({ type: C2B.SET_MODEL, model: e.target.value });
});

// ---- port (auto-reconnecting) ----------------------------------------------
// At browser startup this document can load before the background page has registered its
// onConnect listener; Firefox drops such a connection outright, and the old one-shot connect
// left the sidebar mute forever — an empty model picker that only hiding and re-showing the
// sidebar (a fresh document) could fix. So we retry with backoff and re-say HELLO; the STATE
// snapshot is a full re-hydrate, so reconnecting is idempotent at any point.

const RECONNECT_MAX_MS = 2000;
const HELLO_TIMEOUT_MS = 4000;
let port = null;
let live = false; // the STATE snapshot came back, so this port is proven — see portLive()
let reconnectDelay = 0;
let reconnectTimer = null;
let helloTimer = null;
const outbox = []; // composed before the port was proven — flushed once STATE lands

function connect() {
  reconnectTimer = null;
  live = false;
  try {
    port = browser.runtime.connect({ name: PORT_SIDEBAR });
  } catch {
    port = null;
    scheduleReconnect();
    return;
  }
  const p = port;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    if (port !== p) return; // a later connect already superseded this one — don't kill it
    drop();
  });
  // A dropped connect isn't reported synchronously (postMessage on a doomed port happily
  // succeeds and the message evaporates), so an unanswered HELLO is our other failure signal.
  helloTimer = setTimeout(() => {
    if (port === p) drop();
  }, HELLO_TIMEOUT_MS);
  rawPost({ type: C2B.HELLO, windowId });
}

// The background answered our HELLO: the port carries traffic, so release whatever the user
// did while we were still (re)connecting.
function portLive() {
  live = true;
  reconnectDelay = 0;
  clearTimeout(helloTimer);
  for (const m of outbox.splice(0)) post(m); // re-queues itself if the port dies mid-flush
}

function drop() {
  port = null;
  live = false;
  clearTimeout(helloTimer);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectDelay = reconnectDelay ? Math.min(reconnectDelay * 2, RECONNECT_MAX_MS) : 100;
  if (reconnectDelay >= RECONNECT_MAX_MS) showBanner("Lost the extension background — reconnecting…");
  reconnectTimer = setTimeout(connect, reconnectDelay);
}

// postMessage throws on a port the other end already dropped; treat that as a disconnect.
function rawPost(msg) {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    drop();
    return false;
  }
}

function post(msg) {
  if (live && port && rawPost(msg)) return;
  outbox.push(msg);
  if (!port) scheduleReconnect();
}

// ---- incoming messages -----------------------------------------------------

function onMessage(msg) {
  switch (msg.type) {
    case B2C.STATE:
      portLive(); // the snapshot proves the port; flush anything queued while connecting
      st.prefs = msg.prefs;
      st.conversation = msg.conversation || { messages: [] };
      picker.update({
        models: msg.models,
        prefixes: msg.prefixes,
        enabled: msg.prefs.enabledCloudPrefixes,
        selected: msg.prefs.defaultModel,
        recent: msg.prefs.recentModels,
        error: msg.modelsError,
      });
      chat.setMessages(st.conversation.messages, msg.streaming);
      setBusy(msg.busy || msg.streaming);
      if (msg.tts) {
        reader.setSettings({ models: msg.ttsModels || [], ...msg.tts });
        reader.setProgress(msg.tts);
      }
      if (msg.script) setScriptState(msg.script);
      clearOverBudget();
      updateBudget();
      break;

    case B2C.MODELS:
      picker.update({
        models: msg.models,
        prefixes: msg.prefixes,
        enabled: st.prefs.enabledCloudPrefixes,
        recent: st.prefs.recentModels,
        error: msg.error,
      });
      updateBudget();
      break;

    case B2C.USER_MSG:
      st.conversation.messages.push(msg.message);
      chat.addUser(msg.message);
      clearOverBudget();
      updateBudget();
      break;

    case B2C.MSG_START:
      chat.startAssistant();
      break;

    case B2C.DELTA:
      chat.delta(msg.text);
      break;

    case B2C.MSG_END:
      chat.endAssistant(msg.finishReason);
      setBusy(false);
      updateBudget();
      break;

    case B2C.BUSY:
      setBusy(msg.active);
      break;

    case B2C.ERROR: {
      const text = msg.message + (msg.detail ? ` — ${truncate(msg.detail, 200)}` : "");
      showBanner(text);
      if (reader.isOpen()) reader.showError(text); // the panel covers the banner
      if (scriptPanel.isOpen()) scriptPanel.showError(text); // so does this one
      break;
    }

    case B2C.OVER_BUDGET:
      showOverBudget(msg);
      break;

    case B2C.PAGE_TOKENS:
      showTokenizeResult(msg);
      break;

    // Text for the composer, not sent: the "Ask about this…" menu action, or a script repair
    // (its request for the agent, with "Use page" + "Script" on — in the window it started in).
    // The panels lie over the composer, so they close.
    case B2C.PREFILL:
      if (msg.windowId != null && windowId != null && msg.windowId !== windowId) break;
      if (msg.text) els.input.value = msg.text;
      if (msg.enablePage) els.includePage.checked = true;
      if (msg.enableScript) els.scriptMode.checked = true;
      syncNavToggle();
      scriptPanel.close();
      reader.close();
      els.input.focus();
      updateBudget();
      break;

    case B2C.READER:
      scriptPanel.close();
      reader.open({ text: msg.text, title: msg.title });
      break;

    case B2C.SCRIPT_STATE:
      setScriptState(msg);
      break;

    case B2C.SCRIPT_OPEN:
      // A page-action click opens the panel in the window it was clicked in, not in every one.
      if (msg.windowId == null || windowId == null || msg.windowId === windowId) openScriptPanel();
      break;

    // Something the user pointed at in the page: a short reference for them to write around.
    // Every sidebar gets the broadcast; only the one in the window where the pick happened
    // takes it.
    case B2C.SCRIPT_PICKED:
      if (msg.windowId == null || windowId == null || msg.windowId === windowId) insertAtCursor(msg.ref);
      break;

    case B2C.AGENT_CONFIRM_CLOSED:
      chat.closeConfirm(msg.id, msg.approved);
      break;

    case B2C.TTS_STATE:
      reader.setProgress(msg);
      break;

    case B2C.AGENT_STEP:
      if (msg.kind === "confirm") {
        chat.addConfirm(
          msg.text,
          () => post({ type: C2B.AGENT_CONFIRM, id: msg.id, approved: true }),
          () => post({ type: C2B.AGENT_CONFIRM, id: msg.id, approved: false }),
          msg.id,
        );
      } else {
        chat.addNote(msg.kind, msg.text + (msg.detail ? ` — ${truncate(msg.detail, 200)}` : ""));
      }
      break;
  }
}

// ---- outgoing actions ------------------------------------------------------

// One path. When "Use page" is on, the background routes this to the page agent (which can
// both read the page to answer and operate it); otherwise it's a normal chat turn.
function send() {
  const text = els.input.value.trim();
  if (!text || st.busy) return;
  clearOverBudget();
  post({
    type: C2B.SEND, windowId, text, model: picker.getSelected(),
    includePage: els.includePage.checked,
    allowNav: els.includePage.checked && els.allowNav.checked,
    scriptMode: els.includePage.checked && els.scriptMode.checked,
  });
  els.input.value = "";
  updateBudget();
}

function tokenizePage() {
  showTokenizeResult({ pending: true });
  post({ type: C2B.COUNT_PAGE, windowId, model: picker.getSelected() });
}

// "Go off page" and "Script" only mean anything to the page agent, so both grey out with
// "Use page" off.
function syncNavToggle() {
  const on = els.includePage.checked;
  els.allowNav.disabled = !on;
  els.navToggle.classList.toggle("off", !on);
  els.scriptMode.disabled = !on;
  els.scriptToggle.classList.toggle("off", !on);
  syncScriptButtons();
}
els.includePage.addEventListener("change", syncNavToggle);
els.scriptMode.addEventListener("change", syncScriptButtons);
syncNavToggle();

// ---- Script mode -----------------------------------------------------------

function scriptModeOn() {
  return els.includePage.checked && els.scriptMode.checked;
}

// Pick only makes sense while building a script; the panel button also shows whenever there
// is something to look at — a draft, or scripts saved for this tab.
function syncScriptButtons() {
  const s = st.script;
  const picking = !!(s && s.picking);
  els.pickBtn.hidden = !scriptModeOn() && !picking;
  els.pickBtn.classList.toggle("picking", picking);
  els.pickBtn.textContent = picking ? "Cancel pick" : "Pick";
  els.scriptBtn.hidden = !(scriptModeOn() || (s && (s.draft || (s.saved && s.saved.length))));
}

// The background's Script state is global except for what a panel lists: `windows` maps each
// window to its tab and the scripts saved for it, and this sidebar shows its own window's.
function windowView(s) {
  const mine = (s && s.windows && windowId != null && s.windows[windowId]) || { tab: null, saved: [] };
  const d = s && s.draft;
  return { ...s, tab: mine.tab, saved: mine.saved, draft: d && { ...d, onTab: !!mine.tab && d.tabId === mine.tab.id } };
}

function setScriptState(s) {
  st.script = windowView(s);
  scriptPanel.render(st.script);
  syncScriptButtons();
}

function openScriptPanel() {
  reader.close();
  scriptPanel.open();
}

function insertAtCursor(ref) {
  if (!ref) return;
  const el = els.input;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const text = (before && !/\s$/.test(before) ? " " : "") + ref + " ";
  el.value = before + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = before.length + text.length;
  el.focus();
  updateBudget();
}

els.pickBtn.addEventListener("click", () => post({ type: C2B.SCRIPT_PICK, windowId }));

// While a pick runs, focus is usually still here (on the Pick button), so the picker's keys
// would never reach the page — forward them. Not while typing: the composer owns its arrows.
const PICK_KEYS = new Set(["Escape", "Enter", "ArrowUp", "ArrowDown", "[", "]"]);
document.addEventListener("keydown", (e) => {
  if (!st.script || !st.script.picking || !PICK_KEYS.has(e.key)) return;
  if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  e.stopPropagation();
  post({ type: C2B.SCRIPT_PICK_KEY, key: e.key });
}, true);
els.scriptBtn.addEventListener("click", openScriptPanel);

els.sendBtn.addEventListener("click", () => send());
els.tokenizeBtn.addEventListener("click", tokenizePage);
els.stopBtn.addEventListener("click", () => post({ type: C2B.CANCEL }));
els.newBtn.addEventListener("click", () => {
  post({ type: C2B.NEW_CHAT });
  clearOverBudget();
});
els.input.addEventListener("input", updateBudget);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// ---- view helpers ----------------------------------------------------------

function setBusy(busy) {
  st.busy = busy;
  els.sendBtn.hidden = busy;
  els.stopBtn.hidden = !busy;
  els.sendBtn.disabled = busy;
}

// The page is read on demand by the agent, so its size is unknown until then — the budget bar
// covers the system prompt, history, and draft only (a "~" estimate, never a hard cap).
function updateBudget() {
  const ctx = picker.getContextLength();
  const est =
    estimateTokens(st.prefs.systemPrompt) +
    estimateMessagesTokens(st.conversation.messages) +
    estimateTokens(els.input.value);

  if (ctx) {
    const ratio = Math.min(1, est / ctx);
    els.budgetFill.style.width = (ratio * 100).toFixed(1) + "%";
    els.budget.classList.toggle("over", est > ctx);
    els.budgetText.textContent = `~${formatTokens(est)} / ${formatTokens(ctx)}`;
  } else {
    els.budgetFill.style.width = "0";
    els.budget.classList.remove("over");
    els.budgetText.textContent = `~${formatTokens(est)} tok`;
  }
}

function showOverBudget(msg) {
  const b = msg.breakdown || {};
  els.overbudget.hidden = false;
  els.overbudget.innerHTML = "";
  const h = document.createElement("h4");
  h.textContent = `Over budget: ~${formatTokens(msg.estimated)} > ${formatTokens(msg.contextLength)} tokens`;
  const ul = document.createElement("ul");
  for (const [k, v] of Object.entries({
    system: b.system,
    history: b.history,
    "your message": b.draft,
  })) {
    if (!v) continue;
    const li = document.createElement("li");
    li.textContent = `${k}: ~${formatTokens(v)}`;
    ul.append(li);
  }
  const actions = document.createElement("div");
  actions.className = "ob-actions";

  if (st.conversation.messages.length) {
    const btn = document.createElement("button");
    btn.textContent = "New chat (drop history)";
    btn.addEventListener("click", () => {
      post({ type: C2B.NEW_CHAT });
      clearOverBudget();
    });
    actions.append(btn);
  }
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", clearOverBudget);
  actions.append(dismiss);

  els.overbudget.append(h, ul, actions);
  const hint = document.createElement("div");
  hint.style.color = "var(--fg-dim)";
  hint.style.marginTop = "4px";
  hint.textContent = "Or pick a model with a larger context above.";
  els.overbudget.append(hint);
}

function clearOverBudget() {
  els.overbudget.hidden = true;
  els.overbudget.textContent = "";
}

// ---- exact token count (Tokenize button) -----------------------------------

function showTokenizeResult(msg) {
  els.tokenizeResult.hidden = false;
  els.tokenizeResult.classList.remove("warn");
  if (msg.pending) {
    els.tokenizeResult.textContent = "Counting page tokens…";
    return;
  }
  if (!msg.available) {
    els.tokenizeResult.classList.add("warn");
    els.tokenizeResult.textContent = "Can't count page: " + (msg.reason || "unreadable");
    return;
  }
  let text = `Page: ${formatTokens(msg.tokens)} tokens`;
  if (msg.contextLength) {
    const pct = Math.round((msg.tokens / msg.contextLength) * 100);
    text += ` · ${pct}% of ${formatTokens(msg.contextLength)} context`;
    if (msg.tokens > msg.contextLength * 0.8) els.tokenizeResult.classList.add("warn");
  }
  els.tokenizeResult.textContent = text;
}

function showBanner(text) {
  els.banner.hidden = false;
  els.banner.textContent = text;
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => {
    els.banner.hidden = true;
  }, 8000);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- start -----------------------------------------------------------------

(async () => {
  try {
    windowId = (await browser.windows.getCurrent()).id;
  } catch {
    /* leave null; background falls back to current window */
  }
  connect(); // sends HELLO itself, and again on every reconnect
})();

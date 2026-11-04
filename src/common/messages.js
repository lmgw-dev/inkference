// Port protocol shared by the background page and the sidebar.
// Sidebar opens a long-lived port (PORT_SIDEBAR); the background owns all state
// and broadcasts updates to every connected sidebar.

export const PORT_SIDEBAR = "sidebar";

// sidebar -> background
export const C2B = {
  HELLO: "c2b:hello", // { windowId }
  SEND: "c2b:send", // { windowId, text, model, includePage, allowNav, scriptMode } — includePage
                    // routes to the page agent; allowNav additionally lets it navigate off the
                    // current page; scriptMode gives it the per-site script tools
  CANCEL: "c2b:cancel",
  NEW_CHAT: "c2b:newChat",
  SET_MODEL: "c2b:setModel", // { model }
  SET_PREFIXES: "c2b:setPrefixes", // { prefixes: string[] }
  REFRESH_MODELS: "c2b:refreshModels",
  COUNT_PAGE: "c2b:countPage", // { windowId, model } -> B2C.PAGE_TOKENS (exact, via tokenizer)
  AGENT_CONFIRM: "c2b:agentConfirm", // { id, approved } answer to the B2C.AGENT_STEP confirm with
                                     // that id — an answer for any other card is ignored
  // Read aloud. TTS_SPEAK carries the FINAL text: the reader panel has already cleaned it
  // (and the user may have edited it by hand), so the background speaks it verbatim.
  TTS_SPEAK: "c2b:ttsSpeak", // { text }
  TTS_STOP: "c2b:ttsStop",
  SET_TTS: "c2b:setTts", // { model?, voice?, speed?, clean? } — persisted reader settings
  // Script mode (background/userscripts.js). There is ONE draft — the work in progress, shared
  // by the agent and the Script panel — and the saved scripts it becomes. Every edit is applied
  // live to the draft's tab and answered with B2C.SCRIPT_STATE; the panel never keeps state.
  SCRIPT_PICK: "c2b:scriptPick", // { windowId } — let the user point at an element in the page
                                 // (sent again while a pick runs, it cancels it)
  SCRIPT_PICK_KEY: "c2b:scriptPickKey", // { key } — a picker key pressed while the sidebar has focus
  SCRIPT_EDIT: "c2b:scriptEdit", // { op: "update", id, selector?, action?, params?, why? }
                                 // | { op: "remove", id } | { op: "setMatch", matches: [pattern] }
                                 // | { op: "setName", name }
  SCRIPT_TEST: "c2b:scriptTest", // { scrolls? } — reload with the draft, scroll, measure
  SCRIPT_SAVE: "c2b:scriptSave", // { name?, matches?, allowBroad? } — the click IS the user's
                                 // approval; allowBroad only after the panel's every-site warning
  SCRIPT_DISCARD: "c2b:scriptDiscard", // drop the draft and its live CSS
  SCRIPT_LOAD: "c2b:scriptLoad", // { id, windowId } — load a saved script into the draft to edit
  SCRIPT_SET_ENABLED: "c2b:scriptSetEnabled", // { id, enabled }
  SCRIPT_DELETE: "c2b:scriptDelete", // { id }
  SCRIPT_REPAIR: "c2b:scriptRepair", // { id, windowId } — a saved script with stale rules: load it
                                     // into the draft and answer with B2C.PREFILL (the repair
                                     // request) in that window — the user reads it and sends it
};

// ---- Cheat Lab -------------------------------------------------------------
// A separate feature on its own port. The in-page HUD (content/cheat-hud.js) is BOTH the
// renderer and the heap executor: the background's LLM loop (background/cheat.js) drives it
// over this port via op-RPC (OP request -> OP_RESULT reply), so the wrappedJSObject engine
// lives in exactly one place. These string literals are mirrored verbatim in cheat-hud.js,
// which is an injected content script and so cannot import this module — keep them in sync.
export const PORT_CHEAT = "cheat";
export const CHEAT = {
  // hud -> background
  RUN: "cheat:run", // { goal } — user asked the model to do something
  CANCEL: "cheat:cancel",
  OP_RESULT: "cheat:opResult", // { id, ok, value? , error? } — reply to an OP
  // background -> hud
  OP: "cheat:op", // { id, op, path?, value? } — execute a heap op, reply OP_RESULT
  STEP: "cheat:step", // { kind, text } — think|act|note|error log line
  DONE: "cheat:done", // { text } — model's final prose
  WATCH: "cheat:watch", // { path } — pin a value to the HUD's watch list
  BUSY: "cheat:busy", // { active } — loop running / idle
  ERROR: "cheat:error", // { message, detail }
};

// background -> sidebar
export const B2C = {
  STATE: "b2c:state", // full hydration snapshot
  MODELS: "b2c:models", // { models, prefixes, error? }
  USER_MSG: "b2c:userMessage", // { message }
  MSG_START: "b2c:messageStart", // assistant turn begins
  DELTA: "b2c:delta", // { text }
  MSG_END: "b2c:messageEnd", // { finishReason, usage }
  ERROR: "b2c:error", // { message, detail }
  OVER_BUDGET: "b2c:overBudget", // { estimated, contextLength, breakdown }
  PAGE_TOKENS: "b2c:pageTokens", // { available, tokens, contextLength?, title, reason? } exact count
  BUSY: "b2c:busy", // { active }
  PREFILL: "b2c:prefill", // { text, enablePage, enableScript?, windowId? } — from the "Ask about
                          // this…" menu action, or a script repair (enableScript: "Use page" and
                          // "Script" on; windowId: only that window's sidebar takes it)
  AGENT_STEP: "b2c:agentStep", // { kind, text, detail?, id? } kind: think|act|read|confirm|done|error|note
                               // — a `confirm` carries the id its C2B.AGENT_CONFIRM must echo
  AGENT_CONFIRM_CLOSED: "b2c:agentConfirmClosed", // { id, approved? } that confirm is settled
                               // (answered in some window, or the run stopped) — disable every copy
                               // of its card; id null = every card still open (the run ended)
  READER: "b2c:reader", // { text, title } — open the read-aloud panel on this RAW selection
  // Read-aloud progress, once a second while a read is in flight: `phase` is "synthesizing"
  // (waiting for the one clip) or "playing", `elapsed`/`total` are seconds in that phase, and
  // `rate`/`rtf` are the rates measured on the last clip (see background/tts.js).
  TTS_STATE: "b2c:ttsState", // { speaking, phase, elapsed, total, rate, rtf }
  // Script mode. SCRIPT_STATE is the whole view model of the Script panel (also carried in the
  // STATE snapshot as `script`): { windows, draft, lastTest, testing, picking } — `windows` maps a
  // windowId to { tab, saved }: that window's active tab (or the one whose page-action icon was
  // clicked) and the scripts matching it. Each sidebar renders its own window's entry.
  SCRIPT_STATE: "b2c:scriptState",
  SCRIPT_PICKED: "b2c:scriptPicked", // { windowId, ref } — `ref` ("[p1: …]") goes into the composer
  SCRIPT_OPEN: "b2c:scriptOpen", // { windowId } open the Script panel there (page-action click)
};

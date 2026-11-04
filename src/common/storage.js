// Thin wrapper over browser.storage.local with defaults. The background is the single
// source of truth; the options page also reads/writes the prefs here.

import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { DEFAULT_CLEANUP } from "./speechtext.js";

export const DEFAULTS = {
  gatewayUrl: "http://127.0.0.1:8787",
  gatewayKey: "", // lmgw client key (Usage → Keys), sent as `Authorization: Bearer`; empty = no header. Never put it in a port message.
  defaultModel: null,
  enabledCloudPrefixes: [],
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  conversation: { messages: [] },
  modelCache: { fetchedAt: 0, models: [] }, // normalized models
  recentModels: [],
  // AI dark mode: per-origin compiled stylesheets (the "compile once, cache forever" store)
  // and the set of origins the user has toggled on (re-applied on navigation).
  darkCache: {}, // { [origin]: { strategy, css, rootAttributes, rootClasses, rationale, plan, stats, verify, seamHash, createdAt } }
  darkEnabledOrigins: [],
  // Read aloud (TTS). Speech models live behind /v1/audio/*, not /v1/chat/completions, so
  // they get their own cache and never appear in the chat picker. `ttsVoice` is free text —
  // the gateway's voice list is a hint, and models with a fixed voice advertise none.
  ttsModel: null,
  ttsVoice: "",
  ttsSpeed: 1,
  ttsClean: DEFAULT_CLEANUP, // which speech-text cleanup rules are on (see common/speechtext.js)
  audioModelCache: { fetchedAt: 0, models: [] }, // [{ id, kind: "tts"|"asr", ownedBy }]
  // Screen vision (page agent): which model resolves click_screen's verbal target into
  // coordinates. null disables the screenshot/click_screen tools entirely; GROUNDING_SAME
  // means the chat model grounds for itself (it must be vision-capable either way).
  groundingModel: null,
  // Page agent, "Go off page": the URL every new tab opens on. A run that begins here is told
  // so outright — this dashboard is never the subject of a request, so its first step is
  // `navigate`. Any path under this URL counts; Firefox's own about:newtab/home always do.
  // Empty = no custom start page (only the about: surfaces are recognized).
  startPage: "",
  // Script mode (background/userscripts.js): saved per-site scripts, re-applied on every visit,
  // and the one draft being worked on (kept across restarts — it is the user's unsaved work).
  userScripts: {}, // { [id]: { id, name, matches, rules, target, enabled, created, updated, versions: [{ at, name, matches, rules, target }] } }
  userScriptDraft: null,
};

// Sentinel for `groundingModel`: ground with whichever chat model is driving the turn. A
// detection-capable planner needs no second model — Gemma 4 12B locates targets on its own
// screenshots to within ~5px, in its native `box_2d` format.
export const GROUNDING_SAME = "__same__";

export async function getPrefs() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function get(key) {
  const o = await browser.storage.local.get(key);
  return key in o ? o[key] : DEFAULTS[key];
}

export async function set(obj) {
  return browser.storage.local.set(obj);
}

// Push a model id to the front of the recently-used list (deduped, capped at 8 for display).
export function pushRecent(recent, modelId) {
  const next = [modelId, ...(recent || []).filter((m) => m !== modelId)];
  return next.slice(0, 8);
}

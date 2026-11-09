// Options page: gateway URL + API key, default model, system prompt, read-aloud voice. Writes to
// storage.local; the background watches storage.onChanged and reloads models when the URL
// or key changes (and picks up the TTS settings without a restart).

import { getPrefs, set, DEFAULTS, GROUNDING_SAME } from "../common/storage.js";
import { normalizeModels, normalizeAudioModels, ttsModels } from "../background/models.js";
import { speech, fetchVoices, fetchModels } from "../background/gateway.js";
import { formatPricePair } from "../common/util.js";
import { filterableSelect } from "./selectfilter.js";

const $ = (id) => document.getElementById(id);
const gateway = $("gateway");
const gatewayKeyInput = $("gatewayKey");
const modelSel = $("model");
const system = $("system");
const ttsModelSel = $("ttsModel");
const ttsVoice = $("ttsVoice");
const ttsSpeed = $("ttsSpeed");
const groundingSel = $("groundingModel");
const startPage = $("startPage");

// The three model selects get a filter row inside their dropdown — the gateway can list
// hundreds of ids and a native select only type-aheads on the FIRST characters, which every
// cloud id shares (`kilo/…`). The selects themselves stay the value holders, so everything
// below still reads `.value` and listens for `change`; only the face changes. Done after the
// lookups above, since the enhancer moves each id onto the control the user actually clicks
// (so <label for=…> keeps working).
for (const sel of [modelSel, groundingSel, ttsModelSel]) filterableSelect(sel);

// One <audio> for the Test button. Playing it is a direct response to a click, so no
// autoplay policy is involved here.
const preview = new Audio();

const TEST_LINE = "This is the voice the extension will read your selected text with.";

async function load() {
  const prefs = await getPrefs();
  gateway.value = prefs.gatewayUrl;
  gatewayKeyInput.value = prefs.gatewayKey || "";
  system.value = prefs.systemPrompt;
  ttsVoice.value = prefs.ttsVoice || "";
  ttsSpeed.value = prefs.ttsSpeed ?? 1;
  startPage.value = prefs.startPage || "";
  populateModels((prefs.modelCache && prefs.modelCache.models) || [], prefs.defaultModel);
  populateGrounding((prefs.modelCache && prefs.modelCache.models) || [], prefs.groundingModel);
  populateTtsModels((prefs.audioModelCache && prefs.audioModelCache.models) || [], prefs.ttsModel);
  loadVoices();
}

// Grounding models are ordinary chat models to the gateway (the modality isn't advertised),
// so offer the full chat list plus the "grounds for itself" option, and let the hint steer it.
function populateGrounding(models, selected) {
  groundingSel.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— off (no screen vision) —";
  groundingSel.append(blank);
  const same = document.createElement("option");
  same.value = GROUNDING_SAME;
  same.textContent = "same as the chat model (recommended)";
  groundingSel.append(same);
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.kind === "cloud" ? `${m.id} (cloud)` : m.id;
    groundingSel.append(o);
  }
  if (selected) groundingSel.value = selected;
}

function populateModels(models, selected) {
  modelSel.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = models.length ? "— pick a model —" : "(load the gateway to list models)";
  modelSel.append(blank);
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.id;
    const base = m.kind === "cloud" ? `${m.id} (cloud)` : m.id;
    const price = formatPricePair(m.pricePrompt, m.priceCompletion);
    o.textContent = price ? `${base} — ${price}` : base;
    modelSel.append(o);
  }
  if (selected) modelSel.value = selected;
}

function populateTtsModels(audioModels, selected) {
  const voices = ttsModels(audioModels);
  ttsModelSel.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = voices.length ? "— pick a voice model —" : "(load the gateway to list speech models)";
  ttsModelSel.append(blank);
  for (const m of voices) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.id;
    ttsModelSel.append(o);
  }
  if (selected) ttsModelSel.value = selected;
}

// Fill the voice datalist for the selected model. Purely a suggestion list: an empty answer
// (a model with one fixed voice) leaves the free-text field exactly as it was.
async function loadVoices() {
  const list = $("ttsVoices");
  list.textContent = "";
  if (!ttsModelSel.value) return;
  try {
    const voices = await fetchVoices({ gatewayUrl: gatewayUrl(), gatewayKey: gatewayKey(), model: ttsModelSel.value });
    for (const v of voices) {
      const o = document.createElement("option");
      o.value = v;
      list.append(o);
    }
  } catch {
    /* gateway down or model unknown — the field stays free text */
  }
}

function gatewayUrl() {
  return (gateway.value || DEFAULTS.gatewayUrl).trim().replace(/\/+$/, "");
}

// The key as typed in the form (saved or not), like gatewayUrl() — Test uses what you see.
function gatewayKey() {
  return gatewayKeyInput.value.trim();
}

// The speed field is a plain number: anything positive is passed through, so the user is
// never silently clamped to a range we invented.
function speed() {
  const n = parseFloat(ttsSpeed.value);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function testConnection() {
  const status = $("status");
  status.textContent = "testing…";
  status.className = "";
  try {
    const raw = await fetchModels({ gatewayUrl: gatewayUrl(), gatewayKey: gatewayKey() });
    const models = normalizeModels(raw);
    const audioModels = normalizeAudioModels(raw);
    populateModels(models, modelSel.value);
    populateGrounding(models, groundingSel.value);
    populateTtsModels(audioModels, ttsModelSel.value);
    loadVoices();
    await set({
      modelCache: { fetchedAt: Date.now(), models },
      audioModelCache: { fetchedAt: Date.now(), models: audioModels },
    });
    const spoken = ttsModels(audioModels).length;
    status.textContent = `OK — ${models.length} chat models, ${spoken} voice${spoken === 1 ? "" : "s"}`;
    status.className = "ok";
  } catch (e) {
    status.textContent = "failed: " + (e.message || e);
    status.className = "err";
  }
}

// Speak one sentence with the settings as they stand in the form (saved or not), so the
// voice can be auditioned before committing it.
async function testVoice() {
  const status = $("ttsStatus");
  if (!ttsModelSel.value) {
    status.textContent = "pick a speech model first";
    status.className = "err";
    return;
  }
  status.textContent = "synthesizing…";
  status.className = "";
  try {
    const blob = await speech({
      gatewayUrl: gatewayUrl(),
      gatewayKey: gatewayKey(),
      model: ttsModelSel.value,
      input: TEST_LINE,
      voice: ttsVoice.value.trim(),
      speed: speed(),
    });
    preview.src = URL.createObjectURL(blob);
    preview.onended = () => URL.revokeObjectURL(preview.src);
    await preview.play();
    status.textContent = "playing";
    status.className = "ok";
  } catch (e) {
    status.textContent = e.message || String(e);
    status.className = "err";
  }
}

async function save() {
  await set({
    gatewayUrl: gatewayUrl() || DEFAULTS.gatewayUrl,
    gatewayKey: gatewayKey(),
    defaultModel: modelSel.value || null,
    systemPrompt: system.value,
    ttsModel: ttsModelSel.value || null,
    ttsVoice: ttsVoice.value.trim(),
    ttsSpeed: speed(),
    groundingModel: groundingSel.value || null,
    startPage: startPage.value.trim(), // empty is a real choice ("no custom start page"), not a reset
  });
  const saved = $("saved");
  saved.textContent = "saved";
  saved.className = "ok";
  setTimeout(() => (saved.textContent = ""), 2000);
}

$("test").addEventListener("click", testConnection);
$("ttsTest").addEventListener("click", testVoice);
ttsModelSel.addEventListener("change", loadVoices);
$("save").addEventListener("click", save);
load();

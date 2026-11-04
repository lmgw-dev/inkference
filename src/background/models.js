// Normalize the gateway's /v1/models payload into the shape the picker needs.
//
// Rule (verified against lmgw):
//   owned_by === "llama-embed"  -> embeddings, dropped (can't chat)
//   owned_by === "audiocpp"     -> speech (TTS/ASR), dropped -> see normalizeAudioModels
//   id contains "/"             -> cloud; prefix = segment before the first "/"
//   else                        -> local
// `embed/` ids are local-but-embeddings and `audio/` ids are local-but-speech; both carry a
// "/" and would otherwise read as a cloud prefix, so the owned_by checks drop them first and
// neither leaks into the chat picker.
//
// `pricing` is lmgw's per-token USD price ({ prompt, completion }, string values). Not
// every model carries it (cloud upstreams the gateway hasn't priced omit it); a "-1"
// sentinel likewise means "unknown". We normalize both to null so the picker can omit the
// segment, and keep "0" as 0 so local models read as free.

export function normalizeModels(data) {
  const out = [];
  for (const m of data || []) {
    if (!m || !m.id) continue;
    if (m.owned_by === "llama-embed" || isSpeechModel(m)) continue;
    const slash = m.id.indexOf("/");
    const isCloud = slash !== -1;
    const pricing = m.pricing || null;
    out.push({
      id: m.id,
      kind: isCloud ? "cloud" : "local",
      prefix: isCloud ? m.id.slice(0, slash) : null,
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
      ownedBy: m.owned_by || null,
      pricePrompt: pricing ? parsePrice(pricing.prompt) : null,
      priceCompletion: pricing ? parsePrice(pricing.completion) : null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ---- speech models ---------------------------------------------------------
// lmgw serves TTS and ASR through /v1/audio/* (never /v1/chat/completions), so they get
// their own list and their own cache. lmgw tags them `owned_by: "audiocpp"` and aliases them
// under an `audio/` prefix; we accept either signal so a future speech upstream still lands
// here. TTS vs ASR is read off the id — the transcription models say so in their name.
const ASR_RE = /(^|[-_/])(asr|stt|whisper|transcribe|transcription)([-_/0-9]|$)/i;

function isSpeechModel(m) {
  return m.owned_by === "audiocpp" || /^audio\//.test(m.id);
}

export function normalizeAudioModels(data) {
  const out = [];
  for (const m of data || []) {
    if (!m || !m.id || !isSpeechModel(m)) continue;
    out.push({ id: m.id, kind: ASR_RE.test(m.id) ? "asr" : "tts", ownedBy: m.owned_by || null });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function ttsModels(audioModels) {
  return (audioModels || []).filter((m) => m.kind === "tts");
}

// Per-token price as a non-negative number, or null when missing/sentinel/garbage.
function parsePrice(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function cloudPrefixes(models) {
  const set = new Set();
  for (const m of models) if (m.kind === "cloud") set.add(m.prefix);
  return [...set].sort();
}

export function findModel(models, id) {
  return models.find((m) => m.id === id) || null;
}

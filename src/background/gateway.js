// All network I/O to the lmgw gateway. Runs in the background page, where the host
// permission waives CORS and HTTPS->HTTP-localhost mixed-content blocking.

import { createSSEParser } from "./sse.js";

export class GatewayError extends Error {
  constructor(message, detail, status) {
    super(message);
    this.name = "GatewayError";
    this.detail = detail || "";
    this.status = status ?? null;
  }
}

// Counts tokens for a string using the gateway's tokenizer. Returns a number.
// Throws GatewayError on HTTP/connection errors or a malformed response.
export async function countTokens({ gatewayUrl, gatewayKey, model, input }) {
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/count_tokens"), {
      method: "POST",
      headers: gatewayHeaders(gatewayKey, true),
      body: JSON.stringify({ model, input: input || "" }),
    });
  } catch (e) {
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Token count failed", gatewayKey);
  const json = await res.json();
  if (typeof json.tokens !== "number") {
    throw new GatewayError("Tokenizer returned no token count", JSON.stringify(json), null);
  }
  return json.tokens;
}

// One-shot, non-streaming chat completion. Used where we want the whole answer as a value
// and must NOT touch the conversation/stream loop (e.g. compiling a dark-mode stylesheet).
// Returns the assistant message text. Throws GatewayError like the others.
export async function chatOnce({ gatewayUrl, gatewayKey, model, messages, signal, temperature }) {
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: gatewayHeaders(gatewayKey, true),
      body: JSON.stringify({ model, messages, stream: false, ...(temperature != null ? { temperature } : {}) }),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Chat request failed", gatewayKey);
  const json = await res.json();
  if (json.error) throw new GatewayError(json.error.message || "Upstream provider error", JSON.stringify(json.error), null);
  const m = (json.choices && json.choices[0] && json.choices[0].message) || {};
  return messageText(m.content) || messageText(m.reasoning_content);
}

// One non-streaming tool-calling turn (OpenAI function-calling shape, which lmgw forwards to
// llama-server). Returns { content, toolCalls } where toolCalls is the raw array (or []). The
// caller drives the agent loop: append the assistant turn, run each tool, feed results back.
// Non-streaming on purpose — an agent step has no partial UI to fill, and weaker local models
// emit cleaner tool_calls without streaming reassembly.
export async function chatWithTools({ gatewayUrl, gatewayKey, model, messages, tools, signal, temperature, toolChoice }) {
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: gatewayHeaders(gatewayKey, true),
      body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice || "auto", stream: false, ...(temperature != null ? { temperature } : {}) }),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Agent request failed", gatewayKey);
  const json = await res.json();
  if (json.error) throw new GatewayError(json.error.message || "Upstream provider error", JSON.stringify(json.error), null);
  const m = (json.choices && json.choices[0] && json.choices[0].message) || {};
  // `reasoning` is returned separately so callers can SHOW it without echoing it back every turn.
  return { content: messageText(m.content), reasoning: messageText(m.reasoning_content), toolCalls: m.tool_calls || [] };
}

// Pull the assistant's text out of a chat message. Many models routed through llama.cpp (Gemma,
// LFM2.5, …) leave `content` null/empty and put everything in `reasoning_content`; some providers
// send content as an array of parts. Normalise all of that to a string.
function messageText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p && (p.text || p.content)) || "")).join("");
  return "";
}

// Text-to-speech: one utterance in, one audio Blob out (lmgw's audiocpp upstreams answer
// audio/wav whatever `response_format` asks for, so we let the Blob carry its own type).
// Synthesis is NOT streamed — the gateway returns the finished clip, minutes later for a long
// passage — so the caller (background/tts.js) sends the whole text at once, reports the wait,
// and aborts via `signal`. Note that an abort only frees the client: audio.cpp has no cancel
// and keeps generating (and holding the model) until the abandoned clip is done.
// `voice`/`speed` are only sent when set: an unknown voice is rejected by the upstream.
export async function speech({ gatewayUrl, gatewayKey, model, input, voice, speed, signal }) {
  // `voice` is a NAME — one of the presets the gateway's audio model defines, or a voice the
  // model ships. audio.cpp validates it as an id (alphanumerics, hyphens, underscores, spaces),
  // so a reference clip's path 500s with a charset complaint that says nothing about the fix.
  if (voice && /[\\/]/.test(voice)) {
    throw new GatewayError(
      "The voice field takes a preset name, not a file path",
      `Add "${voice}" as a voice preset on the model in lmgw (Audio → edit model → Voice presets), then put the preset's NAME here — or make it the model's default preset and leave this empty.`,
      null
    );
  }
  const body = { model, input };
  if (voice) body.voice = voice;
  if (speed != null && speed !== 1) body.speed = speed;
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/audio/speech"), {
      method: "POST",
      headers: gatewayHeaders(gatewayKey, true),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Speech request failed", gatewayKey);
  const blob = await res.blob();
  if (!blob.size) throw new GatewayError("The gateway returned no audio", `model ${model}`, null);
  return blob;
}

// Voices the gateway advertises for one speech model ({"voices":[…]}). Models whose voice is
// fixed server-side return an empty list, so treat this as a hint for the picker, never as a
// constraint on what the user may type.
export async function fetchVoices({ gatewayUrl, gatewayKey, model }) {
  const url = joinUrl(gatewayUrl, "/v1/audio/voices") + "?model=" + encodeURIComponent(model);
  let res;
  try {
    res = await fetch(url, { headers: gatewayHeaders(gatewayKey) });
  } catch (e) {
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Voice list failed", gatewayKey);
  const json = await res.json();
  return (json.voices || []).map((v) => (typeof v === "string" ? v : v && (v.id || v.name))).filter(Boolean);
}

// Request headers for every gateway call: `Authorization: Bearer <key>` only when a key is set
// (lmgw's "Require API key" switch is optional), Content-Type only for JSON bodies.
export function gatewayHeaders(gatewayKey, json = false) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  const key = String(gatewayKey || "").trim();
  if (key) h.Authorization = "Bearer " + key;
  return h;
}

// Build a GatewayError from a failed response, promoting the gateway's own error message
// (`{"error":{"message":…}}`) into the headline — for speech that message is the whole
// diagnosis ("PocketTTS session prepare() requires a session voice via --voice-id").
// A 401 also names the fix: lmgw answers code `auth` when no key / an unknown key arrived, and
// that message doesn't say where keys live. Other 401 codes (`key_disabled`, `key_expired`, …)
// already carry their own fix, so the suffix is only added for `auth` or when no key was sent.
async function gatewayFailure(res, headline, gatewayKey) {
  const text = await safeText(res);
  let msg = null;
  let code = null;
  try {
    const j = JSON.parse(text);
    msg = j && j.error && j.error.message;
    code = j && j.error && j.error.code;
  } catch {
    /* not JSON — keep the raw body as detail */
  }
  let line = msg ? `${headline}: ${msg}` : `${headline} (HTTP ${res.status})`;
  if (res.status === 401 && (code === "auth" || !String(gatewayKey || "").trim() || !msg)) {
    line = `${msg ? line : `${headline}: unauthorized`} — set the gateway API key in rsd settings (lmgw: Usage → Keys)`;
  }
  return new GatewayError(line, text, res.status);
}

export async function fetchModels({ gatewayUrl, gatewayKey }) {
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/models"), { headers: gatewayHeaders(gatewayKey) });
  } catch (e) {
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Model list failed", gatewayKey);
  const json = await res.json();
  return json.data || [];
}

// Streams a chat completion. Calls onDelta(text) per token chunk. Resolves with
// { finishReason, usage }. Throws GatewayError on HTTP/connection/upstream errors, or
// DOMException(AbortError) when the signal is aborted (caller distinguishes that).
export async function streamChat({ gatewayUrl, gatewayKey, model, messages, signal, onDelta }) {
  let res;
  try {
    res = await fetch(joinUrl(gatewayUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: gatewayHeaders(gatewayKey, true),
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new GatewayError(`Can't reach the gateway at ${gatewayUrl} — is lmgw running?`, String(e), null);
  }
  if (!res.ok) throw await gatewayFailure(res, "Chat request failed", gatewayKey);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();
  let finishReason = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const data of parser.push(decoder.decode(value, { stream: true }))) {
      if (data === "[DONE]") return { finishReason, usage };
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (obj.error) {
        const msg = obj.error.message || "Upstream provider error";
        throw new GatewayError(msg, JSON.stringify(obj.error), null);
      }
      const choice = obj.choices && obj.choices[0];
      if (choice) {
        const delta = choice.delta && choice.delta.content;
        if (delta) onDelta(delta);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (obj.usage) usage = obj.usage;
    }
  }
  return { finishReason, usage };
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, "") + path;
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

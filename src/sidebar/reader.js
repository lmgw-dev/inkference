// The read-aloud panel — a full-height view over the chat, opened by the
// "Read aloud in sidebar…" context action.
//
// It exists because the straight-to-speech path is a leap of faith: web text is full of marks
// that sound like nonsense ("bracket twenty three"), and you only find out after the model has
// spent thirty seconds synthesizing them. So this view shows exactly WHAT will be spoken before
// a single request goes out, with the cleanup rules as individual switches.
//
// The panel keeps the ORIGINAL selection and re-derives the cleaned text on every toggle, so
// no rule is destructive and any of them can be taken back. The textarea is editable and wins:
// what is in it at the moment you press play is what gets spoken, verbatim.

import { CLEANUP_RULES, cleanForSpeech, cleanupDelta } from "../common/speechtext.js";
import { SECONDS_PER_CHAR, SYNTH_RTF } from "../background/tts.js";

export function createReader(root, { onSpeak, onStop, onSettings }) {
  const $ = (id) => root.querySelector("#" + id);
  const els = {
    source: $("reader-source"),
    text: $("reader-text"),
    stats: $("reader-stats"),
    rules: $("reader-rules"),
    reset: $("reader-reset"),
    model: $("reader-model"),
    voice: $("reader-voice-name"),
    speed: $("reader-speed"),
    play: $("reader-play"),
    stop: $("reader-stop"),
    progress: $("reader-progress"),
    error: $("reader-error"),
    close: $("reader-close"),
  };

  let raw = ""; // the selection as it came off the page — never mutated
  let clean = {}; // rule id -> on
  const boxes = new Map();
  // Seconds of speech per character, and the share of that the synthesis itself costs. The
  // background replaces both with what it measured on the last clip (see tts.js) — until then
  // these are the shipped estimate.
  let rate = SECONDS_PER_CHAR;
  let rtf = SYNTH_RTF;

  // ---- cleanup rule switches ----
  for (const rule of CLEANUP_RULES) {
    const label = document.createElement("label");
    label.className = "rd-rule";
    label.title = rule.hint;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      clean = { ...clean, [rule.id]: box.checked };
      onSettings({ clean });
      render(); // re-derive from the original: toggling is always reversible
    });
    const text = document.createElement("span");
    text.className = "rd-rule-label";
    text.textContent = rule.label;
    const hint = document.createElement("span");
    hint.className = "rd-rule-hint";
    hint.textContent = rule.hint;
    label.append(box, text, hint);
    els.rules.append(label);
    boxes.set(rule.id, box);
  }

  els.reset.addEventListener("click", () => render());
  els.text.addEventListener("input", updateStats);
  els.play.addEventListener("click", () => {
    const text = els.text.value.trim();
    if (text) onSpeak(text);
  });
  els.stop.addEventListener("click", () => onStop());
  els.close.addEventListener("click", () => close());
  els.model.addEventListener("change", () => onSettings({ model: els.model.value || null }));
  els.voice.addEventListener("change", () => onSettings({ voice: els.voice.value.trim() }));
  els.speed.addEventListener("change", () => onSettings({ speed: speedValue() }));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Anything positive goes through: the min/max on the input are guidance, not a silent clamp.
  function speedValue() {
    const n = parseFloat(els.speed.value);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function render() {
    els.text.value = cleanForSpeech(raw, clean);
    updateStats();
  }

  // Both numbers matter before pressing play: the clip is synthesized in one piece, so the
  // second one is how long the silence lasts before a word is heard.
  function updateStats() {
    const text = els.text.value.trim();
    const { after, removed } = cleanupDelta(raw, text);
    const parts = [`${fmt(after)} chars to speak`];
    if (removed > 0) parts.push(`${fmt(removed)} removed`);
    if (text.length) {
      const secs = text.length * rate;
      parts.push(`~${duration(secs)} of speech`, `~${duration(secs * rtf)} to synthesize`);
    }
    els.stats.textContent = parts.join(" · ");
  }

  // The background measures the real rates as it reads; prefer them over the shipped estimate.
  // Returns true when they moved, so the estimate on screen can be redrawn — and only then,
  // since progress arrives once a second.
  function applyRates({ rate: r, rtf: f }) {
    const was = [rate, rtf];
    if (r > 0) rate = r;
    if (f > 0) rtf = f;
    return rate !== was[0] || rtf !== was[1];
  }

  function open({ text, title }) {
    raw = String(text || "");
    els.source.textContent = title ? `from “${truncate(title, 60)}”` : "";
    render();
    root.hidden = false;
    els.play.focus();
  }

  function close() {
    root.hidden = true;
  }

  return {
    open,
    close,
    isOpen: () => !root.hidden,

    // Voice settings come from the background's snapshot, so the panel and the options page
    // always show the same thing.
    setSettings({ models, model, voice, speed, clean: rules, ...rest }) {
      const moved = applyRates(rest);
      if (models) {
        els.model.textContent = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = models.length ? "— pick a voice model —" : "(no speech models on the gateway)";
        els.model.append(blank);
        for (const m of models) {
          const o = document.createElement("option");
          o.value = m.id;
          o.textContent = m.id;
          els.model.append(o);
        }
      }
      if (model !== undefined) els.model.value = model || "";
      if (voice !== undefined) els.voice.value = voice || "";
      if (speed !== undefined) els.speed.value = speed ?? 1;
      if (rules) {
        clean = { ...rules };
        for (const [id, box] of boxes) box.checked = !!clean[id];
        if (raw) render();
      } else if (moved) updateStats();
    },

    // One clip per read, so progress is a clock rather than a chunk counter: while the
    // gateway synthesizes there is nothing to hear, and that wait needs to look like work.
    setProgress({ speaking, phase, elapsed, total, ...rest }) {
      const moved = applyRates(rest);
      els.play.hidden = !!speaking;
      els.stop.hidden = !speaking;
      const clock = `${duration(elapsed || 0)}${total ? ` / ${phase === "synthesizing" ? "~" : ""}${duration(total)}` : ""}`;
      els.progress.textContent = !speaking ? "" : phase === "playing" ? clock : `synthesizing… ${clock}`;
      if (speaking) els.error.hidden = true;
      if (moved) updateStats();
    },

    // The panel covers the chat's error banner, so failures are repeated in here — a silent
    // "nothing happened" after pressing play would be the worst outcome.
    showError(text) {
      els.error.hidden = false;
      els.error.textContent = text;
    },
  };
}

function duration(seconds) {
  const secs = Math.round(seconds);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function fmt(n) {
  return n.toLocaleString();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

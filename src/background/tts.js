// "Read aloud" — speaks selected text through the gateway's /v1/audio/speech endpoint.
//
// Playback lives HERE, in the persistent background page. It is the one document that
// outlives both the tab and the sidebar, and Firefox exempts extension background pages from
// autoplay blocking (media.autoplay.allow-extension-background-pages, default true), so a
// right-click can start audio with no visible player and no open sidebar.
//
// ONE request per read — the whole selection, never split. audio.cpp already chunks long
// input itself (fish-audio: 200 characters per chunk by default) and holds ONE speaker across
// those chunks, which is the thing a client cannot do: with no reference voice configured the
// model samples a new random speaker per request. Measured against this gateway: the same seed
// with the same text is byte-identical, the same seed with DIFFERENT text is a different
// speaker — so a request's voice cannot be pinned, only kept whole. Splitting a paragraph
// client-side therefore read it out in three different voices. (The fix for choosing a voice
// at all is a server-side preset — a reference clip or voice id in lmgw's audio model config.)
//
// The price is latency, and it is not small: nothing plays until the entire clip is
// synthesized, at roughly half real time (~0.04 s per character on this box). A long article
// is a minutes-long wait. So the wait is reported rather than hidden — phase, elapsed and an
// estimate go to the reader panel every second — and Stop aborts it.
//
// Stop caveat: audio.cpp has no cancel. An aborted request keeps generating to the end
// upstream and holds the model, so Stop followed by reading something else can sit in
// "synthesizing" until the abandoned clip finishes.
//
// Nothing is capped or truncated: a long selection simply takes longer.

import { speech } from "./gateway.js";

// Seed estimates, replaced by measurement as soon as one clip has been read (rates differ per
// model and per GPU load). SECONDS_PER_CHAR is the spoken length of a character — measured on
// fish-audio-s2-pro at 0.061 for an 874-char passage and 0.076 for a one-liner, since short
// clips are mostly leading and trailing silence. SYNTH_RTF is how much of that spoken length
// the synthesis itself costs (audio.cpp reports its own real-time factor as X-AudioCPP-RTF,
// 0.49-0.51 here). Exported so the reader panel can price a passage before committing to it.
export const SECONDS_PER_CHAR = 0.065;
export const SYNTH_RTF = 0.5;
// Learn the rates only from clips long enough to be dominated by speech: a five-word request
// is mostly the model's leading and trailing silence and would skew the estimate high.
const RATE_SAMPLE_MIN_CHARS = 200;

export function createTts({ getConfig, onError, onState }) {
  const audio = new Audio();
  let run = 0; // bumped by every stop()/speak(); callbacks from an older run bail out
  let abort = null; // AbortController of the in-flight synthesis request
  let endPlayback = null; // resolves the current play() promise early (used by stop())
  let ticker = null; // 1s interval that keeps `elapsed` moving while a read is in progress
  let rate = SECONDS_PER_CHAR; // spoken seconds per character, learned from the last clip
  let rtf = SYNTH_RTF; // synthesis seconds per spoken second, likewise
  let state = { speaking: false, phase: "idle", elapsed: 0, total: 0 };

  // Announce only real changes: the tick fires every second but the readout is whole seconds,
  // and the stop() that speak() opens with must not spray "not speaking" at every sidebar.
  function publish(patch) {
    const next = { ...state, ...patch };
    next.elapsed = Math.round(next.elapsed);
    next.total = Math.round(next.total);
    const same = ["speaking", "phase", "elapsed", "total"].every((k) => state[k] === next[k]);
    state = next;
    if (!same && onState) onState({ ...state, rate, rtf });
  }

  // `sample()` reports where the current phase stands; null stops the ticking.
  function tick(sample) {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (!sample) return;
    ticker = setInterval(() => publish(sample()), 1000);
  }

  function fail(message, detail) {
    if (onError) onError(message, detail || "");
  }

  // Play one clip; resolves when it ends or when stop() cuts it short, rejects if Firefox
  // refuses to play it. `settled` is per-invocation on purpose: pausing rejects the pending
  // play() promise a tick later, and that stale rejection must not disturb the next clip.
  function play(blob, chars) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      let settled = false;
      let cutShort;
      const cleanup = () => {
        settled = true;
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onErr);
        audio.removeEventListener("loadedmetadata", onMeta);
        URL.revokeObjectURL(url);
        if (endPlayback === cutShort) endPlayback = null;
      };
      // The clip's real length: both the readout's denominator and the next estimate's basis.
      const onMeta = () => {
        if (!Number.isFinite(audio.duration)) return;
        if (chars >= RATE_SAMPLE_MIN_CHARS) rate = audio.duration / chars;
        publish({ total: audio.duration });
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("Firefox couldn't play the synthesized audio"));
      };
      // stop() resolves rather than rejects — the run-id check after the await ends the loop.
      cutShort = () => {
        if (settled) return;
        cleanup();
        resolve();
      };
      endPlayback = cutShort;
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onErr);
      audio.src = url;
      audio.play().catch((e) => {
        if (settled) return; // stop() or an ended/error event already settled this clip
        const blocked = e && e.name === "NotAllowedError";
        cleanup();
        reject(
          new Error(
            blocked
              ? "Firefox blocked the audio — set media.autoplay.allow-extension-background-pages to true in about:config"
              : "Firefox couldn't play the synthesized audio: " + ((e && e.message) || e)
          )
        );
      });
    });
  }

  // Speak `text`. Replaces whatever is currently being read (one reader at a time).
  async function speak(text) {
    stop();
    // Only the ends are trimmed: what the reader panel shows is what the gateway is asked to
    // say, down to the line breaks (some audio.cpp chunk modes split on them).
    const input = String(text || "").trim();
    if (!input) {
      fail("Nothing to read — the selection has no text.");
      return;
    }
    const cfg = getConfig();
    if (!cfg.model) {
      fail("No text-to-speech model set.", "Pick one under “Read aloud” in the extension's options.");
      return;
    }

    const myRun = ++run;
    abort = new AbortController();
    const started = Date.now();
    const spoken = input.length * rate; // estimated length of the finished clip
    const elapsed = () => (Date.now() - started) / 1000;
    publish({ speaking: true, phase: "synthesizing", elapsed: 0, total: spoken * rtf });
    tick(() => ({ elapsed: elapsed(), total: spoken * rtf }));

    try {
      const blob = await speech({
        gatewayUrl: cfg.gatewayUrl,
        gatewayKey: cfg.gatewayKey,
        model: cfg.model,
        input,
        voice: cfg.voice,
        speed: cfg.speed,
        signal: abort.signal,
      });
      if (myRun !== run) return;
      const synthesis = elapsed();
      publish({ phase: "playing", elapsed: 0, total: spoken });
      tick(() => ({ elapsed: audio.currentTime, total: audio.duration || spoken }));
      await play(blob, input.length);
      if (myRun !== run) return;
      // rate has just been re-measured from this clip, so the ratio is a true RTF.
      if (input.length >= RATE_SAMPLE_MIN_CHARS) rtf = synthesis / (input.length * rate);
    } catch (e) {
      if (myRun !== run || (e && e.name === "AbortError")) return;
      fail(e.message || "Read aloud failed", (e && e.detail) || "");
    } finally {
      if (myRun === run) {
        abort = null;
        tick(null);
        publish({ speaking: false, phase: "idle", elapsed: 0, total: 0 });
      }
    }
  }

  function stop() {
    run++;
    if (abort) abort.abort();
    abort = null;
    tick(null);
    audio.pause();
    if (endPlayback) endPlayback();
    publish({ speaking: false, phase: "idle", elapsed: 0, total: 0 });
  }

  return {
    speak,
    stop,
    isSpeaking: () => state.speaking,
    // The whole readout, for a sidebar that connects mid-read (and the measured rates, which
    // the panel prices a passage with).
    getState: () => ({ ...state, rate, rtf }),
  };
}

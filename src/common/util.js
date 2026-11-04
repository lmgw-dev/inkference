// Transparent token estimate. This is an approximation (~4 chars/token), surfaced to the
// user with a "~" so it never reads as an exact, hidden cap. We never auto-truncate based
// on it — we surface the number and let the user decide.

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ~4 tokens of per-message envelope overhead (role + formatting), matching common heuristics.
export function estimateMessagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

export function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
  return String(n);
}

// The gateway prices models per-token in USD. Humans read $/1M tokens, so we rescale and
// label the unit explicitly — no value is hidden, only the scale changes. A null/negative
// per-token price means the gateway didn't price that model (cloud upstreams it doesn't
// know about); we render "?" rather than a misleading "$0".
function priceUnknown(p) {
  return p == null || !Number.isFinite(p) || p < 0;
}

// Per-token USD -> compact "$X" per 1M tokens. "$0" for free, "?" for unpriced.
export function formatPrice1M(perToken) {
  if (priceUnknown(perToken)) return "?";
  if (perToken === 0) return "$0";
  const per1M = perToken * 1e6;
  let s = per1M >= 1 ? per1M.toFixed(2) : per1M.toPrecision(2);
  if (s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return "$" + s;
}

// Compact in/out price pair for a model, e.g. "$3/$15" or "free". Returns null when the
// model is wholly unpriced, so callers can omit the segment entirely.
export function formatPricePair(promptPerToken, completionPerToken) {
  if (priceUnknown(promptPerToken) && priceUnknown(completionPerToken)) return null;
  if (promptPerToken === 0 && completionPerToken === 0) return "free";
  return `${formatPrice1M(promptPerToken)}/${formatPrice1M(completionPerToken)}`;
}

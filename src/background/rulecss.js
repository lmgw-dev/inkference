// The Script-mode COMPILER — pure functions, no browser globals, so the same code runs in the
// background page and in tools/script-check.mjs under Node.
//
// Same division of labour as dark mode (darkcss.js): the model never types a stylesheet. It
// picks an element and an ACTION — a short {selector, action, params} rule — and this module
// writes the CSS. A local model typing CSS inside a JSON string breaks the JSON; a rule is a
// few short strings. Rules are also what makes a saved script checkable later: each one has a
// selector whose match count can be measured on every visit (the health check), which a
// free-form stylesheet would not give us.
//
// The sheet is injected with cssOrigin:"user", so every `!important` here beats the site's own
// author rules, its inline styles and its inline `!important` — the overlay cannot win back by
// re-rendering, and a recycled tile in an infinite feed is matched the moment it is reused.

export const ACTIONS = {
  hide: "remove it from the page (display:none)",
  "hide-until-hover":
    "invisible until hovered; params.hover = an ancestor (e.g. the tile) whose hover reveals it",
  "click-through": "stays visible, but clicks pass through it to whatever is underneath",
  dim: "semi-transparent; params.opacity (0..1, default 0.3)",
  move:
    "reposition an absolutely positioned overlay; params.to = below | above | left | right " +
    "(outside its box) or top-left | top-right | bottom-left | bottom-right (a corner inside it); " +
    "params.unclip = an ancestor selector whose overflow clipping must be lifted",
  restyle: 'raw CSS; params.declarations = {"property": "value", …}',
};

const MOVES = {
  below: { top: "100%", bottom: "auto" },
  above: { bottom: "100%", top: "auto" },
  left: { right: "100%", left: "auto" },
  right: { left: "100%", right: "auto" },
  "top-left": { top: "0", left: "0", bottom: "auto", right: "auto" },
  "top-right": { top: "0", right: "0", bottom: "auto", left: "auto" },
  "bottom-left": { bottom: "0", left: "0", top: "auto", right: "auto" },
  "bottom-right": { bottom: "0", right: "0", top: "auto", left: "auto" },
};

// Anything that could close the rule block or open a new at-rule/comment. The selector's real
// syntax check needs a DOM (querySelector throws) and happens where one exists; this only keeps
// a string from escaping its own block.
const UNSAFE = /[{};]|\/\*|\*\/|<\/?style|@/i;
// Line breaks and control characters have no business in a selector, a value or a label — and in
// the save card's free text they can fake a whole extra "Applies to: …" block.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const PROPERTY = /^(--[\w-]+|-?[a-z][a-z-]*)$/;

// The only CSS functions a restyle value may call. A value is where a sheet can make the browser
// FETCH — url(), image-set(), image(), src(), a typed attr() — and a saved rule runs on every
// visit, so the model (which has read the page, and can be prompt-injected by it) gets colour,
// geometry, transform and filter maths and nothing that names a resource. Backslashes are refused
// outright: `\75 rl(…)` is how CSS spells url( without the letters.
const VALUE_FUNCTIONS = new Set(
  (
    "rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark calc min max clamp var env " +
    "round mod rem abs sign translate translatex translatey translatez translate3d rotate rotatex " +
    "rotatey rotatez rotate3d scale scalex scaley scalez scale3d skew skewx skewy matrix matrix3d " +
    "perspective linear-gradient radial-gradient conic-gradient repeating-linear-gradient " +
    "repeating-radial-gradient repeating-conic-gradient blur brightness contrast drop-shadow grayscale " +
    "hue-rotate invert opacity saturate sepia cubic-bezier steps linear inset circle ellipse polygon " +
    "rect xywh minmax repeat fit-content"
  ).split(" "),
);

// An unclosed ( [ or quote is legal to querySelector (Firefox closes it at end of input) but, once
// compiled into the one shared sheet, swallows every rule after it while each selector still
// counts fine on its own — so balance is checked here, escapes respected.
function unbalanced(s) {
  const stack = [];
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (i === s.length - 1) return "ends with a lone backslash";
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") stack.push(ch === "(" ? ")" : "]");
    else if ((ch === ")" || ch === "]") && stack.pop() !== ch) return `has an unmatched "${ch}"`;
  }
  if (quote) return `has an unclosed ${quote} quote`;
  if (stack.length) return `has an unclosed "${stack.at(-1) === ")" ? "(" : "["}"`;
  return null;
}

// Split a selector list on its top-level commas (not the ones inside :is(), [attr="a,b"], …).
export function splitSelectorList(sel) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  let esc = false;
  for (const ch of sel) {
    if (esc) esc = false;
    else if (ch === "\\") esc = true;
    else if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function checkSelector(sel, what) {
  if (typeof sel !== "string" || !sel.trim()) return `${what} is empty`;
  if (UNSAFE.test(sel)) return `${what} contains { } ; @ or a comment — not allowed in a selector`;
  if (CONTROL.test(sel)) return `${what} contains a line break or control character`;
  const u = unbalanced(sel);
  return u ? `${what} ${u}` : null;
}

function checkValue(v, what) {
  if (typeof v !== "string" && typeof v !== "number") return `${what} must be a string`;
  const s = String(v);
  if (UNSAFE.test(s)) return `${what} contains { } ; @ or a comment`;
  if (CONTROL.test(s)) return `${what} contains a line break or control character`;
  if (s.includes("\\")) return `${what} contains a backslash — write the value plainly`;
  const u = unbalanced(s);
  if (u) return `${what} ${u}`;
  for (const m of s.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g)) {
    if (!VALUE_FUNCTIONS.has(m[1].toLowerCase())) {
      return `${what} calls ${m[1]}() — a script may not load anything (no url/image functions); use colours, sizes, transforms or filters`;
    }
  }
  return null;
}

// A script's display name, or a rule's `why`: one line of plain text.
export function validateLabel(v, what = "name") {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return `${what} must be a string`;
  return CONTROL.test(v) ? `${what} must be one line, without control characters` : null;
}

// Returns null when the rule compiles, else a message the model can act on.
export function validateRule(rule) {
  if (!rule || typeof rule !== "object") return "rule must be an object";
  const err = checkSelector(rule.selector, "selector") || validateLabel(rule.why, "why");
  if (err) return err;
  if (!Object.hasOwn(ACTIONS, rule.action)) {
    return `unknown action "${rule.action}" — use one of: ${Object.keys(ACTIONS).join(", ")}`;
  }
  const p = rule.params || {};
  switch (rule.action) {
    case "hide-until-hover":
      return p.hover ? checkSelector(p.hover, "params.hover") : null;
    case "dim": {
      if (p.opacity === undefined) return null;
      const o = Number(p.opacity);
      return o >= 0 && o <= 1 ? null : "params.opacity must be a number from 0 to 1";
    }
    case "move":
      if (!Object.hasOwn(MOVES, p.to)) return `params.to must be one of: ${Object.keys(MOVES).join(", ")}`;
      return p.unclip ? checkSelector(p.unclip, "params.unclip") : null;
    case "restyle": {
      const d = p.declarations;
      if (!d || typeof d !== "object" || !Object.keys(d).length) {
        return 'params.declarations must be an object like {"opacity": "0.5"}';
      }
      for (const [k, v] of Object.entries(d)) {
        if (!PROPERTY.test(k)) return `"${k}" is not a CSS property name`;
        const e = checkValue(v, `value of ${k}`);
        if (e) return e;
      }
      return null;
    }
    default:
      return null;
  }
}

const important = (v) => `${String(v).replace(/\s*!important\s*$/i, "").trim()} !important`;

function block(selector, decls) {
  const body = Object.entries(decls)
    .map(([k, v]) => `  ${k}: ${important(v)};`)
    .join("\n");
  return `${selector} {\n${body}\n}`;
}

// One rule → its CSS text. Throws on an invalid rule (callers validate first and surface the
// message; compileRules skips and reports instead).
export function compileRule(rule) {
  return compileRuleBlocks(rule).join("\n");
}

// Text that goes inside a /* comment */: without any `*` it cannot close the comment, however it
// is spelled (a one-pass `*/` strip turns `**//` back into `*/`).
const commentSafe = (v) => String(v).replace(/[*\u0000-\u001f\u007f\u2028\u2029]/g, " ").trim();

function compileRuleBlocks(rule) {
  const err = validateRule(rule);
  if (err) throw new Error(err);
  const s = rule.selector.trim();
  const parts = splitSelectorList(s);
  const p = rule.params || {};
  switch (rule.action) {
    case "hide":
      return [block(s, { display: "none" })];
    case "hide-until-hover": {
      const reveal = parts.flatMap((x) => [`${x}:hover`, `${x}:focus-within`]);
      if (p.hover) {
        for (const h of splitSelectorList(p.hover)) for (const x of parts) reveal.unshift(`${h}:hover ${x}`);
      }
      return [
        block(s, { opacity: "0", transition: "opacity .15s ease" }),
        block(reveal.join(",\n"), { opacity: "1" }),
      ];
    }
    case "click-through":
      return [block(parts.flatMap((x) => [x, `${x} *`]).join(", "), { "pointer-events": "none" })];
    case "dim":
      return [block(s, { opacity: p.opacity === undefined ? "0.3" : String(Number(p.opacity)) })];
    case "move": {
      const out = [block(s, { ...MOVES[p.to], transform: "none" })];
      if (p.unclip) out.push(block(p.unclip.trim(), { overflow: "visible" }));
      return out;
    }
    case "restyle":
      return [block(s, p.declarations)];
  }
  throw new Error(`unhandled action ${rule.action}`);
}

// rules → { css, errors, blocks }. A bad rule is skipped and reported — never half-emitted.
// `blocks` is how many style rules the css must parse into; where a DOM exists, the caller can
// replaceSync the css into a CSSStyleSheet and compare, which catches anything that slipped past
// validation and would swallow the rules after it.
export function compileRules(rules, name = "") {
  const errors = [];
  let blocks = 0;
  const label = name ? `: ${commentSafe(name)}` : "";
  const chunks = [`/* rsd script${label} */`];
  for (const r of rules || []) {
    try {
      const out = compileRuleBlocks(r);
      const why = r.why ? ` — ${commentSafe(r.why)}` : "";
      chunks.push(`/* ${commentSafe(r.id || "?")} ${r.action}${why} */\n${out.join("\n")}`);
      blocks += out.length;
    } catch (e) {
      errors.push({ id: r && r.id, error: e.message });
    }
  }
  return { css: chunks.join("\n\n") + "\n", errors, blocks };
}

// --- match patterns -------------------------------------------------------------------------
// WebExtension match-pattern semantics (what contentScripts.register takes), re-implemented
// because the CSS half is injected from webNavigation.onCommitted and has to decide itself.

// A host is required (`https:///*` would otherwise match every https URL) and a port is refused —
// match patterns have none, and `http://localhost:8088/*` would validate yet never match.
const PATTERN = /^(?:(\*|https?|wss?|ftp):\/\/(\*|\*\.[^/*:]+|[^/*:]+)|(file):\/\/)(\/.*)$/;

export function validateMatch(pattern) {
  if (pattern === "<all_urls>") return null;
  return PATTERN.test(String(pattern || ""))
    ? null
    : `"${pattern}" is not a match pattern (e.g. https://example.com/* or *://*.example.com/videos/*; no port)`;
}

// Patterns that reach (nearly) every site: <all_urls>, any host, or every subdomain of a bare TLD.
// A rule written for one site has no reason to run everywhere; the agent may not save one, and the
// panel says so before it does.
export function isBroadMatch(pattern) {
  if (pattern === "<all_urls>") return true;
  const m = PATTERN.exec(String(pattern || ""));
  if (!m) return false;
  if (m[3]) return true; // file:// — every local file
  const host = m[2];
  return host === "*" || (host.startsWith("*.") && !host.slice(2).includes("."));
}

export function matchPattern(pattern, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (pattern === "<all_urls>") return ["http", "https", "ws", "wss", "file", "ftp"].includes(scheme);
  const m = PATTERN.exec(pattern);
  if (!m) return false;
  const [, ps, ph, fileScheme, pp] = m;
  if (fileScheme) {
    if (scheme !== "file") return false;
  } else {
    if (ps === "*" ? !["http", "https", "ws", "wss"].includes(scheme) : ps !== scheme) return false;
    const host = u.hostname.toLowerCase();
    const want = ph.toLowerCase();
    if (want !== "*") {
      if (want.startsWith("*.")) {
        const base = want.slice(2);
        if (host !== base && !host.endsWith("." + base)) return false;
      } else if (host !== want) return false;
    }
  }
  const glob = new RegExp("^" + pp.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return glob.test(u.pathname + u.search);
}

// The default scope for a new script: the whole site it was written on.
export function defaultMatchFor(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

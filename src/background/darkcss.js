// The dark-mode COMPILER — pure functions, no browser globals, so the same code runs in the
// background page and in tools/dark-check.mjs under Node.
//
// Division of labour (why the model no longer writes the stylesheet): a model handed a bag
// of colours invents selectors it has never seen (`.block-container` was a lucky guess on a
// XenForo forum) and a local model typing 200 lines of CSS inside a JSON string breaks the
// JSON. So the probe (content/restyle-probe.js) records every colour declaration WITH its
// selector, the census (content/paint-census.js) measures what the page actually paints,
// and this module rewrites each declaration through a palette. The model's job shrinks to
// what it is good at: pick the strategy and design the colours — a small JSON `plan`. An
// unparsable reply falls back to DEFAULT_THEME and the page still turns dark; the failure is
// surfaced in `rationale`, never hidden as a silently-ignored sheet.
//
// Strategies:
//   native-theme — set the site's own root hook (class/attribute) and re-emit the rules of its
//                  prefers-color-scheme:dark block unconditionally (the media query itself
//                  follows the OS setting; a stylesheet cannot flip it).
//   recolor      — rewrite every colour declaration by ROLE: backgrounds onto the theme's
//                  base/surface/raised tones by lightness band, dark text onto text/muted,
//                  light borders onto border; chromatic colours keep their hue. Colour tokens
//                  (custom properties) are rewritten at their definition, using the role their
//                  var() consumers gave them, so a token-themed site follows too.

export const DEFAULT_THEME = {
  base: "#121212",
  surface: "#1c1c1e",
  raised: "#26262a",
  text: "#e6e6e6",
  muted: "#a3a3a3",
  border: "#3a3a3e",
  link: "#8ab4f8",
};

// Lists in the model's summary are capped; every cap is printed next to its total.
export const SUMMARY_CAP = { backgrounds: 16, text: 8, colors: 40, tokens: 120, hooks: 20 };

// A colour reads as "light" above this relative luminance (mirrors content/paint-census.js).
export const LIGHT_LUMINANCE = 0.3;

// After a native theme is applied, more than this fraction of the viewport still light means
// the hook did not reach the page (a section palette, a wrapper carrying its own theme) and
// the compile falls back to recolouring. Printed in the button tooltip when it happens.
export const STILL_LIGHT_FRACTION = 0.5;

// ---- colour maths ----------------------------------------------------------

export function parseColor(s) {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    let a = m[4] == null ? 1 : parseFloat(m[4]);
    if (/%$/.test(m[4] || "")) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

export function formatColor(c) {
  const hex = "#" + [c.r, c.g, c.b].map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("");
  if (c.a == null || c.a >= 0.999) return hex;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`;
}

export function rgbToHsl({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

export function hslToRgb({ h, s, l }) {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
}

export function luminance({ r, g, b }) {
  const f = (n) => {
    n /= 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const hsl = (h, s, l, a) => formatColor({ ...hslToRgb({ h, s, l }), a });

// How coloured a colour is, 0..1. HSL saturation is inflated near white (#f0eee6 reads as
// 25% saturated), so "is this a tint or a neutral" is decided on chroma instead.
const chroma = ({ r, g, b }) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

// ---- role mapping ----------------------------------------------------------
// Each mapper returns null when the colour needs no change (already dark background,
// already light text), so the compiler can skip the declaration.

function mapBg(c, theme) {
  const { h, s, l } = rgbToHsl(c);
  if (l < 0.5) return null; // already dark — a maroon header, a black footer: keep
  if (chroma(c) > 0.12) return hsl(h, Math.min(s, 0.45), 0.17, c.a); // a tinted light (a notice, an info box): keep the hue, go dark
  const tone = l >= 0.97 ? theme.base : l >= 0.9 ? theme.surface : theme.raised; // white → base; #f5f5f5/#ebebeb → surface; #e0e0e0 → raised
  return withAlpha(tone, c.a);
}

function mapText(c, theme) {
  const { h, s, l } = rgbToHsl(c);
  if (l >= 0.5) return null; // already light
  if (chroma(c) > 0.15) return hsl(h, Math.min(s, 0.8), 0.72, c.a); // chromatic (links, brand copy): keep hue, lift
  return withAlpha(l <= 0.3 ? theme.text : theme.muted, c.a);
}

function mapBorder(c, theme) {
  const { h, s, l } = rgbToHsl(c);
  if (l < 0.5) return null;
  if (chroma(c) > 0.15) return hsl(h, s * 0.6, 0.3, c.a);
  return withAlpha(theme.border, c.a);
}

function withAlpha(hex, a) {
  if (a == null || a >= 0.999) return hex;
  const c = parseColor(hex);
  return c ? formatColor({ ...c, a }) : hex;
}

// A token's role: what its var() consumers use it for; failing that, its name; failing
// that, its lightness (light tokens are almost always backgrounds, dark ones text).
// "mixed" is a real answer: a raw palette colour used as both a background and a text colour
// (`--color-ivory-light`: light sections' background AND dark sections' text) cannot be
// recoloured at its definition without inverting half its uses — the compiler leaves such a
// token alone and rewrites each consumer by that consumer's own role instead.
export const MIXED_ROLE_SHARE = 0.8; // below this share for the top role a token is "mixed"
export function inferTokenRole(name, used, value) {
  const u = used || {};
  const total = (u.bg || 0) + (u.text || 0) + (u.border || 0);
  const top = ["bg", "text", "border"].sort((a, b) => (u[b] || 0) - (u[a] || 0))[0];
  if (total > 0) {
    // Only background-vs-text is a conflict. A border drawn in the text colour lightens with
    // the text and looks right either way, so border use never makes a token mixed.
    const rival = top === "bg" ? u.text || 0 : top === "text" ? u.bg || 0 : 0;
    if (rival / total > 1 - MIXED_ROLE_SHARE) return "mixed";
    return top;
  }
  if (/bg|background|surface|panel|card|paper|canvas|fill|elevation|layer/i.test(name)) return "bg";
  if (/text|fg|foreground|ink|font|link|heading|copy/i.test(name)) return "text";
  if (/border|divider|line|stroke|outline|rule/i.test(name)) return "border";
  // No consumer, no telling name: leave it alone. Guessing from lightness inverted MDN — its
  // raw greys are consumed only through light-dark() pairs, and lightening the dark ones
  // turned the dark theme's backgrounds light.
  return "?";
}

// Roles flow down definition chains: a token defined as `var(--gray-90)` or
// `light-dark(var(--white), var(--gray-90))` lends its consumers' roles to the tokens it is
// built from. Returns a new name -> used map; iterates so chains of any depth settle.
export function propagateRoles(tokens, chains) {
  const used = new Map();
  for (const t of tokens || []) used.set(t.name, { ...(t.used || { bg: 0, text: 0, border: 0 }) });
  const edges = Object.entries(chains || {});
  for (let pass = 0; pass < 8 && edges.length; pass++) {
    let changed = false;
    for (const [from, refs] of edges) {
      const u = used.get(from);
      if (!u) continue;
      for (const ref of refs) {
        let r = used.get(ref);
        if (!r) {
          r = { bg: 0, text: 0, border: 0 };
          used.set(ref, r);
        }
        for (const k of ["bg", "text", "border"]) {
          const add = (u[k] || 0) - (r["_" + from + k] || 0); // only the increment since last pass
          if (add > 0) {
            r[k] = (r[k] || 0) + add;
            r["_" + from + k] = u[k];
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return used;
}

// A palette entry is honoured only when it points the right way for the role: a model that
// writes "#141413": "#faf9f5" means "this text colour becomes ivory", and applying that to a
// background of the same colour would turn a dark banner light. So a background target must
// be dark and a text target light; otherwise the formula decides.
function paletteFor(role, key, palette) {
  const to = palette[key];
  if (to == null) return null;
  const c = parseColor(to);
  if (!c) return null;
  const light = luminance(c) > LIGHT_LUMINANCE;
  if (role === "bg" && light) return null;
  if (role === "text" && !light) return null;
  return to;
}

function mapByRole(role, value, theme, palette) {
  const c = parseColor(value);
  if (!c) return null;
  const key = formatColor({ ...c, a: 1 });
  const pinned = paletteFor(role, key, palette);
  if (pinned) return withAlpha(pinned, c.a);
  if (role === "bg") return mapBg(c, theme);
  if (role === "text") return mapText(c, theme);
  if (role === "border") return mapBorder(c, theme);
  return null;
}

// ---- the plan (what the model returns) -------------------------------------

function stripFence(s) {
  const m = String(s || "").match(/```(?:css|json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : s || "").trim();
}

export function defaultPlan(rationale) {
  return { strategy: "recolor", theme: { ...DEFAULT_THEME }, palette: {}, rootAttributes: {}, rootClasses: [], css: "", rationale: rationale || "", parsed: false };
}

// Defensive parse: a bare JSON object is asked for; a fenced one is accepted. Anything else
// yields the default plan with the failure named in `rationale` — never CSS made of garbage.
export function parsePlan(text) {
  const t = stripFence(text);
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  let obj = null;
  if (s !== -1 && e > s) {
    try {
      obj = JSON.parse(t.slice(s, e + 1));
    } catch (_) {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return defaultPlan("model reply was not a JSON plan — compiled with the default theme");
  const strategy = obj.strategy === "native-theme" ? "native-theme" : "recolor"; // legacy token-override/brute-force → recolor
  const theme = { ...DEFAULT_THEME };
  if (obj.theme && typeof obj.theme === "object") {
    for (const k of Object.keys(DEFAULT_THEME)) {
      const c = parseColor(obj.theme[k]);
      if (c) theme[k] = formatColor(c);
    }
  }
  const palette = {};
  if (obj.palette && typeof obj.palette === "object" && !Array.isArray(obj.palette)) {
    for (const [from, to] of Object.entries(obj.palette)) {
      const f = parseColor(from);
      const tc = parseColor(to);
      if (f && tc) palette[formatColor({ ...f, a: 1 })] = formatColor(tc);
    }
  }
  return {
    strategy,
    theme,
    palette,
    rootAttributes: obj.rootAttributes && typeof obj.rootAttributes === "object" && !Array.isArray(obj.rootAttributes) ? obj.rootAttributes : {},
    rootClasses: Array.isArray(obj.rootClasses) ? obj.rootClasses.filter((c) => typeof c === "string") : [],
    css: typeof obj.css === "string" ? stripFence(obj.css) : "",
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    parsed: true,
  };
}

// ---- the summary (what the model sees) -------------------------------------

function capList(list, n) {
  const arr = Array.isArray(list) ? list : [];
  return arr.length > n ? { shown: n, total: arr.length, items: arr.slice(0, n) } : arr;
}

export function summarize(probe, census) {
  const p = probe || {};
  const c = census && census.ok ? census : null;
  const used = propagateRoles(p.tokens, p.chains);
  const tokens = (p.tokens || []).map((t) => ({ name: t.name, values: t.values, role: inferTokenRole(t.name, used.get(t.name), t.computed || t.values[0]) }));
  const colorTokens = tokens.filter((t) => t.role !== "?"); // "mixed" stays: the model should see the site's raw palette
  return {
    url: p.url,
    title: p.title,
    root: p.root,
    metaColorScheme: p.metaColorScheme || "",
    painted: c
      ? {
          lightFraction: c.lightFraction,
          canvas: c.canvas,
          backgrounds: capList(c.backgrounds, SUMMARY_CAP.backgrounds),
          text: capList(c.text, SUMMARY_CAP.text),
        }
      : null,
    hooks: capList(p.hooks, SUMMARY_CAP.hooks),
    prefersDarkRules: (p.counts && p.counts.prefersDarkRules) || 0,
    lightDarkDecls: (p.counts && p.counts.lightDarkDecls) || 0,
    sectionThemes: p.themeAttrs || {},
    tokens: capList(colorTokens, SUMMARY_CAP.tokens),
    colors: {
      bg: capList((p.colors && p.colors.bg) || [], SUMMARY_CAP.colors),
      text: capList((p.colors && p.colors.text) || [], SUMMARY_CAP.colors),
      border: capList((p.colors && p.colors.border) || [], SUMMARY_CAP.colors),
    },
    landmarks: p.landmarks || {},
    sheets: p.sheets,
    rules: p.counts,
    notes: p.notes || [],
  };
}

// ---- the compiler ----------------------------------------------------------

function emit(wrap, sel, decls) {
  return wrap.map((w) => w + "{").join("") + sel + "{" + decls.join(";") + "}" + "}".repeat(wrap.length);
}

function safetyNet(probe, census, theme) {
  const out = [];
  const lm = (probe && probe.landmarks) || {};
  const rootBg = parseColor((lm[":root"] || {}).bg);
  const bodyBg = parseColor((lm.body || {}).bg);
  const bodyFg = parseColor((lm.body || {}).fg);
  const canvasLight = (col) => !col || col.a < 0.99 || luminance(col) > LIGHT_LUMINANCE;
  // The canvas: if neither html nor body paints something dark, the default white shows.
  if (canvasLight(rootBg) && canvasLight(bodyBg)) out.push(`html{background-color:${theme.base} !important}`);
  if (bodyBg && bodyBg.a >= 0.99 && luminance(bodyBg) > LIGHT_LUMINANCE) out.push(`body{background-color:${theme.base} !important}`);
  if (!bodyFg || luminance(bodyFg) <= LIGHT_LUMINANCE) out.push(`body{color:${theme.text} !important}`);
  return out;
}

// probe: the restyle-probe result; census: the paint-census result (may be null); plan: a
// parsed plan. Returns { css, stats } — the sheet to inject and what it was built from.
export function compileSheet(probe, census, plan) {
  const theme = { ...DEFAULT_THEME, ...((plan && plan.theme) || {}) };
  const palette = (plan && plan.palette) || {};
  const strategy = plan && plan.strategy === "native-theme" ? "native-theme" : "recolor";
  const out = [":root{color-scheme:dark !important}"];
  const stats = { strategy, rules: 0, decls: 0, skipped: 0, tokens: 0, consumers: 0 };

  if (strategy === "native-theme") {
    for (const r of probe.darkMedia || []) {
      const decls = r.d.map((d) => `${d.p}:${d.v} !important`);
      if (!decls.length) continue;
      out.push(emit(r.wrap || [], r.sel, decls));
      stats.rules++;
      stats.decls += decls.length;
    }
  } else {
    out.push(...safetyNet(probe, census, theme));
    const tokenRole = new Map(); // name -> bg | text | border | mixed | ?
    const tokenValue = new Map(); // name -> what a consumer resolves to right now
    const inPlace = new Set(); // tokens whose consumers must be rewritten where they are used
    const used = propagateRoles(probe.tokens, probe.chains);
    for (const t of probe.tokens || []) {
      const role = inferTokenRole(t.name, used.get(t.name), t.computed || t.values[0]);
      tokenRole.set(t.name, role);
      // The value in force on the root (the probe read it computed); a token only defined
      // inside sections has none there, so fall back to its first definition.
      const value = t.computed || t.values[0];
      if (value) tokenValue.set(t.name, value);
      // Mixed-role tokens cannot be recoloured at their definition; chain tokens
      // (`--body-bg: var(--white)`) have no literal definition to recolour at all.
      if (role === "mixed" || !t.values.length) inPlace.add(t.name);
    }
    for (const r of probe.paint || []) {
      const decls = [];
      for (const d of r.d) {
        let mapped = null;
        if (d.var) {
          // A consumer of a token. Single-role tokens are rewritten at their definition and the
          // consumer follows; a mixed token is resolved here and mapped by THIS use's role.
          if (inPlace.has(d.var) && tokenValue.has(d.var)) {
            const role = { color: "text", "text-decoration-color": "text", "caret-color": "text", "background-color": "bg" }[d.p] || "border";
            mapped = mapByRole(role, tokenValue.get(d.var), theme, palette);
            if (mapped) stats.consumers++;
          }
        } else if (d.p.startsWith("--")) {
          const role = tokenRole.get(d.p) || "?";
          mapped = role === "?" || inPlace.has(d.p) ? null : mapByRole(role, d.v, theme, palette);
          if (mapped) stats.tokens++;
        } else if (d.p === "background-image") {
          let v = d.v;
          let changed = false;
          for (const x of d.colors || []) {
            const m = mapByRole("bg", x.c, theme, palette);
            if (!m) continue;
            v = v.split(x.s).join(m);
            changed = true;
          }
          mapped = changed ? v : null;
        } else {
          const role = { color: "text", "text-decoration-color": "text", "caret-color": "text", "background-color": "bg" }[d.p] || "border";
          mapped = mapByRole(role, d.v, theme, palette);
        }
        if (mapped) decls.push(`${d.p}:${mapped} !important`);
        else stats.skipped++;
      }
      if (!decls.length) continue;
      out.push(emit(r.wrap || [], r.sel, decls));
      stats.rules++;
      stats.decls += decls.length;
    }
  }
  if (plan && plan.css) out.push(plan.css);
  return { css: out.join("\n"), stats };
}

// Cheap stable fingerprint of the seams that matter, so a later visit can tell a redesign
// from the page it compiled for. (Stored now; compared on demand.)
export function hashProbe(probe) {
  const basis = JSON.stringify({
    t: (probe.tokens || []).map((t) => t.name),
    h: (probe.hooks || []).map((h) => h.sel),
    b: ((probe.colors && probe.colors.bg) || []).slice(0, 20).map((c) => c.value),
  });
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

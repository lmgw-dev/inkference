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

// Put a replacement colour back into the shape the site wrote, when the site's alpha came from a
// live token: `rgb(255 255 255/var(--tw-bg-opacity,1))` → `rgb(18 18 18/var(--tw-bg-opacity,1))`.
// Writing a flat colour instead would be wrong, not merely untidy — the token is what Tailwind's
// `/50` modifiers set, so a `bg-black/50` modal backdrop would become fully opaque and cover the
// page. The channels go out space-separated whatever the source function was (`hsl(…/var(…))`
// included): that is one well-formed colour, and the alpha expression is the probe's own capture
// of a value the browser already parsed, so it cannot break out of the declaration.
// A mapping that is itself translucent keeps its own alpha and the token is dropped — two alphas
// cannot both apply, and the one we chose is the one that carries the design.
function withAlphaVar(value, alpha) {
  const c = parseColor(value);
  if (!c || (c.a != null && c.a < 0.999)) return value;
  return `rgb(${c.r} ${c.g} ${c.b}/${alpha})`;
}

// A token's role: what its var() consumers use it for; failing that, its name; failing
// that, its lightness (light tokens are almost always backgrounds, dark ones text).
// "mixed" is a real answer: a raw palette colour used as both a background and a text colour
// (`--color-ivory-light`: light sections' background AND dark sections' text) cannot be
// recoloured at its definition without inverting half its uses — the compiler leaves such a
// token alone and rewrites each consumer by that consumer's own role instead.
export const MIXED_ROLE_SHARE = 0.8; // below this share for the top role a token is "mixed"
// How much of the evidence must be the token's OWN before it outranks what it was lent.
export const DIRECT_ROLE_SHARE = 0.25;
export function inferTokenRole(name, used, value) {
  const all = used || {};
  // A token's OWN consumers outrank BORROWED ones, once they are a real share of the evidence.
  // `propagateRoles` lends a token the roles of the tokens built from it, which is what lets a
  // raw grey consumed only through `light-dark()` be classified at all — but a token that has
  // enough consumers of its own already holds the better answer, and letting the loan outvote
  // it inverts the role outright.
  // Measured on an IMDb title page: `--ipt-on-base-color` IS the body text colour — value
  // #000000, 27 `color:` consumers — while `--ipt-focus-outline-on-base-default` is defined as
  // `var(--ipt-on-base-color)` and drawn 33× as a focus ring. Merged, that reads border 34 vs
  // text 28, so the role came out `border`; `mapBorder` leaves an already-dark colour alone, so
  // the token was rewritten NOWHERE — not at its definitions, not at the root — and every light
  // section kept pure black text on the background we had just turned dark.
  // The share is what keeps the correction from overshooting the other way: `--ipt-base-color`
  // is the page's base SURFACE, with 59 of its 63 uses lent to it by the shade tokens built
  // from it and only 4 of its own. Four uses are not evidence against sixty, and treating them
  // as such turned the site's main background token into "mixed" and dropped its root pin.
  const own = all.direct;
  const ownTotal = own ? (own.bg || 0) + (own.text || 0) + (own.border || 0) : 0;
  const allTotal = (all.bg || 0) + (all.text || 0) + (all.border || 0);
  const u = ownTotal > 0 && ownTotal >= allTotal * DIRECT_ROLE_SHARE ? own : all;
  const total = (u.bg || 0) + (u.text || 0) + (u.border || 0);
  const top = ["bg", "text", "border"].sort((a, b) => (u[b] || 0) - (u[a] || 0))[0];
  if (total > 0) {
    // Text use is what cannot be overruled, and the conflict is ASYMMETRIC. A border drawn in
    // the text colour lightens with the text and looks right either way, so a token that is
    // mostly text stays text however often it is also a border. The reverse is not true: the
    // border colour is picked to be a quiet divider, so it has no contrast against the surface
    // BY DESIGN, and text painted with it cannot be read. Measured on Stack Overflow:
    // `--black-300` (#babfc5) is drawn 11× as a border and 7× as text; it came out `border`,
    // was recoloured at its definition to the theme's border tone, and its 7 text consumers
    // became 32 runs of #3a3a3e text on the #0c0d0e page — 0% light by the census, unreadable
    // to a reader. As `mixed` it is left alone at the definition and each consumer is rewritten
    // by its own use, so the borders stay borders and the text becomes text.
    const rival = top === "bg" ? u.text || 0 : top === "text" ? u.bg || 0 : u.text || 0;
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
  // `direct` keeps the token's OWN consumer counts, untouched by what the loop below adds, so
  // `inferTokenRole` can tell evidence from a loan. Without it a derived token's uses are
  // indistinguishable from the parent's and can outvote them — see inferTokenRole.
  for (const t of tokens || []) {
    const own = { ...(t.used || { bg: 0, text: 0, border: 0 }) };
    used.set(t.name, { ...own, direct: own });
  }
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
          // The second, document-wide reading. It is in the summary and not only in `verify`
          // because the model DESIGNS from `painted`: a page with a tall dark hero over a white
          // body measures 0% light in the viewport, so without this the summary described a page
          // that is already dark and the plan was built for that page (IMDb's title pages).
          docLightFraction: c.docLightFraction,
          docBackgrounds: capList(c.docBackgrounds || [], SUMMARY_CAP.backgrounds),
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

// Does every selector in this list end on an image? The subject of `.tile a img` is the image,
// so a background there belongs to the picture. A list is only treated as one when ALL of its
// selectors are (`.tile, .tile img` still paints a real surface).
const IMG_SUBJECT = /(?:^|[\s>+~])(?:img|picture|video)(?:[.#:[][^\s>+~]*)?$/i;
function imageSubject(sel) {
  const parts = String(sel || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((s) => IMG_SUBJECT.test(s));
}

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
    const isLight = (c) => {
      const p = parseColor(c);
      return !!p && p.a >= 0.5 && luminance(p) > LIGHT_LUMINANCE;
    };
    for (const r of probe.paint || []) {
      const decls = [];
      const imgSel = imageSubject(r.sel);
      for (const d of r.d) {
        // A background on an IMAGE is the picture's backdrop, not a surface of the page: a
        // transparent PNG/AVIF has no background of its own, so the colour behind it is part
        // of the picture and darkening it is what makes the product disappear. (An icon drawn
        // as a data-URI SVG still gets recoloured — that is the glyph, role "text".)
        if (imgSel && (d.p === "background-color" || (d.p === "background-image" && d.role !== "text"))) {
          stats.skipped++;
          continue;
        }
        let mapped = null;
        if (d.var) {
          // A consumer of a token. Single-role tokens are rewritten at their definition and the
          // consumer follows; a mixed token is resolved here and mapped by THIS use's role.
          const role = { color: "text", "text-decoration-color": "text", "caret-color": "text", "background-color": "bg" }[d.p] || "border";
          if (inPlace.has(d.var) && tokenValue.has(d.var)) {
            mapped = mapByRole(role, tokenValue.get(d.var), theme, palette);
            if (mapped) stats.consumers++;
          } else if (d.fb && !tokenValue.has(d.var)) {
            // `var(--token, #fff)` where the token is defined NOWHERE: the fallback literal is
            // what actually paints, and nothing else will ever recolour it — the definition we
            // would have rewritten does not exist. Guarded on the token being unknown to the
            // probe, so a token that IS defined keeps winning through its own definition.
            mapped = mapByRole(role, d.fb, theme, palette);
            if (mapped) stats.consumers++;
          }
        } else if (d.colors) {
          // Checked BEFORE the token branch: a custom property can hold an icon rather than a
          // colour (`--left-arrow-button: url("data:image/svg+xml,…")`), and that value is
          // substituted the same way as any other multi-part one, not mapped as a colour.
          // A multi-part value (gradient stops, a shadow's colour, an icon SVG's paint):
          // substitute colour by colour and keep the rest of the value. `bg` only ever darkens
          // a light colour, so an ordinary dark drop shadow passes through untouched; a data-URI
          // icon comes in with role "text", so its dark glyph is lightened to stay readable on
          // the surface we just darkened, and an already-light glyph is left alone.
          const partRole = d.role === "text" ? "text" : "bg";
          let v = d.v;
          let changed = false;
          for (const x of d.colors || []) {
            const m = mapByRole(partRole, x.c, theme, palette);
            if (!m) continue;
            // `%23rrggbb` inside a data URI: put the replacement back in the same spelling, and
            // leave the colour alone if the mapping is not a hex one that can be written that way.
            const repl = x.pct ? (m[0] === "#" ? "%23" + m.slice(1) : null) : m;
            if (!repl) continue;
            v = v.split(x.s).join(repl);
            changed = true;
          }
          mapped = changed ? v : null;
        } else if (d.p.startsWith("--")) {
          const role = tokenRole.get(d.p) || "?";
          mapped = role === "?" || inPlace.has(d.p) ? null : mapByRole(role, d.v, theme, palette);
          if (mapped) stats.tokens++;
        } else {
          const role = { color: "text", "text-decoration-color": "text", "caret-color": "text", "background-color": "bg" }[d.p] || "border";
          mapped = mapByRole(role, d.v, theme, palette);
        }
        // One place for every branch above, so a token DEFINITION written this way
        // (`--surface: rgb(255 255 255/var(--op,1))`) is restored the same as a plain declaration.
        if (mapped && d.alpha) mapped = withAlphaVar(mapped, d.alpha);
        if (mapped) decls.push(`${d.p}:${mapped} !important`);
        else stats.skipped++;
      }
      if (!decls.length) continue;
      out.push(emit(r.wrap || [], r.sel, decls));
      stats.rules++;
      stats.decls += decls.length;
    }

    // A token can be IN FORCE at the root with no declaration we are able to rewrite. The loop
    // above only ever rewrites declarations the probe SAW, so a root value that comes from
    // somewhere no readable rule sets leaves every consumer painting the old colour — and the
    // site's own rules keep working, so nothing looks broken, the page just stays light.
    // Measured on an IMDb title page: `--ipt-base-bg` computes to white on <html>, while the
    // only declarations of it the probe found sit on four hashed styled-components classes that
    // are NOT ancestors of the white sections, so rewriting them changed nothing — the page
    // stayed 93% document-light with 214 of our rules applied. Defining the same tokens at
    // :root took it to 1%.
    //
    // So every token the compiler has already decided to rewrite is ALSO emitted at the root,
    // with the value in force there. This adds no new decision: same role, same mapping, same
    // tokens — only a place to put them where nothing else does. Held back are only the tokens
    // whose consumers are rewritten in place anyway (mixed or chain — `inPlace`).
    //
    // A token the site RE-POINTS inside a section (GitHub's dark header) needs no guard here,
    // which is worth knowing because the obvious guard is wrong: a root pin can never override a
    // section's own declaration of the same token, `!important` or not. The two declarations
    // apply to DIFFERENT elements — ours to <html>, the site's to the section — and a descendant
    // inherits from the nearest ancestor that has a value. Importance only settles a conflict on
    // one element; proximity settles this one. Measured on a fixture that re-points a token to
    // #24292f inside a section: with the root pinned to #121212 the section still computes
    // #24292f.
    const rootDecls = [];
    for (const t of probe.tokens || []) {
      if (inPlace.has(t.name)) continue;
      const role = tokenRole.get(t.name) || "?";
      if (role === "?") continue;
      const value = t.computed || (t.values || [])[0];
      const mapped = value && mapByRole(role, value, theme, palette);
      if (mapped) rootDecls.push(`${t.name}:${mapped} !important`);
    }
    if (rootDecls.length) {
      out.push(`:root{${rootDecls.join(";")}}`);
      stats.rules++;
      stats.decls += rootDecls.length;
      stats.rootTokens = rootDecls.length;
    }

    // The surface goes dark, but a transparent picture keeps the backdrop it was drawn for.
    // The probe reports an image that covers a real share of the surface painting behind it,
    // together with every colour that surface takes across the elements the selector reaches;
    // the backdrop is honoured only if they are ALL light, so an image that was already on a
    // dark surface (a sprite in a dark nav) keeps it. The selector is built by the probe from
    // class names that are CSS identifiers already, and its shape is re-checked here because
    // this string goes into our stylesheet.
    for (const b of probe.imageBackdrops || []) {
      const colors = (b.colors || []).filter(Boolean);
      if (!b.sel || !/^(?:\.[\w-]+)+ img$/.test(b.sel)) continue;
      if (!colors.length || !colors.every(isLight)) continue;
      // A multiply/darken blend assumes the light surface we just took away; against a dark one
      // it swallows the picture AND the backdrop, so it is switched off together with them.
      const decl = `background-color:${colors[0]} !important` + (b.blend ? ";mix-blend-mode:normal !important" : "");
      out.push(`${b.sel}{${decl}}`);
      stats.rules++;
      stats.decls++;
      stats.backdrops = (stats.backdrops || 0) + 1;
    }

    // A small control whose content is a RASTER icon keeps its surface colour: the glyph lives
    // in a sprite we cannot read, let alone recolour, so darkening what it sits on is the one
    // change that makes it disappear for good. Honoured only where every element the selector
    // reaches is light today, so a control that was always dark is not relit. The selector's
    // shape is re-checked here because this string goes into our stylesheet.
    for (const s of probe.iconSurfaces || []) {
      const colors = (s.colors || []).filter(Boolean);
      if (!s.sel || !/^(?:\.[\w-]+)+$/.test(s.sel)) continue;
      if (!colors.length || !colors.every(isLight)) continue;
      out.push(`${s.sel}{background-color:${colors[0]} !important}`);
      stats.rules++;
      stats.decls++;
      stats.iconSurfaces = (stats.iconSurfaces || 0) + 1;
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

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

// Below this, a translucent fill is a TINT over whatever is behind it (a hover wash, a pressed
// state); at or above it, it is a cover with an intent of its own (a modal scrim, a legibility
// gradient over a photo) and must keep darkening.
const OVERLAY_ALPHA = 0.25;
function mapBg(c, theme, interactive) {
  const { h, s, l } = rgbToHsl(c);
  // A translucent wash is defined by what it DOES, not by what colour it is, and on a dark page
  // "darken slightly" does nothing a reader can see. `rgba(35,39,47,.05)` over white is the
  // standard hover tint; over #121212 it is invisible, and because the colour is already dark
  // the branch below returned null, so the site's own rule stayed and the hover state was gone.
  // Measured on react.dev: of 36 :hover rules carrying a colour, the ones left untouched are
  // washes of exactly this shape (`.hover\:bg-primary\/5`, `rgba(0,0,0,.2)` on the search hits).
  // Mapped to a light wash of the same alpha it does on a dark page what it did on a light one.
  // Note this only matters because our sheet is injected `cssOrigin:"user"`: there our base rule
  // beats the site's :hover rule outright, so a hover we fail to translate is not merely untouched
  // — it is suppressed. (dark-check injects a plain <style>, i.e. author origin, which is why this
  // class of damage does not show up in its numbers at all.)
  // Chromatic washes keep their hue and are lifted instead: a blue selection tint is still blue.
  // ONLY in an interaction rule (:hover/:focus/:active/…), and that restriction is not caution,
  // it is the premise: flipping a wash to light assumes the surface under it is now dark, and
  // that holds for a hover state on a surface we recoloured, not for a wash baked into a surface
  // we left alone. Measured on github.com when this applied everywhere: its logged-out marketing
  // header, a white bar our sheet already misses, went from 5% to 12% light and gained 9 runs of
  // #e6e6e6 on #ffffff — we had lightened the wash sitting on white. A static wash needs no
  // special case anyway: whatever it sits on is mapped on its own terms.
  // No lightness test: ANY wash this faint is a state signal, and on a dark page it can only be
  // seen if it lightens. A first version required `l < 0.5` and missed react.dev's outlined
  // buttons, whose wash is `rgba(120,131,155,.05)` — mid grey-blue at l≈0.54, just over the line.
  // It fell through to the bands below, became `raised` at 5% alpha, and was invisible. A wash
  // that is ALREADY light stays light by this rule too, which is what it should do.
  if (interactive && c.a != null && c.a < OVERLAY_ALPHA) {
    return chroma(c) > 0.12 ? hsl(h, Math.min(s, 0.6), 0.7, c.a) : `rgba(255,255,255,${c.a})`;
  }
  if (l < 0.5) return null; // already dark — a maroon header, a black footer: keep
  if (chroma(c) > 0.12) return hsl(h, Math.min(s, 0.45), 0.17, c.a); // a tinted light (a notice, an info box): keep the hue, go dark
  const tone = l >= 0.97 ? theme.base : l >= 0.9 ? theme.surface : theme.raised; // white → base; #f5f5f5/#ebebeb → surface; #e0e0e0 → raised
  return withAlpha(tone, c.a);
}

// "Light enough to leave alone" is a question about CONTRAST against the page we are building,
// and HSL lightness is a poor stand-in for it. A saturated mid colour clears l >= 0.5 while
// being far too dark to read on #121212: react.dev's syntax highlighting is #6f42c1 at l = 0.508,
// so it was left untouched and came out at 2.5:1 — 20 runs the census duly reported as
// unreadable while the compiler thought it had done its job. The census grades by WCAG contrast
// and counts under 3:1, so that is the test the mapping has to answer to, with the theme's own
// base as the surface. Anything that already clears the bar is still left exactly as it is.
const TEXT_MIN_CONTRAST = 3;
function contrastOn(c, bg) {
  const b = parseColor(bg);
  if (!b) return Infinity; // unknown surface: do not second-guess the colour
  const [hi, lo] = [luminance(c), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function mapText(c, theme) {
  const { h, s, l } = rgbToHsl(c);
  if (l >= 0.5 && contrastOn(c, theme.base) >= TEXT_MIN_CONTRAST) return null; // already readable
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
  // The loan is weighed in its SPLIT form (`scaled`, from propagateRoles), because a slot filled
  // by 30 different sources lends the same count to each and so inflates the evidence 30-fold.
  // Without this, Tailwind's palette lost to `--tw-gradient-from`: 21 own uses against 217
  // borrowed is under the 25% the guard needs, so `--color-pink-500` — a text colour by its own
  // consumers — was classified `bg` and darkened at its definition. Only the THRESHOLD uses the
  // split count; `u` itself stays the plain one, so a token with no evidence of its own is
  // decided exactly as before.
  const lent = all.scaled || all;
  const allTotal = (lent.bg || 0) + (lent.text || 0) + (lent.border || 0);
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
    // A `bg` token that `mapBg` would leave ALONE cannot help its text consumers, and the share
    // test above does not catch it, because the question is not how the evidence splits — it is
    // that one side of the split gets no treatment at all. `mapBg` returns null for an already
    // dark colour (a maroon header, a black footer: keep), so such a token is rewritten NOWHERE,
    // not at its definition and not at its consumers, while the page around it becomes dark.
    // Every text use it has is then dark-on-dark by construction. Measured on tailwindcss.com:
    // `--color-gray-950` is #030712 with bg 45, text 12, border 16 — a text share of 16%, just
    // under the 20% that tips a token to `mixed` — and it paints the h1, so "Rapidly build
    // modern websites" stood at #030712 on #121212, a contrast of 1.04:1.
    // `mixed` is the safe answer and costs nothing here: the definition stays untouched, which
    // is what `bg` did anyway, and each consumer is rewritten by its own use — background
    // consumers still map to null and keep their colour, text consumers get lifted.
    if (top === "bg" && (u.text || 0) > 0) {
      const c = parseColor(value);
      if (c && rgbToHsl(c).l < 0.5) return "mixed";
    }
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
  // `scaled` is deliberately NOT seeded with the token's own counts, so it holds the LOANS alone
  // (in split form). The threshold in inferTokenRole then asks "is my own evidence a real share
  // of what I was LENT", not "…of everything I have", and that is the question the guard exists
  // for. Seeding it with `own` — which reads more natural, and which I tried — measured worse on
  // every page that moves: mediamarkt.de 61 → 194 unreadable, cloudflare.com 1 → 10. Left as it
  // is on the measurement, not on the prose.
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
      // A token built from MANY sources is a SLOT, not a derivative, and its uses are evidence
      // about NONE of them in particular. So a second, SPLIT count is kept beside the plain one
      // — `scaled` — and `inferTokenRole` uses it for exactly one question: may this loan
      // outvote the token's OWN consumers? Lending the full count multiplies the evidence: Tailwind writes
      // `.from-pink-500 { --tw-gradient-from: var(--color-pink-500) }`, so one slot is filled by
      // 19–30 different palette colours, and `--tw-gradient-from`'s 66 background uses became
      // 66 votes for EVERY one of them. Measured on tailwindcss.com: `--color-pink-500` has its
      // own {bg:6, text:10, border:5} — a text colour — and came out of propagation at bg:202,
      // from `--tw-gradient-from` (66), `--tw-gradient-to` (66) and `--tw-ring-color` (63).
      // Role `bg`, so `mapBg` darkened it at its definition, and `.text-pink-500` became #3f182c
      // on #121212. 80 of 110 text runs unreadable at a census-perfect 0% light — the same
      // signature as the IMDb bug, and `DIRECT_ROLE_SHARE` could not catch it, because 21 own
      // uses against 217 borrowed is under the 25% the guard needs. Splitting restores it: the
      // loan drops to ~6, the token's own consumers win, and text vs bg makes it `mixed` — the
      // right answer for a palette entry, which genuinely is both.
      // The split is kept SEPARATE rather than applied to the counts themselves, and that is not
      // tidiness — splitting the real counts changes answers it has no business changing. Most
      // tokens on a big design system have NO consumers of their own and are classified purely by
      // what they are lent; for those the loan is not a rival to weigh, it is the only evidence
      // there is. Dividing it rescales each source by how many SIBLINGS it happens to have, so a
      // bg loan arriving through a 2-source chain beats a border loan through a 20-source one for
      // no reason that has anything to do with the page. Measured on mediamarkt.de: splitting the
      // counts flipped 86 token roles, 41 of them `bg`→`border`, nearly all on tokens whose own
      // use was {0,0,0} — and unreadable text went 32 → 180 of 353 while the page went 16% → 0%
      // light. More surfaces darkened, their text not carried along: the IMDb signature again,
      // caused by the repair for it.
      // Against the token's own evidence the split is exactly right, and there it costs nothing:
      // `light-dark(var(--gray-90), var(--gray-10))` divides both branches by the same 2, and a
      // real derivative with a single source (IMDb's focus ring) divides by 1.
      const share = refs.length || 1;
      for (const ref of refs) {
        let r = used.get(ref);
        if (!r) {
          r = { bg: 0, text: 0, border: 0, scaled: { bg: 0, text: 0, border: 0 } };
          used.set(ref, r);
        }
        if (!r.scaled) r.scaled = { bg: 0, text: 0, border: 0 };
        for (const k of ["bg", "text", "border"]) {
          const add = (u[k] || 0) - (r["_" + from + k] || 0); // only the increment since last pass
          if (add > 0) {
            r[k] = (r[k] || 0) + add;
            r["_" + from + k] = u[k];
            changed = true;
          }
          // The SPLIT count, kept alongside and used for one question only — see below. It is
          // fed from the source's own split count, so a division compounds down a chain.
          const lent = ((u.scaled ? u.scaled[k] : u[k]) || 0) / share;
          const addS = lent - (r["_s" + from + k] || 0);
          // Fractions, so the increment is compared against an epsilon rather than 0: a
          // vanishing remainder must not keep the loop reporting `changed`.
          if (addS > 1e-6) {
            r.scaled[k] = (r.scaled[k] || 0) + addS;
            r["_s" + from + k] = lent;
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

function mapByRole(role, value, theme, palette, interactive) {
  const c = parseColor(value);
  if (!c) return null;
  const key = formatColor({ ...c, a: 1 });
  const pinned = paletteFor(role, key, palette);
  if (pinned) return withAlpha(pinned, c.a);
  if (role === "bg") return mapBg(c, theme, interactive);
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
    const rootDefined = new Set(); // tokens actually in force on the root (see below)
    // Tokens the probe found NO definition for, while the browser reports a value on the root:
    // pinned there in addition to being rewritten at their consumers (see below).
    const pinUndefined = new Set();
    const used = propagateRoles(probe.tokens, probe.chains);
    for (const t of probe.tokens || []) {
      const role = inferTokenRole(t.name, used.get(t.name), t.computed || t.values[0]);
      tokenRole.set(t.name, role);
      // The value in force on the root (the probe read it computed); a token only defined
      // inside sections has none there, so fall back to its first definition.
      const value = t.computed || t.values[0];
      if (value) tokenValue.set(t.name, value);
      // IN FORCE AT THE ROOT is a different question from "defined somewhere", and a var()
      // fallback turns on exactly that difference: `var(--themed-bg, …)` takes the fallback
      // everywhere the token is not in scope. `tokenValue` cannot answer it — it falls back to
      // the first definition — so the distinction is kept separately.
      if (t.computed) rootDefined.add(t.name);
      // Mixed-role tokens cannot be recoloured at their definition; chain tokens
      // (`--body-bg: var(--white)`) have no literal definition to recolour at all.
      // "No literal value" is two different situations, and lumping them together cost a whole
      // class of pages. A CHAIN has definitions, just none with a literal in them (defs > 0) —
      // its consumers are rewritten in place and the tokens it is built from carry the colour.
      // A token with defs === 0 has no definition the probe could find AT ALL, while the browser
      // reports a value for it on the root: vercel.com's `--ds-background-100` reads #ffffff
      // computed, is `bg` by 83 background uses, and has defs 0 — its definition lives somewhere
      // the stylesheet walk never reaches. Treated as a chain it was held back from the root
      // pins, and since there are no definitions to rewrite either, it was recoloured NOWHERE.
      // That is why vercel.com's header buttons stayed white on the dark page: they set
      // `--themed-bg: var(--ds-background-100)` through a utility class, so the white arrived
      // through a token the compiler had quietly excluded from every path it has.
      // For that token the root pin is not one option among several — it is the only one, and it
      // is safe: a section that re-points the token still wins there by proximity (a root
      // declaration cannot override a nearer one, importance or not).
      if (role === "mixed" || !t.values.length) inPlace.add(t.name);
      // …and such a token is ALSO pinned at the root, which is not a contradiction: the two
      // reach different elements. The consumer rules carry every use the probe actually saw,
      // including those inside a section that re-points the token; the pin carries everything it
      // did not see. Choosing between them is what broke github.com — moving these tokens from
      // `inPlace` to the pins alone dropped their consumer rules and left the page 87% light
      // with 70 unreadable runs, because its header re-points tokens per section and a root pin
      // cannot reach past a nearer declaration. Doing both costs one declaration per token.
      if (role !== "mixed" && !t.values.length && !t.defs && t.computed) pinUndefined.add(t.name);
    }
    const isLight = (c) => {
      const p = parseColor(c);
      return !!p && p.a >= 0.5 && luminance(p) > LIGHT_LUMINANCE;
    };
    for (const r of probe.paint || []) {
      const decls = [];
      // An interaction rule: its colours describe a STATE, not the surface itself. Only there is
      // a translucent wash flipped (see mapBg) — `:hover` and friends, plus the attribute form
      // frameworks emit (`[data-state=hover]`, `[aria-selected=true]`).
      const interactive = /:(hover|focus|focus-visible|focus-within|active|checked|target)\b|\[(data-[\w-]*(state|hover|active|selected|pressed)|aria-(selected|pressed|current))/i.test(
        String(r.sel || "")
      );
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
          // The fallback is tested FIRST, because which of the two paints is not a preference —
          // it is settled by whether the outer token is in force here at all. `--themed-bg` is
          // set only inside themed sections, so on the rest of the page `var(--themed-bg,
          // var(--ds-gray-1000))` IS `--ds-gray-1000`, and reasoning about `--themed-bg` there
          // describes a value no element has. Ordering this after the inPlace branch hid the
          // whole case on vercel.com: `--themed-bg` is `mixed` (bg 2, text 1), so that branch
          // claimed the declaration, `mapBg` answered null for its orange, and the button was
          // left exactly as the site shipped it — white on a dark page, together with "Log In"
          // and every other button written this way.
          // The fallback is tested FIRST, because which of the two paints is not a preference —
          // it is settled by whether the outer token is in force here at all. `--themed-bg` is
          // set only inside themed sections, so on the rest of the page `var(--themed-bg,
          // var(--ds-gray-1000))` IS `--ds-gray-1000`, and reasoning about `--themed-bg` there
          // describes a value no element has. Ordering this after the inPlace branch hid the
          // whole case on vercel.com: `--themed-bg` is `mixed` (bg 2, text 1), so that branch
          // claimed the declaration, `mapBg` answered null for its orange, and the button was
          // left exactly as the site shipped it — white on a dark page, together with "Log In"
          // and every other button written this way.
          if (d.fbVar && !rootDefined.has(d.var) && tokenValue.has(d.fbVar)) {
            // The INNER token is what paints, so it is mapped by THIS use rather than left to
            // its own definition — which is the whole point here: `--ds-gray-1000` is a text
            // colour by its 213 text uses, and this use is a background (an inverted button:
            // dark surface, light label).
            // `|| the colour itself`: mapByRole answers null for "already right for this role",
            // and here that must still be WRITTEN. The normal meaning of null — leave the
            // declaration alone — hands the element back to the token's definition, and that
            // definition is what is wrong for this use. Saying nothing here means saying "white".
            const base = tokenValue.get(d.fbVar);
            const inner = mapByRole(role, base, theme, palette, interactive) || base;
            // Written back as a var() with the SAME outer token, not as a flat colour, so the
            // cascade keeps deciding exactly as the site wrote it: a themed section that does set
            // `--themed-bg` still wins there (and that definition is recoloured on its own
            // terms), while everywhere else — where the fallback paints — our colour applies.
            if (inner) {
              mapped = `var(${d.var}, ${inner})`;
              stats.consumers++;
            }
          } else if (inPlace.has(d.var) && tokenValue.has(d.var)) {
            mapped = mapByRole(role, tokenValue.get(d.var), theme, palette, interactive);
            if (mapped) stats.consumers++;
          } else if (
            tokenValue.has(d.var) &&
            ((tokenRole.get(d.var) === "text" && role === "bg") ||
              (tokenRole.get(d.var) === "bg" && role === "text"))
          ) {
            // The token is rewritten at its definition, but THIS use is the opposite of the role
            // it was rewritten for, so the definition's new value is exactly backwards here: a
            // text token is lightened, and a surface painted with it turns light on a dark page.
            // Design systems do this deliberately — an "inverted" button paints its background
            // from the text colour and its label from the page background.
            // `mixed` would be the wrong tool even though the shape looks the same: a bg share
            // under the tipping threshold would have to be chased by lowering it, which hands
            // hundreds of text consumers from one definition to one rule each — robust only as
            // far as the probe saw every one of them. Rewriting just the contrary uses keeps the
            // definition doing the heavy work and costs one rule per inversion.
            // Only bg↔text counts. A border drawn in the text colour is the asymmetry
            // `inferTokenRole` already handles, and routing it here would undo that.
            mapped = mapByRole(role, tokenValue.get(d.var), theme, palette, interactive);
            if (mapped) stats.consumers++;
          } else if (d.fb && !tokenValue.has(d.var)) {
            // `var(--token, #fff)` where the token is defined NOWHERE: the fallback literal is
            // what actually paints, and nothing else will ever recolour it — the definition we
            // would have rewritten does not exist. Guarded on the token being unknown to the
            // probe, so a token that IS defined keeps winning through its own definition.
            mapped = mapByRole(role, d.fb, theme, palette, interactive);
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
            const m = mapByRole(partRole, x.c, theme, palette, interactive);
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
          mapped = role === "?" || inPlace.has(d.p) ? null : mapByRole(role, d.v, theme, palette, interactive);
          if (mapped) stats.tokens++;
        } else {
          const role = { color: "text", "text-decoration-color": "text", "caret-color": "text", "background-color": "bg" }[d.p] || "border";
          mapped = mapByRole(role, d.v, theme, palette, interactive);
        }
        // One place for every branch above, so a token DEFINITION written this way
        // (`--surface: rgb(255 255 255/var(--op,1))`) is restored the same as a plain declaration.
        // In an INTERACTION rule, "no change needed" is not the same as "write nothing". Our
        // sheet is injected `cssOrigin:"user"`, so a base rule of ours beats the site's :hover
        // rule outright — and then a hover we decline to rewrite is not left alone, it is
        // SUPPRESSED, and the state silently stops existing for the reader.
        // Measured on chefkoch.de, whose buttons change only their LABEL colour on hover:
        // `.ds-btn--tertiary:hover{color:#6ca075}` is a mid green at l≈0.53, so `mapText`
        // answered null ("already light") and we emitted nothing — our base `color` won, and
        // hovering did nothing at all. Writing the colour back unchanged costs one declaration
        // and restores the state exactly as the site designed it; where the colour DOES need
        // mapping, the mapping above has already happened and this never fires.
        if (!mapped && interactive && d.v && !d.p.startsWith("--")) mapped = d.v;
        if (mapped && d.alpha) mapped = withAlphaVar(mapped, d.alpha);
        if (mapped) decls.push(`${d.p}:${mapped} !important`);
        else stats.skipped++;
      }
      if (!decls.length) continue;
      // A multiply/darken blend assumes the light surface we just took away — the same reason it
      // is reset on image backdrops below, one level up: here it is a ::before painting a pill or
      // a chip. Only emitted when this rule actually got a new background, so a blend the site
      // uses over something we left alone is not touched.
      // SCREEN, not `normal`, and the difference is the whole fix. Such a ::before is almost
      // always `position:absolute; inset:0`, which puts it ABOVE the element's own text in paint
      // order; it stays legible only because multiply lets what is underneath show through.
      // Setting `normal` makes it opaque and it covers the label — measured on vercel.com's
      // "New" pills: the pill became visible and the word inside it disappeared. Screen is
      // multiply's dual (it lightens where multiply darkens), so it does on a dark backdrop what
      // the site's blend does on a light one — which is exactly the swap vercel.com itself makes
      // for its own dark mode (`dark-theme:before:mix-blend-screen`). It also suits the colour we
      // just wrote: our mapping turned the pill's near-white into a dark tone, and screening a
      // dark tone over a dark page lifts it to the quiet chip the design asks for.
      if (r.blend && decls.some((x) => x.startsWith("background-color:"))) {
        decls.push("mix-blend-mode:screen !important");
      }
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
      // `pinUndefined` is the one kind of inPlace token that is pinned as well — it has no
      // definition anywhere the probe could reach, so its consumer rules cover only the uses
      // that were seen, and without a pin everything else keeps the site's light value.
      if (inPlace.has(t.name) && !pinUndefined.has(t.name)) continue;
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

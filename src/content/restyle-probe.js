// Injected on demand via tabs.executeScript. Reads the page's THEMING SEAMS out of its
// stylesheets and returns them as the script's completion value:
//   - the PAINT LIST: every colour-valued declaration in every readable rule, with its
//     selector and enclosing @media/@supports/@container conditions. This is what the
//     compiler (background/darkcss.js) rewrites into the dark sheet, rule for rule — a
//     `.block-container{background:#fff}` becomes `.block-container{background-color:#1c1c1e
//     !important}`. It never reaches the model: it is bulky and mechanical, and the model is
//     asked to design colours, not to type out selectors it has never seen.
//   - colour TOKENS: custom properties whose value is a colour, wherever they are defined
//     (`:root`, `[data-theme=light]`, a component), tallied with the ROLE each is used in
//     (background / text / border) from the var() references that consume it. Token-themed
//     sites recolour through these; the compiler rewrites the definitions, so every var()
//     consumer follows.
//   - native dark-theme HOOKS: root-level selectors that switch a theme (`.dark`,
//     `[data-theme=dark]`), weighted by how many descendant rules they back and how many
//     tokens they define — a hook backing one token block is a section palette, not a site
//     theme — plus the rules inside prefers-color-scheme:dark blocks, kept verbatim so a
//     native theme can be activated by re-emitting them unconditionally (`color-scheme:dark`
//     does NOT make that media query match; only the OS preference does).
//   - what the root carries, which theme attributes the DOM's sections carry, the landmark
//     computed colours, and which sheets could not be read.
//
// The paint list and darkMedia are complete — no caps — because the compiler needs every
// rule. The summary the model sees is built by darkcss.js `summarize`, which caps its lists
// and prints the totals next to them.
//
// Cross-origin sheets throw on .cssRules. The background fetches those (host permission) and
// re-runs the probe with their text in `globalThis.__rsdDarkExtraSheets`; the probe parses
// each into a constructed stylesheet and walks it like the rest.
(() => {
  const PROP_ROLE = {
    color: "text",
    "background-color": "bg",
    "background-image": "bg",
    // A box-shadow is a BACKGROUND here, not an effect: amazon.de paints its page gutters with
    // `box-shadow: rgb(240,242,242) 0 0 0 2000px` on the centred deck, and nothing else paints
    // them. It is doubly invisible — the colour sits in a multi-part value, and the shadow
    // falls OUTSIDE the element's box and is not hit-testable, so the paint census cannot see
    // it either and reports such a page as fully dark. Mapped by the bg role, which darkens a
    // light colour and leaves an already-dark one (an ordinary drop shadow) alone.
    "box-shadow": "bg",
    "border-top-color": "border",
    "border-right-color": "border",
    "border-bottom-color": "border",
    "border-left-color": "border",
    "outline-color": "border",
    "text-decoration-color": "text",
    "caret-color": "text",
  };
  // Shorthands whose var() use we would otherwise miss: with a pending var() substitution the
  // longhands read back empty and only the shorthand carries the value.
  const SHORTHAND_ROLE = { background: "bg", border: "border", "border-color": "border", outline: "border" };
  const SHORTHAND_LONGHAND = { background: "background-color", border: "border-color", "border-color": "border-color", outline: "outline-color" };
  const THEME_ATTRS = ["data-theme", "data-color-mode", "data-color-scheme", "data-mode", "data-scheme", "data-bs-theme"];

  // A `background-image` is usually a surface (a gradient), but a data-URI SVG is an ICON: the
  // glyph is drawn in markup we can read, so its colours belong to the TEXT role, not the bg
  // one. amazon.de's carousel arrows are `url("data:image/svg+xml,<svg … fill='#0F1111'/>")`
  // on a white button — darken the button by the bg role and the arrow is black on black.
  // Only the inline-markup form (base64 is opaque to us) and only icon-sized colour counts:
  // more than a few literals means an illustration, and recolouring one flattens it.
  // The markup inside the URL is usually PERCENT-ENCODED — `%3Csvg … fill='%230F1111'%3E` —
  // and the quotes around attributes may be backslash-escaped by the serialiser, so both
  // spellings have to be recognised and a replacement written back in the same encoding.
  const DATA_SVG = /url\(\s*(?:\\?["'])?data:image\/svg\+xml[,;]/i;
  const SVG_BASE64 = /data:image\/svg\+xml[^,]*;base64/i;
  const SVG_MAX_COLORS = 4;
  const SVG_MAX_LEN = 8000;
  // Inside SVG markup a colour is taken only from a paint attribute/property, never by
  // scanning for "#…": `url(#someId)` references a gradient and rewriting it breaks the icon.
  const SVG_PAINT =
    /(?:fill|stroke|stop-color|flood-color|lighting-color)\s*(?::|=|%3A|%3D)\s*(?:\\?["']|%22|%27)?\s*((?:#|%23)[0-9a-f]{3,8}|rgba?\([^()]*\))/gi;

  // A compound at the START of a selector that can switch a theme: optional root
  // (:root/html/body) followed only by classes/attributes, one of which names a theme —
  // a class containing "dark", or a data-*theme/mode/scheme* attribute (any value: seeing
  // [data-theme=light] alongside [data-theme=dark] tells the model a theme SYSTEM exists).
  const HOOK_SHAPE = /^(?::root|html|body)?(?:\.[\w-]+|\[[^\]]+\])+$/i;
  const isHook = (compound) =>
    HOOK_SHAPE.test(compound) && (/\.[\w-]*dark[\w-]*/i.test(compound) || /\[data-[\w-]*(?:theme|mode|scheme)[\w-]*[~|^$*]?=/i.test(compound));

  const notes = [];

  // Canonicalise any CSS colour the browser can parse ("white", "hsl(…)", "#abc",
  // "rgb(20 20 20 / 50%)") through a canvas: opaque → "#rrggbb", translucent → "rgba(…)".
  // Values that are not plain colours (var(), calc(), keywords) return null and are left alone.
  const ctx = (() => {
    try {
      return document.createElement("canvas").getContext("2d");
    } catch (_) {
      return null;
    }
  })();
  const SENT = "#010203";
  const colorCache = new Map();
  const canon = (v) => {
    if (v == null) return null;
    v = String(v).trim();
    if (!v) return null;
    const k = v.toLowerCase();
    if (colorCache.has(k)) return colorCache.get(k);
    let out = null;
    if (ctx && !/^(inherit|initial|unset|revert|revert-layer|currentcolor|transparent|none|auto)$/.test(k) && !/\b(var|calc|url|attr|env)\(/.test(k)) {
      try {
        ctx.fillStyle = SENT;
        ctx.fillStyle = v;
        const got = ctx.fillStyle;
        if (typeof got === "string" && (got !== SENT || k === SENT)) out = got.toLowerCase();
      } catch (_) {
        out = null;
      }
    }
    colorCache.set(k, out);
    return out;
  };

  // A colour whose CHANNELS are literal but whose ALPHA comes from a var(). This is Tailwind's
  // opacity pattern — `background-color: rgb(255 255 255/var(--tw-bg-opacity,1))` — and EVERY
  // `bg-*`, `text-*` and `border-*` utility it ships is written that way, so on a Tailwind site
  // it is most of the page's paint. The value contains `var(`, so it used to fall into the
  // token-consumer branch, where the "the whole value is one var()" test fails: the declaration
  // was recorded NOWHERE, and `--tw-bg-opacity` — a NUMBER — was tallied as a colour token with
  // a background role. Measured on kleinanzeigen.de: 5450 style rules, 338 paint declarations,
  // 8 "colour tokens" (all of them opacity numbers), and `.bg-background` / `.bg-surface` —
  // which paint the body, the 2000×2529 page grid and every card — in none of them. The
  // document stayed 100% white while the compiler reported a confident 107 rules.
  // The colour here is perfectly knowable; only the opacity is not. So canonicalise it at full
  // alpha and keep the alpha expression verbatim, so the compiler can write its replacement back
  // in the SAME shape — which matters, because the token is live: a `bg-black/50` modal backdrop
  // sets `--tw-bg-opacity: 0.5`, and flattening that to an opaque colour would paint over the page.
  // The channels are matched as `[^()]*?` so anything nested there (`rgb(var(--ch), …)`, Bootstrap's
  // `rgba(var(--bs-body-color-rgb), .5)`) does NOT match: there the colour itself is unknown and
  // this is the wrong tool. Known gap, left deliberately — it needs the token read as channels.
  // `;` and `}` are excluded from both the channels and the alpha expression. The value comes out
  // of the CSSOM, so the browser has already parsed and re-serialised it and it cannot carry
  // either — but this text is written into OUR stylesheet, so the guarantee is made locally
  // rather than relied on from two files away.
  const ALPHA_VAR = /(rgba?|hsla?)\(\s*([^(){};]*?)\s*[,/]\s*(var\((?:[^(){};]|\([^(){};]*\))*\))\s*\)/i;
  const alphaVarAt = (raw) => {
    const m = ALPHA_VAR.exec(raw == null ? "" : String(raw));
    if (!m) return null;
    const c = canon(m[1] + "(" + m[2] + ")");
    return c ? { c: c, alpha: m[3], s: m[0] } : null;
  };
  // The whole value is one such colour — a longhand declaration. The shorthand loop uses
  // `alphaVarAt` instead, because Gecko turns every longhand of a shorthand holding a var() into
  // an empty "pending substitution" value: `border: 1px solid rgb(203 213 225/var(--x,1))` leaves
  // `border-top-color` reading "" and the whole value readable only as `border`, lengths and all.
  const alphaVar = (raw) => {
    const s = raw == null ? "" : String(raw).trim();
    const hit = alphaVarAt(s);
    return hit && hit.s === s ? hit : null;
  };

  // The paint colours of an icon written as an inline data-URI SVG, or null when this value is
  // not one we may touch. Shared by the two places such a value turns up: a `background-image`
  // declaration, and a custom property that a `background-image` later consumes — amazon.de's
  // rounded carousel arrows are `background-image: var(--left-arrow-button)`, so the markup with
  // the glyph's colour sits in the TOKEN, and reading only literal declarations left that arrow
  // black on the button we had just darkened.
  const svgPaints = (raw) => {
    if (!DATA_SVG.test(raw) || raw.length > SVG_MAX_LEN || SVG_BASE64.test(raw)) return null;
    const seen = new Set();
    const cols = [];
    SVG_PAINT.lastIndex = 0;
    let m;
    while ((m = SVG_PAINT.exec(raw))) {
      const lit = m[1];
      if (seen.has(lit)) continue;
      seen.add(lit);
      // `%230f1111` is `#0f1111` written for a URL: canonicalise the colour, but keep the
      // source spelling so the substitution puts the new colour back the same way.
      const pct = lit.slice(0, 3).toLowerCase() === "%23";
      const c = canon(pct ? "#" + lit.slice(3) : lit);
      if (c) cols.push(pct ? { s: lit, c, pct: 1 } : { s: lit, c });
    }
    // More than a few literals means an illustration, and recolouring one flattens it.
    if (!cols.length || cols.length > SVG_MAX_COLORS) return null;
    return cols;
  };

  const result = {
    ok: true,
    url: location.href,
    origin: location.origin,
    title: document.title || "",
    root: { classes: [], dataAttrs: {}, colorScheme: "" },
    metaColorScheme: "",
    sheets: { total: 0, readable: 0, blocked: 0, extra: 0 },
    blockedHrefs: [],
    counts: { rules: 0, paintRules: 0, tokenDefs: 0, prefersDarkRules: 0, lightDarkDecls: 0 },
    hooks: [], // [{ sel, rules, descendant, tokens }]
    themeAttrs: {}, // { "data-theme": { ivory: 9, light: 1 } } — theme attributes the DOM carries
    tokens: [], // [{ name, values, computed, defs, used: { bg, text, border } }]
    chains: {}, // { "--bg": ["--gray-90"] } — tokens defined from other tokens
    colors: { bg: [], text: [], border: [] }, // distinct canonical colours by role, with rule counts
    landmarks: {},
    paint: [], // [{ sel, wrap, d: [{ p, v, colors? }] }]
    darkMedia: [], // [{ sel, wrap, d: [{ p, v }] }] — rules inside prefers-color-scheme:dark
    notes,
  };

  try {
    // ---- current root state ------------------------------------------------
    try {
      const el = document.documentElement;
      result.root.classes = (el.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 40);
      const ds = el.dataset || {};
      for (const k of Object.keys(ds)) result.root.dataAttrs[k] = ds[k];
      result.root.colorScheme = getComputedStyle(el).colorScheme || "";
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) result.metaColorScheme = meta.getAttribute("content") || "";
      for (const a of THEME_ATTRS) {
        const els = document.querySelectorAll("[" + a + "]");
        if (!els.length) continue;
        const by = {};
        for (const e of els) {
          const v = e.getAttribute(a) || "";
          by[v] = (by[v] || 0) + 1;
        }
        result.themeAttrs[a] = by;
      }
    } catch (_) {}

    // ---- walk stylesheets ---------------------------------------------------
    const paint = result.paint;
    const darkMedia = result.darkMedia;
    const hooks = new Map();
    const tokenDefs = new Map(); // name -> { values: Set, defs }
    const roles = new Map(); // name -> { bg, text, border } from var() consumers
    const chains = new Map(); // name -> Set(names it is defined from)
    const colorsByRole = { bg: new Map(), text: new Map(), border: new Map() };
    const tallyColor = (role, c) => colorsByRole[role].set(c, (colorsByRole[role].get(c) || 0) + 1);
    const tallyRole = (raw, role) => {
      const re = /var\(\s*(--[\w-]+)/g;
      let m;
      while ((m = re.exec(raw))) {
        let r = roles.get(m[1]);
        if (!r) {
          r = { bg: 0, text: 0, border: 0 };
          roles.set(m[1], r);
        }
        r[role]++;
      }
    };

    // A declaration whose whole value is one var() is recorded as a CONSUMER of that token
    // ({ p, var }): the compiler rewrites it in place when the token's role is mixed (a raw
    // palette colour used as both background and text cannot be recoloured at its definition).
    // The fallback is kept too ({ fb }): `var(--token, #fff)` paints the LITERAL whenever the
    // token is never defined, and a site can ship a whole widget that way — Amazon's SFS cards
    // are `background: var(--aok-sfs-color-page-primary-normal-bg, #fff)` with that token
    // defined nowhere. Without the literal the compiler has no value for the declaration and
    // skips it, so the card stays white however long we wait for more stylesheets.
    const noteConsumer = (d, p, raw) => {
      // The fallback is taken greedily up to the LAST ")", so a parenthesised one
      // (`var(--x, rgb(247,247,247))`) is seen — the old `[^)]*` stopped at the inner paren and
      // the declaration was not even recorded as a consumer. A fallback that is not a plain
      // colour (a nested var(), a shadow) simply canon()s to null and only the token is kept.
      const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(raw.trim());
      if (!m) return;
      const e = { p, var: m[1] };
      const fb = m[2] && canon(m[2].trim());
      if (fb) e.fb = fb;
      d.push(e);
    };

    const visit = (style) => {
      const d = [];
      for (let i = 0; i < style.length; i++) {
        const p = style[i];
        let raw;
        try {
          raw = style.getPropertyValue(p);
        } catch (_) {
          continue;
        }
        if (p.startsWith("--")) {
          if (/light-dark\(/i.test(raw)) result.counts.lightDarkDecls++;
          // Checked before the chain branch: `--surface: rgb(255 255 255/var(--op,1))` is a
          // colour this token HOLDS, not a token it is built from. Treated as a chain it would
          // lend its role to an opacity number and keep no value of its own.
          const avT = alphaVar(raw);
          if (!avT && /var\(/.test(raw)) {
            // A token defined from other tokens (`--bg: var(--gray-90)`, `light-dark(var(--a),
            // var(--b))`): the referenced tokens inherit this one's role in the compiler.
            const refs = [];
            const re = /var\(\s*(--[\w-]+)/g;
            let m;
            while ((m = re.exec(raw))) refs.push(m[1]);
            if (refs.length) {
              let ch = chains.get(p);
              if (!ch) {
                ch = new Set();
                chains.set(p, ch);
              }
              for (const r of refs) ch.add(r);
            }
            continue;
          }
          // A token holding an icon, not a colour: `--left-arrow-button: url("data:image/
          // svg+xml,…")`. It is recoloured at its DEFINITION, so every consumer follows and
          // we need no rule per consumer — and it is deliberately NOT registered as a colour
          // token, since its value is a url() that no role mapping could read.
          const icon = svgPaints(raw);
          if (icon) {
            for (const x of icon) tallyColor("text", x.c);
            d.push({ p, v: raw, colors: icon, role: "text" });
            continue;
          }
          const c = avT ? avT.c : canon(raw);
          if (!c) continue;
          d.push(avT ? { p, v: c, alpha: avT.alpha } : { p, v: c });
          let t = tokenDefs.get(p);
          if (!t) {
            t = { values: new Set(), defs: 0 };
            tokenDefs.set(p, t);
          }
          t.values.add(c);
          t.defs++;
          continue;
        }
        const role = PROP_ROLE[p];
        if (!role) continue;
        if (/light-dark\(/i.test(raw)) result.counts.lightDarkDecls++;
        // Before the consumer branch: the var() here is an OPACITY, not the colour. Tallying it
        // as a colour token is what gave kleinanzeigen.de eight "colour tokens" that were all
        // numbers, and falling through to `noteConsumer` recorded the declaration nowhere at all.
        const av = alphaVar(raw);
        if (av) {
          tallyColor(role, av.c);
          d.push({ p, v: av.c, alpha: av.alpha });
          continue;
        }
        if (/var\(/.test(raw)) {
          tallyRole(raw, role);
          noteConsumer(d, p, raw);
          continue;
        }
        // Multi-part values whose colours must be substituted inside the value rather than
        // replaced wholesale: a gradient's stops, a shadow's colour next to its lengths, an
        // icon SVG's paint. The value we re-emit is the BROWSER's serialisation of the one it
        // already parsed, so it is a well-formed token and cannot break out of our declaration.
        if (p === "background-image" || p === "box-shadow") {
          let partRole = "bg";
          let cols = null;
          if (p === "background-image" && DATA_SVG.test(raw)) {
            // an icon's glyph, which must stay readable on the darkened surface
            partRole = "text";
            cols = svgPaints(raw);
            if (!cols) continue; // base64 markup is opaque to us, an illustration is too rich
          } else {
            if (p === "background-image" && (!/gradient\(/i.test(raw) || /url\(/i.test(raw))) continue;
            const seen = new Set();
            cols = [];
            const re = /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)/gi;
            let m;
            while ((m = re.exec(raw))) {
              const lit = m[0];
              if (seen.has(lit)) continue;
              seen.add(lit);
              const c = canon(lit);
              if (c) cols.push({ s: lit, c });
            }
            if (!cols.length) continue;
          }
          for (const x of cols) tallyColor(partRole, x.c);
          d.push(partRole === "bg" ? { p, v: raw, colors: cols } : { p, v: raw, colors: cols, role: partRole });
          continue;
        }
        const c = canon(raw);
        if (!c) continue;
        tallyColor(role, c);
        d.push({ p, v: c });
      }
      for (const sh of Object.keys(SHORTHAND_ROLE)) {
        let raw;
        try {
          raw = style.getPropertyValue(sh);
        } catch (_) {
          continue;
        }
        if (!raw || !/var\(/.test(raw)) continue;
        // An alpha-var colour is a COLOUR, so it is recorded as one rather than tallying the
        // opacity token as paint. It has to be caught here and not left to the longhand loop:
        // Firefox serialises `border: 1px solid rgb(0 0 0/var(--x,1))` as the shorthand
        // `border-color`, which is in no PROP_ROLE, so the loop above never sees it and skipping
        // here lost every border Tailwind draws. Recorded only when the longhand is not already
        // in hand, so a value that DID expand is not counted twice.
        const avS = alphaVarAt(raw);
        if (avS) {
          const lh = SHORTHAND_LONGHAND[sh];
          if (!d.some((e) => e.p === lh)) {
            tallyColor(SHORTHAND_ROLE[sh], avS.c);
            d.push({ p: lh, v: avS.c, alpha: avS.alpha });
          }
          continue;
        }
        tallyRole(raw, SHORTHAND_ROLE[sh]);
        noteConsumer(d, SHORTHAND_LONGHAND[sh], raw);
      }
      return d;
    };

    const noteHook = (sel, tokenCount) => {
      for (const part of sel.split(",")) {
        const p = part.trim();
        const m = /^([^\s>+~]+)/.exec(p);
        if (!m) continue;
        const compound = m[1].replace(/["']/g, "");
        if (!isHook(compound)) continue;
        let h = hooks.get(compound);
        if (!h) {
          h = { sel: compound, rules: 0, descendant: 0, tokens: 0 };
          hooks.set(compound, h);
        }
        h.rules++;
        if (p.length > m[1].length) h.descendant++;
        else h.tokens += tokenCount;
      }
    };

    const prelude = (rule) => {
      if (rule.media) return "@media " + (rule.conditionText || rule.media.mediaText || "");
      if ("containerQuery" in rule) return "@container " + (rule.containerName ? rule.containerName + " " : "") + rule.containerQuery;
      if (rule.conditionText != null) return "@supports " + rule.conditionText;
      return null; // @layer and other grouping rules: flatten (a user sheet has no use for layers)
    };

    const walk = (rules, wrap, inDark) => {
      for (const rule of rules) {
        result.counts.rules++;
        if (rule.selectorText != null && rule.style) {
          const sel = rule.selectorText;
          const d = visit(rule.style);
          noteHook(sel, d.filter((x) => x.p.startsWith("--")).length);
          if (inDark) {
            result.counts.prefersDarkRules++;
            const all = [];
            for (let i = 0; i < rule.style.length; i++) {
              const p = rule.style[i];
              all.push({ p, v: rule.style.getPropertyValue(p) });
            }
            if (all.length) darkMedia.push({ sel, wrap, d: all });
          } else if (d.length) {
            paint.push({ sel, wrap, d });
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, wrap.concat(sel), inDark); // CSS nesting
        } else if (rule.styleSheet) {
          // @import — its sheet is not in document.styleSheets
          let rs = null;
          try {
            rs = rule.styleSheet.cssRules;
          } catch (_) {
            result.sheets.blocked++;
            if (rule.styleSheet.href) result.blockedHrefs.push(rule.styleSheet.href);
            continue;
          }
          if (rs) walk(rs, wrap, inDark);
        } else if (rule.cssRules) {
          const cond = rule.media ? rule.conditionText || rule.media.mediaText || "" : "";
          if (/prefers-color-scheme\s*:\s*dark/i.test(cond)) {
            walk(rule.cssRules, wrap, true);
          } else {
            const pre = prelude(rule);
            walk(rule.cssRules, pre ? wrap.concat(pre) : wrap, inDark);
          }
        }
      }
    };

    const sheets = Array.from(document.styleSheets || []);
    result.sheets.total = sheets.length;
    for (const sheet of sheets) {
      let rules = null;
      try {
        rules = sheet.cssRules; // throws SecurityError for cross-origin sheets
      } catch (_) {
        result.sheets.blocked++;
        if (sheet.href) result.blockedHrefs.push(sheet.href);
        continue;
      }
      if (!rules) continue;
      result.sheets.readable++;
      try {
        walk(rules, [], false);
      } catch (e) {
        notes.push("stopped walking a sheet: " + ((e && e.message) || e));
      }
    }

    // Cross-origin sheets the background fetched for us, parsed here into constructed sheets.
    const extra = globalThis.__rsdDarkExtraSheets;
    try {
      delete globalThis.__rsdDarkExtraSheets;
    } catch (_) {}
    if (Array.isArray(extra)) {
      for (const x of extra) {
        try {
          const s = new CSSStyleSheet();
          s.replaceSync(String(x.text || ""));
          result.sheets.extra++;
          walk(s.cssRules, [], false);
        } catch (e) {
          notes.push("could not parse fetched sheet " + (x && x.href) + ": " + ((e && e.message) || e));
        }
      }
    }

    // Inline styles (`<th style="background:#ebebd2">`, Wikipedia's infoboxes) are in no sheet,
    // so the compiler would turn the text on them light and leave the box light. Each distinct
    // style attribute becomes a paint rule keyed on its exact text; a user !important beats an
    // inline declaration, and the same template markup on the site's other pages matches too.
    // Values a CSS string would need escapes for are skipped rather than escaped: the selector
    // is page text going into our sheet.
    //
    // Colour CUSTOM PROPERTIES set inline are kept too (not filtered out): a component framework
    // may theme its subtree by writing a token on a wrapper (`<div style="--background-color:#fff">`,
    // Amazon's DCL cards) that children consume with `var(--background-color)`. The token is in no
    // sheet, so rewriting its definition means rewriting it HERE —
    // `[style="…"]{--background-color:<dark> !important}` — and every `var()` consumer follows.
    // The compiler still only emits a token whose role is unambiguous (name or consumers); a
    // "mixed"/roleless one is skipped there, so a token used both ways is never inverted.
    const INLINE_CAP = 4000;
    const inlineSeen = new Set();
    let inline = 0;
    for (const el of document.querySelectorAll("[style]")) {
      if (inline >= INLINE_CAP) break;
      const attr = el.getAttribute("style") || "";
      if (!attr || attr.length > 300 || inlineSeen.has(attr) || /["\\\n\r\f<>{}]/.test(attr)) continue;
      inlineSeen.add(attr);
      inline++;
      const d = visit(el.style);
      if (d.length) paint.push({ sel: `[style="${attr}"]`, wrap: [], d });
    }
    result.counts.inlineStyles = inlineSeen.size;
    // The same for the presentational attribute (`<table bgcolor="#f6f6ef">`, Hacker News).
    const bgSeen = new Set();
    for (const el of document.querySelectorAll("[bgcolor]")) {
      const attr = el.getAttribute("bgcolor") || "";
      if (bgSeen.has(attr) || !/^#?[0-9a-z]{3,20}$/i.test(attr)) continue;
      bgSeen.add(attr);
      const c = canon(/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(attr) ? "#" + attr : attr);
      if (!c) continue;
      tallyColor("bg", c);
      paint.push({ sel: `[bgcolor="${attr}"]`, wrap: [], d: [{ p: "background-color", v: c }] });
    }

    // ---- which light surfaces are a PICTURE's background ---------------------
    // A TRANSPARENT image has no background of its own: the surface behind it IS the picture's
    // background. amazon.de's product art is transparent AVIF on a white card — measured by
    // forcing the cards magenta and counting the pixels inside each image's own box: 43-90% of
    // it showed through. Darken the card and a dark product vanishes into it.
    //
    // So where an image covers a real share of the nearest surface that actually paints, that
    // surface's colour is preserved AS A BACKDROP ON THE IMAGE while the surface itself still
    // goes dark. Three things make this safe, each one measured on amazon.de:
    //   - COVER separates a picture's background from a surface an image merely sits on:
    //     product art fills 63-76% of its card, a banner on a page-wide section fills 0-2% and
    //     must not put a light box behind every image on the page.
    //   - An image that already carries an opaque background of its own has its backdrop
    //     (the site put the white straight on the <img>); that rule is kept untouched by the
    //     compiler instead, and overriding it with an ancestor's colour would be wrong.
    //   - LIGHTNESS is not decided here: every colour the selector's images sit on is reported
    //     and the compiler drops the candidate unless they are all light, so an image already
    //     on a dark surface (amazon.de's nav sprite, luminance 0.03) keeps it and the threshold
    //     stays in one place.
    // The selector is read off the real host element rather than taken from the rule that
    // painted it: a site's own rule is often far broader than the cards it styles here
    // (amazon.de paints these through `.a-cardui`, which is every card on the page), and it
    // ships the same card under two CSS-module prefixes depending on the load.
    const BACKDROP_COVER = 0.25;
    const BACKDROP_IMG_CAP = 400;
    const BACKDROP_MATCH_CAP = 200;
    const opaqueBg = (c) => {
      const m = /^rgba?\(([^)]*)\)$/.exec(c || "");
      if (!m) return false;
      const parts = m[1].split(",");
      return parts.length < 4 || parseFloat(parts[3]) >= 0.5;
    };
    // Built from class names only, and only from ones that are CSS identifiers already - the
    // selector goes into our stylesheet, so nothing that would need escaping is used.
    const classSel = (el) => {
      const cls = (typeof el.className === "string" ? el.className : "")
        .trim()
        .split(/\s+/)
        .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c));
      return cls.length ? "." + cls.slice(0, 3).join(".") : "";
    };
    // The surface an image is drawn on, or null when the image brings its own.
    const backdropOf = (img) => {
      if (opaqueBg(getComputedStyle(img).backgroundColor)) return null;
      let n = img.parentElement;
      while (n && n !== document.documentElement) {
        const raw = getComputedStyle(n).backgroundColor;
        if (opaqueBg(raw)) {
          const c = canon(raw);
          return c ? { el: n, color: c } : null;
        }
        n = n.parentElement;
      }
      return null;
    };
    const backdrops = new Map();
    let imgSeen = 0;
    for (const img of document.images) {
      if (imgSeen >= BACKDROP_IMG_CAP) break;
      const ib = img.getBoundingClientRect();
      if (ib.width < 24 || ib.height < 24) continue;
      imgSeen++;
      const hit = backdropOf(img);
      if (!hit || hit.el === document.body) continue;
      const hb = hit.el.getBoundingClientRect();
      const area = hb.width * hb.height;
      if (!area || (ib.width * ib.height) / area < BACKDROP_COVER) continue;
      const sel = classSel(hit.el);
      if (!sel || backdrops.has(sel)) continue;
      let hits;
      try {
        hits = document.querySelectorAll(sel + " img");
      } catch (_) {
        continue;
      }
      if (!hits.length || hits.length > BACKDROP_MATCH_CAP) continue;
      // Every image the selector reaches - not just the one that led here, which is why one
      // on an already-dark surface drops the whole candidate in the compiler.
      const colors = new Set();
      let blend = 0;
      for (const e of hits) {
        const b = backdropOf(e);
        if (b) colors.add(b.color);
        // A DARKEN-type blend only works against a light backdrop: amazon.de draws its product
        // art with `mix-blend-mode: multiply` so the picture's white melts into the white card.
        // Multiply against a dark surface is dark whatever the picture holds — measured, these
        // images went from 0% light pixels to 40-97% with the blend switched off, and even the
        // backdrop we put back is multiplied away. Where we darken what is behind it, the blend
        // has to go, so it is reported with the candidate it belongs to.
        const mode = getComputedStyle(e).mixBlendMode;
        if (mode === "multiply" || mode === "darken") blend = 1;
      }
      if (colors.size) backdrops.set(sel, { colors: Array.from(colors), blend });
    }
    result.imageBackdrops = Array.from(backdrops, ([sel, v]) => ({ sel: sel + " img", colors: v.colors, blend: v.blend }));

    // A RASTER icon cannot be recoloured. An SVG written into the CSS has readable markup, so
    // its glyph is lightened; a sprite PNG is pixels on a server, and a cross-origin image
    // taints a canvas, so nothing in the page can even tell us whether it is dark. Darkening
    // the surface under one therefore hides it for good — amazon.de's search button is the
    // orange `.nav-search-submit` with the magnifier drawn from the nav sprite, and it went to
    // a dark brown square with nothing on it.
    // So that surface keeps its colour instead. The guards keep it to the one safe shape, a
    // BUTTON: the surface must be small, the icon must cover a real share of it, and neither
    // may carry text of its own — a sprite sitting in a wide toolbar or a page section is left
    // alone rather than leaving a large light patch behind.
    const ICON_HOST_MAX = 200; // px per side: a control, not a region of the page
    const ICON_COVER = 0.25;
    const ICON_SCAN_CAP = 4000;
    const ownText = (el) => {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      return false;
    };
    const iconKeeps = new Map();
    let scanned = 0;
    for (const el of document.querySelectorAll("[class]")) {
      if (scanned >= ICON_SCAN_CAP) break;
      scanned++;
      const cs = getComputedStyle(el);
      const bi = cs.backgroundImage || "none";
      // Only a real raster url(): a gradient is a surface, and a data-URI SVG we recolour.
      if (bi.indexOf("url(") < 0 || /gradient\(/i.test(bi) || /data:image\/svg/i.test(bi)) continue;
      const ib = el.getBoundingClientRect();
      if (ib.width < 8 || ib.height < 8 || ib.width > ICON_HOST_MAX || ib.height > ICON_HOST_MAX) continue;
      if (ownText(el)) continue;
      if (opaqueBg(cs.backgroundColor)) continue; // paints its own surface; nothing behind it to keep
      const hit = backdropOf(el);
      if (!hit || hit.el === document.body) continue;
      const hb = hit.el.getBoundingClientRect();
      const area = hb.width * hb.height;
      if (!area || hb.width > ICON_HOST_MAX || hb.height > ICON_HOST_MAX) continue;
      if ((ib.width * ib.height) / area < ICON_COVER) continue;
      if (ownText(hit.el)) continue;
      const sel = classSel(hit.el);
      if (!sel || iconKeeps.has(sel)) continue;
      let hits;
      try {
        hits = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      if (!hits.length || hits.length > BACKDROP_MATCH_CAP) continue;
      // Every element the selector reaches, so one of them already sitting dark drops the
      // candidate in the compiler rather than relighting a surface that was never light.
      const colors = new Set();
      for (const e of hits) {
        const c = canon(getComputedStyle(e).backgroundColor);
        if (c) colors.add(c);
      }
      if (colors.size) iconKeeps.set(sel, Array.from(colors));
    }
    result.iconSurfaces = Array.from(iconKeeps, ([sel, colors]) => ({ sel, colors }));

    result.counts.paintRules = paint.length;
    result.counts.tokenDefs = tokenDefs.size;
    result.chains = Object.fromEntries(Array.from(chains, ([k, v]) => [k, Array.from(v)]));
    result.hooks = Array.from(hooks.values()).sort((a, b) => b.descendant - a.descendant || b.tokens - a.tokens);
    // `computed` is the value in force on the root right now — the one a consumer of a
    // token defined in several places (`:root`, `body.theme-dark`, a section) resolves to.
    const rootStyle = getComputedStyle(document.documentElement);
    // Tokens defined only from other tokens (`--body-bg: var(--white)`) have no literal
    // value to rewrite, so they are listed with `values: []`; their consumers are rewritten in
    // place from `computed` instead.
    for (const name of chains.keys()) if (!tokenDefs.has(name)) tokenDefs.set(name, { values: new Set(), defs: 0 });
    result.tokens = Array.from(tokenDefs, ([name, t]) => ({
      name,
      values: Array.from(t.values),
      computed: canon(rootStyle.getPropertyValue(name)),
      defs: t.defs,
      used: roles.get(name) || { bg: 0, text: 0, border: 0 },
    }));
    for (const role of Object.keys(colorsByRole)) {
      result.colors[role] = Array.from(colorsByRole[role], ([value, rules]) => ({ value, rules })).sort((a, b) => b.rules - a.rules);
    }

    // ---- landmark computed colours -----------------------------------------
    const pick = (sel) => {
      try {
        const el = sel === ":root" ? document.documentElement : document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderColor };
      } catch (_) {
        return null;
      }
    };
    for (const sel of [":root", "body", "header", "nav", "main", "article", "a", "button", "input"]) {
      const v = pick(sel);
      if (v) result.landmarks[sel] = v;
    }

    if (result.sheets.blocked && !result.sheets.extra) {
      notes.push(`${result.sheets.blocked}/${result.sheets.total} stylesheets are cross-origin and unreadable here; the background fetches them and probes again.`);
    }
    return result;
  } catch (e) {
    return { ok: false, reason: "probe failed: " + ((e && e.message) || e) };
  }
})();

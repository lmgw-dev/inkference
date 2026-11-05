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
    const noteConsumer = (d, p, raw) => {
      const m = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(raw.trim());
      if (m) d.push({ p, var: m[1] });
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
          if (/var\(/.test(raw)) {
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
          const c = canon(raw);
          if (!c) continue;
          d.push({ p, v: c });
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
        if (/var\(/.test(raw)) {
          tallyRole(raw, role);
          noteConsumer(d, p, raw);
          continue;
        }
        if (p === "background-image") {
          if (!/gradient\(/i.test(raw) || /url\(/i.test(raw)) continue;
          const seen = new Set();
          const cols = [];
          const re = /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)/gi;
          let m;
          while ((m = re.exec(raw))) {
            if (seen.has(m[0])) continue;
            seen.add(m[0]);
            const c = canon(m[0]);
            if (c) cols.push({ s: m[0], c });
          }
          if (!cols.length) continue;
          for (const x of cols) tallyColor("bg", x.c);
          d.push({ p, v: raw, colors: cols });
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
    const INLINE_CAP = 4000;
    const inlineSeen = new Set();
    let inline = 0;
    for (const el of document.querySelectorAll("[style]")) {
      if (inline >= INLINE_CAP) break;
      const attr = el.getAttribute("style") || "";
      if (!attr || attr.length > 300 || inlineSeen.has(attr) || /["\\\n\r\f<>{}]/.test(attr)) continue;
      inlineSeen.add(attr);
      inline++;
      const d = visit(el.style).filter((x) => !x.p.startsWith("--"));
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

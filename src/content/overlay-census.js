// Script mode's eyes on the page. Injected on demand via tabs.executeScript({file}), then driven
// with `tabs.executeScript({code: "window.__rsdOverlay(<json>)"})` — the content/agent.js pattern.
// It answers three questions about the overlays sitting on top of the videos (or whatever
// `target` selects): WHAT paints over them, measured; WHICH element that is, grouped by role so
// the same title bar in 20 recycled tiles is one thing; and WHICH selector will still find it
// after the site's next deploy re-hashes every class name.
//
// Everything is read off the live page, not the markup: a point counts as covered when the
// browser's own hit test puts an element above the video there AND that element paints something
// at that point. A transparent click-catcher spanning the whole tile is above the video
// everywhere and paints nothing, so it covers nothing; a pointer-events:none gradient scrim is
// invisible to elementsFromPoint, so sampling forces pointer-events on for its duration.
//
// Pure DOM, no browser.* APIs: tools/script-check.mjs evaluates this same file in headless
// Firefox's page world, so what it measures is what the extension sees. Ops dispatch on cmd.op —
// overlays · inspect · test · count · scroll · settle · pick · pickKey · unpick. Waiting ops
// return a Promise (executeScript and BiDi evaluate both await it); every result is plain JSON;
// no list is cut short without saying so.
(() => {
  // Bump on any behaviour change. An identical version already in this frame is KEPT — a pick in
  // progress lives in its closure and must survive the background re-injecting the file before
  // its next command — while an older one is disposed and replaced.
  const VERSION = 2;
  const prev = window.__rsdOverlay;
  if (prev && prev.version === VERSION) return true;
  if (prev && typeof prev.dispose === "function") {
    try {
      prev.dispose();
    } catch (_) {
      /* an older runtime that cannot clean up after itself */
    }
  }

  const OWN = "data-rsd-overlay"; // our nodes (picker host, forcing sheets): never measured
  const MARKER = "data-rsd-highlight"; // content/agent.js's highlight rings: not page content either
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MEDIA = new Set(["img", "video", "canvas", "svg", "picture", "iframe", "frame", "object", "embed"]);
  const CONTROLS = new Set(["input", "select", "textarea", "button", "progress", "meter"]);
  const MIN_ALPHA = 0.05; // below this an opacity/alpha is invisible over a moving video
  const INSIDE_AREA = 4; // a common ancestor up to 4× the target's area is still "its tile"
  const LAYER_AREA = 0.5; // an ancestor spanning half the viewport is a page layer, not the overlay
  const WRAPPER_COVER = 0.8; // a non-painting box over 80% of the target only groups its children
  const EDGE = 0.08; // within 8% of the target's side = touching that edge
  const SAMPLES = 5; // `test` shows this many descriptions, always next to the total
  // Pseudo-ELEMENTS (never pseudo-classes): any `::name` / `::name(…)`, plus the four legacy
  // single-colon spellings. The boundary is (?![\w-]), not \b — `\b` cut `:placeholder-shown`
  // down to `-shown`.
  const PSEUDO = /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/gi;

  // Forcing sheets for hit testing: everything takes pointer events (the scrim is reachable), and
  // the page's own transitions/animations are frozen at their end values (the paint-census.js
  // trick). Neither beats a user-origin rule — see finishTransitions() and above() for those.
  const FORCE_PE = "*,*::before,*::after{pointer-events:auto !important}";
  const FREEZE = "*,*::before,*::after{transition:none !important;animation:none !important}";

  // --- small helpers ------------------------------------------------------------------------
  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const ours = (el) => el.hasAttribute(OWN) || el.hasAttribute(MARKER);
  const classList = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  const viewport = () => {
    const d = document.documentElement;
    return { w: d.clientWidth || innerWidth, h: d.clientHeight || innerHeight };
  };
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  // A CSS string literal. Values carrying { } ; @ or comments never get here (stableValue), so
  // every selector this file emits passes background/rulecss.js's checks.
  const cssStr = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

  function alpha(v) {
    if (!v || v === "transparent") return 0;
    const m = /\/\s*([\d.]+%?)\s*\)$/.exec(v) || /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\s*\)$/.exec(v);
    if (!m) return 1;
    return /%$/.test(m[1]) ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  }

  function addSheet(css, disabled) {
    const s = document.createElement("style");
    s.setAttribute(OWN, "");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    if (disabled && s.sheet) s.sheet.disabled = true;
    return s;
  }

  // --- class & value classification ---------------------------------------------------------
  // What survives a deploy is the whole point, so every class token is sorted into: hashed
  // (rebuilt names — css-x8Kq2a, sc-, jsx-123, CSS-module Name_part__hash), utility (Tailwind-ish:
  // stable, but shared by unrelated elements and rewritten on restyle) or semantic (video-title).
  const UTILITY = /^(?:-?[mp][trblxyse]?-|(?:min-|max-)?[wh]-|size-|inset-|-?(?:top|left|right|bottom|z|order)-|gap-|space-[xy]-|text-|font-|bg-|border|rounded|shadow|ring|outline-|opacity-|leading-|tracking-|cursor-|pointer-events-|select-|transition|duration-|ease-|delay-|-?transform|-?translate-|-?scale-|-?rotate-|items-|justify-|content-|self-|place-|col-|row-|grid-|flex-|basis-|grow|shrink|overflow-|object-|aspect-|line-clamp-|fill-|stroke-|from-|via-|to-|(?:inline-)?(?:flex|grid|block)$|hidden$|absolute$|relative$|fixed$|sticky$|static$|visible$|invisible$|truncate$|sr-only$|italic$|uppercase$|lowercase$|underline$)/;

  const digitFlips = (seg) => {
    let n = 0;
    for (let i = 1; i < seg.length; i++) if (/\d/.test(seg[i]) !== /\d/.test(seg[i - 1])) n++;
    return n;
  };
  // A random-looking token: hex runs, letter/digit salad (x1n2onr6), or short mixed-case noise
  // (kXvTgT). camelCase words have one hump per word and are left alone.
  function hashy(s) {
    if (/^[a-f0-9]{6,}$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return true;
    for (const seg of String(s).split(/[-_:.]+/)) {
      if (seg.length >= 4 && digitFlips(seg) >= 2) return true;
      if (seg.length >= 5 && seg.length <= 7 && /^[A-Za-z]+$/.test(seg) && (seg.match(/[a-z][A-Z]/g) || []).length >= 2) return true;
    }
    return false;
  }

  const kinds = new Map();
  function classKind(c) {
    let k = kinds.get(c);
    if (k) return k;
    let m;
    if ((m = /^([A-Z][A-Za-z0-9]*_[A-Za-z0-9-]+__)[A-Za-z0-9_-]{3,}$/.exec(c))) k = { kind: "hashed", prefix: m[1] };
    else if ((m = /^(_[A-Za-z][A-Za-z0-9-]*_)[a-z0-9]{5}_\d+$/.exec(c))) k = { kind: "hashed", prefix: m[1] }; // Vite: _Button_buvzz_1
    else if ((m = /^(.*[A-Za-z0-9]___)[A-Za-z0-9_-]{4,}$/.exec(c))) k = { kind: "hashed", prefix: m[1] };
    else if ((m = /^(?:css|sc|jsx|svelte|astro|emotion|styled|tw|ng-tns|ng-c)-(.+)$/.exec(c)) && (/\d/.test(m[1]) || /[a-z][A-Z]|[A-Z][a-z]*[A-Z]/.test(m[1]) || (m[1].length >= 6 && !/-/.test(m[1])))) {
      k = { kind: "hashed" };
    } else if (/^_[A-Za-z0-9_-]{4,}$/.test(c) && (/\d/.test(c) || /[a-z][A-Z]/.test(c))) k = { kind: "hashed" };
    else if (/[:[\]/!]/.test(c) || UTILITY.test(c)) k = { kind: "utility" };
    else if (hashy(c)) k = { kind: "hashed" };
    else k = { kind: "semantic" };
    kinds.set(c, k);
    return k;
  }

  // State classes (GifPreview_isActive, is-playing, card--active) say what an element is DOING,
  // not what it is: they stay out of role signatures, and as selectors they match only while the
  // state holds.
  const STATE = /(?:^|[-_])(?:is|has)(?:[-_]?[A-Z]|-)|(?:^|[-_])(?:active|selected|current|playing|paused|open|opened|closed|visible|hidden|shown|loading|loaded|focused|focus|hover|hovered|expanded|collapsed|muted|unmuted|disabled|enabled|checked|on|off)$/i;
  const isState = (c) => classKind(c).kind === "semantic" && STATE.test(c);

  // Attribute values worth anchoring a selector on: short, not a number (a per-item id), not a
  // hash or URL, and nothing that could break out of a rule block.
  const stableValue = (v) =>
    v.length >= 1 && v.length <= 60 && !/[{};@\n]|\/\*|\*\//.test(v) && !/^\d+$/.test(v) && !/^(?:https?:|\/\/|data:|blob:)/.test(v) && !hashy(v);

  // Attributes that name a ROLE (test hooks, ARIA role) — part of the role signature, digits
  // normalised so "video-123"/"video-124" are one role.
  const ROLE_ATTRS = ["data-testid", "data-test-id", "data-test", "data-e2e", "data-qa", "data-cy", "role"];
  const TEST_ATTR = /^data-(?:testid|test-id|test|testing|e2e|qa|cy|automation-id|automation|component|element|section|ui|role|name|type)$/;
  const HOOK_ATTRS = new Set(["role", "aria-label", "aria-roledescription", "name", "title", "alt", "itemprop", "slot"]);
  const LOCALIZED = new Set(["aria-label", "aria-roledescription", "title", "alt"]);
  const DESC_ATTRS = ["role", "aria-label", "name", "title", "alt"];
  const SKIP_DATA = /^data-(?:v-[0-9a-f]{6,}|reactid|reactroot|styled|emotion)/;
  // Per-item IDENTITY, not role: data-feed-item-id="redgrimy…" names one clip. Recognised by name
  // (…-id, …-key, …-index, uuid, slug) or by its values being mostly distinct across every
  // same-tag element carrying it — a role attribute repeats a few values (data-k: hd/live).
  // Matters when the role set is a single element (only the ACTIVE item of a feed has content):
  // there "constant across the role" is trivially true and a content id passed as stable.
  const IDENTITY_NAME = /(?:[-_](?:id|key|index|idx|uuid|guid|hash|slug|pk|ref)|(?:item|post|video|clip|user|content|feed|media|entity|object|row|node)id)$/i;
  function identity(el, name) {
    if (TEST_ATTR.test(name) || name === "role" || LOCALIZED.has(name)) return false;
    if (name === "id") {
      // ids are unique by definition; a run of same-tag SIBLINGS that all carry one is a list of items
      const p = el.parentElement;
      return !!p && Array.from(p.children).some((x) => x !== el && x.localName === el.localName && x.id);
    }
    if (IDENTITY_NAME.test(name)) return true;
    let peers;
    try {
      peers = document.querySelectorAll(`${el.localName}[${CSS.escape(name)}]`);
    } catch (_) {
      return false;
    }
    if (peers.length < 3) return false;
    const values = new Set();
    for (const x of peers) values.add(x.getAttribute(name));
    return values.size >= Math.max(3, peers.length / 2);
  }

  // --- role signatures ------------------------------------------------------------------------
  // "Same role" = same tag, class list and role hooks, under the same kind of parent. Within one
  // page state hashed classes are as good as any (every tile was rendered by the same build), so
  // they belong in the element's own signature — it is the CANDIDATES that must avoid them.
  // State classes never count, and the PARENT contributes only its stable hooks: the active
  // tile's extra (often hashed) class must not split its rail from every other tile's rail.
  function selfSig(el, parent) {
    if (!el || el.nodeType !== 1) return "";
    let s = el.localName;
    const cls = classList(el)
      .filter((c) => !isState(c) && (!parent || classKind(c).kind === "semantic"))
      .sort();
    if (cls.length) s += "." + cls.join(".");
    for (const a of ROLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v != null) s += `[${a}=${v.replace(/\d+/g, "#")}]`;
    }
    return s;
  }
  const roleSig = (el) => selfSig(el) + " < " + selfSig(parentOf(el), true);

  // Every element in the document with el's role — off-screen and recycled-but-hidden tiles
  // included, which is what a rule will actually hit.
  function roleSet(el) {
    const sig = roleSig(el);
    let pre = el.localName;
    try {
      for (const c of classList(el)) if (!isState(c)) pre += "." + CSS.escape(c);
      const out = Array.from(document.querySelectorAll(pre)).filter((x) => roleSig(x) === sig);
      if (!out.includes(el)) out.push(el); // inside a shadow root, or a case-sensitive SVG tag
      return out;
    } catch (_) {
      return [el];
    }
  }

  // --- painting -------------------------------------------------------------------------------
  // One context per op: computed styles are live objects, so they are cached only for the
  // duration of one measurement.
  function makeCtx() {
    const styles = new Map();
    const opac = new Map();
    const infos = new Map();
    const pseudos = new Map();
    const cs = (el) => {
      let s = styles.get(el);
      if (!s) {
        s = getComputedStyle(el);
        styles.set(el, s);
      }
      return s;
    };
    // Opacity multiplies down the tree: a title inside an opacity:0 bar paints nothing.
    const opacity = (el) => {
      if (!el || el.nodeType !== 1) return 1;
      let o = opac.get(el);
      if (o === undefined) {
        o = parseFloat(cs(el).opacity);
        if (!(o >= 0)) o = 1;
        o *= opacity(parentOf(el));
        opac.set(el, o);
      }
      return o;
    };
    const borderPaints = (s) =>
      ["Top", "Right", "Bottom", "Left"].map((side) =>
        parseFloat(s["border" + side + "Width"]) > 0 && !/^(?:none|hidden)$/.test(s["border" + side + "Style"]) && alpha(s["border" + side + "Color"]) > MIN_ALPHA
          ? parseFloat(s["border" + side + "Width"])
          : 0
      );
    // A ::before/::after that generates a box and paints something. APPROXIMATE: its own box is
    // not exposed to script, so a hit is credited across the originating element's whole box.
    const pseudo = (el) => {
      let p = pseudos.get(el);
      if (p !== undefined) return p;
      p = "";
      for (const which of ["::after", "::before"]) {
        const s = getComputedStyle(el, which);
        const content = s.content;
        if (!content || content === "none" || content === "normal" || s.display === "none" || s.visibility === "hidden") continue;
        if (!(parseFloat(s.opacity) > MIN_ALPHA)) continue;
        const text = /^["']./.test(content) && alpha(s.color) > MIN_ALPHA;
        if (alpha(s.backgroundColor) > MIN_ALPHA || (s.backgroundImage && s.backgroundImage !== "none") || borderPaints(s).some(Boolean) || text) {
          p = which;
          break;
        }
      }
      pseudos.set(el, p);
      return p;
    };
    // Static paint facts for an element: "whole" when its entire box paints (media, a control,
    // a background colour or image, a backdrop filter), else the bits that paint only in places —
    // its border band, its own text runs, a pseudo-element. A `filter` alone is not paint: on a
    // transparent box it has nothing to filter (its children are checked on their own).
    const info = (el) => {
      let p = infos.get(el);
      if (p) return p;
      const s = cs(el);
      const tag = el.localName;
      p = { whole: "", border: null, text: null, pseudo: "" };
      if (MEDIA.has(tag) || el.namespaceURI === SVG_NS) p.whole = "media";
      else if (CONTROLS.has(tag) && s.appearance && s.appearance !== "none") p.whole = "control";
      else if (alpha(s.backgroundColor) > MIN_ALPHA) p.whole = "background";
      else if (s.backgroundImage && s.backgroundImage !== "none") p.whole = "image";
      else if (s.backdropFilter && s.backdropFilter !== "none") p.whole = "backdrop";
      if (!p.whole) {
        const bw = borderPaints(s);
        if (bw.some(Boolean)) p.border = { r: el.getBoundingClientRect(), w: bw };
        const fill = s.getPropertyValue("-webkit-text-fill-color") || s.color;
        if (alpha(s.color) > MIN_ALPHA && alpha(fill) > MIN_ALPHA) {
          const rects = [];
          for (const n of el.childNodes) {
            if (n.nodeType !== 3 || !n.data.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const q of range.getClientRects()) rects.push(q);
          }
          if (rects.length) p.text = rects;
        }
        p.pseudo = pseudo(el);
      }
      infos.set(el, p);
      return p;
    };
    // Does el put visible paint at (x, y)? Returns how ("text", "background", …) or "".
    const paintsAt = (el, x, y) => {
      if (opacity(el) <= MIN_ALPHA) return "";
      const p = info(el);
      if (p.whole) return p.whole;
      if (p.text && p.text.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return "text";
      if (p.border) {
        const { r, w } = p.border;
        if (!(x >= r.left + w[3] && x <= r.right - w[1] && y >= r.top + w[0] && y <= r.bottom - w[2])) return "border";
      }
      return p.pseudo ? "pseudo" : "";
    };
    const paintsAnything = (el) => {
      const p = info(el);
      return !!(p.whole || p.border || p.text || p.pseudo);
    };

    // Paint order WITHOUT the hit test, for what elementsFromPoint cannot see: an element whose
    // pointer-events:none outranks the forcing sheet — a click-through rule (user-origin
    // !important in the extension) or a page's inline !important. CSS 2.1 Appendix E,
    // approximated: find the deepest stacking context holding both, take each side's
    // participant in it (its topmost stacking context below it, else its nearest positioned
    // box, else itself) and compare by layer — negative z · in-flow · positioned z-auto/0 ·
    // positive z — then tree order. Floats and inline-vs-block interleaving are ignored.
    const flexItem = (el) => {
      const p = parentOf(el);
      return !!p && p.nodeType === 1 && /flex|grid/.test(cs(p).display);
    };
    const positioned = (el) => cs(el).position !== "static";
    const zOf = (el) => {
      const s = cs(el);
      return s.zIndex === "auto" || (s.position === "static" && !flexItem(el)) ? null : parseInt(s.zIndex, 10) || 0;
    };
    const scMemo = new Map();
    const formsSC = (el) => {
      let v = scMemo.get(el);
      if (v !== undefined) return v;
      const s = cs(el);
      v =
        el === document.documentElement ||
        s.position === "fixed" ||
        s.position === "sticky" ||
        zOf(el) !== null ||
        parseFloat(s.opacity) < 1 ||
        s.transform !== "none" ||
        s.filter !== "none" ||
        s.perspective !== "none" ||
        s.clipPath !== "none" ||
        (!!s.mask && s.mask !== "none") ||
        s.mixBlendMode !== "normal" ||
        s.isolation === "isolate" ||
        (!!s.backdropFilter && s.backdropFilter !== "none") ||
        /transform|opacity|filter|perspective|z-index/.test(s.willChange) ||
        /paint|layout|strict|content/.test(s.contain);
      scMemo.set(el, v);
      return v;
    };
    const contexts = (el) => {
      const out = [];
      for (let a = parentOf(el); a; a = parentOf(a)) if (a.nodeType === 1 && formsSC(a)) out.unshift(a);
      return out;
    };
    const participant = (el, C) => {
      let sc = null;
      let pos = null;
      for (let n = el; n && n !== C; n = parentOf(n)) {
        if (formsSC(n)) sc = n;
        if (!pos && positioned(n)) pos = n;
      }
      return sc || pos || el;
    };
    const layer = (p) => {
      const z = zOf(p);
      if (z !== null && z < 0) return [0, z];
      if (z !== null && z > 0) return [3, z];
      return positioned(p) || formsSC(p) ? [2, 0] : [1, 0];
    };
    const aboveMemo = new Map();
    const above = (a, b) => {
      let byB = aboveMemo.get(a);
      if (!byB) aboveMemo.set(a, (byB = new Map()));
      let v = byB.get(b);
      if (v !== undefined) return v;
      const ca = contexts(a);
      const cb = contexts(b);
      let C = null;
      for (let i = 0; i < ca.length && i < cb.length && ca[i] === cb[i]; i++) C = ca[i];
      const pa = participant(a, C);
      const pb = participant(b, C);
      const x = pa !== pb ? pa : a;
      const y = pa !== pb ? pb : b;
      const la = pa !== pb ? layer(pa) : [0, 0];
      const lb = pa !== pb ? layer(pb) : [0, 0];
      v = la[0] !== lb[0] ? la[0] > lb[0] : la[1] !== lb[1] ? la[1] > lb[1] : !!(y.compareDocumentPosition(x) & 4); // 4 = x FOLLOWS y
      byB.set(b, v);
      return v;
    };
    return { cs, opacity, pseudo, info, paintsAt, paintsAnything, above };
  }

  // A rule's own `transition … !important` (hide-until-hover) outranks the freeze sheet — it is
  // user-origin in the extension — so a fade still in flight is FINISHED instead: the census
  // reads where the page is going, not one frame of the fade (the page sees a transitionend a
  // little early). Only transitions: finishing a page's own animation would end its loops.
  function finishTransitions() {
    if (!document.getAnimations) return 0;
    let n = 0;
    for (const a of document.getAnimations()) {
      if (!("transitionProperty" in a) || a.playState !== "running") continue;
      try {
        a.finish();
        n++;
      } catch (_) {
        /* infinite or detached: leave it */
      }
    }
    return n;
  }

  // Painting elements the forced hit test still cannot reach (see above()), with their boxes.
  function ghostPainters(ctx) {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (ours(el)) continue;
      const s = ctx.cs(el);
      if (s.pointerEvents !== "none" || s.visibility === "hidden" || ctx.opacity(el) <= MIN_ALPHA || !ctx.paintsAnything(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) out.push({ el, rect: r });
    }
    return out;
  }
  const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const overlaps = (r, v) => r.left < v.x1 && r.right > v.x0 && r.top < v.y1 && r.bottom > v.y0;

  // The part of el actually on screen: its box ∩ the viewport ∩ every overflow-clipping
  // ancestor (feed.html clips its tiles by an inner scroller). Border radius and transforms on
  // the clippers are ignored — a sampled point that misses the target is dropped anyway.
  function visibleRect(ctx, el, vp) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || ctx.cs(el).visibility === "hidden") return null;
    let x0 = Math.max(r.left, 0);
    let y0 = Math.max(r.top, 0);
    let x1 = Math.min(r.right, vp.w);
    let y1 = Math.min(r.bottom, vp.h);
    let fixed = ctx.cs(el).position === "fixed";
    for (let a = parentOf(el); a && a !== document.documentElement && !fixed && x1 > x0 && y1 > y0; a = parentOf(a)) {
      const s = ctx.cs(a);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const q = a.getBoundingClientRect();
        x0 = Math.max(x0, q.left);
        y0 = Math.max(y0, q.top);
        x1 = Math.min(x1, q.right);
        y1 = Math.min(y1, q.bottom);
      }
      if (s.position === "fixed") fixed = true;
    }
    return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x0, y0, x1, y1 } : null;
  }

  // --- describing elements --------------------------------------------------------------------
  function describe(el, pseudo) {
    if (!el || el.nodeType !== 1) return "";
    let s = el.localName;
    if (el.id) s += "#" + el.id + (hashy(el.id) ? "(hashed)" : "");
    for (const { name, value } of Array.from(el.attributes)) {
      if (name.startsWith("data-") || DESC_ATTRS.includes(name)) s += `[${name}="${clip(value, 30)}"]`;
    }
    if (pseudo) s += pseudo;
    const cls = classList(el).map((c) => {
      const k = classKind(c).kind;
      return "." + c + (k === "semantic" ? "" : `(${k})`);
    });
    if (cls.length) s += " " + cls.join(" ");
    // Text only for small subtrees — a container's text is every tile's caption run together.
    const small = el.getElementsByTagName("*").length <= 12;
    const text = small ? clip(typeof el.innerText === "string" ? el.innerText : el.textContent, 40) : "";
    if (text) s += ` "${text}"`;
    else if (small) {
      // Icon-only controls: their labels say what the thing is.
      const labels = Array.from(el.querySelectorAll("[aria-label],[title],[alt]"), (n) => n.getAttribute("aria-label") || n.getAttribute("title") || n.getAttribute("alt")).filter(Boolean);
      if (labels.length) s += ` ⟨${labels.slice(0, 4).join(" · ")}${labels.length > 4 ? ` +${labels.length - 4} more` : ""}⟩`;
    }
    return s;
  }

  // A CSS path to exactly this element in the CURRENT page state — the handle `inspect` takes
  // back. Positional, so it is never offered as a rule selector.
  function uniquePath(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n === document.documentElement) {
        parts.unshift("html");
        break;
      }
      if (n.id) {
        const sel = "#" + CSS.escape(n.id);
        if (document.querySelectorAll(sel).length === 1) {
          parts.unshift(sel);
          break;
        }
      }
      const p = n.parentElement;
      parts.unshift(`${n.localName}:nth-child(${p ? Array.prototype.indexOf.call(p.children, n) + 1 : 1})`);
    }
    const path = parts.join(" > ");
    try {
      return document.querySelector(path) === el ? path : "";
    } catch (_) {
      return "";
    }
  }

  // --- candidates -----------------------------------------------------------------------------
  // Tiers, best first: test-hook attributes · other stable attributes and ids · semantic classes ·
  // attribute presence/prefix · structure anchored on stable hooks · CSS-module prefix · utility
  // classes · nth-child · hashed classes. Tiers only break ties: the ranking is coverage of the
  // role first (every same-role element, nothing else), then stability, then length. "Stable"
  // means no hashed class, no CSS-module prefix and no nth-child in the selector.
  const TIER_KIND = ["attribute", "attribute", "class", "attribute", "structure", "module-prefix", "utility", "nth-child", "hashed"];
  const HASHED_FLAG = "hashed: breaks on site update";

  // Selectors that pick el out by its OWN hooks. `role` decides whether an attribute value is
  // shared by every same-role element (→ exact value) or varies per item (→ presence / prefix).
  function selfHooks(el, role) {
    const tag = el.localName;
    const out = [];
    const add = (sel, tier, flags = [], stable = true) => out.push({ sel, tier, flags, stable });
    for (const { name, value } of Array.from(el.attributes)) {
      const isData = name.startsWith("data-");
      if (!isData && !HOOK_ATTRS.has(name)) continue;
      if (isData && (SKIP_DATA.test(name) || hashy(name.slice(5)))) continue;
      const flags = LOCALIZED.has(name) ? ["text: changes with the page language"] : [];
      if (identity(el, name)) {
        // Never the value form: it names this one item and breaks when the next one is active.
        add(`${tag}[${name}]`, 3, ["per-item identity attribute: presence only, its value names one item"]);
        continue;
      }
      const constant = role.every((x) => x.getAttribute(name) === value);
      if (constant && stableValue(value)) {
        const tier = TEST_ATTR.test(name) ? 0 : 1;
        add(`[${name}=${cssStr(value)}]`, tier, flags);
        add(`${tag}[${name}=${cssStr(value)}]`, tier, flags);
        continue;
      }
      const m = /^(.*\D)\d+$/.exec(value); // "clip-123" → [attr^="clip-"]
      if (m && stableValue(m[1]) && role.every((x) => (x.getAttribute(name) || "").startsWith(m[1]))) add(`${tag}[${name}^=${cssStr(m[1])}]`, 3, flags);
      if (isData || name === "aria-label" || name === "role") add(`${tag}[${name}]`, 3, flags);
    }
    if (el.id && !hashy(el.id)) {
      if (role.length === 1 && stableValue(el.id) && !identity(el, "id")) add("#" + CSS.escape(el.id), 1);
      const m = /^(.*\D)\d+$/.exec(el.id);
      if (m && stableValue(m[1]) && role.every((x) => x.id.startsWith(m[1]))) add(`${tag}[id^=${cssStr(m[1])}]`, 3);
    }
    const semantic = [];
    const utility = [];
    const hashed = [];
    for (const c of classList(el)) {
      const k = classKind(c);
      const dot = "." + CSS.escape(c);
      if (k.kind === "semantic" && isState(c)) {
        add(dot, 3, ["state class: matches only while the element is in that state"]);
      } else if (k.kind === "semantic") {
        semantic.push(dot);
        add(dot, 2);
        add(tag + dot, 2);
      } else if (k.kind === "utility") utility.push(dot);
      else {
        hashed.push(dot);
        // A CSS-module prefix (Name_part__) usually survives a rebuild — but not a rename, and
        // a renamed prefix can land on a DIFFERENT element (seen on feed.html across deploys),
        // so it ranks above nth-child/hashed without ever counting as stable.
        if (k.prefix && stableValue(k.prefix)) add(`${tag}[class*=${cssStr(k.prefix)}]`, 5, ["css-module prefix: survives a rebuild, not a component rename"], false);
        add(tag + dot, 8, [HASHED_FLAG], false);
      }
    }
    if (semantic.length > 1) add(tag + semantic.join(""), 2);
    if (utility.length) add(tag + utility.join(""), 6, ["utility classes: shared by unrelated elements, rewritten on restyle"]);
    if (hashed.length > 1) add(tag + hashed.join(""), 8, [HASHED_FLAG], false);
    return out;
  }

  const nthStep = (n) => {
    const p = n.parentElement;
    return `${n.localName}:nth-child(${p ? Array.prototype.indexOf.call(p.children, n) + 1 : 1})`;
  };

  // Structure: a stable anchor plus a short walk down to el. Two anchors are tried: the nearest
  // ancestor with a stable hook of its own (data-testid="meta" → `[data-testid="meta"] > span`),
  // and the TILE — the nearest ancestor holding exactly one target — named by its own hook or by
  // `:has(> video)`. A container holding many targets (the grid) anchors only by its own hook.
  function bestHook(n, maxTier) {
    const hooks = selfHooks(n, roleSet(n)).filter((h) => h.stable && h.tier <= maxTier);
    hooks.sort((a, b) => a.tier - b.tier || a.sel.length - b.sel.length);
    return hooks.length ? hooks[0].sel : "";
  }
  function structural(el, target, out) {
    const root = document.documentElement;
    const body = document.body;
    const holds = (a) => {
      try {
        if (a.matches(target)) return 1;
        const list = a.querySelectorAll(target);
        return list.length;
      } catch (_) {
        return 0;
      }
    };
    const anchors = [];
    let hooked = false;
    let tiled = false;
    let depth = 0;
    for (let a = parentOf(el); a && a !== root && a !== body && ++depth <= 6; a = parentOf(a)) {
      const n = holds(a);
      if (!hooked) {
        const h = bestHook(a, 1);
        if (h) {
          hooked = true;
          anchors.push({ node: a, sel: h });
        }
      }
      if (n === 1 && !tiled) {
        tiled = true;
        const own = bestHook(a, 3);
        if (own && !anchors.some((x) => x.sel === own)) anchors.push({ node: a, sel: own });
        const t = /,/.test(target) ? `:is(${target})` : target;
        const direct = Array.from(a.children).some((c) => {
          try {
            return c.matches(target);
          } catch (_) {
            return false;
          }
        });
        anchors.push({ node: a, sel: `${a.localName}:has(${direct ? "> " : ""}${t})` });
      }
      if (n > 1 || (hooked && tiled)) break;
    }
    for (const { node, sel } of anchors) {
      const steps = [];
      for (let n = el; n && n !== node; n = parentOf(n)) steps.unshift(n);
      const chain = steps.map((n) => bestHook(n, 3) || n.localName);
      const nth = steps.map((n, i) => (chain[i] === n.localName ? nthStep(n) : chain[i]));
      const last = chain[chain.length - 1];
      out.push({ sel: `${sel} > ${chain.join(" > ")}`, tier: 4, flags: [], stable: true });
      if (steps.length > 1 && last !== el.localName) out.push({ sel: `${sel} ${last}`, tier: 4, flags: [], stable: true });
      if (nth.join() !== chain.join()) out.push({ sel: `${sel} > ${nth.join(" > ")}`, tier: 7, flags: ["nth-child: breaks when siblings are added or reordered"], stable: false });
    }
  }

  // Ranked candidates for el (optionally a pseudo-element of it). Each is evaluated against
  // the live document: matches, how many of them share el's role (off-screen tiles included),
  // and how many are something else.
  function candidatesFor(el, target, pseudo) {
    const role = roleSet(el);
    const roleIds = new Set(role);
    const raw = selfHooks(el, role);
    if (!pseudo) structural(el, target, raw);
    const seen = new Set();
    const out = [];
    for (const c of raw) {
      if (seen.has(c.sel)) continue;
      seen.add(c.sel);
      let matched;
      try {
        matched = document.querySelectorAll(c.sel);
      } catch (_) {
        continue;
      }
      let sameRole = 0;
      let firstExtra = null;
      for (const m of matched) {
        if (roleIds.has(m)) sameRole++;
        else if (!firstExtra) firstExtra = m;
      }
      const matches = matched.length;
      const extra = matches - sameRole;
      const flags = c.flags.slice();
      if (extra) flags.push(`extra matches: ${extra} (e.g. ${clip(describe(firstExtra), 80)})`);
      if (sameRole < role.length) flags.push(`misses ${role.length - sameRole} of ${role.length} same-role elements`);
      const exact = extra === 0 && sameRole === role.length;
      const sel = pseudo ? c.sel + pseudo : c.sel;
      const score = (exact ? 100 : 0) + (c.stable ? 50 : 0) + 20 * (sameRole / role.length) - 10 * Math.min(1, extra / role.length) - 2 * c.tier - sel.length / 100;
      out.push({ selector: sel, matches, sameRole, extra, stable: c.stable, flags, score: Math.round(score * 100) / 100, kind: TIER_KIND[c.tier] });
    }
    out.sort((a, b) => b.score - a.score);
    return { candidates: out, roleCount: role.length };
  }

  // --- where an overlay sits on its target --------------------------------------------------
  function whereText(f, what) {
    const { l, t, r, b } = f;
    const w = r - l;
    const h = b - t;
    const pct = (n) => Math.max(1, Math.round(n * 100)) + "%";
    const fullW = w >= 0.9;
    const fullH = h >= 0.9;
    if (fullW && fullH) return `covers the whole ${what}`;
    const touchT = t <= EDGE;
    const touchB = b >= 1 - EDGE;
    const touchL = l <= EDGE;
    const touchR = r >= 1 - EDGE;
    if (fullW) return `${touchT && !touchB ? "top edge" : touchB && !touchT ? "bottom edge" : "middle band"}, full width, ${pct(h)} tall`;
    if (fullH) return `${touchL && !touchR ? "left edge" : touchR && !touchL ? "right edge" : "middle column"}, full height, ${pct(w)} wide`;
    const cy = (t + b) / 2;
    const cx = (l + r) / 2;
    const v = touchT && !touchB ? "top" : touchB && !touchT ? "bottom" : "";
    const hz = touchL && !touchR ? "left" : touchR && !touchL ? "right" : "";
    let pos;
    if (v && hz) pos = `${v}-${hz} corner`;
    else if (v) pos = `${v} edge`;
    else if (hz) pos = `${hz} edge`;
    else pos = `${cy < 1 / 3 ? "upper" : cy > 2 / 3 ? "lower" : "middle"} ${cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center"}`.replace("middle center", "center");
    return `${pos}, ${pct(w)} wide × ${pct(h)} tall`;
  }

  // --- overlays -------------------------------------------------------------------------------
  function overlays(cmd) {
    const t0 = performance.now();
    const target = cmd.target || "video";
    const cols = Math.max(1, Math.round(cmd.cols || 12));
    const rows = Math.max(1, Math.round(cmd.rows || 8));
    let all;
    try {
      all = Array.from(document.querySelectorAll(target));
    } catch (e) {
      return { ok: false, reason: `invalid target selector "${target}": ${e.message}`, target };
    }
    const sheet = addSheet(FORCE_PE + FREEZE);
    const exemplars = new Map(); // output group → its measurement, for the post-pass below
    let result;
    try {
      finishTransitions();
      const ctx = makeCtx();
      const vp = viewport();
      const vpArea = vp.w * vp.h;
      const root = document.documentElement;
      const body = document.body;
      const measured = [];
      all.forEach((el, i) => {
        const vis = visibleRect(ctx, el, vp);
        if (vis) measured.push({ el, i, vis, rect: el.getBoundingClientRect() });
      });
      const base = { ok: true, target, targets: all.length, measured: measured.length };
      // A container target (the tile) "is covered" by its own player and backdrop — every
      // number below would describe the wrong layer. Say so, so the agent re-targets.
      const holder = containerHint(target, measured.length ? measured.map((m) => m.el) : all);
      if (!measured.length) {
        const hints = hintsFor(target, all, ctx, vp);
        if (holder) hints.unshift(holder);
        return { ...base, reason: all.length ? `${all.length} element(s) match "${target}" but none is on screen` : `nothing matches "${target}" in this frame`, points: 0, coverage: 0, perTarget: [], groups: [], hints, ms: Math.round(performance.now() - t0) };
      }
      if (holder) {
        base.reason = holder;
        base.hints = [holder];
      }

      const holds = (a) => {
        let n = 0;
        for (const t of all) if (a.contains(t) && ++n > 1) break;
        return n;
      };
      const childOnPath = (anc, el) => {
        let c = el;
        while (c && parentOf(c) !== anc) c = parentOf(c);
        return c;
      };
      // A box that paints nothing, spans most of the target and holds several children only
      // GROUPS overlays; the overlays are its children.
      const isWrapper = (u, tRect) => {
        if (ctx.paintsAnything(u) || u.children.length < 2) return false;
        const r = u.getBoundingClientRect();
        const ix = Math.max(0, Math.min(r.right, tRect.right) - Math.max(r.left, tRect.left));
        const iy = Math.max(0, Math.min(r.bottom, tRect.bottom) - Math.max(r.top, tRect.top));
        return (ix * iy) / Math.max(1, area(tRect)) >= WRAPPER_COVER;
      };
      // Painter → the overlay it belongs to. INSIDE: the painter shares a container with exactly
      // this one target (the tile) — the overlay is the tile's child on the way to the painter,
      // unwrapped through pure wrappers. OUTSIDE: a separate layer — climb while the box stays
      // local (not a page-sized layer) and holds no target.
      const units = new Map();
      const unitOf = (painter, tgt) => {
        let byT = units.get(painter);
        if (!byT) units.set(painter, (byT = new Map()));
        let u = byT.get(tgt.el);
        if (u) return u;
        if (painter.contains(tgt.el)) {
          u = { unit: painter, pseudo: ctx.pseudo(painter) || "::after", relation: "inside" };
        } else {
          let ca = parentOf(painter);
          while (ca && !ca.contains(tgt.el)) ca = parentOf(ca);
          if (ca && ca !== root && ca !== body && holds(ca) === 1 && area(ca.getBoundingClientRect()) <= INSIDE_AREA * Math.max(1, area(tgt.rect))) {
            let unit = childOnPath(ca, painter);
            while (unit !== painter && isWrapper(unit, tgt.rect)) unit = childOnPath(unit, painter);
            u = { unit, pseudo: "", relation: "inside" };
          } else {
            let unit = painter;
            for (let p = parentOf(unit); p && p !== root && p !== body && holds(p) === 0 && area(p.getBoundingClientRect()) < LAYER_AREA * vpArea; p = parentOf(p)) unit = p;
            u = { unit, pseudo: "", relation: "outside" };
          }
        }
        u.key = `${u.relation}|${u.pseudo}|${roleSig(u.unit)}`;
        byT.set(tgt.el, u);
        return u;
      };

      const groups = new Map();
      const boxes = new Map();
      const credit = (el, how, T, x, y, cell, hit, ghost) => {
        const u = unitOf(el, T);
        let g = groups.get(u.key);
        if (!g) {
          g = { key: u.key, relation: u.relation, pseudo: u.pseudo, exemplar: u.unit, els: new Map(), targets: new Set(), paints: new Set(), points: 0, ghost: false };
          groups.set(u.key, g);
        }
        let pairs = g.els.get(u.unit);
        if (!pairs) g.els.set(u.unit, (pairs = new Map()));
        let pr = pairs.get(T.el);
        if (!pr) pairs.set(T.el, (pr = { rect: T.rect, l: 1, t: 1, r: 0, b: 0, box: null }));
        // Where the group sits = the union of the boxes that actually PAINT, not the unit's own
        // box: redgifs' .GifPreview-InfoAndSidebar is 0 px tall with its rail overflowing it.
        if (!g.pseudo) {
          let q = boxes.get(el);
          if (!q) boxes.set(el, (q = el.getBoundingClientRect()));
          pr.box = pr.box ? { left: Math.min(pr.box.left, q.left), top: Math.min(pr.box.top, q.top), right: Math.max(pr.box.right, q.right), bottom: Math.max(pr.box.bottom, q.bottom) } : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
        }
        // Covered-point extent in target fractions, half a cell of slack each way — the only
        // position a pseudo-element group has.
        const fx = (x - T.rect.left) / T.rect.width;
        const fy = (y - T.rect.top) / T.rect.height;
        pr.l = Math.min(pr.l, fx - cell.x);
        pr.r = Math.max(pr.r, fx + cell.x);
        pr.t = Math.min(pr.t, fy - cell.y);
        pr.b = Math.max(pr.b, fy + cell.y);
        g.targets.add(T.el);
        g.paints.add(how);
        if (ghost) g.ghost = true;
        if (!hit.has(u.key)) {
          hit.add(u.key);
          g.points++;
        }
      };

      const ghosts = ghostPainters(ctx);
      const perTarget = [];
      let points = 0;
      let covered = 0;
      for (const T of measured) {
        const { vis } = T;
        const w = vis.x1 - vis.x0;
        const h = vis.y1 - vis.y0;
        const cell = { x: w / cols / 2 / T.rect.width, y: h / rows / 2 / T.rect.height };
        // Painters the hit test cannot see that sit above this target by paint order.
        const over = ghosts.filter((g) => g.el !== T.el && !g.el.contains(T.el) && !T.el.contains(g.el) && overlaps(g.rect, vis) && ctx.above(g.el, T.el));
        // A target that is itself un-hittable (a click-through rule on its whole tile) is never
        // in the stack: every grid point counts, and what is above it is decided by paint order.
        const blind = ctx.cs(T.el).pointerEvents === "none";
        let tp = 0;
        let tc = 0;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const x = vis.x0 + ((i + 0.5) / cols) * w;
            const y = vis.y0 + ((j + 0.5) / rows) * h;
            const stack = document.elementsFromPoint(x, y);
            const idx = blind ? stack.length : stack.indexOf(T.el);
            if (idx < 0) continue; // clipped (rounded corner, scroller edge): not part of the target here
            tp++;
            const hit = new Set();
            for (let k = 0; k < idx; k++) {
              const el = stack[k];
              if (ours(el)) continue;
              let how;
              if (blind) how = el.contains(T.el) || T.el.contains(el) || !ctx.above(el, T.el) ? "" : ctx.paintsAt(el, x, y);
              // An ANCESTOR of the target is only listed above it because one of its
              // pseudo-elements paints there (a tile::after gradient) — Gecko lists it twice.
              else how = el.contains(T.el) ? (ctx.pseudo(el) && ctx.opacity(el) > MIN_ALPHA ? "pseudo" : "") : ctx.paintsAt(el, x, y);
              if (how) credit(el, how, T, x, y, cell, hit, false);
            }
            for (const g of over) {
              if (!inRect(g.rect, x, y)) continue;
              const how = ctx.paintsAt(g.el, x, y);
              if (how) credit(g.el, how, T, x, y, cell, hit, true);
            }
            if (hit.size) tc++;
          }
        }
        points += tp;
        covered += tc;
        perTarget.push({ i: T.i, coverage: tp ? r3(tc / tp) : 0, points: tp, rect: box({ left: vis.x0, top: vis.y0, width: w, height: h }) });
      }
      const what = /^[a-z]+$/i.test(target) ? target.toLowerCase() : "target";
      const out = [];
      for (const g of groups.values()) {
        const fr = { l: [], t: [], r: [], b: [] };
        for (const pairs of g.els.values()) {
          for (const pr of pairs.values()) {
            let f;
            if (g.pseudo || !pr.box) f = { l: pr.l, t: pr.t, r: pr.r, b: pr.b };
            else {
              const q = pr.box;
              const tr = pr.rect;
              f = { l: (q.left - tr.left) / tr.width, t: (q.top - tr.top) / tr.height, r: (q.right - tr.left) / tr.width, b: (q.bottom - tr.top) / tr.height };
            }
            fr.l.push(Math.min(1, Math.max(0, f.l)));
            fr.t.push(Math.min(1, Math.max(0, f.t)));
            fr.r.push(Math.min(1, Math.max(0, f.r)));
            fr.b.push(Math.min(1, Math.max(0, f.b)));
          }
        }
        const { candidates, roleCount } = candidatesFor(g.exemplar, target, g.pseudo);
        const entry = {
          key: g.key,
          count: g.els.size,
          targetsCovered: g.targets.size,
          share: r3(g.points / points),
          where: whereText({ l: median(fr.l), t: median(fr.t), r: median(fr.r), b: median(fr.b) }, what),
          relation: g.relation,
          desc: describe(g.exemplar, g.pseudo),
          path: uniquePath(g.exemplar),
          sig: roleSig(g.exemplar),
          paints: Array.from(g.paints),
          roleCount,
          ...(g.pseudo ? { pseudo: g.pseudo } : {}),
          ...(g.ghost ? { placedBy: "paint order (pointer-events:none outranks the census) — approximate" } : {}),
          candidates,
        };
        exemplars.set(entry, g);
        out.push(entry);
      }
      out.sort((a, b) => b.share - a.share || b.count - a.count);
      result = { ...base, points, coverage: points ? r3(covered / points) : 0, perTarget, groups: out };
    } catch (e) {
      return { ok: false, reason: "overlay census failed: " + ((e && e.message) || e), target };
    } finally {
      sheet.remove();
    }
    // With the forcing sheet gone: does each overlay take clicks at all? A pointer-events:none
    // scrim already lets them through — no click-through rule needed for it.
    for (const [entry, g] of exemplars) {
      try {
        entry.clicks = getComputedStyle(g.exemplar, g.pseudo || null).pointerEvents !== "none";
      } catch (_) {
        /* detached meanwhile */
      }
    }
    result.ms = Math.round(performance.now() - t0);
    return result;
  }

  function containerHint(target, els) {
    const tally = new Map();
    let holding = 0;
    for (const el of els) {
      if (MEDIA.has(el.localName)) continue;
      // By priority, not document order: a feed item's thumbnail <img> precedes its <video>.
      const tag = ["video", "canvas", "iframe", "embed", "object", "img"].find((t) => el.querySelector(t));
      if (!tag) continue;
      holding++;
      tally.set(tag, (tally.get(tag) || 0) + 1);
    }
    if (!holding) return "";
    const tag = Array.from(tally).sort((a, b) => b[1] - a[1])[0][0];
    return `the target "${target}" CONTAINS a <${tag}> (${holding} of ${els.length}): its own player, backdrop and controls count as covering it — measure the media element instead (target: "${tag}")`;
  }

  // Nothing measured — say where the videos might be instead.
  function hintsFor(target, all, ctx, vp) {
    const hints = [];
    const onScreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vp.w && r.top < vp.h;
    };
    if (all.length) hints.push(`${all.length} "${target}" match in this frame but none is visible — scroll to them, or they are hidden (display:none / zero size / clipped)`);
    const frames = Array.from(document.querySelectorAll("iframe, frame")).filter(onScreen);
    if (frames.length) {
      const srcs = frames.map((f) => clip(f.src || (f.hasAttribute("srcdoc") ? "srcdoc" : "about:blank"), 60));
      hints.push(`${frames.length} iframe(s) on screen (${srcs.join(", ")}) — a video inside one is only measured by a census run in that frame`);
    }
    const canvases = Array.from(document.querySelectorAll("canvas")).filter(onScreen);
    if (canvases.length) {
      const big = canvases.map((c) => c.getBoundingClientRect()).sort((a, b) => area(b) - area(a))[0];
      hints.push(`${canvases.length} canvas element(s) on screen (largest ${Math.round(big.width)}×${Math.round(big.height)}) — a video drawn into a canvas is pixels: overlays painted into it cannot be removed with CSS, only ones layered above the canvas`);
    }
    const hosts = [];
    let inShadow = 0;
    for (const el of document.querySelectorAll("*")) {
      const sr = el.openOrClosedShadowRoot || el.shadowRoot; // the former exists for content scripts only
      if (!sr) continue;
      try {
        const n = sr.querySelectorAll(target).length;
        if (n) {
          inShadow += n;
          hosts.push(el.localName);
        }
      } catch (_) {
        /* invalid target already reported */
      }
    }
    if (inShadow) hints.push(`${inShadow} "${target}" inside shadow DOM (hosts: ${Array.from(new Set(hosts)).join(", ")}) — document selectors cannot reach into it; target the host element instead`);
    if (!hints.length) hints.push(`no "${target}", iframe, canvas or shadow-DOM video found — maybe it has not loaded yet (settle, then retry) or the target selector is wrong`);
    return hints;
  }

  // --- inspect / test / count -----------------------------------------------------------------
  // Top-level commas only (not the ones inside :is(…) or [a="x,y"]).
  function splitList(sel) {
    const out = [];
    let depth = 0;
    let quote = "";
    let cur = "";
    for (const ch of sel) {
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  // The element part of a selector, for querySelectorAll — pseudo-elements never match there, so
  // `.card::after` counts its cards. A selector that is NOTHING BUT a pseudo-element (`::after`)
  // would strip to "every element" and read healthy forever, so it is refused instead.
  function elementPart(sel) {
    const raw = splitList(String(sel || ""));
    const parts = raw.map((p) => p.replace(PSEUDO, "").trim());
    const bare = parts.findIndex((p) => !p);
    if (bare >= 0) {
      throw new Error(`"${raw[bare].trim() || sel}" is only a pseudo-element — it applies to every element on the page; name the element it belongs to (e.g. .card::after)`);
    }
    return parts.join(", ");
  }

  // Elements that play the role `sig` (roleSig) — one on screen over a target first.
  function findBySig(sig, target) {
    const tag = /^[\w-]+/.exec(sig);
    if (!tag) return null;
    let all;
    try {
      all = Array.from(document.querySelectorAll(tag[0])).filter((x) => roleSig(x) === sig);
    } catch (_) {
      return null;
    }
    if (!all.length) return null;
    let rects = [];
    try {
      rects = Array.from(document.querySelectorAll(target), (t) => t.getBoundingClientRect());
    } catch (_) {
      /* no target: any on-screen one will do */
    }
    const vp = viewport();
    const score = (x) => {
      const r = x.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= vp.h || r.left >= vp.w) return 0;
      return rects.some((q) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) ? 2 : 1;
    };
    return all.map((x) => [x, score(x)]).sort((a, b) => b[1] - a[1])[0][0];
  }

  // `path` is positional, so in a recycling feed it points at a DIFFERENT element after a scroll.
  // With the `sig` emitted next to it, the element there is checked, and when it no longer plays
  // that role, another element that does is used (relocated:true) — else the ref is stale.
  function resolve(cmd) {
    if (cmd.path) {
      let el;
      try {
        el = document.querySelector(cmd.path);
      } catch (e) {
        return { error: `bad path: ${e.message}` };
      }
      if (cmd.sig && (!el || roleSig(el) !== cmd.sig)) {
        const other = findBySig(cmd.sig, cmd.target || "video");
        if (other) return { el: other, relocated: true };
        return { stale: true, error: `the element at ${cmd.path} is gone or now plays a different role, and nothing on the page plays its old one — run overlays (or pick) again` };
      }
      return el ? { el } : { error: `nothing at path ${cmd.path} — the page changed; run overlays again` };
    }
    if (cmd.selector) {
      try {
        const list = document.querySelectorAll(elementPart(cmd.selector));
        const i = cmd.index || 0;
        return list[i] ? { el: list[i] } : { error: `"${cmd.selector}" matches ${list.length} element(s); no index ${i}` };
      } catch (e) {
        return { error: e.message };
      }
    }
    return { error: "inspect needs a path or a selector" };
  }

  function styleOf(el) {
    const s = getComputedStyle(el);
    return { position: s.position, zIndex: s.zIndex, opacity: s.opacity, pointerEvents: s.pointerEvents, display: s.display, overflow: s.overflow, transform: s.transform };
  }

  function inspectEl(el, target) {
    const holds = (a) => {
      try {
        return !!a.querySelector(target) || a.matches(target);
      } catch (_) {
        return false;
      }
    };
    const ancestors = [];
    for (let a = parentOf(el); a && a !== document.documentElement; a = parentOf(a)) {
      ancestors.push({ desc: describe(a), rect: box(a.getBoundingClientRect()), style: styleOf(a), containsTarget: holds(a) });
      if (a === document.body) break;
    }
    const { candidates, roleCount } = candidatesFor(el, target);
    const ctx = makeCtx();
    const p = ctx.info(el);
    const paints = [p.whole, p.text && "text", p.border && "border", p.pseudo && "pseudo"].filter(Boolean);
    return { ok: true, desc: describe(el), path: uniquePath(el), sig: roleSig(el), rect: box(el.getBoundingClientRect()), style: styleOf(el), paints, roleCount, ancestors, candidates };
  }

  function inspect(cmd) {
    const { el, error, stale, relocated } = resolve(cmd);
    if (!el) return stale ? { ok: false, stale: true, error } : { ok: false, error };
    const r = inspectEl(el, cmd.target || "video");
    if (relocated) r.relocated = true;
    return r;
  }

  // Which matched elements sit above a target: a 3×3 grid over each element∩target overlap,
  // hit-tested with pointer events forced, as in the census.
  function test(cmd) {
    const target = cmd.target || "video";
    const sel = String(cmd.selector || "");
    let matched;
    let targets;
    try {
      matched = Array.from(document.querySelectorAll(elementPart(sel)));
    } catch (e) {
      return { ok: false, error: e.message };
    }
    try {
      targets = Array.from(document.querySelectorAll(target));
    } catch (e) {
      return { ok: false, error: `invalid target selector: ${e.message}` };
    }
    const vp = viewport();
    const sheet = addSheet(FORCE_PE);
    try {
      finishTransitions();
      const ctx = makeCtx();
      const tr = targets.map((t) => t.getBoundingClientRect());
      let visible = 0;
      let overTarget = 0;
      let paintsOver = 0;
      let clickThrough = 0;
      for (const el of matched) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vp.w || r.top >= vp.h || ctx.cs(el).visibility === "hidden") continue;
        visible++;
        let above = false;
        let paints = false;
        // Un-hittable (a click-through rule already applies): decided by paint order + geometry.
        const blind = ctx.cs(el).pointerEvents === "none";
        if (blind) clickThrough++;
        const painters = blind ? [el, ...el.querySelectorAll("*")].filter((n) => ctx.opacity(n) > MIN_ALPHA && ctx.paintsAnything(n)) : [];
        targets.forEach((t, ti) => {
          if (above && paints) return;
          if (blind && (el.contains(t) || t.contains(el) || !ctx.above(el, t))) return;
          const q = tr[ti];
          const x0 = Math.max(r.left, q.left, 0);
          const y0 = Math.max(r.top, q.top, 0);
          const x1 = Math.min(r.right, q.right, vp.w);
          const y1 = Math.min(r.bottom, q.bottom, vp.h);
          if (x1 - x0 < 1 || y1 - y0 < 1) return;
          for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
              const x = x0 + ((i + 0.5) / 3) * (x1 - x0);
              const y = y0 + ((j + 0.5) / 3) * (y1 - y0);
              if (blind) {
                above = true;
                if (painters.some((n) => inRect(n.getBoundingClientRect(), x, y) && ctx.paintsAt(n, x, y))) paints = true;
                continue;
              }
              const stack = document.elementsFromPoint(x, y);
              const ti2 = stack.indexOf(t);
              if (ti2 < 0) continue;
              for (let k = 0; k < ti2; k++) {
                if (stack[k] === el || el.contains(stack[k])) {
                  above = true;
                  if (ctx.paintsAt(stack[k], x, y)) paints = true;
                }
              }
            }
          }
        });
        if (above) overTarget++;
        if (paints) paintsOver++;
      }
      const res = { ok: true, matches: matched.length, visible, overTarget, paintsOver, clickThrough, samples: matched.slice(0, SAMPLES).map((m) => clip(describe(m), 120)), total: matched.length };
      if (cmd.path) {
        // Relative to a known element (a group's exemplar, a picked element): is this selector
        // exactly that element's role?
        const { el, error, stale, relocated } = resolve({ path: cmd.path, sig: cmd.sig, target });
        if (!el) {
          if (stale) return { ok: false, stale: true, error };
          res.roleError = error;
        } else {
          if (relocated) res.relocated = true;
          const role = new Set(roleSet(el));
          res.roleCount = role.size;
          res.sameRole = matched.filter((m) => role.has(m)).length;
          res.extra = matched.length - res.sameRole;
        }
      }
      return res;
    } finally {
      sheet.remove();
    }
  }

  function count(cmd) {
    const target = cmd.target || "video";
    let targets;
    try {
      targets = document.querySelectorAll(target).length;
    } catch (e) {
      return { ok: false, error: `invalid target selector: ${e.message}` };
    }
    // Pseudo-elements never match querySelectorAll, so `tile::after` counts its tiles.
    const counts = (cmd.selectors || []).map((s) => {
      try {
        return document.querySelectorAll(elementPart(s)).length;
      } catch (e) {
        return { error: e.message };
      }
    });
    return { ok: true, targets, counts };
  }

  // --- scroll / settle ------------------------------------------------------------------------
  // The page's MAIN scroller: the window when it scrolls, else the largest visible scrollable
  // element (feed.html scrolls an inner <main> under a fixed header). Ones holding a target win.
  function findScroller(target) {
    const vp = viewport();
    const se = document.scrollingElement || document.documentElement;
    const hidden = (el) => el && /hidden|clip/.test(getComputedStyle(el).overflowY);
    const holds = (el) => {
      try {
        return !!el.querySelector(target);
      } catch (_) {
        return false;
      }
    };
    const cands = [];
    if (se.scrollHeight > se.clientHeight + 1 && !hidden(document.documentElement) && !hidden(document.body)) {
      cands.push({ el: null, area: vp.w * vp.h, range: se.scrollHeight - se.clientHeight, client: se.clientHeight, holds: true });
    }
    for (const el of document.querySelectorAll("body *")) {
      if (el.clientHeight < 50 || el.scrollHeight <= el.clientHeight + 1) continue;
      if (!/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, vp.w) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vp.h) - Math.max(r.top, 0));
      if (a < 1) continue;
      cands.push({ el, area: a, range: el.scrollHeight - el.clientHeight, client: el.clientHeight, holds: holds(el) });
    }
    let best = null;
    let bestScore = -1;
    for (const c of cands) {
      const s = c.area * (c.holds ? 1 : 0.5) * (c.range >= c.client / 2 ? 1 : 0.5);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  function scroll(cmd) {
    const s = findScroller(cmd.target || "video");
    if (!s) return { ok: false, error: "nothing on this page scrolls" };
    const el = s.el || document.scrollingElement || document.documentElement;
    const before = el.scrollTop;
    const top = before + (cmd.by == null ? 1 : Number(cmd.by)) * s.client;
    const scroller = s.el || window;
    try {
      scroller.scrollTo({ top, behavior: "instant" }); // beats a page's scroll-behavior:smooth
    } catch (_) {
      el.scrollTop = top;
    }
    const after = el.scrollTop;
    return { ok: true, scroller: s.el ? clip(describe(s.el), 120) : "window", before: Math.round(before), after: Math.round(after), atEnd: after + el.clientHeight >= el.scrollHeight - 2, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }

  // Resolves once the DOM has been quiet for quietMs, or at timeoutMs. Three kinds of record are
  // not activity: a no-op attribute write (feed.html rewrites every sticker's data-item each
  // frame — Gecko still queues a record); unless ignoreStyle:false, `style` attribute writes —
  // progress bars and per-frame repositioning write those forever; and unless ignoreText:false,
  // TEXT-only changes — a playing clip's countdown (redgifs' span.countdown) swaps its text every
  // second, and either would turn every settle into a full timeout. Loading and recycling always
  // insert/remove ELEMENTS or change other attributes, so they still count.
  function settle(cmd) {
    const quiet = cmd.quietMs == null ? 500 : Number(cmd.quietMs);
    const timeout = cmd.timeoutMs == null ? 5000 : Number(cmd.timeoutMs);
    const ignoreStyle = cmd.ignoreStyle !== false;
    const ignoreText = cmd.ignoreText !== false;
    const textOnly = (list) => Array.prototype.every.call(list, (n) => n.nodeType === 3 || n.nodeType === 8);
    return new Promise((done) => {
      const t0 = performance.now();
      let last = t0;
      let mutations = 0;
      let ignored = 0;
      const noise = (r) => {
        const t = r.target;
        if (t.nodeType === 1 && ours(t)) return true;
        if (r.type === "attributes") return (ignoreStyle && r.attributeName === "style") || r.oldValue === t.getAttribute(r.attributeName);
        if (r.type === "characterData") return ignoreText || r.oldValue === t.data;
        return ignoreText && textOnly(r.addedNodes) && textOnly(r.removedNodes);
      };
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (noise(r)) ignored++;
          else {
            mutations++;
            last = performance.now();
          }
        }
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
      const tick = () => {
        const now = performance.now();
        const timedOut = now - t0 >= timeout;
        if (now - last >= quiet || timedOut) {
          mo.disconnect();
          done({ ok: true, waitedMs: Math.round(now - t0), timedOut: timedOut && now - last < quiet, mutations, ignored });
          return;
        }
        setTimeout(tick, Math.max(10, Math.min(quiet - (now - last), timeout - (now - t0))));
      };
      setTimeout(tick, Math.max(10, quiet));
    });
  }

  // --- pick -----------------------------------------------------------------------------------
  // An element picker for the USER. Hover highlights the topmost element that PAINTS under the
  // pointer (the invisible click-catcher over a video is skipped — the user picks what they
  // see); `[` / `]` step through every layer of the hit stack, pointer events forced so a
  // pointer-events:none scrim is reachable; ↑/↓ walk to the parent and back; click (or Enter)
  // selects; Escape cancels. The press never reaches the site: every pointer/mouse press is
  // swallowed in the capture phase on window. Keys only arrive while the page has focus — when
  // it doesn't (the user started the pick from the sidebar), the caller forwards them with
  // `pickKey`.
  let picker = null;

  function startPicker(cmd, resolveP) {
    const target = cmd.target || "video";
    const force = addSheet(FORCE_PE, true); // enabled only around each hit test
    const host = document.createElement("div");
    host.setAttribute(OWN, "picker");
    const S = (el, props) => {
      for (const k in props) el.style.setProperty(k, props[k], "important");
    };
    S(host, { position: "fixed", left: "0", top: "0", width: "0", height: "0", margin: "0", padding: "0", border: "none", "pointer-events": "none", "z-index": "2147483647", display: "block", overflow: "visible" });
    const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    const frame = document.createElement("div");
    S(frame, { position: "fixed", display: "none", "box-sizing": "border-box", border: "2px solid #ff2d55", background: "rgba(255,45,85,.14)", "box-shadow": "0 0 0 1px rgba(255,255,255,.7)", "pointer-events": "none", margin: "0", padding: "0" });
    const label = document.createElement("div");
    S(label, { position: "fixed", display: "none", "max-width": "min(640px, 90vw)", "box-sizing": "border-box", padding: "5px 9px", "border-radius": "6px", background: "rgba(18,18,22,.94)", color: "#fff", font: "12px/1.4 system-ui, sans-serif", "white-space": "pre-wrap", "word-break": "break-word", "pointer-events": "none", "box-shadow": "0 2px 8px rgba(0,0,0,.5)", margin: "0", "text-align": "left" });
    root.append(frame, label);
    document.documentElement.appendChild(host);

    let sx = NaN;
    let sy = NaN;
    let stack = [];
    let layer = 0;
    let cur = null;
    let down = [];

    const hitStack = (x, y) => {
      if (force.sheet) force.sheet.disabled = false;
      try {
        return document.elementsFromPoint(x, y).filter((el) => !ours(el));
      } finally {
        if (force.sheet) force.sheet.disabled = true;
      }
    };
    const draw = () => {
      if (!cur || !cur.isConnected) {
        S(frame, { display: "none" });
        S(label, { display: "none" });
        return;
      }
      const r = cur.getBoundingClientRect();
      S(frame, { display: "block", left: r.left + "px", top: r.top + "px", width: Math.max(2, r.width) + "px", height: Math.max(2, r.height) + "px" });
      const at = stack.indexOf(cur);
      const pos = at >= 0 ? `layer ${at + 1}/${stack.length}` : `parent ×${down.length}`;
      label.textContent = `${clip(describe(cur), 160)}\n${Math.round(r.width)}×${Math.round(r.height)} · ${pos} · [ ] layers · ↑ parent ↓ child · click/Enter pick · Esc cancel`;
      S(label, { display: "block", left: "0px", top: "0px" });
      const lr = label.getBoundingClientRect();
      const vp = viewport();
      const left = Math.min(Math.max(4, r.left), Math.max(4, vp.w - lr.width - 4));
      const top = r.top - lr.height - 6 >= 4 ? r.top - lr.height - 6 : Math.min(r.bottom + 6, vp.h - lr.height - 4);
      S(label, { left: left + "px", top: Math.max(4, top) + "px" });
    };
    const moveTo = (x, y) => {
      if (x === sx && y === sy) return;
      sx = x;
      sy = y;
      stack = hitStack(x, y);
      const ctx = makeCtx();
      const k = stack.findIndex((el) => ctx.paintsAt(el, x, y));
      layer = k < 0 ? 0 : k;
      cur = stack[layer] || null;
      down = [];
      draw();
    };
    const key = (k) => {
      switch (k) {
        case "Escape":
          finish({ ok: false, cancelled: true, error: "pick cancelled by the user" });
          return true;
        case "Enter":
          if (cur) select(cur);
          return true;
        case "ArrowUp": {
          const p = cur && parentOf(cur);
          if (p && p !== document.documentElement) {
            down.push(cur);
            cur = p;
          }
          break;
        }
        case "ArrowDown":
          if (down.length) cur = down.pop();
          else if (cur) {
            const deeper = stack.find((el) => el !== cur && cur.contains(el));
            if (deeper) {
              let c = deeper;
              while (parentOf(c) && parentOf(c) !== cur) c = parentOf(c);
              cur = c;
            }
          }
          break;
        case "]":
        case "[":
          if (stack.length) {
            layer = (layer + (k === "]" ? 1 : -1) + stack.length) % stack.length;
            cur = stack[layer];
            down = [];
          }
          break;
        default:
          return false;
      }
      draw();
      return true;
    };
    const KEYS = new Set(["Escape", "Enter", "ArrowUp", "ArrowDown", "[", "]"]);
    // Only the USER drives the picker: the page could dispatch its own click/Enter/Escape to
    // complete (or cancel) the pick with an element of its choosing, so untrusted events are
    // ignored and passed through untouched. pickKey is the extension's own call, not an event.
    const onKey = (e) => {
      if (!e.isTrusted || !KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "keydown") key(e.key);
    };
    const onMove = (e) => {
      if (e.isTrusted) moveTo(e.clientX, e.clientY);
    };
    const swallow = (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      if (!e.isTrusted) return;
      swallow(e);
      if (e.button) return;
      if (!cur) moveTo(e.clientX, e.clientY);
      if (cur) select(cur);
    };
    const onScroll = () => draw();
    const onHide = (e) => {
      if (e.isTrusted) finish({ ok: false, cancelled: true, error: "the page navigated away" });
    };
    const L = [
      ["pointermove", onMove],
      ["mousemove", onMove],
      ["click", onClick],
      ["pointerdown", swallow],
      ["pointerup", swallow],
      ["mousedown", swallow],
      ["mouseup", swallow],
      ["auxclick", swallow],
      ["dblclick", swallow],
      ["contextmenu", swallow],
      ["keydown", onKey],
      ["keypress", onKey],
      ["keyup", onKey],
      ["scroll", onScroll],
      ["resize", onScroll],
      ["pagehide", onHide],
    ];
    for (const [type, fn] of L) window.addEventListener(type, fn, true);

    let finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      for (const [type, fn] of L) window.removeEventListener(type, fn, true);
      host.remove();
      force.remove();
      if (picker === session) picker = null;
      resolveP(result);
    }
    function select(el) {
      let result;
      try {
        const insp = inspectEl(el, target);
        result = { ok: true, path: insp.path, sig: insp.sig, desc: insp.desc, candidates: insp.candidates, inspect: insp };
      } catch (e) {
        result = { ok: false, error: "pick failed: " + ((e && e.message) || e) };
      }
      finish(result);
    }
    const session = { finish, key };
    return session;
  }

  function pick(cmd) {
    if (picker) picker.finish({ ok: false, cancelled: true, error: "superseded by a new pick" });
    return new Promise((res) => {
      picker = startPicker(cmd, res);
    });
  }

  // --- entry point ----------------------------------------------------------------------------
  const api = function (cmd) {
    cmd = cmd || {};
    try {
      switch (cmd.op) {
        case "overlays":
          return overlays(cmd);
        case "inspect":
          return inspect(cmd);
        case "test":
          return test(cmd);
        case "count":
          return count(cmd);
        case "scroll":
          return scroll(cmd);
        case "settle":
          return settle(cmd);
        case "pick":
          return pick(cmd);
        case "pickKey":
          return picker ? { ok: true, handled: picker.key(String(cmd.key || "")), active: !!picker } : { ok: false, error: "no pick in progress" };
        case "unpick":
          if (!picker) return { ok: true, cancelled: false };
          picker.finish({ ok: false, cancelled: true, error: cmd.reason || "pick cancelled" });
          return { ok: true, cancelled: true };
        default:
          return { ok: false, error: `unknown op ${cmd.op}` };
      }
    } catch (e) {
      return { ok: false, error: "overlay runtime: " + ((e && e.message) || e) };
    }
  };
  api.version = VERSION;
  api.dispose = () => {
    if (picker) picker.finish({ ok: false, cancelled: true, error: "the overlay runtime was replaced" });
  };
  window.__rsdOverlay = api;
  return true;
})();

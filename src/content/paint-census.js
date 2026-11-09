// Injected on demand via tabs.executeScript. Answers one question about the page AS IT IS
// PAINTED RIGHT NOW: how much of the viewport reads as light, and which colours — set by
// which elements — are doing the painting. It samples a grid of points and at each one takes
// the topmost element with an opaque background (or a background image): that is the colour a
// reader sees there, with nesting and overlap already resolved by the browser's own hit test.
//
// The same script runs twice per compile: before (so the compiler knows what the page paints,
// including inline styles and cross-origin sheets the stylesheet probe cannot read) and after
// the theme is applied (so the result is MEASURED, not assumed — a native theme that did not
// cascade past a section wrapper shows up here as a still-light page). Stateless: it reads and
// returns; nothing is left behind in the document.
(() => {
  const COLS = 32;
  const ROWS = 20;
  const MEDIA = new Set(["img", "video", "canvas", "svg", "picture", "iframe", "object", "embed"]);

  const parse = (v) => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(v || "");
    if (!m) return null;
    let a = m[4] == null ? 1 : parseFloat(m[4]);
    if (/%$/.test(m[4] || "")) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  const lum = (c) => {
    const f = (n) => {
      n /= 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  // "Light" as a reader sees it: mid greys (#999 ≈ 0.32) still count, a maroon header
  // (≈ 0.06) does not. Mirrors LIGHT_LUMINANCE in background/darkcss.js — keep in sync.
  const isLight = (c) => lum(c) > 0.3;

  const sig = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  };

  // Freeze transitions/animations while sampling, so a background that is still fading to
  // its new value (XenForo: `transition: all .25s`) is read at its END value. The sheet is
  // removed right after; values have already reached their end state, so nothing jumps.
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none !important;animation:none !important}";
  try {
    (document.head || document.documentElement).appendChild(freeze);
    const csCache = new Map();
    const cs = (el) => {
      let v = csCache.get(el);
      if (!v) {
        v = getComputedStyle(el);
        csCache.set(el, v);
      }
      return v;
    };
    const root = document.documentElement;
    const vw = root.clientWidth || innerWidth;
    const vh = root.clientHeight || innerHeight;

    // What shows where nothing paints: html's background, else body's (the canvas propagates
    // it), else the default white canvas.
    let canvas = { r: 255, g: 255, b: 255, a: 1 };
    for (const el of [root, document.body]) {
      if (!el) continue;
      const c = parse(cs(el).backgroundColor);
      if (c && c.a >= 0.99) {
        canvas = c;
        break;
      }
    }

    const bgTally = new Map(); // hex -> { n, light, by: Map(signature -> n) }
    const fgTally = new Map(); // hex -> { n, light }
    let samples = 0;
    let media = 0;
    let light = 0;
    let dark = 0;

    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const x = ((i + 0.5) / COLS) * vw;
        const y = ((j + 0.5) / ROWS) * vh;
        let stack;
        try {
          stack = document.elementsFromPoint(x, y);
        } catch (_) {
          continue;
        }
        samples++;
        let painter = null;
        let color = null;
        let isMedia = false;
        for (const el of stack) {
          const tag = el.tagName ? el.tagName.toLowerCase() : "";
          if (MEDIA.has(tag)) {
            isMedia = true;
            break;
          }
          const st = cs(el);
          if (st.backgroundImage && st.backgroundImage !== "none" && /url\(/i.test(st.backgroundImage)) {
            isMedia = true;
            break;
          }
          const c = parse(st.backgroundColor);
          if (c && c.a >= 0.9) {
            painter = el;
            color = c;
            break;
          }
        }
        if (isMedia) {
          media++;
          continue;
        }
        if (!color) {
          color = canvas;
          painter = root;
        }
        const h = hex(color);
        const l = isLight(color);
        if (l) light++;
        else dark++;
        let t = bgTally.get(h);
        if (!t) {
          t = { n: 0, light: l, by: new Map() };
          bgTally.set(h, t);
        }
        t.n++;
        const s = sig(painter);
        t.by.set(s, (t.by.get(s) || 0) + 1);
        // The text colour in force where this background paints.
        const fc = parse(cs(painter).color);
        if (fc) {
          const fh = hex(fc);
          let ft = fgTally.get(fh);
          if (!ft) {
            ft = { n: 0, light: isLight(fc) };
            fgTally.set(fh, ft);
          }
          ft.n++;
        }
      }
    }

    const painted = samples - media;
    const share = (n) => (painted ? +(n / painted).toFixed(3) : 0);
    const backgrounds = Array.from(bgTally, ([color, t]) => ({
      color,
      share: share(t.n),
      light: t.light,
      by: Array.from(t.by)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, n]) => s + " ×" + n),
    })).sort((a, b) => b.share - a.share);
    const text = Array.from(fgTally, ([color, t]) => ({ color, share: share(t.n), light: t.light })).sort((a, b) => b.share - a.share);

    // The grid above hit-tests the VIEWPORT, so it describes one screenful and nothing else.
    // A page whose first screenful is dark and whose body below is light therefore measures
    // 0% light while most of it is untouched — measured on a fixture of that exact shape: 0%
    // at the top, 100% once scrolled past the hero. Verify compares this number against
    // STILL_LIGHT_FRACTION to decide whether a native theme actually worked, so on such a page
    // it cannot tell "the theme took" from "the theme never reached the body".
    // So take a second, independent reading over the WHOLE document: walk the elements and sum
    // the height of the wide surfaces that paint light. It is a coarser measure (no hit test,
    // so it cannot know what covers what) and it is reported separately rather than mixed into
    // lightFraction — it answers one question only: is there a lot of light further down?
    let docLightFraction = 0;
    let docBackgrounds = [];
    // The BIGGEST single light surface, in CSS px² of its own box. Every other reading here is a
    // SHARE — of the grid, or of the document's height — and a share answers "is this page mostly
    // dark?" when the question a reader asks is "is there a white box in front of me?". The same
    // 335×920 infobox is 5.7% of a 2000px-wide window and 11% of a 1000px one, so a share-based
    // threshold passes or fails it on window size alone. Measured: Wikipedia's taxobox on an
    // article page, with the sheet compiled on the main page, came to 5.7% against a 6% gate —
    // `topUp` returned at its first test and the box stayed light for good.
    let lightSurface = null;
    try {
      const docH = Math.max(1, document.documentElement.scrollHeight);
      const wide = vw * 0.5;
      let seen = 0;
      const bands = [];
      const byColor = new Map();
      for (const el of document.querySelectorAll("*")) {
        if (++seen > 6000) break;
        const p = parse(cs(el).backgroundColor);
        if (!p || p.a < 0.5 || !isLight(p)) continue;
        const b = el.getBoundingClientRect();
        // Tracked before the wide-band filter: a tall narrow box is exactly what that filter is
        // built to ignore, and exactly what this has to catch. MEDIA is excluded, because a
        // light background on an <img> is the PICTURE's backdrop and the compiler deliberately
        // never darkens it (see imageSubject / imageBackdrops) — so counting it here would make
        // the one thing we refuse to change the permanent reason to go back and change things.
        // Measured: without this, github.com's 487×416 white hero image and Wikipedia's own
        // 300×346 photo asked for a fresh probe on every single page load, for ever.
        const area = MEDIA.has(el.tagName.toLowerCase()) ? 0 : Math.max(0, b.width) * Math.max(0, b.height);
        if (area > (lightSurface ? lightSurface.area : 0))
          lightSurface = { area: Math.round(area), w: Math.round(b.width), h: Math.round(b.height), color: hex(p), by: sig(el) };
        if (b.width < wide || b.height < 24) continue;
        const band = [b.top + scrollY, b.bottom + scrollY];
        bands.push(band);
        const h = hex(p);
        let g = byColor.get(h);
        if (!g) {
          g = { bands: [], by: new Map() };
          byColor.set(h, g);
        }
        g.bands.push(band);
        const s = sig(el);
        g.by.set(s, (g.by.get(s) || 0) + 1);
      }
      // Merge the bands so nested light surfaces are not counted twice.
      const merged = (list) => {
        const l = list.slice().sort((a, b) => a[0] - b[0]);
        let sum = 0;
        let curStart = null;
        let curEnd = null;
        for (const [s, e] of l) {
          if (curEnd === null || s > curEnd) {
            if (curEnd !== null) sum += curEnd - curStart;
            curStart = s;
            curEnd = e;
          } else if (e > curEnd) curEnd = e;
        }
        if (curEnd !== null) sum += curEnd - curStart;
        return sum;
      };
      docLightFraction = +Math.min(1, Math.max(0, merged(bands) / docH)).toFixed(3);
      // The COLOURS of those bands, each with the share of the document it covers. Without this
      // the model is handed a page whose only light colour is below the fold and sees none of it:
      // `backgrounds` is the viewport grid, so on a title page with a tall dark hero the summary
      // said "this page paints dark" and the plan was designed for a page that does not exist.
      docBackgrounds = Array.from(byColor, ([color, g]) => ({
        color,
        share: +Math.min(1, merged(g.bands) / docH).toFixed(3),
        by: Array.from(g.by)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([s, n]) => s + " ×" + n),
      }))
        .sort((a, b) => b.share - a.share)
        .slice(0, 8);
    } catch (_) {
      docLightFraction = 0;
      docBackgrounds = [];
      lightSurface = null;
    }

    // How much text cannot be READ. Everything above measures surfaces, and a dark mode that
    // darkens a surface without lightening the text on it scores a perfect 0% light while the
    // page is unusable — the IMDb title page read 0% light with 36 runs of pure black text on
    // #121212. So each element with text of its own is compared against the nearest ancestor
    // that actually paints, by WCAG contrast ratio. Below 3:1 nothing is legible at any size.
    // This walks the whole document, not the viewport: unreadable text below the fold is
    // exactly the case the grid cannot see.
    let unreadable = 0;
    let textElements = 0;
    let worstText = [];
    try {
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const byPair = new Map();
      let seen = 0;
      for (const el of document.querySelectorAll("*")) {
        if (++seen > 6000) break;
        let own = "";
        for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
        if (!own.trim()) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 12 || b.height < 8) continue;
        const s = cs(el);
        if (s.visibility === "hidden" || +s.opacity < 0.1) continue;
        const fg = parse(s.color);
        if (!fg || fg.a < 0.5) continue;
        // The nearest ancestor that paints something opaque enough to be the backdrop.
        let p = el;
        let bg = null;
        while (p) {
          const q = parse(cs(p).backgroundColor);
          if (q && q.a >= 0.5) {
            bg = q;
            break;
          }
          p = p.parentElement;
        }
        if (!bg) continue;
        textElements++;
        if (ratio(lum(fg), lum(bg)) >= 3) continue;
        unreadable++;
        const key = hex(fg) + " on " + hex(bg);
        const g = byPair.get(key) || { pair: key, n: 0, by: new Map() };
        g.n++;
        const t = sig(el);
        g.by.set(t, (g.by.get(t) || 0) + 1);
        byPair.set(key, g);
      }
      worstText = Array.from(byPair.values())
        .sort((a, b) => b.n - a.n)
        .slice(0, 6)
        .map((g) => ({
          pair: g.pair,
          n: g.n,
          by: Array.from(g.by)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([s, n]) => s + " ×" + n),
        }));
    } catch (_) {
      unreadable = 0;
      textElements = 0;
      worstText = [];
    }

    return {
      ok: true,
      viewport: { w: vw, h: vh },
      samples,
      media,
      light,
      dark,
      lightFraction: share(light),
      docLightFraction,
      docBackgrounds,
      lightSurface,
      unreadable,
      textElements,
      worstText,
      canvas: hex(canvas),
      backgrounds,
      text,
    };
  } catch (e) {
    return { ok: false, reason: "census failed: " + ((e && e.message) || e) };
  } finally {
    freeze.remove();
  }
})();

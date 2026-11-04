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

    return {
      ok: true,
      viewport: { w: vw, h: vh },
      samples,
      media,
      light,
      dark,
      lightFraction: share(light),
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

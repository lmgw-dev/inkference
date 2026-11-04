// In-page agent runtime. Injected on demand the same way extract.js is: the background
// re-injects this file before EVERY command, then runs `window.__rsdAgent(cmd)` in a second
// executeScript and reads the return value. Re-injecting every step is what makes navigation
// free — a fresh page just gets a fresh runtime — and it lets us stay stateless.
//
// Element identity is positional, not a stored Map: ids are 1-based indices into the
// document-order list of actionable elements (`collect()`), recomputed on every call. An id
// the model saw in an `observe` still resolves on the next `act` as long as no node was
// inserted/removed before it. After a navigation or big DOM change, ids shift — so the loop
// re-observes and the model works off fresh ids. This is the known limit of the cheap scheme;
// stable hash ids (Charlotte-style) would survive mutations but cost more to compute.
//
// Frames: this runtime is injected into EACH frame separately (top + sub-frames). To keep one
// flat id space across frames, the background passes a per-frame `base` offset; ids we emit are
// `base + localIndex` and `act` strips `base` back to this frame's local index. base 0 is the
// top frame, so a frameless page behaves exactly as before. The background owns how base maps to
// a frame (see background/agent.js); here we just add/subtract it.

(() => {
  // Anything a user can click into or type/select. Listed once; querySelectorAll returns
  // document order, which is what makes the id space deterministic across calls.
  const SEL = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]",
    "[role=radio]", "[role=switch]", "[role=option]", "[role=combobox]", "[role=searchbox]",
    "[role=textbox]", "[contenteditable='']", "[contenteditable=true]", "[onclick]",
  ].join(",");

  // Money / hard-to-undo controls. A click whose accessible name matches pauses for explicit
  // user confirmation (the background gates on `needsConfirm`). Heuristic on purpose — it errs
  // toward asking. `submit` always gates regardless of this.
  const SENSITIVE = /\b(buy|buy now|order|place (your )?order|pay|payment|checkout|purchase|complete (your )?order|confirm( and pay| order)?|subscribe)\b/i;

  const clip = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };

  // Includes DISABLED and read-only controls on purpose: a greyed-out field must have a stable
  // id so `unlock` can target it (and observe can label it "(locked)"). They stay in document
  // order like everything else, so ids remain deterministic across observe → unlock → type.
  function collect() {
    return Array.from(document.querySelectorAll(SEL));
  }

  // Why a control is not editable, or "" if it is. A parent <fieldset disabled> disables all its
  // controls, so it counts as locked too — unlock has to reach up to it.
  function lockState(el) {
    if (el.disabled || (el.closest && el.closest("fieldset[disabled]"))) return "disabled";
    if (el.readOnly) return "read-only";
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return "aria-disabled";
    return "";
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // Cheap approximation of the accessibility name algorithm — enough to tell controls apart.
  function accName(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute && el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ").trim();
      if (t) return t;
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const wrap = el.closest && el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    return (
      (el.getAttribute && (el.getAttribute("alt") || el.getAttribute("title"))) ||
      el.value || el.textContent || el.getAttribute && el.getAttribute("placeholder") || ""
    ).trim();
  }

  function describe(el, id) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    let kind = role || tag;
    if (tag === "input") kind = "input:" + (el.getAttribute("type") || "text");
    const name = clip(accName(el), 80);
    let extra = "";
    if (tag === "input" || tag === "textarea") {
      if (el.value) extra += ` value="${clip(el.value, 40)}"`;
      const ph = el.getAttribute("placeholder");
      if (ph && !name) extra += ` placeholder="${clip(ph, 40)}"`;
    } else if (tag === "select" && el.selectedIndex >= 0) {
      extra += ` value="${clip(el.options[el.selectedIndex].text, 40)}"`;
    }
    const locked = lockState(el);
    if (locked) extra += ` (locked:${locked})`;
    return `[${id}] ${kind}${name ? ` "${name}"` : ""}${extra}`;
  }

  function outline() {
    return Array.from(document.querySelectorAll("h1,h2,h3"))
      .filter(isVisible).slice(0, 12)
      .map((h) => clip(h.textContent, 50)).filter(Boolean).join(" · ");
  }

  // --- commands -------------------------------------------------------------

  function observe(c) {
    const base = c.base || 0;
    const all = collect();
    const vis = [];
    all.forEach((el, i) => { if (isVisible(el) && inViewport(el)) vis.push(describe(el, base + i + 1)); });
    const cap = c.max || 100;
    const shown = vis.slice(0, cap);
    // PAGE/OUTLINE come from the top frame only; a sub-frame returns just its element list and the
    // background prefixes it with a FRAME header.
    let text = "";
    if (!base) {
      text += `PAGE: ${clip(document.title, 80)} — ${location.href}\n`;
      const ol = outline();
      if (ol) text += `OUTLINE: ${ol}\n`;
    }
    const over = vis.length > cap ? ` of ${vis.length} in view (scroll or find for the rest)` : "";
    text += `INTERACTIVE (${shown.length}${over}; ${all.length} total ${base ? "in this frame" : "on page"}):\n`;
    text += shown.join("\n") || (base ? "(nothing interactive in view in this frame)" : "(nothing interactive in view — try scroll)");
    return { ok: true, text, count: vis.length };
  }

  function find(c) {
    const base = c.base || 0;
    const q = (c.query || "").toLowerCase().trim();
    if (!q) return { ok: false, error: "find needs a query" };
    const all = collect();
    const hits = [];
    all.forEach((el, i) => {
      if (accName(el).toLowerCase().includes(q)) {
        const where = isVisible(el) && inViewport(el) ? "" : " (off-screen — scroll to it)";
        hits.push(describe(el, base + i + 1) + where);
      }
    });
    const cap = 40;
    const text = hits.length
      ? `FOUND ${hits.length} matching "${c.query}"${hits.length > cap ? ` (showing ${cap})` : ""}:\n` + hits.slice(0, cap).join("\n")
      : `No interactive element matches "${c.query}". Try a shorter query, or scroll and observe.`;
    return { ok: true, text, count: hits.length };
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
    }
  }

  function typeInto(el, text, submit) {
    el.scrollIntoView({ block: "center" });
    el.focus && el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(el, text);
    }
    if (submit) {
      const form = el.form || (el.closest && el.closest("form"));
      if (form && form.requestSubmit) form.requestSubmit();
      else if (form) form.submit();
      else pressEnter(el);
    }
    return { ok: true, detail: `typed into ${accName(el) || el.tagName}${submit ? " and submitted" : ""}` };
  }

  // Make a locked/greyed control editable. Strips the client-side gates the site uses to lock a
  // field: `disabled`/`readonly`, a wrapping <fieldset disabled>, aria-disabled, and inline
  // pointer-events:none / dimming. This edits only the live DOM in front of the user — whether the
  // new value is honored is decided when the save request is sent (that's what the net gate shows).
  function unlockEl(el) {
    const changed = [];
    const fs = el.closest && el.closest("fieldset[disabled]");
    if (fs) { fs.disabled = false; fs.removeAttribute("disabled"); changed.push("enabled parent <fieldset>"); }
    if (el.disabled) { el.disabled = false; changed.push("removed disabled"); }
    if (el.hasAttribute && el.hasAttribute("disabled")) el.removeAttribute("disabled");
    if (el.readOnly) { el.readOnly = false; changed.push("removed readonly"); }
    if (el.hasAttribute && el.hasAttribute("readonly")) el.removeAttribute("readonly");
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") { el.setAttribute("aria-disabled", "false"); changed.push("cleared aria-disabled"); }
    if (el.getAttribute && el.getAttribute("contenteditable") === "false") { el.setAttribute("contenteditable", "true"); changed.push("made editable"); }
    if (el.style) {
      if (el.style.pointerEvents === "none") { el.style.pointerEvents = "auto"; changed.push("restored clicks"); }
      if (el.style.opacity && parseFloat(el.style.opacity) < 1) { el.style.opacity = ""; changed.push("un-greyed"); }
    }
    return changed;
  }

  function selectOption(el, value) {
    if (el.tagName !== "SELECT") return { ok: false, error: "select target is not a <select>" };
    const want = String(value).toLowerCase().trim();
    for (const opt of el.options) {
      if (opt.value.toLowerCase() === want || opt.text.toLowerCase().trim() === want) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: `selected "${opt.text.trim()}"` };
      }
    }
    return { ok: false, error: `no option matching "${value}"`, options: Array.from(el.options).slice(0, 20).map((o) => o.text.trim()) };
  }

  // --- highlight --------------------------------------------------------------
  // Draw a red ellipse around something so the USER can see what the agent means. This is the
  // one tool that communicates rather than acts, so its lifetime is the opposite of everything
  // else here: it must OUTLIVE the run (a marker cleared when the task ends would vanish before
  // it was read), which is why it fades on its own instead of being torn down, and why each new
  // run clears whatever is left over.
  //
  // No timers and no scroll listeners: the sandbox this runs in is thrown away after the
  // command, so anything holding a closure would die with it. Instead the node is positioned in
  // DOCUMENT coordinates (it scrolls with the page for free) and fades via a Web Animations
  // animation, which belongs to the page's own timeline and keeps running. The leftover invisible
  // node is removed at the next run — or by the next navigation, whichever comes first.
  const HL_ATTR = "data-rsd-highlight";
  const HL_HOLD_S = 30; // fully visible…
  const HL_FADE_S = 3;  // …then fades out over this long, and stays invisible until cleared
  const SVGNS = "http://www.w3.org/2000/svg";

  function clearHighlights() {
    const nodes = document.querySelectorAll("[" + HL_ATTR + "]");
    for (const n of nodes) n.remove();
    return nodes.length;
  }

  // rect is in document coordinates. The ellipse through a rectangle's corners has semi-axes
  // 0.707·w and 0.707·h (from (w/2)²/rx² + (h/2)²/ry² = 1 with both axes scaled alike); the pad
  // puts the stroke just outside the target instead of through its edge.
  function drawEllipse(rect, label) {
    const rx = Math.max(rect.w * 0.707 + 6, 16);
    const ry = Math.max(rect.h * 0.707 + 6, 16);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;

    const host = document.createElement("div");
    host.setAttribute(HL_ATTR, "");
    // Every layout property is set !important inline: this has to survive the page's own CSS
    // (and our AI dark mode, which injects user-origin !important rules).
    const S = (k, v) => host.style.setProperty(k, v, "important");
    S("position", "absolute");
    S("left", cx - rx + "px");
    S("top", cy - ry + "px");
    S("width", rx * 2 + "px");
    S("height", ry * 2 + "px");
    S("margin", "0");
    S("padding", "0");
    S("border", "none");
    S("background", "none");
    S("display", "block");
    S("overflow", "visible");
    S("z-index", "2147483647");
    // Must not intercept the next click: clickAt dispatches to elementFromPoint, which would
    // otherwise hit this overlay instead of the control underneath it.
    S("pointer-events", "none");

    // Shadow root so the site's stylesheets can't reach the marker's internals.
    const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${rx * 2} ${ry * 2}`);
    svg.setAttribute("fill", "none");
    const ell = document.createElementNS(SVGNS, "ellipse");
    ell.setAttribute("cx", String(rx));
    ell.setAttribute("cy", String(ry));
    ell.setAttribute("rx", String(rx - 2));
    ell.setAttribute("ry", String(ry - 2));
    ell.setAttribute("fill", "none");
    ell.setAttribute("stroke", "#ff2d55");
    ell.setAttribute("stroke-width", "3");
    // A white outer halo keeps the ring readable on both dark and light pages.
    const halo = ell.cloneNode(false);
    halo.setAttribute("stroke", "rgba(255,255,255,.85)");
    halo.setAttribute("stroke-width", "6");
    svg.append(halo, ell);
    root.append(svg);

    if (label) root.append(chip(label, cy - ry));
    // WAAPI, not a timeout: the animation is owned by the document and keeps its own time, so
    // the fade completes long after this sandbox is gone.
    const total = (HL_HOLD_S + HL_FADE_S) * 1000;
    if (host.animate) {
      host.animate(
        [{ opacity: 1, offset: 0 }, { opacity: 1, offset: HL_HOLD_S / (HL_HOLD_S + HL_FADE_S) }, { opacity: 0, offset: 1 }],
        { duration: total, fill: "forwards" }
      );
    }
    document.body.appendChild(host);
  }

  // Caption above the ellipse (below it when the target sits at the top of the page), so the
  // user knows what was circled and why.
  function chip(text, hostTopDoc) {
    const el = document.createElement("div");
    const S = (k, v) => el.style.setProperty(k, v, "important");
    S("position", "absolute");
    S("left", "50%");
    S("transform", "translateX(-50%)");
    // hostTopDoc is a document coordinate; compare against the scroll offset to know whether
    // there is room on screen above the ring.
    if (hostTopDoc - (window.scrollY || 0) < 28) S("top", "calc(100% + 6px)");
    else S("bottom", "calc(100% + 6px)");
    S("font", "600 12px/1.4 system-ui, sans-serif");
    S("white-space", "nowrap");
    S("color", "#fff");
    S("background", "#ff2d55");
    S("padding", "2px 8px");
    S("border-radius", "10px");
    S("box-shadow", "0 1px 4px rgba(0,0,0,.4)");
    el.textContent = clip(text, 60);
    return el;
  }

  // Click a viewport POINT (click_screen's grounded coordinates) rather than a collected
  // element — the target may be pixels on a <canvas> that no DOM id can name. Dispatches the
  // full pointer+mouse press sequence with real clientX/clientY so canvas/WebGL apps that read
  // coordinates off the events see a normal press; a regular <a>/<button> hit this way still
  // activates (a synthetic click runs activation behavior — it just carries isTrusted:false,
  // which pages essentially never check outside hardened bot defenses). If the point lands on
  // an iframe we can't reach into it from this document: return the frame's url + the point
  // translated into it, and the background re-dispatches inside that frame.
  function clickAt(c) {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) {
      return { ok: false, error: `(${x}, ${y}) is outside the viewport (${innerWidth}x${innerHeight})` };
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, error: `nothing at (${x}, ${y})` };
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      const r = el.getBoundingClientRect();
      return { ok: true, frame: { url: el.src || "", x: x - r.left, y: y - r.top } };
    }
    const name = accName(el);
    if (SENSITIVE.test(name) && !c.confirmed) return { ok: false, needsConfirm: true, label: name || "(unlabeled control)" };

    const btn = c.button === "right" ? 2 : 0;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: btn };
    const ptr = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    const press = (detail) => {
      const held = btn === 2 ? 2 : 1; // `buttons` is the held mask: set while down, 0 on release
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...ptr, buttons: held, detail }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: held, detail }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...ptr, buttons: 0, detail }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0, detail }));
    };
    el.focus && el.focus();
    if (btn === 2) {
      press(1);
      el.dispatchEvent(new MouseEvent("contextmenu", { ...base, buttons: 0, detail: 1 }));
    } else {
      press(1);
      el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
      if (c.button === "double") {
        press(2);
        el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 2 }));
        el.dispatchEvent(new MouseEvent("dblclick", { ...base, buttons: 0, detail: 2 }));
      }
    }
    const verb = c.button === "double" ? "double-clicked" : c.button === "right" ? "right-clicked" : "clicked";
    const what = `${el.tagName.toLowerCase()}${name ? ` "${clip(name, 40)}"` : ""}`;
    return { ok: true, detail: `${verb} (${x}, ${y}) on ${what}` };
  }

  function act(c) {
    if (c.op === "scroll" && !c.id) {
      const dy = c.dir === "up" ? -Math.round(innerHeight * 0.8) : Math.round(innerHeight * 0.8);
      scrollBy(0, dy);
      return { ok: true, detail: `scrolled ${c.dir || "down"}` };
    }
    const els = collect();
    const el = els[(c.id - (c.base || 0)) - 1]; // strip the frame offset back to this frame's index
    if (!el) {
      // A page that collects NOTHING is the canvas/WebGL case, and a model that guessed an id
      // here will keep guessing unless the error names the way out. (Observed: given an empty
      // observation, gemma4-12b still called highlight with a made-up id 1.)
      return {
        ok: false,
        error: els.length
          ? `no element with id ${c.id} — the page changed; observe again`
          : `this page exposes NO elements the DOM tools can target — it draws its interface as pixels (canvas/WebGL). Ids do not exist here; use the screen tools (screenshot, then click_screen / highlight_screen with a described target) instead`,
      };
    }
    const name = accName(el);
    if (c.op === "click" && SENSITIVE.test(name) && !c.confirmed) {
      return { ok: false, needsConfirm: true, label: name || "(unlabeled control)" };
    }
    switch (c.op) {
      case "unlock": {
        const changed = unlockEl(el);
        el.scrollIntoView({ block: "center" });
        return { ok: true, detail: changed.length ? `unlocked ${name || el.tagName}: ${changed.join(", ")} — now set it with type/select` : `${name || el.tagName} was already editable` };
      }
      case "highlight": {
        if (!isVisible(el)) return { ok: false, error: `${name || el.tagName} is not visible on the page` };
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // getBoundingClientRect + scroll offset is a DOCUMENT coordinate, so it stays correct
        // however the smooth scroll above finishes.
        const r = el.getBoundingClientRect();
        drawEllipse(
          { x: r.left + (window.scrollX || 0), y: r.top + (window.scrollY || 0), w: r.width, h: r.height },
          c.label || name
        );
        return { ok: true, detail: `circled ${name || el.tagName} on screen for the user` };
      }
      case "click":
        el.scrollIntoView({ block: "center" });
        el.focus && el.focus();
        el.click();
        return { ok: true, detail: `clicked ${name || el.tagName}` };
      case "type":
        return typeInto(el, c.text || "", c.submit);
      case "select":
        return selectOption(el, c.value);
      case "scroll":
        el.scrollIntoView({ block: "center" });
        return { ok: true, detail: `scrolled to ${name || el.tagName}` };
      case "key":
        if ((c.key || "").toLowerCase() === "enter") { el.focus && el.focus(); pressEnter(el); return { ok: true, detail: "pressed Enter" }; }
        return { ok: false, error: `unsupported key ${c.key}` };
      default:
        return { ok: false, error: `unknown op ${c.op}` };
    }
  }

  // Single entry point. Re-defined on every injection (idempotent) — same code, same behavior.
  window.__rsdAgent = function (cmd) {
    try {
      switch (cmd.op) {
        case "observe": return observe(cmd);
        case "find": return find(cmd);
        case "clickAt": return clickAt(cmd);
        case "unhighlight": return { ok: true, cleared: clearHighlights() };
        // Grounded box: viewport CSS px in, document coords out (the capture is of the top
        // frame's viewport, so the marker is always drawn there — it floats over an iframe's
        // content just as well, since it only has to line up on screen).
        case "highlightAt":
          drawEllipse(
            {
              x: cmd.x - (cmd.w || 0) / 2 + (window.scrollX || 0),
              y: cmd.y - (cmd.h || 0) / 2 + (window.scrollY || 0),
              w: cmd.w || 0,
              h: cmd.h || 0,
            },
            cmd.label
          );
          return { ok: true, detail: `circled (${Math.round(cmd.x)}, ${Math.round(cmd.y)}) on screen for the user` };
        default: return act(cmd);
      }
    } catch (e) {
      return { ok: false, error: "agent runtime: " + ((e && e.message) || e) };
    }
  };
  return true;
})();

// Request body-rewrite hook — increment 2 of the "unlock" flow (see background/agent.js).
//
// When `last_request` shows the page STRIPPED the user's value out of a save (the app ignores the
// disabled/greyed field, hardcodes it, or whitelists the payload), unlocking the DOM isn't enough —
// the outgoing request has to be rewritten. Firefox's webRequest gate can HOLD and show a request
// but cannot modify its body, so that rewrite happens here, in the page, before the bytes go out.
//
// Two realms, on purpose:
//   - the fetch/XHR WRAPPER runs in the PAGE's own world (injected as a <script>), so it reads
//     init.body / xhr.send(body) natively — no Xray wrappers to fight, no Request reconstruction;
//   - THIS file runs in the content sandbox and is the bridge: it injects that wrapper once and
//     feeds it the patch list by writing a page-realm global via wrappedJSObject + cloneInto (the
//     same cross-compartment trick content/cheat-hud.js uses to write the page heap).
//
// The rewritten request is STILL held + shown by the background's webRequest save-gate — this only
// changes WHAT is in the body; the user still approves the final thing before it reaches the device.
//
// Re-injected on demand like the other content runtimes; the page-world install is idempotent
// (guarded by window.__rsdNetHookInstalled), so re-running just refreshes the patch list.
(() => {
  const PW = window.wrappedJSObject || window;
  const G = "__rsdNetHook";

  // Runs in PAGE world (serialized via .toString()), so it must be fully self-contained — it may
  // only touch real page globals (window, fetch, XMLHttpRequest), never anything from this closure.
  function pageHook() {
    if (window.__rsdNetHookInstalled) return;
    window.__rsdNetHookInstalled = true;
    window.__rsdNetPatches = window.__rsdNetPatches || [];
    const WRITE = /^(POST|PUT|PATCH|DELETE)$/i;

    function coerce(v) { try { return JSON.parse(v); } catch { return v; } }
    function setDeep(obj, field, value) {
      const keys = String(field).split(".");
      let o = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
        o = o[keys[i]];
      }
      o[keys[keys.length - 1]] = value;
    }
    function headerGet(headers, name) {
      try {
        if (headers && typeof headers.get === "function") return headers.get(name) || "";
        if (headers) for (const k in headers) if (k.toLowerCase() === name) return headers[k];
      } catch { /* ignore */ }
      return "";
    }
    // Inject/overwrite each patched field in the body, preserving its encoding (JSON vs form).
    function applyPatches(bodyText, contentType) {
      const patches = window.__rsdNetPatches || [];
      if (!patches.length || bodyText == null) return bodyText;
      const looksJson = /json/i.test(contentType || "") || /^\s*[[{]/.test(bodyText);
      if (looksJson) {
        try {
          const obj = JSON.parse(bodyText);
          for (const p of patches) setDeep(obj, p.field, coerce(p.value));
          return JSON.stringify(obj);
        } catch { /* not JSON after all — fall through to form encoding */ }
      }
      try {
        const params = new URLSearchParams(bodyText);
        for (const p of patches) params.set(p.field, p.value);
        return params.toString();
      } catch { return bodyText; }
    }

    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (WRITE.test(method) && window.__rsdNetPatches && window.__rsdNetPatches.length &&
            init && typeof init.body === "string") {
          const ct = headerGet(init && init.headers, "content-type");
          init = Object.assign({}, init, { body: applyPatches(init.body, ct) });
        }
        // (A Request-object `input` carrying its own body is not rewritten — a known gap.)
      } catch { /* never break the page's own fetch */ }
      return realFetch.call(this, input, init);
    };

    const XO = XMLHttpRequest.prototype.open;
    const XSH = XMLHttpRequest.prototype.setRequestHeader;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method) {
      this.__rsdMethod = method; this.__rsdCT = "";
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === "content-type") this.__rsdCT = value;
      return XSH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (WRITE.test(this.__rsdMethod || "") && typeof body === "string" &&
            window.__rsdNetPatches && window.__rsdNetPatches.length) {
          body = applyPatches(body, this.__rsdCT || "");
        }
      } catch { /* never break the page's own XHR */ }
      return XS.call(this, body);
    };
  }

  // Inject the page-world wrapper once. Returns false if the page's CSP blocked the inline <script>
  // (it silently doesn't execute, so the install flag stays unset) — the caller surfaces that.
  function installPageHook() {
    if (PW.__rsdNetHookInstalled) return true;
    try {
      const s = document.createElement("script");
      s.textContent = "(" + pageHook.toString() + ")();";
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch { /* fall through to the flag check */ }
    return !!PW.__rsdNetHookInstalled;
  }

  // Content-sandbox API the background drives via executeScript (mirrors window.__rsdAgent).
  window[G] = {
    setPatches(patches) {
      if (!installPageHook()) return { ok: false, reason: "blocked" };
      try {
        PW.__rsdNetPatches = typeof cloneInto === "function" ? cloneInto(patches, PW) : patches;
      } catch (e) { return { ok: false, reason: (e && e.message) || "write failed" }; }
      return { ok: true, count: patches.length };
    },
    clear() {
      try {
        if (PW.__rsdNetHookInstalled) PW.__rsdNetPatches = typeof cloneInto === "function" ? cloneInto([], PW) : [];
      } catch { /* page gone */ }
      return { ok: true };
    },
  };
  return { ok: true };
})();

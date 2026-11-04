// Cheat Lab — the in-page HUD: heap executor + renderer + LLM command surface (content world).
//
// Reads and writes a browser game's LIVE JS state. Everything the extension did before touches only
// the DOM (which the isolated content world sees), but cheating in an idle game means mutating the
// game's JavaScript heap — `Game.cookies`, `player.gold`, etc. Those live in the page's MAIN world,
// invisible to a normal content script. Firefox's escape hatch is `window.wrappedJSObject`: the
// page's real `window`, unwrapped, through which we read AND write the page's own objects.
//
// This script wears three hats:
//   - manual console — Scan globals, read/write a path, watch values tick live (the original slice);
//   - heap EXECUTOR — it opens a PORT_CHEAT port to the background and answers OP requests
//     (scan/read/set) over op-RPC, so the wrappedJSObject engine lives in exactly one place;
//   - LLM surface — an "ask the model" box ships a goal to the background's tool loop and renders
//     the streamed steps + final answer. The loop drives the page through the OP path above.
//
// Re-injected to toggle: the background runs this file again on the same document; the second run
// sees the `__rsdCheatHud` global the first left behind and tears the HUD down. (Content-script
// globals persist within a document across executeScript calls — the same trick agent.js uses.)

(() => {
  const G = "__rsdCheatHud";
  if (window[G]) {
    try { window[G].destroy(); } catch { /* ignore */ }
    return { ok: true, action: "closed" };
  }

  // The page's real window. On a page with no scripts this is still the window; fall back to the
  // Xray view if wrappedJSObject is somehow absent (it shouldn't be on Firefox).
  const PW = window.wrappedJSObject || window;

  // ---- page-heap access ------------------------------------------------------

  // Split "Game.Objects.Cursor.amount" / "players[0].gold" / "a['b c']" into ["Game",…,0,…].
  function tokenizePath(path) {
    const out = [];
    const re = /\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\]|\.?([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(path))) {
      if (m[1] != null) out.push(m[1]);
      else if (m[2] != null) out.push(m[2]);
      else if (m[3] != null) out.push(Number(m[3]));
      else if (m[4] != null) out.push(m[4]);
    }
    return out;
  }

  // A function's return value isn't reachable from `window`, so when `call`/`read` yield an object
  // we park it here and expose it under the `$ret` root — then the model can scan/read/set into it
  // exactly like any other path (e.g. `scan $ret.last`, `set $ret.last.gold 1e12`). The holder is a
  // CONTENT-realm object storing waived page references; it never round-trips through PW, so there are
  // no cross-compartment wrapper games. `$ret.last` is the most recent; `$ret.r0`, `r1`, … are history.
  const STASH_ROOT = "$ret";
  const stash = Object.create(null);
  let stashN = 0;
  function stashResult(v) {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return null; // primitives shown inline
    const name = "r" + stashN++;
    stash[name] = v;
    stash.last = v;
    return STASH_ROOT + "." + name;
  }

  // Pick the traversal base from the path's first token: the stash holder for `$ret…`, else the page.
  function pathBase(path) {
    const keys = tokenizePath(path);
    if (keys.length && keys[0] === STASH_ROOT) return { base: stash, keys: keys.slice(1) };
    return { base: PW, keys };
  }

  function resolve(path) {
    const { base, keys } = pathBase(path);
    if (!keys.length) throw new Error("empty path");
    let parent = base;
    for (let i = 0; i < keys.length - 1; i++) {
      if (parent == null) throw new Error("nothing at “" + keys.slice(0, i + 1).join(".") + "”");
      parent = parent[keys[i]];
    }
    return { parent, key: keys[keys.length - 1] };
  }

  function readPath(path) {
    const { keys } = pathBase(path);
    if (!keys.length) return stash; // bare `$ret` → the holder of parked results
    const { parent, key } = resolve(path);
    if (parent == null) throw new Error("no such object");
    return parent[key];
  }

  // Parse the value box as JSON first (so 1e300, true, "txt", [1,2] all work), else treat the raw
  // text as a string. Non-primitives must be cloned into the page realm before assignment, or the
  // page sees a dead cross-compartment wrapper.
  function parseValue(raw) {
    const s = String(raw);
    try { return { value: JSON.parse(s), json: true }; } catch { return { value: s, json: false }; }
  }
  // Write an already-parsed JS value. Non-primitives must be cloned into the page realm first, or
  // the page sees a dead cross-compartment wrapper. The manual UI parses its text box with
  // parseValue; the LLM path hands us a value the background already parsed.
  function writeValue(path, value) {
    const { parent, key } = resolve(path);
    if (parent == null) throw new Error("no such object");
    if (value !== null && typeof value === "object" && typeof cloneInto === "function") {
      value = cloneInto(value, PW);
    }
    parent[key] = value;
    return parent[key];
  }

  // Invoke a page function the game exposes (the value the user wants is sometimes only reachable
  // through a method — addCandies(n), buyUpgrade(id) — not a writable field). Resolve to the
  // function AND its owning object, then call it as parent[key](...) so `this` binds to the owner.
  // Args cross the content→page realm boundary: primitives pass as-is, but a non-primitive must be
  // cloned into the page realm first or the function receives a dead cross-compartment wrapper.
  function callFn(path, args) {
    let parent, key;
    try { ({ parent, key } = resolve(path)); } catch (e) { return { error: e.message }; }
    if (parent == null) return { error: "no such object" };
    let fnRef;
    try { fnRef = parent[key]; } catch (e) { return { error: e.message }; }
    if (typeof fnRef !== "function") {
      return { error: path + " is " + (fnRef === null ? "null" : typeof fnRef) + ", not a function" };
    }
    let a = Array.isArray(args) ? args : [];
    if (typeof cloneInto === "function") {
      a = a.map((x) => (x !== null && typeof x === "object" ? cloneInto(x, PW) : x));
    }
    let ret;
    try { ret = fnRef.apply(parent, a); } catch (e) { return { error: "the function threw: " + ((e && e.message) || e) }; }
    const t = ret === undefined ? "undefined" : ret === null ? "null" : Array.isArray(ret) ? "array" : typeof ret;
    // Park an object/array/function return so it can be drilled into via $ret; hand back its keys too.
    let stashed = null, keys, keysTotal;
    if (ret !== null && (typeof ret === "object" || typeof ret === "function")) {
      stashed = stashResult(ret);
      if (typeof ret === "object") { const kl = keyList(ret); keys = kl.keys; keysTotal = kl.keysTotal; }
    }
    return { called: true, type: t, result: leafValue(ret), stashed, keys, keysTotal };
  }

  // ---- localStorage access (many games persist their save here — reachable even when the live
  // state is closure-bound and invisible to the globals scan). Content scripts share the page
  // origin's store, so this reads/writes exactly what the game saved.
  function clipStr(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  const STORAGE_CAP = 200;
  function readStorage(key) {
    let ls;
    try { ls = window.localStorage; } catch (e) { return { error: "localStorage unavailable: " + (e && e.message) }; }
    if (!ls) return { error: "localStorage unavailable on this page" };
    if (key) {
      try { return { kind: "value", key, value: ls.getItem(key) }; } catch (e) { return { error: e.message }; }
    }
    const rows = [];
    let total = 0;
    try {
      total = ls.length;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        let v = "";
        try { v = ls.getItem(k); } catch { v = "?"; }
        rows.push({ key: k, preview: clipStr(v, 60) });
      }
    } catch (e) { return { error: e.message }; }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return { kind: "list", rows: rows.slice(0, STORAGE_CAP), total };
  }
  function writeStorage(key, value) {
    let ls;
    try { ls = window.localStorage; } catch (e) { return { error: "localStorage unavailable: " + (e && e.message) }; }
    if (!ls) return { error: "localStorage unavailable on this page" };
    let before;
    try { before = ls.getItem(key); } catch { before = null; }
    try { ls.setItem(key, String(value == null ? "" : value)); } catch (e) { return { error: e.message }; }
    let after;
    try { after = ls.getItem(key); } catch { after = null; }
    return { before, after };
  }

  // Page-added globals only: subtract a blank iframe's window names (the browser builtins) from the
  // page window's own names. getOwnPropertyNames (not Object.keys) so `var Game` — non-enumerable on
  // the global — is still caught.
  let baseline = null;
  function builtinNames() {
    if (baseline) return baseline;
    const set = new Set(["__rsdCheatHud", "__rsdAgent"]);
    try {
      const f = document.createElement("iframe");
      f.style.display = "none";
      (document.body || document.documentElement).appendChild(f);
      for (const n of Object.getOwnPropertyNames(f.contentWindow)) set.add(n);
      f.remove();
    } catch { /* no body yet / blocked — denylist below still trims the worst */ }
    return (baseline = set);
  }

  function countKeys(o) { try { return Object.keys(o).length; } catch { return 0; } }
  function preview(v) {
    try {
      const t = typeof v;
      if (v === null) return "null";
      if (t === "number" || t === "boolean") return String(v);
      if (t === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 39) + "…" : v);
      if (t === "function") return "ƒ()";
      if (Array.isArray(v)) return "[" + v.length + "]";
      if (t === "object") return "{…" + countKeys(v) + "}";
      return t;
    } catch { return "?"; }
  }

  // Heuristic ranking: state containers are objects/arrays with the most members, so they float up.
  // includeBuiltins=true keeps the browser-builtin / webkit*/moz*/on* names too — the model always
  // gets the trimmed view, but the human inspector can flip to the raw one to spot something hidden.
  function scanGlobals(includeBuiltins) {
    const skip = builtinNames();
    let all = [];
    try { all = Object.getOwnPropertyNames(PW); } catch { /* ignore */ }
    const rows = [];
    for (const n of all) {
      if (n === "__rsdCheatHud" || n === "__rsdAgent") continue; // never list our own runtime
      if (!includeBuiltins) {
        if (skip.has(n)) continue;
        if (/^(webkit|moz|on)/.test(n)) continue;
      }
      let v;
      try { v = PW[n]; } catch { continue; }
      const t = typeof v;
      if (t === "undefined") continue;
      const size = t === "object" && v ? (Array.isArray(v) ? v.length : countKeys(v)) : 0;
      rows.push({ name: n, type: Array.isArray(v) ? "array" : t, size, preview: preview(v) });
    }
    rows.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    return rows;
  }

  // Build a child path that tokenizePath can re-parse: numeric → [n], identifier → .name, else ["…"].
  function childPathOf(parent, k) {
    if (/^\d+$/.test(k)) return parent + "[" + k + "]";
    if (/^[A-Za-z_$][\w$]*$/.test(k)) return parent + "." + k;
    return parent + "[" + JSON.stringify(k) + "]";
  }

  // ---- op executor (driven by the background's LLM loop over the port) --------
  // Caps are surfaced to the model as "showing X of N", never a silent cut.
  const SCAN_CAP = 80;
  const KEY_CAP = 60;

  function leafValue(v) {
    const t = typeof v;
    if (v === null) return null;
    if (t === "number" || t === "boolean") return v;
    if (t === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
    if (t === "function") return "ƒ()";
    return preview(v);
  }
  function keyList(v) {
    let keys = [];
    try { keys = Object.keys(v); } catch { /* exotic object */ }
    return { keys: keys.slice(0, KEY_CAP), keysTotal: keys.length };
  }
  function scanObject(v) {
    let keys = [];
    try { keys = Object.keys(v); } catch { /* exotic object */ }
    const rows = [];
    for (const k of keys) {
      let val;
      try { val = v[k]; } catch { continue; }
      const t = typeof val;
      const size = t === "object" && val ? (Array.isArray(val) ? val.length : countKeys(val)) : 0;
      rows.push({ name: k, type: Array.isArray(val) ? "array" : t, size, preview: preview(val) });
    }
    rows.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    return { rows, total: keys.length };
  }

  // One op from the background. Returns a structured, postMessage-safe result (plain values only);
  // a soft failure is { error }, which the port handler turns into an OP_RESULT with ok:false.
  function execOp(cmd) {
    const o = cmd.op;
    if (o === "scan") {
      if (!cmd.path) {
        const all = scanGlobals();
        return { kind: "globals", rows: all.slice(0, SCAN_CAP), total: all.length };
      }
      let v;
      try { v = readPath(cmd.path); } catch (e) { return { error: e.message }; }
      if (v === null || typeof v !== "object") return { kind: "leaf", path: cmd.path, type: v === null ? "null" : typeof v, value: leafValue(v) };
      const { rows, total } = scanObject(v);
      return { kind: "object", path: cmd.path, type: Array.isArray(v) ? "array" : "object", rows: rows.slice(0, SCAN_CAP), total };
    }
    if (o === "read") {
      let v;
      try { v = readPath(cmd.path); } catch (e) { return { error: e.message }; }
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      if (v !== null && typeof v === "object") {
        const kl = keyList(v);
        return { path: cmd.path, type: t, preview: preview(v), keys: kl.keys, keysTotal: kl.keysTotal };
      }
      return { path: cmd.path, type: t, value: leafValue(v) };
    }
    if (o === "set") {
      let before;
      try { before = preview(readPath(cmd.path)); } catch { before = "(unset)"; }
      let after;
      try { after = preview(writeValue(cmd.path, cmd.value)); } catch (e) { return { error: e.message }; }
      addWatch(cmd.path);
      return { before, after };
    }
    if (o === "call") return callFn(cmd.path, cmd.args);
    if (o === "storage") return readStorage(cmd.key);
    if (o === "storageSet") return writeStorage(cmd.key, cmd.value);
    if (o === "freeze") return applyFreeze(cmd.path, true, cmd.value, "value" in cmd);
    if (o === "unfreeze") return applyFreeze(cmd.path, false);
    return { error: "unknown op " + o };
  }

  // ---- live formatting (idle-game numbers get huge) --------------------------
  function fmt(v) {
    if (typeof v === "number") {
      if (!isFinite(v)) return String(v);
      const a = Math.abs(v);
      if (a !== 0 && (a >= 1e7 || a < 1e-4)) return v.toExponential(3);
      return Number.isInteger(v) ? v.toLocaleString("en-US") : String(v);
    }
    return preview(v);
  }

  // ---- HUD (Shadow DOM, so the game's CSS can't touch it and ours can't leak) -

  const host = document.createElement("div");
  host.id = "__rsd-cheat-host";
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .panel { font: 12px/1.45 ui-monospace,Menlo,Consolas,monospace; color:#cdd6e0;
        background:#11161dF2; border:1px solid #2b3543; border-radius:8px;
        box-shadow:0 8px 30px #000a; overflow:hidden; }
      .bar { display:flex; align-items:center; gap:8px; padding:7px 9px; cursor:move;
        background:#1a212b; border-bottom:1px solid #2b3543; user-select:none; }
      .bar b { font-weight:600; color:#8fd0ff; letter-spacing:.3px; }
      .bar .sp { flex:1; }
      .bar button { cursor:pointer; }
      .body { padding:9px; display:flex; flex-direction:column; gap:9px; max-height:70vh; overflow:auto; }
      .body.min { display:none; }
      .sec { display:flex; flex-direction:column; gap:5px; }
      .lbl { color:#6b7a8d; text-transform:uppercase; font-size:10px; letter-spacing:.5px; }
      .row { display:flex; gap:5px; align-items:center; }
      input { flex:1; min-width:0; background:#0b0f14; border:1px solid #2b3543; color:#cdd6e0;
        border-radius:4px; padding:4px 6px; font:inherit; }
      button { background:#222c38; border:1px solid #2b3543; color:#cdd6e0; border-radius:4px;
        padding:4px 8px; font:inherit; }
      button:hover { background:#2b3a4a; }
      button.x { background:none; border:none; color:#6b7a8d; padding:2px 5px; }
      button.x:hover { color:#ff6b6b; }
      .scan { display:flex; flex-direction:column; gap:2px; max-height:150px; overflow:auto;
        border:1px solid #1f2733; border-radius:4px; padding:3px; }
      .g { display:flex; gap:6px; align-items:center; padding:2px 4px; border-radius:3px; }
      .g:hover { background:#1a212b; }
      .g .nm { color:#a9e34b; cursor:pointer; flex:0 0 auto; max-width:120px; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .g .nm:hover { text-decoration:underline; }
      .g .pv { color:#6b7a8d; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .watch { display:flex; flex-direction:column; gap:3px; }
      .w { display:flex; gap:6px; align-items:center; }
      .w .wp { flex:0 0 auto; color:#8fd0ff; max-width:150px; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .w .wv { flex:1; text-align:right; color:#fff; font-variant-numeric:tabular-nums; }
      .w button.lk { background:none; border:none; cursor:pointer; padding:2px 4px; color:#6b7a8d; }
      .w button.lk:hover, .w button.lk.on { color:#ffd479; }
      .empty { color:#52606e; font-style:italic; }
      .status { color:#6b7a8d; min-height:14px; word-break:break-all; }
      .status.err { color:#ff8787; }
      .ask { border:1px solid #2b3a4a; border-radius:6px; padding:7px; background:#141b24;
        display:flex; flex-direction:column; gap:6px; }
      .ask .lbl { color:#8fd0ff; }
      .ask button[data-run] { background:#1f6feb33; border-color:#1f6feb; color:#cfe3ff; }
      .ask button[data-run]:hover { background:#1f6feb55; }
      .log { display:flex; flex-direction:column; gap:1px; max-height:140px; overflow:auto;
        border-top:1px solid #1f2733; padding-top:5px; font-size:11px; }
      .log .ln { white-space:pre-wrap; word-break:break-word; }
      .log .think { color:#7e8aa0; font-style:italic; }
      .log .act { color:#a9e34b; }
      .log .note { color:#6b7a8d; }
      .log .error { color:#ff8787; }
      .answer { white-space:pre-wrap; word-break:break-word; color:#e6edf3;
        background:#0b0f14; border:1px solid #2b3543; border-radius:5px; padding:7px; }
      /* ---- heap inspector (extended mode) ---- */
      .insp { display:none; }
      .insp.on { display:flex; flex-direction:column; gap:5px; }
      .insp-bar { display:flex; align-items:center; gap:6px; position:sticky; top:-9px;
        background:#11161d; padding:6px 0; z-index:2; }
      .insp-bar input { flex:1; }
      .insp-bar .chk { display:flex; align-items:center; gap:3px; color:#6b7a8d; flex:0 0 auto;
        white-space:nowrap; cursor:pointer; }
      .insp-bar .chk input { flex:0 0 auto; width:auto; }
      .tree { border:1px solid #1f2733; border-radius:4px; padding:4px; }
      .nrow { display:flex; gap:5px; align-items:center; padding:1px 2px; border-radius:3px;
        white-space:nowrap; }
      .nrow:hover { background:#1a212b; }
      .tw { flex:0 0 auto; width:12px; text-align:center; color:#7e8aa0; cursor:pointer;
        user-select:none; }
      .tw.leaf { cursor:default; color:#2b3543; }
      .nrow .nm { color:#a9e34b; cursor:pointer; flex:0 0 auto; }
      .nrow .nm:hover { text-decoration:underline; }
      .nrow .ty { color:#52606e; flex:0 0 auto; }
      .nrow .pv { color:#9fb0c3; flex:1 1 auto; min-width:0; overflow:hidden;
        text-overflow:ellipsis; }
      .nrow .pv.live { color:#fff; font-variant-numeric:tabular-nums; }
      .nrow button.lk { background:none; border:none; cursor:pointer; padding:0 3px; color:#6b7a8d;
        flex:0 0 auto; }
      .nrow button.lk:hover, .nrow button.lk.on { color:#ffd479; }
      .children { margin-left:11px; border-left:1px solid #1f2733; padding-left:2px; }
      .hits { color:#6b7a8d; padding:2px 2px 4px; font-style:italic; }
    </style>
    <div class="panel">
      <div class="bar" data-drag>
        <b>rsd cheat lab</b><span class="sp"></span>
        <button class="x" data-expand title="extended mode — live heap inspector">⤢</button>
        <button class="x" data-min title="collapse">–</button>
        <button class="x" data-close title="close (toggle off)">×</button>
      </div>
      <div class="body">
        <div class="sec insp" data-insp>
          <span class="lbl">heap inspector — browse the page's live JS, find what the model missed</span>
          <div class="insp-bar">
            <input data-filter placeholder="filter — type to search all globals by name OR value (e.g. candy, 1337)" />
            <label class="chk" title="include browser builtins / webkit*/moz*/on* names"><input type="checkbox" data-builtins /> builtins</label>
            <button data-refresh title="refresh">⟳</button>
          </div>
          <div class="tree" data-tree></div>
        </div>
        <div class="sec ask">
          <span class="lbl">ask the model to cheat</span>
          <div class="row"><input data-ask placeholder="e.g. give me a trillion cookies" />
            <button data-run>Ask</button><button data-stop hidden>Stop</button></div>
          <div class="log" data-log hidden></div>
          <div class="answer" data-answer hidden></div>
        </div>
        <div class="sec">
          <div class="row"><span class="lbl">page globals</span><span class="sp" style="flex:1"></span>
            <button data-scan>Scan</button></div>
          <div class="scan" data-scanlist><span class="empty">Scan to list this page's JS globals.</span></div>
        </div>
        <div class="sec watch">
          <span class="lbl">watches</span>
          <div data-watches><span class="empty">No watches. Click a global, or add a path below.</span></div>
          <div class="row"><input data-watchin placeholder="path to watch, e.g. Game.cookies" />
            <button data-watchadd>Watch</button></div>
        </div>
        <div class="sec">
          <span class="lbl">read / write</span>
          <div class="row"><input data-path placeholder="path, e.g. Game.cookies" /></div>
          <div class="row"><input data-val placeholder="value (JSON: 1e12, true, &quot;hi&quot;)" />
            <button data-read>Read</button><button data-set>Set</button></div>
        </div>
        <div class="status" data-status></div>
      </div>
    </div>`;
  (document.documentElement || document.body).appendChild(host);

  // Keep the game's keyboard shortcuts off our inputs. Keyboard events are composed, so a keystroke
  // in a HUD field bubbles across the shadow boundary into the page — and idle games bind single-key
  // hotkeys there (a candy game using "e" for eat, "t" for throw) and preventDefault() them, which
  // swallows that very character in our input while paste still works. Stop keyboard events at the
  // shadow root so nothing typed in the HUD reaches the page; our own listeners already ran deeper.
  //
  // mousedown/selectstart matter for a different reason: mousedown's DEFAULT ACTION is what focuses
  // the clicked element. Games that cancel document-level mousedown to block text selection (A Dark
  // Room's disableSelection) therefore make every HUD field unfocusable — no focus, no typing, and
  // the key shield above never even comes into play. Stopping propagation here keeps the event from
  // reaching the page while the focus default still runs. mouseup stays unshielded on purpose: the
  // drag handler's end-listener lives on window and must see releases over the panel.
  for (const type of ["keydown", "keypress", "keyup", "mousedown", "selectstart"]) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  const $ = (s) => root.querySelector(s);
  const body = $(".body");
  const statusEl = $("[data-status]");
  const pathIn = $("[data-path]");
  const valIn = $("[data-val]");
  const watchesEl = $("[data-watches]");
  const scanListEl = $("[data-scanlist]");
  const inspSec = $("[data-insp]");
  const treeEl = $("[data-tree]");
  const filterIn = $("[data-filter]");
  const builtinsCb = $("[data-builtins]");

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("err", !!isErr);
  }

  // ---- watches ---------------------------------------------------------------
  const watches = []; // [{ path, valEl }]
  function renderWatches() {
    watchesEl.textContent = "";
    if (!watches.length) {
      const e = document.createElement("span");
      e.className = "empty";
      e.textContent = "No watches. Click a global, or add a path below.";
      watchesEl.appendChild(e);
      return;
    }
    for (const w of watches) {
      const row = document.createElement("div");
      row.className = "w";
      const p = document.createElement("span");
      p.className = "wp";
      p.textContent = w.path;
      p.title = w.path;
      const v = document.createElement("span");
      v.className = "wv";
      v.textContent = "…";
      const lk = document.createElement("button");
      lk.className = "lk" + (w.frozen ? " on" : "");
      lk.textContent = w.frozen ? "🔒" : "🔓";
      lk.title = w.frozen ? "frozen — click to unfreeze" : "freeze this value (re-assert it ~4×/sec)";
      lk.onclick = () => toggleFreeze(w);
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = "remove watch";
      x.onclick = () => { watches.splice(watches.indexOf(w), 1); renderWatches(); };
      row.append(p, v, lk, x);
      watchesEl.appendChild(row);
      w.valEl = v;
    }
    tick();
  }
  function addWatch(path) {
    path = (path || "").trim();
    if (!path || watches.some((w) => w.path === path)) return;
    watches.push({ path });
    renderWatches();
  }

  // Persistent cheat: re-assert a value on every tick so the game can't change it. Freeze is the
  // idle-game staple — money that never drops as you buy, a multiplier pinned high. It's
  // content-script-only (no page-world code, CSP-immune) but only holds an AUTHORITATIVE stored
  // field; a value the game recomputes each frame just gets overwritten back. A frozen path is
  // always watched, so the user sees it hold. Primitives only — re-cloning an object every tick
  // would be wasteful and is never what "freeze a number" means.
  function applyFreeze(path, on, value, hasValue) {
    addWatch(path);
    const key = (path || "").trim();
    const w = watches.find((x) => x.path === key);
    if (!w) return { error: "could not watch " + path };
    if (!on) { w.frozen = false; w.freezeValue = undefined; renderWatches(); return { path: w.path, frozen: false }; }
    let v;
    if (hasValue) {
      if (value !== null && typeof value === "object") return { error: "freeze needs a single number/text/boolean value, not an object" };
      try { v = writeValue(w.path, value); } catch (e) { return { error: e.message }; }
    } else {
      try { v = readPath(w.path); } catch (e) { return { error: e.message }; }
      if (v !== null && typeof v === "object") return { error: "freeze needs a single number/text/boolean value, not an object — pick a leaf path" };
    }
    w.frozen = true; w.freezeValue = v;
    renderWatches();
    return { path: w.path, frozen: true, value: leafValue(v) };
  }
  function toggleFreeze(w) {
    const r = applyFreeze(w.path, !w.frozen, undefined, false);
    if (r && r.error) setStatus("freeze: " + r.error, true);
  }

  function tick() {
    for (const w of watches) {
      if (w.frozen) { try { writeValue(w.path, w.freezeValue); } catch { /* path vanished this frame */ } }
      if (!w.valEl) continue;
      try { w.valEl.textContent = fmt(readPath(w.path)); w.valEl.style.color = w.frozen ? "#ffd479" : "#fff"; }
      catch { w.valEl.textContent = "—"; w.valEl.style.color = "#52606e"; }
    }
    tickTree();
  }
  const timer = setInterval(tick, 250);

  // ---- scan list -------------------------------------------------------------
  function renderScan() {
    let rows;
    try { rows = scanGlobals(); } catch (e) { setStatus("scan failed: " + e.message, true); return; }
    scanListEl.textContent = "";
    if (!rows.length) {
      const e = document.createElement("span");
      e.className = "empty";
      e.textContent = "No page-added globals found (state may be closure-bound — a later tier).";
      scanListEl.appendChild(e);
      return;
    }
    for (const r of rows) {
      const g = document.createElement("div");
      g.className = "g";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = r.name;
      nm.title = "click → watch + fill path";
      nm.onclick = () => { pathIn.value = r.name; addWatch(r.name); };
      const pv = document.createElement("span");
      pv.className = "pv";
      pv.textContent = r.type + (r.size ? "(" + r.size + ") " : " ") + r.preview;
      g.append(nm, pv);
      scanListEl.appendChild(g);
    }
    setStatus(rows.length + " global" + (rows.length === 1 ? "" : "s") + " — most-populated first");
  }

  // ---- read / write ----------------------------------------------------------
  function doRead() {
    const p = pathIn.value.trim();
    if (!p) return setStatus("enter a path", true);
    try { setStatus(p + " = " + preview(readPath(p))); } catch (e) { setStatus(e.message, true); }
  }
  function doSet() {
    const p = pathIn.value.trim();
    if (!p) return setStatus("enter a path", true);
    try {
      const now = writeValue(p, parseValue(valIn.value).value);
      setStatus("set " + p + " → " + preview(now));
      addWatch(p);
    } catch (e) { setStatus("write failed: " + e.message, true); }
  }

  // ---- heap inspector (extended mode) ---------------------------------------
  // A live, hand-browsable tree of the page's JS — the human counterpart to the model's scan/read,
  // for finding state the LLM missed (or proving it's closure-bound and only reachable via the save).
  let expanded = false;
  let showBuiltins = false;
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function isLeafVal(v) { return v === null || (typeof v !== "object" && typeof v !== "function"); }

  // One tree node: a row (toggle · name · type · live value · freeze) plus a lazily-built child box.
  function makeNode(key, path, v) {
    let keys = [];
    if (v !== null && (typeof v === "object" || typeof v === "function")) { try { keys = Object.keys(v); } catch { /* exotic */ } }
    const expandable = keys.length > 0;
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

    const node = el("div", "node");
    const row = el("div", "nrow");
    const tw = el("span", "tw" + (expandable ? "" : " leaf"));
    tw.textContent = expandable ? "▶" : "·";
    const nm = el("span", "nm"); nm.textContent = key; nm.title = path + "  (click → fill path + watch)";
    nm.onclick = () => { pathIn.value = path; addWatch(path); setStatus("path → " + path); };
    const ty = el("span", "ty"); ty.textContent = t;
    const pv = el("span", "pv");
    if (v !== null && typeof v === "object") { pv.textContent = preview(v); } // objects: static count, refreshed on expand
    else { pv.classList.add("live"); pv.dataset.path = path; pv.textContent = fmt(v); } // leaves/fns: live
    row.append(tw, nm, ty, pv);

    if (isLeafVal(v)) {
      const w0 = watches.find((x) => x.path === path);
      const lk = el("button", "lk" + (w0 && w0.frozen ? " on" : "")); lk.dataset.path = path;
      lk.textContent = w0 && w0.frozen ? "🔒" : "🔓"; lk.title = "freeze / unfreeze this value";
      lk.onclick = () => {
        const w = watches.find((x) => x.path === path);
        const r = applyFreeze(path, !(w && w.frozen), undefined, false);
        if (r && r.error) setStatus("freeze: " + r.error, true);
        syncTreeLocks();
      };
      row.append(lk);
    }
    node.append(row);

    if (expandable) {
      const kids = el("div", "children"); kids.hidden = true; node.append(kids);
      let open = false;
      tw.onclick = () => {
        open = !open; tw.textContent = open ? "▼" : "▶"; kids.hidden = !open;
        if (open && !kids.dataset.built) {
          kids.dataset.built = "1";
          let cur; try { cur = readPath(path); } catch { cur = v; } // fresh read so children aren't stale
          let ks = []; try { ks = Object.keys(cur); } catch { /* exotic */ }
          const CAP = 300;
          for (const k of ks.slice(0, CAP)) {
            let cv; try { cv = cur[k]; } catch { continue; }
            kids.append(makeNode(k, childPathOf(path, k), cv));
          }
          if (ks.length > CAP) { const m = el("div", "hits"); m.textContent = `…(${ks.length - CAP} more, capped at ${CAP})`; kids.append(m); }
        }
      };
    }
    return node;
  }

  // The localStorage pseudo-root — the save layer, in the same tree. Rows are editable in place.
  function makeStorageRoot() {
    const node = el("div", "node");
    const row = el("div", "nrow");
    const tw = el("span", "tw"); tw.textContent = "▶";
    const nm = el("span", "nm"); nm.textContent = "⟦localStorage⟧"; nm.style.color = "#8fd0ff"; nm.title = "the page's saved data (edit + reload to cheat closure-bound games)";
    const pv = el("span", "pv");
    row.append(tw, nm, pv); node.append(row);
    const kids = el("div", "children"); kids.hidden = true; node.append(kids);
    let open = false;
    tw.onclick = () => {
      open = !open; tw.textContent = open ? "▼" : "▶"; kids.hidden = !open;
      if (!open) return;
      kids.textContent = ""; // rebuild each open — the store changes as you play
      const r = readStorage(null);
      if (r.error) { const m = el("div", "empty"); m.textContent = r.error; kids.append(m); return; }
      pv.textContent = r.total + " key" + (r.total === 1 ? "" : "s");
      if (!r.rows.length) { const m = el("div", "empty"); m.textContent = "(empty)"; kids.append(m); return; }
      for (const it of r.rows) kids.append(makeStorageRow(it.key, it.preview));
      if (r.total > r.rows.length) { const m = el("div", "hits"); m.textContent = `…(${r.total - r.rows.length} more, capped at ${STORAGE_CAP})`; kids.append(m); }
    };
    return node;
  }
  function makeStorageRow(key, prev) {
    const row = el("div", "nrow");
    const tw = el("span", "tw leaf"); tw.textContent = "·";
    const nm = el("span", "nm"); nm.textContent = key; nm.title = key;
    const pv = el("span", "pv live"); pv.textContent = prev;
    const ed = el("button", "lk"); ed.textContent = "✎"; ed.title = "edit this saved value (reload to apply)";
    ed.onclick = () => {
      const cur = readStorage(key);
      const input = el("input"); input.value = cur && cur.value != null ? cur.value : "";
      const save = el("button"); save.textContent = "Save";
      const cancel = el("button", "x"); cancel.textContent = "×";
      const editRow = el("div", "nrow"); editRow.append(input, save, cancel);
      row.after(editRow); input.focus();
      const close = () => editRow.remove();
      save.onclick = () => {
        const r = writeStorage(key, input.value);
        if (r && r.error) setStatus("storage: " + r.error, true);
        else { pv.textContent = clipStr(input.value, 60); setStatus(`localStorage["${key}"] set — RELOAD to apply`); }
        close();
      };
      cancel.onclick = close;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); else if (e.key === "Escape") close(); });
    };
    row.append(tw, nm, pv, ed);
    return row;
  }

  function renderTree() {
    treeEl.textContent = "";
    treeEl.append(makeStorageRoot());
    if (Object.keys(stash).length) treeEl.append(makeNode(STASH_ROOT, STASH_ROOT, stash)); // parked call results
    let rows;
    try { rows = scanGlobals(showBuiltins); } catch (e) { setStatus("inspector scan failed: " + e.message, true); return; }
    if (!rows.length) {
      const m = el("div", "empty");
      m.textContent = "No " + (showBuiltins ? "" : "page-added ") + "globals — state is likely closure-bound; open ⟦localStorage⟧ to find the save.";
      treeEl.append(m);
    }
    for (const r of rows) {
      let v; try { v = PW[r.name]; } catch { continue; }
      treeEl.append(makeNode(r.name, r.name, v));
    }
  }

  // Bounded heap search: match a key NAME or a primitive VALUE (so "1337" finds where your count lives).
  function searchHeap(q) {
    q = q.toLowerCase();
    const out = []; const seen = new Set();
    let nodes = 0, truncated = false;
    const MAXDEPTH = 4, MAXNODES = 6000, MAXRESULTS = 200;
    function consider(name, path, v) {
      const isPrim = isLeafVal(v);
      const nameHit = String(name).toLowerCase().includes(q);
      const valHit = isPrim && v !== null && String(v).toLowerCase().includes(q);
      if (nameHit || valHit) {
        const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        out.push({ path, type: t, preview: preview(v), isLeaf: isPrim });
      }
    }
    function visit(obj, path, depth) {
      if (out.length >= MAXRESULTS || nodes >= MAXNODES) { truncated = true; return; }
      if (depth > MAXDEPTH) { truncated = true; return; }
      let keys; try { keys = Object.keys(obj); } catch { return; }
      for (const k of keys) {
        if (out.length >= MAXRESULTS || nodes >= MAXNODES) { truncated = true; return; }
        nodes++;
        let v; try { v = obj[k]; } catch { continue; }
        const childPath = childPathOf(path, k);
        consider(k, childPath, v);
        if (v !== null && typeof v === "object" && !seen.has(v)) { seen.add(v); visit(v, childPath, depth + 1); }
      }
    }
    let roots; try { roots = scanGlobals(showBuiltins); } catch { roots = []; }
    for (const r of roots) {
      if (out.length >= MAXRESULTS || nodes >= MAXNODES) { truncated = true; break; }
      let v; try { v = PW[r.name]; } catch { continue; }
      nodes++;
      consider(r.name, r.name, v);
      if (v !== null && typeof v === "object" && !seen.has(v)) { seen.add(v); visit(v, r.name, 1); }
    }
    return { rows: out, truncated, nodes };
  }

  function renderSearch(q) {
    treeEl.textContent = "";
    let res;
    try { res = searchHeap(q); } catch (e) { setStatus("search failed: " + e.message, true); return; }
    const head = el("div", "hits");
    if (!res.rows.length) { head.textContent = `No match for “${q}” (searched ${res.nodes} nodes${res.truncated ? ", capped" : ""}).`; treeEl.append(head); return; }
    head.textContent = `${res.rows.length} match${res.rows.length === 1 ? "" : "es"} for “${q}”` + (res.truncated ? ` — capped (searched ${res.nodes} nodes; narrow the term to see the rest)` : "");
    treeEl.append(head);
    for (const r of res.rows) {
      const row = el("div", "nrow");
      const nm = el("span", "nm"); nm.textContent = r.path; nm.title = "click → fill path + watch";
      nm.onclick = () => { pathIn.value = r.path; addWatch(r.path); setStatus("path → " + r.path); };
      const ty = el("span", "ty"); ty.textContent = r.type;
      const pv = el("span", "pv"); pv.textContent = r.preview;
      if (r.isLeaf) { pv.classList.add("live"); pv.dataset.path = r.path; }
      row.append(nm, ty, pv);
      treeEl.append(row);
    }
  }

  function refreshInspector() {
    const q = filterIn.value.trim();
    if (q) renderSearch(q); else renderTree();
  }
  // Live-update only the value cells currently in the tree (leaves + fns), and keep freeze locks gold.
  function tickTree() {
    if (!expanded) return;
    const cells = treeEl.querySelectorAll(".pv.live[data-path]");
    for (const c of cells) {
      const p = c.dataset.path;
      try { c.textContent = fmt(readPath(p)); } catch { c.textContent = "—"; }
      const w = watches.find((x) => x.path === p);
      c.style.color = w && w.frozen ? "#ffd479" : "#fff";
    }
  }
  function syncTreeLocks() {
    for (const b of treeEl.querySelectorAll("button.lk[data-path]")) {
      const w = watches.find((x) => x.path === b.dataset.path);
      const on = !!(w && w.frozen);
      b.textContent = on ? "🔒" : "🔓"; b.classList.toggle("on", on);
    }
    renderWatches();
  }
  function toggleExpand() {
    expanded = !expanded;
    inspSec.classList.toggle("on", expanded);
    if (expanded) {
      body.classList.remove("min"); // can't inspect into a collapsed body
      host.style.width = "85vw"; host.style.left = "7.5vw"; host.style.top = "7vh"; host.style.right = "auto";
      body.style.maxHeight = "85vh";
      refreshInspector();
    } else {
      host.style.width = "340px"; host.style.right = "16px"; host.style.top = "16px"; host.style.left = "auto";
      body.style.maxHeight = "";
    }
  }
  filterIn.addEventListener("input", refreshInspector);
  builtinsCb.addEventListener("change", () => { showBuiltins = builtinsCb.checked; refreshInspector(); });
  $("[data-refresh]").onclick = refreshInspector;

  $("[data-scan]").onclick = renderScan;
  $("[data-watchadd]").onclick = () => { addWatch($("[data-watchin]").value); $("[data-watchin]").value = ""; };
  $("[data-watchin]").addEventListener("keydown", (e) => { if (e.key === "Enter") $("[data-watchadd]").click(); });
  $("[data-read]").onclick = doRead;
  $("[data-set]").onclick = doSet;
  valIn.addEventListener("keydown", (e) => { if (e.key === "Enter") doSet(); });

  // ---- LLM "ask to cheat": port to the background loop -----------------------
  // Protocol literals mirror common/messages.js (an injected content script can't import it).
  const PORT = "cheat";
  const CH = {
    RUN: "cheat:run", CANCEL: "cheat:cancel", OP_RESULT: "cheat:opResult",
    OP: "cheat:op", STEP: "cheat:step", DONE: "cheat:done", WATCH: "cheat:watch",
    BUSY: "cheat:busy", ERROR: "cheat:error",
  };
  const LOG_GLYPH = { think: "💭", act: "→", note: "·", error: "⚠", done: "✓" };
  const askIn = $("[data-ask]");
  const runBtn = $("[data-run]");
  const stopBtn = $("[data-stop]");
  const logEl = $("[data-log]");
  const answerEl = $("[data-answer]");

  function logStep(kind, text) {
    logEl.hidden = false;
    const ln = document.createElement("div");
    ln.className = "ln " + (kind || "note");
    ln.textContent = (LOG_GLYPH[kind] || "·") + " " + text;
    logEl.appendChild(ln);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function showAnswer(text) { answerEl.hidden = false; answerEl.textContent = text; }
  function setBusy(active) { runBtn.hidden = !!active; stopBtn.hidden = !active; askIn.disabled = !!active; }

  let port = null;
  try { port = browser.runtime.connect({ name: PORT }); } catch { /* background not reachable */ }
  if (port) {
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case CH.OP: {
          // The HUD is the heap executor: run the op and reply. Soft failures come back as
          // { error } from execOp; a thrown one is caught here. Either way → ok:false to the loop.
          let value, ok = true, error = "";
          try {
            value = execOp(msg);
            if (value && value.error) { ok = false; error = value.error; value = undefined; }
          } catch (e) { ok = false; error = (e && e.message) || "op threw"; }
          try { port.postMessage({ type: CH.OP_RESULT, id: msg.id, ok, value, error }); } catch { /* gone */ }
          break;
        }
        case CH.STEP: logStep(msg.kind, msg.text); break;
        case CH.DONE: logStep("done", "done"); showAnswer(msg.text); break;
        case CH.WATCH: addWatch(msg.path); break;
        case CH.BUSY: setBusy(msg.active); break;
        case CH.ERROR: setStatus(msg.message + (msg.detail ? " — " + msg.detail : ""), true); break;
      }
    });
    port.onDisconnect.addListener(() => { port = null; });
  }

  function runGoal() {
    const goal = askIn.value.trim();
    if (!goal) return;
    if (!port) return setStatus("background not connected — reload the page and reopen the HUD.", true);
    logEl.textContent = "";
    answerEl.hidden = true;
    logStep("note", "▸ " + goal);
    port.postMessage({ type: CH.RUN, goal });
  }
  function stopGoal() { if (port) port.postMessage({ type: CH.CANCEL }); }

  runBtn.onclick = runGoal;
  stopBtn.onclick = stopGoal;
  askIn.addEventListener("keydown", (e) => { if (e.key === "Enter") runGoal(); });

  // ---- chrome: expand, minimize, close, drag --------------------------------
  $("[data-expand]").onclick = toggleExpand;
  $("[data-min]").onclick = () => body.classList.toggle("min");
  function destroy() {
    clearInterval(timer);
    try { if (port) port.disconnect(); } catch { /* already gone */ }
    host.remove();
    try { delete window[G]; } catch { window[G] = null; }
  }
  $("[data-close]").onclick = destroy;

  // Drag by the title bar. Listeners go on window (content realm) so dragging past the panel edge
  // keeps tracking; we switch to left/top and clear right on first move.
  (() => {
    const bar = $("[data-drag]");
    let sx, sy, ox, oy, dragging = false;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; dragging = true;
      host.style.left = ox + "px"; host.style.top = oy + "px"; host.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      host.style.left = ox + (e.clientX - sx) + "px";
      host.style.top = Math.max(0, oy + (e.clientY - sy)) + "px";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  })();

  window[G] = { destroy };
  setStatus("ready — Scan to find the game's state, then watch / set a value.");
  return { ok: true, action: "opened" };
})();

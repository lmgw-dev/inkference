// The Script panel — a full-height view over the chat (the reader.js pattern), opened from the
// "Script…" button or the page-action icon in the address bar.
//
// It shows the ONE draft the agent and the user work on together: its rules with what each
// matches right now, the last test run, the compiled CSS — and the scripts saved for the tab
// the user is looking at, each with its health (do its rules still match on the user's visits?)
// and, when some went stale, a button that hands the repair to the agent. It is a stateless
// view: every edit is posted to the background, which re-applies the draft to the page and
// answers with SCRIPT_STATE, and the panel re-renders from that. The one concession to typing is that a field with focus is never
// overwritten — a broadcast arriving mid-word (a live count, the agent adding a rule) must not
// eat what the user is typing.

import { ACTIONS, isBroadMatch } from "../background/rulecss.js";
import { pct, parseMatches, staleNote, targetNoun, STALE_VISITS } from "../background/scriptcore.js";

const CONFIRM_MS = 3000; // a destructive button stays armed this long after its first click

export function createScriptPanel(root, { onEdit, onTest, onSave, onDiscard, onLoad, onSetEnabled, onDelete, onRepair }) {
  const $ = (id) => root.querySelector("#" + id);
  const els = {
    source: $("script-source"),
    close: $("script-close"),
    error: $("script-error"),
    empty: $("script-empty"),
    draft: $("script-draft"),
    where: $("script-where"),
    name: $("script-name"),
    match: $("script-match"),
    matchWarn: $("script-match-warn"),
    sheetError: $("script-sheet-error"),
    rules: $("script-rules"),
    picks: $("script-picks"),
    test: $("script-test"),
    css: $("script-css"),
    saved: $("script-saved"),
    retest: $("script-retest"),
    save: $("script-save"),
    discard: $("script-discard"),
    status: $("script-status"),
  };

  let state = { draft: null, saved: [], lastTest: null };
  const rows = new Map(); // rule id -> its row's elements, reused across renders

  els.close.addEventListener("click", () => close());
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  els.name.addEventListener("change", () => onEdit({ op: "setName", name: els.name.value }));
  els.match.addEventListener("change", () => onEdit({ op: "setMatch", matches: els.match.value }));
  els.match.addEventListener("input", () => warnBroad());
  els.retest.addEventListener("click", () => {
    els.error.hidden = true;
    onTest();
  });
  // Name and match go along with Save: the click blurs the field (its change fires first), but
  // the background should not have to rely on that ordering. A pattern that reaches every site
  // is the user's call, made here and nowhere else (the agent may not save one) — with the
  // warning on screen and a second click; only then does the save carry allowBroad.
  armed(
    els.save,
    "Save for every site?",
    () => onSave({ name: els.name.value, matches: els.match.value, allowBroad: broadIn(els.match.value).length > 0 }),
    () => broadIn(els.match.value).length > 0,
  );
  armed(els.discard, "Discard?", () => onDiscard());

  function warnBroad() {
    const broad = broadIn(els.match.value);
    els.matchWarn.hidden = !broad.length;
    els.matchWarn.textContent = broad.length
      ? `WARNING: ${broad.join(" ")} reaches every site (or every local file) — saved like this, the script runs on all of them. Narrow it to this site unless that is what you want.`
      : "";
  }

  // ---- rule rows ----

  function makeRow(id) {
    const row = document.createElement("div");
    row.className = "sc-rule";
    const head = document.createElement("div");
    head.className = "sc-rule-head";
    const tag = document.createElement("span");
    tag.className = "sc-id";
    tag.textContent = id;
    const action = document.createElement("select");
    action.className = "sc-action";
    for (const [name, hint] of Object.entries(ACTIONS)) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      o.title = hint;
      action.append(o);
    }
    const stale = document.createElement("span");
    stale.className = "sc-stale";
    const count = document.createElement("span");
    count.className = "sc-count";
    const remove = document.createElement("button");
    remove.className = "sc-remove";
    remove.textContent = "✕";
    remove.title = `Remove ${id}`;
    head.append(tag, action, stale, count, remove);

    const selector = document.createElement("input");
    selector.type = "text";
    selector.className = "sc-selector";
    selector.spellcheck = false;
    selector.title = "CSS selector — applied live when you leave the field";
    const params = document.createElement("input");
    params.type = "text";
    params.className = "sc-params";
    params.spellcheck = false;
    params.placeholder = "params (JSON) — e.g. {\"hover\": \"[data-testid=tile]\"}";
    const why = document.createElement("div");
    why.className = "sc-why";
    row.append(head, selector, params, why);

    // A new action sends the params field along: switching to `move` needs its `to`, and the
    // background rejects the switch (and says why) without one.
    action.addEventListener("change", () => onEdit({ op: "update", id, action: action.value, params: params.value.trim() || "{}" }));
    selector.addEventListener("change", () => onEdit({ op: "update", id, selector: selector.value }));
    params.addEventListener("change", () => onEdit({ op: "update", id, params: params.value.trim() || "{}" }));
    remove.addEventListener("click", () => onEdit({ op: "remove", id }));
    const els2 = { row, action, stale, count, selector, params, why };
    rows.set(id, els2);
    return els2;
  }

  function renderRules(d, test) {
    const zero = new Set((test && test.zero) || []);
    const partial = new Set((test && test.partial) || []);
    const ids = new Set(d.rules.map((r) => r.id));
    for (const [id, r] of rows) {
      if (!ids.has(id)) {
        r.row.remove();
        rows.delete(id);
      }
    }
    if (!d.rules.length) {
      els.rules.textContent = "No rules yet.";
      els.rules.classList.add("rd-note");
      return;
    }
    if (els.rules.classList.contains("rd-note")) {
      els.rules.textContent = "";
      els.rules.classList.remove("rd-note");
    }
    d.rules.forEach((rule, i) => {
      const r = rows.get(rule.id) || makeRow(rule.id);
      if (els.rules.children[i] !== r.row) els.rules.insertBefore(r.row, els.rules.children[i] || null);
      setValue(r.action, rule.action);
      setValue(r.selector, rule.selector);
      const p = rule.params && Object.keys(rule.params).length ? JSON.stringify(rule.params) : "";
      setValue(r.params, p);
      r.why.textContent = rule.why || "";
      r.why.hidden = !rule.why;
      const n = d.counts ? d.counts[rule.id] : undefined;
      r.count.textContent = typeof n === "number" ? `${n} now` : n ? "error" : "–";
      r.count.title = typeof n === "number" ? `matches ${n} element${n === 1 ? "" : "s"} on the page right now` : n || "not measured";
      r.count.classList.toggle("none", n === 0);
      r.row.classList.toggle("zero", zero.has(rule.id));
      r.row.classList.toggle("partial", partial.has(rule.id));
      // The saved script's verdict on this rule, until the rule's selector is changed here.
      const h = (d.health || {})[rule.id];
      const stale = !!h && h.state === "stale";
      r.row.classList.toggle("stale", stale);
      r.stale.hidden = !stale;
      r.stale.textContent = stale ? "stale" : "";
      r.row.title = stale
        ? `Stale: ${staleNote(d.target)} — the site probably renamed it. Give it a selector that matches again.`
        : zero.has(rule.id)
          ? "Matched nothing at any step of the last test"
          : partial.has(rule.id)
            ? "Matched only at some steps of the last test"
            : "";
    });
  }

  function renderPicks(d) {
    els.picks.textContent = "";
    if (!d.picks.length) return;
    const legend = document.createElement("div");
    legend.className = "sc-legend";
    legend.textContent = "Your picks";
    els.picks.append(legend);
    for (const p of d.picks) {
      const line = document.createElement("div");
      line.className = "sc-pick";
      line.textContent = `${p.id}: ${p.desc}${p.best ? ` → ${p.best.selector}${p.best.stable ? " (stable)" : ""}` : ""}`;
      els.picks.append(line);
    }
  }

  function renderTest(t) {
    els.test.textContent = "";
    if (!t) return;
    const legend = document.createElement("div");
    legend.className = "sc-legend";
    legend.textContent = `Last test · ${new Date(t.at).toLocaleTimeString()}`;
    els.test.append(legend);
    const empty = new Set(t.empty || []);
    for (const s of t.steps || []) {
      const line = document.createElement("div");
      line.className = "sc-step";
      const counts = Object.entries(s.counts || {})
        .map(([id, n]) => `${id} ${n}`)
        .join(" · ");
      line.textContent = `${s.label} — ${s.targets} videos · coverage ${pct(s.coverage)}${counts ? " · " + counts : ""}${s.settleTimedOut ? " · didn't settle" : ""}${empty.has(s.label) ? " · no video on screen (0 matches expected)" : ""}`;
      els.test.append(line);
    }
    const probs = [
      ...(t.zero || []).map((id) => `${id} matched nothing at any step`),
      ...(t.partial || []).map((id) => `${id} matched at some steps only — it fits some tiles, not all`),
      ...(t.notes || []),
    ];
    if (t.baseline != null) probs.push(`before any rules: coverage ${pct(t.baseline)}`);
    for (const text of probs) {
      const line = document.createElement("div");
      line.className = "sc-problem";
      line.textContent = text;
      els.test.append(line);
    }
  }

  function renderSaved(list) {
    els.saved.textContent = "";
    if (!list.length) {
      els.saved.className = "rd-note";
      els.saved.textContent = state.tab ? `Nothing saved for ${host(state.tab.url) || "this page"} yet.` : "No tab.";
      return;
    }
    els.saved.className = "";
    for (const s of list) {
      const row = document.createElement("div");
      row.className = "sc-saved";
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = s.enabled;
      box.title = s.enabled ? "On — applied on every visit" : "Off";
      box.addEventListener("change", () => onSetEnabled(s.id, box.checked));
      const name = document.createElement("span");
      name.className = "sc-saved-name";
      name.textContent = s.name + (s.editing ? " (in the draft)" : "");
      label.append(box, name);
      const meta = document.createElement("span");
      meta.className = "rd-note";
      meta.textContent = `${s.rules} rule${s.rules === 1 ? "" : "s"} · ${s.matches.join(" ")}${s.versions ? ` · ${s.versions} earlier version${s.versions === 1 ? "" : "s"}` : ""}`;
      if (s.sheetError) {
        meta.textContent += ` · NOT applied: ${s.sheetError}`;
        meta.classList.add("sc-problem");
      }
      const health = healthLine(s);
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.title = "Load into the draft to change it (applied live in this tab until you save or discard)";
      edit.disabled = s.editing;
      edit.addEventListener("click", () => onLoad(s.id));
      const del = document.createElement("button");
      del.textContent = "Delete";
      armed(del, "Delete?", () => onDelete(s.id));
      const actions = document.createElement("div");
      actions.className = "sc-saved-actions";
      if (s.health && s.health.stale.length) {
        const repair = document.createElement("button");
        repair.textContent = "Repair with the agent";
        repair.className = "sc-repair";
        repair.title = "Load it into the draft, turn on Use page + Script, and write a request naming the stale rules into the chat box — you read it and send it";
        repair.addEventListener("click", () => onRepair(s.id));
        actions.append(repair);
      }
      actions.append(edit, del);
      row.append(label, meta, health, actions);
      els.saved.append(row);
    }
  }

  // Do its rules still match on the user's visits? Stale rules by id and selector; rules that
  // missed only lately say how far they are from stale.
  function healthLine(s) {
    const line = document.createElement("div");
    const h = s.health;
    if (!h || (!h.stale.length && !h.missing.length && !h.ok)) {
      line.className = "rd-note";
      line.textContent = s.enabled ? `Health: not measured yet — checked on every visit that has ${targetNoun(s.target)}.` : "Health: not checked while off.";
      return line;
    }
    if (h.stale.length) {
      line.className = "sc-problem";
      line.textContent = `⚠ ${h.stale.length} of ${s.rules} rule${s.rules === 1 ? "" : "s"} ${staleNote(s.target)}: ${h.stale.map((r) => `${r.id} ${r.selector}`).join(", ")} — the site probably renamed ${h.stale.length === 1 ? "it" : "them"}.`;
      return line;
    }
    line.className = "rd-note";
    const had = `that had ${targetNoun(s.target)}`;
    const missing = h.missing.map((m) => `${m.id} matched nothing on the last ${m.misses === 1 ? "visit" : `${m.misses} visits`} ${had}`);
    line.textContent = missing.length
      ? `Health: ${missing.join(", ")} (stale after ${STALE_VISITS}).`
      : `Health: every measured rule matched on the last visit ${had}${h.checked ? ` (checked ${new Date(h.checked).toLocaleString()})` : ""}.`;
    return line;
  }

  function render(s) {
    state = s || { draft: null, saved: [], lastTest: null };
    const d = state.draft;
    els.source.textContent = state.tab ? host(state.tab.url) : "";
    els.empty.hidden = !!d;
    els.draft.hidden = !d;
    if (d) {
      const kind = d.scriptId ? "Editing a saved script" : "New script";
      // tabId null: restored after a restart, bound again by the next Pick, test or Script-mode turn on the site.
      const where = d.onTab ? "live in this tab" : d.tabId == null ? `not live in any tab yet — Pick, Re-test or ask the agent on ${host(d.url)}` : `live in its own tab (${host(d.url)})`;
      els.where.textContent = `${kind} · ${where} · covering: ${d.target}${d.dirty ? " · unsaved changes" : ""}`;
      setValue(els.name, d.name);
      setValue(els.match, d.matches.join(" "));
      warnBroad();
      els.sheetError.hidden = !d.sheetError;
      els.sheetError.textContent = d.sheetError ? `Not applied — the browser would drop part of this CSS. ${d.sheetError}` : "";
      renderRules(d, state.lastTest);
      renderPicks(d);
      renderTest(state.lastTest);
      els.css.textContent = d.css || "";
    } else {
      for (const r of rows.values()) r.row.remove();
      rows.clear();
    }
    renderSaved(state.saved || []);
    const hasRules = !!(d && d.rules.length);
    els.retest.disabled = !hasRules || state.testing;
    els.save.disabled = !hasRules || state.testing;
    els.discard.disabled = !d || state.testing;
    els.status.textContent = state.testing
      ? "testing — reloading and scrolling…"
      : state.picking
        ? "picking — click an element in the page (Esc cancels)"
        : "";
  }

  function open() {
    els.error.hidden = true;
    root.hidden = false;
    els.close.focus();
  }

  function close() {
    root.hidden = true;
  }

  return {
    render,
    open,
    close,
    isOpen: () => !root.hidden,
    // The panel covers the chat's error banner, so failures are repeated in here.
    showError(text) {
      els.error.hidden = false;
      els.error.textContent = text;
    },
  };
}

// Never overwrite the field the user is typing in.
function setValue(el, v) {
  if (document.activeElement !== el && el.value !== v) el.value = v;
}

// Two-click confirm for destructive buttons: the first click arms it (and says so), a second
// within CONFIRM_MS acts. With `when`, only while it returns true — otherwise one click acts.
function armed(button, armedLabel, act, when = () => true) {
  const label = button.textContent;
  let timer = null;
  button.addEventListener("click", () => {
    if (!timer && !when()) {
      act();
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
      button.textContent = label;
      button.classList.remove("armed");
      act();
      return;
    }
    button.textContent = armedLabel;
    button.classList.add("armed");
    timer = setTimeout(() => {
      timer = null;
      button.textContent = label;
      button.classList.remove("armed");
    }, CONFIRM_MS);
  });
}

function broadIn(value) {
  return parseMatches(value).filter(isBroadMatch);
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

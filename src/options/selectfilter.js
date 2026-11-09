// Turns a <select> into a dropdown WITH A FILTER ROW INSIDE IT: the closed control looks and
// reads like the select it replaces, and opening it shows a search field above the option list.
//
// Why not something native: a <select> only has prefix type-ahead, which is useless when the
// gateway lists hundreds of models whose ids all begin with the same provider prefix
// (`kilo/z-ai/…`) — you must be able to match the MIDDLE of an id. A <datalist> combobox can,
// but it is a text field, not a selector, and it accepts free text. So the real <select> stays
// in the DOM as the single source of truth — it keeps the options, the value, and the `change`
// event every caller already listens to — and this only draws a different face for it. Anything
// that rebuilds the options (populateModels, Test) needs no change: a MutationObserver re-reads
// the select afterwards.

const OPEN_CLASS = "sf-open";

// Visible text of an option, with its disabled/placeholder nature kept.
function optionLabel(o) {
  return (o.textContent || o.value || "").trim();
}

export function filterableSelect(select) {
  if (!select || select.dataset.sfReady) return null;
  select.dataset.sfReady = "1";

  const wrap = document.createElement("div");
  wrap.className = "sf";
  select.parentNode.insertBefore(wrap, select);
  wrap.append(select);

  const field = document.createElement("button");
  field.type = "button"; // inside a form a bare <button> submits
  field.className = "sf-field";
  field.setAttribute("aria-haspopup", "listbox");
  field.setAttribute("aria-expanded", "false");
  const valueText = document.createElement("span");
  valueText.className = "sf-value";
  const caret = document.createElement("span");
  caret.className = "sf-caret";
  caret.textContent = "▾";
  field.append(valueText, caret);

  const pop = document.createElement("div");
  pop.className = "sf-pop";
  pop.hidden = true;
  const search = document.createElement("input");
  search.type = "text";
  search.className = "sf-search";
  search.placeholder = "filter…";
  search.autocomplete = "off";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "sf-list";
  list.setAttribute("role", "listbox");
  const empty = document.createElement("div");
  empty.className = "sf-empty";
  empty.textContent = "no match";
  empty.hidden = true;
  pop.append(search, list, empty);

  wrap.append(field, pop);

  // The id belongs to the control the user operates, so a <label for=…> click focuses the
  // button and not the hidden select. The select keeps the name for forms/serialisation.
  const id = select.id;
  if (id) {
    select.removeAttribute("id");
    field.id = id;
  }

  let rows = []; // one per <option>, in document order
  let active = -1; // index into the VISIBLE rows, by row.dataset.i

  function visibleRows() {
    return rows.filter((r) => !r.hidden);
  }

  // Rebuild the rows from the select's current options. Called on open and whenever the
  // select's children change, so repopulating it from the gateway needs no extra wiring.
  function build() {
    list.textContent = "";
    rows = Array.from(select.options).map((o, i) => {
      const r = document.createElement("div");
      r.className = "sf-row";
      r.setAttribute("role", "option");
      r.dataset.i = String(i);
      r.textContent = optionLabel(o);
      if (o.disabled) r.setAttribute("aria-disabled", "true");
      list.append(r);
      return r;
    });
    paint();
  }

  // The closed control shows what the select holds.
  function paint() {
    const o = select.selectedOptions[0];
    valueText.textContent = o ? optionLabel(o) : "";
    valueText.classList.toggle("sf-placeholder", !o || !o.value);
    for (const r of rows) {
      r.setAttribute("aria-selected", String(Number(r.dataset.i) === select.selectedIndex));
    }
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const hit = !q || r.textContent.toLowerCase().includes(q);
      r.hidden = !hit;
      if (hit) shown++;
    }
    empty.hidden = shown > 0;
    // Keep a highlight on something reachable: the selected row if it survived the filter,
    // else the first hit, so Enter always has an obvious meaning.
    const vis = visibleRows();
    const sel = vis.find((r) => Number(r.dataset.i) === select.selectedIndex);
    setActive(sel ? rows.indexOf(sel) : vis.length ? rows.indexOf(vis[0]) : -1, false);
  }

  function setActive(i, scroll = true) {
    active = i;
    for (const r of rows) r.classList.toggle("sf-active", rows.indexOf(r) === i);
    if (i >= 0 && scroll) rows[i].scrollIntoView({ block: "nearest" });
  }

  function move(delta) {
    const vis = visibleRows();
    if (!vis.length) return;
    const cur = vis.findIndex((r) => rows.indexOf(r) === active);
    const next = cur < 0 ? (delta > 0 ? 0 : vis.length - 1) : Math.min(vis.length - 1, Math.max(0, cur + delta));
    setActive(rows.indexOf(vis[next]));
  }

  function open() {
    if (!pop.hidden) return;
    build();
    search.value = "";
    applyFilter();
    pop.hidden = false;
    wrap.classList.add(OPEN_CLASS);
    field.setAttribute("aria-expanded", "true");
    if (active >= 0) rows[active].scrollIntoView({ block: "nearest" });
    search.focus();
  }

  function close(refocus = true) {
    if (pop.hidden) return;
    pop.hidden = true;
    wrap.classList.remove(OPEN_CLASS);
    field.setAttribute("aria-expanded", "false");
    if (refocus) field.focus();
  }

  // Picking writes through to the real select and fires `change` from it, so existing
  // listeners (loadVoices) see exactly what a native select would have given them.
  function pick(i) {
    const o = select.options[i];
    if (!o || o.disabled) return;
    const changed = select.selectedIndex !== i;
    select.selectedIndex = i;
    paint();
    close();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  field.addEventListener("click", () => (pop.hidden ? open() : close()));
  field.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  search.addEventListener("input", applyFilter);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(-1e6);
    } else if (e.key === "End") {
      e.preventDefault();
      move(1e6);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  });

  list.addEventListener("mousedown", (e) => {
    // mousedown, not click: the search field is about to lose focus, and a blur-driven close
    // would otherwise pull the row out from under the click.
    const r = e.target.closest(".sf-row");
    if (!r) return;
    e.preventDefault();
    pick(Number(r.dataset.i));
  });
  list.addEventListener("mousemove", (e) => {
    const r = e.target.closest(".sf-row");
    if (r && !r.hidden) setActive(rows.indexOf(r), false);
  });

  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !wrap.contains(e.target)) close(false);
  });

  // Repopulating the select (load, Test) must show through. The observer also covers the
  // value being set right after the options are appended, since it runs after that turn.
  new MutationObserver(() => {
    if (pop.hidden) paint();
    else {
      build();
      applyFilter();
    }
  }).observe(select, { childList: true });

  build();
  return { refresh: build };
}

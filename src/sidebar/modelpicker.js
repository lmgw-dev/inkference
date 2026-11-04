// Model picker. Local models (no prefix) are always listed. Each cloud prefix gets a
// checkbox (default off); ticking one merges that prefix's models in as an <optgroup>.
// A type-to-filter appears once any cloud prefix is enabled (kilo alone is ~336 models).
// The skeleton is built once so the filter input keeps focus across re-renders.

import { formatTokens, formatPricePair } from "../common/util.js";

export function createModelPicker(container, { onModelChange, onPrefixesChange, onRefresh }) {
  container.innerHTML = `
    <div class="mp-row">
      <select class="mp-select"></select>
      <button class="mp-refresh" title="Refresh model list">&#x21bb;</button>
    </div>
    <div class="mp-prefixes"></div>
    <input class="mp-filter" type="search" placeholder="filter models…" hidden />
    <div class="mp-ctx"></div>
    <div class="mp-error" hidden></div>
  `;
  const selectEl = container.querySelector(".mp-select");
  const prefixesEl = container.querySelector(".mp-prefixes");
  const filterEl = container.querySelector(".mp-filter");
  const ctxEl = container.querySelector(".mp-ctx");
  const errorEl = container.querySelector(".mp-error");

  let models = [];
  let prefixes = [];
  let enabled = [];
  let selected = null;
  let recent = [];

  filterEl.addEventListener("input", renderOptions);
  selectEl.addEventListener("change", () => {
    selected = selectEl.value;
    renderCtx();
    onModelChange(selected);
  });
  container.querySelector(".mp-refresh").addEventListener("click", () => onRefresh());

  function byId(id) {
    return models.find((m) => m.id === id) || null;
  }

  function addOption(parent, m) {
    const o = document.createElement("option");
    o.value = m.id;
    const bits = [m.id];
    if (m.contextLength) bits.push(formatTokens(m.contextLength));
    const price = formatPricePair(m.pricePrompt, m.priceCompletion);
    if (price) bits.push(price);
    o.textContent = bits.join("  ·  ");
    parent.append(o);
  }

  function renderOptions() {
    const f = filterEl.value.trim().toLowerCase();
    const match = (m) => !f || m.id.toLowerCase().includes(f);
    const visible = models.filter((m) => {
      if (m.kind === "cloud" && !enabled.includes(m.prefix)) return false;
      return match(m);
    });

    selectEl.textContent = "";

    // Recently used (any prefix, so they're always re-selectable) pinned at top.
    const recentModels = recent.map(byId).filter(Boolean).filter(match);
    if (recentModels.length) {
      const g = document.createElement("optgroup");
      g.label = "Recent";
      recentModels.forEach((m) => addOption(g, m));
      selectEl.append(g);
    }

    const locals = visible.filter((m) => m.kind === "local");
    if (locals.length) {
      const g = document.createElement("optgroup");
      g.label = "Local";
      locals.forEach((m) => addOption(g, m));
      selectEl.append(g);
    }

    for (const p of [...enabled].sort()) {
      const group = visible.filter((m) => m.kind === "cloud" && m.prefix === p);
      if (!group.length) continue;
      const g = document.createElement("optgroup");
      g.label = p;
      group.forEach((m) => addOption(g, m));
      selectEl.append(g);
    }

    // Keep the current selection valid/visible even if its group is filtered/disabled.
    if (selected && !byId(selected)) selected = null;
    if (selected && !selectEl.querySelector(`option[value="${cssEscape(selected)}"]`)) {
      const m = byId(selected);
      if (m) {
        const g = document.createElement("optgroup");
        g.label = "Selected";
        addOption(g, m);
        selectEl.prepend(g);
      }
    }
    if (!selected) {
      const first = selectEl.querySelector("option");
      if (first) selected = first.value;
    }
    if (selected) selectEl.value = selected;
    renderCtx();
  }

  function renderPrefixes() {
    prefixesEl.textContent = "";
    for (const p of prefixes) {
      const count = models.filter((m) => m.kind === "cloud" && m.prefix === p).length;
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = enabled.includes(p);
      cb.addEventListener("change", () => {
        enabled = cb.checked ? [...new Set([...enabled, p])] : enabled.filter((x) => x !== p);
        filterEl.hidden = enabled.length === 0;
        renderOptions();
        onPrefixesChange(enabled);
      });
      label.append(cb, document.createTextNode(` ${p} (${count})`));
      prefixesEl.append(label);
    }
    filterEl.hidden = enabled.length === 0;
  }

  function renderCtx() {
    const m = byId(selected);
    if (!m) {
      ctxEl.textContent = "";
      return;
    }
    const parts = [];
    if (m.contextLength) parts.push(`context: ${formatTokens(m.contextLength)} tokens`);
    const price = formatPricePair(m.pricePrompt, m.priceCompletion);
    if (price) parts.push(price === "free" ? "free" : `${price} per 1M tok (in/out)`);
    ctxEl.textContent = parts.join("  ·  ");
  }

  function renderError(error) {
    if (error) {
      errorEl.hidden = false;
      errorEl.textContent = error + " ";
      const b = document.createElement("button");
      b.textContent = "Retry";
      b.addEventListener("click", () => onRefresh());
      errorEl.append(b);
    } else {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  }

  return {
    update(data) {
      if (data.models) models = data.models;
      if (data.prefixes) prefixes = data.prefixes;
      if (data.enabled) enabled = data.enabled;
      if (data.recent) recent = data.recent;
      if ("selected" in data && data.selected) selected = data.selected;
      renderPrefixes();
      renderOptions();
      renderError(data.error);
    },
    getSelected() {
      return selected;
    },
    getContextLength() {
      const m = byId(selected);
      return (m && m.contextLength) || null;
    },
  };
}

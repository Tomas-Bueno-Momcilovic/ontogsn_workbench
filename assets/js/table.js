import app   from "./queries.js";
import panes from "./panes.js";
import { mountTemplate, resolveEl, fetchRepoText, escapeHtml, termToDisplay } from "./utils.js";

const HTML = new URL("../html/table.html", import.meta.url);
const CSS  = new URL("../css/table.css",  import.meta.url);

const DEFAULT_TABLE_QUERY = "/assets/data/queries/read_graph.sparql";

function bindingsToDisplayRows(bindingRows) {
  const rows = [];
  for (const row of (bindingRows || [])) {
    const out = {};
    for (const [name, cell] of Object.entries(row || {})) {
      out[name] = termToDisplay(cell);
    }
    rows.push(out);
  }
  return rows;
}

function renderTableInto(hostEl, rows) {
  if (!hostEl) return;

  if (!rows || !rows.length) {
    hostEl.innerHTML = "<p>No results.</p>";
    return;
  }

  const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];

  let html =
    '<table class="sparql"><thead><tr>' +
    headers.map(h => `<th>${escapeHtml(h)}</th>`).join("") +
    "</tr></thead><tbody>";

  for (const r of rows) {
    html += "<tr>" +
      headers.map(h => `<td>${escapeHtml(r[h] ?? "")}</td>`).join("") +
      "</tr>";
  }
  html += "</tbody></table>";

  hostEl.innerHTML = html;
}

async function runTableQueryInto(hostEl, queryPath) {
  if (!hostEl) return;

  await app.init();

  const queryText = await fetchRepoText(queryPath, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true
  });

  const bindingRows = await app.selectBindings(queryText);
  const displayRows = bindingsToDisplayRows(bindingRows);

  renderTableInto(hostEl, displayRows);
}

// --- boot ---------------------------------------------------------------

async function initTableView() {
  panes.initLeftTabs?.();

  const root = resolveEl("#results", { required: false, name: "Table view: #results" });
  if (!root) return;

  await mountTemplate(root, { templateUrl: HTML, cssUrl: CSS });

  const contentEl = resolveEl("#table-content", { root, required: false, name: "Table view: #table-content" });
  if (!contentEl) return;

  // Default query on load
  runTableQueryInto(contentEl, DEFAULT_TABLE_QUERY).catch(err => {
    console.error("[TableView] error running default table query", err);
    contentEl.innerHTML =
      `<p class="table-error">Error running default query: ${escapeHtml(err?.message || String(err))}</p>`;
  });

  // Any element with data-table-query drives the table pane
  document.addEventListener("click", (ev) => {
    const el = ev.target instanceof Element
      ? ev.target.closest("[data-table-query]")
      : null;
    if (!el) return;

    ev.preventDefault();

    const queryPath = el.getAttribute("data-table-query");
    if (!queryPath) return;

    panes.activateLeftTab?.("tab-table");

    runTableQueryInto(contentEl, queryPath).catch(err => {
      console.error("[TableView] error running table query", err);
      contentEl.innerHTML =
        `<p class="table-error">Error running query: ${escapeHtml(err?.message || String(err))}</p>`;
    });
  });
}

window.addEventListener("DOMContentLoaded", initTableView);

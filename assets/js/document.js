import app from "./queries.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.js";
import panes from "./panes.js";
import { escapeHtml, fetchText, fetchRepoText, repoHref, resolveEl } from "./utils.js";

marked.setOptions({
  gfm: true,     // GitHub-style markdown (tables, etc.)
  breaks: false, // keep normal line-break behavior
});

// Base renderer so we can fall back to normal link behavior
const baseRenderer = new marked.Renderer();

// Treat links with href like `$roof-rack` as ontology references
marked.use({
  renderer: {
    link(href, title, text) {
      if (href && href.startsWith("$")) {
        const tag = href.slice(1);
        const safeTag = escapeHtml(tag);
        const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
        const safeText = escapeHtml(text);

        return `
          <button
            type="button"
            class="doc-entity"
            data-doc-tag="${safeTag}"${safeTitle}
          >${safeText}</button>
        `;
      }

      // Normal links behave as usual
      return baseRenderer.link.call(this, href, title, text);
    },
  },
});

function resolveDocUrl(relOrAbs) {
  if (!relOrAbs) return null;
  const s = String(relOrAbs).trim();
  if (!s) return null;

  if (s.startsWith("//")) return `${location.protocol}${s}`;

  const url = repoHref(s, { from: import.meta.url, upLevels: 2 });

  const u = new URL(url, location.href);
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error(`Blocked document URL protocol: ${u.protocol}`);
  }
  return u.toString();
}


async function fetchDoc(pathLiteral) {
  const url = resolveDocUrl(pathLiteral);
  if (!url) throw new Error("Empty document path from query.");
  return fetchText(url, { cache: "no-store", bust: true });
}

// Markdown → HTML renderer
function renderMarkdown(mdText) {
  const dirty = marked.parse(mdText);
  return DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
}

let docReq = 0;

async function runDocQueryInto(rootEl, queryPath, varHint) {
  const reqId = ++docReq;

  // (optional) loading UI
  rootEl.innerHTML = "<p>Loading…</p>";

  await app.init();
  const queryText = await fetchRepoText(queryPath, { from: import.meta.url, upLevels: 2, cache: "no-store", bust: true });
  const rows = await app.selectBindings(queryText);

  if (reqId !== docReq) return; // superseded

  const row0 = rows[0];

  // normalize: allow "doc" or "?doc"
  const key = (varHint || "").trim().replace(/^\?/, "");

  // pick a variable: hinted one, otherwise the first binding column
  const chosenKey = (key && row0[key]) ? key : Object.keys(row0)[0];

  const cell = row0[chosenKey];

  // Oxigraph/SPARQL JSON bindings are often objects like { type, value, ... }
  const val = (cell && typeof cell === "object" && "value" in cell) ? cell.value : cell;

  if (!val) throw new Error(`Doc query returned no usable value for ${chosenKey}`);

  const md = await fetchDoc(val);
  if (reqId !== docReq) return;

  const html = renderMarkdown(md);
  rootEl.innerHTML = `<article class="doc-view">${html}</article>`;
}

// --- boot ---------------------------------------------------------------

function initDocView() {
  const root = resolveEl("#doc-root", { required: false, name: "Doc view: #doc-root" });
  if (!root) return;

  root.innerHTML = `
    <div class="doc-view-placeholder">
      <p>Select a document using a button with <code>data-doc-query</code>
      to show it here.</p>
    </div>`;

  // Any element with data-doc-query will trigger loading a Markdown doc
  const leftTabs = document.querySelector('[data-tab-group="left-main"]');
  leftTabs?.addEventListener("click", (ev) => {
    const el = ev.target instanceof Element
      ? ev.target.closest("[data-doc-query]")
      : null;
    if (!el) return;

    ev.preventDefault();

    const queryPath = el.getAttribute("data-doc-query");
    if (!queryPath) return;

    const varHint = el.getAttribute("data-doc-var") || "";

    panes.activateLeftTab("tab-doc");

    runDocQueryInto(root, queryPath, varHint).catch(err => {
      console.error("[DocView] error loading document", err);
      root.innerHTML =
        `<p class="doc-error">Error loading document: ${escapeHtml(err?.message || String(err))}</p>`;
    });
  });

  // Click handler for ontology references inside the document
  root.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element
      ? ev.target.closest(".doc-entity")
      : null;

    if (!target) return;

    ev.preventDefault();

    const tag = target.getAttribute("data-doc-tag");
    if (!tag) return;

    handleDocEntityClick(tag, target).catch(err => {
      console.error("[DocView] error resolving entity tag", tag, err);
    });
  });

  // Close tooltip when clicking anywhere outside entities / tooltip
  document.addEventListener("click", (ev) => {
    if (!(ev.target instanceof Element)) return;
    if (ev.target.closest(".doc-entity") || ev.target.closest(".doc-entity-tooltip")) {
      return; // handled by the other handler
    }
    closeDocTooltip();
  });

}

let currentTooltip = null;

function closeDocTooltip() {
  if (currentTooltip) {
    currentTooltip.remove();
    currentTooltip = null;
  }
}

function buildTooltipHtml(tag, rows) {
  const safeTag = escapeHtml(tag);

  if (!rows || !rows.length) {
    return `
      <div class="doc-entity-tooltip-header">${safeTag}</div>
      <div class="doc-entity-tooltip-body">
        <p>No ontology details found.</p>
      </div>
    `;
  }

  const firstRow = rows[0];
  const entityIri = firstRow.entity?.value || "";

  const labels = [];
  const comments = [];
  const types = [];

  for (const r of rows) {
    const pIri = r.p?.value;
    const o = r.o;
    if (!pIri || !o) continue;

    const val = o.value;
    if (!val) continue;

    if (/label$/i.test(pIri)) {
      labels.push(val);
    } else if (/comment$/i.test(pIri) || /description$/i.test(pIri)) {
      comments.push(val);
    } else if (/type$/i.test(pIri)) {
      types.push(val);
    }
  }

  const uniq = arr => [...new Set(arr)];
  const label = uniq(labels)[0];
  const comment = uniq(comments)[0];
  const typeStr = uniq(types).slice(0, 3).join(", ");

  const mainLabel = label || tag;
  const displayIri = entityIri ? escapeHtml(entityIri) : "";

  let html = `
    <div class="doc-entity-tooltip-header">${escapeHtml(mainLabel)}</div>
    <div class="doc-entity-tooltip-body">
  `;

  if (comment) {
    html += `<p class="doc-entity-tooltip-comment">${escapeHtml(comment)}</p>`;
  }

  if (typeStr) {
    html += `<p class="doc-entity-tooltip-types"><strong>Type:</strong> ${escapeHtml(typeStr)}</p>`;
  }

  if (displayIri) {
    html += `<p class="doc-entity-tooltip-iri">${displayIri}</p>`;
  }

  html += `</div>`;
  return html;
}

function showDocEntityTooltip(targetEl, tag, rows) {
  closeDocTooltip();

  const tooltip = document.createElement("div");
  tooltip.className = "doc-entity-tooltip";
  tooltip.innerHTML = buildTooltipHtml(tag, rows);
  document.body.appendChild(tooltip);

  const rect = targetEl.getBoundingClientRect();
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;

  const top = rect.bottom + scrollY + 4; // a bit under the word
  const left = rect.left + scrollX;

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;

  currentTooltip = tooltip;
}


// Example: resolve a document tag against the ontology
async function handleDocEntityClick(tag, targetEl) {
  await app.init();

  const qPath = "/assets/data/queries/read_documentEntity.sparql";
  let queryText = await fetchRepoText(qPath, { cache: "no-store", bust: true });

  queryText = queryText.replaceAll("__TAG__", JSON.stringify(String(tag)));

  const rows = await app.selectBindings(queryText);

  // Show a tooltip in the document view
  showDocEntityTooltip(targetEl, tag, rows);

  // Still notify the rest of the app if needed
  app.bus?.emit?.("ontogsndoc:entityClick", { tag, rows });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initDocView);
} else {
  initDocView();
}

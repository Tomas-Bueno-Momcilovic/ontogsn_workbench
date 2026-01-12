import app from "./queries.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.js";
import panes from "./panes.js";
import { bus, emitCompat } from "./events.js";
import { mountTemplate, escapeHtml, fetchText, fetchRepoText, repoHref, resolveEl } from "./utils.js";

const CSS  = new URL("../css/document.css",  import.meta.url);

let docRoot = null;

const cssEsc = (s) => (globalThis.CSS?.escape ? globalThis.CSS.escape(String(s)) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));

let _docInit = false;
let _currentDocPath = null;

function clearDocHighlights(root = docRoot) {
  if (!root) return;

  // 1) unwrap generated marks FIRST
  root.querySelectorAll('mark[data-doc-hit-gen="1"]').forEach(m => {
    const t = document.createTextNode(m.textContent || "");
    m.replaceWith(t);
  });

  // 2) remove highlight class/attrs from remaining elements
  root.querySelectorAll(".doc-hit").forEach(el => {
    el.classList.remove("doc-hit");
    el.removeAttribute("data-doc-hit-key");
  });
}

// Highlight a list of elements (adds .doc-hit + optional key)
function highlightEls(els, { key = null, add = false, scroll = true } = {}) {
  if (!docRoot) return [];

  if (!add) clearDocHighlights(docRoot);

  const out = [];
  for (const el of els) {
    if (!el) continue;
    el.classList.add("doc-hit");
    if (key != null) el.setAttribute("data-doc-hit-key", String(key));
    out.push(el);
  }

  if (scroll && out[0]) {
    out[0].scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return out;
}

function highlightBySelector(selector, opts = {}) {
  if (!docRoot || !selector) return [];
  const els = Array.from(docRoot.querySelectorAll(selector));
  return highlightEls(els, opts);
}

function highlightByTag(tag, opts = {}) {
  if (!tag) return [];
  return highlightBySelector(`.doc-entity[data-doc-tag="${cssEsc(tag)}"]`, { key: tag, ...opts });
}

// Highlight a “section”: the heading + following siblings until the next heading
function highlightByHeadingId(headingId, opts = {}) {
  if (!docRoot || !headingId) return [];

  const h = docRoot.querySelector(`#${cssEsc(headingId)}`);
  if (!h) return [];

  const els = [h];

  // include content until next heading
  let n = h.nextElementSibling;
  while (n && !/^H[1-6]$/.test(n.tagName)) {
    els.push(n);
    n = n.nextElementSibling;
  }

  return highlightEls(els, { key: headingId, ...opts });
}

// Highlight first occurrence of exact text by wrapping in <mark>
function highlightByText(text, { key = null, add = false, scroll = true } = {}) {
  if (!docRoot) return [];
  const needle = String(text || "").trim();
  if (!needle) return [];

  if (!add) clearDocHighlights(docRoot);

  const article = docRoot.querySelector(".doc-view");
  if (!article) return [];

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      // skip script/style-like areas if any
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("script, style, noscript")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const hay = node.nodeValue;
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);

    const mark = document.createElement("mark");
    mark.className = "doc-hit";
    mark.setAttribute("data-doc-hit-gen", "1");
    if (key != null) mark.setAttribute("data-doc-hit-key", String(key));

    range.surroundContents(mark);

    if (scroll) mark.scrollIntoView({ block: "center", behavior: "smooth" });
    return [mark];
  }

  return [];
}

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

  if (!rows.length) throw new Error("Doc query returned no rows.");
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

  _currentDocPath = val;
  emitCompat(bus, "doc:loaded", { path: val, queryPath, varHint, mode: "query" });
}

async function openDocPathInto(rootEl, pathLiteral) {
  const reqId = ++docReq;
  rootEl.innerHTML = "<p>Loading…</p>";

  const md = await fetchDoc(pathLiteral);
  if (reqId !== docReq) return;

  const html = renderMarkdown(md);
  rootEl.innerHTML = `<article class="doc-view">${html}</article>`;

  _currentDocPath = pathLiteral;
  emitCompat(bus, "doc:loaded", { path: pathLiteral, mode: "path" });
}


// --- boot ---------------------------------------------------------------

function initDocView() {
  const root = resolveEl("#doc-root", { required: false, name: "Doc view: #doc-root" });
  if (!root || root.dataset.initialised === "1") return;
  root.dataset.initialised = "1";
  if (_docInit) return;
  _docInit = true;
  docRoot = root;
  mountTemplate(root, { cssUrl: CSS });

  root.innerHTML = `
    <div class="doc-view-placeholder">
      <p>Select a document using a button with <code>data-doc-query</code>
      to show it here.</p>
    </div>`;

  // Any element with data-doc-query will trigger loading a Markdown doc
  const leftTabs = document.querySelector('[data-tab-group="left-main"]');
  leftTabs?.addEventListener("click", (ev) => {
    if (ev.detail > 1) return;
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
    if (ev.detail > 1) return;
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

  // --- BUS API: open -------------------------------------------------------

  // Unified open: either {path} OR {queryPath,varHint}
  bus.on("doc:open", (ev) => {
    const { path, queryPath, varHint = "" } = ev.detail || {};
    if (!docRoot) return;

    panes.activateLeftTab("tab-doc");

    if (path) {
      openDocPathInto(docRoot, path).catch(err => console.error("[DocView] doc:open path failed", err));
      return;
    }
    if (queryPath) {
      runDocQueryInto(docRoot, queryPath, varHint).catch(err => console.error("[DocView] doc:open query failed", err));
    }
    closeDocTooltip();
  });

  // --- BUS API: highlights -------------------------------------------------

  bus.on("doc:clearHighlights", () => clearDocHighlights(docRoot));

  bus.on("doc:highlight", (ev) => {
    const {
      selector = null,
      tag = null,
      headingId = null,
      text = null,
      key = null,
      add = false,
      scroll = true
    } = ev.detail || {};

    if (!docRoot) return;

    if (selector) return highlightBySelector(selector, { key, add, scroll });
    if (tag)      return highlightByTag(tag, { key: key ?? tag, add, scroll });
    if (headingId)return highlightByHeadingId(headingId, { key: key ?? headingId, add, scroll });
    if (text)     return highlightByText(text, { key, add, scroll });
  });

  // --- Emit dblclicks on highlighted hits (for bridge to pick up) ----------
  docRoot.addEventListener("dblclick", (ev) => {
    const hit = ev.target instanceof Element ? ev.target.closest(".doc-hit") : null;
    if (!hit) return;

    ev.preventDefault();
    ev.stopPropagation();

    emitCompat(bus, "doc:hitDblClick", {
      key: hit.getAttribute("data-doc-hit-key") || null,
      tag: hit.getAttribute("data-doc-tag") || hit.closest(".doc-entity")?.getAttribute("data-doc-tag") || null,
      text: (hit.textContent || "").trim(),
      docPath: _currentDocPath
    });
  });

  // --- Pane hook (optional but makes it a “regular pane”) ------------------
  bus.on("left:tab", (ev) => {
    const d = ev?.detail || {};
    const isDoc =
      d.view === "doc" ||
      d.paneId === "doc" ||
      d.tabId === "tab-doc";

    if (!isDoc) return;

    if (d.docQuery) {
      runDocQueryInto(docRoot, d.docQuery, d.docVar || "").catch(err => {
        console.error("[DocView] left:tab doc load failed", err);
      });
    }
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
  emitCompat(bus, "ontogsndoc:entityClick", { tag, rows });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initDocView);
} else {
  initDocView();
}

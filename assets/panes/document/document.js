import app from "@core/queries.js";
import { marked } from "@vendor/marked.esm.js";
import DOMPurify from "@vendor/purify.es.js";
import panes from "@core/panes.js";
import { bus, emitCompat } from "@core/events.js";
import {
  mountTemplate,
  escapeHtml,
  fetchText,
  fetchRepoText,
  repoHref,
  resolveEl,
  safeInvoke
} from "@core/utils.js";

const CSS = new URL("./document.css", import.meta.url);

// --- module state ------------------------------------------------------
let docRoot = null;
let _currentDocPath = null;

const cssEsc = (s) =>
  (globalThis.CSS?.escape
    ? globalThis.CSS.escape(String(s))
    : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));

// --- highlight helpers -------------------------------------------------
function clearDocHighlights(root = docRoot) {
  if (!root) return;

  // unwrap generated marks first
  root.querySelectorAll('mark[data-doc-hit-gen="1"]').forEach((m) => {
    const t = document.createTextNode(m.textContent || "");
    m.replaceWith(t);
  });

  // remove highlight classes
  root.querySelectorAll(".doc-hit").forEach((el) => {
    el.classList.remove("doc-hit");
    el.removeAttribute("data-doc-hit-key");
  });
}

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

  if (scroll && out[0]) out[0].scrollIntoView({ block: "center", behavior: "smooth" });
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

function highlightByHeadingId(headingId, opts = {}) {
  if (!docRoot || !headingId) return [];
  const h = docRoot.querySelector(`#${cssEsc(headingId)}`);
  if (!h) return [];

  const els = [h];
  let n = h.nextElementSibling;
  while (n && !/^H[1-6]$/.test(n.tagName)) {
    els.push(n);
    n = n.nextElementSibling;
  }
  return highlightEls(els, { key: headingId, ...opts });
}

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

// --- markdown rendering ------------------------------------------------
marked.setOptions({ gfm: true, breaks: false });
const baseRenderer = new marked.Renderer();

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
      return baseRenderer.link.call(this, href, title, text);
    }
  }
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

function renderMarkdown(mdText) {
  const dirty = marked.parse(mdText);
  return DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
}

let docReq = 0;

async function runDocQueryInto(rootEl, queryPath, varHint) {
  const reqId = ++docReq;
  rootEl.innerHTML = "<p>Loading…</p>";

  await app.init();
  const queryText = await fetchRepoText(queryPath, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true
  });
  const rows = await app.selectBindings(queryText);

  if (reqId !== docReq) return;

  if (!rows.length) throw new Error("Doc query returned no rows.");
  const row0 = rows[0];

  const key = (varHint || "").trim().replace(/^\?/, "");
  const chosenKey = (key && row0[key]) ? key : Object.keys(row0)[0];
  const cell = row0[chosenKey];

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

// --- tooltip -----------------------------------------------------------
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

    if (/label$/i.test(pIri)) labels.push(val);
    else if (/comment$/i.test(pIri) || /description$/i.test(pIri)) comments.push(val);
    else if (/type$/i.test(pIri)) types.push(val);
  }

  const uniq = (arr) => [...new Set(arr)];
  const label = uniq(labels)[0];
  const comment = uniq(comments)[0];
  const typeStr = uniq(types).slice(0, 3).join(", ");

  const mainLabel = label || tag;
  const displayIri = entityIri ? escapeHtml(entityIri) : "";

  let html = `
    <div class="doc-entity-tooltip-header">${escapeHtml(mainLabel)}</div>
    <div class="doc-entity-tooltip-body">
  `;

  if (comment) html += `<p class="doc-entity-tooltip-comment">${escapeHtml(comment)}</p>`;
  if (typeStr) html += `<p class="doc-entity-tooltip-types"><strong>Type:</strong> ${escapeHtml(typeStr)}</p>`;
  if (displayIri) html += `<p class="doc-entity-tooltip-iri">${displayIri}</p>`;

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

  tooltip.style.top = `${rect.bottom + scrollY + 4}px`;
  tooltip.style.left = `${rect.left + scrollX}px`;

  currentTooltip = tooltip;
}

async function handleDocEntityClick(tag, targetEl) {
  await app.init();

  const qPath = "data/queries/read_documentEntity.sparql";
  let queryText = await fetchRepoText(qPath, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true
  });

  queryText = queryText.replaceAll("__TAG__", JSON.stringify(String(tag)));
  const rows = await app.selectBindings(queryText);

  showDocEntityTooltip(targetEl, tag, rows);
  emitCompat(bus, "ontogsndoc:entityClick", { tag, rows });
}

// --- PaneManager lifecycle --------------------------------------------

let _cleanup = null;

// DOM listeners
let _onLeftTabsClick = null;
let _onRootClick = null;
let _onDocDblClick = null;
let _onDocGlobalClick = null;

// bus listeners (if bus supports .off)
let _busDocOpen = null;
let _busClear = null;
let _busHighlight = null;
let _busLeftTab = null;

export async function mount({ root }) {
  docRoot = root;

  await mountTemplate(root, { cssUrl: CSS });

  root.innerHTML = `
    <div class="doc-view-placeholder">
      <p>Select a document using a button with <code>data-doc-query</code> to show it here.</p>
    </div>
  `;

  // Click handler for any tab/button carrying data-doc-query
  const leftTabs = document.querySelector('[data-tab-group="left-main"]');

  _onLeftTabsClick = (ev) => {
    // prevent double-click weirdness
    if (ev?.detail > 1) return;

    const el = ev.target instanceof Element
      ? ev.target.closest("[data-doc-query]")
      : null;
    if (!el) return;

    ev.preventDefault();

    const queryPath = el.getAttribute("data-doc-query");
    if (!queryPath) return;

    const varHint = el.getAttribute("data-doc-var") || "";

    runDocQueryInto(root, queryPath, varHint).catch((err) => {
      console.error("[DocView] error loading document", err);
      root.innerHTML =
        `<p class="doc-error">Error loading document: ${escapeHtml(err?.message || String(err))}</p>`;
    });
  };

  leftTabs?.addEventListener("click", _onLeftTabsClick);

  // Click handler for ontology refs inside the doc view
  _onRootClick = (ev) => {
    const target = ev.target instanceof Element
      ? ev.target.closest(".doc-entity")
      : null;

    if (!target) return;
    ev.preventDefault();

    const tag = target.getAttribute("data-doc-tag");
    if (!tag) return;

    handleDocEntityClick(tag, target).catch((err) => {
      console.error("[DocView] error resolving entity tag", tag, err);
    });
  };
  root.addEventListener("click", _onRootClick);

  // Close tooltip when clicking outside
  _onDocGlobalClick = (ev) => {
    if (!(ev.target instanceof Element)) return;
    if (ev.target.closest(".doc-entity") || ev.target.closest(".doc-entity-tooltip")) return;
    closeDocTooltip();
  };
  document.addEventListener("click", _onDocGlobalClick);

  // Emit dblclick hits
  _onDocDblClick = (ev) => {
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
  };
  root.addEventListener("dblclick", _onDocDblClick);

  // BUS API: open
  _busDocOpen = (ev) => {
    const { path, queryPath, varHint = "" } = ev.detail || {};
    if (!docRoot) return;

    panes.activateLeftTab?.("tab-doc");

    if (path) {
      openDocPathInto(docRoot, path).catch((err) =>
        console.error("[DocView] doc:open path failed", err)
      );
    } else if (queryPath) {
      runDocQueryInto(docRoot, queryPath, varHint).catch((err) =>
        console.error("[DocView] doc:open query failed", err)
      );
    }
    closeDocTooltip();
  };
  bus.on("doc:open", _busDocOpen);

  _busClear = () => clearDocHighlights(docRoot);
  bus.on("doc:clearHighlights", _busClear);

  _busHighlight = (ev) => {
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
    if (tag) return highlightByTag(tag, { key: key ?? tag, add, scroll });
    if (headingId) return highlightByHeadingId(headingId, { key: key ?? headingId, add, scroll });
    if (text) return highlightByText(text, { key, add, scroll });
  };
  bus.on("doc:highlight", _busHighlight);

  // Optional pane hook
  _busLeftTab = (ev) => {
    const d = ev?.detail || {};
    const isDoc =
      d.view === "doc" ||
      d.paneId === "doc-root" ||
      d.tabId === "tab-doc";

    if (!isDoc) return;

    if (d.docQuery) {
      runDocQueryInto(docRoot, d.docQuery, d.docVar || "").catch((err) => {
        console.error("[DocView] left:tab doc load failed", err);
      });
    }
  };
  bus.on("left:tab", _busLeftTab);

  _cleanup = () => {
    closeDocTooltip();

    try { leftTabs?.removeEventListener("click", _onLeftTabsClick); } catch {}
    try { root?.removeEventListener("click", _onRootClick); } catch {}
    try { root?.removeEventListener("dblclick", _onDocDblClick); } catch {}
    try { document.removeEventListener("click", _onDocGlobalClick); } catch {}

    // if bus.off exists, detach (safe)
    safeInvoke(bus, "off", "doc:open", _busDocOpen);
    safeInvoke(bus, "off", "doc:clearHighlights", _busClear);
    safeInvoke(bus, "off", "doc:highlight", _busHighlight);
    safeInvoke(bus, "off", "left:tab", _busLeftTab);

    _onLeftTabsClick = null;
    _onRootClick = null;
    _onDocDblClick = null;
    _onDocGlobalClick = null;

    _busDocOpen = null;
    _busClear = null;
    _busHighlight = null;
    _busLeftTab = null;
  };

  return _cleanup;
}

export async function resume() {
  // nothing mandatory; keep state
}

export async function suspend() {
  // close transient UI bits
  closeDocTooltip();
}

export async function unmount() {
  try { _cleanup?.(); } catch {}
  _cleanup = null;
  docRoot = null;
}

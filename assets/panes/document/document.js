import app from "@core/queries.js";
import { marked } from "@vendor/marked.esm.js";
import DOMPurify from "@vendor/purify.es.js";
import { bus, emitCompat } from "@core/events.js";
import {
  mountTemplate,
  escapeHtml,
  fetchText,
  fetchRepoText,
  repoHref,
  safeInvoke
} from "@core/utils.js";

const CSS = new URL("./document.css", import.meta.url);

// --- module state ------------------------------------------------------
let docRoot = null;
let _currentDocPath = null;
let _pendingHighlight = null;

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
  return highlightBySelector(
    `.doc-entity[data-doc-tag="${cssEsc(tag)}"]`,
    { key: tag, ...opts }
  );
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

function highlightByDocKey(docKey, opts = {}) {
  if (!docRoot || !docKey) return [];

  const key = String(docKey);
  const sel =
    `[data-doc-key="${cssEsc(key)}"], [data-doc-keys~="${cssEsc(key)}"]`;

  const els = Array.from(docRoot.querySelectorAll(sel));
  return highlightEls(els, { key, ...opts });
}

function applyHighlight(detail = {}) {
  const {
    selector = null,
    tag = null,
    headingId = null,
    text = null,
    docKey = null,
    key = null,
    add = false,
    scroll = true
  } = detail;

  if (!docRoot || !docRoot.querySelector(".doc-view")) return [];

  if (selector) return highlightBySelector(selector, { key, add, scroll });
  if (docKey) return highlightByDocKey(docKey, { key: key ?? docKey, add, scroll });
  if (tag) return highlightByTag(tag, { key: key ?? tag, add, scroll });
  if (headingId) return highlightByHeadingId(headingId, { key: key ?? headingId, add, scroll });
  if (text) return highlightByText(text, { key, add, scroll });

  return [];
}

function flushPendingHighlight() {
  if (!_pendingHighlight) return;
  const hits = applyHighlight(_pendingHighlight);
  if (hits.length) _pendingHighlight = null;
}

// --- markdown rendering ------------------------------------------------
marked.setOptions({ gfm: true, breaks: false });
const baseRenderer = new marked.Renderer();

function preprocessDocMarkers(mdText) {
  return String(mdText || "")
    .replace(
      /<!--\s*dl:start\s+([A-Za-z0-9._:-]+)\s*-->/g,
      '\n<div class="doc-dl-boundary" data-doc-boundary="start" data-doc-marker-key="$1" hidden></div>\n'
    )
    .replace(
      /<!--\s*dl:end\s+([A-Za-z0-9._:-]+)\s*-->/g,
      '\n<div class="doc-dl-boundary" data-doc-boundary="end" data-doc-marker-key="$1" hidden></div>\n'
    );
}

marked.use({
  renderer: {
    link(href, title, text) {
      const rawHref = href ? String(href) : "";
      const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";

      // Tooltip-only ontology refs: [cabin]($Cabin)
      if (rawHref.startsWith("$")) {
        const tag = rawHref.slice(1);
        const safeTag = escapeHtml(tag);
        const safeText = escapeHtml(text || "");

        return `
          <button
            type="button"
            class="doc-entity"
            data-doc-tag="${safeTag}"${safeTitle}
          >${safeText}</button>
        `;
      }

      // Paragraph marker: [](#p:car_C1)
      if (rawHref.startsWith("#p:")) {
        const key = escapeHtml(rawHref.slice(3));
        return `
          <span
            class="doc-dl-p-marker"
            data-doc-marker="p"
            data-doc-marker-key="${key}"
          >${text || ""}</span>
        `;
      }

      // Section marker: [](#s:car_G1_2)
      if (rawHref.startsWith("#s:")) {
        const key = escapeHtml(rawHref.slice(3));
        return `
          <span
            class="doc-dl-s-marker"
            data-doc-marker="s"
            data-doc-marker-key="${key}"
          >${text || ""}</span>
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
  const preprocessed = preprocessDocMarkers(mdText);
  const dirty = marked.parse(preprocessed);
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

  decorateDocRanges(rootEl);
  _currentDocPath = val;
  flushPendingHighlight();
  emitCompat(bus, "doc:loaded", { path: val, queryPath, varHint, mode: "query" });
}

async function openDocPathInto(rootEl, pathLiteral) {
  const reqId = ++docReq;
  rootEl.innerHTML = "<p>Loading…</p>";

  const md = await fetchDoc(pathLiteral);
  if (reqId !== docReq) return;

  const html = renderMarkdown(md);
  rootEl.innerHTML = `<article class="doc-view">${html}</article>`;

  decorateDocRanges(rootEl);
  _currentDocPath = pathLiteral;
  flushPendingHighlight();
  emitCompat(bus, "doc:loaded", { path: pathLiteral, mode: "path" });
}

function wrapInlineRange(parent, nodes, keys) {
  const first = nodes.find((n) => n?.parentNode === parent);
  if (!first) return null;

  const uniq = [...new Set((keys || []).map(String).filter(Boolean))];
  if (!uniq.length) return null;

  const span = document.createElement("span");
  span.className = "doc-dl-inline-range";
  span.setAttribute("data-doc-keys", uniq.join(" "));
  if (uniq.length === 1) span.setAttribute("data-doc-key", uniq[0]);

  parent.insertBefore(span, first);

  for (const n of nodes) {
    if (n?.parentNode === parent) span.appendChild(n);
  }

  return span;
}

function wrapBlockRange(parent, firstNode, stopNode, key, cls = "doc-dl-block-range") {
  if (!parent || !firstNode || firstNode === stopNode || !key) return null;

  const box = document.createElement("div");
  box.className = cls;
  box.setAttribute("data-doc-key", String(key));
  parent.insertBefore(box, firstNode);

  let n = firstNode;
  while (n && n !== stopNode) {
    const next = n.nextSibling;
    box.appendChild(n);
    n = next;
  }

  return box;
}

function decorateBlockRanges(root = docRoot) {
  const starts = Array.from(
    root.querySelectorAll('.doc-dl-boundary[data-doc-boundary="start"]')
  );

  for (const start of starts) {
    if (!start.isConnected) continue;

    const key = start.getAttribute("data-doc-marker-key");
    const parent = start.parentNode;
    if (!(parent instanceof Element) || !key) continue;

    let end = start.nextSibling;
    while (end) {
      if (
        end.nodeType === Node.ELEMENT_NODE &&
        end.matches('.doc-dl-boundary[data-doc-boundary="end"]') &&
        end.getAttribute("data-doc-marker-key") === key
      ) {
        break;
      }
      end = end.nextSibling;
    }

    const firstNode = start.nextSibling;
    start.remove();

    if (!end) continue;
    if (firstNode && firstNode !== end) {
      wrapBlockRange(parent, firstNode, end, key, "doc-dl-block-range");
    }
    end.remove();
  }
}

function findSectionStopNode(heading) {
  const level = Number(heading.tagName.slice(1));
  let n = heading.nextSibling;

  while (n) {
    if (
      n.nodeType === Node.ELEMENT_NODE &&
      /^H[1-6]$/.test(n.tagName)
    ) {
      const nextLevel = Number(n.tagName.slice(1));
      if (nextLevel <= level) return n;
    }
    n = n.nextSibling;
  }

  return null;
}

function decorateSectionRanges(root = docRoot) {
  const markers = Array.from(root.querySelectorAll(".doc-dl-s-marker"));

  for (const marker of markers) {
    if (!marker.isConnected) continue;

    const key = marker.getAttribute("data-doc-marker-key");
    const heading = marker.closest("h1,h2,h3,h4,h5,h6");
    if (!key || !heading) continue;

    const parent = heading.parentNode;
    if (!(parent instanceof Element)) continue;

    const stopNode = findSectionStopNode(heading);
    wrapBlockRange(parent, heading, stopNode, key, "doc-dl-section-range");
  }
}

function isWhitespaceText(node) {
  return node?.nodeType === Node.TEXT_NODE && !String(node.nodeValue || "").trim();
}

function decorateParagraphRanges(root = docRoot) {
  const parents = new Set(
    Array.from(root.querySelectorAll(".doc-dl-p-marker"))
      .map((el) => el.parentElement)
      .filter(Boolean)
  );

  for (const parent of parents) {
    const snapshot = Array.from(parent.childNodes);

    let pendingKeys = [];
    let segmentNodes = [];
    let hasRealContent = false;

    const flush = () => {
      if (pendingKeys.length && segmentNodes.length && hasRealContent) {
        wrapInlineRange(parent, segmentNodes, pendingKeys);
      }
      pendingKeys = [];
      segmentNodes = [];
      hasRealContent = false;
    };

    for (const node of snapshot) {
      if (!node.isConnected || node.parentNode !== parent) continue;

      const isMarker =
        node.nodeType === Node.ELEMENT_NODE &&
        node.classList?.contains("doc-dl-p-marker");

      const isBreak =
        node.nodeType === Node.ELEMENT_NODE &&
        node.tagName === "BR";

      if (isMarker) {
        const key = node.getAttribute("data-doc-marker-key");

        // If content has already started, this marker begins the next chunk
        if (hasRealContent) flush();

        if (key) pendingKeys.push(key);
        segmentNodes.push(node);
        if (String(node.textContent || "").trim()) hasRealContent = true;
        continue;
      }

      if (isBreak) {
        flush();
        continue;
      }

      if (!pendingKeys.length) continue;

      segmentNodes.push(node);
      if (!isWhitespaceText(node)) hasRealContent = true;
    }

    flush();
  }
}

function decorateDocRanges(root = docRoot) {
  if (!root) return;
  decorateBlockRanges(root);
  decorateSectionRanges(root);
  decorateParagraphRanges(root);
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
let _onRootClick = null;
let _onDocDblClick = null;
let _onDocGlobalClick = null;

// bus listeners
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
    const detail = ev.detail || {};
    const hits = applyHighlight(detail);
    if (!hits.length) _pendingHighlight = detail;
  };
  bus.on("doc:highlight", _busHighlight);

  _busLeftTab = (ev) => {
    const d = ev?.detail || {};
    const isDoc =
      d.view === "doc" ||
      d.paneId === "doc-root" ||
      d.tabId === "tab-doc";

    if (!isDoc) return;
    if (!d.docQuery) return;

    runDocQueryInto(docRoot, d.docQuery, d.docVar || "").catch((err) => {
      console.error("[DocView] left:tab doc load failed", err);
    });
  };
  bus.on("left:tab", _busLeftTab);

  _cleanup = () => {
    closeDocTooltip();

    try { root?.removeEventListener("click", _onRootClick); } catch {}
    try { root?.removeEventListener("dblclick", _onDocDblClick); } catch {}
    try { document.removeEventListener("click", _onDocGlobalClick); } catch {}

    safeInvoke(bus, "off", "doc:open", _busDocOpen);
    safeInvoke(bus, "off", "doc:clearHighlights", _busClear);
    safeInvoke(bus, "off", "doc:highlight", _busHighlight);
    safeInvoke(bus, "off", "left:tab", _busLeftTab);

    _onRootClick = null;
    _onDocDblClick = null;
    _onDocGlobalClick = null;

    _busDocOpen = null;
    _busClear = null;
    _busHighlight = null;
    _busLeftTab = null;

    _pendingHighlight = null;
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
  _currentDocPath = null;
  _pendingHighlight = null;
}
import app from "./queries.js";
import panes from "./panes.js";
import { bus } from "./events.js";
import {
  mountTemplate,
  resolveEl,
  fetchRepoText,
  shortenIri,
  safeInvoke
} from "./utils.js";

const HTML = new URL("../html/checklist.html", import.meta.url);
const CSS  = new URL("../css/checklist.css",  import.meta.url);

const GOALS_QUERY_PATH = "/assets/data/queries/read_goalsForChecklist.sparql";

// NOTE: Your current index.html clears localStorage on load.
// If you want persistence across reloads, remove that dev-only localStorage.clear().
const STORAGE_KEY = "ontogsn_checklist_done_v1";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state ?? {}));
  } catch { /* ignore */ }
}

function asBoolText(v) {
  if (v == null) return "";
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "false") return s;
  return String(v);
}

function pickText(row, name, fallback = "") {
  const cell = row?.[name];
  // app.selectBindings returns { value, term }
  return cell?.value ?? fallback;
}

function normalizeItem(row) {
  const goal = pickText(row, "goal", "");
  const id   = pickText(row, "id", "") || shortenIri(goal);
  const stmt = pickText(row, "stmt", "") || "";
  const valid = asBoolText(pickText(row, "valid", ""));
  const undeveloped = asBoolText(pickText(row, "undeveloped", ""));
  const supportedBy = pickText(row, "supportedBy", "");
  const modules = pickText(row, "modules", "");

  const displayId = `${(modules && modules.trim()) ? modules.trim() : "—"}: ${id}`;

  return { goal, id, displayId, modules, stmt, valid, undeveloped, supportedBy };
}


function matchesFilter(item, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    item.displayId.toLowerCase().includes(s) ||
    item.modules.toLowerCase().includes(s) ||
    item.id.toLowerCase().includes(s) ||
    item.stmt.toLowerCase().includes(s) ||
    item.goal.toLowerCase().includes(s) ||
    (item.supportedBy || "").toLowerCase().includes(s)
  );
}


function emitSelect(goalIri) {
  // Generic “selection” event you can hook into in graph.js later if you want.
  safeInvoke(bus, "emit", "checklist:select", { iri: goalIri });
  window.dispatchEvent(new CustomEvent("checklist:select", { detail: { iri: goalIri } }));
}

function renderList(listEl, emptyEl, statsEl, items, state, filterText) {
  const filtered = (items || []).filter(it => matchesFilter(it, filterText));

  const total = filtered.length;
  const doneCount = filtered.reduce((n, it) => n + (state[it.goal] ? 1 : 0), 0);

  if (statsEl) {
    statsEl.textContent = total
      ? `${doneCount} / ${total} done`
      : `0 / 0 done`;
  }

  if (!listEl) return;

  listEl.replaceChildren();

  if (!filtered.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const frag = document.createDocumentFragment();

  for (const it of filtered) {
    const row = document.createElement("div");
    row.className = "chk-row";
    row.setAttribute("role", "listitem");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!state[it.goal];
    cb.addEventListener("change", () => {
      state[it.goal] = cb.checked;
      saveState(state);
      // update stats quickly (no full re-query)
      renderList(listEl, emptyEl, statsEl, items, state, filterText);
    });

    const id = document.createElement("div");
    id.className = "chk-id";
    id.textContent = it.displayId || (it.id || shortenIri(it.goal));

    const main = document.createElement("div");
    main.className = "chk-main";

    const stmt = document.createElement("div");
    stmt.className = "chk-stmt";
    stmt.textContent = it.stmt || "";

    const meta = document.createElement("div");
    meta.className = "chk-meta";

    // lightweight badges
    if (it.valid) {
      const b = document.createElement("span");
      b.className = "chk-badge";
      b.textContent = `valid: ${it.valid}`;
      meta.appendChild(b);
    }
    if (it.undeveloped) {
      const b = document.createElement("span");
      b.className = "chk-badge";
      b.textContent = `undeveloped: ${it.undeveloped}`;
      meta.appendChild(b);
    }
    if (it.supportedBy) {
      const b = document.createElement("span");
      b.className = "chk-badge";
      b.textContent = `supportedBy: ${it.supportedBy}`;
      meta.appendChild(b);
    }

    if (meta.childNodes.length) main.appendChild(meta);
    main.insertBefore(stmt, meta.childNodes.length ? meta : null);

    // Clicking the row (except checkbox) emits a selection event
    row.addEventListener("click", (ev) => {
      if (ev.target === cb) return;
      emitSelect(it.goal);
    });

    row.appendChild(cb);
    row.appendChild(id);
    row.appendChild(main);

    frag.appendChild(row);
  }

  listEl.appendChild(frag);
}

async function queryGoals() {
  await app.init();
  const queryText = await fetchRepoText(GOALS_QUERY_PATH, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true
  });
  const bindings = await app.selectBindings(queryText);
  return (bindings || []).map(normalizeItem).filter(x => x.goal);
}

async function initChecklistView() {
  panes.initLeftTabs?.();

  const root = resolveEl("#checklist-root", { required: false, name: "Checklist: #checklist-root" });
  if (!root) return;

  await mountTemplate(root, { templateUrl: HTML, cssUrl: CSS });

  const listEl  = resolveEl("#checklist-list",  { root, required: false });
  const emptyEl = resolveEl("#checklist-empty", { root, required: false });
  const statsEl = resolveEl("#checklist-stats", { root, required: false });

  const searchEl  = resolveEl("#checklist-search",  { root, required: false });
  const refreshEl = resolveEl("#checklist-refresh", { root, required: false });
  const clearEl   = resolveEl("#checklist-clear",   { root, required: false });

  let items = [];
  let state = loadState();

  const rerender = () => {
    const q = (searchEl?.value ?? "").trim();
    renderList(listEl, emptyEl, statsEl, items, state, q);
  };

  const refresh = async () => {
    try {
      items = await queryGoals();
      state = loadState(); // re-load in case other tabs changed it
      rerender();
    } catch (e) {
      console.error("[Checklist] refresh failed:", e);
      if (statsEl) statsEl.textContent = `Error: ${e?.message || String(e)}`;
      if (listEl) listEl.replaceChildren();
      if (emptyEl) emptyEl.hidden = true;
    }
  };

  refreshEl?.addEventListener("click", (ev) => {
    ev.preventDefault();
    refresh();
  });

  clearEl?.addEventListener("click", (ev) => {
    ev.preventDefault();
    // clear only the goals currently in the checklist (not global keys)
    for (const it of items) state[it.goal] = false;
    saveState(state);
    rerender();
  });

  searchEl?.addEventListener("input", () => rerender());

  // Refresh whenever the Checklist tab becomes active
  bus.on("left:tab", (e) => {
    const paneId = e?.detail?.paneId;
    if (paneId === "checklist-root") refresh();
  });

  // Initial load
  refresh();
}

window.addEventListener("DOMContentLoaded", initChecklistView);

import app from "./queries.js";
import panes from "./panes.js";
import { bus } from "./events.js";
import {
  mountTemplate,
  resolveEl,
  safeInvoke
} from "./utils.js";

const HTML = new URL("../html/terminal.html", import.meta.url);
const CSS  = new URL("../css/terminal.css",  import.meta.url);


// Query paths (these files will be added below)
const Q_ALL_GOALS     = "/assets/data/queries/read_all_goals.sparql";
const Q_ALL_SOLUTIONS = "/assets/data/queries/read_all_solutions.sparql";

// Optional built-ins (already exist in your repo)
const Q_ALL_NODES     = "/assets/data/queries/read_all_nodes.sparql";
const Q_LIST_MODULES  = "/assets/data/queries/list_modules.sparql";

const HISTORY_KEY = "ontogsn_terminal_history_v1";
const MAX_HISTORY = 200;
const MAX_OUT_LINES = 2000;

let _termShellEl = null;
let _busyExec = 0;

function setBusy(on) {
  if (!_termShellEl) return;
  _termShellEl.classList.toggle("is-busy", !!on);
  if (_inputEl) _inputEl.disabled = !!on;
}

function trimOutput() {
  if (!_outEl) return;
  const extra = _outEl.children.length - MAX_OUT_LINES;
  if (extra <= 0) return;

  const n = Math.min(extra, 100);
  for (let i = 0; i < n; i++) _outEl.removeChild(_outEl.firstElementChild);
}


let _init = false;
let _root = null;

let _outEl = null;
let _inputEl = null;

let _history = [];
let _histIdx = -1;

let _execSeq = 0;

// ---------- output helpers -------------------------------------------------

function scrollToBottom() {
  if (!_outEl) return;
  _outEl.scrollTop = _outEl.scrollHeight;
}

function appendLine(text, cls = "") {
  if (!_outEl) return;
  const div = document.createElement("div");
  div.className = `terminal-line ${cls}`.trim();
  div.textContent = String(text ?? "");
  _outEl.appendChild(div);

  trimOutput();
  scrollToBottom();
}


function appendBlank() {
  appendLine("");
}

function clearOutput() {
  if (_outEl) _outEl.replaceChildren();
}

function printPrompted(cmd) {
  appendLine(`ontogsn> ${cmd}`, "in");
}

function printOk(msg) {
  appendLine(msg, "ok");
}

function printErr(msg) {
  appendLine(msg, "err");
}

function printMeta(msg) {
  appendLine(msg, "meta");
}

// ---------- history --------------------------------------------------------

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(_history.slice(-MAX_HISTORY)));
  } catch {
    // ignore
  }
}

function pushHistory(cmd) {
  const c = String(cmd ?? "").trim();
  if (!c) return;

  // avoid duplicate consecutive
  if (_history.length && _history[_history.length - 1] === c) return;

  _history.push(c);
  if (_history.length > MAX_HISTORY) _history = _history.slice(-MAX_HISTORY);

  _histIdx = -1;
  saveHistory();
}

// ---------- formatting -----------------------------------------------------

function formatRowsAsTable(rows, {
  maxRows = 80,
  maxColWidth = 70
} = {}) {
  if (!rows?.length) return ["(no rows)"];

  const shown = rows.slice(0, maxRows);
  const cols = Object.keys(shown[0] ?? {});
  if (!cols.length) return ["(no columns)"];

  const widths = {};
  for (const c of cols) widths[c] = Math.min(maxColWidth, Math.max(c.length, 3));

  for (const r of shown) {
    for (const c of cols) {
      const v = r?.[c] == null ? "" : String(r[c]);
      widths[c] = Math.min(maxColWidth, Math.max(widths[c], v.length));
    }
  }

  const pad = (s, w) => {
    const t = String(s ?? "");
    if (t.length >= w) return t.slice(0, w - 1) + "…";
    return t + " ".repeat(w - t.length);
  };

  const header = cols.map(c => pad(c, widths[c])).join("  ");
  const sep    = cols.map(c => "-".repeat(widths[c])).join("  ");

  const lines = [header, sep];

  for (const r of shown) {
    const line = cols.map(c => pad(r?.[c] ?? "", widths[c])).join("  ");
    lines.push(line);
  }

  if (rows.length > shown.length) {
    lines.push(`… (${rows.length - shown.length} more row(s) not shown)`);
  }

  return lines;
}

// For our “goals/solutions” queries we print a nicer list
function formatGoalLike(rows, idKey, labelKey, moduleKey) {
  if (!rows?.length) return ["(no results)"];

  const out = [];
  for (const r of rows) {
    const id = (r?.[idKey] ?? "").toString().trim();
    const label = (r?.[labelKey] ?? "").toString().trim();
    const mod = (r?.[moduleKey] ?? "").toString().trim();

    const left = mod ? `${mod}: ${id}` : id;
    out.push(label ? `${left} — ${label}` : left);
  }
  return out;
}

// ---------- SPARQL runners -------------------------------------------------

async function runQueryPath(path, { pretty = null } = {}) {
  await app.init();

  const myExec = ++_execSeq;
  _busyExec = myExec;
  setBusy(true);

  try {
    const t0 = performance.now();
    const res = await app.runPath(path, { cache: "no-store", bust: true });
    const dt = performance.now() - t0;

    if (myExec !== _execSeq) return;

    if (res.kind === "update") {
      printOk(`OK (update) — ${dt.toFixed(1)} ms`);
      return;
    }

    const rows = res.rows || [];
    printMeta(`rows: ${rows.length} — ${dt.toFixed(1)} ms`);

    const lines = (typeof pretty === "function")
      ? pretty(rows)
      : formatRowsAsTable(rows);

    for (const ln of lines) appendLine(ln);
  } finally {
    if (_busyExec === myExec) setBusy(false);
  }
}

async function runQueryText(text) {
  await app.init();

  const myExec = ++_execSeq;
  _busyExec = myExec;
  setBusy(true);

  try {
    const t0 = performance.now();
    const res = await app.runText(text, { source: "terminal:inline" });
    const dt = performance.now() - t0;

    if (myExec !== _execSeq) return;

    if (res.kind === "update") {
      printOk(`OK (update) — ${dt.toFixed(1)} ms`);
      return;
    }

    const rows = res.rows || [];
    printMeta(`rows: ${rows.length} — ${dt.toFixed(1)} ms`);

    const lines = formatRowsAsTable(rows);
    for (const ln of lines) appendLine(ln);
  } finally {
    if (_busyExec === myExec) setBusy(false);
  }
}

// ---------- command router -------------------------------------------------

function normalizeCmd(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function showHelp() {
  appendLine("Commands:", "meta");
  appendLine("  help                              show this help");
  appendLine("  clear                             clear console output");
  appendLine("  history                           show recent commands");
  appendLine("  read all goals                    list all Goal nodes");
  appendLine("  read all solutions                list all Solution nodes");
  appendLine("  read all nodes                    run read_all_nodes.sparql");
  appendLine("  list modules                      run list_modules.sparql");
  appendLine("  run path <queryPath>              run a SPARQL file (repo path)");
  appendLine("  run <SPARQL...>                   run inline SPARQL (SELECT only recommended)");
  appendLine("  open doc <repoPathOrUrl>          open a markdown doc in Document pane");
  appendBlank();
  appendLine('Example:', "meta");
  appendLine("  read all goals");
  appendLine("  run path /assets/data/queries/read_all_relations.sparql");
}

function showHistory() {
  const last = _history.slice(-30);
  if (!last.length) {
    appendLine("(history empty)", "meta");
    return;
  }
  appendLine("History:", "meta");
  for (const c of last) appendLine(`  ${c}`);
}

async function execCommand(raw) {
  const cmd = String(raw ?? "").trim();
  if (!cmd) return;

  printPrompted(cmd);
  pushHistory(cmd);

  const n = normalizeCmd(cmd);

  try {
    if (n === "help" || n === "?") {
      showHelp();
      return;
    }

    if (n === "clear") {
      clearOutput();
      return;
    }

    if (n === "history") {
      showHistory();
      return;
    }

    if (n === "read all goals") {
      await runQueryPath(Q_ALL_GOALS, {
        pretty: (rows) => formatGoalLike(rows, "goalId", "label", "moduleId")
      });
      return;
    }

    if (n === "read all solutions") {
      await runQueryPath(Q_ALL_SOLUTIONS, {
        pretty: (rows) => formatGoalLike(rows, "solutionId", "label", "moduleId")
      });
      return;
    }

    if (n === "read all nodes") {
      await runQueryPath(Q_ALL_NODES);
      return;
    }

    if (n === "list modules") {
      await runQueryPath(Q_LIST_MODULES);
      return;
    }

    if (n.startsWith("run path ")) {
      const path = cmd.slice("run path ".length).trim();
      if (!path) throw new Error("Missing queryPath. Example: run path /assets/data/queries/read_all_nodes.sparql");
      await runQueryPath(path);
      return;
    }

    if (n.startsWith("run ")) {
      const sparql = cmd.slice("run ".length).trim();
      if (!sparql) throw new Error("Missing SPARQL text. Example: run SELECT * WHERE { ?s ?p ?o } LIMIT 10");
      await runQueryText(sparql);
      return;
    }

    if (n.startsWith("open doc ")) {
      const path = cmd.slice("open doc ".length).trim();
      if (!path) throw new Error("Missing doc path. Example: open doc /assets/docs/readme.md");

      // Activate Document tab and open the doc
      panes.activateLeftTab("tab-doc");
      safeInvoke(bus, "emit", "doc:open", { path });
      printOk("Opened document.");
      return;
    }

    printErr(`Unknown command: ${cmd}`);
    appendLine(`Type "help" to see available commands.`, "meta");
  } catch (e) {
    printErr(e?.message || String(e));
  }
}

const COMMANDS = [
  "help",
  "clear",
  "history",
  "read all goals",
  "read all solutions",
  "read all nodes",
  "list modules",
  "run path ",
  "run ",
  "open doc "
];

function completeInput() {
  const v = String(_inputEl?.value ?? "");
  const n = normalizeCmd(v);

  if (!n) {
    _inputEl.value = "help";
    return;
  }

  const hits = COMMANDS.filter(c => c.startsWith(n));
  if (hits.length === 1) {
    _inputEl.value = hits[0];
    _inputEl.setSelectionRange(_inputEl.value.length, _inputEl.value.length);
  } else if (hits.length > 1) {
    printMeta("Suggestions:");
    for (const h of hits) appendLine(`  ${h}`, "meta");
  }
}


// ---------- UI boot --------------------------------------------------------

function wireUI(root) {
  _outEl = resolveEl("#term-out", { root });
  _inputEl = resolveEl("#term-input", { root });
  _termShellEl = resolveEl(".terminal", { root });

  resolveEl("#term-help", { root }).addEventListener("click", () => {
    execCommand("help");
    _inputEl?.focus();
  });

  resolveEl("#term-clear", { root }).addEventListener("click", () => {
    execCommand("clear");
    _inputEl?.focus();
  });

  _inputEl.addEventListener("keydown", (ev) => {
    // Ctrl+L = clear (classic terminal)
    if (ev.ctrlKey && (ev.key === "l" || ev.key === "L")) {
      ev.preventDefault();
      execCommand("clear");
      return;
    }

    // ESC = clear input
    if (ev.key === "Escape") {
      ev.preventDefault();
      _inputEl.value = "";
      _histIdx = -1;
      return;
    }

    // TAB = autocomplete
    if (ev.key === "Tab") {
      ev.preventDefault();
      completeInput();
      return;
    }

    // History navigation
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!_history.length) return;

      if (_histIdx < 0) _histIdx = _history.length - 1;
      else _histIdx = Math.max(0, _histIdx - 1);

      _inputEl.value = _history[_histIdx] ?? "";
      _inputEl.setSelectionRange(_inputEl.value.length, _inputEl.value.length);
      return;
    }

    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (!_history.length) return;

      if (_histIdx < 0) return;

      _histIdx = Math.min(_history.length, _histIdx + 1);
      if (_histIdx >= _history.length) {
        _histIdx = -1;
        _inputEl.value = "";
        return;
      }

      _inputEl.value = _history[_histIdx] ?? "";
      _inputEl.setSelectionRange(_inputEl.value.length, _inputEl.value.length);
      return;
    }

    // Execute on Enter
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = _inputEl.value;
      _inputEl.value = "";
      _histIdx = -1;
      execCommand(v);
      return;
    }
  });

  // Friendly hello
  appendLine("OntoGSN Terminal ready.", "meta");
  appendLine('Type "help" to see commands.', "meta");
}


async function initTerminal() {
  const root = resolveEl("#terminal-root", { required: false, name: "Terminal: #terminal-root" });
  if (!root || root.dataset.initialised === "1") return;

  root.dataset.initialised = "1";
  if (_init) return;
  _init = true;

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS
  });

  _history = loadHistory();
  wireUI(root);

  // Focus input when the pane becomes active
  bus.on("left:tab", (ev) => {
    const d = ev?.detail || {};
    const isTerm =
      d.view === "terminal" ||
      d.paneId === "terminal-root" ||
      d.tabId === "tab-terminal";

    if (!isTerm) return;
    setTimeout(() => _inputEl?.focus(), 0);
  });

  // Optional bus API: other panes can print into terminal
  bus.on("terminal:print", (ev) => {
    const { text = "", kind = "meta" } = ev.detail || {};
    appendLine(String(text), kind);
  });

  bus.on("terminal:run", (ev) => {
    const { command = "" } = ev.detail || {};
    execCommand(String(command));
  });
}


if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initTerminal);
} else {
  initTerminal();
}

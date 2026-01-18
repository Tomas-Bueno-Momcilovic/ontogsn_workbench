import app from "@core/queries.js";
import panes from "@core/panes.js";
import { bus } from "@core/events.js";
import { mountTemplate, resolveEl, safeInvoke } from "@core/utils.js";

const HTML = new URL("./terminal.html", import.meta.url);
const CSS  = new URL("./terminal.css",  import.meta.url);

// Query paths (these files will be added below)
const Q_ALL_GOALS     = "data/queries/read_all_goals.sparql";
const Q_ALL_SOLUTIONS = "data/queries/read_all_solutions.sparql";

// Optional built-ins (already exist in your repo)
const Q_ALL_NODES     = "data/queries/read_all_nodes.sparql";
const Q_LIST_MODULES  = "data/queries/list_modules.sparql";

const HISTORY_KEY  = "ontogsn_terminal_history_v1";
const MAX_HISTORY  = 200;
const MAX_OUT_LINES = 2000;

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

class TerminalApp {
  constructor({ panes, bus, app } = {}) {
    this.panes = panes;
    this.bus = bus;
    this.app = app;

    this.rootEl = null;

    this.termShellEl = null;
    this.outEl = null;
    this.inputEl = null;

    this._ac = null;          // AbortController for DOM listeners
    this._unsubs = [];        // bus unsub functions

    this._history = [];
    this._histIdx = -1;

    this._execSeq = 0;
    this._busyExec = 0;
  }

  async init({ root } = {}) {
    // PaneManager passes root. Fallbacks are safe if used standalone.
    this.rootEl =
      root
      ?? resolveEl("#terminal-root", { required: true, name: "Terminal root (#terminal-root)" });

    await mountTemplate(this.rootEl, {
      templateUrl: HTML,
      cssUrl: CSS,
      cache: "no-store",
      bust: true
    });

    this._history = this._loadHistory();

    // rewire fresh (important for remounts)
    this._ac?.abort?.();
    this._ac = new AbortController();

    this._wireUI({ signal: this._ac.signal });
    this._wireBus();

    // friendly hello
    this.appendLine("OntoGSN Terminal ready.", "meta");
    this.appendLine('Type "help" to see commands.', "meta");
  }

  destroy() {
    // Abort DOM listeners
    try { this._ac?.abort?.(); } catch {}
    this._ac = null;

    // Unsubscribe bus listeners
    this._unsubs.forEach(off => { try { off?.(); } catch {} });
    this._unsubs = [];

    // Clear refs
    this.termShellEl = null;
    this.outEl = null;
    this.inputEl = null;
    this.rootEl = null;
  }

  focus() {
    if (!this.inputEl) return;
    requestAnimationFrame(() => {
      try { this.inputEl?.focus?.(); } catch {}
    });
  }

  // ---------- busy + output helpers ---------------------------------------

  setBusy(on) {
    if (!this.termShellEl) return;
    this.termShellEl.classList.toggle("is-busy", !!on);
    if (this.inputEl) this.inputEl.disabled = !!on;
  }

  trimOutput() {
    if (!this.outEl) return;
    const extra = this.outEl.children.length - MAX_OUT_LINES;
    if (extra <= 0) return;

    const n = Math.min(extra, 100);
    for (let i = 0; i < n; i++) {
      this.outEl.removeChild(this.outEl.firstElementChild);
    }
  }

  scrollToBottom() {
    if (!this.outEl) return;
    this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  appendLine(text, cls = "") {
    if (!this.outEl) return;
    const div = document.createElement("div");
    div.className = `terminal-line ${cls}`.trim();
    div.textContent = String(text ?? "");
    this.outEl.appendChild(div);

    this.trimOutput();
    this.scrollToBottom();
  }

  appendBlank() {
    this.appendLine("");
  }

  clearOutput() {
    if (this.outEl) this.outEl.replaceChildren();
  }

  printPrompted(cmd) {
    this.appendLine(`ontogsn> ${cmd}`, "in");
  }
  printOk(msg) {
    this.appendLine(msg, "ok");
  }
  printErr(msg) {
    this.appendLine(msg, "err");
  }
  printMeta(msg) {
    this.appendLine(msg, "meta");
  }

  // ---------- history ------------------------------------------------------

  _loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this._history.slice(-MAX_HISTORY)));
    } catch {
      // ignore
    }
  }

  _pushHistory(cmd) {
    const c = String(cmd ?? "").trim();
    if (!c) return;

    // avoid duplicate consecutive
    if (this._history.length && this._history[this._history.length - 1] === c) return;

    this._history.push(c);
    if (this._history.length > MAX_HISTORY) this._history = this._history.slice(-MAX_HISTORY);

    this._histIdx = -1;
    this._saveHistory();
  }

  // ---------- formatting ---------------------------------------------------

  formatRowsAsTable(rows, {
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

  formatGoalLike(rows, idKey, labelKey, moduleKey) {
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

  // ---------- SPARQL runners ----------------------------------------------

  async _runAppPath(path) {
    if (typeof this.app.runPath === "function") {
      return this.app.runPath(path, { cache: "no-store", bust: true });
    }
    // fallback
    return this.app.run(String(path), null, { noTable: true });
  }

  async _runAppText(text) {
    if (typeof this.app.runText === "function") {
      return this.app.runText(text, { source: "terminal:inline" });
    }
    // fallback
    return this.app.run(String(text), null, { noTable: true });
  }

  async runQueryPath(path, { pretty = null } = {}) {
    await this.app.init();

    const myExec = ++this._execSeq;
    this._busyExec = myExec;
    this.setBusy(true);

    try {
      const t0 = performance.now();
      const res = await this._runAppPath(path);
      const dt = performance.now() - t0;

      if (myExec !== this._execSeq) return;

      if (res.kind === "update") {
        this.printOk(`OK (update) — ${dt.toFixed(1)} ms`);
        return;
      }

      const rows = res.rows || [];
      this.printMeta(`rows: ${rows.length} — ${dt.toFixed(1)} ms`);

      const lines = (typeof pretty === "function")
        ? pretty(rows)
        : this.formatRowsAsTable(rows);

      for (const ln of lines) this.appendLine(ln);
    } finally {
      if (this._busyExec === myExec) this.setBusy(false);
    }
  }

  async runQueryText(text) {
    await this.app.init();

    const myExec = ++this._execSeq;
    this._busyExec = myExec;
    this.setBusy(true);

    try {
      const t0 = performance.now();
      const res = await this._runAppText(text);
      const dt = performance.now() - t0;

      if (myExec !== this._execSeq) return;

      if (res.kind === "update") {
        this.printOk(`OK (update) — ${dt.toFixed(1)} ms`);
        return;
      }

      const rows = res.rows || [];
      this.printMeta(`rows: ${rows.length} — ${dt.toFixed(1)} ms`);

      const lines = this.formatRowsAsTable(rows);
      for (const ln of lines) this.appendLine(ln);
    } finally {
      if (this._busyExec === myExec) this.setBusy(false);
    }
  }

  // ---------- command router ----------------------------------------------

  normalizeCmd(s) {
    return String(s ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  showHelp() {
    this.appendLine("Commands:", "meta");
    this.appendLine("  help                              show this help");
    this.appendLine("  clear                             clear console output");
    this.appendLine("  history                           show recent commands");
    this.appendLine("  read all goals                    list all Goal nodes");
    this.appendLine("  read all solutions                list all Solution nodes");
    this.appendLine("  read all nodes                    run read_all_nodes.sparql");
    this.appendLine("  list modules                      run list_modules.sparql");
    this.appendLine("  run path <queryPath>              run a SPARQL file (repo path)");
    this.appendLine("  run <SPARQL...>                   run inline SPARQL (SELECT only recommended)");
    this.appendLine("  open doc <repoPathOrUrl>          open a markdown doc in Document pane");
    this.appendBlank();
    this.appendLine("Example:", "meta");
    this.appendLine("  read all goals");
    this.appendLine("  run path data/queries/read_all_relations.sparql");
  }

  showHistory() {
    const last = this._history.slice(-30);
    if (!last.length) {
      this.appendLine("(history empty)", "meta");
      return;
    }
    this.appendLine("History:", "meta");
    for (const c of last) this.appendLine(`  ${c}`);
  }

  async execCommand(raw) {
    const cmd = String(raw ?? "").trim();
    if (!cmd) return;

    this.printPrompted(cmd);
    this._pushHistory(cmd);

    const n = this.normalizeCmd(cmd);

    try {
      if (n === "help" || n === "?") {
        this.showHelp();
        return;
      }

      if (n === "clear") {
        this.clearOutput();
        return;
      }

      if (n === "history") {
        this.showHistory();
        return;
      }

      if (n === "read all goals") {
        await this.runQueryPath(Q_ALL_GOALS, {
          pretty: (rows) => this.formatGoalLike(rows, "goalId", "label", "moduleId")
        });
        return;
      }

      if (n === "read all solutions") {
        await this.runQueryPath(Q_ALL_SOLUTIONS, {
          pretty: (rows) => this.formatGoalLike(rows, "solutionId", "label", "moduleId")
        });
        return;
      }

      if (n === "read all nodes") {
        await this.runQueryPath(Q_ALL_NODES);
        return;
      }

      if (n === "list modules") {
        await this.runQueryPath(Q_LIST_MODULES);
        return;
      }

      if (n.startsWith("run path ")) {
        const path = cmd.slice("run path ".length).trim();
        if (!path) throw new Error("Missing queryPath. Example: run path data/queries/read_all_nodes.sparql");
        await this.runQueryPath(path);
        return;
      }

      if (n.startsWith("run ")) {
        const sparql = cmd.slice("run ".length).trim();
        if (!sparql) throw new Error("Missing SPARQL text. Example: run SELECT * WHERE { ?s ?p ?o } LIMIT 10");
        await this.runQueryText(sparql);
        return;
      }

      if (n.startsWith("open doc ")) {
        const path = cmd.slice("open doc ".length).trim();
        if (!path) throw new Error("Missing doc path. Example: open doc /assets/docs/readme.md");

        // Activate Document tab and open the doc
        this.panes.activateLeftTab?.("tab-doc");
        safeInvoke(this.bus, "emit", "doc:open", { path });
        this.printOk("Opened document.");
        return;
      }

      this.printErr(`Unknown command: ${cmd}`);
      this.appendLine(`Type "help" to see available commands.`, "meta");
    } catch (e) {
      this.printErr(e?.message || String(e));
    }
  }

  completeInput() {
    if (!this.inputEl) return;

    const v = String(this.inputEl.value ?? "");
    const n = this.normalizeCmd(v);

    if (!n) {
      this.inputEl.value = "help";
      return;
    }

    const hits = COMMANDS.filter(c => c.startsWith(n));
    if (hits.length === 1) {
      this.inputEl.value = hits[0];
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    } else if (hits.length > 1) {
      this.printMeta("Suggestions:");
      for (const h of hits) this.appendLine(`  ${h}`, "meta");
    }
  }

  // ---------- UI wiring ----------------------------------------------------

  _wireUI({ signal } = {}) {
    const root = this.rootEl;
    if (!root) return;

    this.outEl = resolveEl("#term-out", { root, required: true, name: "Terminal: #term-out" });
    this.inputEl = resolveEl("#term-input", { root, required: true, name: "Terminal: #term-input" });
    this.termShellEl = resolveEl(".terminal", { root, required: true, name: "Terminal: .terminal" });

    resolveEl("#term-help", { root, required: true, name: "Terminal: #term-help" })
      .addEventListener("click", () => {
        this.execCommand("help");
        this.focus();
      }, { signal });

    resolveEl("#term-clear", { root, required: true, name: "Terminal: #term-clear" })
      .addEventListener("click", () => {
        this.execCommand("clear");
        this.focus();
      }, { signal });

    this.inputEl.addEventListener("keydown", (ev) => {
      // Ctrl+L = clear
      if (ev.ctrlKey && (ev.key === "l" || ev.key === "L")) {
        ev.preventDefault();
        this.execCommand("clear");
        return;
      }

      // ESC = clear input
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.inputEl.value = "";
        this._histIdx = -1;
        return;
      }

      // TAB = autocomplete
      if (ev.key === "Tab") {
        ev.preventDefault();
        this.completeInput();
        return;
      }

      // History navigation
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!this._history.length) return;

        if (this._histIdx < 0) this._histIdx = this._history.length - 1;
        else this._histIdx = Math.max(0, this._histIdx - 1);

        this.inputEl.value = this._history[this._histIdx] ?? "";
        this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
        return;
      }

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!this._history.length) return;

        if (this._histIdx < 0) return;

        this._histIdx = Math.min(this._history.length, this._histIdx + 1);
        if (this._histIdx >= this._history.length) {
          this._histIdx = -1;
          this.inputEl.value = "";
          return;
        }

        this.inputEl.value = this._history[this._histIdx] ?? "";
        this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
        return;
      }

      // Execute on Enter
      if (ev.key === "Enter") {
        ev.preventDefault();
        const v = this.inputEl.value;
        this.inputEl.value = "";
        this._histIdx = -1;
        this.execCommand(v);
        return;
      }
    }, { signal });
  }

  _wireBus() {
    if (!this.bus?.on) return;

    // Focus input when the pane becomes active
    const offFocus = this.bus.on("left:tab", (ev) => {
      const d = ev?.detail || {};
      const isTerm =
        d.view === "terminal" ||
        d.paneId === "terminal-root" ||
        d.tabId === "tab-terminal";

      if (!isTerm) return;
      this.focus();
    });
    if (typeof offFocus === "function") this._unsubs.push(offFocus);

    // Other panes can print into terminal
    const offPrint = this.bus.on("terminal:print", (ev) => {
      const { text = "", kind = "meta" } = ev?.detail || {};
      this.appendLine(String(text), kind);
    });
    if (typeof offPrint === "function") this._unsubs.push(offPrint);

    const offRun = this.bus.on("terminal:run", (ev) => {
      const { command = "" } = ev?.detail || {};
      this.execCommand(String(command));
    });
    if (typeof offRun === "function") this._unsubs.push(offRun);
  }
}

// ---------------------------------------------------------------------------
// PaneManager lifecycle (lazy-load safe)
// ---------------------------------------------------------------------------

let _app = null;

async function ensureApp(root) {
  if (_app) return _app;
  _app = new TerminalApp({ panes, bus, app });
  await _app.init({ root });
  return _app;
}

export async function mount({ root } = {}) {
  await ensureApp(root);

  // cleanup for PaneManager
  return () => {
    try { _app?.destroy?.(); } catch {}
    _app = null;
  };
}

export async function resume() {
  try { _app?.focus?.(); } catch {}
}

export async function suspend() {
}

export async function unmount() {
  try { _app?.destroy?.(); } catch {}
  _app = null;
}

export default { mount, resume, suspend, unmount };

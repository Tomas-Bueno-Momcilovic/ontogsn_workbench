import init, { Store } from "https://cdn.jsdelivr.net/npm/oxigraph@0.5.2/web.js";
import { visualizeSPO } from "./graph.js";
import panes from "./panes.js";
import { bus, emitCompat } from "./events.js";
import { resolveEl, exposeForDebug, splitTokens, fetchRepoText } from "./utils.js";

/** @typedef {{s:string,p:string,o:string}} SPORow */

// ---------- DOM handles ----------
const outEl = resolveEl("#out", { required: false, name: "#out" });

const show = x => { if (outEl) outEl.textContent = (typeof x === "string" ? x : JSON.stringify(x, null, 2)); };

const MIME_TTL = "text/turtle";

// Ontology prefixes
// --OntoGSN prefix
const BASE_ONTO = "https://w3id.org/OntoGSN/ontology#";
// --Assurance case prefix
const BASE_CASE = "https://w3id.org/OntoGSN/cases/ACT-FAST-robust-llm#";
// --Domain ontology: Car
const BASE_CAR = "https://example.org/car-demo#";
// --Domain ontology: Code
const BASE_CODE = "https://example.org/python-code#";

// Paths to data files
const PATHS = {
  // --Paths to the ontologies
  onto: "/assets/data/ontologies/ontogsn_lite.ttl",
  example: "/assets/data/ontologies/example_ac.ttl",
  car: "/assets/data/ontologies/car.ttl",
  code: "/assets/data/ontologies/example_python_code.ttl",
  // --Paths to base queries
  q: {
    nodes: "/assets/data/queries/read_all_nodes.sparql",
    rels: "/assets/data/queries/read_all_relations.sparql",
    visualize: "/assets/data/queries/visualize_graph.sparql",
    propCtx: "/assets/data/queries/propagate_context.sparql",
    propDef: "/assets/data/queries/propagate_defeater.sparql",
    listModules: "/assets/data/queries/list_modules.sparql",
    visualizeByMod: "/assets/data/queries/visualize_graph_by_module.sparql"
  }
};

const GRAPH_RENDER_OPTS = {
  height: 520,
  label: shorten,
  supportedBy: [
    "supported by",
    "gsn:supportedBy",
    "https://w3id.org/OntoGSN/ontology#supportedBy",
    "http://w3id.org/gsn#supportedBy",
  ],
  contextOf: [
    "in context of",
    "gsn:inContextOf",
    "https://w3id.org/OntoGSN/ontology#inContextOf",
    "http://w3id.org/gsn#inContextOf",
  ],
  challenges: [
    "challenges",
    "gsn:challenges",
    "https://w3id.org/OntoGSN/ontology#challenges",
    "http://w3id.org/gsn#challenges",
  ],
  theme: "light",
};


// One global-ish app instance to keep state tidy
class QueryApp {
  constructor({ bus: eventBus } = {}) {
    this.bus = eventBus ?? bus;
    this._unsubs = [];

    this.store = null;
    this._initPromise = null;
    this.graphCtl = null;
    this.overlays = new Map();
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await init();
      this.store = new Store();
      await this._loadTTL();
      this._attachUI();
      await this._buildModulesBar();
    })();
    return this._initPromise;
  }

  async run(queryPath, overlayClass = null, _opts = {}) {
    try {
      this._setBusy(true);
      const query = await fetchRepoText(queryPath, { cache: "no-store", bust: true });
      await this._execute(query, overlayClass, { source: queryPath });
    } catch (e) {
      show(`Error running ${queryPath}: ${e?.message || e}`);
      console.error(e);
    } finally {
      this._setBusy(false);
    }
  }

  async runInline(queryText, overlayClass = null, _opts = {}) {
    try {
      this._setBusy(true);
      await this._execute(queryText, overlayClass, { source: "inline" });
    } catch (e) {
      show(`Error (inline query): ${e?.message || e}`);
      console.error(e);
    } finally {
      this._setBusy(false);
    }
  }

  // --- private helpers ---
  async _execute(queryText, overlayClass = null, meta = {}) {

    if (isUpdateQuery(queryText)) {
      await this.store.update(queryText);
      this._setStatus?.("SPARQL UPDATE executed.");
      return;
    }

    const res = this.store.query(queryText);
    const rows = bindingsToRows(res);

    if (!rows.length) {
      this._setStatus?.("No results.");
      return;
    }

    const r0 = rows[0];
    const hasS = Object.prototype.hasOwnProperty.call(r0, "s");
    const hasP = Object.prototype.hasOwnProperty.call(r0, "p");
    const hasO = Object.prototype.hasOwnProperty.call(r0, "o");

    const hasCollectionsShape = ("ctx" in r0) && ("clt" in r0) && ("item" in r0);

    // 1) Collections overlay
    if (hasCollectionsShape) {
      if (!this.graphCtl?.addCollections) {
        this._setStatus?.("Collections overlay not available. Draw the graph first.");
        return;
      }
      this.graphCtl.addCollections(rows, { dx: 90, dy: 26 });
      this.graphCtl?.fit?.();
      this._setStatus?.(`Added ${rows.length} collection link${rows.length === 1 ? "" : "s"}.`);
      exposeForDebug("graphCtl", this.graphCtl);
      return;
    }

    // 2) Graph
    if (hasS && hasP && hasO) {
      await this._renderGraph(rows);
      return;
    }

    // 3) Overlay (single ?s)
    if (hasS && !hasP && !hasO) {
      if (!this.graphCtl?.highlightByIds) {
        this._setStatus?.("Nothing to highlight yet. Run “Visualize Graph” first.");
        return;
      }

      const ids = rows.map(r => r.s).filter(Boolean);
      const cls = overlayClass || "overlay";

      this.overlays.set(cls, new Set(ids));
      this._reapplyOverlays();
      this._setStatus?.(`Highlighted ${ids.length} ${cls} node${ids.length === 1 ? "" : "s"}.`);

      exposeForDebug("graphCtl", this.graphCtl);
      return;
    }

    this._setStatus?.("Query returned an unsupported shape.");
  }

  async _renderGraph(rows) {
    const host =
      panes.getRightPane()
      ?? resolveEl("#rightPane", { required: false })
      ?? resolveEl(".gsn-host", { required: false });

    if (!host) {
      this._setStatus?.("Cannot render graph: right pane host not found.");
      return;
    }

    // Clear right pane via PaneManager if available
    if (typeof panes.clearRightPane === "function") {
      panes.clearRightPane();
      this.graphCtl = null;
    } else if (host instanceof Element) {
      host.innerHTML = "";
      this.graphCtl?.destroy?.();
      this.graphCtl = null;
    }

    const newCtl = await visualizeSPO(rows, {
      mount: host,
      bus: this.bus,
      ...GRAPH_RENDER_OPTS,
    });

    panes.setRightController("graph", newCtl);
    this.graphCtl = newCtl;

    this.graphCtl?.fit?.();
    this._applyVisibility();
    this._reapplyOverlays();

    this._setStatus?.(`Rendered graph from ${rows.length} triples.`);
    exposeForDebug("graphCtl", this.graphCtl);
  }

  destroy() {
    this._unsubs.forEach(off => off());
    this._unsubs = [];

    if (this._onDocClick) {
      document.removeEventListener("click", this._onDocClick);
      this._onDocClick = null;
    }
    if (this._onDocChange) {
      document.removeEventListener("change", this._onDocChange);
      this._onDocChange = null;
    }
  }

  async _buildModulesBar(isDefault = false) {
    // 1) Query modules
    const listQ = await fetchRepoText(PATHS.q.listModules, { cache: "no-store", bust: true });
    const rows = bindingsToRows(this.store.query(listQ));

    // 2) Find/create the container at the bottom
    let bar = resolveEl("#modulesBar", { required: false, name: "#modulesBar" });
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "modulesBar";
      bar.className = "modules-bar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";

    // 3) An “All” button to restore the global view
    const btnAll = document.createElement("button");
    btnAll.classList.add('tab');
    if (isDefault) btnAll.classList.add('active');
    btnAll.textContent = "All";
    btnAll.addEventListener("click", () => this.run(PATHS.q.visualize));
    bar.appendChild(btnAll);

    // 4) One button per module
    for (const r of rows) {
      const iri = r.module;
      if (!iri) {
        console.warn("[modules] Missing ?module variable in list_modules.sparql row:", r);
        continue;
      }

      const label = r.label || shorten(iri);
      const b = document.createElement("button");
      b.textContent = label;
      b.title = iri;
      b.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();

        const tmpl = await fetchRepoText(PATHS.q.visualizeByMod, { cache: "no-store", bust: true });
        let query = tmpl;
        query = query.replaceAll("<{{MODULE_IRI}}>", `<${iri}>`);
        query = query.replaceAll("{{MODULE_IRI}}", `<${iri}>`);
        console.debug("[modules] query preview:", query.slice(0, 400));
        await this.runInline(query, null);
      });
      bar.appendChild(b);
    }
  }


  _applyVisibility() {
    const root = panes.getRightPane();
    const ctx = document.getElementById("toggle-context");
    const df = document.getElementById("toggle-defeat");
    if (!root) return;
    const showCtx = ctx ? ctx.checked : true;
    const showDef = df ? df.checked : true;
    root.classList.toggle("hide-ctx", !showCtx);
    root.classList.toggle("hide-def", !showDef);
    this.graphCtl?.fit?.();
  }

  _reapplyOverlays() {
    if (!this.graphCtl) return;
    if (this.graphCtl.clearAll) this.graphCtl.clearAll();
    for (const [cls, idSet] of this.overlays.entries()) {
      if (idSet && idSet.size > 0) {
        this.graphCtl.highlightByIds(Array.from(idSet), cls);
      }
    }
  }

  async _loadTTL() {
    const [ttlOnto, ttlExample, ttlCar, ttlCode] =
      await Promise.all([
        getTTL(PATHS.onto),
        getTTL(PATHS.example),
        getTTL(PATHS.car),
        getTTL(PATHS.code),
      ]);

    try {
      this.store.load(ttlOnto, MIME_TTL, BASE_ONTO);
      this.store.load(ttlExample, MIME_TTL, BASE_CASE);
      this.store.load(ttlCar, MIME_TTL, BASE_CAR);
      this.store.load(ttlCode, MIME_TTL, BASE_CODE);
    } catch (e) {
      const preview = ttlOnto.slice(0, 300);
      show?.(`Parse error while loading TTL: ${e.message}\n\nPreview of ontogsn_lite.ttl:\n${preview}`);
      throw e;
    }

    if (!this._wiredGraphBus) {
      this._wiredGraphBus = true;

      this._unsubs.push(
        this.bus.on("gsn:contextClick", async (ev) => {
          const iri = ev?.detail?.id;
          if (!iri) return;

          const tmpl = await fetchText(PATHS.q.propCtx);
          const q = tmpl.replaceAll("{{CTX_IRI}}", `<${iri}>`);

          const rows = bindingsToRows(this.store.query(q));
          const ids = rows.map(r => r.nodeIRI).filter(Boolean);

          this.graphCtl?.clearAll();
          this.graphCtl?.highlightByIds(ids, "in-context");
        })
      );

      this._unsubs.push(
        this.bus.on("gsn:defeaterClick", async (ev) => {
          const iri = ev?.detail?.id;
          if (!iri) return;

          const tmpl = await fetchText(PATHS.q.propDef);
          const q = tmpl.replaceAll("{{DFT_IRI}}", `<${iri}>`);

          const rows = bindingsToRows(this.store.query(q));
          const ids = rows.map(r => r.hitIRI).filter(Boolean);

          this.graphCtl?.clearAll();
          this.graphCtl?.highlightByIds(ids, "def-prop");
        })
      );
    }
  }

  _attachUI() {
    this._onDocClick = (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-query]:not(input)") : null;
      if (!btn) return;
      const path = btn.getAttribute("data-query");
      if (!path) return;
      this.run(path);
    };

    this._onDocChange = (e) => {
      const el = e.target instanceof Element
        ? e.target.closest('input[type="checkbox"][data-class]')
        : null;
      if (!el) return;

      const cls = el.getAttribute("data-class") || "overlay";
      const raw = el.getAttribute("data-queries") ?? el.getAttribute("data-query");
      if (!raw) return;

      const paths = splitTokens(raw);
      if (!paths.length) return;

      const deletePath = el.getAttribute("data-delete-query");
      const eventName = el.getAttribute("data-event");

      const isOverloadRule = paths.some(p => p.includes("propagate_overloadedCar.sparql"));

      if (el.checked) {
        (async () => {
          for (const path of paths) await this.run(path, cls);
          if (isOverloadRule) emitCompat(this.bus, "car:overloadChanged", { active: true });
          if (eventName) emitCompat(this.bus, eventName, { active: true });
        })();
      } else {
        (async () => {
          if (deletePath) await this.run(deletePath, cls);

          this.overlays.set(cls, new Set());
          this._reapplyOverlays();
          this._setStatus?.(`Hid ${cls} overlay.`);

          if (cls === "collection") {
            this.graphCtl?.clearCollections?.();
            this._setStatus?.("Hid collections overlay.");
          }

          if (isOverloadRule) emitCompat(this.bus, "car:overloadChanged", { active: false });
          if (eventName) emitCompat(this.bus, eventName, { active: false });
        })();
      }
    };

    document.addEventListener("click", this._onDocClick);
    document.addEventListener("change", this._onDocChange);

    const ctxBox = document.getElementById("toggle-context");
    const dfBox = document.getElementById("toggle-defeat");
    ctxBox?.addEventListener("change", () => this._applyVisibility());
    dfBox?.addEventListener("change", () => this._applyVisibility());
  }

  _setBusy(busy) {
    document.body.toggleAttribute("aria-busy", !!busy);
    const btns = document.querySelectorAll("[data-query]");
    btns.forEach(b => b.toggleAttribute("disabled", !!busy));
  }
}

// ---------- generic helpers ----------

function toTriples(rows) {
  const get = (r, keys) => keys.find(k => r[k] !== undefined);
  const triples = [];
  for (const r of rows) {
    const ks = get(r, ["s", "subject", "subj", "source", "nodeIRI", "from", "g"]);
    const kp = get(r, ["p", "predicate", "pred", "rel", "property", "edge"]);
    const ko = get(r, ["o", "object", "obj", "target", "to", "hitIRI"]);
    const s = ks ? r[ks] : undefined;
    const p = kp ? r[kp] : undefined;
    const o = ko ? r[ko] : undefined;
    if (s && p && o) triples.push({ s, p, o });
  }
  return triples;
}

function getFirstKeyword(queryText) {
  const lines = String(queryText).split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;           // skip empty
    if (t.startsWith("#")) continue; // skip comments
    if (/^(PREFIX|BASE)\b/i.test(t)) continue; // skip PREFIX/BASE
    return t.split(/\s+/)[0].toUpperCase();
  }
  return "";
}

function isUpdateQuery(queryText) {
  const kw = getFirstKeyword(queryText);
  // basic set of SPARQL UPDATE operations
  return ["INSERT", "DELETE", "LOAD", "CREATE", "DROP", "CLEAR", "COPY", "MOVE", "ADD"].includes(kw);
}

async function getTTL(pathOrUrl) {
  const txt = await fetchRepoText(pathOrUrl, { cache: "no-store", bust: true });

  const first = txt.split(/\r?\n/).find(l => l.trim().length) || "";
  if (first.startsWith("<!")) throw new Error(`Got HTML instead of Turtle from ${pathOrUrl}. Check the path.`);
  return txt;
}

function termToDisplay(t) {
  if (!t) return "";
  switch (t.termType) {
    case "NamedNode": return t.value;
    case "BlankNode": return "_:" + t.value;
    case "Literal": {
      const dt = t.datatype?.value;
      const lg = t.language;
      if (lg) return `"${t.value}"@${lg}`;
      if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") return `"${t.value}"^^${dt}`;
      return t.value;
    }
    default: return t.value ?? String(t);
  }
}

function bindingsToRows(iter) {
  const rows = [];
  for (const b of iter) {
    const obj = {};
    for (const [k, v] of b) obj[k] = termToDisplay(v);
    rows.push(obj);
  }
  return rows;
}

function shorten(iriOrLabel) {
  try {
    const u = new URL(iriOrLabel);
    if (u.hash && u.hash.length > 1) return u.hash.slice(1);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || iriOrLabel;
  } catch {
    return iriOrLabel.replace(/^.*[#/]/, "");
  }
}

// ---------- boot ----------
const app = new QueryApp({ bus });
//app.init();
window.addEventListener("DOMContentLoaded", async () => {
  await app.init();                     // loads TTLs + wires UI
  await app.run(PATHS.q.visualize);
});

app.selectBindings = async function selectBindings(queryText) {
  // Ensure store is ready (reuses your init() logic and _initPromise)
  await this.init();

  const q = queryText.trim();
  const res = this.store.query(q);

  const rows = [];
  for (const binding of res) {
    const row = {};
    for (const [name, term] of binding) {
      row[name] = { value: term.value, term };
    }
    rows.push(row);
  }
  return rows;
};

// Also export the app for debugging in console if needed
export default app;
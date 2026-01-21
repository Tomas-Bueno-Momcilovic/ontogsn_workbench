import queries from "@core/queries.js";
import { bus } from "@core/events.js";
import {
  mountTemplate,
  bindingsToRows,
  shortenIri,
  cleanRdfLiteral,
  downloadText,
  fetchText
} from "@core/utils.js";

import { getOrchestratorOntologyUrls } from "./config.js";

const app = queries;

let _ontoLoadPromise = null;

const HTML = new URL("./orchestrator.html", import.meta.url);
const CSS = new URL("./orchestrator.css", import.meta.url);

/**
 * IMPORTANT:
 * These URLs must resolve to /assets/data/queries/...
 * From /assets/panes/orchestrator/orchestrator.js -> ../../../ goes to /assets/
 */
const Q_SELECTION = new URL("../../data/queries/orchestrator/read_selection.sparql", import.meta.url);
const Q_TEST_RESULTS = new URL("../../data/queries/orchestrator/read_test_results.sparql", import.meta.url);
const Q_CLASSIFY = new URL("../../data/queries/orchestrator/read_classifications.sparql", import.meta.url);
const Q_COVERAGE = new URL("../../data/queries/orchestrator/read_coverage.sparql", import.meta.url);
const Q_CASE_TO_SOL = new URL("../../data/queries/orchestrator/read_case_to_solution.sparql", import.meta.url); // optional

async function ensureOrchestratorOntologiesLoaded({ bust = false, base } = {}) {
  if (_ontoLoadPromise && !bust) return _ontoLoadPromise;
  if (bust) _ontoLoadPromise = null;

  _ontoLoadPromise = (async () => {
    await app.init();

    const store = app.store;
    if (!store) throw new Error("[orchestrator] app.store not initialized");

    const parser = new N3.Parser();

    // ✅ only pass base if it's actually provided
    const urls = (base == null)
      ? getOrchestratorOntologyUrls()
      : getOrchestratorOntologyUrls({ base });

    const loaded = [];

    for (const url of urls) {
      try {
        const ttl = await fetchText(url, { cache: bust ? "no-store" : "force-cache", bust });
        const quads = parser.parse(ttl);

        if (typeof store.addQuads === "function") store.addQuads(quads);
        else if (typeof store.addQuad === "function") quads.forEach(q => store.addQuad(q));
        else if (typeof store.add === "function") quads.forEach(q => store.add(q));
        else throw new Error("Store does not support addQuads/addQuad/add");

        loaded.push({ url, quads: quads.length });
      } catch (e) {
        console.warn("[orchestrator] failed to load ontology:", url, e);
      }
    }

    return loaded;
  })();

  return _ontoLoadPromise;
}



function $(root, sel) {
  return root.querySelector(sel);
}

function text(v) {
  if (v == null) return "";
  return String(v);
}

function normLit(v) {
  try { return cleanRdfLiteral(v); } catch { return text(v); }
}

function fmtProb(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text(v);
}

function badgeForLabel(label, prob) {
  const L = (label || "").toLowerCase();
  const p = Number(prob);
  if (L === "yes" || L === "unsafe") return { cls: "bad", txt: `unsafe ${fmtProb(p)}` };
  if (L === "no" || L === "safe") return { cls: "good", txt: `safe ${fmtProb(p)}` };
  if (L === "failed") return { cls: "warn", txt: `failed` };
  return { cls: "", txt: `${label ?? "?"} ${fmtProb(p)}`.trim() };
}

async function runQuery(pathUrl) {
  // queries.runPath() returns whatever your QueryService returns.
  // In your codebase, bindingsToRows expects an *iterable* of bindings.
  // Many of your panes use QueryService objects that are iterable.
  const res = await queries.runPath(pathUrl, { cache: "no-store", bust: true });

  // Make it robust for either: iterable OR { rows: iterable }
  const iter = res?.rows ?? res;
  return bindingsToRows(iter ?? []);
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function maxTimestamp(...rowSets) {
  let best = null;
  for (const rows of rowSets) {
    for (const r of rows) {
      const ts = r.timestamp || r.time || r.ts;
      if (!ts) continue;
      if (!best || String(ts) > String(best)) best = ts;
    }
  }
  return best;
}

function buildEvidence({ selectionRows, testRows, clsRows, caseToSolRows }) {
  const byCase = new Map();

  const ensure = (caseId) => {
    const k = text(caseId);
    if (!byCase.has(k)) {
      byCase.set(k, {
        caseId: k,
        solutionIri: null,
        solutionLabel: null,
        selectedForRisks: [],
        tests: [],
        classifications: [],
      });
    }
    return byCase.get(k);
  };

  for (const r of (caseToSolRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    const sol = r.solution || r.solutionIri || r.solution_node;
    if (!caseId || !sol) continue;
    const ev = ensure(caseId);
    ev.solutionIri = text(sol);
    ev.solutionLabel = shortenIri(text(sol));
  }

  for (const r of (selectionRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    const risk = r.risk;
    const order = r.order ?? r.rank ?? r.k;
    if (!caseId || caseId === "None") continue;
    const ev = ensure(caseId);
    ev.selectedForRisks.push({ risk: text(risk), order: text(order) });
  }

  for (const r of (testRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    if (!caseId) continue;
    const ev = ensure(caseId);
    ev.tests.push({
      prompt: normLit(r.prompt || r.attack_prompt || r.final_prompt || r.input || ""),
      output: normLit(r.output || r.response || r.final_prompt_response || ""),
      verdict: normLit(r.verdict || r.improvement || r.judge || ""),
      timestamp: r.timestamp || null,
    });
  }

  for (const r of (clsRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    if (!caseId) continue;
    const ev = ensure(caseId);
    ev.classifications.push({
      risk: text(r.risk || ""),
      label: text(r.label || ""),
      prob: r.prob ?? r.probability ?? r.p ?? "",
      timestamp: r.timestamp || null,
    });
  }

  for (const ev of byCase.values()) {
    ev.selectedForRisks.sort((a, b) => (a.risk || "").localeCompare(b.risk || ""));
    ev.classifications.sort((a, b) => (a.risk || "").localeCompare(b.risk || ""));
  }

  return Array.from(byCase.values()).filter(e => e.caseId);
}

function renderRiskFilter(selEl, risks, selectedRisk) {
  const opts = [{ v: "__all__", label: "All risks" }, ...risks.map(r => ({ v: r, label: r }))];
  selEl.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.label;
    if (o.v === selectedRisk) opt.selected = true;
    selEl.appendChild(opt);
  }
}

function renderSelection(el, selectionRows, onPickCase) {
  const byRisk = groupBy(selectionRows || [], r => text(r.risk || "unknown"));
  const risks = Array.from(byRisk.keys()).sort();
  el.innerHTML = "";

  for (const risk of risks) {
    const rows = byRisk.get(risk) || [];
    const wrap = document.createElement("div");
    wrap.className = "sel-risk";

    const head = document.createElement("div");
    head.className = "sel-risk-head";
    head.innerHTML = `
      <div class="sel-risk-name">${risk}</div>
      <div class="orc-muted">${rows.length}</div>
    `;
    wrap.appendChild(head);

    rows.sort((a, b) => {
      const oa = Number(a.order ?? 9999);
      const ob = Number(b.order ?? 9999);
      if (oa !== ob) return oa - ob;
      return text(a.case || "").localeCompare(text(b.case || ""));
    });

    for (const r of rows) {
      const caseId = r.case || r.test_case || r.id;
      if (!caseId) continue;

      const item = document.createElement("div");
      item.className = "sel-case";
      item.textContent = `${caseId}${r.order != null ? `  (#${r.order})` : ""}`;
      item.addEventListener("click", () => onPickCase(caseId, risk));
      wrap.appendChild(item);
    }

    el.appendChild(wrap);
  }
}

function renderCoverage(el, coverageRows) {
  const rows = (coverageRows || []).map(r => {
    const risk = text(r.risk || "");
    const prob = Number(r.avgProb ?? r.prob ?? r.probability ?? 0);
    return { risk, prob };
  }).filter(x => x.risk);

  rows.sort((a, b) => b.prob - a.prob);

  el.innerHTML = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "cov-row";

    const left = document.createElement("div");
    left.innerHTML = `
      <div style="font-weight:700">${r.risk}</div>
      <div class="cov-bar"><i style="width:${Math.max(0, Math.min(1, r.prob)) * 100}%"></i></div>
    `;

    const right = document.createElement("div");
    right.className = "cov-val";
    right.textContent = fmtProb(r.prob);

    row.appendChild(left);
    row.appendChild(right);
    el.appendChild(row);
  }

  if (!rows.length) el.innerHTML = `<div class="orc-muted">No coverage data.</div>`;
}

function cardHtml(ev) {
  const cls = ev.classifications || [];
  const tests = ev.tests || [];
  const sol = ev.solutionIri;

  let headline = null;
  for (const c of cls) {
    const b = badgeForLabel(c.label, c.prob);
    if ((c.label || "").toLowerCase() === "yes") headline = headline || { ...b, risk: c.risk };
  }
  if (!headline && cls.length) {
    const c = cls[0];
    headline = { ...badgeForLabel(c.label, c.prob), risk: c.risk };
  }

  const badgeLine = [
    ...(headline ? [`<span class="badge ${headline.cls}">${headline.risk}: ${headline.txt}</span>`] : []),
    ...(tests.length ? [`<span class="badge">tests: ${tests.length}</span>`] : []),
    ...(cls.length ? [`<span class="badge">risks: ${cls.length}</span>`] : []),
  ].join("");

  const riskRows = cls.map(c => {
    const b = badgeForLabel(c.label, c.prob);
    return `
      <tr>
        <td>${c.risk}</td>
        <td><span class="badge ${b.cls}">${b.txt}</span></td>
        <td>${fmtProb(c.prob)}</td>
      </tr>
    `;
  }).join("");

  const firstTest = tests[0] || { prompt: "", output: "", verdict: "" };

  return `
    <article class="ev-card" data-case="${ev.caseId}">
      <div class="ev-head">
        <div>
          <div class="ev-case">${ev.caseId}</div>
          <div class="orc-muted">${sol ? shortenIri(sol) : "no mapped Solution IRI"}</div>
        </div>
        <div class="ev-meta">${ev.solutionLabel || ""}</div>
      </div>

      <div class="ev-badges">${badgeLine}</div>

      <div>
        <table class="ev-table">
          <thead>
            <tr><th>Risk</th><th>Label</th><th>Prob</th></tr>
          </thead>
          <tbody>
            ${riskRows || `<tr><td colspan="3" class="orc-muted">No classifications found.</td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="ev-block">
        <details>
          <summary>Adversarial prompt</summary>
          <pre class="ev-pre">${firstTest.prompt || "(none)"}</pre>
        </details>
      </div>

      <div class="ev-block">
        <details>
          <summary>Target output</summary>
          <pre class="ev-pre">${firstTest.output || "(none)"}</pre>
        </details>
      </div>

      <div class="ev-block">
        <details>
          <summary>Judge verdict</summary>
          <pre class="ev-pre">${firstTest.verdict || "(none)"}</pre>
        </details>
      </div>

      <div class="ev-foot">
        <button class="ev-btn" data-action="focus" data-iri="${sol || ""}">Focus</button>
        <button class="ev-btn" data-action="copyPrompt">Copy prompt</button>
        <button class="ev-btn" data-action="copyOutput">Copy output</button>
      </div>
    </article>
  `;
}

function renderCards(el, evidence) {
  el.innerHTML = evidence.map(cardHtml).join("") || `<div class="orc-muted">No evidence.</div>`;
}

function filterEvidence(evidence, { risk, q }) {
  const term = (q || "").trim().toLowerCase();
  const wantRisk = (risk && risk !== "__all__") ? risk : null;

  return evidence.filter(ev => {
    if (wantRisk) {
      const hasRisk = ev.classifications.some(c => c.risk === wantRisk);
      if (!hasRisk) return false;
    }
    if (term) {
      const hay = [
        ev.caseId,
        ev.solutionIri,
        ...(ev.classifications.map(c => `${c.risk} ${c.label} ${c.prob}`)),
        ...(ev.tests.map(t => `${t.prompt} ${t.output} ${t.verdict}`)),
      ].join(" ").toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

async function copyToClipboard(textVal) {
  const t = textVal || "";
  if (!t) return;
  try { await navigator.clipboard.writeText(t); } catch { }
}

export async function mount({ root, payload }) {
  const base = payload?.base ?? payload?.orcBase ?? null;

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    replace: true,
    cache: "no-store",
    bust: true
  });

  const orc = root.querySelector(".orc");
  if (!orc) throw new Error("Orchestrator pane: template mounted but .orc not found");

  const els = {
    summary: $(orc, '[data-el="summary"]'),
    riskFilter: $(orc, '[data-el="riskFilter"]'),
    caseFilter: $(orc, '[data-el="caseFilter"]'),
    refreshBtn: $(orc, '[data-el="refreshBtn"]'),
    exportBtn: $(orc, '[data-el="exportBtn"]'),
    selection: $(orc, '[data-el="selection"]'),
    coverage: $(orc, '[data-el="coverage"]'),
    cards: $(orc, '[data-el="cards"]'),
    selCount: $(orc, '[data-el="selCount"]'),
    riskCount: $(orc, '[data-el="riskCount"]'),
  };

  const state = {
    selectionRows: [],
    testRows: [],
    clsRows: [],
    coverageRows: [],
    caseToSolRows: [],
    evidenceAll: [],
    risk: "__all__",
    q: "",
  };

  async function refresh() {
    els.summary.textContent = "Loading Orchestrator ontologies…";

    // Load STC ontologies dynamically (once per session)
    const loaded = await ensureOrchestratorOntologiesLoaded({ bust: true, base });

    els.summary.textContent = `Loaded ${loaded.length} ontologies. Querying store…`;

    const [sel, tests, cls, cov, map] = await Promise.all([
      runQuery(Q_SELECTION).catch(() => []),
      runQuery(Q_TEST_RESULTS).catch(() => []),
      runQuery(Q_CLASSIFY).catch(() => []),
      runQuery(Q_COVERAGE).catch(() => []),
      runQuery(Q_CASE_TO_SOL).catch(() => []),
    ]);

    state.selectionRows = sel;
    state.testRows = tests;
    state.clsRows = cls;
    state.coverageRows = cov;
    state.caseToSolRows = map;

    state.evidenceAll = buildEvidence({
      selectionRows: sel,
      testRows: tests,
      clsRows: cls,
      caseToSolRows: map,
    });

    const risks = new Set();
    for (const r of cls) if (r.risk) risks.add(text(r.risk));
    const riskList = Array.from(risks).sort();
    renderRiskFilter(els.riskFilter, riskList, state.risk);

    renderSelection(els.selection, state.selectionRows, (caseId, risk) => {
      state.q = caseId;
      els.caseFilter.value = caseId;
      state.risk = risk || state.risk;
      els.riskFilter.value = state.risk;
      rerender();
    });

    renderCoverage(els.coverage, state.coverageRows);

    els.selCount.textContent = `${sel.length}`;
    els.riskCount.textContent = `${riskList.length}`;

    const lastTs = maxTimestamp(sel, tests, cls);
    els.summary.textContent =
      `cases: ${state.evidenceAll.length} · tests: ${tests.length} · classifications: ${cls.length}` +
      (lastTs ? ` · last: ${lastTs}` : "");

    rerender();
  }

  function rerender() {
    const filtered = filterEvidence(state.evidenceAll, { risk: state.risk, q: state.q });
    renderCards(els.cards, filtered);
  }

  els.refreshBtn.addEventListener("click", refresh);

  els.riskFilter.addEventListener("change", (e) => {
    state.risk = e.target.value;
    rerender();
  });

  els.caseFilter.addEventListener("input", (e) => {
    state.q = e.target.value;
    rerender();
  });

  els.exportBtn.addEventListener("click", () => {
    const filtered = filterEvidence(state.evidenceAll, { risk: state.risk, q: state.q });
    downloadText(
      `ontogsn-orchestrator-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), ...state, evidence: filtered }, null, 2)
    );
  });

  els.cards.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");
    const card = btn.closest(".ev-card");
    const caseId = card?.getAttribute("data-case") || null;
    const ev = state.evidenceAll.find(x => x.caseId === caseId);
    if (!ev) return;

    if (action === "focus") {
      const iri = btn.getAttribute("data-iri") || ev.solutionIri;
      if (!iri) return;
      bus.emit("graph:focus", { iri, caseId });
      return;
    }

    if (action === "copyPrompt") await copyToClipboard(ev.tests?.[0]?.prompt || "");
    if (action === "copyOutput") await copyToClipboard(ev.tests?.[0]?.output || "");
  });

  await refresh();
}

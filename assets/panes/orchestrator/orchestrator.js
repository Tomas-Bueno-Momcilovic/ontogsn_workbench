import queries from "@core/queries.js";
import { bus as coreBus } from "@core/events.js";
import { MIME_TTL } from "@rdf/config.js";
import { getOrchestratorOntologyUrls } from "./config.js";
import {
  mountTemplate,
  shortenIri,
  downloadText,
  fetchText,
  qs,
  toText,
  escText,
  fmtProb,
  groupBy,
  maxTimestamp,
  copyToClipboard,
  normRdfLiteral,
  safeInvoke
} from "@core/utils.js";


const app = queries;

let _ontoLoadPromise = null;
let _ontoBaseKey = null;

const HTML = new URL("./orchestrator.html", import.meta.url);
const CSS = new URL("./orchestrator.css", import.meta.url);

const Q_SELECTION = new URL("../../data/queries/orchestrator/read_selection.sparql", import.meta.url);
const Q_TEST_RESULTS = new URL("../../data/queries/orchestrator/read_test_results.sparql", import.meta.url);
const Q_CLASSIFY = new URL("../../data/queries/orchestrator/read_classifications.sparql", import.meta.url);
const Q_COVERAGE = new URL("../../data/queries/orchestrator/read_coverage.sparql", import.meta.url);
const Q_CASE_TO_SOL = new URL("../../data/queries/orchestrator/read_case_to_solution.sparql", import.meta.url); // optional

// --- module state ----------------------------------------------------------
let _root = null;
let _bus = null;
let _cleanup = null;
let _refresh = null;

function badgeForLabel(label, prob) {
  const L = (label || "").toLowerCase();
  const p = Number(prob);
  if (L === "yes" || L === "unsafe") return { cls: "bad", txt: `unsafe ${fmtProb(p)}`.trim() };
  if (L === "no" || L === "safe") return { cls: "good", txt: `safe ${fmtProb(p)}`.trim() };
  if (L === "failed") return { cls: "warn", txt: `failed` };
  return { cls: "", txt: `${label ?? "?"} ${fmtProb(p)}`.trim() };
}

async function runQuery(pathUrl) {
  // QueriesApp.runPath -> QueryService.runPath -> QueryResult { kind:"rows", rows:[...] }
  const res = await app.runPath(String(pathUrl), { cache: "no-store", bust: true });
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

// Load additional orchestrator ontologies into the existing Oxigraph store.
async function ensureOrchestratorOntologiesLoaded({ bust = false, base } = {}) {
  const baseKey = String(base ?? "");
  if (_ontoBaseKey !== baseKey) {
    _ontoBaseKey = baseKey;
    _ontoLoadPromise = null;
  }

  if (_ontoLoadPromise && !bust) return _ontoLoadPromise;
  if (bust) _ontoLoadPromise = null;

  _ontoLoadPromise = (async () => {
    await app.init();

    const store = app.store;
    if (!store) throw new Error("[orchestrator] app.store not initialized");

    const urls = (base == null)
      ? getOrchestratorOntologyUrls()
      : getOrchestratorOntologyUrls({ base });

    const loaded = [];

    for (const url of urls) {
      try {
        const ttl = await fetchText(url, {
          cache: bust ? "no-store" : "force-cache",
          bust
        });

        // Oxigraph Store supports .load(text, mime, baseIri)
        store.load(ttl, {
          format: MIME_TTL,
          base_iri: String(url),
        });

        loaded.push({ url });
      } catch (e) {
        console.warn("[orchestrator] failed to load ontology:", url, e);
      }
    }

    return loaded;
  })();

  return _ontoLoadPromise;
}

// --- helpers ---------------------------------------------------------------
function buildEvidence({ selectionRows, testRows, clsRows, caseToSolRows }) {
  const byCase = new Map();

  const ensure = (caseId) => {
    const k = toText(caseId);
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
    ev.solutionIri = toText(sol);
    ev.solutionLabel = shortenIri(toText(sol));
  }

  for (const r of (selectionRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    const risk = r.risk;
    const order = r.order ?? r.rank ?? r.k;
    if (!caseId || caseId === "None") continue;
    const ev = ensure(caseId);
    ev.selectedForRisks.push({ risk: toText(risk), order: toText(order) });
  }

  for (const r of (testRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    if (!caseId) continue;
    const ev = ensure(caseId);
    ev.tests.push({
      prompt: normRdfLiteral(r.prompt || r.attack_prompt || r.final_prompt || r.input || ""),
      output: normRdfLiteral(r.output || r.response || r.final_prompt_response || ""),
      verdict: normRdfLiteral(r.verdict || r.improvement || r.judge || ""),
      timestamp: r.timestamp || null,
    });
  }

  for (const r of (clsRows || [])) {
    const caseId = r.case || r.test_case || r.id;
    if (!caseId) continue;
    const ev = ensure(caseId);
    ev.classifications.push({
      risk: toText(r.risk || ""),
      label: toText(r.label || ""),
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

// --- rendering -------------------------------------------------------------
function renderRiskFilter(selEl, risks, selectedRisk) {
  const opts = [{ v: "__all__", label: "All risks" }, ...risks.map(r => ({ v: r, label: r }))];
  selEl.replaceChildren();

  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.label;
    opt.selected = (o.v === selectedRisk);
    selEl.appendChild(opt);
  }
}

function renderSelection(el, selectionRows, onPickCase) {
  const byRisk = groupBy(selectionRows || [], r => toText(r.risk || "unknown"));
  const risks = Array.from(byRisk.keys()).sort();
  el.replaceChildren();

  for (const risk of risks) {
    const rows = byRisk.get(risk) || [];

    const wrap = document.createElement("div");
    wrap.className = "sel-risk";

    const head = document.createElement("div");
    head.className = "sel-risk-head";

    const nameEl = document.createElement("div");
    nameEl.className = "sel-risk-name";
    nameEl.textContent = risk;

    const cntEl = document.createElement("div");
    cntEl.className = "orc-muted";
    cntEl.textContent = String(rows.length);

    head.appendChild(nameEl);
    head.appendChild(cntEl);
    wrap.appendChild(head);

    rows.sort((a, b) => {
      const oa = Number(a.order ?? 9999);
      const ob = Number(b.order ?? 9999);
      if (oa !== ob) return oa - ob;
      return toText(a.case || "").localeCompare(toText(b.case || ""));
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
  const rows = (coverageRows || [])
    .map(r => {
      const risk = toText(r.risk || "");
      const prob = Number(r.avgProb ?? r.prob ?? r.probability ?? 0);
      return { risk, prob };
    })
    .filter(x => x.risk);

  rows.sort((a, b) => b.prob - a.prob);

  el.replaceChildren();

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "cov-row";

    const left = document.createElement("div");

    const title = document.createElement("div");
    title.style.fontWeight = "700";
    title.textContent = r.risk;

    const bar = document.createElement("div");
    bar.className = "cov-bar";

    const fill = document.createElement("i");
    const pct = Math.max(0, Math.min(1, Number(r.prob))) * 100;
    fill.style.width = `${pct}%`;

    bar.appendChild(fill);
    left.appendChild(title);
    left.appendChild(bar);

    const right = document.createElement("div");
    right.className = "cov-val";
    right.textContent = fmtProb(r.prob);

    row.appendChild(left);
    row.appendChild(right);
    el.appendChild(row);
  }

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "orc-muted";
    empty.textContent = "No coverage data.";
    el.appendChild(empty);
  }
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
    ...(headline ? [`<span class="badge ${escText(headline.cls)}">${escText(headline.risk)}: ${escText(headline.txt)}</span>`] : []),
    ...(tests.length ? [`<span class="badge">tests: ${tests.length}</span>`] : []),
    ...(cls.length ? [`<span class="badge">risks: ${cls.length}</span>`] : []),
  ].join("");

  const riskRows = cls.map(c => {
    const b = badgeForLabel(c.label, c.prob);
    return `
      <tr>
        <td>${escText(c.risk)}</td>
        <td><span class="badge ${escText(b.cls)}">${escText(b.txt)}</span></td>
        <td>${escText(fmtProb(c.prob))}</td>
      </tr>
    `;
  }).join("");

  const firstTest = tests[0] || { prompt: "", output: "", verdict: "" };
  const prompt = escText(firstTest.prompt || "(none)");
  const output = escText(firstTest.output || "(none)");
  const verdict = escText(firstTest.verdict || "(none)");

  const caseIdEsc = escText(ev.caseId);
  const solShort = sol ? escText(shortenIri(sol)) : "no mapped Solution IRI";
  const solLabel = escText(ev.solutionLabel || "");
  const iriAttr = escText(sol || "");

  return `
    <article class="ev-card" data-case="${caseIdEsc}">
      <div class="ev-head">
        <div>
          <div class="ev-case">${caseIdEsc}</div>
          <div class="orc-muted">${solShort}</div>
        </div>
        <div class="ev-meta">${solLabel}</div>
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
          <pre class="ev-pre">${prompt}</pre>
        </details>
      </div>

      <div class="ev-block">
        <details>
          <summary>Target output</summary>
          <pre class="ev-pre">${output}</pre>
        </details>
      </div>

      <div class="ev-block">
        <details>
          <summary>Judge verdict</summary>
          <pre class="ev-pre">${verdict}</pre>
        </details>
      </div>

      <div class="ev-foot">
        <button class="ev-btn" data-action="focus" data-iri="${iriAttr}">Focus</button>
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

  return (evidence || []).filter(ev => {
    const cls = ev.classifications || [];
    const tests = ev.tests || [];

    if (wantRisk) {
      const hasRisk = cls.some(c => c.risk === wantRisk);
      if (!hasRisk) return false;
    }

    if (term) {
      const hay = [
        ev.caseId,
        ev.solutionIri,
        ...(cls.map(c => `${c.risk} ${c.label} ${c.prob}`)),
        ...(tests.map(t => `${t.prompt} ${t.output} ${t.verdict}`)),
      ].join(" ").toLowerCase();

      if (!hay.includes(term)) return false;
    }

    return true;
  });
}

// --- PaneManager lifecycle exports ----------------------------------------
export async function mount({ root, bus, payload }) {
  _root = root;
  _bus = bus || coreBus;

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
    summary: qs(orc, '[data-el="summary"]'),
    riskFilter: qs(orc, '[data-el="riskFilter"]'),
    caseFilter: qs(orc, '[data-el="caseFilter"]'),
    refreshBtn: qs(orc, '[data-el="refreshBtn"]'),
    exportBtn: qs(orc, '[data-el="exportBtn"]'),
    selection: qs(orc, '[data-el="selection"]'),
    coverage: qs(orc, '[data-el="coverage"]'),
    cards: qs(orc, '[data-el="cards"]'),
    selCount: qs(orc, '[data-el="selCount"]'),
    riskCount: qs(orc, '[data-el="riskCount"]'),
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

  function rerender() {
    const filtered = filterEvidence(state.evidenceAll, { risk: state.risk, q: state.q });
    renderCards(els.cards, filtered);
  }

  async function refresh({ bustOntos = false } = {}) {
    els.summary.textContent = "Loading Orchestrator ontologies…";

    // once per session (unless Shift+Refresh or explicit bust)
    const loaded = await ensureOrchestratorOntologiesLoaded({ bust: bustOntos, base });

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

    // IMPORTANT: union risks from BOTH selection + classifications
    const risks = new Set();
    for (const r of cls) if (r.risk) risks.add(toText(r.risk));
    for (const r of sel) if (r.risk) risks.add(toText(r.risk));

    const riskList = Array.from(risks).sort();
    renderRiskFilter(els.riskFilter, riskList, state.risk);

    renderSelection(els.selection, state.selectionRows, (caseId, risk) => {
      state.q = caseId;
      els.caseFilter.value = caseId;

      // if selection picks a risk not currently in dropdown, include it
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

  _refresh = refresh;

  // --- events (with cleanup) ----------------------------------------------
  const onRefreshClick = (ev) => {
    // Shift+Refresh -> force reload of ontologies (dev / hot changes)
    const bustOntos = !!ev?.shiftKey;
    refresh({ bustOntos }).catch(console.error);
  };

  const onRiskChange = (e) => {
    state.risk = e.target.value;
    rerender();
  };

  const onCaseInput = (e) => {
    state.q = e.target.value;
    rerender();
  };

  const onExportClick = () => {
    const filtered = filterEvidence(state.evidenceAll, { risk: state.risk, q: state.q });
    downloadText(
      `ontogsn-orchestrator-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      JSON.stringify(
        { exportedAt: new Date().toISOString(), ...state, evidence: filtered },
        null,
        2
      )
    );
  };

  const onCardsClick = async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");
    const card = btn.closest(".ev-card");
    const caseId = card?.getAttribute("data-case") || null;
    const evObj = (state.evidenceAll || []).find(x => x.caseId === caseId);
    if (!evObj) return;

    if (action === "focus") {
      const iri = btn.getAttribute("data-iri") || evObj.solutionIri;
      if (!iri) return;

      safeInvoke(_bus, "emit", "graph:focus", { iri, caseId });
      return;
    }

    if (action === "copyPrompt") await copyToClipboard(evObj.tests?.[0]?.prompt || "");
    if (action === "copyOutput") await copyToClipboard(evObj.tests?.[0]?.output || "");
  };

  els.refreshBtn.addEventListener("click", onRefreshClick);
  els.riskFilter.addEventListener("change", onRiskChange);
  els.caseFilter.addEventListener("input", onCaseInput);
  els.exportBtn.addEventListener("click", onExportClick);
  els.cards.addEventListener("click", onCardsClick);

  // initial load
  await refresh({ bustOntos: false });

  _cleanup = () => {
    try { els.refreshBtn.removeEventListener("click", onRefreshClick); } catch { }
    try { els.riskFilter.removeEventListener("change", onRiskChange); } catch { }
    try { els.caseFilter.removeEventListener("input", onCaseInput); } catch { }
    try { els.exportBtn.removeEventListener("click", onExportClick); } catch { }
    try { els.cards.removeEventListener("click", onCardsClick); } catch { }

    _refresh = null;
    _cleanup = null;
    _root = null;
    _bus = null;
  };

  return _cleanup;
}

export async function resume() {
  // refresh on re-open (cheap and consistent with checklist behavior)
  await _refresh?.({ bustOntos: false });
}

export async function suspend() {
  // nothing long-running to stop
}

export async function unmount() {
  try { _cleanup?.(); } catch { }
}

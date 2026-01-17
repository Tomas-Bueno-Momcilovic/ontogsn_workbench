import panes from "@core/panes.js";
import app from "@core/queries.js";
import { resolveEl, escapeHtml, fetchRepoText, repoHref, fetchText, highlightCode } from "@core/utils.js";

async function runSparql(query) {
  if (!app || typeof app.selectBindings !== "function") {
    throw new Error("SPARQL store not available (app.selectBindings missing)");
  }
  return app.selectBindings(query);
}

const TARGET_SOLUTION_IRI = "https://w3id.org/OntoGSN/cases/ACT-FAST-robust-llm#Sn11";
const CODE_BASE_URL = "data/";
const CODE_SOLUTION_QUERY = "data/queries/read_solutionWithCode.sparql";

async function fetchCodeMeta(solutionIri) {
  const raw = await fetchRepoText(CODE_SOLUTION_QUERY, { cache: "no-store", bust: true });
  const query     = raw.replaceAll("${solutionIri}", solutionIri);
  const bindings  = await runSparql(query);

  if (!bindings || !bindings.length) {
    throw new Error(`No code artefact found for ${solutionIri}`);
  }

  const row = bindings[0];
  const langLiteral     = row.lang?.value ?? "text";
  const filePathLiteral = row.filePath?.value ?? "";

  if (!filePathLiteral) { throw new Error(`Missing py:filePath for ${solutionIri}`); }

  const [relativePath, fragment] = filePathLiteral.split("#");
  if (!relativePath) { throw new Error(`Invalid py:filePath for ${solutionIri}: "${filePathLiteral}"`); }

  const codeUrl = repoHref(CODE_BASE_URL + relativePath);

  return {
    codeLanguage: String(langLiteral).toLowerCase(),
    codeUrl,
    fragment: fragment || null
  };
}


async function renderCodePanel() {
  const root = resolveEl("#code-root", { required: false });
  if (!root) return;

  root.innerHTML = `<p>Loading code artefact…</p>`;

  try {
    // 1) Get metadata from the KG
    const meta = await fetchCodeMeta(TARGET_SOLUTION_IRI);

    // 2) Fetch the actual code file
    const codeText = await fetchText(meta.codeUrl, { cache: "no-store", bust: true });

    root.innerHTML = `
      <section class="code-panel">
        <pre class="code-block"><code class="language-${escapeHtml(meta.codeLanguage)}">${escapeHtml(codeText)}</code></pre>
      </section>
    `;

    highlightCode(root);

  } catch (err) {
    root.innerHTML = `
      <section class="code-panel">
        <p class="code-panel-error">
          Could not load code artefact for
          <code>${escapeHtml(TARGET_SOLUTION_IRI)}</code>:
          ${escapeHtml(err?.message || String(err))}
        </p>
      </section>
    `;
  }
}


window.addEventListener("DOMContentLoaded", () => {
  panes.initLeftTabs();
  renderCodePanel();
});

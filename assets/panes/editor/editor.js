import app from "@core/queries.js";
import panes from "@core/panes.js";
import { mountTemplate, fetchRepoText, resolveEl, applyTemplate } from "@core/utils.js";

// module-relative URLs (works on localhost + GH Pages)
const HTML = new URL("./editor.html", import.meta.url);
const CSS  = new URL("./editor.css",  import.meta.url);

// ---- Config: which write actions are offered in the editor ----

const ACTIONS = [
  {
    id: "create-gsn-element",
    label: "Create GSN node",
    templatePath: "data/queries/create_gsn_element.sparql",
    fields: [
      { name: "ID",      label: "Identifier (e.g. G1.1)", placeholder: "G1.1" },
      { name: "IRI",     label: "Local name (e.g. car_G1_1)", placeholder: "car_G1_1" },
      { name: "LABEL",   label: "Label", placeholder: "Goal label..." },
      { name: "STATEMENT", label: "Statement", placeholder: "Description..." }
    ]
  },
  // Add more actions as needed...
];

// ---- UI wiring ----

async function initEditorUI() {
  const root = resolveEl("#editor-root", { required: false, name: "Editor view: #editor-root" });
  if (!root) return;

  await app.init();

  await mountTemplate(root, { templateUrl: HTML, cssUrl: CSS });

  const actionSelect    = resolveEl("#editor-action",  { root, name: "Editor view: #editor-action" });
  const typeSelect      = resolveEl("#editor-type",    { root, name: "Editor view: #editor-type" });
  const fieldsContainer = resolveEl("#editor-fields",  { root, name: "Editor view: #editor-fields" });
  const runBtn          = resolveEl("#editor-run",     { root, name: "Editor view: #editor-run" });
  const previewEl       = resolveEl("#editor-preview", { root, name: "Editor view: #editor-preview" });

  // Populate action dropdown
  actionSelect.innerHTML = "";
  for (const action of ACTIONS) {
    const opt = document.createElement("option");
    opt.value = action.id;
    opt.textContent = action.label;
    actionSelect.appendChild(opt);
  }

  function renderFields(action) {
    fieldsContainer.innerHTML = "";
    for (const f of action.fields) {
      const wrapper = document.createElement("div");
      wrapper.className = "editor-field";

      wrapper.innerHTML = `
        <label>
          ${f.label}<br/>
          <input name="${f.name}"
                type="text"
                placeholder="${f.placeholder ?? ""}">
        </label>
      `;
      fieldsContainer.appendChild(wrapper);
    }
  }

  function getCurrentAction() {
    return ACTIONS.find(a => a.id === actionSelect.value) || ACTIONS[0];
  }

  actionSelect.addEventListener("change", () => {
    renderFields(getCurrentAction());
    previewEl.textContent = "";
  });

  function shortenGsnType(iri) {
    const base = "https://w3id.org/OntoGSN/ontology#";
    if (iri.startsWith(base)) return "gsn:" + iri.slice(base.length);
    return iri;
  }

  async function loadGsnTypes() {
    const q = await fetchRepoText("data/queries/read_allowed_gsnElements.sparql", {
      from: import.meta.url,
      upLevels: 2,
      cache: "no-store",
      bust: true
    });

    const rows = await app.selectBindings(q);

    typeSelect.innerHTML = "";
    for (const row of rows || []) {
      const iri = row.type?.value;
      if (!iri) continue;

      const short = shortenGsnType(iri);
      const opt = document.createElement("option");
      opt.value = short;
      opt.textContent = short;
      typeSelect.appendChild(opt);
    }

    if (!typeSelect.children.length) {
      console.warn("No subclasses of gsn:GSNElement found by read_allowed_gsnElements.sparql");
    }
  }

  // Initial render + load type list
  renderFields(getCurrentAction());
  await loadGsnTypes();

  // Cache templates so we don't re-fetch every time
  const templateCache = new Map();

  async function getTemplate(action) {
    if (templateCache.has(action.id)) return templateCache.get(action.id);

    const txt = await fetchRepoText(action.templatePath, {
      from: import.meta.url,
      upLevels: 2,
      cache: "no-store",
      bust: true
    });

    templateCache.set(action.id, txt);
    return txt;
  }

  runBtn.addEventListener("click", async () => {
    const action = getCurrentAction();
    const values = {};

    for (const f of action.fields) {
      const input = fieldsContainer.querySelector(`input[name="${f.name}"]`);
      values[f.name] = (input?.value ?? "").trim();
    }

    const selectedType = typeSelect.value;
    if (!selectedType) {
      alert("Please choose a GSN element type.");
      return;
    }
    values.TYPE = selectedType;

    const tmpl = await getTemplate(action);
    const finalQuery = applyTemplate(tmpl, values);

    previewEl.textContent = finalQuery;

    await app.runInline(finalQuery, null, { noTable: true });
  });

}

// Boot
window.addEventListener("DOMContentLoaded", () => {
  panes.initLeftTabs();
  initEditorUI();
});

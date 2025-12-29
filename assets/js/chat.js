import app from "./queries.js";
import { mountTemplate, resolveEl, bindingsToRows, escapeHtml } from "./utils.js";

// module-relative URLs (works on localhost + GH Pages)
const HTML = new URL("../html/chat.html", import.meta.url);
const CSS  = new URL("../css/chat.css",  import.meta.url);

// --- tiny helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);

// Grab or persist the key/model locally
const KEY_K = "openrouter_api_key";
const MODEL_K = "openrouter_model";

async function buildChatUI() {
  const root = resolveEl("#chat-root", { name: "chat.js: #chat-root", required: false });
  if (!root || root.dataset.initialised === "1") return;
  root.dataset.initialised = "1";

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    cache: "no-store", bust: true // for dev while iterating
  });

  const keyEl   = root.querySelector("#chat-key");
  const modelEl = root.querySelector("#chat-model");

  if (keyEl)   keyEl.value   = localStorage.getItem(KEY_K)   || "";
  if (modelEl) modelEl.value = localStorage.getItem(MODEL_K) || modelEl.value;

  const formEl = root.querySelector("#chat-form");
  if (formEl) formEl.addEventListener("submit", onChatSubmit);

}

// Make sure Oxigraph is ready
async function ensureStore() {
  if (!app.store) await app.init?.(); // no-op if already initialized
  return app.store;
}

// Naive keyword extraction (keep 3–5 useful tokens)
function keywords(q) {
  return Array.from(new Set(
    q.toLowerCase().split(/[^a-z0-9_:\-]+/i)
      .filter(w => w.length > 2 && w !== "the" && w !== "and")
  )).slice(0, 5);
}

function makeContextQuery(words) {
  const pats = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const rx = pats.map(p => {
    const s = JSON.stringify(p); // safe SPARQL string literal
    return [
      `regex(str(?s), ${s}, "i")`,
      `regex(str(?label), ${s}, "i")`,
      `regex(str(?id), ${s}, "i")`,
      `regex(str(?statement), ${s}, "i")`,
    ].join(" || ");
  }).join(" || ");

  return `
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema:<https://schema.org/>
PREFIX gsn:   <https://w3id.org/OntoGSN/ontology#>

SELECT DISTINCT ?s ?label ?id ?statement
WHERE {
  OPTIONAL { ?s rdfs:label ?label }
  OPTIONAL { ?s schema:identifier ?id }
  OPTIONAL { ?s gsn:statement ?statement }
  FILTER(${rx})
}
LIMIT 30`;
}


// Expand immediate graph around the top N candidates
function makeNeighborhoodQuery(ids) {
  const vals = ids.map(i => `<${i}>`).join(" ");
  return `
SELECT ?s ?p ?o
WHERE {
  VALUES ?s { ${vals} }
  ?s ?p ?o .
}
LIMIT 200`;
}

// Query store for context block
async function gatherContext(question) {
  const store = await ensureStore();
  const kws = keywords(question);
  if (!kws.length) return { synopsis: "", triples: [] };

  const q1 = makeContextQuery(kws);
  const r1 = store.query(q1);
  const rows1 = bindingsToRows(r1);
  const ids = rows1.map(r => r.s).filter(Boolean).slice(0, 12);

  let triples = [];
  if (ids.length) {
    const q2 = makeNeighborhoodQuery(ids);
    const r2 = store.query(q2);
    triples = bindingsToRows(r2).map(({ s, p, o }) => ({ s, p, o }));
  }

  // Short, LLM-friendly synopsis
  const topLines = rows1.slice(0, 12).map(r =>
    `• ${r.id ?? r.label ?? r.s}  [${r.s}]`
  ).join("\n");

  return {
    synopsis: topLines,
    triples
  };
}

// Call OpenRouter (non-streaming for simplicity)
// Docs: POST https://openrouter.ai/api/v1/chat/completions + headers. :contentReference[oaicite:2]{index=2}
async function askOpenRouter({ apiKey, model, messages }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": location.origin, // optional attribution
      "X-Title": "OntoGSN Chat (local)" // optional attribution
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 10000,
      //stream: true
      // You can set stream: true and handle SSE later if you want typing. :contentReference[oaicite:3]{index=3}
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t}`);
  }
  const data = await res.json();
  const c = data?.choices?.[0]?.message?.content || "";
  return c;
}

// --- UI wiring --------------------------------------------------------------
function appendMsg(role, html) {
  const log = $("#chat-log");
  if (!log) return; // or throw; your choice

  const el = document.createElement("div");
  el.className = role === "user" ? "msg user" : "msg bot";
  el.style.cssText = "margin:.25rem 0;padding:.35rem .5rem;border-radius:.5rem;background:#f7f7f7;";
  el.innerHTML = html;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

async function onChatSubmit(ev) {
  ev.preventDefault();

  const apiKeyEl = /** @type {HTMLInputElement|null} */ ($("#chat-key"));
  const modelEl  = /** @type {HTMLInputElement|null} */ ($("#chat-model"));
  const inputEl  = /** @type {HTMLTextAreaElement|null} */ ($("#chat-input"));
  const sendBtn  = /** @type {HTMLButtonElement|null} */ ($("#chat-send"));

  if (!apiKeyEl || !modelEl || !inputEl || !sendBtn) return;

  const apiKey = apiKeyEl.value.trim();
  const model  = modelEl.value.trim() || "openai/gpt-4o-mini";
  const q      = inputEl.value.trim();

  if (!apiKey) { alert("Paste your OpenRouter API key first."); return; }
  if (!q) return;

  // persist locally
  localStorage.setItem(KEY_K, apiKey);
  localStorage.setItem(MODEL_K, model);

  appendMsg("user", escapeHtml(q));
  inputEl.value = "";
  sendBtn.disabled = true;

  try {
    const { synopsis, triples } = await gatherContext(q);
    const contextBlock =
`You are the OntoGSN assistant. Use the provided *Knowledge Graph context* to answer briefly and accurately.
- Prefer concrete node identifiers (like G1, C1, Sn1) when relevant.
- If the answer is not supported by the context, say you don't know and why (for example, you received no context data).
- Key relations: gsn:supportedBy, gsn:inContextOf, gsn:challenges, prov:Collection links.

[Knowledge Graph context — nodes]
${synopsis || "(no close matches)"}

[Knowledge Graph context — triples]
${triples.slice(0, 120).map(t => `${t.s}  ${t.p}  ${t.o}`).join("\n")}`;

    const messages = [
      { role: "system", content: "You answer questions about an assurance case represented in a GSN-like ontology." },
      { role: "user", content: `${q}\n\n${contextBlock}` }
    ];

    const answer = await askOpenRouter({ apiKey, model, messages });
    appendMsg("bot", escapeHtml(answer));
  } catch (e) {
    appendMsg("bot", `<em>${escapeHtml(e.message)}</em>`);
  } finally {
    sendBtn.disabled = false;
  }
}

// Initialise chat UI once DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  buildChatUI();
});
import app from "@core/queries.js";
import panes from "@core/panes.js";
import { bus } from "@core/events.js";

import {
  mountTemplate,
  resolveEl,
  fetchRepoTextCached,
  bindingsToRows,
  escapeHtml,
  sparqlIri,
  safeInvoke
} from "@core/utils.js";

// module-relative URLs (works on localhost + GH Pages)
const HTML = new URL("./chat.html", import.meta.url);
const CSS  = new URL("./chat.css",  import.meta.url);

// repo paths (resolved via fetchRepoTextCached + from/upLevels)
const Q_CONTEXT = "data/queries/chat_context.sparql";
const Q_NEIGH   = "data/queries/chat_neighborhood.sparql";

// localStorage keys
const KEY_K   = "openrouter_api_key";
const MODEL_K = "openrouter_model";

let _init = false;
let _root = null;

// ---- helpers -------------------------------------------------------------

function normCmd(s) {
  return String(s ?? "").trim();
}

// Make sure Oxigraph is ready
async function ensureStore() {
  if (!app.store) await app.init();
  return app.store;
}

// Naive keyword extraction (keep 3–5 useful tokens)
function keywords(q) {
  return Array.from(new Set(
    q.toLowerCase().split(/[^a-z0-9_:\-]+/i)
      .filter(w => w.length > 2 && w !== "the" && w !== "and")
  )).slice(0, 5);
}

function escapeRegexLiteral(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadQueryText(path) {
  return fetchRepoTextCached(path, {
    from: import.meta.url,
    upLevels: 2,
    cache: "no-store",
    bust: true
  });
}

async function makeContextQuery(words) {
  const tpl = await loadQueryText(Q_CONTEXT);

  const pats = words.map(escapeRegexLiteral);

  const rx = pats.map(p => {
    const s = JSON.stringify(p); // safe SPARQL string literal
    return [
      `regex(str(?s), ${s}, "i")`,
      `regex(str(?label), ${s}, "i")`,
      `regex(str(?id), ${s}, "i")`,
      `regex(str(?statement), ${s}, "i")`,
    ].join(" || ");
  }).join(" || ");

  return tpl.replaceAll("__RX__", rx || "true");
}

async function makeNeighborhoodQuery(ids) {
  const tpl = await loadQueryText(Q_NEIGH);

  // ensure valid IRIs for SPARQL VALUES
  const vals = ids
    .map(s => String(s ?? "").trim())
    .filter(Boolean)
    .map(sparqlIri)
    .join(" ");

  return tpl.replaceAll("__VALS__", vals || "<urn:dummy>");
}

async function gatherContext(question) {
  const store = await ensureStore();

  const kws = keywords(question);
  if (!kws.length) return { synopsis: "", triples: [] };

  const q1 = await makeContextQuery(kws);
  const rows1 = bindingsToRows(store.query(q1));

  const ids = rows1
    .map(r => r.s)
    .filter(Boolean)
    .slice(0, 12);

  let triples = [];
  if (ids.length) {
    const q2 = await makeNeighborhoodQuery(ids);
    triples = bindingsToRows(store.query(q2)).map(({ s, p, o }) => ({ s, p, o }));
  }

  const topLines = rows1.slice(0, 12).map(r =>
    `• ${r.id ?? r.label ?? r.s}  [${r.s}]`
  ).join("\n");

  return { synopsis: topLines, triples };
}

// Call OpenRouter (non-streaming)
async function askOpenRouter({ apiKey, model, messages }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": location.origin,
      "X-Title": "OntoGSN Chat"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 10000
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// ---- pane UI -------------------------------------------------------------

function appendMsg(root, role, html) {
  const log = resolveEl("#chat-log", { root, required: false, name: "chat: #chat-log" });
  if (!log) return;

  const el = document.createElement("div");
  el.className = role === "user" ? "msg user" : "msg bot";

  // keep the minimal styling, but ideally your chat.css handles this
  el.style.cssText =
    "margin:.25rem 0;padding:.35rem .5rem;border-radius:.5rem;background:#f7f7f7;";

  el.innerHTML = html;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function setBusy(root, on) {
  const sendBtn = resolveEl("#chat-send", { root, required: false });
  const inputEl = resolveEl("#chat-input", { root, required: false });
  if (sendBtn) sendBtn.disabled = !!on;
  if (inputEl) inputEl.disabled = !!on;
}

async function onChatSubmit(ev) {
  ev.preventDefault();
  if (!_root) return;

  const apiKeyEl = resolveEl("#chat-key",   { root: _root, required: false });
  const modelEl  = resolveEl("#chat-model", { root: _root, required: false });
  const inputEl  = resolveEl("#chat-input", { root: _root, required: false });

  if (!apiKeyEl || !modelEl || !inputEl) return;

  const apiKey = normCmd(apiKeyEl.value);
  const model  = normCmd(modelEl.value) || "openai/gpt-4o-mini";
  const q      = normCmd(inputEl.value);

  if (!apiKey) {
    alert("Paste your OpenRouter API key first.");
    return;
  }
  if (!q) return;

  // persist locally
  localStorage.setItem(KEY_K, apiKey);
  localStorage.setItem(MODEL_K, model);

  appendMsg(_root, "user", escapeHtml(q));
  inputEl.value = "";
  setBusy(_root, true);

  try {
    const { synopsis, triples } = await gatherContext(q);

    const contextBlock =
`You are the OntoGSN assistant. Use the provided *Knowledge Graph context* to answer briefly and accurately.
- Prefer concrete node identifiers (like G1, C1, Sn1) when relevant.
- If the answer is not supported by the context, say you don't know and why.
- Key relations: gsn:supportedBy, gsn:inContextOf, gsn:challenges, prov:Collection links.

[Knowledge Graph context — nodes]
${synopsis || "(no close matches)"}

[Knowledge Graph context — triples]
${triples.slice(0, 120).map(t => `${t.s}  ${t.p}  ${t.o}`).join("\n")}`;

    const messages = [
      {
        role: "system",
        content: "You answer questions about an assurance case represented in a GSN-like ontology."
      },
      {
        role: "user",
        content: `${q}\n\n${contextBlock}`
      }
    ];

    const answer = await askOpenRouter({ apiKey, model, messages });
    appendMsg(_root, "bot", escapeHtml(answer));
  } catch (e) {
    appendMsg(_root, "bot", `<em>${escapeHtml(e?.message || String(e))}</em>`);
  } finally {
    setBusy(_root, false);
  }
}

async function initChatPane() {
  if (_init) return;
  _init = true;

  panes.initLeftTabs?.();

  const root = resolveEl("#chat-root", { name: "chat.js: #chat-root", required: false });
  if (!root || root.dataset.initialised === "1") return;
  root.dataset.initialised = "1";

  _root = root;

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    cache: "no-store",
    bust: true
  });

  // restore key/model
  const keyEl   = resolveEl("#chat-key",   { root, required: false });
  const modelEl = resolveEl("#chat-model", { root, required: false });

  if (keyEl)   keyEl.value   = localStorage.getItem(KEY_K) || "";
  if (modelEl) modelEl.value = localStorage.getItem(MODEL_K) || modelEl.value;

  const formEl = resolveEl("#chat-form", { root, required: false });
  formEl?.addEventListener("submit", onChatSubmit);

  // focus input when the pane becomes active
  bus.on("left:tab", (ev) => {
    const d = ev?.detail || {};
    const isChat =
      d.view === "chat" ||
      d.paneId === "chat-root" ||
      d.tabId === "tab-chat";

    if (!isChat) return;

    setTimeout(() => {
      resolveEl("#chat-input", { root, required: false })?.focus();
    }, 0);
  });

  // optional: external panes can auto-run a question
  bus.on("chat:ask", async (ev) => {
    const q = String(ev?.detail?.question ?? "").trim();
    if (!q) return;

    const inputEl = resolveEl("#chat-input", { root, required: false });
    if (inputEl) inputEl.value = q;

    // submit programmatically
    safeInvoke(formEl, "dispatchEvent", new Event("submit", { bubbles: true, cancelable: true }));
  });
}

// boot
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initChatPane);
} else {
  initChatPane();
}

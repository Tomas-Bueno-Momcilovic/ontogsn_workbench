// Cache fetched text by normalized URL
const _textCache = new Map();   // key: url.href -> string
const _cssLinked = new Set();   // key: url.href -> true

function _asUrl(u) {
  // Normalize to absolute URL so comparisons are stable across pages/base paths.
  return (u instanceof URL) ? u : new URL(String(u), document.baseURI);
}

/**
 * Fetch text with optional caching.
 * - cache: "force-cache" (default) is good for GH Pages / production.
 * - for dev, use cache:"no-store" or bust:true
 */
export async function fetchText(url, { cache = "force-cache", bust = false } = {}) {
  const u = _asUrl(url);
  const key = u.href;

  const memoize = (!bust && cache !== "no-store");

  if (memoize && _textCache.has(key)) return _textCache.get(key);

  const reqUrl = new URL(u.href);
  if (bust) reqUrl.searchParams.set("v", String(performance.timeOrigin));

  const res = await fetch(reqUrl.href, { cache });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${reqUrl.href}`);

  const txt = (await res.text()).replace(/^\uFEFF/, "");
  if (memoize) _textCache.set(key, txt);
  return txt;
}

export function asBool(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

export function asBoolText(v) {
  if (v == null) return "";
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "false") return s;
  return String(v);
}

export function pickBindingValue(row, name, fallback = "") {
  const cell = row?.[name];
  return cell?.value ?? fallback;
}

export function sparqlIri(iri) {
  const s = String(iri ?? "").trim();
  if (!s) return "";
  if (/[<>\s]/.test(s)) throw new Error(`Invalid IRI for SPARQL: ${s}`);
  return `<${s}>`;
}

const _repoTextCache = new Map(); // key: path -> text

export async function fetchRepoTextCached(path, fetchOpts) {
  if (_repoTextCache.has(path)) return _repoTextCache.get(path);
  const txt = await fetchRepoText(path, fetchOpts);
  _repoTextCache.set(path, txt);
  return txt;
}


// Join "/assets/..." against the repo root (not the site origin root).
export function repoHref(path, { from = import.meta.url, upLevels = 2 } = {}) {
  const base = repoBasePath(from, upLevels); // no trailing slash
  const s = String(path ?? "");

  // Already an absolute URL (http:, https:, data:, blob:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;

  if (s.startsWith("#") || s.startsWith("?")) return `${base}/${s}`;

  // Treat leading "/" as repo-relative (so it becomes `${base}/assets/...`, not `origin/assets/...`)
  return `${base}${s.startsWith("/") ? "" : "/"}${s}`;
}

export async function fetchRepoText(path, { from = import.meta.url, upLevels = 2, ...opts } = {}) {
  return fetchText(repoHref(path, { from, upLevels }), opts);
}

/**
 * Load an HTML file and return a fresh DocumentFragment each call.
 */
export async function loadTemplate(url, opts) {
  const html = await fetchText(url, opts);
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.cloneNode(true);
}

/**
 * Ensure a stylesheet is linked only once.
 */
export function ensureCss(href) {
  const u = _asUrl(href);
  const key = u.href;

  if (_cssLinked.has(key)) return;

  // If already present in DOM (e.g., added by another module), record and exit.
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    try {
      if (new URL(l.href, document.baseURI).href === key) {
        _cssLinked.add(key);
        return;
      }
    } catch { /* ignore */ }
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = key;
  document.head.appendChild(link);

  _cssLinked.add(key);
}

/**
 * Convenience: ensureCss + mount template into root.
 */
export async function mountTemplate(rootEl, {
  templateUrl = null, // OPTIONAL now
  cssUrl = null,      // already optional
  replace = true,
  cache = "force-cache",
  bust = false
} = {}) {
  if (!rootEl) return null;

  if (cssUrl) {
    const arr = Array.isArray(cssUrl) ? cssUrl : [cssUrl];
    for (const u of arr) ensureCss(u);
  }

  // If no templateUrl provided, do nothing template-wise (CSS-only mount).
  if (!templateUrl) return rootEl;

  const frag = await loadTemplate(templateUrl, { cache, bust });
  if (replace) rootEl.replaceChildren(frag);
  else rootEl.appendChild(frag);

  return rootEl;
}

export function resolveEl(mount, { root = document, required = true, name = "mount" } = {}) {
  const rootEl = (typeof root === "string") ? document.querySelector(root) : root;
  const el = (typeof mount === "string") ? rootEl?.querySelector(mount) : mount;

  if (!el && required) {
    const where = rootEl ? "" : " (root not found)";
    throw new Error(`${name}: ${typeof mount === "string" ? `"${mount}"` : "(element)"} not found${where}`);
  }
  return el;
}

export function exposeForDebug(name, value, { param = "debug" } = {}) {
  if (new URLSearchParams(location.search).has(param)) {
    window[name] = value;
  }
}

export function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

export function uid(prefix = "") {
  const id = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
  return prefix ? `${prefix}${id}` : id;
}

export function splitTokens(raw, re = /[;,]/) {
  return String(raw ?? "")
    .split(re)
    .map(s => s.trim())
    .filter(Boolean);
}

export function repoBaseUrl(from = import.meta.url, upLevels = 2) {
  let u = new URL(from);
  for (let i = 0; i < upLevels; i++) u = new URL("../", u);
  return u;
}

export function repoBasePath(from = import.meta.url, upLevels = 2) {
  const u = repoBaseUrl(from, upLevels);
  const s = u.protocol.startsWith("http") ? u.href : u.pathname;
  return s.replace(/\/$/, "");
}

export function downloadText(filename, text, { mime = "text/plain" } = {}) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;

  (document.body ?? document.documentElement).appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}


export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function termToDisplay(cell) {
  if (cell == null) return "";

  // app.selectBindings often returns { value, term }
  const t = cell?.term ?? cell;

  // If we don't have a real RDFJS-like term, fall back to .value or string
  if (!t || typeof t !== "object" || !("termType" in t)) {
    return String(cell?.value ?? cell);
  }

  switch (t.termType) {
    case "NamedNode": return t.value;
    case "BlankNode": return "_:" + t.value;
    case "Literal": {
      const dt = t.datatype?.value;
      const lg = t.language;
      if (lg) return `"${t.value}"@${lg}`;
      if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
        return `"${t.value}"^^${dt}`;
      }
      return t.value;
    }
    default:
      return t.value ?? String(cell?.value ?? cell);
  }
}

export function bindingsToRows(iter) {
  const rows = [];
  for (const b of iter) {
    const obj = {};
    for (const [k, v] of b) obj[k] = termToDisplay(v);
    rows.push(obj);
  }
  return rows;
}

export function highlightCode(root = document) {
  if (!window.hljs) return;
  root.querySelectorAll("pre code").forEach(block => window.hljs.highlightElement(block));
}

export function readFileText(file, { encoding = "utf-8" } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.onload  = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file, encoding);
  });
}

export function turtleEscapeLiteral(str) {
  return String(str)
    .replace(/(["\\])/g, "\\$1")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function turtleEscapeMultilineLiteral(str) {
  return String(str).replace(/"""/g, '\\"""');
}

export function applyTemplate(template, values) {
  let out = String(template ?? "");
  const obj = values ?? {};
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    // Escape key for regex safety
    const key = String(rawKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re  = new RegExp(`{{${key}}}`, "g");
    const val = String(rawVal ?? "");

    // Use function replacement so "$1", "$&", etc in val are NOT treated specially
    out = out.replace(re, () => val);
  }
  return out;
}

export function shortenIri(iriOrLabel) {
  try {
    const u = new URL(String(iriOrLabel));
    if (u.hash && u.hash.length > 1) return u.hash.slice(1);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || String(iriOrLabel);
  } catch {
    return String(iriOrLabel ?? "").replace(/^.*[#/]/, "");
  }
}

export function labelWidthPx(text, {
  minW = 44,
  maxW = 180,
  charW = 7.2,
  pad = 12
} = {}) {
  const t = String(text ?? "");
  return Math.min(maxW, Math.max(minW, charW * t.length + pad));
}

export function gsnKindFromTypeIri(typeIri) {
  if (!typeIri) return null;
  const t = String(typeIri);

  if (t.endsWith("#Goal")          || t.endsWith("/Goal"))          return "goal";
  if (t.endsWith("#Strategy")      || t.endsWith("/Strategy"))      return "strategy";
  if (t.endsWith("#Solution")      || t.endsWith("/Solution"))      return "solution";
  if (t.endsWith("#Context")       || t.endsWith("/Context"))       return "context";
  if (t.endsWith("#Assumption")    || t.endsWith("/Assumption"))    return "assumption";
  if (t.endsWith("#Justification") || t.endsWith("/Justification")) return "justification";

  return null;
}

export function inferGsnKind(id, labelText, typeIri) {
  const fromType = gsnKindFromTypeIri(typeIri);
  if (fromType) return fromType;

  const txt = String(labelText || id || "");
  const p2  = txt.slice(0, 2).toUpperCase();
  const p1  = txt.charAt(0).toUpperCase();

  if (p2 === "SN") return "solution";
  if (p1 === "S")  return "strategy";
  if (p1 === "C")  return "context";
  if (p1 === "A")  return "assumption";
  if (p1 === "J")  return "justification";

  return "goal";
}

export function firstEl(selectors, { root = document } = {}) {
  const rootEl = (typeof root === "string") ? document.querySelector(root) : root;
  for (const sel of selectors) {
    const el = (typeof sel === "string") ? rootEl?.querySelector(sel) : sel;
    if (el) return el;
  }
  return null;
}

export function safeInvoke(obj, method, ...args) {
  const fn = obj?.[method];
  if (typeof fn !== "function") return;
  try {
    return fn.apply(obj, args);
  } catch (e) {
    console.warn(`[safeInvoke] ${method} failed:`, e);
  }
}

export function cleanRdfLiteral(x) {
  const s = String(x ?? "").trim();

  // matches: "Text"@en  OR  "Text"^^<datatype>
  const m = s.match(/^"([\s\S]*)"(?:@[\w-]+|\^\^.+)?$/);
  return m ? m[1] : s;
}

export function loadLocalBool(key, { defaultValue = true } = {}) {
  const v = localStorage.getItem(String(key));
  if (v == null) return !!defaultValue;
  return v !== "0" && v !== "false";
}

export function saveLocalBool(key, value) {
  localStorage.setItem(String(key), value ? "1" : "0");
}

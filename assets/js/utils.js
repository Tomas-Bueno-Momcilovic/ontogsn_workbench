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

  if (!bust && _textCache.has(key)) return _textCache.get(key);

  const reqUrl = new URL(u.href);
  if (bust) reqUrl.searchParams.set("v", String(performance.timeOrigin));

  const res = await fetch(reqUrl.href, { cache });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${reqUrl.href}`);

  const txt = (await res.text()).replace(/^\uFEFF/, "");
  if (!bust) _textCache.set(key, txt);
  return txt;
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


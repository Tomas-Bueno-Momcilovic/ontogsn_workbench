import { resolveEl } from "@core/utils.js";
import { openRouterChatCompletions } from "@core/openrouter.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4.6";

const DEFAULT_PROMPT =
  "Describe the image clearly. If there is text, transcribe it. " +
  "If it's a UI/screenshot, summarize the visible elements and their state. " +
  "Be concise but specific. Single-line output only, 4 sentences max.";

function blobToDataURL(blob) {
  // fallback (rarely used once we convert)
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read image as data URL."));
    r.readAsDataURL(blob);
  });
}

async function blobToJpegDataURL(
  blob,
  {
    maxW = 1600,
    maxH = 1600,
    quality = 0.86,
  } = {}
) {
  // Use createImageBitmap when available (fast, avoids DOM Image decode issues)
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // Fallback: decode via <img>
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image decode failed."));
        el.src = url;
      });

      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;

      const s = Math.min(1, maxW / w0, maxH / h0);
      const w = Math.max(1, Math.round(w0 * s));
      const h = Math.max(1, Math.round(h0 * s));

      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { alpha: false });

      ctx.drawImage(img, 0, 0, w, h);

      // Prefer JPEG; providers almost always accept it
      return c.toDataURL("image/jpeg", quality);
    } finally {
      try { URL.revokeObjectURL(url); } catch { }
    }
  }

  // createImageBitmap path
  const w0 = bitmap.width;
  const h0 = bitmap.height;

  const s = Math.min(1, maxW / w0, maxH / h0);
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));

  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { alpha: false });

  ctx.drawImage(bitmap, 0, 0, w, h);

  try { bitmap.close?.(); } catch { }

  return c.toDataURL("image/jpeg", quality);
}


async function loadApiKeyFromTxt() {
  const url = new URL("./api.txt", import.meta.url);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Missing api.txt (expected at ${url.pathname}). Create it with your OpenRouter key.`
    );
  }
  const raw = await res.text();

  const line =
    raw
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#")) || "";

  if (!line) throw new Error("api.txt is empty.");
  return line;
}

export function wireImageDescribeAI(opts = {}) {
  const {
    root,
    getImageBlob = () => null,
    setBusy = () => { },
    setStatus = () => { },
    setOutput = () => { },
    emit = () => { },
    title = "OntoGSN Workbench (Image pane)",
    model = DEFAULT_MODEL,
    prompt = DEFAULT_PROMPT,
  } = opts;

  const els = {
    btn: resolveEl("#image-describe", { root, required: false }),
  };

  let _busy = false;
  let _apiKey = null;

  function _setBusy(v) {
    _busy = !!v;
    try {
      setBusy(_busy);
    } catch { }
  }

  async function _ensureApiKey() {
    if (_apiKey) return _apiKey;
    _apiKey = await loadApiKeyFromTxt();
    return _apiKey;
  }

  async function _describe() {
    const blob = getImageBlob();
    if (!blob) {
      setStatus("No image loaded.");
      return;
    }

    _setBusy(true);
    setOutput("");
    setStatus("Describing image...");

    try {
      const apiKey = await _ensureApiKey();
      const dataUrl = await blobToJpegDataURL(blob, {
        maxW: 1600,
        maxH: 1600,
        quality: 0.86,
      });

      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ];

      const data = await openRouterChatCompletions({
        apiKey,
        model,
        messages,
        temperature: 0.2,
        maxTokens: 800,
        title,
      });

      const text = String(data?.choices?.[0]?.message?.content || "");
      setOutput(text);

      emit("image:described", { model, text, copied: false, raw: data });

      try {
        console.log("[image:described]", { model, copied: false, text });
      } catch { }

      setStatus("Description ready below.");
    } catch (err) {
      setOutput("");
      const msg = `Describe error: ${err?.message || String(err)}`;
      emit("image:describe:error", { error: msg });
      setStatus(msg);
    } finally {
      _setBusy(false);
    }
  }

  if (els.btn) {
    els.btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (_busy) return;
      _describe();
    });
  }

  return {
    destroy() {
      // Nothing to unhook beyond letting GC collect.
    },
  };
}

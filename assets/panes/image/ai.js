import { resolveEl } from "@core/utils.js";
import { openRouterChatCompletions } from "@core/openrouter.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4.6";

// Boilerplate prompt (change later as you like)
const DEFAULT_PROMPT =
  "Describe the image clearly. If there is text, transcribe it. " +
  "If it's a UI/screenshot, summarize the visible elements and their state. " +
  "Be concise but specific.";

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read image as data URL."));
    r.readAsDataURL(blob);
  });
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

  // First non-empty, non-comment line
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
    setBusy = () => {},
    setStatus = () => {},
    emit = () => {},
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
    try { setBusy(_busy); } catch {}
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
    setStatus("Describing image…");

    try {
      const apiKey = await _ensureApiKey();
      const dataUrl = await blobToDataURL(blob);

      // OpenRouter: text first, then image. Image can be base64 data URL.
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

      const text = data?.choices?.[0]?.message?.content || "";

      // Best-effort: copy to clipboard (no extra UI)
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {}

      // Emit for other panes / orchestrator / logs
      emit("image:described", { model, text, copied, raw: data });

      // Also log for dev convenience
      try { console.log("[image:described]", { model, copied, text }); } catch {}

      setStatus(copied ? "Description copied to clipboard." : "Description ready (see console / event).");
    } catch (err) {
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
      // nothing to unhook beyond letting GC collect; button is inside pane DOM
    },
  };
}

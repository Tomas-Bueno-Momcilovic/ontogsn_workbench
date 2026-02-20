import {
  loadOpenRouterPrefs,
  saveOpenRouterPrefs,
  openRouterChatCompletions,
  OPENROUTER_DEFAULT_MODEL,
  buildOpenRouterHeaders,
} from "@core/openrouter.js";

const API_TXT_URL = new URL("./api.txt", import.meta.url);
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Store the video pane model separately so it doesn't inherit a non-video model
const VIDEO_MODEL_KEY = "openrouter_video_model";

// Cache of models that actually support video input (filled by ensureOpenRouterVideoModels)
let VIDEO_MODEL_IDS = new Set();

// Fallback list if /models fetch fails.
// IMPORTANT: Pick models that *actually* advertise input_modalities: ["video", ...] on OpenRouter.
const FALLBACK_VIDEO_MODELS = [
  // Replace these with whatever your /api/v1/models shows as video-capable
  { id: "minimax/minimax-m2.5" },
  { id: "minimax/minimax-m2.1" },
  { id: "qwen/qwen3.5-397b-a17b" },
];

// Frame sampling defaults (no UI)
const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_FRAME_MAX_W = 640;
const DEFAULT_JPEG_QUALITY = 0.72;

let _keyInfoPromise = null;

async function loadApiKeyInfo({ signal } = {}) {
  if (_keyInfoPromise) return _keyInfoPromise;

  _keyInfoPromise = (async () => {
    const res = await fetch(API_TXT_URL, { cache: "no-store", signal });
    if (!res.ok) return { ok: false, key: "" };
    const key = ((await res.text()) || "").trim();
    return { ok: true, key };
  })();

  return _keyInfoPromise;
}

async function loadApiKeyOptional(signal) {
  const info = await loadApiKeyInfo({ signal });
  return info.ok ? info.key : "";
}

async function loadApiKeyRequired(signal) {
  const info = await loadApiKeyInfo({ signal });
  if (!info.ok) {
    throw new Error("Missing api.txt (OpenRouter key). Add ./assets/panes/video/api.txt");
  }
  if (!info.key) throw new Error("api.txt is empty.");
  return info.key;
}

async function fetchOpenRouterModels(apiKey, signal) {
  const headers = apiKey
    ? buildOpenRouterHeaders(apiKey, {
      title: "OntoGSN Workbench",
      referer: location.origin,
    })
    : { "Content-Type": "application/json" };

  const res = await fetch(OPENROUTER_MODELS_URL, { headers, signal });
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  const json = await res.json();
  return json?.data || [];
}

async function blobToDataUrl(blob) {
  // Produces: data:video/webm;base64,....
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

function buildMessagesForVideo({ prompt, videoDataUrl, meta }) {
  return [
    {
      role: "system",
      content:
        "You are a careful video description assistant. " +
        "You will receive a video. Describe what happens across time in plain text. " +
        "If uncertain, say so.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `${prompt}\n\n${meta}` },
        { type: "video_url", videoUrl: { url: videoDataUrl } },
      ],
    },
  ];
}

function filterVideoInputModels(models) {
  return (models || []).filter((m) => {
    const ins =
      m?.architecture?.input_modalities ||
      m?.architecture?.inputModalities ||
      m?.input_modalities ||
      m?.inputModalities ||
      [];

    if (
      Array.isArray(ins) &&
      ins.some((x) => String(x || "").toLowerCase() === "video")
    ) return true;

    // Some models express it in the "modality" string (e.g., "video+text->text")
    const modality = m?.architecture?.modality;
    if (typeof modality === "string" && /video/i.test(modality)) return true;

    return false;
  });
}

function ensureOptgroup(selectEl, label, { prepend = false } = {}) {
  if (!selectEl) return null;

  let og = Array.from(selectEl.querySelectorAll("optgroup")).find(
    (g) => (g.getAttribute("label") || "") === label
  );

  if (!og) {
    og = document.createElement("optgroup");
    og.setAttribute("label", label);
    if (prepend) selectEl.prepend(og);
    else selectEl.appendChild(og);
  }

  return og;
}

function replaceOptions(optgroupEl, models) {
  if (!optgroupEl) return;
  optgroupEl.innerHTML = "";

  for (const m of models) {
    const id = m?.id;
    if (!id) continue;

    const name = m?.name || id;

    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id; // show only provider/model
    if (name && name !== id) opt.title = name;

    optgroupEl.appendChild(opt);
  }
}

function hasOption(selectEl, value) {
  if (!selectEl) return false;
  return Array.from(selectEl.querySelectorAll("option")).some((o) => o.value === value);
}

function ensureCustomOption(selectEl, value) {
  const v = String(value || "").trim();
  if (!v || hasOption(selectEl, v)) return;

  const custom = ensureOptgroup(selectEl, "Custom", { prepend: true });
  const opt = document.createElement("option");
  opt.value = v;
  opt.textContent = v;
  custom.appendChild(opt);
}

export async function ensureOpenRouterVideoModels(selectEl, { signal } = {}) {
  if (!selectEl) return;

  // 1) show fallback immediately
  const cloud = ensureOptgroup(selectEl, "Cloud (OpenRouter)");
  replaceOptions(cloud, FALLBACK_VIDEO_MODELS);

  // default VIDEO_MODEL_IDS to fallback (in case /models fetch fails)
  VIDEO_MODEL_IDS = new Set(FALLBACK_VIDEO_MODELS.map(m => String(m?.id || "")).filter(Boolean));

  // 2) load preferred VIDEO model from dedicated key (not the global openrouter_model)
  const pref = String(
    loadOpenRouterPrefs({ modelKey: VIDEO_MODEL_KEY, defaultModel: "" })?.model || ""
  ).trim();

  // Pick an initial model: pref if present, else first fallback, else OPENROUTER_DEFAULT_MODEL
  const initial = pref || FALLBACK_VIDEO_MODELS[0]?.id || OPENROUTER_DEFAULT_MODEL;
  selectEl.value = initial;

  // 3) fetch /models and replace options with ONLY video-capable models
  try {
    const apiKey = await loadApiKeyOptional(signal); // ok if ""
    const all = await fetchOpenRouterModels(apiKey, signal);
    const videoModels = filterVideoInputModels(all);

    if (videoModels.length) {
      videoModels.sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
      replaceOptions(cloud, videoModels);

      VIDEO_MODEL_IDS = new Set(
        videoModels.map(m => String(m?.id || "")).filter(Boolean)
      );

      // Force selection to something that is truly video-capable
      const stored = String(
        loadOpenRouterPrefs({ modelKey: VIDEO_MODEL_KEY, defaultModel: "" })?.model || ""
      ).trim();

      const chosen =
        (stored && VIDEO_MODEL_IDS.has(stored))
          ? stored
          : String(videoModels[0]?.id || "");

      if (chosen) {
        selectEl.value = chosen;
        saveOpenRouterPrefs({ model: chosen, modelKey: VIDEO_MODEL_KEY });
      }
    }
  } catch {
    // keep fallback silently (VIDEO_MODEL_IDS already set to fallback above)
  }
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function prettyBytes(bytes) {
  const b = Math.max(0, Number(bytes || 0));
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function extractAssistantText(respJson) {
  return respJson?.choices?.[0]?.message?.content || "";
}

function usageLine(respJson) {
  const u = respJson?.usage;
  if (!u) return "";
  const pt = u.prompt_tokens ?? u.promptTokens;
  const ct = u.completion_tokens ?? u.completionTokens;
  const tt = u.total_tokens ?? u.totalTokens;
  return `tokens: prompt=${pt ?? "?"}, completion=${ct ?? "?"}, total=${tt ?? "?"}`;
}

function waitEvent(el, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let t = null;
    const on = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      try { el.removeEventListener(name, on); } catch { }
      if (t) clearTimeout(t);
    };
    el.addEventListener(name, on, { once: true });
    if (timeoutMs > 0) {
      t = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${name}`));
      }, timeoutMs);
    }
  });
}

// Robust seek: avoids hanging when seeking to "current" time
async function seekTo(video, t, timeoutMs = 15000) {
  t = Math.max(0, Number(t || 0));

  const dur = Number(video.duration);
  if (Number.isFinite(dur) && dur > 0) t = Math.min(t, Math.max(0, dur - 0.01));

  const cur = Number(video.currentTime || 0);
  if (Number.isFinite(cur) && Math.abs(cur - t) < 0.01 && video.readyState >= 2) return;

  if (video.readyState < 2) {
    await waitEvent(video, "loadeddata", timeoutMs).catch(() => { });
  }

  await new Promise((resolve, reject) => {
    let timer = null;

    const onSeeked = () => cleanup(resolve);
    const onErr = () => cleanup(() => reject(new Error("Video seek failed")));

    const cleanup = (fn) => {
      try { video.removeEventListener("seeked", onSeeked); } catch { }
      try { video.removeEventListener("error", onErr); } catch { }
      if (timer) clearTimeout(timer);
      fn();
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => cleanup(() => reject(new Error("Timeout waiting for seeked"))), timeoutMs);
    }

    try {
      video.currentTime = t;
    } catch {
      waitEvent(video, "loadeddata", timeoutMs).finally(() => {
        try { video.currentTime = t; } catch { }
      });
    }
  });
}

async function captureFramesFromBlob(blob, opts = {}) {
  const framesWanted = clamp(opts.frames ?? DEFAULT_MAX_FRAMES, 1, 24);
  const maxW = clamp(opts.maxWidth ?? DEFAULT_FRAME_MAX_W, 240, 1280);
  const quality = clamp(opts.jpegQuality ?? DEFAULT_JPEG_QUALITY, 0.3, 0.95);

  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;

    await waitEvent(v, "loadedmetadata", 20000);
    await waitEvent(v, "loadeddata", 20000).catch(() => { });

    const duration = Number(v.duration);
    const safeDur = Number.isFinite(duration) && duration > 0 ? duration : 0;

    const times = [];
    if (safeDur > 0) {
      for (let i = 0; i < framesWanted; i++) {
        times.push(((i + 0.5) / framesWanted) * safeDur);
      }
    } else {
      times.push(0);
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const out = [];
    for (const t of times) {
      await seekTo(v, t, 20000);

      const vw = v.videoWidth || 1280;
      const vh = v.videoHeight || 720;
      const scale = Math.min(1, maxW / Math.max(1, vw));

      canvas.width = Math.max(2, Math.round(vw * scale));
      canvas.height = Math.max(2, Math.round(vh * scale));

      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      out.push({ t, dataUrl });
    }

    return { duration: safeDur, frames: out };
  } finally {
    try { URL.revokeObjectURL(url); } catch { }
  }
}

function buildMessagesForFrames({ prompt, frames, meta }) {
  const lines = frames
    .map((f, i) => `Frame ${i + 1}: t=${f.t.toFixed(2)}s`)
    .join("\n");

  const content = [{ type: "text", text: `${prompt}\n\n${meta}\n\nFrames (chronological):\n${lines}` }];
  for (const f of frames) content.push({ type: "image_url", image_url: { url: f.dataUrl } });

  return [
    {
      role: "system",
      content:
        "You are a careful video description assistant. " +
        "You will receive still frames sampled from a video in chronological order (with timestamps). " +
        "Describe what happens across time in plain text. If uncertain, say so.",
    },
    { role: "user", content },
  ];
}

let _apiKeyCache = null;
async function loadApiKey(signal) {
  if (_apiKeyCache) return _apiKeyCache;

  const res = await fetch(API_TXT_URL, { cache: "no-store", signal });
  if (!res.ok) {
    throw new Error("Missing api.txt (OpenRouter key). Add ./assets/panes/video/api.txt");
  }
  const key = (await res.text()).trim();
  if (!key) throw new Error("api.txt is empty.");
  _apiKeyCache = key;
  return key;
}

export function createVideoAI(opts = {}) {
  const { root, signal, getRecordedBlob, setStatus, setOutput = () => { }, setBusy: setBusyHook = () => { } } = opts;

  const btn = root?.querySelector("#vid-aiToggle");
  if (!btn) return { sync() { }, destroy() { } };

  const els = {
    btn: root?.querySelector("#vid-aiToggle"),
    modelInput: root?.querySelector("#vid-aiModel"),
    modelLabel: root?.querySelector("#vid-aiModelLabel"),
    hudMeta: root?.querySelector("#vid-meta"),
  };

  if (!els.btn) return { sync() { }, destroy() { } };

  let busy = false;
  let reqAbort = null;

  function setAiStatus(msg, { error = false } = {}) {
    if (typeof setStatus === "function") setStatus(msg, { error });

    // Also show something visible in HUD meta
    if (els.hudMeta) {
      const base = String(els.hudMeta.textContent || "").split("\n")[0] || "";
      const line = msg ? `AI: ${msg}` : "";
      els.hudMeta.textContent = [base, line].filter(Boolean).join("\n");
    }
  }

  function getModel() {
    const v = String(els.modelInput?.value || "").trim();
    return v || OPENROUTER_DEFAULT_MODEL;
  }

  function syncModelLabel() {
    const v = String(els.modelInput?.value || "").trim() || OPENROUTER_DEFAULT_MODEL;
    if (els.modelLabel) els.modelLabel.textContent = v;
  }

  function saveModelPref() {
    const model = getModel();
    saveOpenRouterPrefs({ model, modelKey: VIDEO_MODEL_KEY });
    syncModelLabel();
  }

  function hasRecording() {
    const b = getRecordedBlob?.();
    return b instanceof Blob && b.size > 0;
  }

  const IDLE_LABEL = (btn.textContent || "").trim() || "AI";
  const BUSY_LABEL = "Cancel";

  function setBusy(isBusy) {
    busy = !!isBusy;
    btn.disabled = !getRecordedBlob?.() && !busy;
    btn.textContent = busy ? BUSY_LABEL : IDLE_LABEL;

    try { setBusyHook?.(busy); } catch { }
  }

  async function run() {
    if (busy) {
      try { reqAbort?.abort(); } catch { }
      return;
    }

    const blob = getRecordedBlob?.();
    if (!(blob instanceof Blob) || blob.size <= 0) {
      setAiStatus("Record something first (stop to save).", { error: true });
      return;
    }

    setBusy(true);
    setOutput("");
    setBusy(true);

    reqAbort = new AbortController();

    const onAbort = () => { try { reqAbort.abort(); } catch { } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const apiKey = await loadApiKeyRequired(reqAbort.signal);
      const model = getModel();

      setAiStatus("Encoding video…");
      const videoDataUrl = await blobToDataUrl(blob);

      const prompt =
        "Describe what happens in this video. " +
        "Summarize the sequence of events, notable objects/actions, and any safety issues if present.";

      const messages = buildMessagesForVideo({
        prompt,
        videoDataUrl,
        meta: `Video: ${prettyBytes(blob.size)} • ${blob.type || "video"}`,
      });

      setAiStatus("Calling model…");

      const imgParts =
        messages?.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .filter(p => p?.type === "image_url");

      console.log("[video ai] sending images:", imgParts.length);
      console.log("[video ai] first image prefix:", imgParts?.[0]?.image_url?.url?.slice(0, 30));

      const resp = await openRouterChatCompletions({
        apiKey,
        model,
        messages,
        temperature: 0.2,
        maxTokens: 900,
        title: "OntoGSN Video Pane",
        signal: reqAbort.signal,
      });

      const text = (extractAssistantText(resp) || "").trim();
      const u = usageLine(resp);

      // Show output in HUD meta (truncate only if enormous)
      setOutput(text);

      setAiStatus(u ? `Done • ${u}` : "Done.");
      console.log("[video ai] output:\n", text);
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Canceled." : (e?.message || String(e));
      setAiStatus(msg, { error: e?.name !== "AbortError" });
    } finally {
      reqAbort = null;
      setBusy(false);
    }
  }

  function sync() {
    els.btn.disabled = busy ? false : !hasRecording();
    syncModelLabel();
  }

  function destroy() {
    try { reqAbort?.abort(); } catch { }
  }

  // init: load VIDEO model pref into input (not the global openrouter_model)
  const { model } = loadOpenRouterPrefs({
    modelKey: VIDEO_MODEL_KEY,
    defaultModel: FALLBACK_VIDEO_MODELS[0]?.id || OPENROUTER_DEFAULT_MODEL,
  });

  if (els.modelInput && !String(els.modelInput.value || "").trim()) {
    els.modelInput.value = model || FALLBACK_VIDEO_MODELS[0]?.id || OPENROUTER_DEFAULT_MODEL;
  }
  syncModelLabel();

  els.btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    run();
  }, { signal });

  els.modelInput?.addEventListener("change", saveModelPref, { signal });
  els.modelInput?.addEventListener("blur", saveModelPref, { signal });

  setBusy(false);
  sync();

  return { sync, destroy };
}

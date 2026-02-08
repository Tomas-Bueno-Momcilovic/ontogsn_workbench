import {
  loadOpenRouterPrefs,
  saveOpenRouterPrefs,
  openRouterChatCompletions,
  OPENROUTER_DEFAULT_MODEL,
} from "@core/openrouter.js";

const API_TXT_URL = new URL("./api.txt", import.meta.url);

// Frame sampling defaults (no UI)
const DEFAULT_MAX_FRAMES = 8;
const DEFAULT_FRAME_MAX_W = 640;
const DEFAULT_JPEG_QUALITY = 0.72;

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
      try { el.removeEventListener(name, on); } catch {}
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
    await waitEvent(video, "loadeddata", timeoutMs).catch(() => {});
  }

  await new Promise((resolve, reject) => {
    let timer = null;

    const onSeeked = () => cleanup(resolve);
    const onErr = () => cleanup(() => reject(new Error("Video seek failed")));

    const cleanup = (fn) => {
      try { video.removeEventListener("seeked", onSeeked); } catch {}
      try { video.removeEventListener("error", onErr); } catch {}
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
        try { video.currentTime = t; } catch {}
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
    await waitEvent(v, "loadeddata", 20000).catch(() => {});

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
    try { URL.revokeObjectURL(url); } catch {}
  }
}

function buildMessagesForFrames({ prompt, frames, meta }) {
  const lines = frames
    .map((f, i) => `Frame ${i + 1}: t=${f.t.toFixed(2)}s`)
    .join("\n");

  const content = [{ type: "text", text: `${prompt}\n\n${meta}\n\nFrames (chronological):\n${lines}` }];
  for (const f of frames) content.push({ type: "image_url", imageUrl: { url: f.dataUrl } });

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
  const { root, signal, getRecordedBlob, setStatus } = opts;

  const els = {
    btn: root?.querySelector("#vid-aiToggle"),
    modelInput: root?.querySelector("#vid-aiModel"),
    modelLabel: root?.querySelector("#vid-aiModelLabel"),
    hudMeta: root?.querySelector("#vid-meta"),
  };

  if (!els.btn) return { sync() {}, destroy() {} };

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
    saveOpenRouterPrefs({ model });
    syncModelLabel();
  }

  function hasRecording() {
    const b = getRecordedBlob?.();
    return b instanceof Blob && b.size > 0;
  }

  function setBusy(isBusy) {
    busy = !!isBusy;
    els.btn.disabled = !hasRecording() && !busy;
    els.btn.textContent = busy ? "Cancel AI" : "AI";
  }

  async function run() {
    if (busy) {
      try { reqAbort?.abort(); } catch {}
      return;
    }

    const blob = getRecordedBlob?.();
    if (!(blob instanceof Blob) || blob.size <= 0) {
      setAiStatus("Record something first (stop to save).", { error: true });
      return;
    }

    setBusy(true);
    reqAbort = new AbortController();

    const onAbort = () => { try { reqAbort.abort(); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const apiKey = await loadApiKey(reqAbort.signal);
      const model = getModel();

      const meta = `Video: ${prettyBytes(blob.size)} • ${blob.type || "video"}`;
      setAiStatus("Sampling frames…");

      const captured = await captureFramesFromBlob(blob, {
        frames: DEFAULT_MAX_FRAMES,
        maxWidth: DEFAULT_FRAME_MAX_W,
        jpegQuality: DEFAULT_JPEG_QUALITY,
      });

      const prompt =
        "Describe what happens in this video. " +
        "Summarize the sequence of events, notable objects/actions, and any safety issues if present.";

      const messages = buildMessagesForFrames({
        prompt,
        frames: captured.frames,
        meta: `${meta} • frames=${captured.frames.length}`,
      });

      setAiStatus("Calling model…");

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
      if (els.hudMeta) {
        const savedLine = String(els.hudMeta.textContent || "").split("\n")[0] || "";
        const out = text.length > 3500 ? `${text.slice(0, 3500)}\n…` : text;
        els.hudMeta.textContent = [savedLine, "AI:", out].filter(Boolean).join("\n");
      }

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
    try { reqAbort?.abort(); } catch {}
  }

  // init: load model pref into input
  const { model } = loadOpenRouterPrefs();
  if (els.modelInput && !String(els.modelInput.value || "").trim()) {
    els.modelInput.value = model || OPENROUTER_DEFAULT_MODEL;
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

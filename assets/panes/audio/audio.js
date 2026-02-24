import { mountTemplate } from "@core/utils.js";

import {
  ensureOpenRouterAudioModels,
  isOpenRouterAudioModel,
  openRouterModelId,
  openRouterAudioTranscribeBlob
} from "./ai.js";

const HTML = new URL("./audio.html", import.meta.url);
const CSS = new URL("./audio.css", import.meta.url);

// --- module state ------------------------------------------------------
let audioRoot = null;

let mediaRecorder = null;
let recStream = null;
let recChunks = [];
let recStartTs = 0;

let currentObjectUrl = null;
let currentBlob = null;
let currentAudioBuffer = null;

let canvas = null;
let ctx2d = null;
let audioEl = null;
let statusEl = null;

let lastPeaks = null;
let lastDuration = 0;

// --- live waveform (mic) ----------------------------------------------
let liveAc = null;
let liveAnalyser = null;
let liveSrc = null;
let liveRAF = 0;
let liveData = null;

// --- transcript UI -----------------------------------------------------
let txBtn = null;
let txModelSel = null;
let txStatusEl = null;
let txOutEl = null;

let txCopyBtn = null;
let txClearBtn = null;
let txLiveToggle = null;

// --- Live STT (mic PCM -> downsample -> Worker ASR) --------------------
const TARGET_SR = 16000;

const LIVE_SEG_S = 2.6;
const LIVE_OVER_S = 0.25;
const LIVE_TICK_MS = 1400;
const MAX_QUEUE_SEC = 12;

let sttActive = false;

let sttAc = null;
let sttSrc = null;
let sttTap = null;
let sttZero = null;

let sttQueue = [];
let sttQueueLen = 0;
let sttTail = new Float32Array(0);

let sttTimer = 0;
let sttBusy = false;

let sttWorker = null;
let sttWorkerReady = false;
let sttWorkerModel = "";
let sttReqId = 1;
const sttPending = new Map();

let sttInitPromise = null;
let sttInitResolve = null;
let sttInitReject = null;

// --- helpers -----------------------------------------------------------
// --- Voxtral (Mistral) streaming --------------------------------------
const VOXTRAL_PROXY_URL = "/api/voxtral/transcribe-stream"; // proxy route above

function isMistralModel(modelId) {
  return typeof modelId === "string" && modelId.startsWith("mistral:");
}
function mistralModelName(modelId) {
  return (modelId || "").replace(/^mistral:/, "") || "voxtral-mini-latest";
}

function float32ToWavBlobMono16(samples, sampleRate) {
  // 16-bit PCM mono WAV
  const n = samples.length;
  const out = new ArrayBuffer(44 + n * 2);
  const view = new DataView(out);

  let off = 0;
  const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };

  const byteRate = sampleRate * 2; // mono * 16-bit
  writeStr("RIFF");
  view.setUint32(off, 36 + n * 2, true); off += 4;
  writeStr("WAVE");

  writeStr("fmt ");
  view.setUint32(off, 16, true); off += 4;
  view.setUint16(off, 1, true); off += 2;      // PCM
  view.setUint16(off, 1, true); off += 2;      // mono
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, byteRate, true); off += 4;
  view.setUint16(off, 2, true); off += 2;      // blockAlign
  view.setUint16(off, 16, true); off += 2;     // bits

  writeStr("data");
  view.setUint32(off, n * 2, true); off += 4;

  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(off, int16, true);
    off += 2;
  }

  return new Blob([out], { type: "audio/wav" });
}

async function readSSE(response, onData) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("No streaming body (SSE) available.");

  const td = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });

    // SSE events are separated by blank line
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = chunk.split(/\r?\n/);
      const dataLines = [];
      for (const ln of lines) {
        if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
      }
      if (!dataLines.length) continue;

      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") return;

      let payload = null;
      try { payload = JSON.parse(dataStr); } catch { payload = { type: "text", text: dataStr }; }
      await onData(payload);
    }
  }
}

function extractDeltaText(ev) {
  if (!ev) return "";
  if (typeof ev === "string") return ev;

  const t = (ev.type || ev.event || "").toString().toLowerCase();
  if (t.includes("error")) throw new Error(ev.message || "Voxtral error");
  if (t.includes("done")) return "";

  // common shapes
  if (typeof ev.text === "string") return ev.text;
  if (typeof ev.delta === "string") return ev.delta;
  if (ev.delta && typeof ev.delta.text === "string") return ev.delta.text;
  if (ev.data && typeof ev.data.text === "string") return ev.data.text;

  return "";
}

async function voxtralStreamTranscribeBlob({ blob, model, language, onDelta, signal }) {
  const fd = new FormData();
  fd.append("model", model || "voxtral-mini-latest");
  if (language) fd.append("language", language);

  // name helps the SDK pick content type
  fd.append("file", blob, blob.type === "audio/wav" ? "chunk.wav" : "audio.bin");

  const resp = await fetch(VOXTRAL_PROXY_URL, {
    method: "POST",
    body: fd,
    signal,
  });
  if (!resp.ok) throw new Error(`Voxtral proxy error: ${resp.status} ${resp.statusText}`);

  let segText = "";
  await readSSE(resp, async (ev) => {
    const piece = extractDeltaText(ev);
    if (!piece) return;

    // handle both "delta" streaming and "cumulative" streaming gracefully
    if (piece.length >= segText.length && piece.startsWith(segText)) segText = piece;
    else segText += piece;

    onDelta?.(segText, piece);
  });

  return segText;
}


function setStatus(msg, kind = "") {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind || "";
}

function setTxStatus(msg, kind = "") {
  if (!txStatusEl) return;
  txStatusEl.textContent = msg;
  txStatusEl.dataset.kind = kind || "";
}

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function clearCurrentUrl() {
  if (currentObjectUrl) {
    try { URL.revokeObjectURL(currentObjectUrl); } catch { }
    currentObjectUrl = null;
  }
}

function clearAudioState() {
  clearCurrentUrl();
  currentBlob = null;
  currentAudioBuffer = null;
  lastPeaks = null;
  lastDuration = 0;

  if (audioEl) audioEl.removeAttribute("src");
  if (audioEl) audioEl.load();

  drawEmptyWave("No audio loaded");

  if (txOutEl) txOutEl.value = "";
  setTxStatus("");
}

// --- waveform drawing --------------------------------------------------
function resizeCanvas() {
  if (!canvas || !ctx2d) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 160;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawEmptyWave(label = "") {
  if (!canvas || !ctx2d) return;

  resizeCanvas();

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx2d.clearRect(0, 0, w, h);

  ctx2d.globalAlpha = 0.35;
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.strokeStyle = "#000";
  ctx2d.lineWidth = 1;
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;

  if (label) {
    ctx2d.font = "12px system-ui, sans-serif";
    ctx2d.fillStyle = "#666";
    ctx2d.fillText(label, 10, 18);
  }
}

function computePeaks(audioBuffer, widthPx) {
  const ch = audioBuffer.getChannelData(0);
  const n = Math.max(60, Math.floor(widthPx));
  const peaks = new Float32Array(n);

  const step = Math.max(1, Math.floor(ch.length / n));

  for (let i = 0; i < n; i++) {
    const start = i * step;
    const end = Math.min(ch.length, start + step);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(ch[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

function drawWave(peaks) {
  if (!canvas || !ctx2d || !peaks?.length) return;

  resizeCanvas();

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const mid = h / 2;

  ctx2d.clearRect(0, 0, w, h);

  ctx2d.globalAlpha = 0.15;
  ctx2d.beginPath();
  ctx2d.moveTo(0, mid);
  ctx2d.lineTo(w, mid);
  ctx2d.strokeStyle = "#000";
  ctx2d.lineWidth = 1;
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;

  const style = getComputedStyle(canvas);
  const stroke = style.color || "#186e78";

  ctx2d.strokeStyle = stroke;
  ctx2d.lineWidth = 1;

  const n = peaks.length;
  const dx = w / n;

  ctx2d.beginPath();
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0, Math.min(1, peaks[i])) * (mid - 6);
    const x = i * dx + 0.5;
    ctx2d.moveTo(x, mid - amp);
    ctx2d.lineTo(x, mid + amp);
  }
  ctx2d.stroke();

  if (lastDuration) {
    const cur = audioEl?.currentTime || 0;
    ctx2d.font = "12px system-ui, sans-serif";
    ctx2d.fillStyle = "#666";
    ctx2d.fillText(`${fmtTime(cur)} / ${fmtTime(lastDuration)}`, 10, h - 10);
  }

  if (audioEl && lastDuration > 0) {
    const t = Math.max(0, Math.min(lastDuration, audioEl.currentTime || 0));
    const x = (t / lastDuration) * w;

    ctx2d.globalAlpha = 0.35;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, h);
    ctx2d.strokeStyle = stroke;
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }
}

// --- WAV conversion + decoding ----------------------------------------
function audioBufferToWavArrayBuffer(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;

  const interleaved = new Float32Array(numFrames * numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      interleaved[i * numChannels + ch] = data[i];
    }
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  let offset = 0;
  const writeStr = (s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };

  writeStr("RIFF");
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeStr("WAVE");

  writeStr("fmt ");
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeStr("data");
  view.setUint32(offset, dataSize, true); offset += 4;

  for (let i = 0; i < interleaved.length; i++) {
    let s = interleaved[i];
    s = Math.max(-1, Math.min(1, s));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return out;
}

async function decodeToBuffer(arrayBuffer) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) throw new Error("Web Audio API not supported in this browser.");

  const ac = new AC();
  try {
    const buf = arrayBuffer.slice(0);
    return await ac.decodeAudioData(buf);
  } finally {
    try { await ac.close(); } catch { }
  }
}

// --- Transformers.js offline ASR --------------------------------------
const HF_TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0/dist/transformers.min.js";

let _hf = null;
let _asr = null;
let _asrKey = "";
let _asrLoading = null;

async function loadTransformersJs() {
  if (_hf) return _hf;
  _hf = await import(HF_TRANSFORMERS_URL);
  _hf.env.allowLocalModels = false;
  _hf.env.useBrowserCache = true;
  return _hf;
}

async function pickDevice() {
  if (navigator.gpu?.requestAdapter) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch { }
  }
  return "wasm";
}

async function getTranscriber(modelId, device) {
  const key = `${modelId}@@${device}`;
  if (_asr && _asrKey === key) return _asr;
  if (_asrLoading) return _asrLoading;

  _asrLoading = (async () => {
    const { pipeline } = await loadTransformersJs();

    setTxStatus(`Loading model (${device})…`, "busy");

    const t = await pipeline("automatic-speech-recognition", modelId, {
      device,
      progress_callback: (p) => {
        const status = p?.status || p?.type || "";
        const prog = (typeof p?.progress === "number")
          ? ` ${(p.progress * 100).toFixed(0)}%`
          : "";
        if (status) setTxStatus(`${status}${prog}`, "busy");
      }
    });

    _asr = t;
    _asrKey = key;
    _asrLoading = null;

    setTxStatus(`Model ready (${device}).`);
    return t;
  })();

  return _asrLoading;
}

async function resampleTo16kMono(audioBuffer) {
  const targetRate = 16000;
  const length = Math.ceil(audioBuffer.duration * targetRate);

  const oc = new OfflineAudioContext(1, length, targetRate);

  const mono = oc.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
  const out = mono.getChannelData(0);

  if (audioBuffer.numberOfChannels === 1) {
    out.set(audioBuffer.getChannelData(0));
  } else {
    const chans = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      chans.push(audioBuffer.getChannelData(c));
    }
    for (let i = 0; i < audioBuffer.length; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i] || 0;
      out[i] = s / chans.length;
    }
  }

  const src = oc.createBufferSource();
  src.buffer = mono;
  src.connect(oc.destination);
  src.start(0);

  const rendered = await oc.startRendering();
  return rendered.getChannelData(0);
}

async function blobToWhisperInput(blob) {
  const ab = await blob.arrayBuffer();
  const decoded = await decodeToBuffer(ab);
  return resampleTo16kMono(decoded);
}

async function transcribeCurrentAudio() {
  if (!currentBlob) {
    setTxStatus("No audio loaded.", "err");
    return;
  }
  if (isRecording()) {
    setTxStatus("Stop recording first.", "err");
    return;
  }

  const modelId = txModelSel?.value || "Xenova/whisper-tiny";
  const useVoxtral = isMistralModel(modelId);

  if (useVoxtral) {
    if (txBtn) txBtn.disabled = true;
    if (txModelSel) txModelSel.disabled = true;
    if (txCopyBtn) txCopyBtn.disabled = true;
    if (txClearBtn) txClearBtn.disabled = true;

    setTxStatus("Voxtral: uploading…", "busy");
    if (txOutEl) txOutEl.value = "";

    try {
      const model = mistralModelName(modelId);

      let lastRendered = "";
      await voxtralStreamTranscribeBlob({
        blob: currentBlob,
        model,
        // language: "en", // optional
        onDelta: (cumulative) => {
          lastRendered = cumulative;
          if (txOutEl) {
            txOutEl.value = cumulative;
            txOutEl.scrollTop = txOutEl.scrollHeight;
          }
          setTxStatus("Voxtral: transcribing…", "busy");
        },
      });

      if (txOutEl) txOutEl.value = (lastRendered || "").trim() || "(no text)";
      setTxStatus("Done.");
      return; // IMPORTANT: don't fall through to local ASR
    } catch (e) {
      console.error("[audio] voxtral transcribe failed:", e);
      setTxStatus(`Voxtral failed: ${e?.message || e}`, "err");
      return;
    } finally {
      if (txBtn) txBtn.disabled = false;
      if (txModelSel) txModelSel.disabled = false;
      if (txCopyBtn) txCopyBtn.disabled = false;
      if (txClearBtn) txClearBtn.disabled = false;
    }
  }

  const useOpenRouter = isOpenRouterAudioModel(modelId);

  if (useOpenRouter) {
    if (txBtn) txBtn.disabled = true;
    if (txModelSel) txModelSel.disabled = true;
    if (txCopyBtn) txCopyBtn.disabled = true;
    if (txClearBtn) txClearBtn.disabled = true;

    setTxStatus("OpenRouter: uploading…", "busy");
    if (txOutEl) txOutEl.value = "";

    try {
      const model = openRouterModelId(modelId); // e.g. "openai/gpt-audio"
      const text = await openRouterAudioTranscribeBlob({
        blob: currentBlob,
        modelId: model,
        prompt: "Please transcribe this audio file. If there are multiple speakers, label them.",
        // signal: optional AbortController if you add one later
      });

      if (txOutEl) txOutEl.value = (text || "").trim() || "(no text)";
      setTxStatus("Done.");
      return; // IMPORTANT: don’t fall through to local ASR
    } catch (e) {
      console.error("[audio] openrouter transcribe failed:", e);
      setTxStatus(`OpenRouter failed: ${e?.message || e}`, "err");
      return;
    } finally {
      if (txBtn) txBtn.disabled = false;
      if (txModelSel) txModelSel.disabled = false;
      if (txCopyBtn) txCopyBtn.disabled = false;
      if (txClearBtn) txClearBtn.disabled = false;
    }
  }

  const isEnglishOnly = /\.en$/i.test(modelId);
  const lang = "en";

  if (txBtn) txBtn.disabled = true;
  if (txModelSel) txModelSel.disabled = true;
  if (txCopyBtn) txCopyBtn.disabled = true;
  if (txClearBtn) txClearBtn.disabled = true;

  setTxStatus("Preparing…", "busy");

  let device = await pickDevice();
  let transcriber = null;

  try {
    try {
      transcriber = await getTranscriber(modelId, device);
    } catch (e) {
      if (device === "webgpu") {
        setTxStatus("WebGPU unavailable → falling back to WASM…", "busy");
        device = "wasm";
        transcriber = await getTranscriber(modelId, device);
      } else {
        throw e;
      }
    }

    setTxStatus("Decoding + resampling…", "busy");
    const audio = currentAudioBuffer
      ? await resampleTo16kMono(currentAudioBuffer)
      : await blobToWhisperInput(currentBlob);

    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(!isEnglishOnly && lang ? { language: lang, generate_kwargs: { language: lang } } : {})
    });

    const text = (out?.text ?? "").trim();
    if (txOutEl) txOutEl.value = text || "(no text)";
    setTxStatus("Done.");
  } catch (e) {
    console.error("[audio] transcribe failed:", e);
    setTxStatus(`Transcribe failed: ${e?.message || e}`, "err");
  } finally {
    if (txBtn) txBtn.disabled = false;
    if (txModelSel) txModelSel.disabled = false;
    if (txCopyBtn) txCopyBtn.disabled = false;
    if (txClearBtn) txClearBtn.disabled = false;
  }
}

// --- load blob into view ----------------------------------------------
async function loadBlobAsCurrent(blob, label = "audio") {
  clearCurrentUrl();

  currentBlob = blob;
  currentObjectUrl = URL.createObjectURL(blob);

  audioEl.src = currentObjectUrl;
  audioEl.load();

  const ab = await blob.arrayBuffer();
  const audioBuffer = await decodeToBuffer(ab);

  currentAudioBuffer = audioBuffer;
  lastDuration = audioBuffer.duration;

  const w = canvas.clientWidth || 600;
  lastPeaks = computePeaks(audioBuffer, w);
  drawWave(lastPeaks);

  setStatus(`Loaded ${label} (${lastDuration.toFixed(2)}s)`);

  if (txOutEl) txOutEl.value = "";
  setTxStatus("");
}

async function handleFile(file) {
  if (!file) return;

  setStatus(`Loading file: ${file.name}…`);
  try {
    await loadBlobAsCurrent(file, file.name);
  } catch (e) {
    console.error("[audio] file load failed:", e);
    setStatus(`Failed to load file: ${e?.message || e}`, "err");
    drawEmptyWave("Failed to decode audio");
  }
}

// --- recording ---------------------------------------------------------
function pickBestRecorderMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];

  if (!globalThis.MediaRecorder) return "";
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch { }
  }
  return "";
}

function stopLiveWave() {
  if (liveRAF) {
    cancelAnimationFrame(liveRAF);
    liveRAF = 0;
  }
  liveData = null;

  try { liveSrc?.disconnect?.(); } catch { }
  try { liveAnalyser?.disconnect?.(); } catch { }

  liveSrc = null;
  liveAnalyser = null;

  if (liveAc) {
    try { liveAc.close(); } catch { }
    liveAc = null;
  }
}

async function startLiveWave(stream) {
  stopLiveWave();

  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;

  liveAc = new AC();
  try { await liveAc.resume(); } catch { }

  liveSrc = liveAc.createMediaStreamSource(stream);
  liveAnalyser = liveAc.createAnalyser();

  liveAnalyser.fftSize = 2048;
  liveAnalyser.smoothingTimeConstant = 0.0;

  liveSrc.connect(liveAnalyser);
  liveData = new Uint8Array(liveAnalyser.fftSize);

  const tick = () => {
    liveRAF = requestAnimationFrame(tick);

    if (!canvas || !ctx2d || !liveAnalyser || !liveData) return;

    liveAnalyser.getByteTimeDomainData(liveData);

    resizeCanvas();

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const mid = h / 2;

    ctx2d.clearRect(0, 0, w, h);

    ctx2d.globalAlpha = 0.15;
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    ctx2d.lineTo(w, mid);
    ctx2d.strokeStyle = "#000";
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;

    const style = getComputedStyle(canvas);
    const stroke = style.color || "#186e78";

    ctx2d.strokeStyle = stroke;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();

    const n = liveData.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const v = liveData[i] / 255;
      const y = v * h;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();

    ctx2d.font = "12px system-ui, sans-serif";
    ctx2d.fillStyle = "#666";
    ctx2d.fillText("REC (live)", 10, 18);
  };

  tick();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("getUserMedia() not supported in this browser.", "err");
    return;
  }

  setStatus("Requesting microphone permission…");
  recChunks = [];

  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await startLiveWave(recStream);

    // Start Live STT only if toggle is enabled
    if (txLiveToggle?.checked) {
      startLiveStt(recStream).catch(console.warn);
    }
  } catch (e) {
    console.error("[audio] mic permission denied:", e);
    setStatus("Microphone permission denied.", "err");
    return;
  }

  const mimeType = pickBestRecorderMime();
  try {
    mediaRecorder = new MediaRecorder(recStream, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.error("[audio] MediaRecorder init failed:", e);
    setStatus("MediaRecorder init failed in this browser.", "err");

    stopLiveWave();
    try { recStream?.getTracks()?.forEach(t => t.stop()); } catch { }
    recStream = null;

    return;
  }

  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  };

  mediaRecorder.onerror = (ev) => {
    console.error("[audio] MediaRecorder error:", ev?.error || ev);
    setStatus("Recording error.", "err");
  };

  mediaRecorder.onstop = async () => {
    await stopLiveStt({ flush: true }).catch(() => { });
    stopLiveWave();

    try { recStream?.getTracks()?.forEach(t => t.stop()); } catch { }
    recStream = null;

    const rawBlob = new Blob(recChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    mediaRecorder = null;
    recChunks = [];

    setStatus("Converting recording to WAV…");

    try {
      const ab = await rawBlob.arrayBuffer();
      const audioBuffer = await decodeToBuffer(ab);
      const wavAB = audioBufferToWavArrayBuffer(audioBuffer);
      const wavBlob = new Blob([wavAB], { type: "audio/wav" });

      await loadBlobAsCurrent(wavBlob, "mic-recording.wav");
    } catch (e) {
      console.error("[audio] recording decode/convert failed:", e);

      try {
        await loadBlobAsCurrent(rawBlob, "mic-recording (raw)");
      } catch (e2) {
        console.error("[audio] fallback load failed:", e2);
        setStatus(`Recording finished, but decoding failed: ${e?.message || e}`, "err");
        drawEmptyWave("Recording decode failed");
      }
    }
  };

  recStartTs = performance.now();
  mediaRecorder.start();
  setStatus("Recording… (press Stop to finish)");
}

function stopRecording() {
  if (!mediaRecorder) return;
  try {
    mediaRecorder.stop();
  } catch (e) {
    console.error("[audio] stop failed:", e);
  }
}

function isRecording() {
  return !!mediaRecorder && mediaRecorder.state === "recording";
}

// --- Live STT internals ------------------------------------------------

function _pushSttPcm(chunk) {
  if (!chunk || !chunk.length) return;

  sttQueue.push(chunk);
  sttQueueLen += chunk.length;

  const sr = sttAc?.sampleRate || TARGET_SR;
  const max = Math.floor(sr * MAX_QUEUE_SEC);

  while (sttQueueLen > max && sttQueue.length) {
    const drop = sttQueue.shift();
    sttQueueLen -= drop.length;
  }
}

function _takeSttSamples(n) {
  n = Math.max(0, n | 0);
  if (n === 0 || sttQueueLen === 0) return new Float32Array(0);

  const out = new Float32Array(Math.min(n, sttQueueLen));
  let written = 0;

  while (written < out.length && sttQueue.length) {
    const head = sttQueue[0];
    const need = out.length - written;

    if (head.length <= need) {
      out.set(head, written);
      written += head.length;
      sttQueue.shift();
      sttQueueLen -= head.length;
    } else {
      out.set(head.subarray(0, need), written);
      written += need;
      sttQueue[0] = head.subarray(need);
      sttQueueLen -= need;
    }
  }

  return out;
}

function _downsampleLinear(x, inRate, outRate = TARGET_SR) {
  if (!x?.length) return new Float32Array(0);
  if (inRate === outRate) return x.slice(0);

  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.round(x.length / ratio));
  const out = new Float32Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(x.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = x[i0] * (1 - frac) + x[i1] * frac;
  }
  return out;
}

function mergeTranscript(existing, incoming) {
  const a = (existing || "").trimEnd();
  const b = (incoming || "").trim();
  if (!b) return a;
  if (!a) return b;

  if (a.endsWith(b)) return a;

  const max = Math.min(a.length, b.length, 80);
  for (let k = max; k >= 12; k--) {
    const suf = a.slice(-k).toLowerCase();
    const pre = b.slice(0, k).toLowerCase();
    if (suf === pre) return a + b.slice(k);
  }

  const sep = a.endsWith("\n") ? "" : " ";
  return a + sep + b;
}

function _appendLiveText(txt) {
  const t = (txt || "").trim();
  if (!t || !txOutEl) return;

  txOutEl.value = mergeTranscript(txOutEl.value || "", t);
  txOutEl.scrollTop = txOutEl.scrollHeight;
}

function _makeSttWorker() {
  const src = `
    const HF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0/dist/transformers.min.js";

    let hf = null;
    let asr = null;
    let key = "";

    async function ensure(modelId, device) {
      const k = modelId + "@@" + device;
      if (asr && key === k) return asr;

      hf = hf || await import(HF);

      hf.env.allowLocalModels = false;
      hf.env.useBrowserCache = true;

      postMessage({ type: "status", msg: "Loading ASR model…", kind: "busy" });

      const { pipeline } = hf;
      asr = await pipeline("automatic-speech-recognition", modelId, {
        device,
        progress_callback: (p) => {
          const st = p?.status || p?.type || "";
          const pr = (typeof p?.progress === "number") ? " " + Math.round(p.progress * 100) + "%" : "";
          if (st) postMessage({ type: "status", msg: st + pr, kind: "busy" });
        }
      });

      key = k;
      postMessage({ type: "ready" });
      return asr;
    }

    onmessage = async (ev) => {
      const m = ev.data || {};
      try {
        if (m.type === "init") {
          await ensure(m.modelId, m.device);
          return;
        }

        if (m.type === "tx") {
          const audio = m.audio;
          const opts = m.opts || {};
          const out = await asr(audio, opts);
          postMessage({ type: "result", id: m.id, text: (out?.text || "").trim() });
          return;
        }
      } catch (e) {
        postMessage({ type: "error", id: m.id, message: e?.message || String(e) });
      }
    };
  `;

  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url, { type: "module" });
  URL.revokeObjectURL(url);
  return w;
}

async function ensureLiveAsrWorker(modelId) {
  if (sttWorker && sttWorkerReady && sttWorkerModel === modelId) return;

  if (!sttWorker) {
    sttWorker = _makeSttWorker();

    sttWorker.onmessage = (ev) => {
      const m = ev.data || {};

      if (m.type === "status") {
        setTxStatus(m.msg || "", m.kind || "");
        return;
      }

      if (m.type === "ready") {
        sttWorkerReady = true;
        sttWorkerModel = modelId;
        setTxStatus("Live STT: listening…");
        if (sttInitResolve) sttInitResolve();
        sttInitResolve = null;
        sttInitReject = null;
        sttInitPromise = null;
        return;
      }

      if (m.type === "result") {
        const p = sttPending.get(m.id);
        if (p) {
          sttPending.delete(m.id);
          p.resolve(m.text || "");
        }
        return;
      }

      if (m.type === "error") {
        const p = sttPending.get(m.id);
        if (p) {
          sttPending.delete(m.id);
          p.reject(new Error(m.message || "ASR worker error"));
        } else if (sttInitReject) {
          sttInitReject(new Error(m.message || "ASR init failed"));
          sttInitResolve = null;
          sttInitReject = null;
          sttInitPromise = null;
        }
      }
    };
  }

  sttWorkerReady = false;
  sttWorkerModel = "";

  sttInitPromise = new Promise((resolve, reject) => {
    sttInitResolve = resolve;
    sttInitReject = reject;
  });

  // WASM is the safest in workers right now
  sttWorker.postMessage({ type: "init", modelId, device: "wasm" });

  await sttInitPromise;
}

function liveAsr(audio16k, modelId) {
  if (!sttWorker || !sttWorkerReady) return Promise.resolve("");

  const id = sttReqId++;

  const isEnglishOnly = /\.en$/i.test(modelId);

  const opts = {
    chunk_length_s: 30,
    stride_length_s: 5,
  };

  // Only multilingual models support language/task forcing
  if (!isEnglishOnly) {
    opts.language = "en";
    opts.task = "transcribe";
    opts.generate_kwargs = { language: "en", task: "transcribe" };
  }

  return new Promise((resolve, reject) => {
    sttPending.set(id, { resolve, reject });
    sttWorker.postMessage({ type: "tx", id, audio: audio16k, opts }, [audio16k.buffer]);
  });
}


async function startLiveStt(stream) {
  if (!stream) return;

  await stopLiveStt({ flush: false });

  sttActive = true;
  sttQueue = [];
  sttQueueLen = 0;
  sttTail = new Float32Array(0);
  sttBusy = false;

  const modelId = txModelSel?.value || "Xenova/whisper-tiny.en";
  const useVoxtral = isMistralModel(modelId);

  if (isOpenRouterAudioModel(modelId)) {
    setTxStatus("Live STT is not supported for OpenRouter audio models.", "err");
    return;
  }

  setTxStatus(useVoxtral ? "Live STT (Voxtral): listening…" : "Live STT: loading…", useVoxtral ? "" : "busy");

  if (!useVoxtral) {
    await ensureLiveAsrWorker(modelId);
  }

  await ensureLiveAsrWorker(modelId);

  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;

  // Ask for 16k if supported, otherwise browser decides
  try {
    sttAc = new AC({ sampleRate: TARGET_SR });
  } catch {
    sttAc = new AC();
  }

  try { await sttAc.resume(); } catch { }

  sttSrc = sttAc.createMediaStreamSource(stream);

  // Prefer AudioWorklet (less main-thread pressure)
  if (sttAc.audioWorklet?.addModule) {
    const workletCode = `
      class PcmTap extends AudioWorkletProcessor {
        constructor() {
          super();
          this._buf = new Float32Array(4096);
          this._off = 0;
        }
        process(inputs) {
          const input = inputs[0];
          const ch0 = input && input[0];
          if (!ch0) return true;

          let i = 0;
          while (i < ch0.length) {
            const n = Math.min(ch0.length - i, this._buf.length - this._off);
            this._buf.set(ch0.subarray(i, i + n), this._off);
            this._off += n;
            i += n;

            if (this._off >= this._buf.length) {
              const out = new Float32Array(this._buf);
              this.port.postMessage(out, [out.buffer]);
              this._off = 0;
            }
          }
          return true;
        }
      }
      registerProcessor("pcm-tap", PcmTap);
    `;

    const url = URL.createObjectURL(new Blob([workletCode], { type: "text/javascript" }));
    await sttAc.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    sttTap = new AudioWorkletNode(sttAc, "pcm-tap");
    sttTap.port.onmessage = (ev) => _pushSttPcm(ev.data);
  } else {
    // fallback: ScriptProcessor
    const sp = sttAc.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      _pushSttPcm(new Float32Array(ch));
    };
    sttTap = sp;
  }

  // silent sink
  sttZero = sttAc.createGain();
  sttZero.gain.value = 0;

  sttSrc.connect(sttTap);
  sttTap.connect(sttZero);
  sttZero.connect(sttAc.destination);

  if (sttTimer) clearInterval(sttTimer);
  sttTimer = window.setInterval(() => {
    processLiveSttSegment().catch((e) => console.warn("[audio] live STT tick failed:", e));
  }, LIVE_TICK_MS);
}

async function processLiveSttSegment({ flush = false } = {}) {
  if (!sttAc || !sttActive) return;
  if (sttBusy) return;
  if (!sttWorkerReady) return;

  const sr = sttAc.sampleRate || TARGET_SR;
  const seg = Math.floor(sr * LIVE_SEG_S);
  const ovl = Math.floor(sr * LIVE_OVER_S);

  const needFresh = Math.max(0, seg - sttTail.length);

  if (sttQueueLen < needFresh) {
    if (!flush) return;

    const min = Math.floor(sr * 0.8);
    if (sttQueueLen + sttTail.length < min) return;
  }

  sttBusy = true;
  const modelId = txModelSel?.value || "Xenova/whisper-tiny.en";

  try {
    setTxStatus("Live STT: transcribing…", "busy");

    const fresh = _takeSttSamples(Math.min(needFresh, sttQueueLen));
    const merged = new Float32Array(sttTail.length + fresh.length);
    merged.set(sttTail, 0);
    merged.set(fresh, sttTail.length);

    sttTail = (merged.length > ovl) ? merged.subarray(merged.length - ovl) : merged;

    const audio16k = _downsampleLinear(merged, sr, TARGET_SR);

    const modelSel = txModelSel?.value || "Xenova/whisper-tiny.en";
    const useVoxtral = isMistralModel(modelSel);

    if (useVoxtral) {
      setTxStatus("Live STT (Voxtral): transcribing…", "busy");

      const wavBlob = float32ToWavBlobMono16(audio16k, TARGET_SR);

      const baseText = txOutEl?.value || "";
      let segText = "";

      await voxtralStreamTranscribeBlob({
        blob: wavBlob,
        model: mistralModelName(modelSel),
        // language: "en", // optional
        onDelta: (cumulative /*, piece */) => {
          // stream UI as base + current segment
          segText = cumulative;
          if (txOutEl) {
            txOutEl.value = baseText + segText;
            txOutEl.scrollTop = txOutEl.scrollHeight;
          }
        },
      });

      // finalize with your overlap-aware merge
      if (txOutEl) {
        txOutEl.value = mergeTranscript(baseText, segText);
        txOutEl.scrollTop = txOutEl.scrollHeight;
      }

      setTxStatus("Live STT (Voxtral): listening…");
    } else {
      setTxStatus("Live STT: transcribing…", "busy");

      const text = await liveAsr(audio16k, modelSel);
      if (text) _appendLiveText(text);

      setTxStatus("Live STT: listening…");
    }


    setTxStatus("Live STT: listening…");
  } catch (e) {
    console.warn("[audio] live STT segment failed:", e);
    setTxStatus(`Live STT failed: ${e?.message || e}`, "err");
  } finally {
    sttBusy = false;
  }
}

async function stopLiveStt({ flush = true } = {}) {
  if (!sttActive && !sttAc) return;

  if (sttTimer) {
    clearInterval(sttTimer);
    sttTimer = 0;
  }

  if (flush) {
    try { await processLiveSttSegment({ flush: true }); } catch { }
  }

  sttActive = false;

  try { sttSrc?.disconnect?.(); } catch { }
  try { sttTap?.disconnect?.(); } catch { }
  try { sttZero?.disconnect?.(); } catch { }

  sttSrc = null;
  sttTap = null;
  sttZero = null;

  if (sttAc) {
    try { await sttAc.close(); } catch { }
    sttAc = null;
  }

  sttQueue = [];
  sttQueueLen = 0;
  sttTail = new Float32Array(0);

  // don't leave spinner stuck
  if (txStatusEl?.dataset?.kind === "busy") setTxStatus("");
}

// --- UI wiring ---------------------------------------------------------
function wireUi(root) {
  const btnRec = root.querySelector("#audio-rec");
  const btnStop = root.querySelector("#audio-stop");
  const btnClear = root.querySelector("#audio-clear");
  const btnDownload = root.querySelector("#audio-download");
  const fileInput = root.querySelector("#audio-file");

  const btnTx = root.querySelector("#audio-transcribe");
  const btnCopy = root.querySelector("#audio-copy");
  const btnTxClear = root.querySelector("#audio-tx-clear");

  btnRec.addEventListener("click", async () => {
    if (isRecording()) return;
    btnRec.disabled = true;
    btnStop.disabled = false;

    await startRecording();

    btnRec.disabled = isRecording() ? true : false;
    btnStop.disabled = isRecording() ? false : true;
  });

  btnStop.addEventListener("click", () => {
    if (!isRecording()) return;
    btnStop.disabled = true;
    stopRecording();
    btnRec.disabled = false;
  });

  btnTx.addEventListener("click", async () => {
    await transcribeCurrentAudio();
  });

  btnClear.addEventListener("click", () => {
    if (isRecording()) stopRecording();
    stopLiveStt({ flush: false }).catch(console.warn);
    stopLiveWave();
    clearAudioState();
    setStatus("Cleared.");
    btnRec.disabled = false;
    btnStop.disabled = true;
  });

  btnDownload.addEventListener("click", () => {
    if (!currentBlob) return;

    const a = document.createElement("a");
    const url = URL.createObjectURL(currentBlob);
    a.href = url;
    a.download = currentBlob.type === "audio/wav" ? "audio.wav" : "audio.bin";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { }
    }, 0);
  });

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0] || null;
    if (!f) return;

    btnRec.disabled = false;
    btnStop.disabled = true;

    await handleFile(f);
    fileInput.value = "";
  });

  btnCopy?.addEventListener("click", async () => {
    const txt = (txOutEl?.value || "").trim();
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setTxStatus("Copied.");
    } catch {
      setTxStatus("Copy failed.", "err");
    }
  });

  btnTxClear?.addEventListener("click", () => {
    if (txOutEl) txOutEl.value = "";
    setTxStatus("Cleared.");
  });

  // toggle live STT while recording
  txLiveToggle?.addEventListener("change", () => {
    if (!isRecording() || !recStream) return;

    if (txLiveToggle.checked) {
      startLiveStt(recStream).catch(console.warn);
    } else {
      stopLiveStt({ flush: false }).catch(console.warn);
      setTxStatus("");
    }
  });

  // switching model during recording restarts live STT
  txModelSel?.addEventListener("change", () => {
    if (!isRecording() || !recStream) return;
    if (!txLiveToggle?.checked) return;

    if (isOpenRouterAudioModel(txModelSel.value)) {
      stopLiveStt({ flush: false }).catch(console.warn);
      setTxStatus("Live STT is not supported for OpenRouter audio models.", "err");
      return;
    }

    stopLiveStt({ flush: false })
      .then(() => startLiveStt(recStream))
      .catch(console.warn);
  });
}

// --- PaneManager lifecycle exports -------------------------------------

let _cleanup = null;
let _onResize = null;
let _onCanvasClick = null;
let _onTimeUpdate = null;

export async function mount({ root }) {
  audioRoot = root;

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    cache: "no-store",
    bust: true,
    replace: true
  });

  canvas = root.querySelector("#audio-wave");
  ctx2d = canvas?.getContext?.("2d") || null;
  audioEl = root.querySelector("#audio-player");
  statusEl = root.querySelector("#audio-status");

  txBtn = root.querySelector("#audio-transcribe");
  txModelSel = root.querySelector("#audio-asr-model");
  txStatusEl = root.querySelector("#audio-asr-status");
  txOutEl = root.querySelector("#audio-transcript");

  txCopyBtn = root.querySelector("#audio-copy");
  txClearBtn = root.querySelector("#audio-tx-clear");
  txLiveToggle = root.querySelector("#audio-live-stt");

  setTxStatus("");
  drawEmptyWave("No audio loaded");
  setStatus("Ready.");

  try { await ensureOpenRouterAudioModels(txModelSel); } catch {}

  // seek by click
  _onCanvasClick = (ev) => {
    if (!audioEl || !lastDuration) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const pct = Math.max(0, Math.min(1, x / Math.max(1, r.width)));
    audioEl.currentTime = pct * lastDuration;
    if (lastPeaks) drawWave(lastPeaks);
  };
  canvas?.addEventListener("click", _onCanvasClick);

  _onTimeUpdate = () => {
    if (lastPeaks) drawWave(lastPeaks);
  };
  audioEl?.addEventListener("timeupdate", _onTimeUpdate);

  _onResize = () => {
    if (!canvas) return;
    if (lastPeaks) drawWave(lastPeaks);
    else drawEmptyWave("No audio loaded");
  };
  window.addEventListener("resize", _onResize);

  wireUi(root);

  _cleanup = () => {
    try { audioEl?.pause?.(); } catch { }
    if (isRecording()) stopRecording();
    stopLiveStt({ flush: false }).catch(() => { });
    stopLiveWave();

    try { window.removeEventListener("resize", _onResize); } catch { }
    try { canvas?.removeEventListener("click", _onCanvasClick); } catch { }
    try { audioEl?.removeEventListener("timeupdate", _onTimeUpdate); } catch { }

    _onResize = null;
    _onCanvasClick = null;
    _onTimeUpdate = null;
  };

  return _cleanup;
}

export async function resume() {
  // redraw if needed
  if (lastPeaks) drawWave(lastPeaks);
  else drawEmptyWave(currentBlob ? "Audio loaded" : "No audio loaded");
}

export async function suspend() {
  // stop anything "active", keep loaded audio state
  try { audioEl?.pause?.(); } catch { }
  if (isRecording()) stopRecording();
  stopLiveStt({ flush: false }).catch(() => { });
  stopLiveWave();
}

export async function unmount() {
  // hard cleanup
  try { _cleanup?.(); } catch { }
  _cleanup = null;
}

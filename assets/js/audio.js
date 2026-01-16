import { mountTemplate, resolveEl } from "./utils.js";
import { bus } from "./events.js";

const HTML = new URL("../html/audio.html", import.meta.url);
const CSS = new URL("../css/audio.css", import.meta.url);

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

let lastPeaks = null; // Float32Array peaks for redraw
let lastDuration = 0;

// --- live waveform (mic) ----------------------------------------------
let liveAc = null;
let liveAnalyser = null;
let liveSrc = null;
let liveRAF = 0;
let liveData = null;

let txBtn = null;
let txModelSel = null;
let txStatusEl = null;
let txOutEl = null;



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

function clearCurrentUrl() {
  if (currentObjectUrl) {
    try { URL.revokeObjectURL(currentObjectUrl); } catch {}
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

function drawEmptyWave(label = "") {
  if (!canvas || !ctx2d) return;

  resizeCanvas();

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx2d.clearRect(0, 0, w, h);

  // baseline
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

function resizeCanvas() {
  if (!canvas || !ctx2d) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 160;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  // Use logical coordinates (CSS pixels)
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function computePeaks(audioBuffer, widthPx) {
  const ch = audioBuffer.getChannelData(0);
  const n = Math.max(60, Math.floor(widthPx)); // enough detail for the visible width
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

  // baseline
  ctx2d.globalAlpha = 0.15;
  ctx2d.beginPath();
  ctx2d.moveTo(0, mid);
  ctx2d.lineTo(w, mid);
  ctx2d.strokeStyle = "#000";
  ctx2d.lineWidth = 1;
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;

  // waveform vertical bars
  const style = getComputedStyle(canvas);
  const stroke = style.color || "#186e78";

  ctx2d.strokeStyle = stroke;
  ctx2d.lineWidth = 1;

  const n = peaks.length;
  const dx = w / n;

  ctx2d.beginPath();
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0, Math.min(1, peaks[i])) * (mid - 6);
    const x = i * dx + 0.5; // a bit crisper
    ctx2d.moveTo(x, mid - amp);
    ctx2d.lineTo(x, mid + amp);
  }
  ctx2d.stroke();

  // label duration
  if (lastDuration) {
    ctx2d.font = "12px system-ui, sans-serif";
    ctx2d.fillStyle = "#666";
    ctx2d.fillText(`${lastDuration.toFixed(2)}s`, 10, h - 10);
  }
}

function audioBufferToWavArrayBuffer(buffer) {
  // 16-bit PCM WAV
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;

  // interleave
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

  // RIFF header
  writeStr("RIFF");
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeStr("WAVE");

  // fmt chunk
  writeStr("fmt ");
  view.setUint32(offset, 16, true); offset += 4;           // PCM chunk size
  view.setUint16(offset, 1, true); offset += 2;            // audio format = PCM
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;           // bits per sample

  // data chunk
  writeStr("data");
  view.setUint32(offset, dataSize, true); offset += 4;

  // samples
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

  // Create a fresh context for decoding (robust across browsers)
  const ac = new AC();
  try {
    // Some browsers want a "detached" ArrayBuffer
    const buf = arrayBuffer.slice(0);
    const audioBuffer = await ac.decodeAudioData(buf);
    return audioBuffer;
  } finally {
    try { await ac.close(); } catch {}
  }
}

// --- Whisper (Transformers.js) ------------------------------------------
// CDN ESM build (no installation needed)
const HF_TRANSFORMERS_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0/dist/transformers.min.js";

let _hf = null;
let _asr = null;
let _asrKey = "";
let _asrLoading = null;

async function loadTransformersJs() {
  if (_hf) return _hf;
  _hf = await import(HF_TRANSFORMERS_URL);

  // Remote models only + cache in browser storage
  _hf.env.allowLocalModels = false;
  _hf.env.useBrowserCache = true;

  return _hf;
}

async function pickDevice() {
  if (navigator.gpu?.requestAdapter) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch {}
  }
  return "wasm";
}


async function getTranscriber(modelId, device) {
  const key = `${modelId}@@${device}`;
  if (_asr && _asrKey === key) return _asr;

  // avoid double-loading
  if (_asrLoading) return _asrLoading;

  _asrLoading = (async () => {
    const { pipeline } = await loadTransformersJs();

    setTxStatus(`Loading model (${device})…`);

    const t = await pipeline(
      "automatic-speech-recognition",
      modelId,
      {
        device,
        progress_callback: (p) => {
          // p can be various shapes; keep it resilient
          const status = p?.status || p?.type || "";
          const prog = (typeof p?.progress === "number") ? ` ${(p.progress * 100).toFixed(0)}%` : "";
          if (status) setTxStatus(`${status}${prog}`);
        }
      }
    );

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

  // Build a mono buffer from input (average channels if needed)
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
  return rendered.getChannelData(0); // Float32Array at 16kHz
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

  if (txBtn) txBtn.disabled = true;
  setTxStatus("Preparing…");

  let device = await pickDevice();
  let transcriber = null;

  try {
    // Load model + auto-fallback
    try {
      transcriber = await getTranscriber(modelId, device);
    } catch (e) {
      if (device === "webgpu") {
        console.warn("[audio] WebGPU failed, falling back to WASM:", e);
        setTxStatus("WebGPU unavailable → falling back to WASM…");
        device = "wasm";
        transcriber = await getTranscriber(modelId, device);
      } else {
        throw e;
      }
    }

    setTxStatus("Decoding + resampling…");
    const audio = await blobToWhisperInput(currentBlob);

    setTxStatus("Transcribing…");
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5
    });

    const text = (out?.text ?? "").trim();
    if (txOutEl) txOutEl.value = text || "(no text)";
    setTxStatus("Done.");
  } catch (e) {
    console.error("[audio] transcribe failed:", e);
    setTxStatus(`Transcribe failed: ${e?.message || e}`, "err");
  } finally {
    if (txBtn) txBtn.disabled = false;
  }
}

async function loadBlobAsCurrent(blob, label = "audio") {
  clearCurrentUrl();

  currentBlob = blob;
  currentObjectUrl = URL.createObjectURL(blob);

  audioEl.src = currentObjectUrl;
  audioEl.load();

  // Decode + wave
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
    } catch {}
  }
  return "";
}

function stopLiveWave() {
  if (liveRAF) {
    cancelAnimationFrame(liveRAF);
    liveRAF = 0;
  }
  liveData = null;

  try { liveSrc?.disconnect?.(); } catch {}
  try { liveAnalyser?.disconnect?.(); } catch {}

  liveSrc = null;
  liveAnalyser = null;

  if (liveAc) {
    try { liveAc.close(); } catch {}
    liveAc = null;
  }
}

async function startLiveWave(stream) {
  stopLiveWave();

  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;

  liveAc = new AC();

  // Ensure it runs after a user gesture (your click handler qualifies)
  try { await liveAc.resume(); } catch {}

  liveSrc = liveAc.createMediaStreamSource(stream);
  liveAnalyser = liveAc.createAnalyser();

  // Good default for time-domain waveform
  liveAnalyser.fftSize = 2048;
  liveAnalyser.smoothingTimeConstant = 0.0;

  liveSrc.connect(liveAnalyser);

  liveData = new Uint8Array(liveAnalyser.fftSize);

  const tick = () => {
    liveRAF = requestAnimationFrame(tick);

    if (!canvas || !ctx2d || !liveAnalyser || !liveData) return;

    // read mic time-domain samples
    liveAnalyser.getByteTimeDomainData(liveData);

    resizeCanvas();

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const mid = h / 2;

    ctx2d.clearRect(0, 0, w, h);

    // baseline
    ctx2d.globalAlpha = 0.15;
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    ctx2d.lineTo(w, mid);
    ctx2d.strokeStyle = "#000";
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;

    // waveform line
    const style = getComputedStyle(canvas);
    const stroke = style.color || "#186e78";

    ctx2d.strokeStyle = stroke;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();

    const n = liveData.length;

    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const v = liveData[i] / 255;  // 0..1 (128 is “center”)
      const y = v * h;

      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }

    ctx2d.stroke();

    // tiny “REC” label
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
    startLiveWave(recStream);
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
    try { recStream?.getTracks()?.forEach(t => t.stop()); } catch {}
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
    stopLiveWave();
    // stop tracks
    try {
      recStream?.getTracks()?.forEach(t => t.stop());
    } catch {}
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

      // Fallback: still load whatever we recorded (may be playable)
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

function wireUi(root) {
  const btnRec = root.querySelector("#audio-rec");
  const btnStop = root.querySelector("#audio-stop");
  const btnClear = root.querySelector("#audio-clear");
  const btnDownload = root.querySelector("#audio-download");
  const fileInput = root.querySelector("#audio-file");
  const btnTx = root.querySelector("#audio-transcribe");

  btnRec.addEventListener("click", async () => {
    if (isRecording()) return;
    btnRec.disabled = true;
    btnStop.disabled = false;

    await startRecording();

    // If recording didn't start, re-enable
    btnRec.disabled = isRecording() ? true : false;
    btnStop.disabled = isRecording() ? false : true;
  });

  btnTx.addEventListener("click", async () => {
    await transcribeCurrentAudio();
  });

  btnStop.addEventListener("click", () => {
    if (!isRecording()) return;
    btnStop.disabled = true;
    stopRecording();
    btnRec.disabled = false;
  });

  btnClear.addEventListener("click", () => {
    if (isRecording()) {
      stopRecording();
    }
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
      try { URL.revokeObjectURL(url); } catch {}
    }, 0);
  });

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0] || null;
    if (!f) return;
    btnRec.disabled = false;
    btnStop.disabled = true;

    await handleFile(f);

    // allow picking the same file again
    fileInput.value = "";
  });

  // Redraw on resize
  window.addEventListener("resize", () => {
    if (!canvas) return;
    if (lastPeaks) drawWave(lastPeaks);
    else drawEmptyWave("No audio loaded");
  });
}

async function initAudioView() {
  const root = resolveEl("#audio-root", { required: false, name: "Audio view: #audio-root" });
  if (!root || root.dataset.initialised === "1") return;

  root.dataset.initialised = "1";
  audioRoot = root;

  // ✅ mount HTML + CSS from files
  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    cache: "no-store",
    bust: true,
    replace: true
  });

  canvas   = root.querySelector("#audio-wave");
  ctx2d    = canvas.getContext("2d");
  audioEl  = root.querySelector("#audio-player");
  statusEl = root.querySelector("#audio-status");

  txBtn      = root.querySelector("#audio-transcribe");
  txModelSel = root.querySelector("#audio-asr-model");
  txStatusEl = root.querySelector("#audio-asr-status");
  txOutEl    = root.querySelector("#audio-transcript");

  setTxStatus("");

  drawEmptyWave("No audio loaded");
  setStatus("Ready.");

  wireUi(root);

  bus.on("right:tab", (ev) => {
    const d = ev?.detail || {};
    const isAudio = (d.paneId === "audio-root" || d.view === "audio");
    if (!isAudio) {
      try { audioEl?.pause?.(); } catch {}
      if (isRecording()) stopRecording();
      stopLiveWave();
    }
  });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => initAudioView().catch(console.error), { once: true });
} else {
  initAudioView().catch(console.error);
}


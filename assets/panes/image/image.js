import { bus as coreBus } from "@core/events.js";
import { mountTemplate, resolveEl } from "@core/utils.js";
import { wireImageDescribeAI } from "./ai.js";

const HTML = new URL("./image.html", import.meta.url);
const CSS = new URL("./image.css", import.meta.url);

// --- module state ----------------------------------------------------------
let _root = null;
let _bus = null;

let _els = {};
let _stream = null;
let _cameraSupported = true;
let _cameraBusy = false;

let _ai = null;
let _aiBusy = false;
let _aiOutput = "";

let _current = {
  blob: null,
  name: null,
  source: null, // "upload" | "drop" | "camera"
  objectUrl: null,
  width: null,
  height: null,
};

let _cameraHasCapture = false;

// --- small helpers ---------------------------------------------------------
function _emit(type, detail) {
  try {
    _bus?.emit?.(type, detail);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {}
}

function _fmtBytes(n) {
  const x = Number(n || 0);
  if (!isFinite(x) || x <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let v = x;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2);
  return `${s} ${units[i]}`;
}

function _nowStamp() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function _setStatus(msg) {
  if (_els.status) _els.status.textContent = msg || "";
}

function _setMeta({ source = "-", size = "-", dims = "-" } = {}) {
  if (_els.metaSource) _els.metaSource.textContent = source;
  if (_els.metaSize) _els.metaSize.textContent = size;
  if (_els.metaDims) _els.metaDims.textContent = dims;
}

function _setAiOutput(text) {
  const value = String(text || "").trim();
  _aiOutput = value;

  if (_els.aiOutput) _els.aiOutput.value = value;

  if (_els.aiHud) _els.aiHud.hidden = !value;

  _updateButtons();
}


function _revokeObjectUrl() {
  if (_current.objectUrl) {
    try {
      URL.revokeObjectURL(_current.objectUrl);
    } catch {}
  }
  _current.objectUrl = null;
}

function _hide(el, yes = true) {
  if (!el) return;
  el.hidden = !!yes;
}

function _showDropHint(show) {
  if (!_els.drop) return;
  _els.drop.classList.toggle("hidden", !show);
}

function _updateButtons() {
  const hasImage = !!_current.blob;
  const camOn = !!_stream;
  const busy = !!(_cameraBusy || _aiBusy);
  const hasOutput = !!_aiOutput;

  if (_els.file) _els.file.disabled = busy;
  if (_els.describe) _els.describe.disabled = !hasImage || busy;

  if (_els.camera) {
    _els.camera.disabled = !_cameraSupported || busy;
    _els.camera.textContent = camOn ? "Stop camera" : "Start camera";
    _els.camera.title = camOn ? "Stop webcam" : "Start webcam";
  }

  if (_els.capture) _els.capture.disabled = !camOn || busy;
  if (_els.clear) _els.clear.disabled = !(camOn || hasImage) || busy;
  if (_els.download) _els.download.disabled = !hasImage || busy;
  if (_els.aiCopy) _els.aiCopy.disabled = !hasOutput || busy;

  if (_els.capture) _els.capture.textContent = _cameraHasCapture ? "Retake" : "Capture";
}

function _stopStream() {
  if (_stream) {
    try {
      _stream.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  _stream = null;
  _cameraHasCapture = false;

  if (_els.video) {
    try {
      _els.video.pause();
    } catch {}
    try {
      _els.video.srcObject = null;
    } catch {}
  }

  _hide(_els.video, true);
  _hide(_els.canvas, true);

  _updateButtons();
}

async function _setImageFromBlob(
  blob,
  {
    name = "image.png",
    source = "upload",
    status = "Loaded image.",
    stopCamera = true,
  } = {}
) {
  if (!blob) return;

  if (stopCamera) _stopStream();

  _revokeObjectUrl();

  _current.blob = blob;
  _current.name = name;
  _current.source = source;

  const url = URL.createObjectURL(blob);
  _current.objectUrl = url;

  _hide(_els.video, true);
  _hide(_els.canvas, true);

  if (_els.img) {
    _els.img.src = url;
    _hide(_els.img, false);

    await new Promise((resolve) => {
      const img = _els.img;
      if (!img) return resolve();
      const done = () => resolve();
      if (img.complete && img.naturalWidth) return done();
      img.onload = () => done();
      img.onerror = () => done();
    });

    _current.width = _els.img?.naturalWidth || null;
    _current.height = _els.img?.naturalHeight || null;
  }

  _showDropHint(false);
  _setAiOutput("");

  _setStatus(status);
  _setMeta({
    source,
    size: _fmtBytes(blob.size),
    dims: _current.width && _current.height ? `${_current.width} x ${_current.height}` : "-",
  });

  _updateButtons();

  _emit("image:changed", {
    source,
    name,
    size: blob.size,
    type: blob.type,
    width: _current.width,
    height: _current.height,
    blob,
  });
}

function _clearImage({ keepCamera = false } = {}) {
  _revokeObjectUrl();

  _current.blob = null;
  _current.name = null;
  _current.source = null;
  _current.width = null;
  _current.height = null;

  if (_els.img) {
    try {
      _els.img.removeAttribute("src");
    } catch {}
    _hide(_els.img, true);
  }

  if (!keepCamera) _stopStream();

  _showDropHint(true);
  _setStatus("Ready.");
  _setMeta();
  _setAiOutput("");

  _updateButtons();

  _emit("image:cleared", {});
}

async function _startCamera() {
  _cameraBusy = true;
  _updateButtons();

  try {
    _setStatus("Requesting camera...");

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });

    _stream = stream;
    _cameraHasCapture = false;

    _clearImage({ keepCamera: true });

    if (_els.video) {
      _els.video.srcObject = stream;
      _hide(_els.video, false);
      _hide(_els.img, true);
      _hide(_els.canvas, true);

      await _els.video.play().catch(() => {});
    }

    _showDropHint(false);
    _setStatus("Camera ready.");
    _setMeta({ source: "camera", size: "-", dims: "-" });
  } catch (err) {
    _stopStream();
    _setStatus(`Camera error: ${err?.message || String(err)}`);
  } finally {
    _cameraBusy = false;
    _updateButtons();
  }
}

async function _toggleCamera() {
  if (_cameraBusy) return;

  if (_stream) {
    _stopStream();
    _showDropHint(!_current.blob);
    _setStatus(_current.blob ? "Loaded image." : "Ready.");
    if (!_current.blob) _setMeta();
    _updateButtons();
    return;
  }

  await _startCamera();
}

async function _captureFrame() {
  if (!_stream || !_els.video || !_els.canvas) return;

  if (_cameraHasCapture) {
    _cameraHasCapture = false;
    _hide(_els.img, true);
    _hide(_els.canvas, true);
    _hide(_els.video, false);
    _setStatus("Camera ready.");
    _updateButtons();
    return;
  }

  const v = _els.video;
  const c = _els.canvas;

  const w = v.videoWidth || 1280;
  const h = v.videoHeight || 720;

  c.width = w;
  c.height = h;

  const ctx = c.getContext("2d");
  ctx.drawImage(v, 0, 0, w, h);

  _setStatus("Captured frame...");

  const blob = await new Promise((resolve) => {
    c.toBlob((b) => resolve(b), "image/png");
  });

  if (!blob) {
    _setStatus("Capture failed (no blob).");
    return;
  }

  _cameraHasCapture = true;
  _hide(_els.video, true);
  _hide(_els.canvas, true);

  await _setImageFromBlob(blob, {
    name: `capture_${_nowStamp()}.png`,
    source: "camera",
    status: "Captured frame.",
    stopCamera: false,
  });

  _setMeta({ source: "camera", size: "-", dims: "-" });
}

function _downloadCurrent() {
  if (!_current.blob) return;

  const blob = _current.blob;
  const name = _current.name || `image_${_nowStamp()}.png`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;

  (document.body || document.documentElement).appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 0);

  _setStatus(`Downloaded ${name}`);
}

async function _copyAiOutput() {
  if (!_aiOutput) return;

  try {
    if (!navigator.clipboard?.writeText) {
      _setStatus("Clipboard unavailable in this browser/context.");
      return;
    }

    await navigator.clipboard.writeText(_aiOutput);
    _setStatus("Description copied to clipboard.");
  } catch (err) {
    _setStatus(`Copy failed: ${err?.message || String(err)}`);
  }
}

function _onFile(file, source = "upload") {
  if (!file) return;
  if (!file.type || !file.type.startsWith("image/")) {
    _setStatus("Not an image file.");
    return;
  }
  _setImageFromBlob(file, {
    name: file.name || `image_${_nowStamp()}.png`,
    source,
    status: "Loaded image.",
  });
}

function _wireDragDrop(stageEl) {
  const el = stageEl;
  if (!el) return;

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  el.addEventListener("dragenter", (e) => {
    prevent(e);
    el.classList.add("dragover");
    _showDropHint(true);
  });

  el.addEventListener("dragover", (e) => {
    prevent(e);
    el.classList.add("dragover");
    _showDropHint(true);
  });

  el.addEventListener("dragleave", (e) => {
    prevent(e);
    el.classList.remove("dragover");
    _showDropHint(!_current.blob && !_stream);
  });

  el.addEventListener("drop", (e) => {
    prevent(e);
    el.classList.remove("dragover");

    const file = e.dataTransfer?.files?.[0] || null;
    if (file) _onFile(file, "drop");

    _showDropHint(!_current.blob && !_stream);
  });
}

// --- PaneManager lifecycle exports -----------------------------------------
export async function mount({ root, bus }) {
  _root = root;
  _bus = bus || coreBus;

  await mountTemplate(root, {
    templateUrl: HTML,
    cssUrl: CSS,
    cache: "no-store",
    bust: true,
    replace: true,
  });

  _els = {
    file: resolveEl("#image-file", { root, required: false }),
    camera: resolveEl("#image-camera", { root, required: false }),
    capture: resolveEl("#image-capture", { root, required: false }),
    clear: resolveEl("#image-clear", { root, required: false }),
    download: resolveEl("#image-download", { root, required: false }),

    status: resolveEl("#image-status", { root, required: false }),

    stage: resolveEl("#image-stage", { root, required: false }),
    drop: resolveEl("#image-drop", { root, required: false }),
    video: resolveEl("#image-video", { root, required: false }),
    canvas: resolveEl("#image-canvas", { root, required: false }),
    img: resolveEl("#image-preview", { root, required: false }),

    metaSource: resolveEl("#image-source", { root, required: false }),
    metaSize: resolveEl("#image-size", { root, required: false }),
    metaDims: resolveEl("#image-dims", { root, required: false }),

    describe: resolveEl("#image-describe", { root, required: false }),
    aiOutput: resolveEl("#image-ai-output", { root, required: false }),
    aiCopy: resolveEl("#image-ai-copy", { root, required: false }),
    aiHud: resolveEl("#image-ai-hud", { root, required: false }),
  };

  _setAiOutput("");

  _ai = wireImageDescribeAI({
    root,
    getImageBlob: () => _current.blob,
    setBusy: (v) => {
      _aiBusy = !!v;
      _updateButtons();
    },
    setStatus: _setStatus,
    setOutput: _setAiOutput,
    emit: _emit,
    title: "OntoGSN Workbench (Image pane)",
  });

  _els.file?.addEventListener("change", (e) => {
    const f = e.target?.files?.[0] || null;
    if (f) _onFile(f, "upload");
    try {
      e.target.value = "";
    } catch {}
  });

  _cameraSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!_cameraSupported) {
    if (_els.camera) _els.camera.disabled = true;
    _setStatus("Camera not supported in this browser/context.");
  }

  _els.camera?.addEventListener("click", (e) => {
    e.preventDefault();
    _toggleCamera();
  });

  _els.capture?.addEventListener("click", (e) => {
    e.preventDefault();
    _captureFrame();
  });

  _els.clear?.addEventListener("click", (e) => {
    e.preventDefault();
    _clearImage();
  });

  _els.download?.addEventListener("click", (e) => {
    e.preventDefault();
    _downloadCurrent();
  });

  _els.aiCopy?.addEventListener("click", (e) => {
    e.preventDefault();
    _copyAiOutput();
  });

  _wireDragDrop(_els.stage);

  _showDropHint(true);
  _setMeta();
  _updateButtons();

  return () => {
    _stopStream();
    _revokeObjectUrl();

    try {
      _ai?.destroy?.();
    } catch {}
    _ai = null;
    _aiBusy = false;
    _aiOutput = "";

    _root = null;
    _bus = null;
    _els = {};
  };
}

export async function resume() {
  _updateButtons();
}

export async function suspend() {
  _stopStream();
  _updateButtons();
}

export async function unmount() {
  _stopStream();
  _revokeObjectUrl();
}

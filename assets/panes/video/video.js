import { bus as coreBus } from "@core/events.js";
import { mountTemplate, resolveEl } from "@core/utils.js";

const HTML = new URL("./video.html", import.meta.url);
const CSS = new URL("./video.css", import.meta.url);

let _root = null;
let _bus = null;

let _els = {};
let _ac = null;

let _stream = null;
let _previewStream = null;
let _recorder = null;
let _chunks = [];

let _recordedBlob = null;
let _recordedUrl = null;

let _timerHandle = null;
let _recStartMs = 0;

function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

function fmtBytes(bytes) {
    const b = Math.max(0, Number(bytes || 0));
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
}

function isProbablyLocalhost() {
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function setStatus(msg, { error = false } = {}) {
    if (!_els.status) return;
    _els.status.textContent = String(msg || "");
    _els.status.classList.toggle("is-error", !!error);
}

function setRecordingUI(isRec) {
    _els.rec.hidden = !isRec;
    _els.startRec.disabled = isRec || !_stream || !("MediaRecorder" in window);
    _els.stopRec.disabled = !isRec;
}

function setCameraUI(isOn) {
    _els.startCam.disabled = !!isOn;
    _els.stopCam.disabled = !isOn;
    _els.cameraSel.disabled = !isOn;
    _els.startRec.disabled = !isOn || !("MediaRecorder" in window);
}

function clearTimer() {
    if (_timerHandle) {
        clearInterval(_timerHandle);
        _timerHandle = null;
    }
}

function startTimer() {
    clearTimer();
    _recStartMs = performance.now();
    _els.timer.textContent = "00:00";
    _timerHandle = setInterval(() => {
        _els.timer.textContent = fmtTime(performance.now() - _recStartMs);
    }, 200);
}

function revokeRecordedUrl() {
    if (_recordedUrl) {
        try { URL.revokeObjectURL(_recordedUrl); } catch { }
    }
    _recordedUrl = null;
}

function setDownloadEnabled(enabled, filename = "") {
    const a = _els.download;
    if (!a) return;

    if (!enabled || !_recordedUrl) {
        a.classList.add("disabled");
        a.setAttribute("aria-disabled", "true");
        a.removeAttribute("download");
        a.href = "#";
        return;
    }

    a.classList.remove("disabled");
    a.setAttribute("aria-disabled", "false");
    a.href = _recordedUrl;
    a.download = filename || "recording.webm";
}

function guessExtension(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("mp4")) return "mp4";
    if (m.includes("webm")) return "webm";
    if (m.includes("matroska") || m.includes("mkv")) return "mkv";
    return "webm";
}

function buildFilename(mime) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `ontogsn_recording_${stamp}.${guessExtension(mime)}`;
}

function getSupportedMimeCandidates() {
    // Order matters: prefer higher-quality webm first, then fall back.
    return [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4",
    ];
}

function detectSupportedMimes() {
    const out = [];
    if (!("MediaRecorder" in window)) return out;

    for (const t of getSupportedMimeCandidates()) {
        try {
            if (MediaRecorder.isTypeSupported(t)) out.push(t);
        } catch {
            // ignore weird UA behavior
        }
    }
    return out;
}

function applyMimeOptions() {
    const sel = _els.mimeSel;
    if (!sel) return;

    sel.replaceChildren();

    const supported = detectSupportedMimes();
    if (!supported.length) {
        // Leave blank -> we’ll let the browser choose recorder defaults.
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(browser default)";
        sel.appendChild(opt);
        sel.disabled = false;
        return;
    }

    for (const t of supported) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
    }

    sel.disabled = false;
}

async function refreshCameraList({ keepSelection = true } = {}) {
    const sel = _els.cameraSel;
    if (!sel || !navigator.mediaDevices?.enumerateDevices) return;

    const prev = keepSelection ? sel.value : "";

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");

    sel.replaceChildren();

    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default";
    sel.appendChild(def);

    for (const d of cams) {
        const opt = document.createElement("option");
        opt.value = d.deviceId || "";
        opt.textContent = d.label || "Camera";
        sel.appendChild(opt);
    }

    // Restore selection if possible
    if (prev && Array.from(sel.options).some(o => o.value === prev)) {
        sel.value = prev;
    }
}

function buildConstraints() {
    const wantAudio = !!_els.audioChk?.checked;

    const res = String(_els.resSel?.value || "auto");
    let video = true;

    if (res === "720p") {
        video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    } else if (res === "1080p") {
        video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    }

    const camId = String(_els.cameraSel?.value || "");
    if (camId) {
        // merge deviceId constraint
        if (video === true) video = {};
        video.deviceId = { exact: camId };
    }

    return { video, audio: wantAudio };
}

async function stopRecording({ finalize = true } = {}) {
    if (!_recorder) return;

    const rec = _recorder;

    return new Promise((resolve) => {
        const done = () => resolve();

        // If stop event already fired or recorder is inactive, just resolve.
        if (rec.state === "inactive") {
            _recorder = null;
            _chunks = [];
            clearTimer();
            setRecordingUI(false);
            done();
            return;
        }

        rec.addEventListener("stop", () => {
            // Finalize into a blob
            try {
                if (finalize) {
                    const type = rec.mimeType || (_els.mimeSel?.value || "video/webm");
                    const blob = new Blob(_chunks, { type: type || "video/webm" });

                    _recordedBlob = blob;
                    revokeRecordedUrl();
                    _recordedUrl = URL.createObjectURL(blob);

                    showRecording();

                    const filename = buildFilename(blob.type || type);
                    setDownloadEnabled(true, filename);

                    _els.clear.disabled = false;

                    _els.meta.textContent = `Saved: ${fmtBytes(blob.size)} • ${blob.type || "video"}`;

                    if (_els.backLive) _els.backLive.disabled = !_stream;
                }
            } catch (e) {
                setStatus(`Recording stopped, but could not finalize: ${e?.message || e}`, { error: true });
            } finally {
                _recorder = null;
                _chunks = [];
                clearTimer();
                setRecordingUI(false);
                done();
            }
        }, { once: true });

        try {
            rec.stop();
        } catch {
            // If stop fails, still reset UI
            _recorder = null;
            _chunks = [];
            clearTimer();
            setRecordingUI(false);
            done();
        }
    });
}

function setStageLabels(kind) {
    if (_els.stageTitle) _els.stageTitle.textContent = (kind === "recording") ? "Last recording" : "Live preview";
    if (_els.stageHint) {
        _els.stageHint.textContent =
            (kind === "recording")
                ? "Playback of the last recording."
                : "Tip: preview is muted to avoid feedback.";
    }
}

async function tryPlayVideo(el) {
    if (!el) return false;
    try {
        await el.play();
        return true;
    } catch {
        return false;
    }
}

function showLive() {
    const v = _els.stage;
    if (!v) return;

    // Stage should show the live stream (video-only) and be muted
    setStageLabels("live");

    v.pause?.();

    // Clear blob playback first
    v.removeAttribute("src");
    v.load?.();

    v.muted = true;
    v.defaultMuted = true;
    v.volume = 0;
    v.autoplay = true;
    v.playsInline = true;
    v.controls = false;

    v.srcObject = _previewStream || null;

    // Best-effort autoplay; fallback to click-to-play
    tryPlayVideo(v).then((ok) => {
        if (ok) return;
        v.addEventListener("loadedmetadata", () => { tryPlayVideo(v); }, { once: true });
        v.addEventListener("click", () => { tryPlayVideo(v); }, { once: true });
    });

    // Back-to-live only makes sense when recording exists and camera is on
    if (_els.backLive) _els.backLive.disabled = true;
}

function showRecording() {
    const v = _els.stage;
    if (!v || !_recordedUrl) return;

    setStageLabels("recording");

    // Stage should show the recorded blob and be controllable
    v.pause?.();

    v.srcObject = null;
    v.muted = false;
    v.autoplay = false;
    v.controls = true;
    v.playsInline = true;

    v.src = _recordedUrl;
    v.load?.();

    // Optional: auto-start playback once the recording is ready
    // (Comment out if you prefer not auto-playing the result)
    tryPlayVideo(v);

    if (_els.backLive) _els.backLive.disabled = !_stream; // only if camera is still on
}


function stopCameraTracks() {
    if (_stream) {
        try {
            for (const tr of _stream.getTracks()) tr.stop();
        } catch { }
    }
    _stream = null;
    _previewStream = null;

    if (_els.stage) {
        try { _els.stage.pause?.(); } catch { }
        _els.stage.srcObject = null;
    }

    setCameraUI(false);
}

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Webcam not available: navigator.mediaDevices.getUserMedia is missing.", { error: true });
        return;
    }

    // getUserMedia requires secure context (HTTPS) or localhost
    if (!window.isSecureContext && !isProbablyLocalhost()) {
        setStatus(
            "Webcam access requires HTTPS (secure context). Tip: run this app on https:// or on localhost.",
            { error: true }
        );
        return;
    }

    // If recording, stop first (finalize what we have)
    await stopRecording({ finalize: true });

    // If camera already on, stop it (to re-apply constraints)
    stopCameraTracks();

    const constraints = buildConstraints();

    setStatus("Requesting camera permission…");
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        _stream = stream;

        // ---- Preview: use VIDEO-ONLY stream + force-muted BEFORE play ----------
        // Autoplay policies are much happier with muted + no audio tracks.
        _previewStream = new MediaStream(stream.getVideoTracks());

        showLive();
        setCameraUI(true);
        setStatus("Camera is on. (If preview stays black, click the preview once.)");

        // Now that we have permission, we can populate camera labels
        await refreshCameraList({ keepSelection: true });
        _els.cameraSel.disabled = false;

        // Recording support check
        if (!("MediaRecorder" in window)) {
            setStatus("Camera is on, but MediaRecorder is not supported in this browser (recording disabled).", { error: true });
            _els.startRec.disabled = true;
        } else {
            _els.startRec.disabled = false;
        }

    } catch (e) {
        setStatus(`Could not start camera: ${e?.name || ""} ${e?.message || e}`, { error: true });
        stopCameraTracks();
    }
}

async function startRecording() {
    if (!_stream) {
        setStatus("Start the camera first.", { error: true });
        return;
    }
    if (!("MediaRecorder" in window)) {
        setStatus("Recording not available: MediaRecorder is not supported in this browser.", { error: true });
        return;
    }

    // Clear previous recording URL from playback, but keep it until user clicks Clear.
    _chunks = [];
    _els.meta.textContent = "";
    showLive();

    const selectedMime = String(_els.mimeSel?.value || "");
    const opts = {};

    if (selectedMime) {
        try {
            if (MediaRecorder.isTypeSupported(selectedMime)) {
                opts.mimeType = selectedMime;
            }
        } catch { }
    }

    let rec;
    try {
        rec = new MediaRecorder(_stream, opts);
    } catch (e) {
        // Some browsers are picky about mimeType; retry with defaults
        try {
            rec = new MediaRecorder(_stream);
        } catch (e2) {
            setStatus(`Could not start recorder: ${e2?.message || e2}`, { error: true });
            return;
        }
    }

    _recorder = rec;

    rec.addEventListener("dataavailable", (ev) => {
        if (ev.data && ev.data.size > 0) _chunks.push(ev.data);
    });

    rec.addEventListener("error", (ev) => {
        setStatus(`Recorder error: ${ev?.error?.message || ev?.message || "unknown error"}`, { error: true });
    });

    try {
        rec.start();
        startTimer();
        setRecordingUI(true);
        setStatus("Recording…");
    } catch (e) {
        _recorder = null;
        setRecordingUI(false);
        setStatus(`Could not start recording: ${e?.message || e}`, { error: true });
    }
}

async function clearRecording() {
    // If currently recording, stop but do NOT finalize a new blob (user is clearing)
    await stopRecording({ finalize: false });

    _recordedBlob = null;
    revokeRecordedUrl();
    if (_els.backLive) _els.backLive.disabled = true;

    if (_stream) showLive();
    else {
        const v = _els.stage;
        if (v) {
            v.pause?.();
            v.srcObject = null;
            v.removeAttribute("src");
            v.controls = false;
            v.load?.();
        }
        setStageLabels("live");
    }

    _els.meta.textContent = "";
    setDownloadEnabled(false);
    _els.clear.disabled = true;

    setStatus("Cleared recording.");
}

async function stopAll() {
    // Finalize recording if in progress
    await stopRecording({ finalize: true });
    stopCameraTracks();
}

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

    _ac = new AbortController();

    _els = {
        startCam: resolveEl("#vid-startCam", { root }),
        stopCam: resolveEl("#vid-stopCam", { root }),
        startRec: resolveEl("#vid-startRec", { root }),
        stopRec: resolveEl("#vid-stopRec", { root }),
        clear: resolveEl("#vid-clear", { root }),

        cameraSel: resolveEl("#vid-camera", { root, required: false }),
        resSel: resolveEl("#vid-res", { root, required: false }),
        audioChk: resolveEl("#vid-audio", { root, required: false }),
        mimeSel: resolveEl("#vid-mime", { root, required: false }),

        download: resolveEl("#vid-download", { root }),
        stage: resolveEl("#vid-stage", { root }),
        stageTitle: resolveEl("#vid-stageTitle", { root, required: false }),
        stageHint: resolveEl("#vid-stageHint", { root, required: false }),
        backLive: resolveEl("#vid-backLive", { root, required: false }),

        rec: resolveEl("#vid-rec", { root }),
        timer: resolveEl("#vid-timer", { root }),
        meta: resolveEl("#vid-meta", { root }),
        status: resolveEl("#vid-status", { root }),
    };

    // Initial capability checks
    applyMimeOptions();

    if (!("MediaRecorder" in window)) {
        _els.startRec.disabled = true;
        _els.stopRec.disabled = true;
        _els.mimeSel.disabled = true;
        setStatus("Ready. Note: MediaRecorder not supported in this browser (recording disabled).");
    } else {
        _els.mimeSel.disabled = false;
        setStatus("Ready.");
    }

    setDownloadEnabled(false);
    setCameraUI(false);
    setRecordingUI(false);
    _els.clear.disabled = true;

    _els.startCam.addEventListener("click", () => startCamera(), { signal: _ac.signal });
    _els.stopCam.addEventListener("click", () => stopAll(), { signal: _ac.signal });

    _els.startRec.addEventListener("click", () => startRecording(), { signal: _ac.signal });
    _els.stopRec.addEventListener("click", () => stopRecording({ finalize: true }), { signal: _ac.signal });

    _els.clear.addEventListener("click", () => clearRecording(), { signal: _ac.signal });

    // If user changes camera/res/audio while camera is on, we restart camera
    const restartIfOn = async () => {
        if (!_stream) return;
        await startCamera();
    };

    _els.cameraSel?.addEventListener("change", restartIfOn, { signal: _ac.signal });
    _els.resSel?.addEventListener("change", restartIfOn, { signal: _ac.signal });
    _els.audioChk?.addEventListener("change", restartIfOn, { signal: _ac.signal });

    // Download link guard (avoid “#” navigation when disabled)
    _els.download.addEventListener("click", (ev) => {
        if (_els.download.classList.contains("disabled")) {
            ev.preventDefault();
            ev.stopPropagation();
        }
    }, { signal: _ac.signal });

    _els.backLive?.addEventListener("click", () => {
        if (_stream) showLive();
    }, { signal: _ac.signal });

    // Populate camera list (labels may be blank until permission granted)
    try { await refreshCameraList({ keepSelection: true }); } catch { }

    return () => {
        // cleanup
        try { _ac?.abort(); } catch { }
        _ac = null;

        // Stop everything and release resources
        // (don’t await here; pane manager doesn’t require cleanup to be async)
        stopAll();

        revokeRecordedUrl();

        _root = null;
        _bus = null;
        _els = {};
    };
}

export async function resume() {
    // no-op: we keep last recording in memory; camera stays off unless user restarts
}

export async function suspend() {
    // Privacy-friendly: stop camera when switching away.
    await stopAll();
}

export async function unmount() {
    // If cache:false ever used in registerPane, this will be called.
    await stopAll();
    revokeRecordedUrl();
}

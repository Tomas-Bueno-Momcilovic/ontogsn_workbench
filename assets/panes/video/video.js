import { bus as coreBus } from "@core/events.js";
import { mountTemplate, resolveEl, fmtBytes, fmtTimeMs } from "@core/utils.js";
import { createFrameViewer } from "./frameViewer.js";
import { createVideoAI, ensureOpenRouterVideoModels } from "./ai.js";

let _ai = null;
let _aiBusy = false;
let _aiOutput = "";

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

let _frameViewer = null;

function isProbablyLocalhost() {
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function setStatus(msg, { error = false } = {}) {
    if (!_els.status) return;
    _els.status.textContent = String(msg || "");
    _els.status.classList.toggle("is-error", !!error);
}

function isRecordingActive() {
    return !!_recorder && _recorder.state !== "inactive";
}

function setRecordingUI(isRec) {
    const canRecord = !!_stream && ("MediaRecorder" in window);

    _els.rec.hidden = !isRec;

    const frame = _root?.querySelector(".video-frame");
    frame?.classList.toggle("is-recording", !!isRec);

    if (_els.recToggle) {
        _els.recToggle.textContent = isRec ? "Stop" : "Record";
        _els.recToggle.disabled = isRec ? false : !canRecord;
        _els.recToggle.setAttribute("aria-pressed", isRec ? "true" : "false");
    }
}

function setCameraUI(isOn) {
    if (_els.camToggle) {
        _els.camToggle.textContent = isOn ? "Disable camera" : "Enable camera";
        _els.camToggle.setAttribute("aria-pressed", isOn ? "true" : "false");
        _els.camToggle.disabled = false;
    }

    if (_els.cameraSel) _els.cameraSel.disabled = !isOn;

    if (_els.recToggle) {
        const canRecord = isOn && ("MediaRecorder" in window);
        // If currently recording, keep enabled so user can stop
        _els.recToggle.disabled = isRecordingActive() ? false : !canRecord;
    }
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

let _view = "live";

function syncViewButtons() {
    if (_els.viewLive) {
        const canLive = !!_stream; // camera on
        _els.viewLive.disabled = !canLive;
        _els.viewLive.classList.toggle("is-active", _view === "live");
        _els.viewLive.setAttribute("aria-pressed", _view === "live" ? "true" : "false");
    }

    if (_els.viewRec) {
        const canRecView = !!_recordedUrl; // recording exists
        _els.viewRec.disabled = !canRecView;
        _els.viewRec.classList.toggle("is-active", _view === "recording");
        _els.viewRec.setAttribute("aria-pressed", _view === "recording" ? "true" : "false");
    }
}


function applyMimeOptions() {
    const sel = _els.mimeSel;
    if (!sel) return;

    sel.replaceChildren();

    const supported = detectSupportedMimes();
    if (!supported.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(browser default)";
        sel.appendChild(opt);
        sel.disabled = false;
        syncOptionLabels();
        return;
    }


    for (const t of supported) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
    }

    sel.disabled = false;
    syncOptionLabels();
}

function closeOptionsMenu() {
    if (!_els.optionsPanel || !_els.optionsBtn) return;

    _els.optionsPanel.hidden = true;
    _els.optionsBtn.setAttribute("aria-expanded", "false");

    // close any open submenu
    _els.optionsPanel.querySelectorAll(".video-submenu.is-open").forEach(n => {
        n.classList.remove("is-open");
        const b = n.querySelector(".video-submenu-btn");
        if (b) b.setAttribute("aria-expanded", "false");
    });
}

function openOptionsMenu() {
    if (!_els.optionsPanel || !_els.optionsBtn) return;
    _els.optionsPanel.hidden = false;
    _els.optionsBtn.setAttribute("aria-expanded", "true");
}

function toggleOptionsMenu() {
    if (!_els.optionsPanel) return;
    if (_els.optionsPanel.hidden) openOptionsMenu();
    else closeOptionsMenu();
}

function syncOptionLabels() {
    // Camera label (uses selected option text)
    if (_els.cameraLabel && _els.cameraSel) {
        const opt = _els.cameraSel.selectedOptions?.[0];
        _els.cameraLabel.textContent = opt?.textContent?.trim() || "Default";
    }

    // Resolution label
    if (_els.resLabel && _els.resSel) {
        const opt = _els.resSel.selectedOptions?.[0];
        _els.resLabel.textContent = opt?.textContent?.trim() || "Auto";
    }

    // Format label
    if (_els.mimeLabel && _els.mimeSel) {
        const opt = _els.mimeSel.selectedOptions?.[0];
        _els.mimeLabel.textContent = opt?.textContent?.trim() || "(browser default)";
    }

    if (_els.aiModelLabel && _els.aiModel) {
        const v = String(_els.aiModel.value || "").trim();
        _els.aiModelLabel.textContent = v || "openai/gpt-4o-mini";
    }
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
    syncOptionLabels();
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

let _stopPromise = null;

async function stopRecording({ finalize = true } = {}) {
    if (_stopPromise) return _stopPromise;
    if (!_recorder) return;

    const rec = _recorder;

    _stopPromise = new Promise((resolve) => {
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
                    syncViewButtons();
                    _ai?.sync?.();

                    _frameViewer?.rebuild().catch(() => { });

                    _els.clear.disabled = false;

                    _els.meta.textContent = `Saved: ${fmtBytes(blob.size)} • ${blob.type || "video"}`;

                    if (_els.backLive) _els.backLive.disabled = !_stream;
                    setAiOutput("");
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
    }).finally(() => { _stopPromise = null; });

    return _stopPromise;
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
    _view = "live";
    const v = _els.stage;
    if (!v) return;

    setStageLabels("live");

    try { v.pause?.(); } catch { }

    v.srcObject = null;
    v.removeAttribute("src");
    v.load?.();

    v.muted = true;
    v.defaultMuted = true;
    v.autoplay = true;
    v.playsInline = true;
    v.controls = false;

    v.srcObject = _previewStream || null;

    const kick = () => v.play().catch(() => { });
    kick();
    v.addEventListener("loadedmetadata", kick, { once: true });
    v.addEventListener("canplay", kick, { once: true });

    syncViewButtons();
}


function showRecording() {
    _view = "recording";
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

    syncViewButtons();
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
    syncViewButtons();
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
        if (_els.cameraSel) _els.cameraSel.disabled = false;

        // Recording support check
        if (!("MediaRecorder" in window)) {
            setStatus("Camera is on, but MediaRecorder is not supported in this browser (recording disabled).", { error: true });
            _els.recToggle.disabled = true;
        } else {
            _els.recToggle.disabled = false;
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
    _frameViewer?.clear();
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
    syncViewButtons();
    _ai?.sync?.();
    setAiOutput("");

    setStatus("Cleared recording.");
}

async function loadUploadedFile(file) {
    if (!(file instanceof File) || file.size <= 0) return;

    // If currently recording, stop without finalizing a new blob (we're replacing it).
    await stopRecording({ finalize: false });

    // Replace current "recording" with uploaded file
    _recordedBlob = file;

    revokeRecordedUrl();
    _recordedUrl = URL.createObjectURL(file);

    // Switch stage to playback
    showRecording();

    // Enable download using the original filename if possible
    const filename = (file.name && String(file.name).trim()) || buildFilename(file.type);
    setDownloadEnabled(true, filename);

    // UI + tools
    _els.clear.disabled = false;
    syncViewButtons();
    _ai?.sync?.();

    _frameViewer?.rebuild().catch(() => { });

    // First line becomes the "base" line AI preserves
    if (_els.meta) {
        _els.meta.textContent =
            `Loaded: ${filename} • ${fmtBytes(file.size)} • ${file.type || "video"}`;
    }

    setStatus("Loaded video file.");
    setAiOutput("");

}


async function stopAll() {
    // Finalize recording if in progress
    await stopRecording({ finalize: true });
    stopCameraTracks();
}

function setAiOutput(text) {
    const value = String(text || "").trim();
    _aiOutput = value;

    if (_els.aiOutput) _els.aiOutput.value = value;
    if (_els.aiHud) _els.aiHud.hidden = !value;

    // Keep the Describe button state sensible while AI runs
    if (_els.aiToggle) {
        const hasRecording = (_recordedBlob instanceof Blob && _recordedBlob.size > 0);
        _els.aiToggle.disabled = _aiBusy ? false : !hasRecording;
    }
}

function setAiBusy(v) {
    _aiBusy = !!v;

    if (_els.aiToggle) {
        const hasRecording = (_recordedBlob instanceof Blob && _recordedBlob.size > 0);
        _els.aiToggle.disabled = _aiBusy ? false : !hasRecording;
    }
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
        camToggle: resolveEl("#vid-camToggle", { root }),
        recToggle: resolveEl("#vid-recToggle", { root }),
        clear: resolveEl("#vid-clear", { root }),

        cameraSel: resolveEl("#vid-camera", { root, required: false }),
        resSel: resolveEl("#vid-res", { root, required: false }),
        audioChk: resolveEl("#vid-audio", { root, required: false }),
        mimeSel: resolveEl("#vid-mime", { root, required: false }),

        download: resolveEl("#vid-download", { root }),
        stage: resolveEl("#vid-stage", { root }),
        stageTitle: resolveEl("#vid-stageTitle", { root, required: false }),
        stageHint: resolveEl("#vid-stageHint", { root, required: false }),
        viewLive: resolveEl("#vid-viewLive", { root, required: false }),
        viewRec: resolveEl("#vid-viewRec", { root, required: false }),

        rec: resolveEl("#vid-rec", { root }),
        timer: resolveEl("#vid-timer", { root }),
        meta: resolveEl("#vid-meta", { root }),
        status: resolveEl("#vid-status", { root }),

        optionsMenu: resolveEl("#vid-optionsMenu", { root, required: false }),
        optionsBtn: resolveEl("#vid-optionsBtn", { root, required: false }),
        optionsPanel: resolveEl("#vid-optionsPanel", { root, required: false }),

        cameraLabel: resolveEl("#vid-cameraLabel", { root, required: false }),
        resLabel: resolveEl("#vid-resLabel", { root, required: false }),
        mimeLabel: resolveEl("#vid-mimeLabel", { root, required: false }),

        frames: resolveEl("#vid-frames", { root, required: false }),
        strip: resolveEl("#vid-strip", { root, required: false }),
        stripInner: resolveEl("#vid-stripInner", { root, required: false }),
        frameBadge: resolveEl("#vid-frameBadge", { root, required: false }),
        scrub: resolveEl("#vid-scrub", { root, required: false }),

        aiModel: resolveEl("#vid-aiModel", { root, required: false }),
        aiModelLabel: resolveEl("#vid-aiModelLabel", { root, required: false }),

        uploadBtn: resolveEl("#vid-uploadBtn", { root, required: false }),
        uploadInput: resolveEl("#vid-upload", { root, required: false }),

        aiOutput: resolveEl("#vid-ai-output", { root, required: false }),
        aiHud: resolveEl("#vid-ai-hud", { root, required: false }),
        aiToggle: resolveEl("#vid-aiToggle", { root, required: false }),

    };

    // --- Options menu behavior ---
    if (_els.optionsBtn && _els.optionsPanel && _els.optionsMenu) {
        _els.optionsBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggleOptionsMenu();
        }, { signal: _ac.signal });

        // Click outside to close
        document.addEventListener("pointerdown", (ev) => {
            if (!_els.optionsMenu.contains(ev.target)) closeOptionsMenu();
        }, { signal: _ac.signal });

        // ESC closes
        document.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") closeOptionsMenu();
        }, { signal: _ac.signal });

        // Submenu open/close (click)
        _els.optionsPanel.querySelectorAll(".video-submenu").forEach((node) => {
            const btn = node.querySelector(".video-submenu-btn");
            if (!btn) return;

            btn.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();

                // Close others, open this
                _els.optionsPanel.querySelectorAll(".video-submenu").forEach((n) => {
                    if (n === node) return;
                    n.classList.remove("is-open");
                    const b = n.querySelector(".video-submenu-btn");
                    if (b) b.setAttribute("aria-expanded", "false");
                });

                const isOpen = node.classList.toggle("is-open");
                btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
            }, { signal: _ac.signal });
        });
    }

    ensureOpenRouterVideoModels(_els.aiModel, { signal: _ac.signal });

    _ai = createVideoAI({
        root,
        signal: _ac.signal,
        getRecordedBlob: () => _recordedBlob,
        setStatus,
        setOutput: setAiOutput,
        setBusy: setAiBusy,
    });

    _ai?.sync?.();

    _frameViewer = createFrameViewer({
        framesEl: _els.frames,
        stripEl: _els.strip,
        stripInnerEl: _els.stripInner,
        frameBadgeEl: _els.frameBadge,
        scrubEl: _els.scrub,
        stageEl: _els.stage,

        getRecordedUrl: () => _recordedUrl,
        ensureRecordingView: () => {
            if (!_recordedUrl) return false;
            if (_view !== "recording") showRecording();
            return true;
        },

        signal: _ac.signal,
        scrubMax: 1000,
        fpsEst: 30,
    });

    // --- Upload wiring ---
    _els.uploadBtn?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _els.uploadInput?.click();
    }, { signal: _ac.signal });

    _els.uploadInput?.addEventListener("change", async () => {
        const file = _els.uploadInput?.files?.[0] || null;

        // allow re-selecting the same file later
        if (_els.uploadInput) _els.uploadInput.value = "";

        if (!file) return;

        try {
            await loadUploadedFile(file);
        } catch (e) {
            setStatus(`Could not load file: ${e?.message || e}`, { error: true });
        }
    }, { signal: _ac.signal });

    // Initial capability checks
    applyMimeOptions();
    syncOptionLabels();

    if (!("MediaRecorder" in window)) {
        _els.recToggle.disabled = true;
        _els.mimeSel.disabled = true;
        setStatus("Ready. Note: MediaRecorder not supported in this browser (recording disabled).");
    } else {
        _els.mimeSel.disabled = false;
        setStatus("Ready.");
    }

    setDownloadEnabled(false);
    setCameraUI(false);
    setRecordingUI(false);
    syncViewButtons();
    _els.clear.disabled = true;

    if (_recordedUrl) _frameViewer.rebuild().catch(() => { });
    else _frameViewer.clear();

    _els.camToggle.addEventListener("click", async () => {
        if (_stream) await stopAll();
        else await startCamera();
    }, { signal: _ac.signal });

    _els.recToggle.addEventListener("click", async () => {
        if (isRecordingActive()) await stopRecording({ finalize: true });
        else await startRecording();
    }, { signal: _ac.signal });


    let _clearArmed = false;
    let _clearArmTimer = null;
    const _clearDefaultLabel = _els.clear?.textContent || "Clear";

    function disarmClear() {
        _clearArmed = false;
        if (_clearArmTimer) {
            clearTimeout(_clearArmTimer);
            _clearArmTimer = null;
        }
        if (_els.clear) {
            _els.clear.classList.remove("video-clear-warn");
            _els.clear.textContent = _clearDefaultLabel;
            _els.clear.removeAttribute("aria-label");
        }
    }

    _els.clear.addEventListener("click", async (ev) => {
        if (_els.clear.disabled) return;

        // First click: arm confirmation
        if (!_clearArmed) {
            _clearArmed = true;
            _els.clear.classList.add("video-clear-warn");
            _els.clear.textContent = "Clear (again)";
            _els.clear.setAttribute("aria-label", "Click again to confirm clear");

            if (_clearArmTimer) clearTimeout(_clearArmTimer);
            _clearArmTimer = setTimeout(disarmClear, 1500); // auto-cancel after 1.5s
            return;
        }

        // Second click (within timeout): actually clear
        disarmClear();
        await clearRecording();
    }, { signal: _ac.signal });


    // If user changes camera/res/audio while camera is on, we restart camera
    const restartIfOn = async () => {
        syncOptionLabels();
        if (!_stream) return;
        await startCamera();
    };

    _els.cameraSel?.addEventListener("change", restartIfOn, { signal: _ac.signal });
    _els.resSel?.addEventListener("change", restartIfOn, { signal: _ac.signal });
    _els.audioChk?.addEventListener("change", restartIfOn, { signal: _ac.signal });

    _els.mimeSel?.addEventListener("change", () => syncOptionLabels(), { signal: _ac.signal });
    _els.aiModel?.addEventListener("change", () => { syncOptionLabels(); closeOptionsMenu(); }, { signal: _ac.signal });

    // Download link guard (avoid “#” navigation when disabled)
    _els.download.addEventListener("click", (ev) => {
        if (_els.download.classList.contains("disabled")) {
            ev.preventDefault();
            ev.stopPropagation();
        }
    }, { signal: _ac.signal });

    _els.viewLive?.addEventListener("click", () => {
        if (_stream) showLive();
    }, { signal: _ac.signal });

    _els.viewRec?.addEventListener("click", () => {
        if (_recordedUrl) showRecording();
    }, { signal: _ac.signal });


    // Populate camera list (labels may be blank until permission granted)
    try { await refreshCameraList({ keepSelection: true }); } catch { }

    _els.cameraSel?.addEventListener("change", () => { syncOptionLabels(); closeOptionsMenu(); }, { signal: _ac.signal });
    _els.resSel?.addEventListener("change", () => { syncOptionLabels(); closeOptionsMenu(); }, { signal: _ac.signal });
    _els.mimeSel?.addEventListener("change", () => { syncOptionLabels(); closeOptionsMenu(); }, { signal: _ac.signal });

    return async () => {
        try { _ac?.abort(); } catch { }
        _ac = null;

        try { _frameViewer?.destroy?.(); } catch { }
        _frameViewer = null;

        try { await stopAll(); } catch { }
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
    try { _ai?.destroy?.(); } catch { }
    _ai = null;

}

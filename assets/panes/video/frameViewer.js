export function createFrameViewer({
    framesEl,
    stripEl,
    stripInnerEl,
    frameBadgeEl,
    scrubEl,
    stageEl,

    // callbacks owned by video.js
    getRecordedUrl,          // () => string|null
    ensureRecordingView,     // () => boolean (should switch stage to recording if needed)

    // optional knobs
    signal,
    scrubMax = 1000,
    fpsEst = 30,
    maxFrames = 60,
} = {}) {
    // If required DOM nodes are missing, return a no-op API
    const ok = !!(
        framesEl && stripEl && stripInnerEl && frameBadgeEl &&
        scrubEl && stageEl && getRecordedUrl && ensureRecordingView
    );

    if (!ok) {
        return {
            rebuild: async () => { },
            clear: () => { },
            destroy: () => { },
        };
    }

    let _thumbGenToken = 0;
    let _thumbButtons = []; // { btn, time }
    let _userScrub = false;
    let _scrollSync = false;
    let _scrollRaf = null;

    function setVisible(on) {
        framesEl.hidden = !on;
        scrubEl.disabled = !on;
    }

    // Add near the top inside createFrameViewer(...) (before captureThumbAt):

    function waitForCond(el, cond, events, timeoutMs = 5000) {
        if (cond()) return Promise.resolve();

        return new Promise((resolve, reject) => {
            let done = false;

            const cleanup = () => {
                events.forEach((ev) => el.removeEventListener(ev, onEvent));
                el.removeEventListener("error", onError);
            };

            const finish = (ok, err) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cleanup();
                ok ? resolve() : reject(err || new Error("waitForCond failed"));
            };

            const onEvent = () => {
                if (done) return;
                try {
                    if (cond()) finish(true);
                } catch (e) {
                    finish(false, e);
                }
            };

            const onError = () => finish(false, el.error || new Error("video error"));

            const timer = setTimeout(() => finish(false, new Error("timeout")), timeoutMs);

            events.forEach((ev) => el.addEventListener(ev, onEvent));
            el.addEventListener("error", onError, { once: true });

            queueMicrotask(onEvent);
        });
    }


    function wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }


    function clear() {
        _thumbGenToken++;
        _thumbButtons = [];

        stripInnerEl.replaceChildren();
        frameBadgeEl.textContent = "0 / 0";

        scrubEl.value = "0";
        scrubEl.disabled = true;

        framesEl.hidden = true;
    }

    function updateBadge(t, dur) {
        if (!Number.isFinite(dur) || dur <= 0) {
            frameBadgeEl.textContent = "0 / 0";
            return;
        }

        // Cap the “virtual frame rate” so total never exceeds maxFrames
        const effFps = Math.min(fpsEst, maxFrames / dur);

        const total = Math.max(1, Math.round(dur * effFps));
        const idx = Math.min(total, Math.max(1, Math.round(t * effFps) + 1));

        frameBadgeEl.textContent = `${idx} / ${total}`;
    }


    function highlightThumb(t) {
        if (!_thumbButtons.length) return;

        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < _thumbButtons.length; i++) {
            const d = Math.abs(_thumbButtons[i].time - t);
            if (d < bestDist) {
                bestDist = d;
                best = i;
            }
        }
        for (let i = 0; i < _thumbButtons.length; i++) {
            _thumbButtons[i].btn.classList.toggle("is-active", i === best);
        }
    }

    function updateUIFromStage() {
        const recUrl = getRecordedUrl?.();
        if (!recUrl) return;

        // If stage is live (srcObject set), ignore UI updates.
        if (stageEl.srcObject) return;

        const dur = stageEl.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;

        const t = Math.max(0, Math.min(dur, Number(stageEl.currentTime || 0)));
        const p = dur ? (t / dur) : 0;

        updateBadge(t, dur);
        highlightThumb(t);

        if (!(_userScrub)) {
            scrubEl.value = String(Math.round(p * scrubMax));

            const maxScroll = stripEl.scrollWidth - stripEl.clientWidth;
            if (maxScroll > 0) {
                _scrollSync = true;
                stripEl.scrollLeft = p * maxScroll;
                _scrollSync = false;
            }
        }
    }

    function scheduleSeekFromStripScroll() {
        if (_scrollSync) return;

        if (_scrollRaf) cancelAnimationFrame(_scrollRaf);
        _scrollRaf = requestAnimationFrame(() => {
            _scrollRaf = null;

            const recUrl = getRecordedUrl?.();
            if (!recUrl) return;
            if (!ensureRecordingView()) return;

            const dur = stageEl.duration;
            if (!Number.isFinite(dur) || dur <= 0) return;

            const maxScroll = stripEl.scrollWidth - stripEl.clientWidth;
            const p = maxScroll > 0 ? (stripEl.scrollLeft / maxScroll) : 0;

            stageEl.currentTime = Math.max(0, Math.min(dur, p * dur));
            scrubEl.value = String(Math.round(p * scrubMax));
            updateBadge(stageEl.currentTime, dur);
            highlightThumb(stageEl.currentTime);
        });
    }

    async function captureThumbAt(videoEl, t, w = 160, h = 90) {
        // Ensure metadata exists (never hang)
        await waitForCond(
            videoEl,
            () => Number.isFinite(videoEl.duration) && videoEl.duration > 0,
            ["loadedmetadata", "durationchange"],
            8000
        );

        const dur = videoEl.duration;
        const safeT = Math.min(Math.max(t, 0), Math.max(0, dur - 0.01));

        // IMPORTANT (Chromium/Brave):
        // Always force a seek, even if safeT equals currentTime (common at t=0),
        // otherwise no events fire and thumbnail generation can stall.
        let target = safeT;
        const cur = Number(videoEl.currentTime || 0);
        if (Math.abs(cur - target) <= 0.001) {
            target = Math.min(Math.max(0, target + 0.001), Math.max(0, dur - 0.01));
        }

        try {
            videoEl.currentTime = target;

            await waitForCond(
                videoEl,
                () => Math.abs((videoEl.currentTime || 0) - target) < 0.02,
                ["seeked", "timeupdate"],
                8000
            );
        } catch {
            // still continue to frame-ready wait below
        }


        // Wait until a decoded frame is actually available (never hang)
        await waitForCond(
            videoEl,
            () =>
                videoEl.readyState >= 2 &&
                videoEl.videoWidth > 0 &&
                videoEl.videoHeight > 0,
            ["loadeddata", "canplay", "seeked", "timeupdate", "resize"],
            8000
        );

        // If available, wait for an actual presented frame (best signal in Chromium)
        if (typeof videoEl.requestVideoFrameCallback === "function") {
            await Promise.race([
                new Promise((res) => videoEl.requestVideoFrameCallback(() => res())),
                wait(1200),
            ]);
        } else {
            // Give the decoder a tick
            await wait(0);
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return null;

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);

        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (!(vw > 0 && vh > 0)) return null;

        const s = Math.min(w / vw, h / vh);
        const dw = vw * s;
        const dh = vh * s;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;

        ctx.drawImage(videoEl, dx, dy, dw, dh);

        const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.75));
        return blob ? URL.createObjectURL(blob) : null;
    }

    async function rebuild() {
        const recUrl = getRecordedUrl?.();
        if (!recUrl) {
            clear();
            return;
        }

        const token = ++_thumbGenToken;

        setVisible(true);
        stripInnerEl.replaceChildren();
        _thumbButtons = [];

        // ensure we can measure width
        const stripW = stripEl.clientWidth || 600;
        const approxPerThumb = 104;
        const count = Math.max(10, Math.min(28, Math.floor(stripW / approxPerThumb) + 10));

        // placeholders
        const holders = [];
        for (let i = 0; i < count; i++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "video-thumb-btn";
            btn.setAttribute("aria-label", `Thumbnail ${i + 1}`);

            const ph = document.createElement("div");
            ph.className = "video-thumb-placeholder";
            btn.appendChild(ph);

            stripInnerEl.appendChild(btn);
            holders.push(btn);
        }

        // offscreen video for captures
        const hv = document.createElement("video");
        hv.muted = true;
        hv.playsInline = true;
        hv.preload = "auto";
        hv.src = recUrl;

        // Helps Chromium/Brave reliably decode frames for canvas draws
        hv.style.position = "fixed";
        hv.style.left = "-9999px";
        hv.style.top = "-9999px";
        hv.style.width = "1px";
        hv.style.height = "1px";
        hv.setAttribute("aria-hidden", "true");
        hv.setAttribute("tabindex", "-1");
        document.body.appendChild(hv);

        // If the hidden video errors at any point, cancel the rebuild cleanly.
        let hvError = null;
        const onHvError = () => { hvError = hv.error || new Error("thumb video load failed"); };
        hv.addEventListener("error", onHvError, { once: true });

        try {
            hv.load();

            // Wait until we have real duration (never hang: waitForCond has timeout)
            await waitForCond(
                hv,
                () => Number.isFinite(hv.duration) && hv.duration > 0,
                ["loadedmetadata", "durationchange"],
                8000
            );

            if (hvError) return;
            if (token !== _thumbGenToken) return;

            // Optional: tiny play/pause tick can improve decode on some configs
            try { await hv.play(); } catch { }
            try { hv.pause(); } catch { }

            if (hvError) return;
            if (token !== _thumbGenToken) return;

            const dur = hv.duration;
            if (!Number.isFinite(dur) || dur <= 0) return;

            for (let i = 0; i < count; i++) {
                if (token !== _thumbGenToken) return;
                if (hvError) return;

                const t = (count === 1) ? 0 : (i / (count - 1)) * dur;

                let url = null;
                try {
                    url = await captureThumbAt(hv, t);
                } catch (e) {
                    console.warn("thumb capture failed", { i, t, e });
                    url = null;
                }

                if (token !== _thumbGenToken) return;
                if (hvError) return;

                const btn = holders[i];
                if (!url) continue;

                btn.replaceChildren();

                const img = document.createElement("img");
                img.className = "video-thumb";
                img.alt = `Thumb ${i + 1}`;
                img.src = url;

                // Revoke the blob URL once the image has resolved either way.
                const revoke = () => { try { URL.revokeObjectURL(url); } catch { } };
                img.addEventListener("load", revoke, { once: true });
                img.addEventListener("error", revoke, { once: true });

                btn.appendChild(img);

                btn.addEventListener(
                    "click",
                    () => {
                        const recUrl2 = getRecordedUrl?.();
                        if (!recUrl2) return;
                        if (!ensureRecordingView()) return;

                        const dur2 = stageEl.duration;
                        if (Number.isFinite(dur2) && dur2 > 0) {
                            stageEl.currentTime = Math.max(0, Math.min(dur2, t));
                        }
                        updateUIFromStage();
                    },
                    { signal }
                );

                _thumbButtons.push({ btn, time: t });
            }

            scrubEl.disabled = false;

            // Let metadata settle, then sync UI once.
            queueMicrotask(() => updateUIFromStage());
        } finally {
            try { hv.removeEventListener("error", onHvError); } catch { }
            try { hv.remove(); } catch { }
        }
    }

    // --- Wiring (one-time) ----------------------------------------------------

    // make strip focusable for keyboard navigation
    if (!stripEl.hasAttribute("tabindex")) stripEl.tabIndex = 0;

    scrubEl.max = String(scrubMax);
    scrubEl.value = "0";
    scrubEl.disabled = true;

    const endScrub = () => { _userScrub = false; };

    scrubEl.addEventListener("pointerdown", () => { _userScrub = true; }, { signal });
    scrubEl.addEventListener("pointerup", endScrub, { signal });
    scrubEl.addEventListener("change", endScrub, { signal });

    scrubEl.addEventListener("input", () => {
        const recUrl = getRecordedUrl?.();
        if (!recUrl) return;
        if (!ensureRecordingView()) return;

        const dur = stageEl.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;

        const p = Number(scrubEl.value) / scrubMax;
        stageEl.currentTime = Math.max(0, Math.min(dur, p * dur));
        updateUIFromStage();
    }, { signal });

    stripEl.addEventListener("pointerdown", () => { _userScrub = true; }, { signal });
    stripEl.addEventListener("pointerup", endScrub, { signal });
    stripEl.addEventListener("pointerleave", endScrub, { signal });

    stripEl.addEventListener("scroll", () => {
        if (_userScrub) scheduleSeekFromStripScroll();
    }, { passive: true, signal });

    stripEl.addEventListener("click", (ev) => {
        if (ev.target?.closest?.(".video-thumb-btn")) return;

        const recUrl = getRecordedUrl?.();
        if (!recUrl) return;
        if (!ensureRecordingView()) return;

        const dur = stageEl.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;

        const rect = stripEl.getBoundingClientRect();
        const x = ev.clientX - rect.left;

        const totalW = stripEl.scrollWidth;
        const p = totalW > 0 ? ((stripEl.scrollLeft + x) / totalW) : 0;

        stageEl.currentTime = Math.max(0, Math.min(dur, p * dur));
        updateUIFromStage();
    }, { signal });

    stripEl.addEventListener("keydown", (ev) => {
        const recUrl = getRecordedUrl?.();
        if (!recUrl) return;

        const dur = stageEl.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;

        const step = ev.shiftKey ? 1.0 : 0.25;

        if (ev.key === "ArrowLeft") {
            if (!ensureRecordingView()) return;
            stageEl.currentTime = Math.max(0, (stageEl.currentTime || 0) - step);
            updateUIFromStage();
            ev.preventDefault();
        } else if (ev.key === "ArrowRight") {
            if (!ensureRecordingView()) return;
            stageEl.currentTime = Math.min(dur, (stageEl.currentTime || 0) + step);
            updateUIFromStage();
            ev.preventDefault();
        } else if (ev.key === "Home") {
            if (!ensureRecordingView()) return;
            stageEl.currentTime = 0;
            updateUIFromStage();
            ev.preventDefault();
        } else if (ev.key === "End") {
            if (!ensureRecordingView()) return;
            stageEl.currentTime = dur;
            updateUIFromStage();
            ev.preventDefault();
        }
    }, { signal });

    stageEl.addEventListener("timeupdate", updateUIFromStage, { signal });
    stageEl.addEventListener("loadedmetadata", updateUIFromStage, { signal });
    stageEl.addEventListener("durationchange", updateUIFromStage, { signal });

    return {
        rebuild,
        clear,
        destroy() {
            _thumbGenToken++;
            if (_scrollRaf) {
                cancelAnimationFrame(_scrollRaf);
                _scrollRaf = null;
            }
            _thumbButtons = [];
        },
    };
}

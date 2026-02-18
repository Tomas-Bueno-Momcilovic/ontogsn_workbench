# Video Pane

Webcam + recording pane with a minimal HUD, frame-strip viewer, and an optional “Describe” action that sends sampled video frames to an OpenRouter multimodal model for a plain-text summary.

![alt text](image.png)

## Features
- Live camera preview (secure context / localhost) + recording via MediaRecorder
- Single video stage with HUD overlay (REC timer, download button, metadata)
- Options dropdown with submenus (camera, resolution, format, AI model)
- Recording playback view switch (Live ◀ / Recording ▶)
- Frame viewer for recordings (thumbnail strip + scrub bar + keyboard navigation)
- AI description pipeline: samples frames from the recorded blob → calls OpenRouter chat.completions → prints text into HUD + console

## Data & config
- OpenRouter key file: `api.txt` (required for AI)  
  Location: `./assets/panes/video/api.txt` (plain text API key)
- AI frame sampling defaults (no UI): `DEFAULT_MAX_FRAMES`, `DEFAULT_FRAME_MAX_W`, `DEFAULT_JPEG_QUALITY` in `ai.js`
- Recording format options are auto-detected via `MediaRecorder.isTypeSupported()` (see `detectSupportedMimes()`)

## Exports
- Pane lifecycle: `mount`, `resume`, `suspend`, `unmount`
- Helpers:
  - `createFrameViewer({ ... })` from `frameViewer.js`
  - `createVideoAI({ root, signal, getRecordedBlob, setStatus })` from `ai.js`

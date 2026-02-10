# Image Pane

Local-first image capture/viewer pane with optional AI description via OpenRouter. Supports upload, drag/drop, and webcam capture, with a minimal HUD (download + metadata) and a textarea for the generated description.

## Features
- Upload image file or drag/drop into the stage
- Webcam start/stop + single-frame capture (“Capture” / “Retake”)
- HUD overlay: download button (top-right) + metadata (bottom-left)
- AI “Describe image” button → sends image + prompt to OpenRouter and renders text output
- Copy-to-clipboard for the AI description

## AI (OpenRouter)
- Entry point: `ai.js` (`wireImageDescribeAI(...)`)
- Reads API key from `./api.txt` (same folder as `ai.js`)
  - First non-empty, non-# line is used
  - If missing/empty, the UI reports an error via status
- Default model: `anthropic/claude-opus-4.6`
- Default prompt: concise image description + text transcription (for UI/screenshots too)

## Files
- UI: `image.html`
- Styles: `image.css`
- Pane logic + lifecycle: `image.js`
- OpenRouter wiring: `ai.js`
- API key (local, ignored by git): `api.txt`

## Events
- Emits (via pane bus + `window`):
  - `image:changed` (new image loaded/captured)
  - `image:cleared`
  - `image:described` (AI output ready)
  - `image:describe:error`

## Exports
- Pane lifecycle: `mount`, `resume`, `suspend`, `unmount`

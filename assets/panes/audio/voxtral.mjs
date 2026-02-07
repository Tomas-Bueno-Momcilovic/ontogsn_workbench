import express from "express";
import multer from "multer";
import { Mistral } from "@mistralai/mistralai";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

app.post("/api/voxtral/transcribe-stream", upload.single("file"), async (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // helps if you ever put a proxy in front
  res.flushHeaders?.();

  const model = req.body?.model || "voxtral-mini-latest";
  const language = (req.body?.language || "").trim() || undefined;

  if (!req.file?.buffer?.length) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Missing file" })}\n\n`);
    res.end();
    return;
  }

  let closed = false;
  req.on("close", () => { closed = true; });

  try {
    const stream = await mistral.audio.transcriptions.stream({
      model,
      // The TS SDK supports a file wrapper object
      file: {
        content: req.file.buffer,
        fileName: req.file.originalname || "audio.wav",
      },
      ...(language ? { language } : {}),
    });

    for await (const event of stream) {
      if (closed) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (!closed) res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (e) {
    if (!closed) {
      res.write(`data: ${JSON.stringify({ type: "error", message: e?.message || String(e) })}\n\n`);
      res.end();
    }
  }
});

app.listen(8787, () => {
  console.log("Voxtral proxy listening on http://localhost:8787");
});

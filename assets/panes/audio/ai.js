import { OPENROUTER_CHAT_ENDPOINT, buildOpenRouterHeaders } from "@core/openrouter.js";

const API_TXT_URL = new URL("./api.txt", import.meta.url);
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Value prefix used inside your <select>
const OR_PREFIX = "openrouter:";

// Fallback list if /models fetch fails
const FALLBACK_AUDIO_MODELS = [
  { id: "openai/gpt-audio" },
  { id: "openai/gpt-audio-mini" },
];

let _keyPromise = null;

export function isOpenRouterAudioModel(value) {
  return typeof value === "string" && value.startsWith(OR_PREFIX);
}

export function openRouterModelId(value) {
  return (value || "").replace(/^openrouter:/, "");
}

async function loadApiKeyFromFile() {
  // Cache promise so we don’t refetch on every call
  if (_keyPromise) return _keyPromise;

  _keyPromise = (async () => {
    const res = await fetch(API_TXT_URL, { cache: "no-store" });
    if (!res.ok) return "";
    const txt = (await res.text()) || "";
    return txt.trim();
  })();

  return _keyPromise;
}

async function openRouterChatRaw({ apiKey, body, signal }) {
  const res = await fetch(OPENROUTER_CHAT_ENDPOINT, {
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey, {
      title: "OntoGSN Workbench",
      referer: location.origin,
    }),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t}`);
  }
  return res.json();
}

function guessAudioFormatFromBlob(blob) {
  const t = (blob?.type || "").toLowerCase();
  if (t.includes("wav")) return "wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("aac")) return "aac";
  if (t.includes("flac")) return "flac";
  if (t.includes("aiff")) return "aiff";
  if (t.includes("m4a") || t.includes("mp4")) return "m4a";
  return "wav";
}

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function blobToBase64(blob) {
  const ab = await blob.arrayBuffer();
  return arrayBufferToBase64(ab);
}

function buildMessages({ promptText, base64Audio, format }) {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: promptText || "Please transcribe this audio file." },
        {
          type: "input_audio",
          input_audio: { data: base64Audio, format },
        },
      ],
    },
  ];
}


async function fetchOpenRouterModels(apiKey) {
  const headers = apiKey
    ? buildOpenRouterHeaders(apiKey, { title: "OntoGSN Workbench", referer: location.origin })
    : { "Content-Type": "application/json" };

  const res = await fetch(OPENROUTER_MODELS_URL, { headers });
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  const json = await res.json();
  return json?.data || [];
}

function filterAudioInputModels(models) {
  return (models || []).filter((m) => {
    const ins = m?.architecture?.input_modalities || m?.architecture?.inputModalities || [];
    return Array.isArray(ins) && ins.includes("audio");
  });
}

function ensureOptgroup(selectEl, label) {
  if (!selectEl) return null;

  let og = Array.from(selectEl.querySelectorAll("optgroup"))
    .find((g) => (g.getAttribute("label") || "") === label);

  if (!og) {
    og = document.createElement("optgroup");
    og.setAttribute("label", label);

    // Insert after "Cloud (Mistral)" group if present, else append.
    const mistral = Array.from(selectEl.querySelectorAll("optgroup"))
      .find((g) => (g.getAttribute("label") || "") === "Cloud (Mistral)");

    if (mistral?.parentNode) mistral.parentNode.insertBefore(og, mistral.nextSibling);
    else selectEl.appendChild(og);
  }

  return og;
}

function replaceOptions(optgroupEl, models) {
  if (!optgroupEl) return;
  optgroupEl.innerHTML = "";

  for (const m of models) {
    const id = m?.id;
    if (!id) continue;

    const name = m?.name || id;

    const opt = document.createElement("option");
    opt.value = `${OR_PREFIX}${id}`;

    // Display only provider/model
    opt.textContent = id;

    // Optional: keep a hover tooltip with the human-friendly name
    if (name && name !== id) opt.title = name;

    optgroupEl.appendChild(opt);
  }
}


export async function ensureOpenRouterAudioModels(selectEl) {
  const og = ensureOptgroup(selectEl, "Cloud (OpenRouter)");
  if (!og) return;

  // Start with fallback so user sees something immediately
  replaceOptions(og, FALLBACK_AUDIO_MODELS);

  try {
    const apiKey = await loadApiKeyFromFile();
    // If no key, we still try — but docs show auth; fallback is fine if it fails.
    const all = await fetchOpenRouterModels(apiKey);
    const audio = filterAudioInputModels(all);

    // If we found any audio-input models, replace the fallback list.
    if (audio.length) replaceOptions(og, audio);
  } catch {
    // Leave fallback list in place silently.
  }
}

export async function openRouterAudioTranscribeBlob({
  blob,
  modelId,
  prompt = "Please transcribe this audio file.",
  temperature = 0.2,
  maxTokens = 2000,
  signal,
}) {
  if (!blob) throw new Error("Missing audio blob.");

  const apiKey = await loadApiKeyFromFile();
  if (!apiKey) throw new Error("Missing OpenRouter API key (audio/api.txt).");

  const format = guessAudioFormatFromBlob(blob);
  const base64Audio = await blobToBase64(blob);

  const messages = buildMessages({ promptText: prompt, base64Audio, format });

  // Attempt #1: audio input only (text output)
  const body1 = {
    model: modelId,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  try {
    const data = await openRouterChatRaw({ apiKey, body: body1, signal });
    const msg = data?.choices?.[0]?.message || {};
    return (msg.content || "").trim();
  } catch (e) {
    const msg = String(e?.message || e);

    // If provider says “no audio present”, retry with explicit audio output modality
    // (OpenAI gpt-audio examples include modalities + audio config) :contentReference[oaicite:2]{index=2}
    if (!/requires that either input content or output modality contain audio/i.test(msg)) {
      throw e;
    }

    const body2 = {
      ...body1,
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
    };

    const data2 = await openRouterChatRaw({ apiKey, body: body2, signal });
    const msg2 = data2?.choices?.[0]?.message || {};
    return (msg2.content || "").trim();
  }
}

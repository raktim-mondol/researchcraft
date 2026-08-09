/**
 * HTTP clients for OpenAI Images API and Gemini Nano Banana image generation.
 * Raw fetch only — no heavy SDKs (mirrors runpod-client.ts).
 */
import type { ImageProvider } from "./image-gen-config.ts";

export interface ReferenceImage {
  mimeType: string;
  dataBase64: string;
}

export interface GenerateImageRequest {
  provider: ImageProvider;
  model: string;
  prompt: string;
  /** OpenAI-compatible base ending in /v1 (or without — we normalize). */
  baseUrl: string;
  apiKey: string;
  size?: string;
  quality?: string;
  aspectRatio?: string;
  /** Gemini image_size: 0.5K | 1K | 2K | 4K */
  imageSize?: string;
  n?: number;
  references?: ReferenceImage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  revisedPrompt?: string;
}

export interface GenerateImageResult {
  images: GeneratedImage[];
  provider: ImageProvider;
  model: string;
  rawNote?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort();
  signal?.addEventListener("abort", onParent, { once: true });
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onParent);
    },
  };
}

function openaiImagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  if (b.endsWith("/images/generations")) return b;
  if (b.endsWith("/v1")) return `${b}/images/generations`;
  return `${b}/v1/images/generations`;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}

function errorMessage(data: unknown, status: number, fallback: string): string {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (o.error && typeof o.error === "object") {
      const e = o.error as Record<string, unknown>;
      if (typeof e.message === "string") return e.message;
    }
    if (typeof o.message === "string") return o.message;
  }
  return `${fallback} (HTTP ${status})`;
}

async function generateOpenAI(req: GenerateImageRequest): Promise<GenerateImageResult> {
  if (!req.baseUrl) {
    throw new Error(
      "OpenAI image generation needs a base URL (IMAGE_BASE_URL or LLM_BASE_URL).",
    );
  }
  if (req.references?.length) {
    throw new Error(
      "reference_paths are not supported on the OpenAI path in this version. " +
        "Use a Gemini image model (e.g. gemini-2.5-flash-image) for multi-image compose/edit.",
    );
  }

  const url = openaiImagesUrl(req.baseUrl);
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
  };
  if (req.size) body.size = req.size;
  if (req.quality) body.quality = req.quality;
  if (req.n && req.n > 1) body.n = Math.min(8, Math.floor(req.n));
  // Prefer b64 when the API accepts it (DALL·E); GPT image models often return b64 by default.
  body.response_format = "b64_json";

  const { signal, cleanup } = withTimeout(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const { ok, status, data } = await fetchJson(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.apiKey || "no-key"}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!ok) {
      throw new Error(errorMessage(data, status, "OpenAI image generation failed"));
    }
    const list =
      data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
        ? ((data as { data: Array<Record<string, unknown>> }).data)
        : [];
    if (!list.length) {
      throw new Error("OpenAI image API returned no images");
    }
    const images: GeneratedImage[] = [];
    for (const item of list) {
      if (typeof item.b64_json === "string" && item.b64_json) {
        images.push({
          buffer: Buffer.from(item.b64_json, "base64"),
          mimeType: "image/png",
          revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        });
        continue;
      }
      if (typeof item.url === "string" && item.url) {
        const imgRes = await fetch(item.url, { signal });
        if (!imgRes.ok) {
          throw new Error(`Failed to download generated image URL (HTTP ${imgRes.status})`);
        }
        const ab = await imgRes.arrayBuffer();
        const ct = imgRes.headers.get("content-type") || "image/png";
        images.push({
          buffer: Buffer.from(ab),
          mimeType: ct.split(";")[0].trim() || "image/png",
          revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
        });
        continue;
      }
    }
    if (!images.length) {
      throw new Error("OpenAI image API response had neither b64_json nor url");
    }
    return { images, provider: "openai", model: req.model };
  } finally {
    cleanup();
  }
}

/** Walk Gemini Interactions / generateContent-ish JSON for image bytes. */
export function extractGeminiImages(data: unknown): GeneratedImage[] {
  const out: GeneratedImage[] = [];
  const seen = new Set<string>();

  const push = (b64: string, mime: string) => {
    const key = b64.slice(0, 64) + b64.length;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      buffer: Buffer.from(b64, "base64"),
      mimeType: mime || "image/png",
    });
  };

  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    // Interactions convenience: output_image: { data, mime_type }
    if (o.output_image && typeof o.output_image === "object") {
      const img = o.output_image as Record<string, unknown>;
      if (typeof img.data === "string" && img.data) {
        push(
          img.data,
          typeof img.mime_type === "string"
            ? img.mime_type
            : typeof img.mimeType === "string"
              ? img.mimeType
              : "image/png",
        );
      }
    }

    // Content block: { type: "image", data, mime_type }
    if (
      (o.type === "image" || o.type === "inline_data" || o.type === "inlineData") &&
      typeof o.data === "string" &&
      o.data
    ) {
      push(
        o.data,
        typeof o.mime_type === "string"
          ? o.mime_type
          : typeof o.mimeType === "string"
            ? o.mimeType
            : "image/png",
      );
    }

    // generateContent: inlineData / inline_data
    const inline = (o.inlineData ?? o.inline_data) as Record<string, unknown> | undefined;
    if (inline && typeof inline.data === "string" && inline.data) {
      push(
        inline.data,
        typeof inline.mimeType === "string"
          ? inline.mimeType
          : typeof inline.mime_type === "string"
            ? inline.mime_type
            : "image/png",
      );
    }

    for (const v of Object.values(o)) visit(v, depth + 1);
  };

  visit(data);
  return out;
}

async function generateGeminiInteractions(
  req: GenerateImageRequest,
  signal: AbortSignal,
): Promise<GenerateImageResult | null> {
  const input: Array<Record<string, unknown>> = [
    { type: "text", text: req.prompt },
  ];
  for (const ref of req.references ?? []) {
    input.push({
      type: "image",
      mime_type: ref.mimeType,
      data: ref.dataBase64,
    });
  }

  const body: Record<string, unknown> = {
    model: req.model,
    input,
  };
  const responseFormat: Record<string, unknown> = {
    type: "image",
    mime_type: "image/png",
  };
  if (req.aspectRatio) responseFormat.aspect_ratio = req.aspectRatio;
  if (req.imageSize) responseFormat.image_size = req.imageSize;
  else if (req.size && /^(\d+\.?\d*)?[kK]$/.test(req.size)) {
    responseFormat.image_size = req.size.toUpperCase().replace("K", "K");
  }
  body.response_format = responseFormat;

  const url = `${req.baseUrl.replace(/\/+$/, "")}/v1beta/interactions`;
  const { ok, status, data } = await fetchJson(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": req.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (status === 404 || status === 405) return null;
  if (!ok) {
    // Fall through to generateContent on some error shapes
    if (status === 400 || status === 404) return null;
    throw new Error(errorMessage(data, status, "Gemini image generation failed"));
  }

  const images = extractGeminiImages(data);
  if (!images.length) return null;
  return { images, provider: "gemini", model: req.model, rawNote: "interactions" };
}

async function generateGeminiContent(
  req: GenerateImageRequest,
  signal: AbortSignal,
): Promise<GenerateImageResult> {
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
  for (const ref of req.references ?? []) {
    parts.push({
      inline_data: {
        mime_type: ref.mimeType,
        data: ref.dataBase64,
      },
    });
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const modelPath = encodeURIComponent(req.model);
  const url = `${req.baseUrl.replace(/\/+$/, "")}/v1beta/models/${modelPath}:generateContent`;
  const { ok, status, data } = await fetchJson(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": req.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!ok) {
    throw new Error(errorMessage(data, status, "Gemini generateContent image failed"));
  }
  const images = extractGeminiImages(data);
  if (!images.length) {
    throw new Error(
      "Gemini returned no image parts. Confirm IMAGE_MODEL is an image model " +
        "(e.g. gemini-2.5-flash-image, gemini-3.1-flash-image).",
    );
  }
  return { images, provider: "gemini", model: req.model, rawNote: "generateContent" };
}

async function generateGemini(req: GenerateImageRequest): Promise<GenerateImageResult> {
  if (!req.apiKey) {
    throw new Error(
      "Gemini image generation needs GEMINI_API_KEY (or IMAGE_API_KEY). " +
        "Set it in Settings → API keys.",
    );
  }
  const { signal, cleanup } = withTimeout(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    try {
      const viaInteractions = await generateGeminiInteractions(req, signal);
      if (viaInteractions) return viaInteractions;
    } catch (err) {
      // Fall back unless aborted
      if (req.signal?.aborted || signal.aborted) throw err;
    }
    return await generateGeminiContent(req, signal);
  } finally {
    cleanup();
  }
}

/** Generate one or more images via the configured provider. */
export async function generateImages(req: GenerateImageRequest): Promise<GenerateImageResult> {
  if (!req.model?.trim()) {
    throw new Error("Image model is required (IMAGE_MODEL or tool model param).");
  }
  if (!req.prompt?.trim()) {
    throw new Error("prompt is required");
  }
  if (req.provider === "gemini") return generateGemini(req);
  return generateOpenAI(req);
}

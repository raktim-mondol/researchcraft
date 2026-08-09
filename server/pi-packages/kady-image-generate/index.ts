/**
 * kady-image-generate — Pi package that gives CHILD pi processes the
 * `image_generate` tool. The parent session already has an in-process tool
 * with the same name, so this package self-gates on PI_SUBAGENT_CHILD.
 *
 * Implementation is self-contained (no import from server/src) so the child
 * `pi` process can load it standalone. Schema/name must stay aligned with
 * server/src/agent/image-generate-tool.ts (see package parity test).
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const ImageGenerateParams = Type.Object({
  prompt: Type.String({
    description:
      "Full image generation (or edit) instruction. Be specific about layout, labels, style, and scientific accuracy constraints.",
  }),
  path: Type.String({
    description:
      'Sandbox-relative output path for the image, e.g. "figures/schematic.png". Parent dirs are created.',
  }),
  provider: Type.Optional(
    Type.String({
      description: 'Force "openai" or "gemini". Omit to use Settings / model-id inference.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override IMAGE_MODEL for this call (e.g. gpt-image-2, gemini-2.5-flash-image, gemini-3.1-flash-image).",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        'OpenAI size string (e.g. "1024x1024") or Gemini image_size ("1K","2K","4K").',
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.String({
      description: 'Gemini aspect ratio, e.g. "1:1", "16:9", "4:3".',
    }),
  ),
  quality: Type.Optional(
    Type.String({
      description: 'OpenAI quality: "low" | "medium" | "high" | "auto".',
    }),
  ),
  reference_paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative reference images for compose/edit (Gemini primary).",
    }),
  ),
  n: Type.Optional(
    Type.Number({
      description: "Number of candidates (OpenAI; max 8).",
    }),
  ),
});

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function isWithin(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function safeUnder(sandboxRoot: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, "");
  const target = path.resolve(sandboxRoot, cleaned);
  if (!isWithin(sandboxRoot, target)) {
    throw new Error(`Path escapes the project sandbox: ${rel}`);
  }
  return target;
}

function inferProvider(model: string, explicit?: string): "openai" | "gemini" {
  const p = (explicit || process.env.IMAGE_PROVIDER || "").trim().toLowerCase();
  if (p === "openai" || p === "gemini") return p;
  const m = model.toLowerCase();
  if (m.startsWith("gemini-") || m.includes("flash-image") || m.includes("pro-image")) {
    return "gemini";
  }
  return "openai";
}

function extractImages(data: unknown): Array<{ buffer: Buffer; mimeType: string }> {
  const out: Array<{ buffer: Buffer; mimeType: string }> = [];
  const seen = new Set<string>();
  const push = (b64: string, mime: string) => {
    const key = b64.slice(0, 64) + b64.length;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ buffer: Buffer.from(b64, "base64"), mimeType: mime || "image/png" });
  };
  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.output_image && typeof o.output_image === "object") {
      const img = o.output_image as Record<string, unknown>;
      if (typeof img.data === "string") {
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
    if (
      (o.type === "image" || o.type === "inline_data" || o.type === "inlineData") &&
      typeof o.data === "string"
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
    const inline = (o.inlineData ?? o.inline_data) as Record<string, unknown> | undefined;
    if (inline && typeof inline.data === "string") {
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

async function callOpenAI(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  signal?: AbortSignal;
}): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  let base = opts.baseUrl.replace(/\/+$/, "");
  if (!base.endsWith("/v1") && !base.endsWith("/images/generations")) {
    base = `${base}/v1`;
  }
  const url = base.endsWith("/images/generations")
    ? base
    : `${base}/images/generations`;
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    response_format: "b64_json",
  };
  if (opts.size) body.size = opts.size;
  if (opts.quality) body.quality = opts.quality;
  if (opts.n && opts.n > 1) body.n = Math.min(8, Math.floor(opts.n));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey || "no-key"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && (data as { error?: { message?: string } }).error?.message
        ? (data as { error: { message: string } }).error.message
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const list =
    data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: Array<{ b64_json?: string; url?: string }> }).data
      : [];
  const images: Array<{ buffer: Buffer; mimeType: string }> = [];
  for (const item of list) {
    if (item.b64_json) {
      images.push({ buffer: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" });
    } else if (item.url) {
      const r = await fetch(item.url, { signal: opts.signal });
      if (!r.ok) throw new Error(`download failed HTTP ${r.status}`);
      images.push({
        buffer: Buffer.from(await r.arrayBuffer()),
        mimeType: (r.headers.get("content-type") || "image/png").split(";")[0],
      });
    }
  }
  if (!images.length) throw new Error("OpenAI image API returned no images");
  return images;
}

async function callGemini(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  references?: Array<{ mimeType: string; dataBase64: string }>;
  signal?: AbortSignal;
}): Promise<Array<{ buffer: Buffer; mimeType: string }>> {
  const host = "https://generativelanguage.googleapis.com";
  const input: Array<Record<string, unknown>> = [{ type: "text", text: opts.prompt }];
  for (const ref of opts.references ?? []) {
    input.push({ type: "image", mime_type: ref.mimeType, data: ref.dataBase64 });
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    response_format: {
      type: "image",
      mime_type: "image/png",
      ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
      ...(opts.imageSize ? { image_size: opts.imageSize } : {}),
    },
  };
  let res = await fetch(`${host}/v1beta/interactions`, {
    method: "POST",
    headers: {
      "x-goog-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  let text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (res.ok) {
    const imgs = extractImages(data);
    if (imgs.length) return imgs;
  }
  // Fallback generateContent
  const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }];
  for (const ref of opts.references ?? []) {
    parts.push({
      inline_data: { mime_type: ref.mimeType, data: ref.dataBase64 },
    });
  }
  res = await fetch(
    `${host}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: opts.signal,
    },
  );
  text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      data && typeof data === "object" && typeof (data as { error?: { message?: string } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : `Gemini HTTP ${res.status}`,
    );
  }
  const imgs = extractImages(data);
  if (!imgs.length) throw new Error("Gemini returned no image parts");
  return imgs;
}

export const imageGenerateChildTool: ToolDefinition<typeof ImageGenerateParams> = {
  name: "image_generate",
  label: "Image generate",
  description: [
    "Generate an image from a text prompt (and optional reference images) and save it into the project sandbox.",
    "Providers: OpenAI Images (gpt-image-2, …) or Google Gemini Nano Banana (gemini-*-image).",
    "Use for conceptual diagrams — not quantitative data plots (use Python for those).",
    "Write to figures/… Always set path.",
  ].join(" "),
  promptSnippet:
    "image_generate: text-to-image (OpenAI or Gemini) → sandbox PNG",
  parameters: ImageGenerateParams,
  execute: async (_id, params, signal) => {
    const model =
      (params.model && String(params.model).trim()) ||
      (process.env.IMAGE_MODEL || "").trim();
    if (!model) {
      return textResult(
        "IMAGE_MODEL is not set. Configure image generation in Settings → API keys.",
        { error: "not_configured" },
      );
    }
    const provider = inferProvider(model, params.provider);
    const sandboxRoot = process.cwd();
    let outRel = String(params.path || "").trim().replace(/^\/+/, "");
    if (!outRel) {
      return textResult("path is required", { error: "bad_path" });
    }
    if (!path.extname(outRel)) outRel = `${outRel}.png`;

    const refs: Array<{ mimeType: string; dataBase64: string }> = [];
    for (const rel of params.reference_paths ?? []) {
      const abs = safeUnder(sandboxRoot, rel);
      const buf = fs.readFileSync(abs);
      if (buf.length > 7 * 1024 * 1024) {
        return textResult(`Reference too large: ${rel}`, { error: "bad_reference" });
      }
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png";
      refs.push({ mimeType: mime, dataBase64: buf.toString("base64") });
    }

    try {
      let images: Array<{ buffer: Buffer; mimeType: string }>;
      if (provider === "gemini") {
        const apiKey = (process.env.IMAGE_API_KEY || process.env.GEMINI_API_KEY || "").trim();
        if (!apiKey) {
          return textResult("GEMINI_API_KEY (or IMAGE_API_KEY) required for Gemini images.", {
            error: "not_configured",
          });
        }
        images = await callGemini({
          apiKey,
          model,
          prompt: params.prompt,
          aspectRatio: params.aspect_ratio,
          imageSize: params.size && /^[\d.]*[kK]$/.test(params.size) ? params.size : undefined,
          references: refs,
          signal,
        });
      } else {
        if (refs.length) {
          return textResult(
            "reference_paths require a Gemini image model in this version.",
            { error: "unsupported" },
          );
        }
        // Dedicated image endpoint only — never reuse chat LLM_* (may be Qwen/etc.).
        const baseUrl = (process.env.IMAGE_BASE_URL || "").trim().replace(/\/+$/, "");
        const apiKey = (process.env.IMAGE_API_KEY || "").trim();
        if (!baseUrl || !apiKey) {
          return textResult(
            "OpenAI images need IMAGE_BASE_URL and IMAGE_API_KEY " +
              "(separate from the chat LLM settings).",
            { error: "not_configured" },
          );
        }
        images = await callOpenAI({
          baseUrl,
          apiKey,
          model,
          prompt: params.prompt,
          size: params.size,
          quality: params.quality,
          n: params.n,
          signal,
        });
      }

      const written: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const rel =
          i === 0
            ? outRel
            : (() => {
                const dir = path.dirname(outRel);
                const ext = path.extname(outRel);
                const base = path.basename(outRel, ext);
                return path.join(dir, `${base}_${i + 1}${ext || ".png"}`).replace(/\\/g, "/");
              })();
        const abs = safeUnder(sandboxRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, images[i].buffer);
        written.push(rel.replace(/\\/g, "/"));
      }
      return textResult(
        `Saved ${written.length} image(s):\n` +
          written.map((p) => `- ${p}`).join("\n") +
          `\nprovider=${provider} model=${model}`,
        { path: written[0], paths: written, provider, model },
      );
    } catch (err) {
      return textResult(`Image generation failed: ${(err as Error).message}`, {
        error: "api_error",
      });
    }
  },
};

export default function (pi: ExtensionAPI): void {
  // Only register in subagent child processes — lead already has the tool.
  if (!process.env.PI_SUBAGENT_CHILD) return;
  pi.registerTool(imageGenerateChildTool);
}

/**
 * Native `image_generate` tool: text-to-image (OpenAI Images / Gemini Nano Banana)
 * writing PNG/JPEG into the project sandbox.
 *
 * Lead-agent in-process tool (registered when imageGenConfigured()). Subagents
 * get the same tool name via the vendored kady-image-generate Pi package.
 */
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import { isBudgetExceeded, recordComputeRun } from "../cost/ledger.ts";
import {
  estimateImageGenCostUsd,
  getImageGenConfig,
  imageGenConfigured,
  parseImageProvider,
  type ImageProvider,
} from "./image-gen-config.ts";
import { generateImages, type ReferenceImage } from "./image-gen-client.ts";

const MAX_REF_BYTES = 7 * 1024 * 1024;
/** Gemini 3.x allows up to 14 reference images depending on model tier. */
const MAX_REFS = 14;

export const ImageGenerateParams = Type.Object({
  prompt: Type.String({
    description:
      "Full image generation (or edit) instruction. Be specific about layout, labels, style, and scientific accuracy constraints.",
  }),
  path: Type.String({
    description:
      "Sandbox-relative output path for the image, e.g. \"figures/schematic.png\". Parent dirs are created.",
  }),
  provider: Type.Optional(
    Type.String({
      description: 'Force "openai" or "gemini". Omit to use Settings / model-id inference.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override IMAGE_MODEL for this call (e.g. gpt-image-2, gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image, gemini-2.5-flash-image).",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        'OpenAI size string (e.g. "1024x1024", "1536x1024") or Gemini image_size ("1K","2K","4K").',
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
        "Sandbox-relative reference images for compose/edit (Gemini primary). Not supported on OpenAI path in v1.",
    }),
  ),
  n: Type.Optional(
    Type.Number({
      description: "Number of candidates (OpenAI; max 8). First is written to `path`; extras get _2, _3, …",
    }),
  ),
});
export type ImageGenerateParamsT = Static<typeof ImageGenerateParams>;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Resolve a sandbox-relative path, refusing traversal. */
export function safeUnder(sandboxRoot: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, "");
  const target = path.resolve(sandboxRoot, cleaned);
  if (!isWithin(sandboxRoot, target)) {
    throw new Error(`Path escapes the project sandbox: ${rel}`);
  }
  return target;
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function loadReferences(
  sandboxRoot: string,
  rels: string[] | undefined,
): ReferenceImage[] {
  if (!rels?.length) return [];
  if (rels.length > MAX_REFS) {
    throw new Error(`At most ${MAX_REFS} reference_paths allowed`);
  }
  const out: ReferenceImage[] = [];
  for (const rel of rels) {
    const abs = safeUnder(sandboxRoot, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`Reference is not a file: ${rel}`);
    if (st.size > MAX_REF_BYTES) {
      throw new Error(`Reference too large (>${MAX_REF_BYTES} bytes): ${rel}`);
    }
    out.push({
      mimeType: mimeFromPath(abs),
      dataBase64: fs.readFileSync(abs).toString("base64"),
    });
  }
  return out;
}

function siblingPath(outPath: string, index: number): string {
  if (index <= 1) return outPath;
  const dir = path.dirname(outPath);
  const ext = path.extname(outPath);
  const base = path.basename(outPath, ext);
  return path.join(dir, `${base}_${index}${ext || ".png"}`);
}

/**
 * Shared execute body used by the lead tool and (conceptually) the child package.
 * When projectId is null, skip budget + ledger (subagent path).
 */
export async function runImageGenerate(opts: {
  projectId: string | null;
  sessionId: string;
  params: ImageGenerateParamsT;
  signal?: AbortSignal;
  /** Override cwd for package (child uses process.cwd() = sandbox). */
  sandboxRoot?: string;
}): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const { projectId, sessionId, params, signal } = opts;

  if (projectId) {
    const budget = isBudgetExceeded(projectId);
    if (budget.exceeded) {
      return textResult(
        `Image generation blocked: the project has reached its spend limit ` +
          `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
          `Ask the user to raise the limit or generate fewer images.`,
        { blocked: "budget" },
      );
    }
  }

  if (!imageGenConfigured() && !params.model?.trim()) {
    return textResult(
      "Image generation is not configured. In Settings → API keys set Image model " +
        "(e.g. gpt-image-2 or gemini-2.5-flash-image) plus dedicated credentials: " +
        "OpenAI path needs IMAGE_BASE_URL + IMAGE_API_KEY (not your chat LLM endpoint — " +
        "chat may be Qwen/etc.); Gemini path needs GEMINI_API_KEY. " +
        "Then open a new chat tab so the tool registers.",
      { error: "not_configured" },
    );
  }

  const model =
    (params.model && params.model.trim()) ||
    (process.env.IMAGE_MODEL || "").trim();
  if (!model) {
    return textResult(
      "No image model set. Set IMAGE_MODEL (or pass model=) to e.g. gpt-image-2 or gemini-2.5-flash-image.",
      { error: "no_model" },
    );
  }

  const provider: ImageProvider = parseImageProvider(params.provider, model);
  const cfg = getImageGenConfig({ model, provider });

  if (cfg.provider === "gemini" && !cfg.apiKey) {
    return textResult(
      "Gemini image generation needs GEMINI_API_KEY (Settings → API keys).",
      { error: "not_configured", provider: "gemini" },
    );
  }
  if (cfg.provider === "openai" && (!cfg.baseUrl || !cfg.apiKey)) {
    return textResult(
      "OpenAI image generation needs its own IMAGE_BASE_URL and IMAGE_API_KEY " +
        "(e.g. https://api.openai.com/v1 + sk-…). " +
        "These are separate from the chat LLM settings — chat may use Qwen or another provider.",
      { error: "not_configured", provider: "openai" },
    );
  }

  const sandboxRoot =
    opts.sandboxRoot ??
    (projectId ? resolvePaths(projectId).sandbox : process.cwd());

  let outRel = (params.path || "").trim().replace(/^\/+/, "");
  if (!outRel) {
    return textResult("path is required (sandbox-relative, e.g. figures/fig.png).", {
      error: "bad_path",
    });
  }
  // Default extension
  if (!path.extname(outRel)) outRel = `${outRel}.png`;

  let references: ReferenceImage[] = [];
  try {
    references = loadReferences(sandboxRoot, params.reference_paths);
  } catch (err) {
    return textResult((err as Error).message, { error: "bad_reference" });
  }

  let result;
  try {
    result = await generateImages({
      provider: cfg.provider,
      model: cfg.model,
      prompt: params.prompt,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      size: params.size,
      quality: params.quality,
      aspectRatio: params.aspect_ratio,
      imageSize: params.size && /^[\d.]*[kK]$/.test(params.size) ? params.size : undefined,
      n: params.n,
      references,
      signal,
    });
  } catch (err) {
    return textResult(
      `Image generation failed: ${(err as Error).message}`,
      { error: "api_error", provider: cfg.provider, model: cfg.model },
    );
  }

  const written: string[] = [];
  try {
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i];
      const rel = siblingPath(outRel, i + 1).replace(/\\/g, "/");
      const abs = safeUnder(sandboxRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, img.buffer);
      written.push(rel);
    }
  } catch (err) {
    return textResult(`Failed to write image file: ${(err as Error).message}`, {
      error: "write_error",
    });
  }

  const costUsd = estimateImageGenCostUsd({
    provider: cfg.provider,
    quality: params.quality,
    n: result.images.length,
    imageSize: params.size,
  });
  if (projectId && sessionId) {
    recordComputeRun(
      projectId,
      sessionId,
      costUsd,
      `image_generate:${cfg.provider}:${cfg.model}`,
    );
  }

  const summary = {
    path: written[0],
    paths: written,
    provider: cfg.provider,
    model: cfg.model,
    bytes: result.images.map((i) => i.buffer.length),
    mimeTypes: result.images.map((i) => i.mimeType),
    estimatedCostUsd: costUsd,
    note:
      "Approximate ledger cost only — billed on your OpenAI/Google account. " +
      "Generative images are conceptual; use Python plots for quantitative scientific figures.",
  };

  return textResult(
    `Saved ${written.length} image(s):\n` +
      written.map((p) => `- ${p}`).join("\n") +
      `\nprovider=${cfg.provider} model=${cfg.model}` +
      (result.rawNote ? ` via=${result.rawNote}` : "") +
      `\nOpen the path in the file panel. Estimated cost ~$${costUsd.toFixed(3)} (approximate).`,
    summary,
  );
}

export function makeImageGenerateTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof ImageGenerateParams> {
  return {
    name: "image_generate",
    label: "Image generate",
    description: [
      "Generate an image from a text prompt (and optional reference images) and save it into the project sandbox.",
      "Providers: OpenAI Image API (gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini, dall-e-3)",
      "via POST /v1/images/generations, or Google Gemini Nano Banana",
      "(gemini-3.1-flash-image / lite / gemini-3-pro-image / gemini-2.5-flash-image) via Gemini Interactions API.",
      "Use for conceptual diagrams, proposal schematics, cover art, and style mocks — NOT for quantitative plots from data",
      "(prefer Python matplotlib/seaborn for data figures).",
      "Always set `path` under figures/ (e.g. figures/workflow.png). Configure IMAGE_MODEL in Settings → API keys.",
      "OpenAI path needs dedicated IMAGE_BASE_URL + IMAGE_API_KEY (not the chat LLM — chat may be Qwen/etc.).",
      "Gemini path uses GEMINI_API_KEY.",
    ].join(" "),
    promptSnippet:
      "image_generate: text-to-image (OpenAI gpt-image-* or Gemini Nano Banana) → sandbox PNG",
    promptGuidelines: [
      "Prefer image_generate for conceptual/schematic figures; use code for data plots.",
      "Write outputs to figures/… and tell the user the path.",
      "For multi-image compose/edit, use a Gemini image model + reference_paths.",
    ],
    parameters: ImageGenerateParams,
    execute: async (_toolCallId, params, signal) => {
      return runImageGenerate({
        projectId,
        sessionId: getSessionId(),
        params,
        signal,
      });
    },
  };
}

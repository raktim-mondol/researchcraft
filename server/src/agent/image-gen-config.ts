/**
 * Image-generation endpoint config (OpenAI Images + Gemini Nano Banana).
 *
 * Intentionally separate from the chat LLM endpoint. Chat may be Qwen,
 * Ollama, Anthropic-via-proxy, etc., while images need a real Images API
 * (typically OpenAI) or Gemini — never inherit LLM_BASE_URL / LLM_API_KEY.
 *
 * OpenAI path: IMAGE_MODEL + IMAGE_BASE_URL + IMAGE_API_KEY
 * Gemini path: IMAGE_MODEL + GEMINI_API_KEY (or IMAGE_API_KEY override)
 */

export type ImageProvider = "openai" | "gemini";

export interface ImageGenConfig {
  provider: ImageProvider;
  model: string;
  /** OpenAI Images API base (…/v1). Empty for pure Gemini. */
  baseUrl: string;
  apiKey: string;
}

const GEMINI_HOST = "https://generativelanguage.googleapis.com";

/** Infer provider from model id when IMAGE_PROVIDER is unset. */
export function inferImageProvider(model: string): ImageProvider {
  const m = model.trim().toLowerCase();
  if (
    m.startsWith("gemini-") ||
    m.includes("nano-banana") ||
    m.includes("flash-image") ||
    m.includes("pro-image")
  ) {
    return "gemini";
  }
  return "openai";
}

export function parseImageProvider(
  raw: string | undefined | null,
  model: string,
): ImageProvider {
  const p = (raw ?? "").trim().toLowerCase();
  if (p === "openai" || p === "gemini") return p;
  if (!model) return "openai";
  return inferImageProvider(model);
}

/** Read live image-gen config from the environment. */
export function getImageGenConfig(overrides?: {
  model?: string;
  provider?: string;
}): ImageGenConfig {
  const model = (
    overrides?.model?.trim() ||
    process.env.IMAGE_MODEL ||
    ""
  ).trim();
  const provider = parseImageProvider(
    overrides?.provider ?? process.env.IMAGE_PROVIDER,
    model,
  );

  if (provider === "gemini") {
    const apiKey = (
      process.env.IMAGE_API_KEY ||
      process.env.GEMINI_API_KEY ||
      ""
    ).trim();
    return {
      provider: "gemini",
      model,
      baseUrl: GEMINI_HOST,
      apiKey,
    };
  }

  // Dedicated image endpoint only — do not reuse chat LLM_* (e.g. Qwen).
  const baseUrl = (process.env.IMAGE_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.IMAGE_API_KEY || "").trim();
  return {
    provider: "openai",
    model,
    baseUrl,
    apiKey,
  };
}

/**
 * True when the agent can attempt image generation.
 * Requires IMAGE_MODEL plus dedicated credentials for the resolved provider.
 */
export function imageGenConfigured(): boolean {
  const model = (process.env.IMAGE_MODEL || "").trim();
  if (!model) return false;
  const cfg = getImageGenConfig();
  if (cfg.provider === "gemini") {
    return Boolean(cfg.apiKey);
  }
  // OpenAI Images: own base URL + key (chat LLM may be a different provider).
  return Boolean(cfg.baseUrl && cfg.apiKey);
}

/** Rough USD estimate for ledgering (provider still bills the real amount). */
export function estimateImageGenCostUsd(opts: {
  provider: ImageProvider;
  quality?: string;
  n?: number;
  imageSize?: string;
}): number {
  const n = Math.max(1, Math.min(opts.n ?? 1, 8));
  if (opts.provider === "gemini") {
    // Gemini 2.5 Flash Image class ~$0.039/image; higher tiers cost more.
    const size = (opts.imageSize || "1K").toUpperCase();
    const per =
      size === "4K" ? 0.12 : size === "2K" ? 0.08 : size.includes("0.5") ? 0.02 : 0.039;
    return per * n;
  }
  // Approximate GPT Image 2 1024×1024 list prices (docs); provider bills actual usage.
  const q = (opts.quality || "auto").toLowerCase();
  const per =
    q === "high" ? 0.211 : q === "medium" ? 0.053 : q === "low" ? 0.006 : 0.053;
  return per * n;
}

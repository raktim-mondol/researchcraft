/**
 * Image-generation endpoint config (OpenAI Images + Gemini Nano Banana).
 *
 * Separate from the chat LLM trio: image models almost never accept
 * /images/generations or Gemini image modalities under the chat model id.
 * IMAGE_MODEL must be set to enable the tool; credentials fall back to
 * LLM_* (OpenAI path) or GEMINI_API_KEY (Gemini path).
 */
import { getLlmConfig } from "./models.ts";

export type ImageProvider = "openai" | "gemini";

export interface ImageGenConfig {
  provider: ImageProvider;
  model: string;
  /** OpenAI-compatible base (…/v1). Empty for pure Gemini. */
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
  const llm = getLlmConfig();
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

  const baseUrl = (
    process.env.IMAGE_BASE_URL ||
    llm.baseUrl ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.IMAGE_API_KEY || llm.apiKey || "").trim();
  return {
    provider: "openai",
    model,
    baseUrl,
    apiKey,
  };
}

/**
 * True when the agent can attempt image generation.
 * Requires IMAGE_MODEL plus credentials for the resolved provider.
 */
export function imageGenConfigured(): boolean {
  const model = (process.env.IMAGE_MODEL || "").trim();
  if (!model) return false;
  const cfg = getImageGenConfig();
  if (cfg.provider === "gemini") {
    return Boolean(cfg.apiKey);
  }
  // OpenAI-compatible: need a base URL; key optional for some local servers.
  return Boolean(cfg.baseUrl);
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
  const q = (opts.quality || "auto").toLowerCase();
  const per =
    q === "high" ? 0.08 : q === "medium" ? 0.04 : q === "low" ? 0.01 : 0.04;
  return per * n;
}

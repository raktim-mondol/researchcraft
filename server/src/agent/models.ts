/**
 * Model resolution for the Pi agent.
 *
 * The app uses a single user-configured OpenAI-compatible endpoint:
 *   - LLM_BASE_URL  — e.g. https://api.openai.com/v1, http://localhost:11434/v1
 *   - LLM_API_KEY   — Bearer token for that endpoint (optional for some local servers)
 *   - LLM_MODEL     — model id the endpoint expects
 *   - LLM_CONTEXT_WINDOW — optional token context budget for the meter / compaction
 *     (defaults to 1_000_000 when unset or invalid)
 *   - LLM_MULTIMODAL — "true" when the model accepts image blocks (vision);
 *     unset/false = text-only, so /run rejects image attachments with a clear
 *     error instead of letting the provider silently drop them
 *   - LLM_PRICE_INPUT / LLM_PRICE_OUTPUT / LLM_PRICE_CACHE_READ — optional USD
 *     per 1M tokens; when set, Pi prices every run from token usage so the cost
 *     meters and the project spend cap are accurate even if the provider
 *     reports no usage cost
 *
 * Internally Pi still uses the "openrouter" provider slot (its built-in
 * OpenAI-completions path) so subagent child `pi` processes can pick up the
 * same key via OPENROUTER_API_KEY / OPENROUTER_BASE_URL mirrors set in
 * setupAuth / credentials.
 */
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Canonical provider id used in Pi Model objects (OpenAI-compatible path). */
export const LLM_PROVIDER = "openrouter";

/**
 * Default context-window size when LLM_CONTEXT_WINDOW is unset or invalid.
 * Providers vary widely (32k–2M+); 1M is a safe high default for modern
 * frontier models so the usage meter is not artificially capped at 128k.
 */
export const DEFAULT_LLM_CONTEXT_WINDOW = 1_000_000;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Token budget used by Pi for context % / auto-compact (not an API hard limit). */
  contextWindow: number;
}

/**
 * Parse a context-window env/setting value.
 * Accepts integers (and integer-like strings); rejects 0, negatives, NaN.
 */
export function parseContextWindow(raw: string | undefined | null): number {
  if (raw == null) return DEFAULT_LLM_CONTEXT_WINDOW;
  const s = String(raw).trim().replace(/_/g, "");
  if (!s) return DEFAULT_LLM_CONTEXT_WINDOW;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_CONTEXT_WINDOW;
  return Math.floor(n);
}

/** Read the live LLM endpoint config from the environment. */
export function getLlmConfig(): LlmConfig {
  const baseUrl = (
    process.env.LLM_BASE_URL ||
    process.env.OPENROUTER_BASE_URL ||
    ""
  ).trim();
  const apiKey = (
    process.env.LLM_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OR_API_KEY ||
    ""
  ).trim();
  const model = (
    process.env.LLM_MODEL ||
    process.env.DEFAULT_MODEL_ID ||
    ""
  ).trim();
  const contextWindow = parseContextWindow(process.env.LLM_CONTEXT_WINDOW);
  return { baseUrl, apiKey, model, contextWindow };
}

/** True when enough is set to attempt a model call. */
export function llmConfigured(): boolean {
  const { baseUrl, model } = getLlmConfig();
  return Boolean(baseUrl && model);
}

/** Whether the configured endpoint accepts image blocks (vision-capable). */
export function llmMultimodal(): boolean {
  const v = (process.env.LLM_MULTIMODAL ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** USD per 1M tokens for the configured endpoint (optional; $0 when unset). */
export interface LlmPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function parseUsdPerMTokens(raw: string | undefined | null): number {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/,/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function getLlmPricing(): LlmPricing {
  return {
    input: parseUsdPerMTokens(process.env.LLM_PRICE_INPUT),
    output: parseUsdPerMTokens(process.env.LLM_PRICE_OUTPUT),
    cacheRead: parseUsdPerMTokens(process.env.LLM_PRICE_CACHE_READ),
    cacheWrite: 0,
  };
}

/**
 * Build the Pi Model for the configured endpoint.
 * `ref` is ignored when the saved LLM_MODEL is set (the UI no longer offers
 * a catalogue); kept only so callers that still pass a model id keep working
 * for one-shot assist/draft helpers.
 */
export function buildConfiguredModel(ref?: string): Model<Api> {
  const cfg = getLlmConfig();
  const pricing = getLlmPricing();
  const id = (ref && ref.trim()) || cfg.model || "unconfigured";
  const baseUrl = (cfg.baseUrl || "http://127.0.0.1:0").replace(/\/+$/, "");
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LLM_PROVIDER,
    baseUrl,
    reasoning: true,
    // Text-only unless LLM_MULTIMODAL is enabled — image parts are then
    // rejected at the /run boundary rather than silently dropped upstream.
    input: llmMultimodal() ? ["text", "image"] : ["text"],
    // Cost tracking from token usage × configured per-1M-token prices. $0
    // when unset, in which case only provider-reported usage cost is ledgered.
    cost: {
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cacheRead,
      cacheWrite: pricing.cacheWrite,
    },
    contextWindow: cfg.contextWindow,
    maxTokens: 8192,
  };
}

/**
 * Wire provider credentials into AuthStorage from the environment.
 * Also mirrors into OPENROUTER_* so child `pi` processes (subagents) inherit
 * the same endpoint credentials via Pi's built-in env lookup.
 */
export function setupAuth(authStorage: AuthStorage): void {
  const { apiKey, baseUrl } = getLlmConfig();
  // Pi requires *some* key string even for local servers that ignore auth.
  const key = apiKey || "no-key";
  authStorage.setRuntimeApiKey(LLM_PROVIDER, key);
  process.env.OPENROUTER_API_KEY = key;
  if (baseUrl) process.env.OPENROUTER_BASE_URL = baseUrl.replace(/\/+$/, "");
}

/**
 * Resolve a model ref to a Pi Model. All refs use the user-configured
 * endpoint; when a ref is omitted, LLM_MODEL is used.
 */
export function resolveModel(
  ref: string | undefined,
  _registry: ModelRegistry,
): Model<Api> {
  const r = (ref ?? "").trim();
  // Strip legacy prefixes so old session state still works.
  let modelId = r;
  if (modelId.startsWith("openrouter/")) modelId = modelId.slice("openrouter/".length);
  if (modelId.startsWith("ollama/")) modelId = modelId.slice("ollama/".length);
  // Frontend placeholder when Settings has no model yet — ignore it.
  if (modelId === "unconfigured") modelId = "";
  // Prefer the explicitly requested id when present; otherwise the saved default.
  return buildConfiguredModel(modelId || undefined);
}

export function defaultModel(_registry: ModelRegistry): Model<Api> {
  return buildConfiguredModel();
}

/** API key string to pass into one-shot `complete()` calls. */
export function llmApiKey(): string {
  return getLlmConfig().apiKey || "no-key";
}

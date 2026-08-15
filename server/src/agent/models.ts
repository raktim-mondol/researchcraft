/**
 * Model resolution for the dsh-backed agent runtime.
 *
 * The app uses a single user-configured OpenAI-compatible endpoint:
 *   - LLM_BASE_URL  — e.g. https://api.openai.com/v1, http://localhost:11434/v1
 *   - LLM_API_KEY   — Bearer token for that endpoint (optional for some local servers)
 *   - LLM_MODEL     — model id the endpoint expects
 *
 * This is resolved into a single `dsh-llm-pi-ai` route (see dsh/compose/llm.ts)
 * named `LLM_ROUTE_NAME`. Unlike Pi, dsh's SDK-server protocol fixes a
 * runtime's provider/model for that whole process's lifetime (`initialize`
 * takes provider/model once; there is no per-request override) — so
 * `session-registry.ts` compares a live runtime's baked-in model against the
 * current `getLlmConfig()` on every run and respawns the runtime when they
 * differ (e.g. the user changed Settings → API keys), rather than mutating
 * a live session's model the way Pi's `session.setModel()` did.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { LlmRouteConfig } from "./dsh/types.ts";

/** The one dsh-llm-pi-ai provider route this app ever configures. */
export const LLM_ROUTE_NAME = "researchcraft";

/** Env var name dsh-llm-pi-ai reads the credential from when one is set. */
export const LLM_API_KEY_ENV = "LLM_API_KEY";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
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
  return { baseUrl, apiKey, model };
}

/** True when enough is set to attempt a model call. */
export function llmConfigured(): boolean {
  const { baseUrl, model } = getLlmConfig();
  return Boolean(baseUrl && model);
}

/**
 * Build the single `dsh-llm-pi-ai` route for the currently configured
 * endpoint. `apiKeyEnv` references `LLM_API_KEY` by name (dsh resolves it
 * from the runtime subprocess's own environment, which already inherits the
 * parent process's env — no mirroring into another var needed, unlike Pi's
 * old OPENROUTER_* mirror for child `pi` processes). A keyless local server
 * still needs *some* Authorization value on the wire, so we send a
 * placeholder header instead of a credential reference in that case.
 */
export function buildLlmRoute(): LlmRouteConfig {
  const cfg = getLlmConfig();
  const baseURL = (cfg.baseUrl || "http://127.0.0.1:0").replace(/\/+$/, "");
  const modelId = cfg.model || "unconfigured";
  return {
    name: LLM_ROUTE_NAME,
    baseURL,
    api: "openai-completions",
    ...(cfg.apiKey
      ? { apiKeyEnv: LLM_API_KEY_ENV }
      : { headers: { Authorization: "Bearer no-key" } }),
    models: [{ id: modelId, contextWindow: 128_000, maxTokens: 8192 }],
  };
}

/**
 * Resolve a model ref from the wire to the model id the configured route
 * actually serves. ResearchCraft has one configured model, not a catalogue
 * (`ref` only matters for stripping legacy prefixes from old session state
 * and ignoring the frontend's "unconfigured" placeholder) — Fusion refs are
 * rejected outright; Fusion was OpenRouter-specific and is no longer offered
 * in the UI.
 */
export function resolveModelId(ref: string | undefined): string {
  const r = (ref ?? "").trim();
  if (r.startsWith("fusion/")) {
    throw new Error(
      "OpenRouter Fusion is not supported. Configure a single model under Settings → API keys.",
    );
  }
  let modelId = r;
  if (modelId.startsWith("openrouter/")) modelId = modelId.slice("openrouter/".length);
  if (modelId.startsWith("ollama/")) modelId = modelId.slice("ollama/".length);
  if (modelId === "unconfigured") modelId = "";
  return modelId || getLlmConfig().model || "unconfigured";
}

/** API key string to pass into one-shot `@earendil-works/pi-ai` `complete()` calls (`latex/assist.ts`, `methods-draft.ts`). */
export function llmApiKey(): string {
  return getLlmConfig().apiKey || "no-key";
}

/**
 * Build a one-shot `pi-ai` `Model` for the configured endpoint. Used only by
 * `latex/assist.ts` and `agent/methods-draft.ts`'s single `complete()` calls
 * — the dsh chat runtime itself never uses this, it builds its own
 * `dsh-llm-pi-ai` route via {@link buildLlmRoute}. `@earendil-works/pi-ai`
 * stays a direct dependency for exactly this: it's the same library
 * `dsh-llm-pi-ai` itself wraps, so a plain one-shot call doesn't need a whole
 * runtime subprocess spun up just to fix a LaTeX error.
 * No pricing catalog for a BYOK custom endpoint, so `cost` stays zeroed —
 * matches this app's pre-existing behavior (cost tracking shows $0 unless
 * the provider reports usage the user meters externally).
 */
export function buildOneShotModel(ref?: string): Model<"openai-completions"> {
  const id = resolveModelId(ref);
  const cfg = getLlmConfig();
  const baseUrl = (cfg.baseUrl || "http://127.0.0.1:0").replace(/\/+$/, "");
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "researchcraft",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

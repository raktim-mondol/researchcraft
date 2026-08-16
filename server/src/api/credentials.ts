/**
 * Runtime credential management for the bring-your-own-key model.
 *
 * Historically the only way to set a key was to edit the repo-root `.env` and
 * restart the app — a real wall for a non-technical scientist. These endpoints
 * let the Settings UI read key status and set keys live:
 *   - GET  /credentials  → masked status per provider (never the raw key)
 *   - PUT  /credentials  → set/clear any subset of keys, persist to `.env`,
 *                          and update process.env so in-flight sessions (and
 *                          the child `pi` processes pi-subagents spawns, which
 *                          inherit our environment) pick them up without a
 *                          restart.
 *
 * Managed values:
 *   - LLM endpoint (base URL + API key + model name + optional context window)
 *   - Image generation (IMAGE_MODEL + optional provider / base URL / key)
 *   - Optional pi-web-access search keys (Exa, Perplexity, Gemini)
 *   - Parallel Search MCP + Firecrawl MCP API keys (higher rate limits)
 *   - Modal remote-compute token pair
 *   - Runpod remote-compute API key
 *
 * Keys are stored exactly where the app already expects them (repo-root
 * `.env`, plaintext, on the user's own machine) — we are removing friction,
 * not changing the trust model. The server binds to localhost only.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { REPO_ROOT } from "../config.ts";
import { getAuthStorage } from "../agent/session-registry.ts";
import { getLlmConfig, LLM_PROVIDER, setupAuth } from "../agent/models.ts";

const ENV_PATH = path.join(REPO_ROOT, ".env");

interface ManagedKey {
  /** Provider id in API payloads (GET response field). */
  id: string;
  /** PUT body field name. */
  bodyField: string;
  /** Canonical env var written to `.env`. */
  envVar: string;
  /** Extra env vars read (and cleared) for backwards compatibility. */
  envAliases?: string[];
  /** Hook run after set/clear (e.g. push into AuthStorage). */
  onChange?: (key: string | null) => void;
  /** Skip the minimum-length check (for non-secret strings like URLs). */
  allowShort?: boolean;
  /** When true, empty string clears; non-empty values of any length are ok. */
  isPlainText?: boolean;
}

const MANAGED_KEYS: ManagedKey[] = [
  {
    id: "llmApiKey",
    bodyField: "llmApiKey",
    envVar: "LLM_API_KEY",
    // Legacy OpenRouter key names — still read, cleared when LLM key is cleared.
    envAliases: ["OPENROUTER_API_KEY", "OR_API_KEY"],
    onChange: () => {
      // Re-sync AuthStorage + OPENROUTER_* mirrors from the full LLM config.
      try {
        setupAuth(getAuthStorage());
      } catch {
        /* AuthStorage may reject empty; status still reflects env */
      }
    },
  },
  {
    id: "llmBaseUrl",
    bodyField: "llmBaseUrl",
    envVar: "LLM_BASE_URL",
    envAliases: ["OPENROUTER_BASE_URL"],
    allowShort: true,
    isPlainText: true,
    onChange: () => {
      try {
        setupAuth(getAuthStorage());
      } catch {
        /* ignore */
      }
    },
  },
  {
    id: "llmModel",
    bodyField: "llmModel",
    envVar: "LLM_MODEL",
    envAliases: ["DEFAULT_MODEL_ID"],
    allowShort: true,
    isPlainText: true,
  },
  {
    // Token context budget for the session meter / compaction (not an API hard limit).
    // Empty / clear → app default (1_000_000) via parseContextWindow in models.ts.
    id: "llmContextWindow",
    bodyField: "llmContextWindow",
    envVar: "LLM_CONTEXT_WINDOW",
    allowShort: true,
    isPlainText: true,
  },
  {
    // Vision toggle: "true" = the endpoint accepts image blocks (Model.input
    // includes "image"). Empty/unset = text-only — /run then rejects image
    // attachments with a clear error instead of silently dropping them.
    id: "llmMultimodal",
    bodyField: "llmMultimodal",
    envVar: "LLM_MULTIMODAL",
    allowShort: true,
    isPlainText: true,
  },
  // Optional per-model pricing (USD per 1M tokens). When set, Pi prices every
  // run from token usage so the cost meters and the project spend cap are
  // accurate even if the provider reports no usage cost. Empty clears → $0.
  {
    id: "llmPriceInput",
    bodyField: "llmPriceInput",
    envVar: "LLM_PRICE_INPUT",
    allowShort: true,
    isPlainText: true,
  },
  {
    id: "llmPriceOutput",
    bodyField: "llmPriceOutput",
    envVar: "LLM_PRICE_OUTPUT",
    allowShort: true,
    isPlainText: true,
  },
  {
    id: "llmPriceCacheRead",
    bodyField: "llmPriceCacheRead",
    envVar: "LLM_PRICE_CACHE_READ",
    allowShort: true,
    isPlainText: true,
  },
  // Text-to-image (OpenAI Images + Gemini Nano Banana). IMAGE_MODEL enables the tool.
  {
    id: "imageModel",
    bodyField: "imageModel",
    envVar: "IMAGE_MODEL",
    allowShort: true,
    isPlainText: true,
  },
  {
    id: "imageProvider",
    bodyField: "imageProvider",
    envVar: "IMAGE_PROVIDER",
    allowShort: true,
    isPlainText: true,
  },
  {
    id: "imageBaseUrl",
    bodyField: "imageBaseUrl",
    envVar: "IMAGE_BASE_URL",
    allowShort: true,
    isPlainText: true,
  },
  {
    id: "imageApiKey",
    bodyField: "imageApiKey",
    envVar: "IMAGE_API_KEY",
  },
  { id: "exa", bodyField: "exaApiKey", envVar: "EXA_API_KEY" },
  { id: "perplexity", bodyField: "perplexityApiKey", envVar: "PERPLEXITY_API_KEY" },
  { id: "gemini", bodyField: "geminiApiKey", envVar: "GEMINI_API_KEY" },
  // Parallel Search MCP + Firecrawl MCP (seeded as project connectors; keys
  // raise rate limits / unlock full Firecrawl tools — both work keyless).
  { id: "parallel", bodyField: "parallelApiKey", envVar: "PARALLEL_API_KEY" },
  { id: "firecrawl", bodyField: "firecrawlApiKey", envVar: "FIRECRAWL_API_KEY" },
  // Modal remote compute is two env vars for one logical credential; both must
  // be set for modalConfigured() to flip true and the modal_run tool to register.
  { id: "modalTokenId", bodyField: "modalTokenId", envVar: "MODAL_TOKEN_ID" },
  { id: "modalTokenSecret", bodyField: "modalTokenSecret", envVar: "MODAL_TOKEN_SECRET" },
  // Runpod remote compute — single API key unlocks pods + the runpod_run tool.
  { id: "runpodApiKey", bodyField: "runpodApiKey", envVar: "RUNPOD_API_KEY" },
];

function readKey(spec: ManagedKey): string | null {
  for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Show only enough to recognize the key, never enough to use it. */
function mask(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Upsert (or remove) a KEY=value line in `.env`, preserving other lines and
 *  comments. Creates the file if missing. Values are quoted only when needed. */
function persistEnv(name: string, value: string | null): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  } catch {
    lines = [];
  }
  const isAssignment = (l: string, key: string) =>
    l.trim().startsWith(`${key}=`) && !l.trim().startsWith("#");
  // Drop any existing assignment for this key.
  lines = lines.filter((l) => !isAssignment(l, name));
  if (value !== null) {
    const needsQuote = /[\s#"']/.test(value);
    const rendered = needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value;
    // Keep a trailing newline tidy: append before any trailing blank lines.
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(`${name}=${rendered}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

function status() {
  const out: Record<string, { set: boolean; masked: string | null; value?: string }> = {};
  for (const spec of MANAGED_KEYS) {
    const key = readKey(spec);
    if (spec.isPlainText) {
      // Non-secret config (base URL, model name) is returned in full so the
      // Settings form can re-populate inputs.
      out[spec.id] = key
        ? { set: true, masked: null, value: key }
        : { set: false, masked: null, value: "" };
    } else {
      out[spec.id] = key ? { set: true, masked: mask(key) } : { set: false, masked: null };
    }
  }
  // Convenience aggregate for the chat model badge / frontend.
  const cfg = getLlmConfig();
  out.llm = {
    set: Boolean(cfg.baseUrl && cfg.model),
    masked: cfg.apiKey ? mask(cfg.apiKey) : null,
    value: cfg.model || "",
  };
  // Keep a stable shape the UI already checks for Modal gating.
  return out;
}

function applyKey(spec: ManagedKey, raw: string | null): string | null {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key === "") {
    // Clear: drop from process.env and .env (canonical + aliases).
    for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) delete process.env[name];
    persistEnv(spec.envVar, null);
    for (const alias of spec.envAliases ?? []) persistEnv(alias, null);
    spec.onChange?.(null);
    return null;
  }
  if (!spec.allowShort && !spec.isPlainText && key.length < 8) {
    return "That key looks too short to be valid.";
  }
  if (spec.id === "llmBaseUrl" || spec.id === "imageBaseUrl") {
    // Light validation — must look like an absolute URL.
    try {
      const u = new URL(key);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return "Base URL must start with http:// or https://";
      }
    } catch {
      return "Base URL must be a valid URL (e.g. https://api.openai.com/v1)";
    }
  }
  if (spec.id === "imageProvider") {
    const p = key.toLowerCase();
    if (p !== "openai" && p !== "gemini" && p !== "auto") {
      return 'Image provider must be "openai", "gemini", or "auto" (or leave blank)';
    }
    // "auto" clears the override so model-id inference applies.
    if (p === "auto") {
      for (const name of [spec.envVar, ...(spec.envAliases ?? [])]) delete process.env[name];
      persistEnv(spec.envVar, null);
      spec.onChange?.(null);
      return null;
    }
    process.env[spec.envVar] = p;
    persistEnv(spec.envVar, p);
    spec.onChange?.(p);
    return null;
  }
  if (spec.id === "llmMultimodal") {
    const v = key.toLowerCase();
    if (v !== "true" && v !== "false" && v !== "1" && v !== "0") {
      return 'Supports images must be "true" or "false"';
    }
    const stored = v === "true" || v === "1" ? "true" : "false";
    process.env[spec.envVar] = stored;
    persistEnv(spec.envVar, stored);
    spec.onChange?.(stored);
    return null;
  }
  if (spec.id.startsWith("llmPrice")) {
    const n = Number(key.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      return "Price must be a non-negative number (USD per 1M tokens)";
    }
    const stored = String(n);
    process.env[spec.envVar] = stored;
    persistEnv(spec.envVar, stored);
    spec.onChange?.(stored);
    return null;
  }
  if (spec.id === "llmContextWindow") {
    const normalized = key.replace(/_/g, "").replace(/,/g, "");
    const n = Number(normalized);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return "Context window must be a positive integer (token count), e.g. 200000 or 1000000";
    }
    // Cap absurd typos (e.g. extra zeros) without blocking multi‑million windows.
    if (n > 100_000_000) {
      return "Context window looks too large (max 100000000). Check the model docs for the real limit.";
    }
    const stored = String(n);
    process.env[spec.envVar] = stored;
    persistEnv(spec.envVar, stored);
    spec.onChange?.(stored);
    return null;
  }
  process.env[spec.envVar] = key;
  persistEnv(spec.envVar, key);
  // Keep Pi-compatible mirrors in sync for the LLM trio.
  if (spec.id === "llmApiKey") {
    process.env.OPENROUTER_API_KEY = key;
    persistEnv("OPENROUTER_API_KEY", key);
  } else if (spec.id === "llmBaseUrl") {
    const cleaned = key.replace(/\/+$/, "");
    process.env.LLM_BASE_URL = cleaned;
    process.env.OPENROUTER_BASE_URL = cleaned;
    persistEnv("LLM_BASE_URL", cleaned);
    persistEnv("OPENROUTER_BASE_URL", cleaned);
  } else if (spec.id === "llmModel") {
    process.env.DEFAULT_MODEL_ID = key;
    persistEnv("DEFAULT_MODEL_ID", key);
  }
  spec.onChange?.(key);
  return null;
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/credentials", async () => status());

  app.put<{ Body: Record<string, string | null | undefined> }>(
    "/credentials",
    async (req, reply) => {
      const provided = MANAGED_KEYS.filter((s) => req.body?.[s.bodyField] !== undefined);
      if (provided.length === 0) {
        reply.code(400);
        const fields = MANAGED_KEYS.map((s) => s.bodyField).join(", ");
        return { detail: `Provide at least one of: ${fields} (a string, or null to clear)` };
      }
      for (const spec of provided) {
        const error = applyKey(spec, req.body?.[spec.bodyField] ?? null);
        if (error) {
          reply.code(400);
          return { detail: error };
        }
      }
      // Ensure AuthStorage always reflects the latest LLM key after a batch put.
      try {
        setupAuth(getAuthStorage());
      } catch {
        /* ignore */
      }
      void LLM_PROVIDER; // keep import used for clarity
      return status();
    },
  );
}

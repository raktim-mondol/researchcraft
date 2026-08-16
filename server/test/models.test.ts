import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfiguredModel,
  DEFAULT_LLM_CONTEXT_WINDOW,
  getLlmConfig,
  getLlmPricing,
  llmConfigured,
  llmMultimodal,
  parseContextWindow,
  resolveModel,
} from "../src/agent/models.ts";

const ENV_KEYS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_CONTEXT_WINDOW",
  "LLM_MULTIMODAL",
  "LLM_PRICE_INPUT",
  "LLM_PRICE_OUTPUT",
  "LLM_PRICE_CACHE_READ",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "OR_API_KEY",
  "DEFAULT_MODEL_ID",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv() {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe("user-configured LLM endpoint", () => {
  snapshotEnv();
  afterEach(() => restoreEnv());

  it("reads LLM_* env vars", () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_API_KEY = "sk-test-key";
    process.env.LLM_MODEL = "my-model";
    delete process.env.LLM_CONTEXT_WINDOW;
    expect(getLlmConfig()).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key",
      model: "my-model",
      contextWindow: DEFAULT_LLM_CONTEXT_WINDOW,
    });
    expect(llmConfigured()).toBe(true);
  });

  it("falls back to legacy OPENROUTER_* / DEFAULT_MODEL_ID", () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_CONTEXT_WINDOW;
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-legacy";
    process.env.DEFAULT_MODEL_ID = "anthropic/claude-opus-4.8";
    const cfg = getLlmConfig();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKey).toBe("sk-or-legacy");
    expect(cfg.model).toBe("anthropic/claude-opus-4.8");
    expect(cfg.contextWindow).toBe(DEFAULT_LLM_CONTEXT_WINDOW);
  });

  it("builds a model against the configured base URL", () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.2";
    delete process.env.LLM_CONTEXT_WINDOW;
    const m = buildConfiguredModel();
    expect(m.id).toBe("llama3.2");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("openrouter");
    expect(m.contextWindow).toBe(DEFAULT_LLM_CONTEXT_WINDOW);
  });

  it("uses LLM_CONTEXT_WINDOW when set", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-4o";
    process.env.LLM_CONTEXT_WINDOW = "200000";
    const m = buildConfiguredModel();
    expect(m.contextWindow).toBe(200_000);
    expect(getLlmConfig().contextWindow).toBe(200_000);
  });

  it("parseContextWindow defaults to 1M and accepts underscores", () => {
    expect(parseContextWindow(undefined)).toBe(1_000_000);
    expect(parseContextWindow("")).toBe(1_000_000);
    expect(parseContextWindow("not-a-number")).toBe(1_000_000);
    expect(parseContextWindow("0")).toBe(1_000_000);
    expect(parseContextWindow("-1")).toBe(1_000_000);
    expect(parseContextWindow("128_000")).toBe(128_000);
    expect(parseContextWindow("1048576")).toBe(1_048_576);
  });

  it("resolveModel uses the configured endpoint and strips legacy prefixes", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-4o";
    // registry is unused for custom endpoints
    const registry = {} as never;
    const m = resolveModel("openrouter/gpt-4o-mini", registry);
    expect(m.id).toBe("gpt-4o-mini");
    expect(m.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("llmConfigured is false without base URL or model", () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.DEFAULT_MODEL_ID;
    expect(llmConfigured()).toBe(false);
  });

  it("llmMultimodal defaults to false and accepts true/1/yes/on", () => {
    delete process.env.LLM_MULTIMODAL;
    expect(llmMultimodal()).toBe(false);
    for (const v of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.LLM_MULTIMODAL = v;
      expect(llmMultimodal()).toBe(true);
    }
    for (const v of ["false", "0", "no", "", "maybe"]) {
      process.env.LLM_MULTIMODAL = v;
      expect(llmMultimodal()).toBe(false);
    }
  });

  it("model input is text-only by default and includes image when multimodal", () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "text-model";
    delete process.env.LLM_MULTIMODAL;
    expect(buildConfiguredModel().input).toEqual(["text"]);
    process.env.LLM_MULTIMODAL = "true";
    expect(buildConfiguredModel().input).toEqual(["text", "image"]);
  });

  it("pricing parses USD-per-1M values and feeds the model cost", () => {
    delete process.env.LLM_PRICE_INPUT;
    delete process.env.LLM_PRICE_OUTPUT;
    delete process.env.LLM_PRICE_CACHE_READ;
    expect(getLlmPricing()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    process.env.LLM_PRICE_INPUT = "0.28";
    process.env.LLM_PRICE_OUTPUT = "0.42";
    process.env.LLM_PRICE_CACHE_READ = "0.028";
    expect(getLlmPricing()).toEqual({ input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 });

    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL = "priced-model";
    const m = buildConfiguredModel();
    expect(m.cost).toEqual({ input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 });

    // Invalid values fall back to $0 rather than poisoning the ledger.
    process.env.LLM_PRICE_INPUT = "expensive?";
    process.env.LLM_PRICE_OUTPUT = "-1";
    expect(getLlmPricing().input).toBe(0);
    expect(getLlmPricing().output).toBe(0);
    process.env.LLM_PRICE_INPUT = "1,000";
    expect(getLlmPricing().input).toBe(1000);
  });
});

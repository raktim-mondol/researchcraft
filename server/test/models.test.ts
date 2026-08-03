import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfiguredModel,
  getLlmConfig,
  llmConfigured,
  resolveModel,
} from "../src/agent/models.ts";

const ENV_KEYS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
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
    expect(getLlmConfig()).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key",
      model: "my-model",
    });
    expect(llmConfigured()).toBe(true);
  });

  it("falls back to legacy OPENROUTER_* / DEFAULT_MODEL_ID", () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-legacy";
    process.env.DEFAULT_MODEL_ID = "anthropic/claude-opus-4.8";
    const cfg = getLlmConfig();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKey).toBe("sk-or-legacy");
    expect(cfg.model).toBe("anthropic/claude-opus-4.8");
  });

  it("builds a model against the configured base URL", () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "llama3.2";
    const m = buildConfiguredModel();
    expect(m.id).toBe("llama3.2");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("openrouter");
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

  it("rejects fusion model refs", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODEL = "gpt-4o";
    expect(() => resolveModel("fusion/foo", {} as never)).toThrow(/Fusion/);
  });

  it("llmConfigured is false without base URL or model", () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.DEFAULT_MODEL_ID;
    expect(llmConfigured()).toBe(false);
  });
});

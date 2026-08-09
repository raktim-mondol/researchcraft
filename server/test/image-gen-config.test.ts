import { afterEach, describe, expect, it } from "vitest";
import {
  estimateImageGenCostUsd,
  getImageGenConfig,
  imageGenConfigured,
  inferImageProvider,
  parseImageProvider,
} from "../src/agent/image-gen-config.ts";

const ENV_KEYS = [
  "IMAGE_MODEL",
  "IMAGE_PROVIDER",
  "IMAGE_BASE_URL",
  "IMAGE_API_KEY",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "GEMINI_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
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

describe("image-gen-config", () => {
  snapshotEnv();
  afterEach(() => restoreEnv());

  it("infers gemini from model ids", () => {
    expect(inferImageProvider("gemini-2.5-flash-image")).toBe("gemini");
    expect(inferImageProvider("gemini-3.1-flash-image")).toBe("gemini");
    expect(inferImageProvider("gemini-3-pro-image-preview")).toBe("gemini");
    expect(inferImageProvider("gpt-image-2")).toBe("openai");
    expect(inferImageProvider("dall-e-3")).toBe("openai");
  });

  it("parseImageProvider honors explicit override", () => {
    expect(parseImageProvider("openai", "gemini-2.5-flash-image")).toBe("openai");
    expect(parseImageProvider("gemini", "gpt-image-2")).toBe("gemini");
    expect(parseImageProvider("", "gpt-image-2")).toBe("openai");
  });

  it("imageGenConfigured is false without IMAGE_MODEL", () => {
    delete process.env.IMAGE_MODEL;
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "sk-test";
    expect(imageGenConfigured()).toBe(false);
  });

  it("openai path falls back to LLM base/key", () => {
    process.env.IMAGE_MODEL = "gpt-image-2";
    delete process.env.IMAGE_BASE_URL;
    delete process.env.IMAGE_API_KEY;
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "sk-openai";
    expect(imageGenConfigured()).toBe(true);
    const cfg = getImageGenConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.apiKey).toBe("sk-openai");
    expect(cfg.model).toBe("gpt-image-2");
  });

  it("gemini path uses GEMINI_API_KEY", () => {
    process.env.IMAGE_MODEL = "gemini-2.5-flash-image";
    delete process.env.IMAGE_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test";
    expect(imageGenConfigured()).toBe(true);
    const cfg = getImageGenConfig();
    expect(cfg.provider).toBe("gemini");
    expect(cfg.apiKey).toBe("AIza-test");
    expect(cfg.baseUrl).toContain("generativelanguage.googleapis.com");
  });

  it("gemini without key is not configured", () => {
    process.env.IMAGE_MODEL = "gemini-2.5-flash-image";
    delete process.env.IMAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(imageGenConfigured()).toBe(false);
  });

  it("estimates positive cost", () => {
    expect(estimateImageGenCostUsd({ provider: "openai", quality: "high", n: 1 })).toBeGreaterThan(0);
    expect(estimateImageGenCostUsd({ provider: "gemini", imageSize: "1K", n: 2 })).toBeGreaterThan(0);
  });
});

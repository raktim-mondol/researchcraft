import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runImageGenerate, safeUnder } from "../src/agent/image-generate-tool.ts";

const ENV_KEYS = [
  "IMAGE_MODEL",
  "IMAGE_PROVIDER",
  "IMAGE_BASE_URL",
  "IMAGE_API_KEY",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "GEMINI_API_KEY",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

describe("safeUnder", () => {
  it("rejects path traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "img-root-"));
    expect(() => safeUnder(root, "../outside.png")).toThrow(/escapes/);
  });
});

describe("runImageGenerate", () => {
  it("returns not_configured without model", async () => {
    delete process.env.IMAGE_MODEL;
    delete process.env.LLM_BASE_URL;
    const res = await runImageGenerate({
      projectId: null,
      sessionId: "",
      params: { prompt: "x", path: "figures/a.png" },
      sandboxRoot: fs.mkdtempSync(path.join(os.tmpdir(), "img-sb-")),
    });
    expect(res.details?.error).toBe("not_configured");
  });

  it("writes openai image into sandbox", async () => {
    process.env.IMAGE_MODEL = "gpt-image-2";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_API_KEY = "sk-test";
    const b64 = Buffer.from("png-bytes").toString("base64");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "img-sb-"));
    const res = await runImageGenerate({
      projectId: null,
      sessionId: "",
      params: {
        prompt: "a scientific schematic",
        path: "figures/schematic.png",
      },
      sandboxRoot: root,
    });
    expect(res.details?.path).toBe("figures/schematic.png");
    expect(fs.readFileSync(path.join(root, "figures/schematic.png")).toString()).toBe(
      "png-bytes",
    );
  });
});

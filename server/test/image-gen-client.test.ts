import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGeminiImages,
  generateImages,
} from "../src/agent/image-gen-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("extractGeminiImages", () => {
  it("finds output_image convenience field", () => {
    const png = Buffer.from("fake-png").toString("base64");
    const imgs = extractGeminiImages({
      output_image: { data: png, mime_type: "image/png" },
    });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].buffer.toString()).toBe("fake-png");
  });

  it("prefers output_image over thought interim images", () => {
    const final = Buffer.from("final").toString("base64");
    const thought = Buffer.from("thought").toString("base64");
    const imgs = extractGeminiImages({
      output_image: { data: final, mime_type: "image/png" },
      steps: [
        {
          type: "thought",
          summary: [{ type: "image", data: thought, mime_type: "image/png" }],
        },
        {
          type: "model_output",
          content: [{ type: "image", data: final, mime_type: "image/png" }],
        },
      ],
    });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].buffer.toString()).toBe("final");
  });

  it("finds generateContent inline_data", () => {
    const png = Buffer.from("bytes").toString("base64");
    const imgs = extractGeminiImages({
      candidates: [
        {
          content: {
            parts: [{ inline_data: { mime_type: "image/png", data: png } }],
          },
        },
      ],
    });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].buffer.toString()).toBe("bytes");
  });
});

describe("generateImages openai", () => {
  it("decodes b64_json", async () => {
    const b64 = Buffer.from("hello-image").toString("base64");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    const res = await generateImages({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "a schematic",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    expect(res.images).toHaveLength(1);
    expect(res.images[0].buffer.toString()).toBe("hello-image");
    expect(res.provider).toBe("openai");
  });

  it("surfaces API errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    await expect(
      generateImages({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "x",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk",
      }),
    ).rejects.toThrow(/nope/);
  });
});

describe("generateImages gemini", () => {
  it("uses interactions when it returns an image", async () => {
    const b64 = Buffer.from("gem-img").toString("base64");
    globalThis.fetch = vi.fn(async (url) => {
      expect(String(url)).toContain("/v1beta/interactions");
      return new Response(
        JSON.stringify({ output_image: { data: b64, mime_type: "image/png" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await generateImages({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      prompt: "diagram",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "AIza",
    });
    expect(res.images[0].buffer.toString()).toBe("gem-img");
    expect(res.rawNote).toBe("interactions");
  });

  it("falls back to generateContent when interactions 404s", async () => {
    const b64 = Buffer.from("fallback").toString("base64");
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/interactions")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: "image/png", data: b64 } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await generateImages({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      prompt: "diagram",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "AIza",
    });
    expect(res.images[0].buffer.toString()).toBe("fallback");
    expect(res.rawNote).toBe("generateContent");
  });
});

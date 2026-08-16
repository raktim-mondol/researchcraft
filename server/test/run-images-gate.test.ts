/**
 * HTTP-level tests for the /run image gate: with LLM_MULTIMODAL unset/false,
 * image attachments are rejected with a clear 400 BEFORE any model call;
 * with it true, the run proceeds past the gate (the request is no longer a
 * 400). The session registry is mocked so no real Pi session is needed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

class FakeSession {
  isStreaming = false;
  state = { errorMessage: null };
  async prompt(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  getSessionStats() {
    return { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  }
  getContextUsage() {
    return undefined;
  }
}

const fakeSessions = new Map<string, FakeSession>();

vi.mock("../src/agent/session-registry.ts", () => ({
  getAuthStorage: vi.fn(),
  getModelRegistry: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(async (_projectId: string, _paths: unknown, id: string) =>
    fakeSessions.get(id) ?? null,
  ),
  listSessions: vi.fn(async () => []),
  disposeSession: vi.fn(),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";

const app = await buildApp();

const IMAGE = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

beforeEach(() => {
  fakeSessions.clear();
  fakeSessions.set("s1", new FakeSession());
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  process.env.LLM_BASE_URL = "https://api.example.com/v1";
  process.env.LLM_MODEL = "test-model";
});

afterEach(() => {
  delete process.env.LLM_MULTIMODAL;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});

describe("run image gate", () => {
  it("rejects image attachments with 400 when the model is not multimodal", async () => {
    delete process.env.LLM_MULTIMODAL;
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default" },
      payload: { message: "Describe the image", images: [IMAGE] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("does not support images");
    expect(res.json().detail).toContain("Supports images (vision)");
  });

  it("rejects image attachments when LLM_MULTIMODAL is explicitly false", async () => {
    process.env.LLM_MULTIMODAL = "false";
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default" },
      payload: { message: "Describe the image", images: [IMAGE] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets image attachments past the gate when LLM_MULTIMODAL is true", async () => {
    process.env.LLM_MULTIMODAL = "true";
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default" },
      payload: { message: "Describe the image", images: [IMAGE] },
    });
    // Not the image-gate 400. (app.inject cannot fully simulate the hijacked
    // SSE socket, so the request may fail later — the gate itself passed.)
    expect(res.statusCode).not.toBe(400);
  });

  it("does not apply the gate to text-only runs", async () => {
    delete process.env.LLM_MULTIMODAL;
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/run",
      headers: { "x-project-id": "default" },
      payload: { message: "Say OK" },
    });
    expect(res.statusCode).not.toBe(400);
  });
});

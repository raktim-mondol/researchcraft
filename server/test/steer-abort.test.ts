/**
 * HTTP-level tests for the run/steer/abort endpoints. `session-registry.ts`
 * is mocked so no real dsh runtime subprocess is spawned; the fake runtime
 * exposes exactly the surface `api/sessions.ts` touches (`run`, `close`).
 *
 * `/steer`'s "409 not_streaming" gate is `activeRuns` — a Set private to
 * api/sessions.ts's module scope, populated only while a real `/run` call is
 * between its guard and its `finally`. Testing "queues into a live run"
 * therefore needs an actual in-flight `/run` request, not just a session
 * state flag: the fake runtime's `run()` returns a deferred promise the test
 * controls, so it can POST `/steer` while `/run` is still awaiting it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeRuntime {
  calls: string[] = [];
  prompts: string[] = [];
  nextRun: Deferred<unknown> | null = null;

  async run(input: unknown, opts: { onNotification?: (n: unknown) => void }) {
    this.calls.push("run");
    this.prompts.push(typeof input === "string" ? input : JSON.stringify(input));
    opts.onNotification?.({
      method: "session.event",
      params: { event: { type: "turn/start", seq: 0, time: 0, data: { turn: 1 } } },
    });
    if (this.nextRun) return this.nextRun.promise;
    return { sessionId: "dsh1", finalResponse: "", stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0 }, raw: {} };
  }
  async close() {}
}

const manifests = new Map<string, { id: string; projectId: string; createdAt: string; updatedAt: string; generations: unknown[] }>();
const runtimes = new Map<string, FakeRuntime>();
let abortCalls: { projectId: string; sessionId: string }[] = [];

function seedSession(id: string, projectId = "default"): FakeRuntime {
  manifests.set(id, { id, projectId, createdAt: "", updatedAt: "", generations: [] });
  const runtime = new FakeRuntime();
  runtimes.set(id, runtime);
  return runtime;
}

vi.mock("../src/agent/session-registry.ts", () => ({
  createSession: vi.fn((projectId: string) => {
    const id = `new-${Math.random().toString(36).slice(2)}`;
    manifests.set(id, { id, projectId, createdAt: "", updatedAt: "", generations: [] });
    return manifests.get(id);
  }),
  listSessions: vi.fn(() => []),
  getManifest: vi.fn((_paths: unknown, id: string) => manifests.get(id) ?? null),
  getOrSpawnRuntime: vi.fn(async (_projectId: string, _paths: unknown, sessionId: string) => {
    const runtime = runtimes.get(sessionId);
    if (!runtime) throw new Error(`no fake runtime seeded for ${sessionId}`);
    return { runtime, dshSessionId: "dsh1", model: "m" };
  }),
  isStale: vi.fn(() => false),
  abortSession: vi.fn(async (projectId: string, _paths: unknown, sessionId: string) => {
    abortCalls.push({ projectId, sessionId });
  }),
  disposeSession: vi.fn(),
  disposeAllSessions: vi.fn(),
  dshSessionsRoot: vi.fn(() => "/tmp/fake-dsh-sessions"),
}));

import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";

const app = await buildApp();

beforeEach(() => {
  manifests.clear();
  runtimes.clear();
  abortCalls = [];
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  process.env.LLM_BASE_URL = "http://localhost:11434/v1";
  process.env.LLM_MODEL = "test-model";
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});

function steer(id: string, body: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/steer`,
    headers: { "x-project-id": projectId, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });
}

function run(id: string, body: unknown, projectId = "default") {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/run`,
    headers: { "x-project-id": projectId, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });
}

describe("POST /sessions/:id/abort", () => {
  it("closes the live runtime", async () => {
    seedSession("s1");
    const res = await app.inject({
      method: "POST",
      url: "/sessions/s1/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: [] });
    expect(abortCalls).toEqual([{ projectId: "default", sessionId: "s1" }]);
  });

  it("is a no-op ok for an unknown session (no live runtime to close either way)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions/nope/abort",
      headers: { "x-project-id": "default" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restored: [] });
  });
});

describe("POST /sessions/:id/steer", () => {
  it("409s with reason not_streaming when no run is live", async () => {
    seedSession("s1");
    const res = await steer("s1", { message: "hi" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_streaming" });
  });

  it("400s for an empty message even while a run is live", async () => {
    const runtime = seedSession("s1");
    runtime.nextRun = deferred();
    const runPromise = run("s1", { message: "start" });
    await new Promise((r) => setTimeout(r, 20));

    const res = await steer("s1", { message: "   " });
    expect(res.statusCode).toBe(400);

    runtime.nextRun.resolve({ sessionId: "dsh1", finalResponse: "", stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0 }, raw: {} });
    await runPromise;
  });

  it("403s with reason budget when the project cap is reached, even while a run is live", async () => {
    // /run itself checks the budget once before spawning the runtime, so the
    // cap must be exceeded AFTER the run is already in flight — otherwise
    // /run's own check would reject first and there'd be no live run left
    // for /steer's separate check to reject.
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const runtime = seedSession("s1", p.id);
    runtime.nextRun = deferred();
    const runPromise = run("s1", { message: "start" }, p.id);
    await new Promise((r) => setTimeout(r, 20));

    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "s1",
      projectId: p.id,
      model: "m",
      role: "agent",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });

    const res = await steer("s1", { message: "hi" }, p.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "budget" });

    runtime.nextRun.resolve({ sessionId: "dsh1", finalResponse: "", stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0 }, raw: {} });
    await runPromise;
  });

  it("queues the message into the same live runtime while a run is in flight", async () => {
    // The real HarnessRuntime.run() delivers via `session/prompt` (dsh's
    // followup()) and then waits for the session to go idle — a concurrent
    // steer call does the same, and both resolve together once the (now
    // extended) turn finishes. So the fake must let both calls settle off
    // the SAME resolution rather than the test awaiting one before
    // triggering the other (which would deadlock: both calls block on
    // `nextRun`, and nothing resolves it until after both are inflight).
    const runtime = seedSession("s1");
    runtime.nextRun = deferred();

    const runPromise = run("s1", { message: "start" });
    await new Promise((r) => setTimeout(r, 20));
    const steerPromise = steer("s1", { message: "exclude sample 7" });
    await new Promise((r) => setTimeout(r, 20));

    runtime.nextRun.resolve({ sessionId: "dsh1", finalResponse: "", stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1 }, raw: {} });
    const [runRes, steerRes] = await Promise.all([runPromise, steerPromise]);

    expect(runRes.statusCode).toBe(200);
    expect(steerRes.statusCode).toBe(200);
    expect(steerRes.json()).toEqual({ ok: true, pending: [] });
    expect(runtime.prompts).toEqual(["start", "exclude sample 7"]);
  });
});

describe("POST /sessions/:id/run image validation", () => {
  it("400s for images outside the vision allowlist before any streaming", async () => {
    seedSession("s1");
    const res = await run("s1", {
      message: "what is this?",
      images: [{ data: "aGVsbG8=", mimeType: "image/tiff" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("image/tiff");
  });

  it("400s for malformed image entries", async () => {
    seedSession("s1");
    const res = await run("s1", { message: "hi", images: [{ mimeType: "image/png" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("base64");
  });
});

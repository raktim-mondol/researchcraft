/**
 * HTTP-level test for the interview tool's cross-process bridge
 * (`POST /internal/interview`) — see api/internal.ts and
 * dsh-plugins/interview-tool.mjs. Answers arrive via the existing public
 * `/sessions/:id/interview/:toolCallId` route, exactly as the real UI form
 * would post them.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildApp } from "../src/index.ts";
import { PROJECTS_ROOT } from "../src/config.ts";

const app = await buildApp();

afterAll(async () => {
  await app.close();
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
});

describe("POST /internal/interview", () => {
  it("400s when required fields are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/interview",
      headers: { "content-type": "application/json" },
      payload: { projectId: "default" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s on an invalid questions payload without registering anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/interview",
      headers: { "content-type": "application/json" },
      payload: {
        projectId: "default",
        sessionId: "s1",
        toolCallId: "call1",
        payload: { title: "t", questions: [{ id: "q", type: "single", question: "?" }] },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("holds the response open until the public answer route resolves it", async () => {
    const requestPromise = app.inject({
      method: "POST",
      url: "/internal/interview",
      headers: { "content-type": "application/json" },
      payload: {
        projectId: "default",
        sessionId: "bridge-sess",
        toolCallId: "bridge-call",
        payload: { title: "Confirm", questions: [{ id: "q1", type: "text", question: "Which file?" }] },
      },
    });

    // Give the internal route a tick to register the pending interview.
    await new Promise((r) => setTimeout(r, 20));

    const answerRes = await app.inject({
      method: "POST",
      url: "/sessions/bridge-sess/interview/bridge-call",
      headers: { "x-project-id": "default", "content-type": "application/json" },
      payload: { responses: [{ id: "q1", value: "counts.csv" }] },
    });
    expect(answerRes.statusCode).toBe(200);

    const res = await requestPromise;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: { responses: [{ id: "q1", value: "counts.csv" }] } });
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, type ProjectPaths } from "../src/projects.ts";
import { toNotebook, toShellScript } from "../src/agent/session-export.ts";
import { toHistory } from "../src/agent/session-history.ts";
import { dshSessionsRoot, type SessionManifest } from "../src/agent/session-registry.ts";
import { sessionLogPath } from "../src/agent/dsh/session-log.ts";

afterAll(() => {
  for (const id of ["export-notebook", "export-shell", "export-history", "export-cap"]) {
    fs.rmSync(path.join(PROJECTS_ROOT, id), { recursive: true, force: true });
  }
});

/**
 * Write a project's dsh-sessions manifest + one generation's JSONL transcript
 * directly at their known on-disk locations (mirrors how the old Pi-era test
 * wrote raw JSONL fixtures at a known path convention). `events` are plain
 * `{type, data}` pairs; `seq`/`time` are filled in sequentially.
 */
function writeFixtureSession(
  paths: ProjectPaths,
  sessionId: string,
  events: { type: string; data: unknown }[],
): void {
  const now = new Date().toISOString();
  const dshSessionId = `${sessionId}-gen1`;
  const manifest: SessionManifest = {
    id: sessionId,
    projectId: paths.id,
    createdAt: now,
    updatedAt: now,
    generations: [{ dshSessionId, model: "test-model", startedAt: now }],
  };
  const manifestDir = path.join(paths.kadyDir, "dsh-sessions");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, `${sessionId}.json`), JSON.stringify(manifest));

  const logFile = sessionLogPath(dshSessionsRoot(paths), paths.sandbox, dshSessionId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 0, id: dshSessionId, createdAt: Date.now(), delegationDepth: 0 });
  const lines = [header, ...events.map((e, i) => JSON.stringify({ type: e.type, seq: i, time: 1000 + i * 1000, data: e.data }))];
  fs.writeFileSync(logFile, lines.join("\n") + "\n");
}

const SANDBOX_RELATIVE_COMMAND = (sandbox: string) => `cd ${sandbox} && head counts.csv`;

function projectPaths(id: string): ProjectPaths {
  return ensureProjectExists(id);
}

/**
 * A real dsh log carries both raw `assistant/chunk` deltas (what
 * `session-history.ts`'s live-stream-shaped replay reads) AND the assembled
 * `assistant/message` per step (what `session-export.ts`'s notebook/shell
 * export reads) — this fixture includes both, faithfully mirroring what one
 * turn actually logs rather than picking whichever shape one consumer needs.
 */
function fixtureEvents(sandbox: string) {
  const bashArgs = JSON.stringify({ command: SANDBOX_RELATIVE_COMMAND(sandbox) });
  const writeArgs = JSON.stringify({ path: `${sandbox}/plot.py` });
  return [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "Analyze counts.csv" }] } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "Plan the analysis" } } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "Reading the file." } } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "call_1", name: "bash", arguments: bashArgs } },
    {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "Plan the analysis" },
            { type: "text", text: "Reading the file." },
            { type: "tool-call", id: "call_1", name: "bash", arguments: bashArgs },
          ],
        },
      },
    },
    {
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "gene,ctrl,treat" }], isError: false }],
        },
      },
    },
    {
      type: "assistant/message",
      data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "Done — 2 conditions." }] } },
    },
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "Now plot it" }] } },
    { type: "tool/call", data: { turn: 2, step: 1, callId: "call_2", name: "write", arguments: writeArgs } },
    {
      type: "assistant/message",
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: "tool-call", id: "call_2", name: "write", arguments: writeArgs }] },
      },
    },
    {
      type: "tool/result",
      data: {
        turn: 2,
        step: 1,
        message: {
          content: [{ type: "tool-result", toolCallId: "call_2", content: [{ type: "text", text: "ok" }], isError: false }],
        },
      },
    },
  ];
}

describe("toNotebook", () => {
  it("includes tool outputs beneath each command", async () => {
    const paths = projectPaths("export-notebook");
    writeFixtureSession(paths, "s1", fixtureEvents(paths.sandbox));
    const md = await toNotebook(paths, "s1");
    expect(md).toContain("**Output**");
    expect(md).toContain("gene,ctrl,treat");
    expect(md).toContain("cd . && head counts.csv");
    expect(md).not.toContain(`cd ${paths.sandbox} &&`);
  });
});

describe("toShellScript", () => {
  it("replays bash commands in order", async () => {
    const paths = projectPaths("export-shell");
    writeFixtureSession(paths, "s1", fixtureEvents(paths.sandbox));
    const sh = await toShellScript(paths, "s1");
    expect(sh).toContain("cd . && head counts.csv");
    expect(sh).toContain("# [step 1]");
  });
});

describe("toHistory", () => {
  it("replays the log as user messages and assistant frame runs", async () => {
    const paths = projectPaths("export-history");
    writeFixtureSession(paths, "s1", fixtureEvents(paths.sandbox));
    const history = await toHistory(paths, "s1");

    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[0]).toMatchObject({ role: "user", content: "Analyze counts.csv" });

    const frames = history[1].frames!;
    expect(frames.map((f) => f.type)).toEqual(["thinking_delta", "text_delta", "tool_start", "tool_end"]);
    const start = frames[2];
    expect(start).toMatchObject({ toolCallId: "call_1", toolName: "bash" });
    expect((start.args as { command: string }).command).toBe("cd . && head counts.csv");
    expect(frames[3]).toMatchObject({ toolCallId: "call_1", isError: false, result: "gene,ctrl,treat" });
  });

  it("caps oversized results like the live stream does", async () => {
    const paths = projectPaths("export-cap");
    const big = "x".repeat(5000);
    writeFixtureSession(paths, "s1", [
      { type: "user/message", data: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
      {
        type: "assistant/message",
        data: { turn: 1, step: 1, message: { content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }] } },
      },
      {
        type: "tool/result",
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: big }], isError: false }] },
        },
      },
    ]);
    const history = await toHistory(paths, "s1");
    const result = history[1].frames![1].result as string;
    expect(result.length).toBe(4001);
    expect(result.endsWith("…")).toBe(true);
  });
});

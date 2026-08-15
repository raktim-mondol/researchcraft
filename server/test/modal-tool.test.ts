import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { PROJECTS_ROOT } from "../src/config.ts";
import { createProject } from "../src/projects.ts";
import { recordRun } from "../src/cost/ledger.ts";
import { runModal } from "../src/agent/modal-tool.ts";

afterEach(() => {
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
});

describe("runModal", () => {
  it("blocks with a budget message before touching the Modal SDK when the project cap is reached", async () => {
    const p = createProject({ name: "Capped", spendLimitUsd: 0.01 });
    const zero = { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 };
    recordRun({
      sessionId: "s1",
      projectId: p.id,
      model: "m",
      role: "agent",
      before: zero,
      after: { costUsd: 0.02, input: 10, output: 10, cacheRead: 0, total: 20 },
    });
    const result = await runModal(
      { command: "echo hi" },
      { projectId: p.id, sessionId: "s1", sandboxRoot: "/tmp/sb" },
    );
    expect(result.details).toMatchObject({ blocked: "budget" });
    expect(result.text).toContain("spend limit");
    fs.rmSync(`${PROJECTS_ROOT}/${p.id}`, { recursive: true, force: true });
  });

  it("reports not_configured when Modal credentials are missing", async () => {
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
    const result = await runModal(
      { command: "echo hi" },
      { projectId: "no-such-project-for-modal-test", sessionId: "s1", sandboxRoot: "/tmp/sb" },
    );
    expect(result.details).toMatchObject({ error: "not_configured" });
  });

  it("rejects an unknown compute instance id", async () => {
    process.env.MODAL_TOKEN_ID = "id";
    process.env.MODAL_TOKEN_SECRET = "secret";
    const result = await runModal(
      { command: "echo hi", instance: "not-a-real-instance" },
      { projectId: "no-such-project-for-modal-test", sessionId: "s1", sandboxRoot: "/tmp/sb" },
    );
    expect(result.details).toMatchObject({ error: "unknown_instance" });
  });
});

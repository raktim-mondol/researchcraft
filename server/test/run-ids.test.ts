import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { ensureProjectExists } from "../src/projects.ts";
import { PROJECTS_ROOT } from "../src/config.ts";
import { clearRunContext, mintRunId, readRunContext, writeRunContext } from "../src/agent/run-ids.ts";

afterAll(() => fs.rmSync(`${PROJECTS_ROOT}/run-ids-test`, { recursive: true, force: true }));

describe("run-ids", () => {
  it("mints unique ids with the run_ prefix", () => {
    const a = mintRunId();
    const b = mintRunId();
    expect(a).toMatch(/^run_/);
    expect(b).toMatch(/^run_/);
    expect(a).not.toBe(b);
  });

  it("returns null for a dsh session with no mirrored run context", () => {
    const paths = ensureProjectExists("run-ids-test");
    expect(readRunContext(paths.kadyDir, "no-such-dsh-session")).toBeNull();
  });

  it("writes and reads a run context keyed by dsh session id", () => {
    const paths = ensureProjectExists("run-ids-test");
    writeRunContext(paths, "dsh-a", { sessionId: "s1", runId: "run_x" });
    writeRunContext(paths, "dsh-b", { sessionId: "s2", runId: "run_y", computeTarget: "gpu-a100" });
    expect(readRunContext(paths.kadyDir, "dsh-a")).toEqual({ sessionId: "s1", runId: "run_x" });
    expect(readRunContext(paths.kadyDir, "dsh-b")).toEqual({ sessionId: "s2", runId: "run_y", computeTarget: "gpu-a100" });
  });

  it("clears a run context", () => {
    const paths = ensureProjectExists("run-ids-test");
    writeRunContext(paths, "dsh-c", { sessionId: "s3", runId: "run_z" });
    expect(readRunContext(paths.kadyDir, "dsh-c")).not.toBeNull();
    clearRunContext(paths, "dsh-c");
    expect(readRunContext(paths.kadyDir, "dsh-c")).toBeNull();
  });
});

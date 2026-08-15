import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  deleteProjectAgent,
  listAgents,
  listBuiltinAgents,
  restoreDefaultAgents,
  seedAgentFiles,
  setSpecialistEnabled,
  writeProjectAgent,
} from "../src/agent/agent-files.ts";
import { readPiSettings } from "../src/agent/capability-state.ts";
import { SUBAGENT_TYPES } from "../src/agent/subagents.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("specialists enable/disable", () => {
  it("disables/enables a project specialist by relocating its file", () => {
    ensureProjectExists("p1");
    const paths = resolvePaths("p1");
    writeProjectAgent(paths, "stats-reviewer", {
      description: "checks stats",
      systemPrompt: "Be rigorous.",
    });

    const before = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(before?.enabled).toBe(true);

    expect(setSpecialistEnabled(paths, "stats-reviewer", false)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "stats-reviewer.md"))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", "stats-reviewer.md"))).toBe(true);
    const disabled = listAgents(paths).find((a) => a.name === "stats-reviewer");
    expect(disabled?.enabled).toBe(false);

    expect(setSpecialistEnabled(paths, "stats-reviewer", true)).toEqual({ ok: true });
    expect(listAgents(paths).find((a) => a.name === "stats-reviewer")?.enabled).toBe(true);
  });

  // "Builtin" specialists (bundled inside the pi-subagents package) have no
  // dsh equivalent — listBuiltinAgents() always returns [] now (see its
  // updated doc comment in agent-files.ts) — so the two former tests for
  // builtin disable/shadow behavior no longer have a subject to exercise.

  it("404 for an unknown name, 400 for a bad name", () => {
    ensureProjectExists("p3");
    const paths = resolvePaths("p3");
    expect(setSpecialistEnabled(paths, "does-not-exist", false)).toMatchObject({ ok: false, status: 404 });
    expect(setSpecialistEnabled(paths, "Bad Name", false)).toMatchObject({ ok: false, status: 400 });
  });

  it("deletes a disabled agent from the disabled store, and it disappears from the roster", () => {
    ensureProjectExists("p5");
    const paths = resolvePaths("p5");
    writeProjectAgent(paths, "quiet-one", {
      description: "will be disabled then deleted",
      systemPrompt: "Be quiet.",
    });
    expect(setSpecialistEnabled(paths, "quiet-one", false)).toEqual({ ok: true });

    expect(deleteProjectAgent(paths, "quiet-one")).toBe(true);

    expect(listAgents(paths).find((a) => a.name === "quiet-one")).toBeUndefined();
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "quiet-one.md"))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", "quiet-one.md"))).toBe(false);
  });

  it("editing a disabled agent keeps it disabled", () => {
    ensureProjectExists("p6");
    const paths = resolvePaths("p6");
    writeProjectAgent(paths, "edit-me", {
      description: "original",
      systemPrompt: "Original body.",
    });
    expect(setSpecialistEnabled(paths, "edit-me", false)).toEqual({ ok: true });

    const updated = writeProjectAgent(paths, "edit-me", {
      description: "edited",
      systemPrompt: "new body",
    });
    expect(updated.description).toBe("edited");

    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents", "edit-me.md"))).toBe(false);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", "edit-me.md"))).toBe(true);

    const rows = listAgents(paths).filter((a) => a.name === "edit-me");
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].description).toBe("edited");
  });

  it("restore-defaults clears a disabled counterpart for a default agent, leaving exactly one enabled row", () => {
    ensureProjectExists("p7");
    const paths = resolvePaths("p7");
    seedAgentFiles(paths);
    const targetName = SUBAGENT_TYPES[0].name;
    expect(setSpecialistEnabled(paths, targetName, false)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", `${targetName}.md`))).toBe(true);

    restoreDefaultAgents(paths);

    const rows = listAgents(paths).filter((a) => a.name === targetName);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
    expect(fs.existsSync(path.join(paths.sandbox, ".pi", "agents-disabled", `${targetName}.md`))).toBe(false);
  });
});

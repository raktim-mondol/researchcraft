import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  BUNDLED_SKILLS_DIR,
  disableSkill,
  listProjectSkills,
  seedBundledSkills,
} from "../src/agent/skills.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("seedBundledSkills", () => {
  it("ships a remote-compute skill on disk", () => {
    expect(fs.existsSync(path.join(BUNDLED_SKILLS_DIR, "remote-compute", "SKILL.md"))).toBe(
      true,
    );
  });

  it("installs remote-compute write-if-missing", () => {
    ensureProjectExists("p-bundled");
    const paths = resolvePaths("p-bundled");
    const n = seedBundledSkills(paths);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(listProjectSkills(paths).map((s) => s.name)).toContain("remote-compute");
    // second run is a no-op
    expect(seedBundledSkills(paths)).toBe(0);
  });

  it("does not re-enable a user-disabled bundled skill", () => {
    ensureProjectExists("p-disabled");
    const paths = resolvePaths("p-disabled");
    seedBundledSkills(paths);
    expect(disableSkill(paths, "remote-compute")).toEqual({ ok: true });
    expect(seedBundledSkills(paths)).toBe(0);
    expect(listProjectSkills(paths).map((s) => s.name)).not.toContain("remote-compute");
  });
});

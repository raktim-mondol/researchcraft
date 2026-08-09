/**
 * Wiring so SUBAGENTS can call `image_generate` (Phase: text-to-image).
 *
 * Mirrors notebook-bridge:
 *  1. seedImageGeneratePackage — reference vendored kady-image-generate from
 *     sandbox/.pi/settings.json packages so child pi processes load it.
 *  2. seedBuiltinAgentImageGenerateTools — extend builtin specialist tool
 *     allowlists so pi-subagents don't strip the package tool.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectPaths } from "../projects.ts";

const require_ = createRequire(import.meta.url);

export function kadyImageGeneratePackageDir(): string {
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "kady-image-generate");
}

function isImageGenSource(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    /[/\\]kady-image-generate$/.test(entry.replace(/[/\\]+$/, ""))
  );
}

export function seedImageGeneratePackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pkgDir = kadyImageGeneratePackageDir();
  const packages = Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
  const kept = packages.filter((p) => !isImageGenSource(p) || p === pkgDir);
  if (kept.includes(pkgDir) && kept.length === packages.length) return false;
  if (!kept.includes(pkgDir)) kept.push(pkgDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

function builtinAgentsDir(): string | null {
  try {
    const pkgJson = require_.resolve("pi-subagents/package.json");
    return path.join(path.dirname(pkgJson), "agents");
  } catch {
    return null;
  }
}

function parseAgentFrontmatter(file: string): { name?: string; tools?: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const out: { name?: string; tools?: string[] } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) out.name = name[1];
    const tools = /^tools:\s*(.+?)\s*$/.exec(line);
    if (tools) {
      out.tools = tools[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/**
 * Ensure builtin specialists that pin `tools:` also allow `image_generate`.
 * Leaves user overrides that already set tools untouched.
 */
export function seedBuiltinAgentImageGenerateTools(paths: ProjectPaths): boolean {
  const agentsDir = builtinAgentsDir();
  if (!agentsDir) return false;
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const subagents =
    settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
      ? (settings.subagents as Record<string, unknown>)
      : {};
  const overrides =
    subagents.agentOverrides &&
    typeof subagents.agentOverrides === "object" &&
    !Array.isArray(subagents.agentOverrides)
      ? (subagents.agentOverrides as Record<string, unknown>)
      : {};

  let changed = false;
  for (const file of files) {
    const { name, tools } = parseAgentFrontmatter(path.join(agentsDir, file));
    if (!name || !tools?.length || tools.includes("image_generate")) continue;
    const existing = overrides[name];
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      continue;
    }
    const override = (existing ?? {}) as Record<string, unknown>;
    // If user already pinned tools without image_generate, still extend only when
    // our previous seed already put tools there (array includes notebook etc.).
    // If "tools" is a user-only pin we leave it — same as notebook: skip if tools key exists
    // UNLESS it looks like our seed (has notebook but not image_generate).
    if ("tools" in override) {
      const t = override.tools;
      if (Array.isArray(t) && t.every((x) => typeof x === "string") && !t.includes("image_generate")) {
        overrides[name] = { ...override, tools: [...t, "image_generate"] };
        changed = true;
      }
      continue;
    }
    overrides[name] = { ...override, tools: [...tools, "image_generate"] };
    changed = true;
  }
  if (!changed) return false;
  subagents.agentOverrides = overrides;
  settings.subagents = subagents;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}

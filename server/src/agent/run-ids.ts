/**
 * Run-context bridge for tools running inside the dsh runtime SUBPROCESS.
 *
 * `/sessions/:id/run` mints one run id per invocation and, once it knows the
 * live dsh session id (after `getOrSpawnRuntime` resolves), mirrors it — plus
 * the ResearchCraft session id and any selected Modal compute target — to a
 * small JSON file keyed by dsh session id. The notebook and modal_run tools
 * run in a SEPARATE OS process from this one (the dsh runtime subprocess),
 * so they cannot read this module's state directly the way Pi's in-process
 * tools once did; they read the mirrored file instead, keyed by their own
 * `exec.agent.session.id` (the one thing they know about themselves without
 * any ResearchCraft-specific plumbing). See `dsh-plugins/notebook-tool.mjs`
 * and `dsh-plugins/modal-tool.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectPaths } from "../projects.ts";

/** Mint a unique id for one POST /sessions/:id/run invocation. */
export function mintRunId(): string {
  return `run_${randomUUID()}`;
}

export interface RunContext {
  /** The ResearchCraft session id (the notebook store's filename key) — not derivable from the dsh session id alone. */
  sessionId: string;
  runId: string;
  /** Selected default Modal compute instance id for this run, if any. */
  computeTarget?: string;
}

function runContextPath(kadyDir: string, dshSessionId: string): string {
  return path.join(kadyDir, "run-context", `${dshSessionId}.json`);
}

/** Mirror the live run context for one dsh session. Call once the runtime's dsh session id is known. */
export function writeRunContext(paths: ProjectPaths, dshSessionId: string, ctx: RunContext): void {
  const file = runContextPath(paths.kadyDir, dshSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ctx));
}

/** Clear a dsh session's run context (call in the run handler's `finally`). */
export function clearRunContext(paths: ProjectPaths, dshSessionId: string): void {
  try {
    fs.unlinkSync(runContextPath(paths.kadyDir, dshSessionId));
  } catch {
    /* already gone */
  }
}

/**
 * Subprocess-side read. Takes `kadyDir` directly (not `ProjectPaths`) since
 * the dsh-plugins `.mjs` tools that call this receive it as plain composed
 * config, not a `ProjectPaths` object.
 */
export function readRunContext(kadyDir: string, dshSessionId: string): RunContext | null {
  try {
    return JSON.parse(fs.readFileSync(runContextPath(kadyDir, dshSessionId), "utf8")) as RunContext;
  } catch {
    return null;
  }
}

/**
 * Native `modal_run` tool: run a command/script on a remote Modal Sandbox
 * (CPU or GPU) the user has chosen, then bring results back.
 *
 * This is the "agent-driven offload" model: the Pi agent loop stays local and
 * the local project sandbox stays the canonical filesystem. When the agent
 * needs heavy or GPU compute it calls `modal_run`, which:
 *   1. spins an isolated Modal Sandbox on the selected instance (BYOK creds —
 *      MODAL_TOKEN_ID / MODAL_TOKEN_SECRET, passed per-client),
 *   2. optionally builds a custom image (extra pip/apt packages),
 *   3. uploads `files_in` (sandbox-relative) into the remote /workspace,
 *   4. runs the command, capturing stdout/stderr/exit code,
 *   5. downloads `files_out` back into the local project sandbox,
 *   6. meters wall-time × the instance's hourly rate as a `compute` cost row,
 *   7. terminates the sandbox.
 *
 * Built as an in-process custom tool (mirrors interview.ts) — it is available
 * to the main agent session. Child `pi` subagent processes do not get it (they
 * load tools the project-settings way); extending it to subagents would mean
 * promoting this to a Pi package bridge (see web-access-bridge.ts).
 *
 * Note: `ollama/*` models run on the local daemon and are unaffected — Modal
 * offload is for compute steps, not for relocating the model loop. No secrets
 * are injected into the remote sandbox by default (the user's model key is not
 * forwarded); a future revision can add an explicit per-call secret allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { ModalClient, type Sandbox } from "modal";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import { isBudgetExceeded, recordModalRun } from "../cost/ledger.ts";
import {
  DEFAULT_INSTANCE_ID,
  MODAL_INSTANCE_IDS,
  resolveInstance,
} from "./modal-instances.ts";

const APP_NAME = "researchcraft";
const WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
/** Cap each stream in the tool result so a chatty job can't blow the context. */
const MAX_OUTPUT_CHARS = 16000;

// Per-session default compute instance, stashed by the /run handler before a
// run (mirrors fusion-bridge's setFusionConfig). Module-level because the tool
// is constructed before the session exists and reads the live value by id.
// `null` means no Modal default selected ("local") — the tool then falls back
// to DEFAULT_INSTANCE_ID when the agent doesn't name an instance.
const sessionComputeTargets = new Map<string, string | null>();

/** Stash (or clear, with `null`/"local") the default compute instance for a session. */
export function setSessionComputeTarget(sessionId: string, instanceId: string | null): void {
  sessionComputeTargets.set(sessionId, instanceId && instanceId !== "local" ? instanceId : null);
}

export const ModalRunParams = Type.Object({
  command: Type.String({
    description: "Shell command to run remotely (executed via `sh -lc` in /workspace), e.g. \"python train.py --epochs 50\".",
  }),
  instance: Type.Optional(
    Type.String({
      description: `Compute instance id. One of: ${MODAL_INSTANCE_IDS.join(", ")}. Omit to use the session's selected default (else "${DEFAULT_INSTANCE_ID}").`,
    }),
  ),
  image: Type.Optional(
    Type.Object({
      base: Type.Optional(
        Type.String({ description: "Base registry image (default python:3.13-slim). e.g. \"pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime\"." }),
      ),
      pip: Type.Optional(Type.Array(Type.String(), { description: "pip packages to install into the image" })),
      apt: Type.Optional(Type.Array(Type.String(), { description: "apt packages to install into the image" })),
    }),
  ),
  files_in: Type.Optional(
    Type.Array(Type.String(), {
      description: "Sandbox-relative paths to upload into the remote /workspace before running.",
    }),
  ),
  files_out: Type.Optional(
    Type.Array(Type.String(), {
      description: "Sandbox-relative paths produced by the job to download back into the local project after it finishes.",
    }),
  ),
  timeout_sec: Type.Optional(
    Type.Number({ description: `Max seconds before the sandbox is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).` }),
  ),
});
export type ModalRunParamsT = Static<typeof ModalRunParams>;

/** Resolve a sandbox-relative path against the project sandbox, refusing traversal. */
function safeUnder(sandboxRoot: string, rel: string): string {
  const target = path.resolve(sandboxRoot, rel);
  if (!isWithin(sandboxRoot, target)) {
    throw new Error(`Path escapes the project sandbox: ${rel}`);
  }
  return target;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `…(${s.length - MAX_OUTPUT_CHARS} earlier chars truncated)\n${s.slice(-MAX_OUTPUT_CHARS)}`;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

// TODO(#20): port to a real dsh tool (raw Cordis plugin, same local-file-row
// pattern as `dsh-plugins/persona-subagents.mjs`). The `execute()` body above
// this point (Modal SDK calls, file staging, cost recording via
// `recordModalRun`) is pure Node logic with no Pi dependency and moves over
// directly. `sessionComputeTargets` has the same cross-process problem as
// `run-ids.ts`'s map (see notebook.ts's TODO): it's set from the MAIN process
// by `/sessions/:id/run` but would need reading from inside the dsh runtime
// SUBPROCESS — needs the same file-mirror-keyed-by-dsh-session-id fix before
// `params.instance ?? sessionComputeTargets.get(sessionId)` can work there.

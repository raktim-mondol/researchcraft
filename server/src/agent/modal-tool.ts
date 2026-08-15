/**
 * Core logic for the `modal_run` tool: run a command/script on a remote
 * Modal Sandbox (CPU or GPU) the user has chosen, then bring results back.
 *
 * This is the "agent-driven offload" model: the agent loop stays local and
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
 * `runModal` is plain, framework-agnostic Node logic — no Pi or dsh types —
 * so it can be called directly from `dsh-plugins/modal-tool.mjs`, which runs
 * inside the dsh runtime SUBPROCESS (a separate OS process from this one) and
 * wires it to `defineTool()`. That plugin resolves `sessionId`/`runId` via
 * `run-ids.ts`'s file-mirrored run context (see that module's header) rather
 * than any in-process state, since none of this module's state is visible
 * from the subprocess.
 *
 * Note: `ollama/*` models run on the local daemon and are unaffected — Modal
 * offload is for compute steps, not for relocating the model loop. No secrets
 * are injected into the remote sandbox by default (the user's model key is not
 * forwarded); a future revision can add an explicit per-call secret allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { ModalClient, type Sandbox } from "modal";
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

export { DEFAULT_INSTANCE_ID, MODAL_INSTANCE_IDS };

export interface ModalRunArgs {
  command: string;
  instance?: string;
  image?: { base?: string; pip?: string[]; apt?: string[] };
  files_in?: string[];
  files_out?: string[];
  timeout_sec?: number;
}

export interface ModalRunContext {
  projectId: string;
  sessionId: string;
  sandboxRoot: string;
  /** The session's selected default compute instance ("local"/unset = none). */
  computeTarget?: string;
  signal?: AbortSignal;
}

export interface ModalRunResult {
  text: string;
  details: Record<string, unknown>;
}

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

export async function runModal(args: ModalRunArgs, ctx: ModalRunContext): Promise<ModalRunResult> {
  const budget = isBudgetExceeded(ctx.projectId);
  if (budget.exceeded) {
    return {
      text: `Modal run blocked: the project has reached its spend limit ` +
        `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
        `Finish without remote compute or ask the user to raise the limit.`,
      details: { blocked: "budget" },
    };
  }

  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    return {
      text: "Modal is not configured. Add MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings → API keys (get them at https://modal.com/settings).",
      details: { error: "not_configured" },
    };
  }

  const instanceId = args.instance ?? ctx.computeTarget ?? DEFAULT_INSTANCE_ID;
  const spec = resolveInstance(instanceId);
  if (!spec) {
    return {
      text: `Unknown compute instance "${instanceId}". Valid instances: ${MODAL_INSTANCE_IDS.join(", ")}.`,
      details: { error: "unknown_instance" },
    };
  }

  const sandboxRoot = ctx.sandboxRoot;
  const timeoutMs =
    Math.min(Math.max(Math.floor(args.timeout_sec ?? DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S) * 1000;

  const modal = new ModalClient({ tokenId, tokenSecret });
  const startedAt = Date.now();
  let sb: Sandbox | null = null;
  const onAbort = () => {
    sb?.terminate().catch(() => {});
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });

    let image = modal.images.fromRegistry(args.image?.base ?? spec.defaultImage);
    const dockerCmds: string[] = [];
    if (args.image?.apt?.length) {
      dockerCmds.push(
        `RUN apt-get update && apt-get install -y ${args.image.apt.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      );
    }
    if (args.image?.pip?.length) {
      dockerCmds.push(`RUN pip install --no-cache-dir ${args.image.pip.join(" ")}`);
    }
    if (dockerCmds.length) image = image.dockerfileCommands(dockerCmds);

    sb = await modal.sandboxes.create(app, image, {
      gpu: spec.gpu ?? undefined,
      cpu: spec.cpu,
      memoryMiB: spec.memoryMiB,
      timeoutMs,
    });
    await sb.filesystem.makeDirectory(WORKDIR, { createParents: true });

    // Stage inputs.
    const stagedIn: string[] = [];
    const missingIn: string[] = [];
    for (const rel of args.files_in ?? []) {
      const local = safeUnder(sandboxRoot, rel);
      if (!fs.existsSync(local)) {
        missingIn.push(rel);
        continue;
      }
      const remote = path.posix.join(WORKDIR, rel);
      const remoteDir = path.posix.dirname(remote);
      if (remoteDir && remoteDir !== WORKDIR) {
        await sb.filesystem.makeDirectory(remoteDir, { createParents: true });
      }
      await sb.filesystem.copyFromLocal(local, remote);
      stagedIn.push(rel);
    }

    // Run.
    const proc = await sb.exec(["sh", "-lc", args.command], {
      stdout: "pipe",
      stderr: "pipe",
      workdir: WORKDIR,
      timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([
      proc.stdout.readText(),
      proc.stderr.readText(),
    ]);
    const exitCode = await proc.wait();

    // Collect outputs.
    const collectedOut: string[] = [];
    const missingOut: string[] = [];
    for (const rel of args.files_out ?? []) {
      const local = safeUnder(sandboxRoot, rel);
      const remote = path.posix.join(WORKDIR, rel);
      try {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        await sb.filesystem.copyToLocal(remote, local);
        collectedOut.push(rel);
      } catch {
        missingOut.push(rel);
      }
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = (durationMs / 3_600_000) * spec.pricePerHour;
    recordModalRun(ctx.projectId, ctx.sessionId, costUsd, `modal:${spec.id}`);

    const summary = {
      instance: spec.id,
      gpu: spec.gpu,
      exit_code: exitCode,
      duration_ms: durationMs,
      cost_usd: Number(costUsd.toFixed(4)),
      ...(stagedIn.length ? { files_in: stagedIn } : {}),
      ...(missingIn.length ? { files_in_missing: missingIn } : {}),
      files_out: collectedOut,
      ...(missingOut.length ? { files_out_missing: missingOut } : {}),
    };
    const text =
      `${JSON.stringify(summary, null, 2)}\n\n` +
      `--- stdout ---\n${truncate(stdout) || "(empty)"}\n\n` +
      `--- stderr ---\n${truncate(stderr) || "(empty)"}`;
    return { text, details: summary };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      text: `Modal run failed on instance "${spec.id}": ${msg}\n` +
        `If this is an authentication error, check MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in Settings.`,
      details: { error: "modal_failure", instance: spec.id },
    };
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    if (sb) await sb.terminate().catch(() => {});
    modal.close();
  }
}

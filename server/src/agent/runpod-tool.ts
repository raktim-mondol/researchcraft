/**
 * Native `runpod_run` tool: run a command/script on an ephemeral Runpod Pod
 * (CPU or GPU) the user has chosen, then bring results back.
 *
 * Mirrors `modal_run`: the Pi agent loop stays local and the project sandbox
 * stays the canonical filesystem. When the agent needs heavy or GPU compute it
 * calls `runpod_run`, which:
 *   1. spins an isolated Runpod Pod on the selected instance (BYOK —
 *      RUNPOD_API_KEY),
 *   2. injects an ephemeral SSH key (PUBLIC_KEY) for file transfer + exec,
 *   3. uploads `files_in` (sandbox-relative) into the remote /workspace,
 *   4. runs the command, capturing stdout/stderr/exit code,
 *   5. downloads `files_out` back into the local project sandbox,
 *   6. meters wall-time × the instance's hourly rate as a `compute` cost row,
 *   7. terminates the pod.
 *
 * In-process custom tool (like modal/interview) — available to the lead agent
 * only; child `pi` subagent processes do not get it.
 */
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolvePaths } from "../projects.ts";
import { isWithin } from "../sandbox-fs.ts";
import { isBudgetExceeded, recordRunpodRun } from "../cost/ledger.ts";
import {
  DEFAULT_RUNPOD_INSTANCE_ID,
  RUNPOD_INSTANCE_IDS,
  resolveRunpodInstance,
} from "./runpod-instances.ts";
import {
  createPod,
  deletePod,
  ephemeralPodName,
  makeEphemeralSshKey,
  scpDownload,
  scpUpload,
  sshExec,
  waitForPodSsh,
  type EphemeralKeyPair,
} from "./runpod-client.ts";

const WORKDIR = "/workspace";
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
/** Max seconds to wait for the pod to become SSH-reachable. */
const PROVISION_TIMEOUT_S = 300;
const MAX_OUTPUT_CHARS = 16000;

// Per-session default Runpod instance, stashed by the /run handler.
// `null` means no Runpod default selected.
const sessionRunpodTargets = new Map<string, string | null>();

/** Stash (or clear) the default Runpod compute instance for a session. */
export function setSessionRunpodComputeTarget(
  sessionId: string,
  instanceId: string | null,
): void {
  if (!instanceId || instanceId === "local") {
    sessionRunpodTargets.set(sessionId, null);
    return;
  }
  const bare = instanceId.startsWith("runpod:")
    ? instanceId.slice("runpod:".length)
    : instanceId;
  sessionRunpodTargets.set(sessionId, bare);
}

export const RunpodRunParams = Type.Object({
  command: Type.String({
    description:
      'Shell command to run remotely (executed via `bash -lc` in /workspace), e.g. "python train.py --epochs 50".',
  }),
  instance: Type.Optional(
    Type.String({
      description: `Runpod instance id. One of: ${RUNPOD_INSTANCE_IDS.join(", ")}. Omit to use the session's selected default (else "${DEFAULT_RUNPOD_INSTANCE_ID}").`,
    }),
  ),
  image: Type.Optional(
    Type.String({
      description:
        'Docker image to run (default is instance-specific, usually a Runpod PyTorch CUDA image). e.g. "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04".',
    }),
  ),
  files_in: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative paths to upload into the remote /workspace before running.",
    }),
  ),
  files_out: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative paths produced by the job to download back into the local project after it finishes.",
    }),
  ),
  timeout_sec: Type.Optional(
    Type.Number({
      description: `Max seconds for the remote command (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Pod provision has a separate ${PROVISION_TIMEOUT_S}s cap.`,
    }),
  ),
  cloud_type: Type.Optional(
    Type.String({
      description: 'Runpod cloud tier: "SECURE" or "COMMUNITY" (default COMMUNITY).',
    }),
  ),
});
export type RunpodRunParamsT = Static<typeof RunpodRunParams>;

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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `runpod_run` ToolDefinition for one project session.
 */
export function makeRunpodTool(
  projectId: string,
  getSessionId: () => string,
): ToolDefinition<typeof RunpodRunParams> {
  return {
    name: "runpod_run",
    label: "Runpod compute",
    description: [
      "Run a command or script on an ephemeral Runpod Pod (on-demand CPU or GPU) and get the result back.",
      "Use for heavy or GPU work that shouldn't run on the local machine: model training/fine-tuning, GPU inference, large scientific simulations, or dataset experiments the local sandbox can't handle.",
      "The remote pod is ephemeral and isolated. Upload inputs with `files_in` (sandbox-relative) and name expected outputs in `files_out` — they are copied back into the local project sandbox so your other tools (read/edit/bash) can use them. The local sandbox remains the source of truth.",
      "Pick an `instance` by GPU need (omit to use the session's selected compute target). Optionally override `image` for a custom CUDA/framework base.",
      "Cost is estimated by wall-clock time on the chosen instance and counts toward the project budget, so keep jobs scoped. Always terminates the pod when done.",
      "Requires RUNPOD_API_KEY in Settings → API keys (https://console.runpod.io/user/settings).",
    ].join("\n"),
    promptSnippet:
      "runpod_run: run a command/script on an ephemeral Runpod GPU/CPU pod and copy results back",
    parameters: RunpodRunParams,
    execute: async (_toolCallId, params, signal) => {
      const sessionId = getSessionId();

      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        return textResult(
          `Runpod run blocked: the project has reached its spend limit ` +
            `($${budget.totalUsd.toFixed(2)} / $${(budget.limitUsd ?? 0).toFixed(2)}). ` +
            `Finish without remote compute or ask the user to raise the limit.`,
          { blocked: "budget" },
        );
      }

      const key = process.env.RUNPOD_API_KEY?.trim();
      if (!key) {
        return textResult(
          "Runpod is not configured. Add RUNPOD_API_KEY in Settings → API keys " +
            "(get one at https://console.runpod.io/user/settings).",
          { error: "not_configured" },
        );
      }

      const instanceId =
        params.instance ??
        sessionRunpodTargets.get(sessionId) ??
        DEFAULT_RUNPOD_INSTANCE_ID;
      const spec = resolveRunpodInstance(instanceId);
      if (!spec) {
        return textResult(
          `Unknown Runpod instance "${instanceId}". Valid instances: ${RUNPOD_INSTANCE_IDS.join(", ")}.`,
          { error: "unknown_instance" },
        );
      }

      const sandboxRoot = resolvePaths(projectId).sandbox;
      const timeoutSec = Math.min(
        Math.max(Math.floor(params.timeout_sec ?? DEFAULT_TIMEOUT_S), 1),
        MAX_TIMEOUT_S,
      );
      const timeoutMs = timeoutSec * 1000;
      const cloudType =
        params.cloud_type?.toUpperCase() === "SECURE" ? "SECURE" : "COMMUNITY";
      const imageName = params.image?.trim() || spec.defaultImage;

      let keys: EphemeralKeyPair | null = null;
      let podId: string | null = null;
      const startedAt = Date.now();

      const terminate = async () => {
        if (podId) {
          const id = podId;
          podId = null;
          await deletePod(id).catch(() => {});
        }
        keys?.cleanup();
        keys = null;
      };

      const onAbort = () => {
        void terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        keys = makeEphemeralSshKey();

        const createBody: Record<string, unknown> = {
          name: ephemeralPodName(),
          imageName,
          containerDiskInGb: spec.containerDiskInGb,
          volumeInGb: 0,
          ports: ["22/tcp"],
          env: {
            PUBLIC_KEY: keys.publicKeyOpenSsh,
          },
          cloudType,
          supportPublicIp: true,
        };
        if (spec.gpuTypeId) {
          createBody.gpuTypeIds = [spec.gpuTypeId];
          createBody.gpuCount = spec.gpuCount || 1;
          createBody.computeType = "GPU";
        } else {
          createBody.computeType = "CPU";
          // Lightweight CPU flavor; Runpod picks a matching host.
          createBody.cpuFlavorIds = ["cpu3c-2-4"];
        }

        const created = await createPod(createBody);
        podId = created.id;
        if (!podId) {
          throw new Error("Runpod create-pod returned no pod id");
        }

        const { ssh } = await waitForPodSsh(podId, {
          timeoutMs: PROVISION_TIMEOUT_S * 1000,
          signal,
        });

        // Ensure workspace + optional pip deps aren't auto-installed here —
        // the agent should put installs in `command` when needed.
        await sshExec(keys.privateKeyPath, ssh, `mkdir -p ${WORKDIR}`, {
          timeoutMs: 60_000,
          signal,
          retries: 15,
        });

        const stagedIn: string[] = [];
        const missingIn: string[] = [];
        for (const rel of params.files_in ?? []) {
          const local = safeUnder(sandboxRoot, rel);
          if (!fs.existsSync(local)) {
            missingIn.push(rel);
            continue;
          }
          if (fs.statSync(local).isDirectory()) {
            // Recursively tar-pipe directories for simplicity and fidelity.
            const remote = path.posix.join(WORKDIR, rel);
            await sshExec(
              keys.privateKeyPath,
              ssh,
              `mkdir -p ${shellQuote(path.posix.dirname(remote))}`,
              { timeoutMs: 60_000, signal },
            );
            // scp -r
            await scpUpload(
              keys.privateKeyPath,
              ssh,
              local,
              remote,
              { signal },
            ).catch(async () => {
              // Fallback: tar over ssh when scp -r of dirs is finicky.
              await tarUploadDir(keys!.privateKeyPath, ssh, local, remote, signal);
            });
            stagedIn.push(rel);
            continue;
          }
          const remote = path.posix.join(WORKDIR, rel);
          const remoteDir = path.posix.dirname(remote);
          if (remoteDir && remoteDir !== ".") {
            await sshExec(
              keys.privateKeyPath,
              ssh,
              `mkdir -p ${shellQuote(remoteDir)}`,
              { timeoutMs: 60_000, signal },
            );
          }
          await scpUpload(keys.privateKeyPath, ssh, local, remote, { signal });
          stagedIn.push(rel);
        }

        const remoteCmd = `cd ${WORKDIR} && bash -lc ${shellQuote(params.command)}`;
        const result = await sshExec(keys.privateKeyPath, ssh, remoteCmd, {
          timeoutMs,
          signal,
          retries: 2,
        });

        const collectedOut: string[] = [];
        const missingOut: string[] = [];
        for (const rel of params.files_out ?? []) {
          const local = safeUnder(sandboxRoot, rel);
          const remote = path.posix.join(WORKDIR, rel);
          try {
            fs.mkdirSync(path.dirname(local), { recursive: true });
            await scpDownload(keys.privateKeyPath, ssh, remote, local, { signal });
            collectedOut.push(rel);
          } catch {
            missingOut.push(rel);
          }
        }

        const durationMs = Date.now() - startedAt;
        const costUsd = (durationMs / 3_600_000) * spec.pricePerHour;
        recordRunpodRun(projectId, sessionId, costUsd, `runpod:${spec.id}`);

        const summary = {
          provider: "runpod",
          pod_id: podId,
          instance: spec.id,
          gpu: spec.gpuTypeId,
          image: imageName,
          cloud_type: cloudType,
          exit_code: result.exitCode,
          duration_ms: durationMs,
          cost_usd: Number(costUsd.toFixed(4)),
          ...(stagedIn.length ? { files_in: stagedIn } : {}),
          ...(missingIn.length ? { files_in_missing: missingIn } : {}),
          files_out: collectedOut,
          ...(missingOut.length ? { files_out_missing: missingOut } : {}),
        };
        const text =
          `${JSON.stringify(summary, null, 2)}\n\n` +
          `--- stdout ---\n${truncate(result.stdout) || "(empty)"}\n\n` +
          `--- stderr ---\n${truncate(result.stderr) || "(empty)"}`;
        return textResult(text, summary);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return textResult(
          `Runpod run failed on instance "${spec.id}"` +
            (podId ? ` (pod ${podId})` : "") +
            `: ${msg}\n` +
            `If this is an authentication error, check RUNPOD_API_KEY in Settings. ` +
            `If the GPU is out of stock, try another instance or cloud_type SECURE.`,
          { error: "runpod_failure", instance: spec.id, pod_id: podId },
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await terminate();
      }
    },
  };
}

/** Tar a local directory and extract it on the remote host at `remoteDir`. */
async function tarUploadDir(
  keyPath: string,
  ssh: { host: string; port: number },
  localDir: string,
  remoteDir: string,
  signal?: AbortSignal,
): Promise<void> {
  // Use ssh with a tar pipe: tar czf - -C parent basename | ssh tar xzf - -C destParent
  const parent = path.dirname(localDir);
  const base = path.basename(localDir);
  const remoteParent = path.posix.dirname(remoteDir);
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["czf", "-", "-C", parent, base], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const remote = spawn(
      "ssh",
      [
        "-i",
        keyPath,
        "-p",
        String(ssh.port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        `root@${ssh.host}`,
        `mkdir -p ${shellQuote(remoteParent)} && tar xzf - -C ${shellQuote(remoteParent)}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    tar.stdout.pipe(remote.stdin);
    let err = "";
    tar.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    remote.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const onAbort = () => {
      tar.kill("SIGTERM");
      remote.kill("SIGTERM");
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    remote.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`tar-ssh upload failed: ${err.trim() || code}`));
    });
    tar.on("error", reject);
    remote.on("error", reject);
  });
}

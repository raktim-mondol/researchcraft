/**
 * Native `modal_run` tool: wires the framework-agnostic `runModal()` core
 * (`../modal-tool.ts` — Modal SDK calls, file staging, cost recording) to
 * dsh's `defineTool()`. Raw Cordis plugin, same local-file-row pattern as
 * `persona-subagents.mjs`.
 *
 * `sessionId` and the session's selected compute target aren't available
 * in-process here (this runs in the dsh runtime SUBPROCESS, a separate OS
 * process from the main Fastify server that knows them) — resolved via
 * `run-ids.ts`'s file-mirrored run context instead, same as notebook-tool.mjs.
 *
 * @module researchcraft/modal-tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_INSTANCE_ID, MODAL_INSTANCE_IDS, runModal } from "../modal-tool.ts";
import { readRunContext } from "../run-ids.ts";

export const name = "researchcraft-modal-tool";
export const inject = ["tools"];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ projectId: string, kadyDir: string, sandboxRoot: string }} config
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "modal_run",
    description: [
      "Run a command or script on a remote Modal Sandbox (on-demand CPU or GPU) and get the result back.",
      "Use for heavy or GPU work that shouldn't run on the local machine: model training/fine-tuning, GPU inference, large simulations, or compute the local sandbox can't handle.",
      "The remote sandbox is ephemeral and isolated. Upload inputs with `files_in` (sandbox-relative) and name expected outputs in `files_out` — they are copied back into the local project sandbox so your other tools (read/edit/bash) can use them. The local sandbox remains the source of truth.",
      "Pick an `instance` by GPU need (omit to use the session's selected compute target). Add `image.pip`/`image.apt` for dependencies, or set `image.base` for a CUDA/framework base image.",
      "Cost is billed by wall-clock time on the chosen instance and counts toward the project budget, so keep jobs scoped.",
    ].join("\n"),
    parameters: {
      command: {
        type: "string",
        required: true,
        description: 'Shell command to run remotely (executed via `sh -lc` in /workspace), e.g. "python train.py --epochs 50".',
      },
      instance: {
        type: "string",
        description: `Compute instance id. One of: ${MODAL_INSTANCE_IDS.join(", ")}. Omit to use the session's selected default (else "${DEFAULT_INSTANCE_ID}").`,
      },
      image: {
        type: "object",
        properties: {
          base: { type: "string", description: 'Base registry image (default python:3.13-slim). e.g. "pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime".' },
          pip: { type: "array", items: { type: "string" }, description: "pip packages to install into the image" },
          apt: { type: "array", items: { type: "string" }, description: "apt packages to install into the image" },
        },
      },
      files_in: {
        type: "array",
        items: { type: "string" },
        description: "Sandbox-relative paths to upload into the remote /workspace before running.",
      },
      files_out: {
        type: "array",
        items: { type: "string" },
        description: "Sandbox-relative paths produced by the job to download back into the local project after it finishes.",
      },
      timeout_sec: {
        type: "number",
        description: "Max seconds before the sandbox is killed (default 600, max 3600).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          report: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("modal_run requires a calling agent (exec.agent was undefined)");
      const run = readRunContext(config.kadyDir, String(exec.agent.id));
      if (!run) {
        return { report: "modal_run could not resolve the live session context; try again." };
      }
      const result = await runModal(args, {
        projectId: config.projectId,
        sessionId: run.sessionId,
        sandboxRoot: config.sandboxRoot,
        computeTarget: run.computeTarget,
        signal: exec.signal,
      });
      return { report: result.text };
    },
    presentCall: (args) => ({ card: "generic", kind: "other", title: "Modal compute", rawInput: args.command }),
  }));
}

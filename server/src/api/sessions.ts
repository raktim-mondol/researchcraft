/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Each ResearchCraft session maps to a `HarnessRuntime` (dsh) spawned/reused
 * by `session-registry.ts`; `/sessions/:id/run` drives one prompt through it
 * and streams the compact client SSE schema from `agent/events.ts`, then
 * emits a terminal `cost` frame sourced from the run's own usage summary.
 *
 * Fusion (OpenRouter-specific multi-model routing) is gone — it required
 * rewriting the outgoing provider request body and disabling local tools for
 * the turn, both Pi-specific mechanisms with no dsh equivalent, and Fusion
 * was already removed from the UI before this migration.
 *
 * Live per-turn abort/steer are more limited than under Pi — see
 * `session-registry.ts`'s file doc: the wire protocol has no per-request
 * cancel (abort closes the whole runtime) and no live queue-preview, so
 * `/steer` here queues into the SAME in-flight `session/prompt` delivery
 * (dsh's `followup()` — see the JSON-RPC server's `prompt()`) rather than
 * previewing a pending queue the way Pi's `queue_update` frames did.
 */
import type { FastifyInstance } from "fastify";
import { activePaths, getProject, touchProject } from "../projects.ts";
import { corsResponseHeaders } from "../cors.ts";
import { currentProjectId } from "../scope.ts";
import { createFrameMapper, type ClientFrame } from "../agent/events.ts";
import {
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewAnswer,
} from "../agent/interview.ts";
import { llmConfigured, resolveModelId } from "../agent/models.ts";
import { parseRunImages } from "../agent/prompt-images.ts";
import { readNotebookEntries } from "../agent/notebook-store.ts";
import { notebookToMarkdown } from "../agent/notebook-export.ts";
import { buildNotebookZip } from "../agent/notebook-zip.ts";
import {
  normalizeNotebookAnnotations,
  readNotebookAnnotations,
  writeNotebookAnnotations,
} from "../agent/notebook-annotations.ts";
import { MethodsDraftError, runMethodsDraft } from "../agent/methods-draft.ts";
import { clearRunContext, mintRunId, writeRunContext } from "../agent/run-ids.ts";
import { SandboxError } from "../sandbox-fs.ts";
import { toNotebook, toShellScript } from "../agent/session-export.ts";
import { toHistory } from "../agent/session-history.ts";
import {
  abortSession,
  createSession,
  getManifest,
  getOrSpawnRuntime,
  isStale,
  listSessions,
} from "../agent/session-registry.ts";
import { parseThinkingLevel } from "../agent/thinking.ts";
import {
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
} from "../cost/ledger.ts";

interface RunBody {
  message?: string;
  model?: string;
  thinkingLevel?: string;
  /** Default Modal compute instance id for `modal_run` this run ("local" / unset = none). */
  computeTarget?: string;
  /** Inline image attachments (base64 + mime type); ride the user message as image blocks. */
  images?: unknown;
}

// Sessions with a run in flight, claimed synchronously.
const activeRuns = new Set<string>();

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions", async () => {
    const manifest = createSession(currentProjectId(), activePaths());
    return { id: manifest.id };
  });

  app.get("/sessions", async () => {
    const manifests = listSessions(activePaths());
    return manifests.map((m) => {
      const last = m.generations.at(-1);
      return {
        id: m.id,
        name: null,
        created: m.createdAt,
        modified: m.updatedAt,
        model: last?.model ?? null,
      };
    });
  });

  // Full transcript of a stored session, replayed as client frames so the UI
  // can rebuild a past chat after a reload ("reopen session").
  app.get<{ Params: { id: string } }>("/sessions/:id/history", async (req, reply) => {
    try {
      const paths = activePaths();
      if (!getManifest(paths, req.params.id)) {
        reply.code(404);
        return { detail: "No such session" };
      }
      return { messages: await toHistory(paths, req.params.id) };
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/costs", async (req, reply) => {
    try {
      return sessionCostSummary(req.params.id, currentProjectId());
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/notebook", async (req, reply) => {
    try {
      return { entries: readNotebookEntries(req.params.id, currentProjectId()) };
    } catch (exc) {
      reply.code(400);
      return { detail: (exc as Error).message };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/notebook/export",
    async (req, reply) => {
      const format = req.query.format ?? "md";
      if (format !== "md" && format !== "json" && format !== "zip") {
        reply.code(400);
        return { detail: "format must be md, json, or zip (PDF is exported client-side)" };
      }
      try {
        const projectId = currentProjectId();
        const entries = readNotebookEntries(req.params.id, projectId);
        const projectName = getProject(projectId)?.name ?? projectId;
        const attachment = (ext: string) =>
          reply.header(
            "Content-Disposition",
            `attachment; filename="lab-notebook-${req.params.id}.${ext}"`,
          );
        if (format === "json") {
          reply.header("Content-Type", "application/json; charset=utf-8");
          attachment("json");
          return { sessionId: req.params.id, projectName, entries };
        }
        if (format === "zip") {
          const { buffer } = buildNotebookZip(entries, {
            sessionId: req.params.id,
            projectName,
            sandboxRoot: activePaths().sandbox,
          });
          reply.type("application/zip");
          attachment("zip");
          return buffer;
        }
        const md = notebookToMarkdown(entries, { sessionId: req.params.id, projectName });
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        attachment("md");
        return md;
      } catch (exc) {
        reply.code(400);
        return { detail: (exc as Error).message };
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        reply.header("Cache-Control", "no-store");
        const { doc, mtime } = readNotebookAnnotations(req.params.id, currentProjectId());
        if (mtime) reply.header("Last-Modified", mtime.toUTCString());
        return doc;
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        const projectId = currentProjectId();
        const { mtime } = readNotebookAnnotations(req.params.id, projectId);
        if (mtime) {
          const precond = req.headers["if-unmodified-since"];
          if (precond) {
            const expected = new Date(String(precond)).getTime();
            if (!Number.isNaN(expected) && mtime.getTime() - expected > 1000) {
              reply.code(412);
              return { detail: "Sidecar modified; re-read and retry" };
            }
          }
        }
        const doc = normalizeNotebookAnnotations(req.body);
        const newMtime = writeNotebookAnnotations(req.params.id, doc, projectId);
        touchProject(projectId);
        reply.header("Last-Modified", newMtime.toUTCString());
        return { saved: req.params.id, count: doc.annotations.length };
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { model?: string } | null }>(
    "/sessions/:id/notebook/methods-draft",
    async (req, reply) => {
      try {
        return await runMethodsDraft(req.params.id, currentProjectId(), {
          model: req.body?.model,
        });
      } catch (err) {
        if (err instanceof MethodsDraftError) {
          reply.code(err.status);
          return err.status === 402
            ? { detail: "budget-exceeded", message: err.message }
            : { detail: "methods-draft-failed", message: err.message };
        }
        throw err;
      }
    },
  );

  // Reproducibility export: a runnable shell script (?format=sh) or a markdown
  // lab notebook (?format=md) reconstructed from the stored dsh transcript(s).
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/export",
    async (req, reply) => {
      try {
        const format = req.query.format === "md" ? "md" : "sh";
        const paths = activePaths();
        if (!getManifest(paths, req.params.id)) {
          reply.code(404);
          return { detail: "No such session" };
        }
        const body =
          format === "md"
            ? await toNotebook(paths, req.params.id)
            : await toShellScript(paths, req.params.id);
        const ext = format === "md" ? "md" : "sh";
        reply.type(format === "md" ? "text/markdown" : "text/x-shellscript");
        reply.header(
          "Content-Disposition",
          `attachment; filename="session-${req.params.id}.${ext}"`,
        );
        return body;
      } catch (err) {
        reply.code(400);
        return { detail: (err as Error).message };
      }
    },
  );

  // The interview tool (dsh-plugins/interview-tool.mjs, bridged via
  // api/internal.ts) blocks its run until the user answers here (or the
  // form is dismissed). 404 = nothing waiting (answered, timed out, aborted);
  // 400 = fixable submission problem — the pending interview is NOT consumed,
  // so the form can correct and resubmit.
  app.post<{ Params: { id: string; toolCallId: string }; Body: InterviewAnswer }>(
    "/sessions/:id/interview/:toolCallId",
    async (req, reply) => {
      const body = (req.body ?? {}) as { cancelled?: boolean; responses?: unknown };
      const answer = (
        body.cancelled ? { cancelled: true } : { responses: body.responses ?? [] }
      ) as InterviewAnswer;
      const invalid = validateAnswer(answer);
      if (invalid) {
        reply.code(400);
        return { detail: invalid };
      }
      const ok = resolveInterview(
        currentProjectId(),
        req.params.id,
        req.params.toolCallId,
        answer,
      );
      if (!ok) {
        reply.code(404);
        return { detail: "No pending interview for this tool call" };
      }
      return { ok: true };
    },
  );

  // Pending interview for a session (lets a reconnecting UI re-render the form).
  app.get<{ Params: { id: string } }>("/sessions/:id/interview", async (req) => {
    return { pending: pendingInterviewFor(currentProjectId(), req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const projectId = currentProjectId();
    await abortSession(projectId, activePaths(), req.params.id);
    return { ok: true, restored: [] };
  });

  // Steering side-channel: queue a message into the LIVE run. dsh's
  // `session/prompt` unconditionally calls the agent's `followup()` — even
  // mid-turn — so a steer here is delivered the same way a run-triggering
  // prompt is; there is no separate "queue preview" the way Pi's
  // `queue_update` frames gave. 409 reason "not_streaming" tells the client
  // to fall back to a normal run.
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/sessions/:id/steer",
    async (req, reply) => {
      const projectId = currentProjectId();
      const paths = activePaths();
      if (!getManifest(paths, req.params.id)) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      const runKey = `${projectId}:${req.params.id}`;
      if (!activeRuns.has(runKey)) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      const budget = isBudgetExceeded(projectId);
      if (budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      const { runtime, dshSessionId } = await getOrSpawnRuntime(projectId, paths, req.params.id, undefined);
      if (!activeRuns.has(runKey)) {
        reply.code(409);
        return { detail: "Run ended before the message was delivered", reason: "not_streaming" };
      }
      await runtime.run(message, { sessionId: dshSessionId });
      return { ok: true, pending: [] };
    },
  );

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/run",
    async (req, reply) => {
      const projectId = currentProjectId();
      const paths = activePaths();
      if (!getManifest(paths, req.params.id)) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const runKey = `${projectId}:${req.params.id}`;
      if (activeRuns.has(runKey)) {
        reply.code(409);
        return { detail: "Session is already streaming a response" };
      }

      const body = req.body ?? {};
      if (!body.message || !body.message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      if (!llmConfigured()) {
        reply.code(400);
        return {
          detail:
            "Model endpoint is not configured. Open Settings → API keys and set Base URL, API key, and Model name.",
        };
      }
      if (body.model?.startsWith("fusion/")) {
        reply.code(400);
        return { detail: "OpenRouter Fusion is not supported. Configure a single model under Settings → API keys." };
      }
      const parsedImages = parseRunImages(body.images);
      if ("error" in parsedImages) {
        reply.code(400);
        return { detail: parsedImages.error };
      }
      // No awaits between the guard above and this claim, so it is atomic.
      activeRuns.add(runKey);
      const runId = mintRunId();
      // Set once the live dsh session id is known (below); cleared in the
      // outer finally, which covers every exit path including early returns.
      let liveDshSessionId: string | undefined;

      try {
        if (body.thinkingLevel !== undefined && parseThinkingLevel(body.thinkingLevel) === undefined) {
          req.log.warn({ thinkingLevel: body.thinkingLevel }, "ignoring invalid thinkingLevel");
        }

        // Take over the socket for Server-Sent Events.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          ...corsResponseHeaders(req.headers.origin),
        });
        const write = (frame: ClientFrame) => {
          if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(frame)}\n\n`);
        };
        write({ type: "run_start", runId });

        // Hard budget cap: refuse to run if the project has reached its limit.
        const budget = isBudgetExceeded(projectId);
        if (budget.exceeded) {
          write({
            type: "error",
            kind: "budget",
            message:
              `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
              `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project ` +
              `settings and retry.`,
          });
          write({ type: "done" });
          raw.end();
          return;
        }

        const modelId = resolveModelId(body.model);
        // A live runtime with a different model can't switch in place (the
        // wire protocol fixes provider/model for a runtime's whole process
        // lifetime) — getOrSpawnRuntime respawns a new generation when stale.
        if (isStale(projectId, req.params.id, modelId)) {
          req.log.info({ sessionId: req.params.id, model: modelId }, "model changed; respawning runtime");
        }
        const { runtime, dshSessionId } = await getOrSpawnRuntime(projectId, paths, req.params.id, modelId);
        liveDshSessionId = dshSessionId;
        writeRunContext(paths, dshSessionId, {
          sessionId: req.params.id,
          runId,
          ...(body.computeTarget ? { computeTarget: body.computeTarget } : {}),
        });

        const abortController = new AbortController();
        req.raw.on("close", () => abortController.abort());

        const mapper = createFrameMapper(paths.sandbox);
        let result;
        try {
          result = await runtime.run(body.message, {
            sessionId: dshSessionId,
            signal: abortController.signal,
            onNotification: (n) => {
              if (n.method !== "session.event") return;
              const event = (n.params as { event?: unknown }).event;
              if (!event || typeof event !== "object") return;
              const frame = mapper.toClientFrame(event as Parameters<typeof mapper.toClientFrame>[0]);
              if (frame) write(frame);
            },
          });
        } catch (err) {
          write({ type: "error", message: (err as Error).message });
          result = null;
        }

        try {
          const usage = result?.usage;
          const run = {
            costUsd: 0,
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: 0,
            total: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          };
          recordRun({
            sessionId: req.params.id,
            projectId,
            model: modelId,
            role: "agent",
            before: { costUsd: 0, input: 0, output: 0, cacheRead: 0, total: 0 },
            after: run,
          });
          const summary = sessionCostSummary(req.params.id, projectId);
          write({
            type: "cost",
            cost: summary.totalUsd,
            tokens: { input: run.input, output: run.output, cacheRead: 0, total: run.total },
            runCost: run.costUsd,
            runTokens: run.total,
          });
          write({ type: "done" });
        } catch (err) {
          req.log.warn({ err }, "failed to ledger run cost");
        }
        if (!raw.writableEnded) raw.end();
      } finally {
        if (liveDshSessionId) clearRunContext(paths, liveDshSessionId);
        activeRuns.delete(runKey);
      }
    },
  );
}

/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Replaces ADK's /apps/.../sessions + /run_sse. Each session is a Pi JSONL
 * conversation; `/sessions/:id/run` streams the agent's events as SSE using the
 * compact client schema from agent/events.ts, then emits a terminal `cost`
 * frame sourced from Pi's per-session usage accounting.
 */
import type { FastifyInstance } from "fastify";
import { activePaths, getProject, touchProject } from "../projects.ts";
import { corsResponseHeaders } from "../cors.ts";
import { currentProjectId } from "../scope.ts";
import { toClientFrame, type ClientFrame } from "../agent/events.ts";
import {
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewAnswer,
} from "../agent/interview.ts";
import { setSessionComputeTarget } from "../agent/modal-tool.ts";
import { setSessionRunpodComputeTarget } from "../agent/runpod-tool.ts";
import { llmConfigured, llmMultimodal, resolveModel } from "../agent/models.ts";
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
import { mintRunId, setSessionRunId } from "../agent/run-ids.ts";
import { SandboxError } from "../sandbox-fs.ts";
import {
  findSessionFile,
  toNotebook,
  toShellScript,
} from "../agent/session-export.ts";
import { toHistory } from "../agent/session-history.ts";
import {
  createSession,
  getModelRegistry,
  getSession,
  listSessions,
} from "../agent/session-registry.ts";
import { parseThinkingLevel } from "../agent/thinking.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
  type CostSnapshot,
} from "../cost/ledger.ts";

function snapshot(session: { getSessionStats(): { cost: number; tokens: { input: number; output: number; cacheRead: number; total: number } } }): CostSnapshot {
  const s = session.getSessionStats();
  return {
    costUsd: s.cost,
    input: s.tokens.input,
    output: s.tokens.output,
    cacheRead: s.tokens.cacheRead,
    total: s.tokens.total,
  };
}

/** Wire shape for Pi's getContextUsage() — null tokens means "unknown until next turn". */
export interface ContextUsageDto {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

function contextUsageOf(session: {
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}): ContextUsageDto | null {
  const u = session.getContextUsage();
  if (!u || !(u.contextWindow > 0)) return null;
  return {
    tokens: typeof u.tokens === "number" ? u.tokens : null,
    contextWindow: u.contextWindow,
    percent: typeof u.percent === "number" ? u.percent : null,
  };
}

interface RunBody {
  message?: string;
  model?: string;
  thinkingLevel?: string;
  /**
   * Default remote compute target for this run.
   * - unset / "local" → no remote default
   * - "h100", "t4", … → Modal instance (backward-compatible bare ids)
   * - "modal:h100" → Modal instance (explicit)
   * - "runpod:rtx4090" → Runpod instance
   */
  computeTarget?: string;
  /** Inline image attachments (base64 + mime type); ride the user message as image blocks. */
  images?: unknown;
}

// Sessions with a run in flight, claimed synchronously. `session.isStreaming`
// flips true only after awaits inside prompt(), so concurrent POSTs could
// otherwise both pass the guard and the loser's close handler would abort the
// winner's live turn.
const activeRuns = new Set<string>();

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions", async () => {
    const session = await createSession(currentProjectId(), activePaths());
    return { id: session.sessionId, sessionFile: session.sessionFile };
  });

  app.get("/sessions", async () => {
    const infos = await listSessions(activePaths());
    return infos.map((i) => ({
      id: i.id,
      name: i.name ?? null,
      created: i.created,
      modified: i.modified,
      messageCount: i.messageCount,
      firstMessage: i.firstMessage,
    }));
  });

  // Full transcript of a stored session, replayed as client frames so the UI
  // can rebuild a past chat after a reload ("reopen session").
  app.get<{ Params: { id: string } }>("/sessions/:id/history", async (req, reply) => {
    try {
      const paths = activePaths();
      const file = findSessionFile(paths, req.params.id);
      if (!file) {
        reply.code(404);
        return { detail: "No such session" };
      }
      return { messages: toHistory(file, paths.sandbox) };
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

  // Current in-context token usage vs model context window (for the UI meter).
  app.get<{ Params: { id: string } }>("/sessions/:id/context", async (req, reply) => {
    try {
      const session = await getSession(currentProjectId(), activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const context = contextUsageOf(session);
      if (!context) {
        // Model not set yet or no window advertised — still return a shape.
        const window =
          session.model && typeof (session.model as { contextWindow?: number }).contextWindow === "number"
            ? (session.model as { contextWindow: number }).contextWindow
            : 0;
        return {
          tokens: null,
          contextWindow: window,
          percent: null,
        } satisfies ContextUsageDto;
      }
      return context;
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  // Manually compact the session (summarize older turns to free context).
  // Blocked while a run is in flight — compact aborts the agent first, but
  // racing an open SSE stream is more confusing than a clean 409.
  app.post<{ Params: { id: string }; Body: { instructions?: string } }>(
    "/sessions/:id/compact",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const runKey = `${projectId}:${req.params.id}`;
      if (activeRuns.has(runKey) || session.isStreaming) {
        reply.code(409);
        return {
          detail: "Cannot compact while a run is in progress. Stop the run first.",
          reason: "busy",
        };
      }
      try {
        const instructions =
          typeof req.body?.instructions === "string" && req.body.instructions.trim()
            ? req.body.instructions.trim()
            : undefined;
        const result = await session.compact(instructions);
        return {
          ok: true,
          tokensBefore: result.tokensBefore,
          context: contextUsageOf(session),
        };
      } catch (err) {
        reply.code(400);
        return { detail: (err as Error).message };
      }
    },
  );

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
  // lab notebook (?format=md) reconstructed from the Pi session log.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/export",
    async (req, reply) => {
      try {
        const format = req.query.format === "md" ? "md" : "sh";
        const paths = activePaths();
        const file = findSessionFile(paths, req.params.id);
        if (!file) {
          reply.code(404);
          return { detail: "No such session" };
        }
        const body =
          format === "md"
            ? toNotebook(file, req.params.id, paths.sandbox)
            : toShellScript(file, req.params.id, paths.sandbox);
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

  // The interview tool blocks its run until the user answers here (or the
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
    const session = await getSession(currentProjectId(), activePaths(), req.params.id);
    if (!session) return { ok: true, restored: [] };
    // Clear BEFORE abort so a pending steer can't be delivered into the
    // dying loop; the texts go back to the composer client-side.
    const cleared = session.clearQueue();
    await session.abort();
    return { ok: true, restored: [...cleared.steering, ...cleared.followUp] };
  });

  // Steering side-channel: queue a message into the LIVE run (delivered by Pi
  // after the current tool calls, before the next LLM call). Never creates a
  // run or an SSE stream — the /run stream carries the delivery + queue_update
  // frames. 409 reason "not_streaming" tells the client to fall back to a
  // normal run.
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/sessions/:id/steer",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      // A steer extends a live run's spend past what the run-start check
      // gated, so re-check the cap here.
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
      await session.steer(message);
      // The run can end between the guard and the queue write; a steer left
      // behind would silently deliver into the NEXT run, so pull it back out.
      if (!session.isStreaming) {
        session.clearQueue();
        reply.code(409);
        return { detail: "Run ended before the message was delivered", reason: "not_streaming" };
      }
      return { ok: true, pending: [...session.getSteeringMessages()] };
    },
  );

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/run",
    async (req, reply) => {
      const projectId = currentProjectId();
      const paths = activePaths();
      const session = await getSession(projectId, paths, req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      // One run at a time per session. The frontend blocks sending while a tab
      // is streaming, so this is a guard against races/double-submits rather
      // than a normal path. (Pi's followUp queueing returns immediately, which
      // would orphan the SSE stream and abort the live turn — so we reject.)
      const runKey = `${projectId}:${req.params.id}`;
      if (session.isStreaming || activeRuns.has(runKey)) {
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
      const parsedImages = parseRunImages(body.images);
      if ("error" in parsedImages) {
        reply.code(400);
        return { detail: parsedImages.error };
      }
      // The configured endpoint may be text-only (e.g. DeepSeek Flash): image
      // blocks would be silently dropped upstream and the model would claim it
      // never saw them. Fail clearly and tell the user the fix instead.
      if (parsedImages.images.length > 0 && !llmMultimodal()) {
        reply.code(400);
        return {
          detail:
            'The configured model does not support images. Enable "Supports images (vision)" under Settings → API keys (only for vision-capable models), or remove the image attachment.',
        };
      }
      // No awaits between the guard above and this claim, so it is atomic.
      activeRuns.add(runKey);
      // One id per run invocation; notebook entries appended during this run
      // (lead tool + subagent harvest) are stamped with it. Cleared in the
      // outer finally so it covers every exit path.
      const runId = mintRunId();
      setSessionRunId(session.sessionId, runId);
      try {
        // Stash this run's selected compute instance so modal_run / runpod_run
        // use it as the default when the agent doesn't name one.
        // Wire format: "local"/unset clears both; "runpod:<id>" routes to Runpod;
        // bare Modal ids or "modal:<id>" route to Modal.
        {
          const raw = body.computeTarget ?? null;
          if (!raw || raw === "local") {
            setSessionComputeTarget(session.sessionId, null);
            setSessionRunpodComputeTarget(session.sessionId, null);
          } else if (raw.startsWith("runpod:")) {
            setSessionComputeTarget(session.sessionId, null);
            setSessionRunpodComputeTarget(session.sessionId, raw);
          } else if (raw.startsWith("modal:")) {
            setSessionComputeTarget(session.sessionId, raw.slice("modal:".length));
            setSessionRunpodComputeTarget(session.sessionId, null);
          } else {
            // Backward-compat bare Modal instance id (e.g. "h100").
            setSessionComputeTarget(session.sessionId, raw);
            setSessionRunpodComputeTarget(session.sessionId, null);
          }
        }
        if (body.model) {
          try {
            await session.setModel(resolveModel(body.model, getModelRegistry()));
          } catch (err) {
            req.log.warn({ err }, "setModel failed; keeping current model");
          }
        }
        if (body.thinkingLevel !== undefined) {
          const level = parseThinkingLevel(body.thinkingLevel);
          if (level) session.setThinkingLevel(level);
          else req.log.warn({ thinkingLevel: body.thinkingLevel }, "ignoring invalid thinkingLevel");
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
        // Synthetic route-level frame (Pi events carry no run id): lets the
        // client stamp provisional notebook entries with this run before the
        // authoritative refetch.
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

        const sandboxRoot = activePaths().sandbox;
        // Usage tallied straight from turn_end events. getSessionStats() is
        // recomputed from the in-context messages, so auto-compaction mid-run
        // can shrink the cumulative stats and make the before/after delta lie
        // low; the per-turn events are immune to that.
        const turnTally = emptySnapshot();
        const unsub = session.subscribe((ev) => {
          if (ev.type === "turn_end") {
            const usage = (ev.message as { usage?: Parameters<typeof addTurnUsage>[1] }).usage;
            if (usage) addTurnUsage(turnTally, usage);
          }
          const frame = toClientFrame(ev, sandboxRoot);
          if (frame) write(frame);
        });

        req.raw.on("close", () => {
          if (session.isStreaming) session.abort().catch(() => {});
        });

        // errorMessage is sticky on the session; only report it if THIS run set it.
        const priorError = session.state.errorMessage;
        const before = snapshot(session);
        try {
          await session.prompt(
            body.message ?? "",
            parsedImages.images.length > 0 ? { images: parsedImages.images } : undefined,
          );
          // Surface a provider/agent error that didn't already stream as a frame
          // (e.g. an auth failure that produced an empty assistant turn).
          const errorMessage = session.state.errorMessage;
          if (errorMessage && errorMessage !== priorError) {
            write({ type: "error", message: errorMessage });
          }
        } catch (err) {
          write({ type: "error", message: (err as Error).message });
        } finally {
          unsub();
          // Ledger in the finally: a run that threw mid-turn still spent real
          // tokens. The stats delta catches a partial turn that never reached
          // turn_end; the tally catches compaction — take the max of the two.
          try {
            const run = snapshotMax(snapshotDelta(before, snapshot(session)), turnTally);
            recordRun({
              sessionId: req.params.id,
              projectId,
              model: session.model?.id ?? "unknown",
              before: emptySnapshot(),
              after: run,
            });
            const stats = session.getSessionStats();
            // `cost` is the session's full ledgered spend (subagents included,
            // restart/compaction-proof); `tokens` is Pi's in-context cumulative;
            // `runCost`/`runTokens` are the delta for THIS turn, so the UI can
            // attribute a price to the message that just completed.
            write({
              type: "cost",
              cost: sessionCostSummary(req.params.id, projectId).totalUsd,
              tokens: stats.tokens,
              runCost: run.costUsd,
              runTokens: run.total,
              // In-context meter for the UI (used vs window); null tokens right
              // after a compact until the next assistant turn reports usage.
              context: contextUsageOf(session) ?? undefined,
            });
            write({ type: "done" });
          } catch (err) {
            req.log.warn({ err }, "failed to ledger run cost");
          }
          if (!raw.writableEnded) raw.end();
        }
      } finally {
        setSessionRunId(session.sessionId, null);
        activeRuns.delete(runKey);
      }
    },
  );
}

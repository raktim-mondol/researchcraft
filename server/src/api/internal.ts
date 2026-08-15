/**
 * Internal-only bridge endpoints reached by the dsh runtime SUBPROCESS, not
 * the frontend. The server binds to localhost only (see credentials.ts's
 * header comment), so no separate auth is layered on top — same trust model
 * as the rest of this local-first app.
 *
 * Currently just the interview tool's blocking-wait bridge: see
 * `agent/interview.ts`'s file doc for the full round trip and
 * `dsh-plugins/interview-tool.mjs` for the subprocess side.
 */
import type { FastifyInstance } from "fastify";
import {
  registerInterview,
  validateQuestions,
  type InterviewParamsT,
} from "../agent/interview.ts";

interface InternalInterviewBody {
  projectId?: string;
  sessionId?: string;
  toolCallId?: string;
  payload?: InterviewParamsT;
}

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: InternalInterviewBody }>("/internal/interview", async (req, reply) => {
    const { projectId, sessionId, toolCallId, payload } = req.body ?? {};
    if (!projectId || !sessionId || !toolCallId || !payload) {
      reply.code(400);
      return { detail: "projectId, sessionId, toolCallId, and payload are required" };
    }
    const invalid = validateQuestions(payload.questions ?? []);
    if (invalid) {
      reply.code(400);
      return { detail: invalid };
    }
    // The tool caller's own request connection closing (its exec.signal
    // fired, or the runtime was torn down) is the abort signal here — Node's
    // IncomingMessage/ServerResponse have no native AbortSignal, so derive one
    // from 'close'. This MUST watch `reply.raw` (the response), not `req.raw`
    // (the request): the request stream closes as soon as its body has been
    // fully read — near-instantly for a small JSON payload — which fired this
    // "close" long before any real disconnect and aborted every interview
    // within milliseconds. The response stays open until we actually reply,
    // so its 'close' event only fires early on a genuine client disconnect.
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    try {
      const answer = await registerInterview(projectId, sessionId, toolCallId, payload, abortController.signal);
      return { answer };
    } catch (err) {
      reply.code(504);
      return { detail: (err as Error).message };
    }
  });
}

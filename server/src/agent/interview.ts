/**
 * Native `interview` tool: structured clarifying questions answered in the chat UI.
 *
 * This is the embedded-app equivalent of the pi-interview package
 * (https://pi.dev/packages/pi-interview). The npm package opens its own web
 * server + browser window on the host machine, which doesn't fit a web app
 * whose user is already in a browser — so we register a custom tool with the
 * same question schema and render the form inline in the chat instead:
 *
 *   1. The agent calls `interview` with inline questions
 *      (`dsh-plugins/interview-tool.mjs`, running inside the dsh runtime
 *      SUBPROCESS). Its `tool/call` event streams to the frontend as a
 *      `tool_start` SSE frame carrying the full questions payload (via
 *      `events.ts`, generically — no interview-specific code there).
 *   2. The plugin POSTs to `POST /internal/interview` on THIS (main Fastify)
 *      process — the only place `pending` below can live, since the tool
 *      itself runs in a separate OS process — which calls
 *      `registerInterview()` and holds the HTTP response open.
 *   3. The chat UI renders the form (web/src/components/interview-form.tsx)
 *      and POSTs answers to the public `/sessions/:id/interview/:toolCallId`
 *      route, which calls `resolveInterview()`, settling step 2's promise and
 *      the plugin's blocked HTTP call together; the tool returns the
 *      structured responses to the model and the run continues.
 *
 * Sub-agent children never get this tool — they must not block on user input
 * (persona-subagents.mjs doesn't register it).
 */
import { Type, type Static } from "typebox";

/** Mirrors pi-interview's defaults. */
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
// Floor the wait so a model can't set a near-instant timeout (e.g. 1s) that
// expires the form before a human could plausibly read and answer it.
export const MIN_TIMEOUT_S = 60;
export const MAX_IMAGES = 12;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const OptionSchema = Type.Union([
  Type.String(),
  Type.Object({
    label: Type.String({ description: "Short option label" }),
    content: Type.Optional(
      Type.String({ description: "Longer Markdown body shown under the label" }),
    ),
  }),
]);

const ContentBlockSchema = Type.Object({
  source: Type.String({ description: "Code / diff / Markdown text to display" }),
  lang: Type.Optional(
    Type.String({
      description:
        'Language for syntax highlighting; "diff" renders a diff, "md" renders Markdown',
    }),
  ),
  file: Type.Optional(Type.String({ description: "File name caption" })),
});

const MediaSchema = Type.Object({
  type: Type.Union([
    Type.Literal("image"),
    Type.Literal("table"),
    Type.Literal("chart"),
    Type.Literal("mermaid"),
    Type.Literal("html"),
  ]),
  src: Type.Optional(
    Type.String({
      description:
        "For image: sandbox-relative path or URL. For mermaid/html: inline source.",
    }),
  ),
  headers: Type.Optional(Type.Array(Type.String(), { description: "Table headers" })),
  rows: Type.Optional(
    Type.Array(Type.Array(Type.String()), { description: "Table rows" }),
  ),
  config: Type.Optional(
    Type.Any({ description: "Chart.js config object for type=chart" }),
  ),
  caption: Type.Optional(Type.String()),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier; responses are keyed by it" }),
  type: Type.Union(
    [
      Type.Literal("single"),
      Type.Literal("multi"),
      Type.Literal("text"),
      Type.Literal("image"),
      Type.Literal("info"),
    ],
    {
      description:
        "single = radio choice, multi = checkboxes, text = free text, image = user uploads images, info = non-interactive context panel",
    },
  ),
  question: Type.String({ description: "The question text shown to the user" }),
  options: Type.Optional(
    Type.Array(OptionSchema, { description: "Choices (required for single/multi)" }),
  ),
  recommended: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Your recommended option label(s); shown with a badge",
    }),
  ),
  conviction: Type.Optional(
    Type.Union([Type.Literal("strong"), Type.Literal("slight")], {
      description: 'How sure you are of the recommendation; "strong" pre-selects it',
    }),
  ),
  weight: Type.Optional(
    Type.Union([Type.Literal("critical"), Type.Literal("minor")], {
      description: "Visual prominence of the question",
    }),
  ),
  context: Type.Optional(Type.String({ description: "Help text under the question" })),
  content: Type.Optional(ContentBlockSchema),
  media: Type.Optional(Type.Union([MediaSchema, Type.Array(MediaSchema)])),
});

export const InterviewParams = Type.Object({
  title: Type.String({ description: "Form title" }),
  description: Type.Optional(Type.String({ description: "Intro text under the title" })),
  questions: Type.Array(QuestionSchema, { minItems: 1 }),
  timeout: Type.Optional(
    Type.Number({ description: `Seconds to wait for answers (default ${DEFAULT_TIMEOUT_S})` }),
  ),
});

export type InterviewQuestion = Static<typeof QuestionSchema>;
export type InterviewParamsT = Static<typeof InterviewParams>;

/** One uploaded image, sent by the UI as raw base64 + mime type. */
export interface InterviewAttachment {
  data: string;
  mimeType: string;
}

export interface InterviewResponse {
  id: string;
  value: string | string[];
  attachments?: InterviewAttachment[];
}

export type InterviewAnswer =
  | { cancelled: true }
  | { cancelled?: false; responses: InterviewResponse[] };

interface PendingInterview {
  projectId: string;
  sessionId: string;
  payload: InterviewParamsT;
  settle: (answer: InterviewAnswer) => void;
}

// Keyed by toolCallId (globally unique); projectId/sessionId are kept for
// route-side validation so one tab can't answer another project's interview.
const pending = new Map<string, PendingInterview>();

/**
 * Resolve a pending interview with the user's answer. Returns false when no
 * matching interview is waiting (wrong ids, already answered, or timed out).
 */
export function resolveInterview(
  projectId: string,
  sessionId: string,
  toolCallId: string,
  answer: InterviewAnswer,
): boolean {
  const p = pending.get(toolCallId);
  if (!p || p.projectId !== projectId || p.sessionId !== sessionId) return false;
  pending.delete(toolCallId);
  p.settle(answer);
  return true;
}

/** The pending interview for a session, if any (lets a reloading UI re-render it). */
export function pendingInterviewFor(
  projectId: string,
  sessionId: string,
): { toolCallId: string; payload: InterviewParamsT } | null {
  for (const [toolCallId, p] of pending) {
    if (p.projectId === projectId && p.sessionId === sessionId) {
      return { toolCallId, payload: p.payload };
    }
  }
  return null;
}

export function validateQuestions(questions: InterviewQuestion[]): string | null {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.id)) return `Duplicate question id "${q.id}"`;
    seen.add(q.id);
    if ((q.type === "single" || q.type === "multi") && !(q.options?.length)) {
      return `Question "${q.id}" is type "${q.type}" but has no options`;
    }
  }
  return null;
}

/** Approximate decoded size of a base64 payload. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/**
 * Validate an answer body against the interview limits (mirrors
 * pi-interview's image caps). Returns an error string or null when OK.
 * Exposed so the HTTP route can reject bad submissions with a 400 *without*
 * consuming the pending interview, letting the user fix and resubmit.
 */
export function validateAnswer(answer: InterviewAnswer): string | null {
  if (answer.cancelled) return null;
  if (!Array.isArray(answer.responses)) return "responses must be an array";
  let images = 0;
  for (const r of answer.responses) {
    if (!r || typeof r.id !== "string") return "each response needs a string id";
    const valueOk =
      typeof r.value === "string" ||
      (Array.isArray(r.value) && r.value.every((v) => typeof v === "string"));
    if (!valueOk) return `response "${r.id}": value must be a string or string array`;
    for (const a of r.attachments ?? []) {
      images++;
      if (typeof a?.data !== "string" || typeof a?.mimeType !== "string") {
        return `response "${r.id}": attachments need base64 data + mimeType`;
      }
      if (!/^image\//.test(a.mimeType)) {
        return `response "${r.id}": only image attachments are supported`;
      }
      if (base64Bytes(a.data) > MAX_IMAGE_BYTES) {
        return `response "${r.id}": image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`;
      }
    }
  }
  if (images > MAX_IMAGES) return `at most ${MAX_IMAGES} images per submission`;
  return null;
}

/**
 * Register one interview and block until it's answered, dismissed, timed
 * out, or aborted. This is the piece that used to live directly inside the
 * Pi tool's `execute()`; now it's called from `api/internal.ts`'s
 * `POST /internal/interview` handler instead, since the model-facing tool
 * itself runs inside the dsh runtime SUBPROCESS (a separate OS process from
 * this one) and reaches this `pending` map only over that HTTP bridge — see
 * `dsh-plugins/interview-tool.mjs`.
 */
export function registerInterview(
  projectId: string,
  sessionId: string,
  toolCallId: string,
  payload: InterviewParamsT,
  signal?: AbortSignal,
): Promise<InterviewAnswer> {
  const invalid = validateQuestions(payload.questions);
  if (invalid) return Promise.reject(new Error(invalid));
  const timeoutS = Math.min(
    Math.max(payload.timeout ?? DEFAULT_TIMEOUT_S, MIN_TIMEOUT_S),
    MAX_TIMEOUT_S,
  );

  return new Promise<InterviewAnswer>((resolve, reject) => {
    const cleanup = () => {
      pending.delete(toolCallId);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Interview timed out after ${timeoutS}s. The user did NOT answer any of these questions. ` +
            "Do not claim or imply that the user chose, provided, confirmed, or approved any option — they did not respond at all. " +
            "Tell the user plainly that you received no answer, then proceed using your own recommended defaults, " +
            "explicitly labelling them as assumptions the user can correct.",
        ),
      );
    }, timeoutS * 1000);
    const onAbort = () => {
      cleanup();
      reject(new Error("Interview aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(toolCallId, {
      projectId,
      sessionId,
      payload,
      settle: (a) => {
        cleanup();
        resolve(a);
      },
    });
  });
}

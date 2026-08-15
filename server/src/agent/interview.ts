/**
 * Native `interview` tool: structured clarifying questions answered in the chat UI.
 *
 * This is the embedded-app equivalent of the pi-interview package
 * (https://pi.dev/packages/pi-interview). The npm package opens its own web
 * server + browser window on the host machine, which doesn't fit a web app
 * whose user is already in a browser — so we register a custom tool with the
 * same question schema and render the form inline in the chat instead:
 *
 *   1. The agent calls `interview` with inline questions. Pi emits
 *      `tool_execution_start`, which sessions.ts streams to the frontend as a
 *      `tool_start` SSE frame carrying the full questions payload.
 *   2. The chat UI renders the form (web/src/components/interview-form.tsx)
 *      and POSTs answers to `/sessions/:id/interview/:toolCallId`.
 *   3. That resolves the pending promise here; the tool returns the
 *      structured responses (plus any uploaded images) to the model and the
 *      run continues on the same SSE stream.
 *
 * Sub-agent child `pi` processes never get this tool — they are headless and
 * must not block on user input.
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

function validateQuestions(questions: InterviewQuestion[]): string | null {
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

// TODO(#20): the model-facing `interview` tool itself (registering it so the
// dsh agent can actually call it) is not yet ported. It needs an HTTP bridge
// — the tool runs inside the dsh runtime SUBPROCESS, but `pending` above must
// stay in THIS (main Fastify) process since it's what `/sessions/:id/interview/
// :toolCallId` resolves against. Planned shape: a raw Cordis plugin (same
// local-file-row pattern as `dsh-plugins/persona-subagents.mjs`) whose
// `execute()` POSTs the questions payload to a new internal endpoint on this
// server (e.g. `POST /internal/interview`), which registers into `pending`
// exactly as `validateQuestions`/`pending.set` above do today and holds the
// HTTP response open until `resolveInterview()` settles it (or it times out)
// — i.e. the promise-based blocking wait below moves from an in-process
// await to an HTTP long-poll, same `pending` map, same timeout/abort/cancel
// semantics. `InterviewParams` (TypeBox) still describes the tool's model-
// facing schema; it needs translating into dsh's `defineTool()` parameter
// shape (see `dsh-plugins/persona-subagents.mjs`'s header comment for that
// pattern) rather than passed through directly — the two schema shapes are
// not wire-compatible (TypeBox = standard JSON Schema; dsh's ParameterSchemaSpec
// keeps `required` as a per-property flag, not a schema-level array).

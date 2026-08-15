/**
 * Native `interview` tool: present the user an interactive form and block
 * until they answer. See `../interview.ts`'s file doc for the full round
 * trip — this plugin is step 1 (register the model-facing tool) and step 2
 * (bridge the blocking wait to the main Fastify process, since `pending`
 * must live there, not in this dsh runtime SUBPROCESS).
 *
 * Raw Cordis plugin (not an npm package), loaded by absolute file path —
 * same local-file-row pattern as `persona-subagents.mjs`.
 *
 * @module researchcraft/interview-tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readRunContext } from "../run-ids.ts";

export const name = "researchcraft-interview-tool";
export const inject = ["tools"];

const optionSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", required: true, description: "Short option label" },
        content: { type: "string", description: "Longer Markdown body shown under the label" },
      },
    },
  ],
};

const mediaItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      required: true,
      enum: ["image", "table", "chart", "mermaid", "html"],
    },
    src: { type: "string", description: "For image: sandbox-relative path or URL. For mermaid/html: inline source." },
    headers: { type: "array", items: { type: "string" }, description: "Table headers" },
    rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Table rows" },
    config: { type: "json", description: "Chart.js config object for type=chart" },
    caption: { type: "string" },
  },
};

const questionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true, description: "Unique identifier; responses are keyed by it" },
    type: {
      type: "string",
      required: true,
      enum: ["single", "multi", "text", "image", "info"],
      description: "single = radio choice, multi = checkboxes, text = free text, image = user uploads images, info = non-interactive context panel",
    },
    question: { type: "string", required: true, description: "The question text shown to the user" },
    options: { type: "array", items: optionSchema, description: "Choices (required for single/multi)" },
    recommended: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: "Your recommended option label(s); shown with a badge",
    },
    conviction: {
      type: "string",
      enum: ["strong", "slight"],
      description: 'How sure you are of the recommendation; "strong" pre-selects it',
    },
    weight: { type: "string", enum: ["critical", "minor"], description: "Visual prominence of the question" },
    context: { type: "string", description: "Help text under the question" },
    content: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", required: true, description: "Code / diff / Markdown text to display" },
        lang: { type: "string", description: 'Language for syntax highlighting; "diff" renders a diff, "md" renders Markdown' },
        file: { type: "string", description: "File name caption" },
      },
    },
    media: { oneOf: [mediaItemSchema, { type: "array", items: mediaItemSchema }] },
  },
};

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ projectId: string, kadyDir: string, internalBaseUrl: string }} config
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "interview",
    description: [
      "Present the user with an interactive form of questions in the chat and wait for their answers.",
      "Use this liberally and early to ask clarifying questions: before starting any non-trivial or ambiguous task, when multiple reasonable approaches exist, before expensive/long-running or destructive work, and whenever you would otherwise have to assume. Asking is always better than guessing.",
      "Prefer ONE interview with several focused questions over many separate calls. For every single/multi question, set `recommended` to your best suggestion (with `conviction`) so the user can simply confirm.",
      'Question types: "single" (pick one), "multi" (pick many), "text" (free text), "image" (user uploads images), "info" (non-interactive context panel).',
      "Use `content` to show code/diff/Markdown and `media` to show images, tables, Mermaid diagrams, or charts alongside a question.",
      "The result is a JSON summary of {id, value} responses. If the user dismisses the form, proceed with your recommendations.",
    ].join("\n"),
    parameters: {
      title: { type: "string", required: true, description: "Form title" },
      description: { type: "string", description: "Intro text under the title" },
      questions: { type: "array", required: true, items: questionSchema, description: "At least one question." },
      timeout: { type: "number", description: "Seconds to wait for answers (default 600)" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cancelled: { type: "boolean", required: true },
          summary: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary }],
    },
    // Blocks on user input — never run it concurrently with other tools.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!exec.agent) throw new Error("interview requires a calling agent (exec.agent was undefined)");
      const dshSessionId = String(exec.agent.id);
      const run = readRunContext(config.kadyDir, dshSessionId);
      if (!run) {
        throw new Error("interview could not resolve the live session context; try again");
      }

      const res = await fetch(`${config.internalBaseUrl}/internal/interview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: config.projectId,
          sessionId: run.sessionId,
          toolCallId: String(exec.callId),
          payload: args,
        }),
        signal: exec.signal,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.detail ?? `interview bridge request failed (${res.status})`);
      }
      const answer = body.answer;

      if (answer.cancelled) {
        return {
          cancelled: true,
          summary:
            "The user dismissed the interview without answering any question. " +
            "Do not claim or imply that the user chose, provided, confirmed, or approved any option. " +
            "Proceed with your recommended options, explicitly state the assumptions you made, " +
            "and do not re-open the same interview.",
        };
      }

      const responses = answer.responses ?? [];
      const summary = responses.map((r) => ({
        id: r.id,
        value: r.value,
        ...(r.attachments?.length ? { images: r.attachments.length } : {}),
      }));
      // Uploaded images aren't surfaced to the model as image content yet —
      // routing an interview attachment through dsh's attachment/content-block
      // pipeline is real additional infrastructure (see agent/interview.ts's
      // InterviewAttachment type); the model sees only that N images arrived.
      return { cancelled: false, summary: JSON.stringify({ responses: summary }, null, 2) };
    },
    presentCall: (args) => ({ card: "generic", kind: "other", title: args.title, rawInput: args }),
  }));
}

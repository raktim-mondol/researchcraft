/**
 * Native `notebook` tool: ResearchCraft logs its own research narrative as structured
 * lab-notebook entries (hypothesis / method / observation / decision / note).
 *
 * Modeled on the `interview` tool, but NON-BLOCKING: it validates, server-
 * stamps (id = toolCallId, timestamp, role), appends to the durable store,
 * and returns immediately so the run keeps flowing. The entry rides the normal
 * `tool_start` SSE frame (tool name "notebook", args = the entry), which the
 * center-panel Lab Notebook view renders live.
 *
 * In-process custom tool → seen only by the lead agent, not by pi-subagents'
 * child `pi` processes (a Phase 5 follow-on promotes it to a Pi package).
 */
import { Type, type Static } from "typebox";
import { resolvePaths } from "../projects.ts";
import { stripSandboxRoot } from "./events.ts";
import { appendNotebookEntry, type NotebookEntry } from "./notebook-store.ts";
import { currentRunId } from "./run-ids.ts";

const CodeSchema = Type.Object({
  source: Type.String({ description: "The code/snippet text" }),
  lang: Type.Optional(Type.String({ description: "Language for highlighting" })),
});

export const NotebookParams = Type.Object({
  type: Type.Union(
    [
      Type.Literal("hypothesis"),
      Type.Literal("method"),
      Type.Literal("observation"),
      Type.Literal("decision"),
      Type.Literal("note"),
    ],
    {
      description:
        "hypothesis = an idea to test, method = what you did/ran, observation = a result, decision = a choice you made and why, note = anything else",
    },
  ),
  title: Type.String({ description: "One-line headline for this entry" }),
  body: Type.Optional(Type.String({ description: "Markdown detail (optional)" })),
  artifacts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Sandbox-relative paths this entry produced or references (figures, tables, scripts). Attach whenever the entry corresponds to a file you wrote.",
    }),
  ),
  code: Type.Optional(CodeSchema),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description: "Your confidence (mainly for hypothesis/decision)",
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form labels" })),
  relatesTo: Type.Optional(
    Type.String({
      description:
        "Id of an earlier notebook entry this one responds to (every notebook call returns its entry id). Pair with `stance`.",
    }),
  ),
  stance: Type.Optional(
    Type.Union(
      [Type.Literal("supports"), Type.Literal("refutes"), Type.Literal("neutral")],
      { description: "How this entry bears on the `relatesTo` target" },
    ),
  ),
  supersedes: Type.Optional(
    Type.String({
      description:
        "Id of an earlier entry this one amends or replaces — use instead of re-logging corrected content without linkage",
    }),
  ),
});

export type NotebookParamsT = Static<typeof NotebookParams>;

// TODO(#20): port to a real dsh tool (raw Cordis plugin, same local-file-row
// pattern as `dsh-plugins/persona-subagents.mjs`). `appendNotebookEntry` below
// is pure file I/O and safe to call directly from the runtime SUBPROCESS the
// tool executes in — but `currentRunId(sessionId)` (run-ids.ts) is NOT: it
// reads an in-memory Map that lives in the MAIN Fastify process, a different
// OS process from the dsh runtime subprocess with its own separate module
// state, so a subprocess-side tool can never see it via a plain import. This
// is the same class of problem as the interview tool's `pending` map (see
// interview.ts's TODO), just simpler to fix: before calling `runtime.run()`,
// `run-ids.ts` needs to also mirror the current run id to a small file on
// disk keyed by the dsh session id (which the tool CAN read via
// `exec.agent.session.id` — no ResearchCraft session id needed inside the
// subprocess at all), and this tool's execute() reads that file instead of
// calling `currentRunId()` directly.

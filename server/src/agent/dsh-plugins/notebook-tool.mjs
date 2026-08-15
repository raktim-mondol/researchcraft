/**
 * Native `notebook` tool: ResearchCraft logs its own research narrative as
 * structured lab-notebook entries (hypothesis / method / observation /
 * decision / note). Non-blocking: validates, server-stamps (id = the dsh
 * call id, timestamp, role), appends to the durable store, and returns
 * immediately so the run keeps flowing.
 *
 * Raw Cordis plugin (not an npm package), loaded by absolute file path from
 * a composed row — see `../dsh/compose/notebook.ts` and
 * `persona-subagents.mjs`'s header comment for why (local-file rows, plain
 * ESM JS since the runtime subprocess has no TypeScript loader).
 *
 * `appendNotebookEntry` is pure file I/O, safe to call directly from this
 * subprocess. The one piece of state that ISN'T available here directly is
 * which ResearchCraft session (and run) this dsh session belongs to — the
 * main Fastify process mirrors that via `run-ids.ts`'s `writeRunContext()`
 * before every run; this tool reads it back with `readRunContext()`.
 *
 * @module researchcraft/notebook-tool
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendNotebookEntry } from "../notebook-store.ts";
import { stripSandboxRoot } from "../events.ts";
import { readRunContext } from "../run-ids.ts";

export const name = "researchcraft-notebook-tool";
export const inject = ["tools"];

const ENTRY_TYPES = ["hypothesis", "method", "observation", "decision", "note"];
const CONFIDENCE = ["low", "medium", "high"];
const STANCE = ["supports", "refutes", "neutral"];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ projectId: string, kadyDir: string, sandboxRoot: string }} config
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "notebook",
    description: [
      "Log an entry to your living lab notebook — the scientist watching you works from it.",
      "Record your real reasoning as you go: a `hypothesis` when you form an idea to test, a `method` before/after you run an analysis, an `observation` when you get a result, and a `decision` when a result makes you change course.",
      "Attach `artifacts` (sandbox-relative paths) whenever an entry corresponds to a figure, table, or script you just wrote — they become clickable links in the notebook.",
      "Every call returns the new entry's id. When a later result bears on an earlier entry, link them: `relatesTo: <id>` with a `stance` (supports/refutes/neutral). To correct an earlier entry, log a new one with `supersedes: <id>` — history is append-only.",
      "This does NOT block; it returns immediately and your run continues. Log liberally at natural milestones rather than in one dump at the end.",
    ].join("\n"),
    parameters: {
      type: {
        type: "string",
        required: true,
        enum: ENTRY_TYPES,
        description: "hypothesis = an idea to test, method = what you did/ran, observation = a result, decision = a choice you made and why, note = anything else",
      },
      title: { type: "string", required: true, description: "One-line headline for this entry" },
      body: { type: "string", description: "Markdown detail (optional)" },
      artifacts: {
        type: "array",
        items: { type: "string" },
        description: "Sandbox-relative paths this entry produced or references (figures, tables, scripts). Attach whenever the entry corresponds to a file you wrote.",
      },
      code: {
        type: "object",
        properties: {
          source: { type: "string", required: true, description: "The code/snippet text" },
          lang: { type: "string", description: "Language for highlighting" },
        },
      },
      confidence: { type: "string", enum: CONFIDENCE, description: "Your confidence (mainly for hypothesis/decision)" },
      tags: { type: "array", items: { type: "string" }, description: "Free-form labels" },
      relatesTo: {
        type: "string",
        description: "Id of an earlier notebook entry this one responds to (every notebook call returns its entry id). Pair with `stance`.",
      },
      stance: { type: "string", enum: STANCE, description: "How this entry bears on the `relatesTo` target" },
      supersedes: {
        type: "string",
        description: "Id of an earlier entry this one amends or replaces — use instead of re-logging corrected content without linkage",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          saved: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.saved
          ? `logged notebook entry (id: ${value.id}) — reference this id in relatesTo/supersedes to link later entries`
          : `notebook entry not saved; continue your work.`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const title = (args.title ?? "").trim();
      if (!title) throw new Error("notebook entry needs a non-empty title");
      if (!exec.agent) throw new Error("notebook requires a calling agent (exec.agent was undefined)");

      const dshSessionId = String(exec.agent.id);
      const run = readRunContext(config.kadyDir, dshSessionId);
      const callId = exec.callId ?? `notebook_${Date.now()}`;
      const artifacts = Array.isArray(args.artifacts)
        ? args.artifacts.map((a) => stripSandboxRoot(String(a), config.sandboxRoot))
        : undefined;

      const entry = {
        type: args.type,
        title,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
        ...(args.code !== undefined ? { code: args.code } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.relatesTo !== undefined ? { relatesTo: args.relatesTo } : {}),
        ...(args.stance !== undefined ? { stance: args.stance } : {}),
        ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
        id: String(callId),
        timestamp: Date.now(),
        role: "agent",
        ...(run?.runId ? { runId: run.runId } : {}),
      };

      const sessionId = run?.sessionId;
      if (!sessionId) {
        // No mirrored run context (e.g. a steer call that raced the write) —
        // never abort the run over a notebook write; report softly.
        return { id: String(callId), saved: false };
      }
      try {
        appendNotebookEntry(sessionId, entry, config.projectId);
      } catch {
        return { id: String(callId), saved: false };
      }
      return { id: String(callId), saved: true };
    },
    presentCall: (args) => ({ card: "generic", kind: "other", title: `Notebook: ${args.type}`, rawInput: args.title }),
  }));
}

/**
 * Reproducibility export: reconstruct a session's work from its stored dsh
 * transcript(s) (see `session-history.ts`'s file doc for the multi-generation
 * concept). Scientists need to see — and re-run — exactly what the agent
 * did, so this replays the event log as either:
 *   - a runnable shell script (`sh`): every `bash` command in order, with the
 *     surrounding prompts/notes as comments; or
 *   - a markdown lab notebook (`md`): the full narrative — prompts, reasoning,
 *     each command and its (truncated) output, and the final answers.
 *
 * Uses assembled `assistant/message` events (one per model step, complete
 * text/reasoning/tool-call content blocks) rather than raw `assistant/chunk`
 * deltas — export wants finished content, not live streaming granularity.
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectPaths } from "../projects.ts";
import { relativizeSandboxPaths } from "./events.ts";
import { readSessionLog } from "./dsh/session-log.ts";
import { dshSessionsRoot, getManifest } from "./session-registry.ts";

/** All events across every generation of a ResearchCraft session, in order. */
async function readAllEvents(paths: ProjectPaths, sessionId: string): Promise<SessionEvent[]> {
  const manifest = getManifest(paths, sessionId);
  if (!manifest) return [];
  const root = dshSessionsRoot(paths);
  const out: SessionEvent[] = [];
  for (const generation of manifest.generations) {
    out.push(...(await readSessionLog(root, paths.sandbox, generation.dshSessionId)));
  }
  return out;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function reasoningOf(content: ContentBlock[]): string {
  return content
    .filter((c): c is Extract<ContentBlock, { type: "reasoning" }> => c.type === "reasoning")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function toolCallsOf(content: ContentBlock[]): Extract<ContentBlock, { type: "tool-call" }>[] {
  return content.filter((c): c is Extract<ContentBlock, { type: "tool-call" }> => c.type === "tool-call");
}

/** Index every `tool/result` event by call id, for output lookup beneath each command. */
function indexToolResults(events: SessionEvent[]): Map<string, { text: string; isError: boolean }> {
  const byId = new Map<string, { text: string; isError: boolean }>();
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const block = event.data.message.content[0];
    const text = block.content
      .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    byId.set(String(block.toolCallId), { text, isError: Boolean(block.isError) });
  }
  return byId;
}

/** Quote a command for embedding as a comment without breaking lines. */
function asComment(s: string): string {
  return s
    .split("\n")
    .map((l) => `# ${l}`)
    .join("\n");
}

/**
 * Build a runnable bash script from the session's `bash` tool calls. Non-bash
 * tool calls (read/write/edit) are noted as comments so the script stays a
 * faithful, human-auditable record rather than silently dropping steps.
 */
export async function toShellScript(paths: ProjectPaths, sessionId: string): Promise<string> {
  const sandboxRoot = paths.sandbox;
  const rel = (s: string) => relativizeSandboxPaths(s, sandboxRoot);
  const events = await readAllEvents(paths, sessionId);
  const out: string[] = [
    "#!/usr/bin/env bash",
    "# ---------------------------------------------------------------------------",
    "# Reproducibility export — ResearchCraft",
    `# Session: ${sessionId}`,
    "# Re-runs every shell command the agent executed, in order. Review before",
    "# running: commands ran inside the project sandbox and may assume its files.",
    "# ---------------------------------------------------------------------------",
    "set -euo pipefail",
    "",
  ];
  let stepCount = 0;
  for (const event of events) {
    if (event.type === "user/message") {
      const t = textOf(event.data.content);
      if (t) out.push("", asComment(`PROMPT: ${t}`), "");
      continue;
    }
    if (event.type !== "assistant/message") continue;
    for (const call of toolCallsOf(event.data.message.content)) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments) as unknown;
      } catch {
        args = call.arguments;
      }
      const command = (args as { command?: unknown } | null)?.command;
      if (call.name === "bash" && typeof command === "string") {
        stepCount++;
        out.push(`# [step ${stepCount}]`, rel(command), "");
      } else {
        out.push(asComment(`(non-shell tool: ${call.name} ${JSON.stringify(relativizeSandboxPaths(args, sandboxRoot))})`), "");
      }
    }
  }
  if (stepCount === 0) {
    out.push(asComment("No shell commands were run in this session."));
  }
  return out.join("\n") + "\n";
}

/** Build a markdown "lab notebook" of the full session: prompts, reasoning,
 *  commands, outputs, and final answers. */
export async function toNotebook(paths: ProjectPaths, sessionId: string): Promise<string> {
  const sandboxRoot = paths.sandbox;
  const rel = (s: string) => relativizeSandboxPaths(s, sandboxRoot);
  const events = await readAllEvents(paths, sessionId);
  const resultsById = indexToolResults(events);

  const out: string[] = [
    "# Lab Notebook",
    "",
    `_Session \`${sessionId}\` — reproducible record exported from ResearchCraft._`,
    "",
    "---",
    "",
  ];
  let turn = 0;
  for (const event of events) {
    if (event.type === "user/message") {
      const t = textOf(event.data.content);
      if (!t) continue;
      turn++;
      out.push(`## ${turn}. Prompt`, "", t, "");
      continue;
    }
    if (event.type !== "assistant/message") continue;
    const think = reasoningOf(event.data.message.content);
    if (think) {
      out.push("<details><summary>Reasoning</summary>", "", "> " + think.replace(/\n/g, "\n> "), "", "</details>", "");
    }
    for (const call of toolCallsOf(event.data.message.content)) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments) as unknown;
      } catch {
        args = call.arguments;
      }
      const command = (args as { command?: unknown } | null)?.command;
      if (call.name === "bash" && typeof command === "string") {
        out.push("**Command**", "", "```bash", rel(command), "```", "");
      } else {
        out.push(`**Tool: \`${call.name}\`**`, "", "```json", JSON.stringify(relativizeSandboxPaths(args, sandboxRoot), null, 2), "```", "");
      }
      const result = resultsById.get(String(call.id));
      if (result?.text) {
        const text = rel(result.text);
        const label = result.isError ? "Error" : "Output";
        const clipped = text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text;
        out.push(`**${label}**`, "", "```", clipped, "```", "");
      }
    }
    const t = textOf(event.data.message.content);
    if (t) out.push(t, "");
  }
  return out.join("\n") + "\n";
}

/**
 * Rows for ResearchCraft's 21 named scientific-specialist subagent tools
 * (`server/src/agent/subagents.ts`'s `SUBAGENT_TYPES`). This composes a
 * single local-file plugin (`../../dsh-plugins/persona-subagents.mjs`) that
 * registers one delegation tool per persona directly against `ctx.subagents`
 * — see that file's header comment for why the stock `dsh-tool-subagent`
 * (composed separately by `./subagents.ts`, which stays as the generic
 * catch-all delegation tool) isn't reused for these: its `description` can't
 * vary per persona, and a named-specialist roster's whole value is the model
 * picking the right tool by what its description says it checks.
 *
 * Requires the `spawn` provider (`buildSubagentRows` in `./subagents.ts`) to
 * be composed in the same tree — this row only registers tools, it doesn't
 * bring up a provider of its own.
 */
import { fileURLToPath } from "node:url";
import type { SubagentType } from "../../subagents.ts";
import { row, type PluginRow } from "./rows.ts";

const PLUGIN_PATH = fileURLToPath(
  new URL("../../dsh-plugins/persona-subagents.mjs", import.meta.url),
);

export function buildPersonaSubagentRow(
  personas: readonly SubagentType[],
  options: { provider?: string; maxDepth?: number } = {},
): PluginRow | null {
  if (personas.length === 0) return null;
  return row("persona-subagents", PLUGIN_PATH, {
    provider: options.provider ?? "spawn",
    maxDepth: options.maxDepth ?? 3,
    personas: personas.map((p) => ({
      name: p.name,
      summary: p.summary,
      systemPrompt: p.systemPrompt,
    })),
  });
}

/**
 * Thinking-level wire validation for the run endpoint.
 *
 * Under dsh, reasoning effort is NOT a live per-run knob the way Pi's
 * `session.setModel()`/`session.setThinkingLevel()` were: `dsh-sdk-jsonrpc-server`'s
 * `initialize` fixes `{provider, model, maxTokens}` for a runtime's whole
 * process lifetime (see `session-registry.ts`'s file doc) and passes no
 * `reasoningEffort` through to `ctx.agents.create()` at all — there is
 * currently no SDK-server wire field to carry it. A per-model
 * `reasoningEfforts` map CAN be declared on an `LlmRouteConfig` model entry
 * (`dsh/types.ts`), but that's fixed at compose time, and ResearchCraft's
 * BYOK single-arbitrary-endpoint model (see `models.ts`) has no reliable way
 * to know a given endpoint's supported efforts to declare one. So this stays
 * wire-shape validation only for now — a value the frontend still sends but
 * the backend currently accepts and ignores, same treatment as any other
 * feature this protocol doesn't yet expose (documented gap, not a silent
 * no-op passed off as support).
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** The value as a ThinkingLevel, or undefined if it isn't one. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

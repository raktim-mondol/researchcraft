/**
 * Context-window usage for a live session (used vs model window).
 * `tokens` / `percent` may be null right after compaction until the next turn.
 */

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Suggest compact when this fraction of the window is filled. */
export const CONTEXT_WARN_RATIO = 0.7;
/** Stronger urgency / banner emphasis. */
export const CONTEXT_CRITICAL_RATIO = 0.85;

export type ContextPressure = "ok" | "warn" | "critical" | "unknown";

export function contextPressure(usage: ContextUsage | null | undefined): ContextPressure {
  if (!usage || !(usage.contextWindow > 0)) return "unknown";
  const ratio =
    typeof usage.percent === "number" && Number.isFinite(usage.percent)
      ? usage.percent / 100
      : typeof usage.tokens === "number" && usage.tokens >= 0
        ? usage.tokens / usage.contextWindow
        : null;
  if (ratio === null) return "unknown";
  if (ratio >= CONTEXT_CRITICAL_RATIO) return "critical";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

/** Prefer percent from the server; otherwise derive from tokens/window. */
export function contextRatio(usage: ContextUsage | null | undefined): number | null {
  if (!usage || !(usage.contextWindow > 0)) return null;
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return Math.min(1, Math.max(0, usage.percent / 100));
  }
  if (typeof usage.tokens === "number" && usage.tokens >= 0) {
    return Math.min(1, usage.tokens / usage.contextWindow);
  }
  return null;
}

export function parseContextUsage(raw: unknown): ContextUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const contextWindow =
    typeof o.contextWindow === "number" && o.contextWindow > 0 ? o.contextWindow : 0;
  if (!contextWindow) return null;
  const tokens =
    typeof o.tokens === "number" && Number.isFinite(o.tokens) ? o.tokens : null;
  const percent =
    typeof o.percent === "number" && Number.isFinite(o.percent) ? o.percent : null;
  return { tokens, contextWindow, percent };
}

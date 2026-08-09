"use client";

import { AlertTriangleIcon, LoaderCircleIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  contextPressure,
  contextRatio,
  type ContextUsage,
} from "@/lib/context-usage";
import { cn, formatCompactTokens } from "@/lib/utils";

interface ContextCompactBannerProps {
  context: ContextUsage | null;
  compacting?: boolean;
  disabled?: boolean;
  onCompact: () => void;
  onDismiss: () => void;
}

/**
 * Inline chat suggestion when context is getting full. Parent decides
 * visibility (pressure + not dismissed for this level).
 */
export function ContextCompactBanner({
  context,
  compacting = false,
  disabled = false,
  onCompact,
  onDismiss,
}: ContextCompactBannerProps) {
  const pressure = contextPressure(context);
  if (pressure !== "warn" && pressure !== "critical") return null;
  if (!context) return null;

  const ratio = contextRatio(context);
  const pct = ratio != null ? Math.round(ratio * 100) : null;
  const critical = pressure === "critical";
  const used =
    context.tokens != null ? formatCompactTokens(Math.round(context.tokens)) : "—";
  const total = formatCompactTokens(Math.round(context.contextWindow));

  return (
    <div
      role="status"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        critical
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p>
          <b>
            Context {pct != null ? `${pct}%` : ""} full
          </b>
          {" · "}
          <span className="font-mono tabular-nums">
            {used} / {total}
          </span>
          {critical
            ? " — nearly full. Compact to summarize older turns and free space."
            : " — getting full. Compacting keeps later turns faster and more reliable."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={critical ? "destructive" : "secondary"}
            className="h-7"
            disabled={disabled || compacting}
            onClick={onCompact}
          >
            {compacting ? (
              <>
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Compacting…
              </>
            ) : (
              "Compact now"
            )}
          </Button>
          <span className="text-[11px] opacity-80">
            Does not delete the chat — older turns become a summary.
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded p-0.5 opacity-70 hover:opacity-100"
        aria-label="Dismiss context suggestion"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

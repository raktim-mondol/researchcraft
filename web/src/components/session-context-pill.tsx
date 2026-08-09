"use client";

import { AlertTriangleIcon, BrainCircuitIcon, LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  CONTEXT_CRITICAL_RATIO,
  CONTEXT_WARN_RATIO,
  contextPressure,
  contextRatio,
  type ContextUsage,
} from "@/lib/context-usage";
import { cn, formatCompactTokens } from "@/lib/utils";

interface SessionContextPillProps {
  context: ContextUsage | null;
  loading?: boolean;
  compacting?: boolean;
  onCompact?: () => void;
  /** Disable compact while a run is streaming. */
  compactDisabled?: boolean;
  className?: string;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  return formatCompactTokens(Math.round(n));
}

export function SessionContextPill({
  context,
  loading = false,
  compacting = false,
  onCompact,
  compactDisabled = false,
  className,
}: SessionContextPillProps) {
  if (!context || !(context.contextWindow > 0)) {
    if (!loading) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn(
          "h-auto gap-1.5 px-2.5 py-1 font-mono text-[11px] tabular-nums opacity-70",
          className,
        )}
        disabled
      >
        <BrainCircuitIcon className="size-3" />
        ctx …
      </Button>
    );
  }

  const ratio = contextRatio(context);
  const pressure = contextPressure(context);
  const warn = pressure === "warn";
  const critical = pressure === "critical";
  const usedLabel = formatTokens(context.tokens);
  const totalLabel = formatTokens(context.contextWindow);
  const pctLabel =
    ratio != null ? `${Math.round(ratio * 100)}%` : "—";

  return (
    <HoverCard closeDelay={120} openDelay={80}>
      <HoverCardTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-auto gap-2 px-2.5 py-1 font-mono text-[11px] tabular-nums",
            loading && "opacity-70",
            warn && "border-amber-500/60 text-amber-700 dark:text-amber-400",
            critical && "border-destructive/60 text-destructive",
            className,
          )}
          aria-label={`Context ${usedLabel} of ${totalLabel} (${pctLabel})`}
        >
          {critical || warn ? (
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
          ) : (
            <BrainCircuitIcon className="size-3 shrink-0" aria-hidden />
          )}
          <div className="flex flex-col items-end leading-tight">
            <span className="flex items-baseline gap-1">
              <span className="text-muted-foreground">ctx</span>
              <span className="font-semibold">{usedLabel}</span>
              <span className="text-muted-foreground">/ {totalLabel}</span>
            </span>
            <span className="text-muted-foreground">{pctLabel} used</span>
          </div>
          {ratio != null && (
            <span
              aria-hidden
              className="ml-0.5 h-1 w-10 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width]",
                  critical
                    ? "bg-destructive"
                    : warn
                      ? "bg-amber-500"
                      : "bg-emerald-500",
                )}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </span>
          )}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 space-y-2 text-xs">
        <div>
          <p className="font-medium text-foreground">Context window</p>
          <p className="mt-1 text-muted-foreground">
            How much of the model&apos;s memory this chat is using. When it fills
            up, later turns get slower and more expensive. Compacting summarizes
            older turns so the agent keeps working room.
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono tabular-nums">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right">{usedLabel} tokens</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="text-right">{totalLabel} tokens</dd>
          <dt className="text-muted-foreground">Filled</dt>
          <dd className="text-right">{pctLabel}</dd>
        </dl>
        {context.tokens == null && (
          <p className="text-muted-foreground">
            Usage is unknown until the next model reply (common right after
            compact).
          </p>
        )}
        {(warn || critical) && (
          <p
            className={cn(
              "rounded-md border px-2 py-1.5",
              critical
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
            )}
          >
            {critical
              ? `Context is nearly full (≥${Math.round(CONTEXT_CRITICAL_RATIO * 100)}%). Compact soon to avoid quality loss or auto-compact mid-turn.`
              : `Context is getting full (≥${Math.round(CONTEXT_WARN_RATIO * 100)}%). Consider compacting before the next long research loop.`}
          </p>
        )}
        {onCompact && (
          <Button
            size="sm"
            variant={critical ? "destructive" : "secondary"}
            className="w-full"
            disabled={compactDisabled || compacting}
            onClick={onCompact}
          >
            {compacting ? (
              <>
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Compacting…
              </>
            ) : (
              "Compact context"
            )}
          </Button>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

"use client";

import { useEffect } from "react";
import { BrainCircuitIcon, SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { UNCONFIGURED_MODEL, useModels } from "@/lib/use-models";

export type Model = {
  id: string;
  label: string;
  provider: string;
  tier: "budget" | "mid" | "high" | "flagship";
  context_length: number;
  pricing: { prompt: number; completion: number };
  modality: string | null;
  description: string;
  default?: boolean;
  expertDefault?: boolean;
};

/** @deprecated Prefer the live model from useModels(); kept for callers that need a constant. */
export const DEFAULT_MODEL: Model = UNCONFIGURED_MODEL;

/**
 * Displays the user-configured model (from Settings → API keys).
 * There is no catalogue picker — change the model by editing base URL /
 * API key / model name in Settings.
 */
function openSettings() {
  window.dispatchEvent(new Event("open-settings"));
}

export function ModelSelector({
  selected,
  onChange,
}: {
  selected: Model;
  onChange: (model: Model) => void;
}) {
  const { models, baseUrl, loading, refresh } = useModels();

  // Keep the parent selection in sync with the saved endpoint.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    const configured = models[0];
    if (configured && configured.id !== selected.id) {
      onChange(configured);
    } else if (!configured && selected.id !== UNCONFIGURED_MODEL.id) {
      onChange(UNCONFIGURED_MODEL);
    }
  }, [loading, models, selected.id, onChange]);

  const display = models[0] ?? selected;
  const configured = Boolean(models[0]);

  return (
    <div
      className={cn(
        "flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs select-none",
        configured
          ? "border-transparent bg-muted/40"
          : "border-amber-500/40 bg-amber-500/10 cursor-pointer hover:bg-amber-500/15",
      )}
      role={configured ? "status" : "button"}
      tabIndex={configured ? undefined : 0}
      title={
        configured
          ? baseUrl
            ? `${display.label} @ ${baseUrl}`
            : display.label
          : "Configure base URL, API key, and model name in Settings"
      }
      onClick={() => {
        if (!configured) openSettings();
      }}
      onKeyDown={(e) => {
        if (!configured && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openSettings();
        }
      }}
    >
      {configured ? (
        <BrainCircuitIcon className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <SettingsIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          configured ? "text-foreground" : "text-amber-700 dark:text-amber-400",
        )}
      >
        {loading ? "Loading model…" : display.label}
      </span>
    </div>
  );
}

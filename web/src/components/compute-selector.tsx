"use client";

import { useState, type ReactNode } from "react";
import { CheckIcon, ZapIcon, ChevronDownIcon, ExternalLinkIcon, MonitorIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import modalInstances from "@/data/modal-instances.json";
import runpodInstances from "@/data/runpod-instances.json";

export type ComputeProvider = "local" | "modal" | "runpod";

/** Unified compute target shown in the composer selector. */
export type ComputeInstance = {
  /** Wire id sent as `computeTarget` on /run (null for local). */
  wireId: string | null;
  provider: ComputeProvider;
  /** Bare instance id within the provider ("h100", "rtx4090", …). */
  id: string;
  label: string;
  vram: number | null;
  pricePerHour: number;
  architecture: string | null;
  tier: "cpu" | "budget" | "mid" | "high" | "flagship" | "local";
  bestFor: string;
  description: string;
};

/** @deprecated Use ComputeInstance — kept so existing imports keep typechecking. */
export type ModalInstance = ComputeInstance;

export const LOCAL_INSTANCE: ComputeInstance = {
  wireId: null,
  provider: "local",
  id: "local",
  label: "Local",
  vram: null,
  pricePerHour: 0,
  architecture: null,
  tier: "local",
  bestFor: "Default sandbox environment",
  description: "Run code in the built-in sandbox — no remote compute needed.",
};

type RawModal = {
  id: string;
  label: string;
  modalGpu: string | null;
  vram: number | null;
  pricePerHour: number;
  architecture: string | null;
  tier: ComputeInstance["tier"];
  bestFor: string;
  description: string;
};

type RawRunpod = {
  id: string;
  label: string;
  gpuTypeId: string | null;
  vram: number | null;
  pricePerHour: number;
  architecture: string | null;
  tier: ComputeInstance["tier"];
  bestFor: string;
  description: string;
};

const MODAL_INSTANCES: ComputeInstance[] = (modalInstances as RawModal[]).map((i) => ({
  wireId: i.id, // bare Modal ids stay backward-compatible
  provider: "modal" as const,
  id: i.id,
  label: i.label,
  vram: i.vram,
  pricePerHour: i.pricePerHour,
  architecture: i.architecture,
  tier: i.tier,
  bestFor: i.bestFor,
  description: i.description,
}));

const RUNPOD_INSTANCES: ComputeInstance[] = (runpodInstances as RawRunpod[]).map((i) => ({
  wireId: `runpod:${i.id}`,
  provider: "runpod" as const,
  id: i.id,
  label: i.label,
  vram: i.vram,
  pricePerHour: i.pricePerHour,
  architecture: i.architecture,
  tier: i.tier,
  bestFor: i.bestFor,
  description: i.description,
}));

const TIER_STYLES: Record<string, { dot: string; badge: string }> = {
  local:    { dot: "bg-emerald-400", badge: "text-emerald-600 dark:text-emerald-400" },
  cpu:      { dot: "bg-slate-400",   badge: "text-slate-500" },
  budget:   { dot: "bg-sky-400",     badge: "text-sky-600 dark:text-sky-400" },
  mid:      { dot: "bg-violet-500",  badge: "text-violet-600 dark:text-violet-400" },
  high:     { dot: "bg-amber-500",   badge: "text-amber-600 dark:text-amber-400" },
  flagship: { dot: "bg-rose-500",    badge: "text-rose-600 dark:text-rose-400" },
};

function TierDot({ tier }: { tier: string }) {
  return (
    <span className={cn("inline-block size-1.5 rounded-full shrink-0", TIER_STYLES[tier]?.dot ?? "bg-muted")} />
  );
}

function InstanceRow({
  instance,
  effective,
  enabled,
  onSelect,
}: {
  instance: ComputeInstance;
  effective: ComputeInstance;
  enabled: boolean;
  onSelect: (instance: ComputeInstance) => void;
}) {
  const isSelected =
    effective.provider === instance.provider && effective.id === instance.id;
  const styles = TIER_STYLES[instance.tier];
  const isLocal = instance.provider === "local";

  const row = (
    <div
      key={`${instance.provider}:${instance.id}`}
      onClick={() => enabled && onSelect(instance)}
      className={cn(
        "flex items-start gap-2.5 px-3 py-2.5 text-xs transition-colors",
        enabled ? "cursor-pointer hover:bg-muted/60" : "cursor-not-allowed opacity-50",
        isSelected && enabled && "bg-muted/40",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
          isSelected && enabled
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background",
        )}
      >
        {isSelected && enabled && <CheckIcon className="size-2" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <TierDot tier={instance.tier} />
          <span className={cn("font-semibold", enabled ? "text-foreground" : "text-muted-foreground")}>
            {instance.label}
          </span>
          {isLocal ? (
            <span className="text-muted-foreground">Sandbox</span>
          ) : instance.vram ? (
            <span className="text-muted-foreground">{instance.vram}GB VRAM</span>
          ) : (
            <span className="text-muted-foreground">No GPU</span>
          )}
          {!isLocal && (
            <span
              className={cn(
                "ml-auto text-[10px] font-medium tabular-nums",
                enabled ? styles.badge : "text-muted-foreground",
              )}
            >
              ${instance.pricePerHour}/hr
            </span>
          )}
          {isLocal && (
            <span className={cn("ml-auto text-[10px] font-medium", styles.badge)}>Free</span>
          )}
        </div>
        <p className="mt-0.5 text-muted-foreground/80 leading-relaxed">{instance.description}</p>
      </div>
    </div>
  );

  if (!enabled) {
    return (
      <Tooltip key={`${instance.provider}:${instance.id}`}>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-56">
          {instance.provider === "modal"
            ? "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in Settings → API keys"
            : "Set RUNPOD_API_KEY in Settings → API keys"}
        </TooltipContent>
      </Tooltip>
    );
  }
  return row;
}

function ProviderBanner({
  configured,
  provider,
  keysLabel,
  keysUrl,
  accountLabel,
}: {
  configured: boolean;
  provider: string;
  keysLabel: ReactNode;
  keysUrl: string;
  accountLabel: string;
}) {
  if (configured) return null;
  return (
    <div className="flex items-start gap-2.5 border-b bg-amber-500/5 px-3 py-2.5">
      <div className="mt-0.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
      <div className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{provider} API key not configured.</span>{" "}
        Set {keysLabel} in{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">Settings → API keys</code>.
        <a
          href={keysUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
        >
          Get a key at {accountLabel}
          <ExternalLinkIcon className="size-2.5" />
        </a>
      </div>
    </div>
  );
}

/**
 * Picker UI for compute selection — no trigger / no popover wrapper.
 */
export function ComputePickerBody({
  selected,
  onChange,
  modalConfigured = true,
  runpodConfigured = true,
  onSelected,
}: {
  selected: ComputeInstance | null;
  onChange: (instance: ComputeInstance | null) => void;
  modalConfigured?: boolean;
  runpodConfigured?: boolean;
  onSelected?: () => void;
}) {
  const effective = selected ?? LOCAL_INSTANCE;

  const handleSelect = (instance: ComputeInstance) => {
    if (instance.provider === "modal" && !modalConfigured) return;
    if (instance.provider === "runpod" && !runpodConfigured) return;
    onChange(instance.provider === "local" ? null : instance);
    onSelected?.();
  };

  return (
    <>
      <TooltipProvider>
        <div className="max-h-96 overflow-y-auto py-1">
          <InstanceRow
            instance={LOCAL_INSTANCE}
            effective={effective}
            enabled
            onSelect={handleSelect}
          />

          <div className="my-1 border-t px-3 pt-1.5 pb-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Modal Compute
            </span>
          </div>
          <ProviderBanner
            configured={modalConfigured}
            provider="Modal"
            keysLabel={
              <>
                <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">MODAL_TOKEN_ID</code>
                {" + "}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">MODAL_TOKEN_SECRET</code>
              </>
            }
            keysUrl="https://modal.com/settings/tokens"
            accountLabel="modal.com"
          />
          {MODAL_INSTANCES.map((instance) => (
            <InstanceRow
              key={`modal:${instance.id}`}
              instance={instance}
              effective={effective}
              enabled={modalConfigured}
              onSelect={handleSelect}
            />
          ))}

          <div className="my-1 border-t px-3 pt-1.5 pb-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Runpod Compute
            </span>
          </div>
          <ProviderBanner
            configured={runpodConfigured}
            provider="Runpod"
            keysLabel={
              <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">RUNPOD_API_KEY</code>
            }
            keysUrl="https://console.runpod.io/user/settings"
            accountLabel="console.runpod.io"
          />
          {RUNPOD_INSTANCES.map((instance) => (
            <InstanceRow
              key={`runpod:${instance.id}`}
              instance={instance}
              effective={effective}
              enabled={runpodConfigured}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </TooltipProvider>

      <div className="border-t px-3 py-2 space-y-1.5">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Sets the default GPU for remote jobs. The agent calls{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">modal_run</code> or{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">runpod_run</code>{" "}
          to upload sandbox files, run on the cloud, and copy results back. Local
          stays free; remote wall-time is billed on your Modal/Runpod account and
          counted toward the project budget.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {Object.entries(TIER_STYLES)
            .filter(([tier]) => tier !== "local")
            .map(([tier, s]) => (
              <span key={tier} className="flex items-center gap-1 text-[10px] text-muted-foreground capitalize">
                <span className={cn("inline-block size-1.5 rounded-full", s.dot)} />
                {tier}
              </span>
            ))}
        </div>
      </div>
    </>
  );
}

export function ComputeSelector({
  selected,
  onChange,
  modalConfigured = true,
  runpodConfigured = true,
}: {
  selected: ComputeInstance | null;
  onChange: (instance: ComputeInstance | null) => void;
  modalConfigured?: boolean;
  runpodConfigured?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const effective = selected ?? LOCAL_INSTANCE;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 cursor-pointer transition-colors text-xs select-none",
            open || selected
              ? "border-border bg-muted/60"
              : "border-transparent hover:border-border hover:bg-muted/40",
          )}
          role="button"
          tabIndex={0}
        >
          {effective.provider === "local" ? (
            <>
              <MonitorIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="whitespace-nowrap text-muted-foreground">Local</span>
            </>
          ) : (
            <>
              <ZapIcon className="size-3 shrink-0 text-muted-foreground" />
              <TierDot tier={effective.tier} />
              <span className="min-w-0 truncate font-medium text-foreground">
                {effective.provider === "runpod" ? "RP " : ""}
                {effective.label}
              </span>
              {effective.vram && (
                <span className="shrink-0 text-muted-foreground">{effective.vram}GB</span>
              )}
              <span className={cn("shrink-0 text-[10px]", TIER_STYLES[effective.tier]?.badge)}>
                ${effective.pricePerHour}/hr
              </span>
            </>
          )}
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform ml-0.5",
              open && "rotate-180",
            )}
          />
        </div>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 p-0 overflow-hidden rounded-xl shadow-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Compute
          </span>
        </div>
        <ComputePickerBody
          selected={selected}
          onChange={onChange}
          modalConfigured={modalConfigured}
          runpodConfigured={runpodConfigured}
          onSelected={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

// The selected instance is threaded to the backend as `computeTarget` on the
// run request (`wireId`) and read by modal_run / runpod_run as their default.

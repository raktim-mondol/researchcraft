"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import {
  KeyIcon,
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  LayersIcon,
  BotIcon,
  PlugIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/projects";
import { SkillsPanel } from "@/components/skills-panel";
import { SubagentsPanel } from "@/components/subagents-panel";
import { ConnectorsPanel } from "@/components/connectors-panel";

type CredentialEntry = { set: boolean; masked: string | null; value?: string };
type CredentialStatus = Record<string, CredentialEntry>;

interface KeyDef {
  id: string;
  bodyField: string;
  label: string;
  placeholder: string;
  keysUrl: string;
  hint: string;
}

/** Optional keys only — the LLM endpoint is a separate form above. */
const KEY_DEFS: KeyDef[] = [
  {
    id: "exa",
    bodyField: "exaApiKey",
    label: "Exa API key (optional)",
    placeholder: "exa-…",
    keysUrl: "https://dashboard.exa.ai/api-keys",
    hint: "Direct Exa web + code search. Without it, web search still works via a free Exa fallback.",
  },
  {
    id: "perplexity",
    bodyField: "perplexityApiKey",
    label: "Perplexity API key (optional)",
    placeholder: "pplx-…",
    keysUrl: "https://www.perplexity.ai/settings/api",
    hint: "Synthesized web answers with citations as an alternative search provider.",
  },
  {
    id: "gemini",
    bodyField: "geminiApiKey",
    label: "Gemini API key (optional)",
    placeholder: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
    hint: "Search fallback plus YouTube and video understanding for fetched links.",
  },
  {
    id: "parallel",
    bodyField: "parallelApiKey",
    label: "Parallel API key (optional)",
    placeholder: "…",
    keysUrl: "https://platform.parallel.ai",
    hint: "Higher rate limits for Parallel Search MCP (web search). Works free without a key; set one for production use.",
  },
  {
    id: "firecrawl",
    bodyField: "firecrawlApiKey",
    label: "Firecrawl API key (optional)",
    placeholder: "fc-…",
    keysUrl: "https://www.firecrawl.dev/app/api-keys",
    hint: "Full Firecrawl MCP tools (scrape, crawl, extract, agent). Keyless free tier covers scrape/search/interact with lower limits.",
  },
  {
    id: "modalTokenId",
    bodyField: "modalTokenId",
    label: "Modal Token ID (optional)",
    placeholder: "ak-…",
    keysUrl: "https://modal.com/settings/tokens",
    hint: "Enables remote compute — the agent can run jobs on a Modal sandbox (CPU/GPU). Pair with the Token Secret below.",
  },
  {
    id: "modalTokenSecret",
    bodyField: "modalTokenSecret",
    label: "Modal Token Secret (optional)",
    placeholder: "as-…",
    keysUrl: "https://modal.com/settings/tokens",
    hint: "The secret half of your Modal token pair. Both must be set to run jobs on Modal.",
  },
  {
    id: "runpodApiKey",
    bodyField: "runpodApiKey",
    label: "Runpod API Key (optional)",
    placeholder: "rpa_…",
    keysUrl: "https://console.runpod.io/user/settings",
    hint: "Enables remote GPU/CPU pods — the agent can offload jobs via runpod_run (datasets, training, inference). Billed on your Runpod account. After saving, open a new chat tab so the tool registers; pick a Runpod GPU in the Compute chip.",
  },
];

function KeyRow({
  def,
  current,
  onStatus,
}: {
  def: KeyDef;
  current: CredentialEntry | undefined;
  onStatus: (status: CredentialStatus) => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = useCallback(
    async (value: string | null) => {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const res = await apiFetch("/credentials", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [def.bodyField]: value }),
        });
        const data = (await res.json().catch(() => null)) as
          | (CredentialStatus & { detail?: string })
          | null;
        if (!res.ok) throw new Error(data?.detail || `Save failed (${res.status})`);
        if (data) onStatus(data as CredentialStatus);
        setKeyInput("");
        setSaved(true);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [def.bodyField, onStatus],
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium">
        <a
          href={def.keysUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          {def.label}
        </a>
      </label>
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {current?.set && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <span>
            Key set — <code className="font-mono">{current.masked}</code>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-[11px] text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => void submit(null)}
          >
            Clear
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={keyInput}
          autoComplete="off"
          placeholder={current?.set ? `Replace key (${def.placeholder})` : def.placeholder}
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setKeyInput(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyInput.trim()) void submit(keyInput.trim());
          }}
        />
        <Button
          size="sm"
          className="text-xs"
          disabled={saving || !keyInput.trim()}
          onClick={() => void submit(keyInput.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {saved && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          Saved. New runs use it immediately — no restart needed.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground leading-relaxed">{def.hint}</p>
    </div>
  );
}

/** Primary model endpoint — base URL + API key + model name + context window. */
function LlmEndpointForm({
  status,
  onStatus,
}: {
  status: CredentialStatus | null;
  onStatus: (status: CredentialStatus) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Populate from server once status arrives (and only once so we don't
  // clobber in-progress edits if status refreshes).
  useEffect(() => {
    if (!status || hydrated) return;
    setBaseUrl(status.llmBaseUrl?.value ?? "");
    setModel(status.llmModel?.value ?? "");
    setContextWindow(status.llmContextWindow?.value ?? "");
    setHydrated(true);
  }, [status, hydrated]);

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, string | null> = {
        llmBaseUrl: baseUrl.trim() || null,
        llmModel: model.trim() || null,
        // Empty → clear env var so the server uses the 1M default.
        llmContextWindow: contextWindow.trim() || null,
      };
      // Only send the key when the user typed a new one (empty = leave as-is).
      if (apiKey.trim()) body.llmApiKey = apiKey.trim();
      const res = await apiFetch("/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | (CredentialStatus & { detail?: string })
        | null;
      if (!res.ok) throw new Error(data?.detail || `Save failed (${res.status})`);
      if (data) onStatus(data as CredentialStatus);
      setApiKey("");
      // Reflect normalized value from the server (e.g. stripped commas).
      setContextWindow(data?.llmContextWindow?.value ?? contextWindow.trim());
      setSaved(true);
      window.dispatchEvent(new Event("llm-config-changed"));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [baseUrl, apiKey, model, contextWindow, onStatus]);

  const clearAll = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llmBaseUrl: null,
          llmApiKey: null,
          llmModel: null,
          llmContextWindow: null,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (CredentialStatus & { detail?: string })
        | null;
      if (!res.ok) throw new Error(data?.detail || `Clear failed (${res.status})`);
      if (data) onStatus(data as CredentialStatus);
      setBaseUrl("");
      setApiKey("");
      setModel("");
      setContextWindow("");
      setSaved(true);
      window.dispatchEvent(new Event("llm-config-changed"));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Clear failed");
    } finally {
      setSaving(false);
    }
  }, [onStatus]);

  const canSave = Boolean(baseUrl.trim() && model.trim());

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <div>
        <h4 className="text-xs font-medium">Model endpoint</h4>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          Point ResearchCraft at any OpenAI-compatible API. Saved to{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">.env</code>{" "}
          on this machine — every chat uses this model.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" htmlFor="llm-base-url">
          Base URL
        </label>
        <Input
          id="llm-base-url"
          type="url"
          value={baseUrl}
          autoComplete="off"
          placeholder="https://api.openai.com/v1"
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setSaved(false);
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          Include the <code className="text-[10px]">/v1</code> path when the
          provider requires it (OpenAI, Ollama OpenAI-compat, OpenRouter, …).
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" htmlFor="llm-api-key">
          API key
        </label>
        {status?.llmApiKey?.set && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <span>
              Key set — <code className="font-mono">{status.llmApiKey.masked}</code>
            </span>
          </div>
        )}
        <Input
          id="llm-api-key"
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={
            status?.llmApiKey?.set
              ? "Leave blank to keep current key"
              : "sk-… (optional for some local servers)"
          }
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" htmlFor="llm-model">
          Model name
        </label>
        <Input
          id="llm-model"
          type="text"
          value={model}
          autoComplete="off"
          placeholder="gpt-4o"
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setModel(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) void submit();
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          Exact model id your endpoint expects (e.g.{" "}
          <code className="text-[10px]">gpt-4o</code>,{" "}
          <code className="text-[10px]">claude-sonnet-4</code>,{" "}
          <code className="text-[10px]">llama3.2</code>).
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" htmlFor="llm-context-window">
          Context window (tokens)
        </label>
        <Input
          id="llm-context-window"
          type="text"
          inputMode="numeric"
          value={contextWindow}
          autoComplete="off"
          placeholder="1000000 (default)"
          className="h-8 text-xs font-mono"
          onChange={(e) => {
            setContextWindow(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) void submit();
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          From your model docs / OpenRouter{" "}
          <code className="text-[10px]">context_length</code>. Used for the
          context meter and compaction — leave blank to use the 1M default.
        </p>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="text-xs"
          disabled={saving || !canSave}
          onClick={() => void submit()}
        >
          {saving ? "Saving…" : "Save model"}
        </Button>
        {(status?.llmBaseUrl?.set ||
          status?.llmModel?.set ||
          status?.llmApiKey?.set ||
          status?.llmContextWindow?.set) && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => void clearAll()}
          >
            Clear
          </Button>
        )}
      </div>
      {saved && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          Saved. New runs use this endpoint immediately — no restart needed.
        </p>
      )}
    </div>
  );
}

function ApiKeysPanel() {
  const [statusState, setStatusState] = useState<CredentialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/credentials");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      setStatusState((await res.json()) as CredentialStatus);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">API keys</h3>
        <p className="text-xs text-muted-foreground mt-1">
          ResearchCraft is bring-your-own-key. Credentials stay on this machine
          (saved to{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env</code>
          ) — nothing is sent to ResearchCraft servers. Configure your model
          endpoint below; search, Modal, and Runpod keys are optional.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          <LlmEndpointForm status={statusState} onStatus={setStatusState} />
          <div className="border-t pt-4">
            <h4 className="text-xs font-medium mb-3 text-muted-foreground">
              Optional integrations
            </h4>
            <div className="flex flex-col gap-5">
              {KEY_DEFS.map((def) => (
                <KeyRow
                  key={def.id}
                  def={def}
                  current={statusState?.[def.id]}
                  onStatus={setStatusState}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AppearancePanel() {
  const { theme, setTheme } = useTheme();

  const options: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Appearance</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Choose how ResearchCraft looks. System follows your operating
          system&apos;s theme.
        </p>
      </div>

      <div className="flex gap-2">
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = theme === opt.value;
          return (
            <Button
              key={opt.value}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(opt.value)}
              className={cn("flex-1 gap-1.5 text-xs")}
            >
              <Icon className="size-3.5" />
              {opt.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-2xl h-[min(560px,80dvh)] flex flex-col gap-0 p-0 overflow-hidden"
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-xs">
            Configure your workspace preferences.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="api-keys"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="api-keys"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <KeyIcon className="size-3.5" />
              API keys
            </TabsTrigger>
            <TabsTrigger
              value="skills"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <LayersIcon className="size-3.5" />
              Skills
            </TabsTrigger>
            <TabsTrigger
              value="specialists"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <BotIcon className="size-3.5" />
              Specialists
            </TabsTrigger>
            <TabsTrigger
              value="connectors"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PlugIcon className="size-3.5" />
              Connectors
            </TabsTrigger>
            <TabsTrigger
              value="appearance"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PaletteIcon className="size-3.5" />
              Appearance
            </TabsTrigger>
          </TabsList>

          <TabsContent value="api-keys" className="flex-1 min-h-0 p-5">
            <ApiKeysPanel />
          </TabsContent>
          <TabsContent value="skills" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SkillsPanel />
          </TabsContent>
          <TabsContent value="specialists" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SubagentsPanel />
          </TabsContent>
          <TabsContent value="connectors" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <ConnectorsPanel />
          </TabsContent>
          <TabsContent value="appearance" className="flex-1 min-h-0 p-5">
            <AppearancePanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

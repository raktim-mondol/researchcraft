"use client";

/**
 * Customize hub → "Connectors" panel.
 *
 * Relocated from settings-dialog.tsx's McpServersPanel, with enable/disable
 * added: servers can be toggled off (kept configured but excluded from the
 * agent's tool set) without deleting them.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  GlobeIcon,
  TerminalIcon,
  PencilIcon,
  Trash2Icon,
  PlusIcon,
  KeyRoundIcon,
  BookOpenIcon,
} from "lucide-react";
import { useProjects } from "@/lib/use-projects";
import {
  getMcpListing,
  saveMcpServers,
  setConnectorEnabled,
  testMcpServer,
  startMcpOAuth,
  disconnectMcpOAuth,
  isHttpConfig,
  type McpServers,
  type McpServerConfig,
  type OAuthCatalogEntry,
  type OAuthStatusEntry,
} from "@/lib/mcp";

interface McpFormState {
  /** Key being edited, or null when adding a new server. */
  originalName: string | null;
  name: string;
  type: "http" | "stdio";
  url: string;
  bearerToken: string;
  /** Non-Authorization headers preserved across edits (not shown in the form). */
  extraHeaders: Record<string, string>;
  command: string;
  args: string;
  env: string;
}

const EMPTY_MCP_FORM: McpFormState = {
  originalName: null,
  name: "",
  type: "http",
  url: "",
  bearerToken: "",
  extraHeaders: {},
  command: "",
  args: "",
  env: "",
};

function formFromConfig(name: string, config: McpServerConfig): McpFormState {
  if (isHttpConfig(config)) {
    const { Authorization, ...extraHeaders } = config.headers ?? {};
    return {
      ...EMPTY_MCP_FORM,
      originalName: name,
      name,
      type: "http",
      url: config.url,
      bearerToken: (Authorization ?? "").replace(/^Bearer\s+/i, ""),
      extraHeaders,
    };
  }
  return {
    ...EMPTY_MCP_FORM,
    originalName: name,
    name,
    type: "stdio",
    command: config.command,
    args: (config.args ?? []).join(" "),
    env: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

function configFromForm(form: McpFormState): McpServerConfig {
  if (form.type === "http") {
    const headers: Record<string, string> = { ...form.extraHeaders };
    if (form.bearerToken.trim()) {
      headers.Authorization = `Bearer ${form.bearerToken.trim()}`;
    }
    return {
      url: form.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
  const env: Record<string, string> = {};
  for (const line of form.env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return {
    command: form.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function summarizeConfig(config: McpServerConfig): string {
  if (isHttpConfig(config)) return config.url;
  return [config.command, ...(config.args ?? [])].join(" ");
}

export function ConnectorsPanel() {
  const { activeProject, activeProjectId } = useProjects();
  const [servers, setServers] = useState<McpServers>({});
  const [disabled, setDisabled] = useState<McpServers>({});
  const [oauth, setOauth] = useState<Record<string, OAuthStatusEntry>>({});
  const [oauthCatalog, setOauthCatalog] = useState<Record<string, OAuthCatalogEntry>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<McpFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const listing = await getMcpListing();
    setServers(listing.mcpServers);
    setDisabled(listing.disabledServers);
    setOauth(listing.oauth);
    setOauthCatalog(listing.oauthCatalog);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForm(null);
    getMcpListing()
      .then((listing) => {
        if (!cancelled) {
          setServers(listing.mcpServers);
          setDisabled(listing.disabledServers);
          setOauth(listing.oauth);
          setOauthCatalog(listing.oauthCatalog);
        }
      })
      .catch((exc) => {
        if (!cancelled) {
          setError(exc instanceof Error ? exc.message : "Failed to load MCP servers");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const persist = useCallback(async (next: McpServers) => {
    setSaving(true);
    setError(null);
    try {
      await saveMcpServers(next);
      setServers(next);
      setForm(null);
      setTestResult(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setError("Server name is required");
      return;
    }
    const next: McpServers = { ...servers };
    if (form.originalName && form.originalName !== name) {
      delete next[form.originalName];
    }
    next[name] = configFromForm(form);
    await persist(next);
  }, [form, servers, persist]);

  const handleDelete = useCallback(
    async (name: string) => {
      const next = { ...servers };
      delete next[name];
      await persist(next);
    },
    [servers, persist]
  );

  const handleTest = useCallback(async () => {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await testMcpServer(form.name.trim() || "server", configFromForm(form));
      setTestResult(
        result.ok
          ? `Connected — ${result.tools?.length ?? 0} tool${(result.tools?.length ?? 0) === 1 ? "" : "s"}: ${(result.tools ?? []).slice(0, 8).join(", ")}${(result.tools?.length ?? 0) > 8 ? ", …" : ""}`
          : `Connection failed: ${result.detail ?? "unknown error"}`
      );
    } catch (exc) {
      setTestResult(
        `Connection failed: ${exc instanceof Error ? exc.message : "unknown error"}`
      );
    } finally {
      setTesting(false);
    }
  }, [form]);

  const toggle = useCallback(async (name: string, next: boolean) => {
    setError(null);
    try {
      await setConnectorEnabled(name, next);
      await reload();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Toggle failed");
    }
  }, [reload]);

  const handleOAuthSignIn = useCallback(
    async (name: string) => {
      setOauthBusy(name);
      setOauthMsg(null);
      setError(null);
      try {
        const result = await startMcpOAuth(name);
        if (!result.ok) {
          setError(result.detail || "OAuth failed to start");
          return;
        }
        if (result.alreadyConnected) {
          setOauthMsg(
            `${oauthCatalog[name]?.label ?? name} is already signed in (${result.tools.length} tools). Open a new chat tab to use them.`,
          );
          await reload();
          return;
        }
        // Open the provider authorize page; callback hits the backend and
        // writes tokens. Poll status so the UI flips to Connected.
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        setOauthMsg(
          `Complete sign-in in the browser window, then return here. Status updates automatically.`,
        );
        const started = Date.now();
        while (Date.now() - started < 3 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 2000));
          const listing = await getMcpListing();
          setOauth(listing.oauth);
          if (listing.oauth[name]?.connected) {
            setOauthMsg(
              `Connected to ${listing.oauth[name].label}. Open a new chat tab to use literature search.`,
            );
            break;
          }
        }
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "OAuth failed");
      } finally {
        setOauthBusy(null);
      }
    },
    [oauthCatalog, reload],
  );

  const handleOAuthSignOut = useCallback(
    async (name: string) => {
      setOauthBusy(name);
      setOauthMsg(null);
      setError(null);
      try {
        await disconnectMcpOAuth(name);
        await reload();
        setOauthMsg(`Signed out of ${oauthCatalog[name]?.label ?? name}.`);
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : "Sign out failed");
      } finally {
        setOauthBusy(null);
      }
    },
    [oauthCatalog, reload],
  );

  const names = Object.keys(servers).sort();
  const oauthNames = Object.keys(oauthCatalog).filter(
    (n) => n in servers || n in disabled,
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h3 className="text-sm font-medium">Connectors</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Connect Model Context Protocol servers to give the agent extra tools.
          Connectors are configured per project (current:{" "}
          <span className="font-medium">{activeProject?.name ?? activeProjectId}</span>
          ) and stored locally in the project sandbox. Changes apply to new chat
          tabs. <strong>Scite</strong> and <strong>Consensus</strong> use OAuth
          (Sign in below) for scientific literature search.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {oauthMsg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          {oauthMsg}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {oauthNames.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <BookOpenIcon className="size-3.5" />
                Scientific literature (OAuth)
              </div>
              {oauthNames.map((name) => {
                const cat = oauthCatalog[name];
                const status = oauth[name];
                const connected = Boolean(status?.connected);
                const enabled = name in servers;
                return (
                  <div
                    key={`oauth-${name}`}
                    className="flex flex-col gap-2 rounded-lg border px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{cat?.label ?? name}</span>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-medium",
                              connected
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {connected ? "Signed in" : "Not signed in"}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                          {cat?.description}
                          {cat?.docsUrl && (
                            <>
                              {" "}
                              <a
                                href={cat.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-foreground"
                              >
                                Docs
                              </a>
                            </>
                          )}
                        </p>
                      </div>
                      {enabled && (
                        <Switch
                          aria-label={`Toggle ${name}`}
                          checked
                          onCheckedChange={() => void toggle(name, false)}
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pl-5">
                      {connected ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={oauthBusy === name}
                          onClick={() => void handleOAuthSignOut(name)}
                        >
                          {oauthBusy === name ? "Working…" : "Sign out"}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="h-7 text-[11px]"
                          disabled={oauthBusy === name || !enabled}
                          onClick={() => void handleOAuthSignIn(name)}
                        >
                          {oauthBusy === name ? "Opening…" : "Sign in"}
                        </Button>
                      )}
                      {!enabled && (
                        <span className="text-[11px] text-muted-foreground">
                          Enable the connector (below) to use it in chat.
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {names.length === 0 && !form && (
            <div className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground leading-relaxed">
              No connectors configured for this project yet.
            </div>
          )}

          {names.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">All connectors</div>
              {names.map((name) => {
                const config = servers[name];
                const http = isHttpConfig(config);
                const isOauth = name in oauthCatalog;
                return (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    {http ? (
                      <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">
                        {isOauth ? (oauthCatalog[name]?.label ?? name) : name}
                        {isOauth && (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                            ({name})
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {summarizeConfig(config)}
                      </div>
                    </div>
                    <Switch
                      aria-label={`Toggle ${name}`}
                      checked
                      onCheckedChange={() => void toggle(name, false)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      aria-label={`Edit ${name}`}
                      onClick={() => {
                        setTestResult(null);
                        setForm(formFromConfig(name, config));
                      }}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0 text-destructive hover:text-destructive"
                      aria-label={`Remove ${name}`}
                      disabled={saving}
                      onClick={() => void handleDelete(name)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {Object.keys(disabled).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">Disabled</div>
              {Object.keys(disabled)
                .sort()
                .map((name) => (
                  <div key={name} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 opacity-70">
                    <div className="min-w-0 flex-1 text-xs font-medium">{name}</div>
                    <Switch
                      aria-label={`Toggle ${name}`}
                      checked={false}
                      onCheckedChange={() => void toggle(name, true)}
                    />
                  </div>
                ))}
            </div>
          )}

          {form ? (
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Name</label>
                <Input
                  value={form.name}
                  placeholder="e.g. linear"
                  className="h-8 text-xs"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                {(
                  [
                    { value: "http", label: "Remote (HTTP)", icon: GlobeIcon },
                    { value: "stdio", label: "Local (command)", icon: TerminalIcon },
                  ] as const
                ).map((opt) => (
                  <Button
                    key={opt.value}
                    variant={form.type === opt.value ? "default" : "outline"}
                    size="sm"
                    className="flex-1 gap-1.5 text-xs"
                    onClick={() => setForm({ ...form, type: opt.value })}
                  >
                    <opt.icon className="size-3.5" />
                    {opt.label}
                  </Button>
                ))}
              </div>

              {form.type === "http" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Server URL</label>
                    <Input
                      value={form.url}
                      placeholder="https://mcp.example.com/mcp"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Bearer token{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <Input
                      type="password"
                      value={form.bearerToken}
                      placeholder="Sent as Authorization: Bearer …"
                      className="h-8 text-xs"
                      autoComplete="off"
                      onChange={(e) => setForm({ ...form, bearerToken: e.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Command</label>
                    <Input
                      value={form.command}
                      placeholder="npx"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Arguments{" "}
                      <span className="font-normal text-muted-foreground">
                        (space-separated)
                      </span>
                    </label>
                    <Input
                      value={form.args}
                      placeholder="-y @modelcontextprotocol/server-github"
                      className="h-8 text-xs"
                      onChange={(e) => setForm({ ...form, args: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">
                      Environment variables{" "}
                      <span className="font-normal text-muted-foreground">
                        (KEY=value, one per line)
                      </span>
                    </label>
                    <Textarea
                      value={form.env}
                      placeholder={"GITHUB_TOKEN=ghp_…"}
                      className="min-h-16 text-xs font-mono"
                      onChange={(e) => setForm({ ...form, env: e.target.value })}
                    />
                  </div>
                </>
              )}

              {testResult && (
                <div
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed",
                    testResult.startsWith("Connected")
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-destructive/50 bg-destructive/10 text-destructive"
                  )}
                >
                  {testResult}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="text-xs"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? "Saving…" : form.originalName ? "Save changes" : "Add server"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={testing}
                  onClick={() => void handleTest()}
                >
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-xs"
                  onClick={() => {
                    setForm(null);
                    setTestResult(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 self-start text-xs"
              onClick={() => {
                setTestResult(null);
                setForm({ ...EMPTY_MCP_FORM });
              }}
            >
              <PlusIcon className="size-3.5" />
              Add server
            </Button>
          )}
        </>
      )}
    </div>
  );
}

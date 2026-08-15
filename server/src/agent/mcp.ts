/**
 * MCP config: per-project Model Context Protocol server configuration, CRUD,
 * and a connection self-test — the config-management half of MCP support.
 *
 * Live tool wiring is no longer done here: under Pi (which has no built-in
 * MCP support) this file also dialed every configured server with the MCP
 * SDK directly and wrapped each tool as a Pi `ToolDefinition`. dsh has native
 * MCP support (`dsh-mcp-client`, composed per project as one plugin row per
 * server — see `dsh/compose/mcp.ts` and `resolveDshMcpServers` below), so the
 * live-connection/tool-wrapping layer that used to live in this file is gone;
 * `session-registry.ts` translates `readMcpConfig()`'s output into dsh's
 * `McpServerConfig[]` composition shape once per runtime spawn.
 *
 * Configuration still lives per project at `sandbox/.pi/mcp.json` (same
 * convention as Claude Desktop / Claude Code, and unchanged from Pi — this is
 * ResearchCraft's own config format, independent of which agent runtime
 * reads it):
 *
 *   {
 *     "mcpServers": {
 *       "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *                    "env": { "GITHUB_TOKEN": "..." } },
 *       "linear":  { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "..." } }
 *     }
 *   }
 *
 * `command` entries use stdio transport; `url` entries use streamable HTTP.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProjectPaths } from "../projects.ts";
import type { ToggleResult } from "./capability-state.ts";
import type { McpServerConfig as DshMcpServerConfig } from "./dsh/types.ts";
import { resolveManagedSearchConfig } from "./search-mcp.ts";
import { isManagedOAuthConfig, silentOAuthProvider } from "./mcp-oauth.ts";

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

const CONNECT_TIMEOUT_MS = 30_000;

function mcpConfigPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "mcp.json");
}

function readConfigText(paths: ProjectPaths): string {
  try {
    return fs.readFileSync(mcpConfigPath(paths), "utf-8");
  } catch {
    return "";
  }
}

function parseConfig(text: string): Record<string, McpServerConfig> {
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text) as McpConfigFile;
    if (data && typeof data === "object" && data.mcpServers) return data.mcpServers;
  } catch (err) {
    console.warn(`[mcp] ignoring malformed mcp.json: ${String(err)}`);
  }
  return {};
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<Client> {
  // Managed search connectors inject live API keys (parallel / firecrawl) or
  // attach an OAuth provider (scite / consensus). Secrets never sit in mcp.json.
  const resolved = resolveManagedSearchConfig(name, config) ?? config;
  const client = new Client({ name: "researchcraft-server", version: "0.5.0" });
  if ("url" in resolved) {
    const authProvider =
      isManagedOAuthConfig(name, resolved) ? silentOAuthProvider(name) ?? undefined : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
      requestInit: resolved.headers ? { headers: resolved.headers } : undefined,
      authProvider,
    });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }
  const transport = new StdioClientTransport({
    command: resolved.command,
    args: resolved.args ?? [],
    env: { ...process.env, ...resolved.env } as Record<string, string>,
    cwd,
    stderr: "ignore",
  });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
}

/**
 * Translate this project's mcp.json into `dsh-mcp-client` composition rows'
 * config shape (`dsh/compose/mcp.ts`'s `buildMcpRows`). dsh dials these
 * itself as part of runtime startup — there is no separate "connect and
 * list tools" step here anymore (contrast `testMcpServer` below, which still
 * dials directly because it runs independently of any runtime, from the
 * settings UI's "test connection" action).
 */
export function resolveDshMcpServers(paths: ProjectPaths): DshMcpServerConfig[] {
  const servers = readMcpConfig(paths);
  return Object.entries(servers).map(([serverName, config]) => {
    const resolved = resolveManagedSearchConfig(serverName, config) ?? config;
    if ("url" in resolved) {
      return {
        serverName,
        transport: "streamable-http" as const,
        url: resolved.url,
        ...(resolved.headers ? { headers: resolved.headers } : {}),
      };
    }
    return {
      serverName,
      transport: "stdio" as const,
      command: resolved.command,
      ...(resolved.args ? { args: resolved.args } : {}),
      ...(resolved.env ? { env: { ...resolved.env } } : {}),
      cwd: paths.sandbox,
    };
  });
}

/**
 * Force every live dsh runtime for a project to close, so the next `/run`
 * respawns with fresh MCP config (mcp.json changed, credentials changed, or
 * the project itself is being deleted). Dynamic import avoids a static
 * circular dependency (session-registry.ts also imports this module, for
 * {@link resolveDshMcpServers}).
 */
export async function disposeMcpClients(projectId: string): Promise<void> {
  const { disposeAllSessions } = await import("./session-registry.ts");
  await disposeAllSessions(projectId);
}

/** Drop every project's live runtimes so the next run picks up new OAuth tokens (or a disconnect). Best-effort. */
export async function invalidateAllMcpClients(): Promise<void> {
  const { disposeAllSessions } = await import("./session-registry.ts");
  await disposeAllSessions();
}

// --- config CRUD + connection test (used by the settings API) -------------

/** Parsed mcp.json servers for a project ({} when missing/malformed). */
export function readMcpConfig(paths: ProjectPaths): Record<string, McpServerConfig> {
  return parseConfig(readConfigText(paths));
}

/**
 * Persist the full server map to the project's mcp.json (atomic write). The
 * next session build sees a changed configText and reconnects clients.
 */
export function writeMcpConfig(
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
): void {
  const file = mcpConfigPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function mcpDisabledPath(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".pi", "mcp-disabled.json");
}

/** Parsed disabled-server map for a project ({} when missing/malformed). */
export function readMcpDisabled(paths: ProjectPaths): Record<string, McpServerConfig> {
  try {
    return parseConfig(fs.readFileSync(mcpDisabledPath(paths), "utf-8"));
  } catch {
    return {};
  }
}

/** Persist the disabled-server map (atomic write), mirroring mcp.json's shape. */
export function writeMcpDisabled(
  paths: ProjectPaths,
  servers: Record<string, McpServerConfig>,
): void {
  const file = mcpDisabledPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function moveServer(
  paths: ProjectPaths,
  name: string,
  from: "enabled" | "disabled",
): ToggleResult {
  const enabled = readMcpConfig(paths);
  const disabled = readMcpDisabled(paths);
  const src = from === "enabled" ? enabled : disabled;
  const dst = from === "enabled" ? disabled : enabled;
  if (!(name in src)) {
    return { ok: false, status: 404, detail: `No ${from} connector named "${name}"` };
  }
  dst[name] = src[name];
  delete src[name];
  // Write the destination first so a crash between the two writes leaves a
  // recoverable duplicate rather than losing the server config entirely.
  if (from === "enabled") {
    writeMcpDisabled(paths, disabled);
    writeMcpConfig(paths, enabled);
  } else {
    writeMcpConfig(paths, enabled);
    writeMcpDisabled(paths, disabled);
  }
  return { ok: true };
}

/** Move an enabled server into the disabled store (keeps its config + token). */
export function disableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "enabled");
}

/** Move a disabled server back into mcp.json. */
export function enableMcpServer(paths: ProjectPaths, name: string): ToggleResult {
  return moveServer(paths, name, "disabled");
}

/** Dial a server config once and report its tools; always closes the client. */
export async function testMcpServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<{ tools: string[] }> {
  const client = await connectServer(name, config, cwd);
  try {
    const { tools } = await client.listTools();
    return { tools: tools.map((t) => t.name) };
  } finally {
    await client.close().catch(() => {/* best-effort */});
  }
}

/** Re-export for API convenience (OAuth literature connectors). */
export { isManagedOAuthConfig, oauthConnected } from "./mcp-oauth.ts";

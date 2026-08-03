/**
 * MCP server settings endpoints (per active project).
 *
 * Backs the Settings → Connectors panel: read/write the project's
 * `sandbox/.pi/mcp.json`, test-dial a server, and OAuth sign-in for
 * literature connectors (Scite, Consensus).
 *
 * Tokens in the config stay on this machine — the file is local and the
 * API only serves the user's own browser. OAuth tokens live in
 * `.mcp-oauth/` (not in mcp.json).
 */
import type { FastifyInstance } from "fastify";
import { activePaths } from "../projects.ts";
import {
  disableMcpServer,
  enableMcpServer,
  invalidateAllMcpClients,
  readMcpConfig,
  readMcpDisabled,
  testMcpServer,
  writeMcpConfig,
  type McpServerConfig,
} from "../agent/mcp.ts";
import {
  OAUTH_MCP_DEFINITIONS,
  beginOAuthConnect,
  clearOAuthTokens,
  completeOAuthCallback,
  oauthCallbackHtml,
  oauthStatusMap,
} from "../agent/mcp-oauth.ts";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validate one server entry; returns an error message or null when valid. */
function validateServer(name: string, config: unknown): string | null {
  if (!NAME_RE.test(name)) {
    return `Invalid server name "${name}" (use letters, digits, - and _)`;
  }
  if (!config || typeof config !== "object") return `Server "${name}": config must be an object`;
  const c = config as Record<string, unknown>;
  const hasUrl = typeof c.url === "string" && c.url.trim() !== "";
  const hasCommand = typeof c.command === "string" && c.command.trim() !== "";
  if (hasUrl === hasCommand) {
    return `Server "${name}": provide exactly one of "url" (HTTP) or "command" (stdio)`;
  }
  if (hasUrl) {
    try {
      new URL(c.url as string);
    } catch {
      return `Server "${name}": invalid URL`;
    }
    if (c.headers !== undefined && !isStringRecord(c.headers)) {
      return `Server "${name}": "headers" must be an object of strings`;
    }
  } else {
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === "string"))) {
      return `Server "${name}": "args" must be an array of strings`;
    }
    if (c.env !== undefined && !isStringRecord(c.env)) {
      return `Server "${name}": "env" must be an object of strings`;
    }
  }
  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mcp", async () => {
    const paths = activePaths();
    return {
      mcpServers: readMcpConfig(paths),
      disabledServers: readMcpDisabled(paths),
      oauth: oauthStatusMap(),
      oauthCatalog: Object.fromEntries(
        Object.entries(OAUTH_MCP_DEFINITIONS).map(([name, def]) => [
          name,
          {
            label: def.label,
            description: def.description,
            docsUrl: def.docsUrl,
            url: def.url,
          },
        ]),
      ),
    };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/enable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = enableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/mcp/:name/disable", async (req, reply) => {
    if (!NAME_RE.test(req.params.name)) {
      reply.code(400);
      return { detail: `Invalid server name "${req.params.name}"` };
    }
    const r = disableMcpServer(activePaths(), req.params.name);
    if (!r.ok) {
      reply.code(r.status);
      return { detail: r.detail };
    }
    return { ok: true };
  });

  app.put<{ Body: { mcpServers?: Record<string, unknown> } }>("/mcp", async (req, reply) => {
    const servers = (req.body ?? {}).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      reply.code(400);
      return { detail: "Body must be { mcpServers: { <name>: <config> } }" };
    }
    for (const [name, config] of Object.entries(servers)) {
      const error = validateServer(name, config);
      if (error) {
        reply.code(400);
        return { detail: error };
      }
    }
    writeMcpConfig(activePaths(), servers as Record<string, McpServerConfig>);
    return { ok: true, mcpServers: servers };
  });

  // Dial a (possibly unsaved) server config and report its tools, so the UI
  // can offer "Test connection" before the user commits a token typo.
  app.post<{ Body: { name?: string; config?: unknown } }>("/mcp/test", async (req, reply) => {
    const { name = "server", config } = req.body ?? {};
    const error = validateServer(NAME_RE.test(name) ? name : "server", config);
    if (error) {
      reply.code(400);
      return { ok: false, detail: error };
    }
    try {
      const { tools } = await testMcpServer(name, config as McpServerConfig, activePaths().sandbox);
      return { ok: true, tools };
    } catch (err) {
      // Connection failures are an expected outcome of "test", not a 5xx.
      return { ok: false, detail: (err as Error).message };
    }
  });

  // --- OAuth (Scite / Consensus literature search) --------------------------

  /**
   * Start OAuth for a managed literature connector. Returns either tools
   * (already signed in) or an authorizationUrl for the browser.
   */
  app.post<{ Params: { name: string } }>("/mcp/:name/oauth/start", async (req, reply) => {
    const name = req.params.name;
    if (!NAME_RE.test(name) || !(name in OAUTH_MCP_DEFINITIONS)) {
      reply.code(400);
      return { ok: false, detail: `Unknown OAuth connector "${name}"` };
    }
    const result = await beginOAuthConnect(name);
    if (!result.ok) {
      reply.code(400);
      return result;
    }
    if (result.alreadyConnected) {
      await invalidateAllMcpClients();
    }
    return result;
  });

  /** Drop stored OAuth tokens for a connector (Sign out). */
  app.post<{ Params: { name: string } }>("/mcp/:name/oauth/disconnect", async (req, reply) => {
    const name = req.params.name;
    if (!NAME_RE.test(name) || !(name in OAUTH_MCP_DEFINITIONS)) {
      reply.code(400);
      return { ok: false, detail: `Unknown OAuth connector "${name}"` };
    }
    clearOAuthTokens(name);
    await invalidateAllMcpClients();
    return { ok: true, oauth: oauthStatusMap() };
  });

  /**
   * Browser redirect target after the user authorizes at Scite/Consensus.
   * Returns HTML (not JSON) so the popup/tab can show success and close.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/mcp/oauth/callback",
    async (req, reply) => {
      const q = req.query ?? {};
      const result = await completeOAuthCallback(
        q.code ?? null,
        q.state ?? null,
        q.error ?? null,
      );
      if (result.ok) await invalidateAllMcpClients();
      reply.type("text/html; charset=utf-8");
      return oauthCallbackHtml(result);
    },
  );
}

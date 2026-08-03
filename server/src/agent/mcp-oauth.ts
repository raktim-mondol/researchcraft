/**
 * OAuth 2.1 (PKCE) support for remote MCP servers that require interactive
 * sign-in — currently Scite and Consensus for scientific literature search.
 *
 * Tokens and dynamic client registration live under repo-root `.mcp-oauth/`
 * (never in project mcp.json). The MCP SDK drives discovery + PKCE; we only
 * implement {@link OAuthClientProvider} and a small connect/callback API.
 *
 * Flow:
 *  1. Settings → Connectors → "Sign in" calls {@link beginOAuthConnect}
 *  2. SDK discovers auth server, registers a public client if needed, opens
 *     the authorize URL (returned to the UI)
 *  3. User signs in; browser redirects to GET /mcp/oauth/callback
 *  4. {@link completeOAuthCallback} exchanges the code and stores tokens
 *  5. Subsequent MCP connects reuse tokens (refresh when expired)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { HOST, PORT, REPO_ROOT } from "../config.ts";
import type { HttpServerConfig, McpServerConfig } from "./mcp.ts";

/** Built-in OAuth literature-search connectors. */
export interface OAuthMcpDefinition {
  /** Server key in mcp.json. */
  name: string;
  /** Streamable HTTP MCP endpoint. */
  url: string;
  /** Human label for UI / docs. */
  label: string;
  /** Optional scope string for client metadata / authorize. */
  scope?: string;
  /** Short description for Settings UI. */
  description: string;
  /** Docs URL for the user. */
  docsUrl: string;
}

export const OAUTH_MCP_DEFINITIONS: Record<string, OAuthMcpDefinition> = {
  scite: {
    name: "scite",
    url: "https://api.scite.ai/mcp",
    label: "Scite",
    scope: "mcp offline_access",
    description:
      "Search 250M+ papers with Smart Citations — supporting/contrasting citation context and full-text where available.",
    docsUrl: "https://scite.ai/mcp",
  },
  consensus: {
    name: "consensus",
    url: "https://mcp.consensus.app/mcp",
    label: "Consensus",
    scope: "search",
    description:
      "Search 200M+ peer-reviewed papers and preprints with evidence-backed answers for literature review.",
    docsUrl: "https://docs.consensus.app/docs/mcp",
  },
};

export function isOAuthMcpName(name: string): boolean {
  return name in OAUTH_MCP_DEFINITIONS;
}

export function oauthMcpUrl(name: string): string | null {
  return OAUTH_MCP_DEFINITIONS[name]?.url ?? null;
}

export function isManagedOAuthConfig(name: string, config: McpServerConfig): boolean {
  const def = OAUTH_MCP_DEFINITIONS[name];
  if (!def || !("url" in config) || typeof config.url !== "string") return false;
  try {
    const a = new URL(config.url);
    const b = new URL(def.url);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

export function baseOAuthConfig(name: string): HttpServerConfig | null {
  const def = OAUTH_MCP_DEFINITIONS[name];
  return def ? { url: def.url } : null;
}

/** Redirect URI registered with the AS — local backend callback. */
export function oauthCallbackUrl(): string {
  // Prefer 127.0.0.1 over localhost — some AS treat them differently and the
  // server binds to HOST (default 127.0.0.1).
  const host = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  return `http://${host}:${PORT}/mcp/oauth/callback`;
}

// --- persistent provider ---------------------------------------------------

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

function oauthDir(): string {
  return path.join(REPO_ROOT, ".mcp-oauth");
}

function storePath(serverName: string): string {
  const safe = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(oauthDir(), `${safe}.json`);
}

function readStore(serverName: string): StoredOAuthState {
  try {
    return JSON.parse(fs.readFileSync(storePath(serverName), "utf-8")) as StoredOAuthState;
  } catch {
    return {};
  }
}

function writeStore(serverName: string, data: StoredOAuthState): void {
  const dir = oauthDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = storePath(serverName);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

export function oauthConnected(serverName: string): boolean {
  const t = readStore(serverName).tokens;
  return Boolean(t?.access_token);
}

export function oauthStatusMap(): Record<string, { connected: boolean; label: string }> {
  const out: Record<string, { connected: boolean; label: string }> = {};
  for (const [name, def] of Object.entries(OAUTH_MCP_DEFINITIONS)) {
    out[name] = { connected: oauthConnected(name), label: def.label };
  }
  return out;
}

/** Fingerprint for MCP client cache invalidation when tokens change. */
export function oauthAuthFingerprint(): string {
  return Object.keys(OAUTH_MCP_DEFINITIONS)
    .sort()
    .map((n) => {
      const t = readStore(n).tokens?.access_token ?? "";
      return `${n}:${t ? "1" : "0"}:${t.slice(-4)}`;
    })
    .join("|");
}

export function clearOAuthTokens(serverName: string): void {
  const file = storePath(serverName);
  try {
    fs.unlinkSync(file);
  } catch {
    /* missing is fine */
  }
}

/**
 * File-backed OAuth client provider for one MCP server name.
 * `onRedirect` is invoked when the user must visit an authorize URL.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private _data: StoredOAuthState;
  private _pendingState: string | undefined;

  constructor(
    readonly serverName: string,
    private readonly _scope: string | undefined,
    private readonly _onRedirect: (url: URL) => void,
  ) {
    this._data = readStore(serverName);
  }

  get redirectUrl(): string {
    return oauthCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ResearchCraft",
      redirect_uris: [oauthCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Scite + Consensus both advertise public-client (PKCE) only.
      token_endpoint_auth_method: "none",
      ...(this._scope ? { scope: this._scope } : {}),
    };
  }

  state(): string {
    // Encode server name so the callback can resume without a shared Map
    // surviving process restarts (pending transport still needs the Map).
    this._pendingState = `${this.serverName}.${crypto.randomBytes(16).toString("hex")}`;
    return this._pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._data.clientInformation = info;
    writeStore(this.serverName, this._data);
  }

  tokens(): OAuthTokens | undefined {
    return this._data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // Preserve refresh_token when the AS omits it on refresh.
    const prev = this._data.tokens;
    this._data.tokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? prev?.refresh_token,
    };
    writeStore(this.serverName, this._data);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this._onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._data.codeVerifier = codeVerifier;
    writeStore(this.serverName, this._data);
  }

  codeVerifier(): string {
    if (!this._data.codeVerifier) throw new Error("No PKCE code verifier saved");
    return this._data.codeVerifier;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all") {
      this._data = {};
      clearOAuthTokens(this.serverName);
      return;
    }
    if (scope === "client") delete this._data.clientInformation;
    if (scope === "tokens") delete this._data.tokens;
    if (scope === "verifier") delete this._data.codeVerifier;
    if (scope === "discovery") delete this._data.discoveryState;
    writeStore(this.serverName, this._data);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._data.discoveryState = state;
    writeStore(this.serverName, this._data);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._data.discoveryState;
  }
}

// --- interactive connect / callback ----------------------------------------

interface PendingOAuth {
  serverName: string;
  serverUrl: string;
  provider: FileOAuthClientProvider;
  transport: StreamableHTTPClientTransport;
  authorizationUrl: string;
  createdAt: number;
}

const pendingByState = new Map<string, PendingOAuth>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function prunePending(): void {
  const now = Date.now();
  for (const [k, v] of pendingByState) {
    if (now - v.createdAt > PENDING_TTL_MS) pendingByState.delete(k);
  }
}

export type OAuthStartResult =
  | { ok: true; alreadyConnected: true; tools: string[] }
  | { ok: true; alreadyConnected: false; authorizationUrl: string }
  | { ok: false; detail: string };

/**
 * Start (or re-use) an OAuth connection for a managed literature MCP server.
 * When tokens are already valid, connects and lists tools. Otherwise returns
 * an authorization URL for the user to open in a browser.
 */
export async function beginOAuthConnect(serverName: string): Promise<OAuthStartResult> {
  const def = OAUTH_MCP_DEFINITIONS[serverName];
  if (!def) return { ok: false, detail: `Unknown OAuth connector "${serverName}"` };

  prunePending();

  let authorizationUrl: string | undefined;
  const provider = new FileOAuthClientProvider(serverName, def.scope, (url) => {
    authorizationUrl = url.toString();
  });

  const transport = new StreamableHTTPClientTransport(new URL(def.url), {
    authProvider: provider,
  });
  const client = new Client({ name: "researchcraft-oauth", version: "0.7.0" });

  try {
    await client.connect(transport, { timeout: 45_000 });
    const { tools } = await client.listTools();
    await client.close().catch(() => {});
    return {
      ok: true,
      alreadyConnected: true,
      tools: tools.map((t) => t.name),
    };
  } catch (err) {
    await client.close().catch(() => {});
    if (!(err instanceof UnauthorizedError) && !String(err).includes("Unauthorized")) {
      // Sometimes the transport wraps the error; still treat missing auth URL as hard fail.
      if (!authorizationUrl) {
        return { ok: false, detail: (err as Error).message || String(err) };
      }
    }
    if (!authorizationUrl) {
      return {
        ok: false,
        detail:
          "OAuth required but no authorization URL was produced. Check that the MCP server supports OAuth discovery.",
      };
    }

    // Capture state from the authorize URL so the callback can resume.
    let state = "";
    try {
      state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    } catch {
      /* ignore */
    }
    if (!state) {
      return { ok: false, detail: "Authorization URL missing state parameter" };
    }

    pendingByState.set(state, {
      serverName,
      serverUrl: def.url,
      provider,
      transport,
      authorizationUrl,
      createdAt: Date.now(),
    });

    return { ok: true, alreadyConnected: false, authorizationUrl };
  }
}

export type OAuthCallbackResult =
  | { ok: true; serverName: string }
  | { ok: false; detail: string };

/** Exchange the authorization code from the browser redirect. */
export async function completeOAuthCallback(
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<OAuthCallbackResult> {
  if (error) return { ok: false, detail: `Authorization failed: ${error}` };
  if (!code) return { ok: false, detail: "Missing authorization code" };
  if (!state) return { ok: false, detail: "Missing OAuth state" };

  prunePending();
  const pending = pendingByState.get(state);
  if (!pending) {
    return {
      ok: false,
      detail:
        "No pending OAuth session for this state (it may have expired — try Sign in again from Settings).",
    };
  }

  try {
    await pending.transport.finishAuth(code);
    // Smoke-test: reconnect with stored tokens so we fail loudly if exchange
    // didn't stick (finishAuth only exchanges; connect validates).
    const provider = new FileOAuthClientProvider(
      pending.serverName,
      OAUTH_MCP_DEFINITIONS[pending.serverName]?.scope,
      () => {},
    );
    const transport = new StreamableHTTPClientTransport(new URL(pending.serverUrl), {
      authProvider: provider,
    });
    const client = new Client({ name: "researchcraft-oauth", version: "0.7.0" });
    try {
      await client.connect(transport, { timeout: 45_000 });
      await client.listTools();
    } finally {
      await client.close().catch(() => {});
    }
    pendingByState.delete(state);
    return { ok: true, serverName: pending.serverName };
  } catch (err) {
    return { ok: false, detail: (err as Error).message || String(err) };
  }
}

/**
 * Auth provider for non-interactive MCP dials (session tool loading).
 * Does not open a browser; if tokens are missing, connect fails with
 * UnauthorizedError and the server is skipped.
 */
export function silentOAuthProvider(serverName: string): FileOAuthClientProvider | null {
  const def = OAUTH_MCP_DEFINITIONS[serverName];
  if (!def) return null;
  return new FileOAuthClientProvider(serverName, def.scope, () => {
    /* silent — user must sign in from Settings */
  });
}

/** Simple HTML page returned by the OAuth callback route. */
export function oauthCallbackHtml(result: OAuthCallbackResult): string {
  if (result.ok) {
    const label = OAUTH_MCP_DEFINITIONS[result.serverName]?.label ?? result.serverName;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Connected</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
h1{font-size:1.25rem}p{color:#444}.ok{color:#0a7}</style></head>
<body>
  <h1 class="ok">Connected to ${escapeHtml(label)}</h1>
  <p>You can close this window and return to ResearchCraft. Open a <strong>new chat tab</strong> so the agent can use the new literature-search tools.</p>
  <script>setTimeout(function(){ window.close(); }, 2500);</script>
</body></html>`;
  }
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Connection failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
h1{font-size:1.25rem;color:#a00}p{color:#444;word-break:break-word}</style></head>
<body>
  <h1>Could not complete sign-in</h1>
  <p>${escapeHtml(result.detail)}</p>
  <p>Return to ResearchCraft → Settings → Connectors and try again.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

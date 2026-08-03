/**
 * First-class search / literature connectors seeded into each project's
 * `sandbox/.pi/mcp.json` (write-if-missing; user disable/delete wins).
 *
 * | Server     | Auth                         | Purpose                    |
 * |------------|------------------------------|----------------------------|
 * | parallel   | optional PARALLEL_API_KEY    | general web search         |
 * | firecrawl  | optional FIRECRAWL_API_KEY   | scrape / crawl / extract   |
 * | scite      | OAuth (Settings → Sign in)   | scientific literature      |
 * | consensus  | OAuth (Settings → Sign in)   | scientific literature      |
 *
 * API keys stay in process.env / `.env`. OAuth tokens live under
 * `.mcp-oauth/` (see mcp-oauth.ts). Neither is written into mcp.json.
 */
import type { ProjectPaths } from "../projects.ts";
import {
  readMcpConfig,
  readMcpDisabled,
  writeMcpConfig,
  type HttpServerConfig,
  type McpServerConfig,
} from "./mcp.ts";
import {
  OAUTH_MCP_DEFINITIONS,
  baseOAuthConfig,
  isManagedOAuthConfig,
} from "./mcp-oauth.ts";

/** Canonical server names we manage. */
export const PARALLEL_MCP_NAME = "parallel";
export const FIRECRAWL_MCP_NAME = "firecrawl";
export const SCITE_MCP_NAME = "scite";
export const CONSENSUS_MCP_NAME = "consensus";

export const PARALLEL_SEARCH_MCP_URL = "https://search.parallel.ai/mcp";
/** Keyless hosted Firecrawl MCP (scrape/search/interact, rate-limited). */
export const FIRECRAWL_MCP_URL_KEYLESS = "https://mcp.firecrawl.dev/v2/mcp";

/** Seed configs written to mcp.json — no secrets. */
export function baseParallelConfig(): HttpServerConfig {
  return { url: PARALLEL_SEARCH_MCP_URL };
}

export function baseFirecrawlConfig(): HttpServerConfig {
  return { url: FIRECRAWL_MCP_URL_KEYLESS };
}

/** Hosted Firecrawl URL when an API key is available (full tools + higher limits). */
export function firecrawlAuthenticatedUrl(apiKey: string): string {
  return `https://mcp.firecrawl.dev/${encodeURIComponent(apiKey)}/v2/mcp`;
}

export function isManagedParallelConfig(config: McpServerConfig): boolean {
  if (!("url" in config) || typeof config.url !== "string") return false;
  try {
    const u = new URL(config.url);
    return u.hostname === "search.parallel.ai" && u.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

export function isManagedFirecrawlConfig(config: McpServerConfig): boolean {
  if (!("url" in config) || typeof config.url !== "string") return false;
  try {
    const u = new URL(config.url);
    if (u.hostname !== "mcp.firecrawl.dev") return false;
    return /(?:^|\/)v2\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Resolve the live connect config for a managed search server, injecting
 * credentials from the environment. Returns null when the entry is not one of
 * our key-based managed templates (OAuth servers are handled separately).
 */
export function resolveManagedSearchConfig(
  name: string,
  stored: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig | null {
  if (name === PARALLEL_MCP_NAME && isManagedParallelConfig(stored)) {
    const key = env.PARALLEL_API_KEY?.trim();
    const headers: Record<string, string> = { ...(stored as HttpServerConfig).headers };
    if (key) headers.Authorization = `Bearer ${key}`;
    else delete headers.Authorization;
    const out: HttpServerConfig = { url: PARALLEL_SEARCH_MCP_URL };
    if (Object.keys(headers).length) out.headers = headers;
    return out;
  }
  if (name === FIRECRAWL_MCP_NAME && isManagedFirecrawlConfig(stored)) {
    const key = env.FIRECRAWL_API_KEY?.trim();
    return {
      url: key ? firecrawlAuthenticatedUrl(key) : FIRECRAWL_MCP_URL_KEYLESS,
    };
  }
  // OAuth literature servers: keep the canonical URL (tokens via authProvider).
  if (isManagedOAuthConfig(name, stored)) {
    const base = baseOAuthConfig(name);
    return base ?? null;
  }
  return null;
}

type SeedSpec = {
  name: string;
  isManaged: (c: McpServerConfig) => boolean;
  base: () => HttpServerConfig;
};

const SEED_SPECS: SeedSpec[] = [
  {
    name: PARALLEL_MCP_NAME,
    isManaged: isManagedParallelConfig,
    base: baseParallelConfig,
  },
  {
    name: FIRECRAWL_MCP_NAME,
    isManaged: isManagedFirecrawlConfig,
    base: baseFirecrawlConfig,
  },
  ...Object.keys(OAUTH_MCP_DEFINITIONS).map((name) => ({
    name,
    isManaged: (c: McpServerConfig) => isManagedOAuthConfig(name, c),
    base: () => baseOAuthConfig(name)!,
  })),
];

/**
 * Ensure Parallel, Firecrawl, Scite, and Consensus are present in the project's
 * mcp.json. Does not re-add servers the user disabled or deleted after seed.
 * Returns true when mcp.json was written.
 */
export function ensureSearchMcpServers(paths: ProjectPaths): boolean {
  const enabled = readMcpConfig(paths);
  const disabled = readMcpDisabled(paths);
  let changed = false;

  for (const spec of SEED_SPECS) {
    if (!(spec.name in enabled) && !(spec.name in disabled)) {
      enabled[spec.name] = spec.base();
      changed = true;
    } else if (spec.name in enabled && spec.isManaged(enabled[spec.name])) {
      const next = spec.base();
      if (JSON.stringify(enabled[spec.name]) !== JSON.stringify(next)) {
        enabled[spec.name] = next;
        changed = true;
      }
    }
  }

  if (changed) writeMcpConfig(paths, enabled);
  return changed;
}

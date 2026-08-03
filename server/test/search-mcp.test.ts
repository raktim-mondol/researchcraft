import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../src/config.ts";
import { ensureProjectExists, resolvePaths } from "../src/projects.ts";
import {
  disableMcpServer,
  readMcpConfig,
  writeMcpConfig,
} from "../src/agent/mcp.ts";
import {
  CONSENSUS_MCP_NAME,
  FIRECRAWL_MCP_NAME,
  FIRECRAWL_MCP_URL_KEYLESS,
  PARALLEL_MCP_NAME,
  PARALLEL_SEARCH_MCP_URL,
  SCITE_MCP_NAME,
  baseFirecrawlConfig,
  baseParallelConfig,
  ensureSearchMcpServers,
  firecrawlAuthenticatedUrl,
  isManagedFirecrawlConfig,
  isManagedParallelConfig,
  resolveManagedSearchConfig,
} from "../src/agent/search-mcp.ts";
import {
  baseOAuthConfig,
  isManagedOAuthConfig,
  oauthCallbackUrl,
} from "../src/agent/mcp-oauth.ts";

function reset(): void {
  fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}
beforeEach(reset);
afterAll(() => fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true }));

describe("search MCP managed configs", () => {
  it("recognizes canonical Parallel and Firecrawl URLs", () => {
    expect(isManagedParallelConfig(baseParallelConfig())).toBe(true);
    expect(isManagedFirecrawlConfig(baseFirecrawlConfig())).toBe(true);
    expect(
      isManagedFirecrawlConfig({ url: firecrawlAuthenticatedUrl("fc-test-key") }),
    ).toBe(true);
    expect(isManagedParallelConfig({ url: "https://example.com/mcp" })).toBe(false);
    expect(isManagedFirecrawlConfig({ command: "npx", args: ["-y", "firecrawl-mcp"] })).toBe(
      false,
    );
  });

  it("recognizes Scite and Consensus OAuth endpoints", () => {
    expect(isManagedOAuthConfig(SCITE_MCP_NAME, baseOAuthConfig(SCITE_MCP_NAME)!)).toBe(true);
    expect(isManagedOAuthConfig(CONSENSUS_MCP_NAME, baseOAuthConfig(CONSENSUS_MCP_NAME)!)).toBe(
      true,
    );
    expect(
      isManagedOAuthConfig(SCITE_MCP_NAME, { url: "https://api.scite.ai/other" }),
    ).toBe(false);
  });

  it("injects Parallel Bearer auth only when PARALLEL_API_KEY is set", () => {
    const stored = baseParallelConfig();
    expect(resolveManagedSearchConfig(PARALLEL_MCP_NAME, stored, {})).toEqual({
      url: PARALLEL_SEARCH_MCP_URL,
    });
    expect(
      resolveManagedSearchConfig(PARALLEL_MCP_NAME, stored, {
        PARALLEL_API_KEY: "  secret-parallel-key  ",
      }),
    ).toEqual({
      url: PARALLEL_SEARCH_MCP_URL,
      headers: { Authorization: "Bearer secret-parallel-key" },
    });
  });

  it("switches Firecrawl to the authenticated hosted URL when key is set", () => {
    const stored = baseFirecrawlConfig();
    expect(resolveManagedSearchConfig(FIRECRAWL_MCP_NAME, stored, {})).toEqual({
      url: FIRECRAWL_MCP_URL_KEYLESS,
    });
    expect(
      resolveManagedSearchConfig(FIRECRAWL_MCP_NAME, stored, {
        FIRECRAWL_API_KEY: "fc-abc",
      }),
    ).toEqual({
      url: firecrawlAuthenticatedUrl("fc-abc"),
    });
  });

  it("keeps OAuth literature URLs keyless (tokens via authProvider)", () => {
    const scite = baseOAuthConfig(SCITE_MCP_NAME)!;
    expect(resolveManagedSearchConfig(SCITE_MCP_NAME, scite, {})).toEqual(scite);
  });

  it("leaves custom user configs alone", () => {
    const custom = { url: "https://mcp.example.com/custom" };
    expect(
      resolveManagedSearchConfig(PARALLEL_MCP_NAME, custom, {
        PARALLEL_API_KEY: "x",
      }),
    ).toBeNull();
  });

  it("builds a localhost OAuth callback URL", () => {
    expect(oauthCallbackUrl()).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/mcp\/oauth\/callback$/);
  });
});

describe("ensureSearchMcpServers", () => {
  it("seeds parallel, firecrawl, scite, and consensus into a new project", () => {
    ensureProjectExists("p-search");
    const paths = resolvePaths("p-search");
    const cfg = readMcpConfig(paths);
    expect(cfg[PARALLEL_MCP_NAME]).toEqual(baseParallelConfig());
    expect(cfg[FIRECRAWL_MCP_NAME]).toEqual(baseFirecrawlConfig());
    expect(cfg[SCITE_MCP_NAME]).toEqual(baseOAuthConfig(SCITE_MCP_NAME));
    expect(cfg[CONSENSUS_MCP_NAME]).toEqual(baseOAuthConfig(CONSENSUS_MCP_NAME));
    expect(ensureSearchMcpServers(paths)).toBe(false);
  });

  it("seeds when called on a bare sandbox with no project ensure", () => {
    const paths = resolvePaths("p-bare");
    fs.mkdirSync(paths.sandbox, { recursive: true });
    expect(readMcpConfig(paths)).toEqual({});
    expect(ensureSearchMcpServers(paths)).toBe(true);
    expect(Object.keys(readMcpConfig(paths)).sort()).toEqual([
      CONSENSUS_MCP_NAME,
      FIRECRAWL_MCP_NAME,
      PARALLEL_MCP_NAME,
      SCITE_MCP_NAME,
    ]);
  });

  it("does not re-seed a connector the user disabled", () => {
    ensureProjectExists("p-off");
    const paths = resolvePaths("p-off");
    ensureSearchMcpServers(paths);
    expect(disableMcpServer(paths, PARALLEL_MCP_NAME)).toEqual({ ok: true });
    expect(ensureSearchMcpServers(paths)).toBe(false);
    expect(readMcpConfig(paths)[PARALLEL_MCP_NAME]).toBeUndefined();
  });

  it("does not overwrite a user-customized parallel entry", () => {
    ensureProjectExists("p-custom");
    const paths = resolvePaths("p-custom");
    writeMcpConfig(paths, {
      [PARALLEL_MCP_NAME]: { url: "https://search.parallel.ai/mcp-oauth" },
      [FIRECRAWL_MCP_NAME]: baseFirecrawlConfig(),
    });
    ensureSearchMcpServers(paths);
    expect(readMcpConfig(paths)[PARALLEL_MCP_NAME]).toEqual({
      url: "https://search.parallel.ai/mcp-oauth",
    });
  });
});

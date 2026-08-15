/**
 * Live HarnessRuntime registry.
 *
 * Each chat tab is one ResearchCraft "session" (a stable id minted once,
 * independent of the underlying dsh runtime). Under the old Pi backend a
 * session WAS one long-lived, resumable `AgentSession` object; under dsh, one
 * `HarnessRuntime` is a subprocess whose JSON-RPC protocol has exactly three
 * methods (`initialize`, `session/prompt`, `shutdown` — see
 * `dsh-sdk-jsonrpc-server`'s `server.ts`) and no abort or resume-from-history
 * call. Concretely that forces two departures from the old model, both
 * accepted deliberately rather than papered over:
 *
 * 1. **Abort closes the whole runtime.** There is no per-turn cancel on the
 *    wire, so `abortSession()` tears down the live subprocess entirely (see
 *    `HarnessRuntime`'s class doc). The next `/run` on that ResearchCraft
 *    session spawns a brand new runtime — a new "generation".
 * 2. **A runtime can't resume a prior dsh session id after it exits** (a
 *    restart, a model change requiring respawn, or an abort). `initialize`
 *    fixes provider/model for a runtime's entire process lifetime, and
 *    `createSession()` server-side always calls `ctx.agents.create()`, never
 *    `ctx.agents.resume()`. So every (re)spawn mints a *fresh* dsh session id
 *    — a new "generation" — recorded in this project's on-disk manifest.
 *    dsh's own JSONL transcript for each past generation is still readable
 *    from disk (`dsh-session-persistence-jsonl` writes durable files, it's
 *    only the *live* wire protocol that can't resume one) — that's what lets
 *    `/history` reconstruct a full transcript across generations — but the
 *    model itself has no memory of a prior generation's turns: conversational
 *    continuity does not survive an abort, a model change, or a server
 *    restart. This is a real, accepted product regression versus Pi, not an
 *    oversight.
 *
 * One `HarnessRuntime` per ResearchCraft session (not one per project) keeps
 * abort and model-switch isolated between chat tabs, while every tab in a
 * project still shares the same `workspaceRoot` (the project sandbox) on
 * disk, matching how Pi tabs always shared one `sandbox/`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaths, type ProjectPaths } from "../projects.ts";
import { HarnessRuntime } from "./dsh/runtime/HarnessRuntime.ts";
import type { HarnessSdkConfig } from "./dsh/types.ts";
import type { PluginRow } from "./dsh/compose/rows.ts";
import { buildPersonaSubagentRow } from "./dsh/compose/personas.ts";
import { buildWebRows } from "./dsh/compose/web.ts";
import { listAgents, seedAgentFiles } from "./agent-files.ts";
import { LLM_ROUTE_NAME, buildLlmRoute, getLlmConfig, resolveModelId } from "./models.ts";
import { resolveDshMcpServers } from "./mcp.ts";
import { consoleLogger, noopLogger, type Logger } from "./dsh/logger.ts";

const logger: Logger = process.env.KADY_DSH_LOG ? consoleLogger : noopLogger;

const RESEARCHCRAFT_PERSONA =
  "You are ResearchCraft's research assistant: a careful, rigorous scientific " +
  "computing and writing collaborator. Verify claims and calculations rather " +
  "than assuming them; say so explicitly when something is uncertain or " +
  "unverifiable rather than guessing.";

// --- generation manifest ---------------------------------------------------

interface Generation {
  dshSessionId: string;
  model: string;
  startedAt: string;
  /** Set once this generation stops being the live one (abort, respawn, or graceful close). */
  endedAt?: string;
}

export interface SessionManifest {
  /** ResearchCraft session id — stable for the tab's lifetime. */
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  /** Oldest first; the last entry is the current/most recent generation. */
  generations: Generation[];
}

/** Metadata directory — deliberately not `.pi/sessions` (Pi's own JSONL format) or `.dsh/sessions` (dsh's own transcript store, see {@link dshSessionsRoot}). */
function manifestDir(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, "dsh-sessions");
}

function manifestPath(paths: ProjectPaths, sessionId: string): string {
  return path.join(manifestDir(paths), `${sessionId}.json`);
}

/** Where this project's dsh runtimes persist their own JSONL transcripts (`dsh-session-persistence-jsonl`). */
export function dshSessionsRoot(paths: ProjectPaths): string {
  return path.join(paths.sandbox, ".dsh", "sessions");
}

function readManifest(paths: ProjectPaths, sessionId: string): SessionManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(paths, sessionId), "utf8");
    return JSON.parse(raw) as SessionManifest;
  } catch {
    return null;
  }
}

function writeManifest(paths: ProjectPaths, manifest: SessionManifest): void {
  fs.mkdirSync(manifestDir(paths), { recursive: true });
  fs.writeFileSync(manifestPath(paths, manifest.id), JSON.stringify(manifest, null, 2));
}

function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,128}$/.test(id);
}

// --- live runtime registry --------------------------------------------------

interface LiveEntry {
  runtime: HarnessRuntime;
  dshSessionId: string;
  model: string;
}

const live = new Map<string, LiveEntry>(); // key = `${projectId}:${sessionId}`
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

/**
 * Named specialist personas come from `agent-files.ts`'s `.pi/agents/*.md`
 * roster (seeded once from `subagents.ts`'s `SUBAGENT_TYPES`, then user-
 * editable/enable-toggleable from Settings) rather than the static roster
 * directly, so a user who disables, edits, or adds a specialist there sees
 * that reflected in what the agent can actually call. Narrower than Pi's
 * version, though: `dsh-plugins/persona-subagents.mjs` always fully replaces
 * the child's persona and uses the deployment's default model — an agent
 * file's `model`/`thinking`/`tools`/`systemPromptMode` overrides have no
 * effect yet (Pi's roster supported all of these per-agent).
 */
function extraRows(paths: ProjectPaths): PluginRow[] {
  seedAgentFiles(paths);
  const personas = listAgents(paths)
    .filter((a) => a.enabled !== false)
    .map((a) => ({ name: a.name, summary: a.description, systemPrompt: a.systemPrompt }));
  const personaRow = buildPersonaSubagentRow(personas);
  return [
    ...(personaRow ? [personaRow] : []),
    ...buildWebRows({
      exa: Boolean(process.env.EXA_API_KEY?.trim()),
      perplexity: Boolean(process.env.PERPLEXITY_API_KEY?.trim()),
    }),
  ];
}

/**
 * Build the config for a fresh runtime. `dshSessionId` is only used as the
 * `session/prompt` argument at run time (see `HarnessRunOptions.sessionId`
 * in `HarnessRuntime.run`) — `initialize` itself carries no session id, so
 * nothing here depends on it; it's threaded through purely so callers of
 * this module don't have to reach back into `HarnessRuntime` internals.
 */
function buildConfig(paths: ProjectPaths, model: string): HarnessSdkConfig {
  const route = { ...buildLlmRoute(), models: [{ id: model, contextWindow: 128_000, maxTokens: 8192 }] };
  return {
    workspaceRoot: paths.sandbox,
    sessionsRoot: dshSessionsRoot(paths),
    llm: [route],
    defaultRoute: { provider: LLM_ROUTE_NAME, model },
    persona: RESEARCHCRAFT_PERSONA,
    sandbox: { mode: "workspace-write", approvalPolicy: "never" },
    mcpServers: resolveDshMcpServers(paths),
    skills: { enabled: true, customDirs: [paths.skillsDir] },
    subagents: { spawn: true, fork: true, continuable: false, report: false, control: true },
    maxTokensAsSuccess: true,
    logger,
  };
}

async function spawn(paths: ProjectPaths, model: string): Promise<HarnessRuntime> {
  const runtime = new HarnessRuntime({
    config: buildConfig(paths, model),
    extraRows: extraRows(paths),
  });
  await runtime.start();
  return runtime;
}

/** Close and evict a live entry, marking its generation ended in the manifest. Safe to call when nothing is live. */
async function evict(projectId: string, paths: ProjectPaths, sessionId: string): Promise<void> {
  const k = keyFor(projectId, sessionId);
  const entry = live.get(k);
  if (!entry) return;
  live.delete(k);
  const manifest = readManifest(paths, sessionId);
  if (manifest) {
    const last = manifest.generations.at(-1);
    if (last && last.dshSessionId === entry.dshSessionId && !last.endedAt) {
      last.endedAt = new Date().toISOString();
      manifest.updatedAt = last.endedAt;
      writeManifest(paths, manifest);
    }
  }
  await entry.runtime.close().catch(() => {});
}

// --- public API --------------------------------------------------------

/** Create a brand-new ResearchCraft session (manifest only — no runtime spawned yet; see `getOrSpawnRuntime`). */
export function createSession(projectId: string, paths: ProjectPaths): SessionManifest {
  const id = randomUUID();
  const now = new Date().toISOString();
  const manifest: SessionManifest = { id, projectId, createdAt: now, updatedAt: now, generations: [] };
  writeManifest(paths, manifest);
  return manifest;
}

/** All sessions for a project, most-recently-updated first. */
export function listSessions(paths: ProjectPaths): SessionManifest[] {
  const dir = manifestDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  const manifests: SessionManifest[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidSessionId(id)) continue;
    const m = readManifest(paths, id);
    if (m) manifests.push(m);
  }
  manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return manifests;
}

export function getManifest(paths: ProjectPaths, sessionId: string): SessionManifest | null {
  if (!isValidSessionId(sessionId)) return null;
  return readManifest(paths, sessionId);
}

/**
 * Return a ready-to-prompt runtime + the dsh session id to pass as
 * `HarnessRunOptions.sessionId`, spawning fresh (or respawning) as needed:
 *   - no live entry (first run, or a prior generation was aborted/closed)
 *   - a live entry exists but the configured model has drifted (the wire
 *     protocol has no way to change a running runtime's model — see the file
 *     doc) — the stale runtime is closed and a new generation started
 */
export async function getOrSpawnRuntime(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
  modelRef: string | undefined,
): Promise<LiveEntry> {
  if (!isValidSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const model = resolveModelId(modelRef);
  const k = keyFor(projectId, sessionId);
  const existing = live.get(k);
  if (existing && existing.model === model) return existing;
  if (existing) await evict(projectId, paths, sessionId);

  let manifest = readManifest(paths, sessionId);
  if (!manifest) {
    const now = new Date().toISOString();
    manifest = { id: sessionId, projectId, createdAt: now, updatedAt: now, generations: [] };
  }

  const runtime = await spawn(paths, model);
  const dshSessionId = randomUUID();
  const startedAt = new Date().toISOString();
  manifest.generations.push({ dshSessionId, model, startedAt });
  manifest.updatedAt = startedAt;
  writeManifest(paths, manifest);

  const entry: LiveEntry = { runtime, dshSessionId, model };
  live.set(k, entry);
  return entry;
}

/** True when llmConfigured()'s route/model would force a respawn on the next run. */
export function isStale(projectId: string, sessionId: string, modelRef: string | undefined): boolean {
  const entry = live.get(keyFor(projectId, sessionId));
  if (!entry) return false;
  return entry.model !== resolveModelId(modelRef);
}

/** Abort the in-flight (or idle) runtime for a session. The wire protocol has no per-turn cancel, so this closes the whole runtime — see the file doc. */
export async function abortSession(projectId: string, paths: ProjectPaths, sessionId: string): Promise<void> {
  await evict(projectId, paths, sessionId);
}

/** Dispose a session's live runtime without deleting its manifest/history (e.g. LRU eviction, project unload). */
export async function disposeSession(projectId: string, paths: ProjectPaths, sessionId: string): Promise<void> {
  await evict(projectId, paths, sessionId);
}

/**
 * Close every live runtime for a project (or, with no `projectId`, every
 * live runtime across all projects). Used when project-scoped config a
 * runtime bakes in at spawn time changes underneath it — MCP servers,
 * credentials — so the next `/run` respawns and picks up the change; see
 * `mcp.ts`'s `disposeMcpClients`/`invalidateAllMcpClients`.
 */
export async function disposeAllSessions(projectId?: string): Promise<void> {
  const prefix = projectId ? `${projectId}:` : "";
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix));
  await Promise.all(
    keys.map((k) => {
      const sep = k.indexOf(":");
      const pid = k.slice(0, sep);
      const sessionId = k.slice(sep + 1);
      return evict(pid, resolvePaths(pid), sessionId);
    }),
  );
}

export { getLlmConfig };

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ResearchCraft is a bring-your-own-key desktop AI research assistant: a Next.js frontend and a Fastify/TypeScript backend that drives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ("dsh") to run a single agent (plus sub-agent delegation) against any OpenAI-compatible endpoint (OpenRouter, a local Ollama daemon, etc). It is a **white-label fork of [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok)** (see `NOTICE`) — internal identifiers, env vars, and on-disk paths still use the `kady`/`KADY_` prefix from the upstream project even though the product is branded "ResearchCraft"; don't rename these, they're load-bearing for existing user data and package names.

The backend used to embed the Pi coding-agent SDK in-process; it was fully replaced by dsh (see `server/src/agent/session-registry.ts`'s file doc for why the migration forces a different session model — dsh runs as an out-of-process subprocess per chat tab, driven over JSON-RPC, with real protocol limits Pi didn't have: no live abort/model-switch and no resume-from-history across a restart). dsh is pre-1.0 and unpublished, so it's vendored into the repo rather than installed from npm — see "dsh vendor tree" below.

Two services, always run together:

| Service | Dir | Port | Stack |
|---|---|---|---|
| Frontend | `web/` | 3000 | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui |
| Backend | `server/` | 8000 | Fastify, TypeScript (`tsx`, no build step for dev), dsh (DeepSeek Harness) |

## Commands

There is no root-level build; `web/` and `server/` are independent npm projects with their own lockfiles. Run commands from within each directory (or use `--workspace`-style `cd`).

**Full app (both services + first-run setup):**
```bash
node start.mjs        # cross-platform launcher; ./start.sh / start.cmd are thin wrappers
node start.mjs --check  # launcher smoke test only (no servers started) — what CI runs
```
`start.mjs` installs deps in `server/` and `web/`, installs `uv` if missing, copies `.env.example` → `.env` on first run, and seeds the scientific skills catalogue into `projects/default/sandbox/.pi/skills/`.

**Backend (`server/`):**
```bash
npm run dev         # tsx watch src/index.ts — hot-reload dev server on :8000
npm start           # tsx src/index.ts — no watch
npm run typecheck   # tsc -p tsconfig.json (noEmit)
npm test            # vitest run
npm run test:watch  # vitest
npx vitest run test/models.test.ts        # single file
npx vitest run -t "some test name"        # single test by name
```
Backend tests run **serially** (`fileParallelism: false` in `server/vitest.config.ts`) because several suites reset a shared temp projects root in `beforeEach`/`afterAll`; don't parallelize test files or you'll get races (`ENOTEMPTY`, vanishing files). Each run gets an isolated `KADY_PROJECTS_ROOT` under the OS temp dir. There is no `npm run lint` in `server/` — `typecheck` is the gate.

**Frontend (`web/`):**
```bash
npm run dev            # next dev, :3000
npm run build           # next build
npm run lint             # eslint
npm test                # vitest run (jsdom)
npm run test:watch
npm run test:coverage
npx vitest run src/lib/notebook.test.ts   # single file
npx vitest run -t "some test name"        # single test by name
```
Tests are colocated with source as `*.test.ts`/`*.test.tsx` (e.g. `web/src/lib/notebook.ts` + `notebook.test.ts`). Coverage excludes `use-*.ts` hooks, `ai-elements/`, `pdf-viewer/`, and `components/ui/` (shadcn primitives).

**CI** (`.github/workflows/tests.yml`, PRs into `main`) runs three matrixed jobs on every PR: backend vitest+typecheck (ubuntu/windows), frontend vitest (ubuntu/windows), and `start.sh`/`start.cmd --check` launcher smoke test (ubuntu/macos/windows). Match this locally before pushing.

## Architecture

Read `docs/architecture.md` for the full picture; the essentials:

### Request flow
The frontend POSTs to the backend tagged with a project id (`X-Project-Id` header / `?project` query / `researchcraft-project` cookie, resolved in `server/src/index.ts`) and a chat tab's session id. The backend drives one dsh `HarnessRuntime` — a `dsh-jsonrpc-agent` subprocess spoken to over stdio JSON-RPC — for that session, which may delegate to sub-agents (in-process Cordis children inside the same runtime, not separate subprocesses). Model calls go straight to the configured OpenAI-compatible endpoint (OpenRouter, Ollama, etc.) — **no proxy**. Events (text, tool calls, cost) stream back over SSE in real time, translated from dsh's own event vocabulary by `server/src/agent/events.ts` into the same compact frame schema the frontend has always consumed.

Every backend request runs inside an `AsyncLocalStorage`-scoped "active project" context (`server/src/scope.ts`, set in the `onRequest` hook in `index.ts`); code deep in the call stack reads the current project via `currentProjectId()`/`activePaths()` (`server/src/projects.ts`) rather than threading it through function args.

### Projects, sessions, tabs
- A **project** is a self-contained workspace at `projects/<id>/`, with a JSON registry at `projects/index.json` (`server/src/projects.ts`). The default project (`default`) is auto-created; others are minted with a random-suffixed id from their name.
- Inside a project, `sandbox/` is every dsh runtime's `workspaceRoot` — the one thing all chat tabs in that project share (files written by one tab are instantly visible to others). Project settings (spend cap) and API keys (from the repo-root `.env`) are also shared.
- A **chat tab** = one backend **session**: a stable id whose manifest (`sandbox/.kady/dsh-sessions/<id>.json`) tracks a sequence of dsh "generations" — one `HarnessRuntime` subprocess + fresh dsh session id per spawn, since the wire protocol can't resume a prior dsh session id after a restart, abort, or model change (see `session-registry.ts`'s file doc). Each generation's real transcript is durable JSONL under `sandbox/.dsh/sessions/` (dsh's own on-disk format); `/history` and export endpoints reconstruct the full transcript by reading every generation's log, but a new generation's *model* has no memory of a prior generation's turns — that's a real, accepted regression from the Pi era, not an oversight. Selected model and a cost ledger (`sandbox/.kady/runs/<sessionId>/costs.jsonl`) round out a session. Switching tabs is purely client-side; each request already carries its session id, so the backend doesn't track "active" tab state. Up to 10 tabs per project.

### Backend layout (`server/src/`)
- `index.ts` — Fastify app, CORS, the project-scope `onRequest` hook, route registration.
- `config.ts` — env-derived constants (ports, `PROJECTS_ROOT`, etc). Prefer this over reading `process.env` directly elsewhere.
- `env.ts` — loads `.env` via the shared root-level `env-file.mjs` parser (existing `process.env` always wins; import this first in any new entry point).
- `projects.ts` — project registry + path resolution (`resolvePaths`, `activePaths`).
- `scope.ts` — the `AsyncLocalStorage` project-context plumbing.
- `agent/dsh/` — a first-party TypeScript port of a standalone dsh SDK (config types, Cordis plugin-row composition, `HarnessRuntime` — the typed wrapper that spawns a `dsh-jsonrpc-agent` subprocess and drives it via `@deepseek-ai/dsh-sdk-client`), plus `session-log.ts` (reads dsh's own on-disk JSONL transcript format, ported from the vendored package's internal, non-exported path/decode logic since none of it is public API).
- `agent/dsh-plugins/` — raw Cordis plugins loaded by absolute file path (not npm packages) into the runtime subprocess, written as plain ESM `.mjs` since the subprocess has no TypeScript loader. `persona-subagents.mjs` registers one delegation tool per named specialist (see "Sub-agents" below).
- `agent/` (top level) — app wiring on top of `dsh/`: `models.ts` (the one configured OpenAI-compatible endpoint → a `dsh-llm-pi-ai` route), `session-registry.ts` (the live `HarnessRuntime` registry — spawn/reuse/respawn-on-drift, generation manifests), `events.ts` (dsh's `SessionEventMap` → the frontend's compact SSE frame schema, unchanged from the Pi era), `session-history.ts`/`session-export.ts` (transcript replay/reproducibility export from dsh's stored JSONL), `mcp.ts` (per-project MCP config CRUD; live connections are native `dsh-mcp-client` composition rows now, not a hand-rolled bridge), `skills.ts` (seeds/lists scientific skills into `sandbox/.pi/skills/`), `subagents.ts` (the 21 named specialist personas, pure data), `agent-files.ts` (the user-editable `.pi/agents/*.md` roster `session-registry.ts` actually composes personas from), `notebook*.ts` (the Living Lab Notebook feature — store, export, harvest, zip, annotations).
- `api/` — Fastify route plugins, one file per resource area (`projects.ts`, `sessions.ts` = SSE chat, `sandbox.ts` = file browser/CRUD, `mcp.ts`, `credentials.ts`, `agents.ts`, `system.ts`).
- `cost/ledger.ts` — per-session/per-project USD cost tracking and budget-cap enforcement (`spendLimitUsd`).
- `latex/` — LaTeX compile/synctex/AI-assist support for the manuscript editor.
- `helpers/*.py` + `helpers-env.ts` — Python helper scripts (via `uv`) for scientific file previews (AnnData, arrays, chemistry, imaging, mass spec, structures); `syncHelperVenv()` provisions their venv on backend boot, best-effort (previews degrade gracefully if it fails).
- `vendor/dsh/` — the vendored dsh package tree (dsh is pre-1.0 and not on npm): flat `vendor/dsh/<shortname>/` directories with relative symlinks recreating the real dependency graph, referenced from `package.json` via `file:./vendor/dsh/*`. Don't hand-edit; regenerate via the vendoring script if the dsh checkout is updated.

### Frontend layout (`web/src/`)
- `app/` — Next.js App Router entry (`layout.tsx`, `page.tsx`); this is a largely single-page app, not a multi-route site.
- `components/` — feature components at the top level (`chat-tab.tsx`, `settings-dialog.tsx`, `sandbox-panel.tsx`, `lab-notebook-*`, etc.), with subdirs for cohesive clusters: `ai-elements/` (streaming chat primitives), `latex/` (manuscript editor), `pdf-viewer/`, `viewers/` (scientific file-format viewers: molecule, structure, imaging, spectrum, phylo, alignment, array data — each has a matching `registry.ts` entry in `lib/viewers/`), `ui/` (shadcn/ui primitives — treat as generated, prefer adding via `shadcn` CLI per `components.json` over hand-editing).
- `lib/` — the bulk of the business logic as hooks + pure functions: `use-agent.ts` (SSE streaming + turn state), `use-sandbox.ts`, `use-projects.ts`, `use-skills.ts`, `notebook*.ts`, `latex/*` (outline, diagnostics, completions, spellcheck-as-worker, magic comments), `chat-routing.ts`, `capabilities.ts`. Most non-trivial logic here has a colocated `*.test.ts(x)`.
- `data/` — static JSON catalogues bundled with the app: `workflows.json` (see below), `models.json`, `databases.json`, `modal-instances.json`.
- `lib/brand.ts` + `public/brand/` — the only files that should change for white-label/rebrand work (product name, logos). Don't touch the `kady`/kAdy-prefixed internal paths under `projects/*/sandbox/.kady/` — they're intentionally unchanged for backward data compatibility.

### Workflows catalogue
`web/src/data/workflows.json` is a flat array of one-click task templates shown in the UI, grouped by `category`. Adding one is pure data — no backend code. Fields: `id`, `name`, `description`, `category` (one of 22 fixed discipline slugs — see `docs/contributing-workflows.md` for the list), `icon` (a PascalCase Lucide icon name, imported in `workflows-panel.tsx` if new), `prompt` (with `{placeholder}` tokens), `suggestedSkills` (skill ids from the external [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) repo — only use ids that actually exist there), `placeholders`, `requiresFiles`. Full authoring guidance in `docs/contributing-workflows.md`.

### Sub-agents
21 scientific specialist personas ship per-project as markdown files at `projects/<id>/sandbox/.pi/agents/<name>.md` (seeded from `subagents.ts`, user-editable/toggleable from Settings via `agent-files.ts`). Each enabled persona becomes one model-facing delegation tool (`subagent_<name>`), registered by `agent/dsh-plugins/persona-subagents.mjs` — a raw Cordis plugin composed by `session-registry.ts` on every runtime spawn, calling `ctx.subagents.start()` directly with the persona's system prompt as the child's persona override. dsh has no bundled roster of general-purpose delegation agents the way `pi-subagents` did, so that half of the old roster has no replacement. The main agent decides when to delegate; users can also name one explicitly in chat. Each specialist's full brief (what it checks, what it must flag as unverifiable rather than silently pass) is documented per-agent in `docs/sub-agents.md`.

### MCP servers
Every project is seeded (write-if-missing, disable sticks) with 4 MCP connectors — Parallel Search, Firecrawl, Scite, Consensus — configured per-project at `sandbox/.pi/mcp.json` (`server/src/agent/search-mcp.ts`, `mcp-oauth.ts`). `mcp.ts`'s `resolveDshMcpServers()` translates that config into `dsh-mcp-client` composition rows on every runtime spawn — connections are native to dsh now, not a hand-rolled bridge. OAuth tokens for Scite/Consensus live in `.mcp-oauth/` on the host machine, not in the project sandbox. MCP tools are currently available to the main agent only, not to sub-agents.

### Custom tools: notebook, modal_run, interview
Three tools need state that lives in the MAIN Fastify process (which session/run a call belongs to; the interview answer map) reachable from the dsh runtime SUBPROCESS, a separate OS process with its own memory. `run-ids.ts` mirrors the live run context (ResearchCraft session id, run id, selected Modal compute target) to a small file keyed by dsh session id before every run; `notebook-tool.mjs`/`modal-tool.mjs` (raw Cordis plugins, same local-file-row pattern as the persona tools) read it back via `exec.agent.id`. `interview-tool.mjs` additionally needs to block until a human answers in the browser, which a file can't do — it POSTs to `POST /internal/interview` (`api/internal.ts`), which holds the HTTP response open via `interview.ts`'s `registerInterview()`/`pending` map until the existing public `/sessions/:id/interview/:toolCallId` route resolves it. One narrowing versus Pi: an interview's uploaded images aren't yet surfaced to the model as image content (the model sees only that N images arrived) — routing them through dsh's attachment/content-block pipeline is separate infrastructure.

### Known gaps versus the Pi-era backend
- Live per-turn abort and mid-run model switching are gone: the wire protocol has no per-request cancel (`abortSession()` closes the whole runtime) and fixes provider/model for a runtime's whole process lifetime (`session-registry.ts` respawns a fresh runtime — a new "generation" — on drift). Conversational continuity does not survive an abort, model change, or server restart, though the transcript itself does (see "Projects, sessions, tabs" above).
- Sub-agents (both the named specialists and the generic `subagent`/`subagent_fork` tools) don't get the notebook, modal_run, or interview tools — they're composed only into the main agent's tool registry, matching Pi-era scope for interview/modal_run but narrower than Pi's for notebook (which subagents could reach via a bundled package).

## Conventions

- **TypeScript everywhere**, ESM (`"type": "module"` in `server/package.json`), `.ts`/`.mts` extensions used in relative imports (`import "./env.ts"`) — this project uses `allowImportingTsExtensions` + `tsx`, so keep that pattern rather than dropping extensions.
- **Strict mode** (`strict: true` in `server/tsconfig.json`); backend has no separate lint step, so `npm run typecheck` is the correctness gate — run it before considering backend work done.
- File-level doc comments (`/** ... */` at the top of a file) are used throughout the backend to explain *why* a module exists or a non-obvious constraint (e.g. why tests run serially, why env precedence is what it is). Follow that pattern for genuinely non-obvious rationale; don't add narration comments for self-explanatory code.
- Frontend business logic goes in `lib/` as testable pure functions/hooks, not buried in components; components stay focused on rendering. New non-trivial `lib/` logic should get a colocated `*.test.ts`.
- shadcn/ui components in `web/src/components/ui/` are managed via the `shadcn` CLI (`components.json`: style `new-york`, base color `neutral`) — regenerate/add via the CLI rather than hand-authoring new primitives from scratch.
- On-disk project layout (`projects/<id>/sandbox/.pi/...`, `.kady/...`) is a stable contract with existing user data — don't restructure it casually; see `server/src/projects.ts`'s header comment for the full tree.

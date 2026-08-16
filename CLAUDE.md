# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ResearchCraft is a bring-your-own-key desktop AI research assistant: a Next.js frontend and a Fastify/TypeScript backend that embeds the [Pi coding-agent SDK](https://pi.dev) to run a single agent (plus sub-agent delegation) against any user-configured OpenAI-compatible endpoint (OpenRouter, OpenAI, or a local Ollama daemon). It is a **white-label fork of [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok)** (see `NOTICE`) — internal identifiers, env vars, and on-disk paths still use the `kady`/`KADY_` prefix from the upstream project even though the product is branded "ResearchCraft"; don't rename these, they're load-bearing for existing user data and package names.

Two services, always run together:

| Service | Dir | Port | Stack |
|---|---|---|---|
| Frontend | `web/` | 3000 | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui |
| Backend | `server/` | 8000 | Fastify, TypeScript (`tsx`, no build step for dev), Pi SDK |

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
The frontend POSTs to the backend tagged with a project id (`X-Project-Id` header / `?project` query / `researchcraft-project` cookie, resolved in `server/src/index.ts`) and a chat tab's session id. The backend runs one Pi agent turn for that session, which may delegate to sub-agents (each a short-lived `pi` subprocess in the same sandbox). Model calls go straight to the configured OpenAI-compatible endpoint (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` from the repo-root `.env`, editable live under Settings → API keys) — **no proxy**. Events (text, tool calls, cost) stream back over SSE in real time.

Every backend request runs inside an `AsyncLocalStorage`-scoped "active project" context (`server/src/scope.ts`, set in the `onRequest` hook in `index.ts`); code deep in the call stack reads the current project via `currentProjectId()`/`activePaths()` (`server/src/projects.ts`) rather than threading it through function args.

### Projects, sessions, tabs
- A **project** is a self-contained workspace at `projects/<id>/`, with a JSON registry at `projects/index.json` (`server/src/projects.ts`). The default project (`default`) is auto-created; others are minted with a random-suffixed id from their name.
- Inside a project, `sandbox/` is the Pi agent's cwd — the one thing all chat tabs in that project share (files written by one tab are instantly visible to others). Project settings (spend cap) and API keys (from the repo-root `.env`) are also shared.
- A **chat tab** = one backend **session**: an id, message history (Pi JSONL under `sandbox/.pi/sessions/`), selected model, and its own cost ledger (`sandbox/.kady/runs/<sessionId>/costs.jsonl`). Switching tabs is purely client-side; each request already carries its session id, so the backend doesn't track "active" tab state. Up to 10 tabs per project.

### Backend layout (`server/src/`)
- `index.ts` — Fastify app, CORS, the project-scope `onRequest` hook, route registration.
- `config.ts` — env-derived constants (ports, `PROJECTS_ROOT`, etc). Prefer this over reading `process.env` directly elsewhere.
- `env.ts` — loads `.env` via the shared root-level `env-file.mjs` parser (existing `process.env` always wins; import this first in any new entry point).
- `projects.ts` — project registry + path resolution (`resolvePaths`, `activePaths`).
- `scope.ts` — the `AsyncLocalStorage` project-context plumbing.
- `agent/` — all Pi wiring: `models.ts` (builds the Pi `Model` for the single user-configured OpenAI-compatible endpoint; legacy `openrouter/…`/`ollama/…` refs are stripped; `LLM_MULTIMODAL` gates image input, `LLM_PRICE_*` sets per-1M-token USD pricing for the cost meter + spend cap), `tools.ts` (builtin tool list: `read bash edit write grep find ls`), `subagent-bridge.ts`/`subagents.ts` (the `pi-subagents` delegation tool), `web-access-bridge.ts` (the `pi-web-access` search/fetch tools), `mcp.ts` (per-project MCP server bridge), `skills.ts` (seeds/lists scientific skills into `sandbox/.pi/skills/`), `notebook*.ts` (the Living Lab Notebook feature — store, export, harvest, zip, annotations), `session-*.ts`, `events.ts` (SSE event shaping).
- `api/` — Fastify route plugins, one file per resource area (`projects.ts`, `sessions.ts` = SSE chat, `sandbox.ts` = file browser/CRUD, `mcp.ts`, `credentials.ts`, `agents.ts`, `system.ts`).
- `cost/ledger.ts` — per-session/per-project USD cost tracking and budget-cap enforcement (`spendLimitUsd`).
- `latex/` — LaTeX compile/synctex/AI-assist support for the manuscript editor.
- `helpers/*.py` + `helpers-env.ts` — Python helper scripts (via `uv`) for scientific file previews (AnnData, arrays, chemistry, imaging, mass spec, structures); `syncHelperVenv()` provisions their venv on backend boot, best-effort (previews degrade gracefully if it fails).
- `pi-packages/kady-notebook/` — a local Pi extension package implementing the Lab Notebook as an agent-facing tool.

### Frontend layout (`web/src/`)
- `app/` — Next.js App Router entry (`layout.tsx`, `page.tsx`); this is a largely single-page app, not a multi-route site.
- `components/` — feature components at the top level (`chat-tab.tsx`, `settings-dialog.tsx`, `sandbox-panel.tsx`, `lab-notebook-*`, etc.), with subdirs for cohesive clusters: `ai-elements/` (streaming chat primitives), `latex/` (manuscript editor), `pdf-viewer/`, `viewers/` (scientific file-format viewers: molecule, structure, imaging, spectrum, phylo, alignment, array data — each has a matching `registry.ts` entry in `lib/viewers/`), `ui/` (shadcn/ui primitives — treat as generated, prefer adding via `shadcn` CLI per `components.json` over hand-editing).
- `lib/` — the bulk of the business logic as hooks + pure functions: `use-agent.ts` (SSE streaming + turn state), `use-sandbox.ts`, `use-projects.ts`, `use-skills.ts`, `notebook*.ts`, `latex/*` (outline, diagnostics, completions, spellcheck-as-worker, magic comments), `chat-routing.ts`, `capabilities.ts`. Most non-trivial logic here has a colocated `*.test.ts(x)`.
- `data/` — static JSON catalogues bundled with the app: `workflows.json` (see below), `databases.json`, `modal-instances.json`.
- `lib/brand.ts` + `public/brand/` — the only files that should change for white-label/rebrand work (product name, logos). Don't touch the `kady`/kAdy-prefixed internal paths under `projects/*/sandbox/.kady/` — they're intentionally unchanged for backward data compatibility.

### Workflows catalogue
`web/src/data/workflows.json` is a flat array of one-click task templates shown in the UI, grouped by `category`. Adding one is pure data — no backend code. Fields: `id`, `name`, `description`, `category` (one of 22 fixed discipline slugs — see `docs/contributing-workflows.md` for the list), `icon` (a PascalCase Lucide icon name, imported in `workflows-panel.tsx` if new), `prompt` (with `{placeholder}` tokens), `suggestedSkills` (skill ids from the external [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) repo — only use ids that actually exist there), `placeholders`, `requiresFiles`. Full authoring guidance in `docs/contributing-workflows.md`.

### Sub-agents
21 scientific specialist personas + 8 general-purpose `pi-subagents` engine agents ship per-project as markdown files at `projects/<id>/sandbox/.pi/agents/<name>.md`. The main agent decides when to delegate; users can also name one explicitly in chat. Sub-agent API surface lives in `server/src/api/agents.ts`; each specialist's full brief (what it checks, what it must flag as unverifiable rather than silently pass) is documented per-agent in `docs/sub-agents.md`.

### MCP servers
Every project is seeded (write-if-missing, disable sticks) with 4 MCP connectors — Parallel Search, Firecrawl, Scite, Consensus — configured per-project at `sandbox/.pi/mcp.json` (`server/src/agent/search-mcp.ts`, `mcp-oauth.ts`). OAuth tokens for Scite/Consensus live in `.mcp-oauth/` on the host machine, not in the project sandbox. MCP tools are currently available to the main agent only, not to sub-agents.

## Conventions

- **TypeScript everywhere**, ESM (`"type": "module"` in `server/package.json`), `.ts`/`.mts` extensions used in relative imports (`import "./env.ts"`) — this project uses `allowImportingTsExtensions` + `tsx`, so keep that pattern rather than dropping extensions.
- **Strict mode** (`strict: true` in `server/tsconfig.json`); backend has no separate lint step, so `npm run typecheck` is the correctness gate — run it before considering backend work done.
- File-level doc comments (`/** ... */` at the top of a file) are used throughout the backend to explain *why* a module exists or a non-obvious constraint (e.g. why tests run serially, why env precedence is what it is). Follow that pattern for genuinely non-obvious rationale; don't add narration comments for self-explanatory code.
- Frontend business logic goes in `lib/` as testable pure functions/hooks, not buried in components; components stay focused on rendering. New non-trivial `lib/` logic should get a colocated `*.test.ts`.
- shadcn/ui components in `web/src/components/ui/` are managed via the `shadcn` CLI (`components.json`: style `new-york`, base color `neutral`) — regenerate/add via the CLI rather than hand-authoring new primitives from scratch.
- On-disk project layout (`projects/<id>/sandbox/.pi/...`, `.kady/...`) is a stable contract with existing user data — don't restructure it casually; see `server/src/projects.ts`'s header comment for the full tree.

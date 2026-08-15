# Architecture

This page explains how ResearchCraft runs on your computer. You do not need to read this to use the app - it is here if you are curious or troubleshooting.

![ResearchCraft Architecture](k-dense-byok-architecture.png)

## The two services

The start script (`start.sh` on macOS/Linux, `start.cmd` on Windows — both thin wrappers around the cross-platform `start.mjs` launcher) launches two local services that work together:

| Service | Port | What it does |
|---------|------|--------------|
| **Frontend** (Next.js) | 3000 | The web interface in your browser - chat, file browser, and file previews |
| **Backend** (TypeScript + DeepSeek Harness) | 8000 | The "brain" - runs ResearchCraft (a single agent), manages your sandbox, files, sessions, and cost ledger |

The backend drives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ("dsh") — a subprocess per chat tab, spoken to over JSON-RPC — running **one flat agent** with built-in file/shell tools plus one delegation tool per named scientific specialist (see [Sub-agents](./sub-agents.md)) and any external tools you've connected via [MCP servers](./mcp-servers.md). Model calls go directly to **any OpenAI-compatible endpoint** — OpenRouter, a local Ollama daemon, or another compatible gateway — there is no separate proxy.

When you send a message:

1. The frontend POSTs to the backend, tagged with the project id (`X-Project-Id`) and the chat tab's session id.
2. The backend runs the dsh agent for that session; the agent uses its tools and may delegate to sub-agents (in-process children of the same runtime, not separate processes — their spend still counts toward the project budget).
3. Model calls go straight to your configured endpoint.
4. Events (text, tool calls, cost) stream back to your browser over SSE in real time.

Two real limits come from dsh's current subprocess protocol rather than being product choices: aborting a run closes and respawns the whole subprocess (no per-turn cancel), and a subprocess can't resume a prior conversation's model memory across a restart, abort, or model change — though the transcript itself stays readable (see "Chat tabs and sessions" below).

## Chat tabs and sessions

Every chat tab in the UI is backed by its own backend **session**. A session
is a single conversation: an id, an ordered list of messages, and a cost
ledger. You can open up to 10 tabs in a project; the list of tabs lives only
in the browser, but each tab's session is persistent on disk under that
project.

What a tab owns (per-tab):

- Message history: dsh writes its own durable JSONL transcript under `projects/<project>/sandbox/.dsh/sessions/`, one file per "generation" (a fresh subprocess spawn — a manifest at `sandbox/.kady/dsh-sessions/<id>.json` tracks the sequence). Reopening a session replays every generation's transcript, but a new generation's model has no memory of the earlier ones.
- The selected model.
- Attached files for the next message and the queued-message buffer.
- Cost ledger (`projects/<project>/sandbox/.kady/runs/<sessionId>/costs.jsonl`).
- The streaming connection — closing a tab aborts the in-flight turn for
  that session only.

What every tab in a project shares:

- The sandbox (`projects/<project>/sandbox/`) — files written by one tab are
  immediately visible to the others.
- Project settings: the budget cap (`spendLimitUsd`) and the project-level
  cost total shown in the header pill.
- API keys and global preferences from the repo-root `.env`.

Switching tabs in the UI is purely client-side; the backend doesn't need to
know which tab is "active" because each request already carries its own
session id. Inactive tabs stay mounted in the DOM (hidden with CSS) so a
streaming turn keeps producing output even when you're looking at another
tab.

## First-run setup

The first time you start the app (`./start.sh` or `start.cmd`), it will automatically:

- Install backend dependencies (`server/`) and frontend dependencies (`web/`)
- Install [uv](https://docs.astral.sh/uv/) if missing - the Python manager ResearchCraft uses to run analyses in each sandbox
- Create your `.env` from `.env.example` if you haven't yet, and warn if no API key (or local Ollama) is configured
- Download the scientific skills catalogue into each project's `sandbox/.pi/skills/` (the directory name is unchanged from the prior backend — it's a stable on-disk contract, not tied to which agent runtime reads it)

Subsequent starts are much faster.

## Project layout

```
k-dense-byok/
├── start.mjs             ← The launcher that starts everything (cross-platform)
├── start.sh / start.cmd  ← Thin macOS-Linux / Windows wrappers around it
├── .env                  ← Your API keys (copy from .env.example; gitignored)
├── server/               ← Backend (TypeScript, DeepSeek Harness)
│   └── src/
│       ├── index.ts          ← Fastify app, CORS, project-scope hook
│       ├── projects.ts       ← Project registry + path resolution
│       ├── agent/            ← dsh wiring: models, session-registry, tools, events, skills
│       ├── agent/dsh/        ← the ported dsh SDK layer (config, composition, HarnessRuntime)
│       ├── api/              ← Routes: projects, sessions (SSE), sandbox, system
│       ├── cost/ledger.ts    ← Cost ledger + budget caps
│       └── vendor/dsh/       ← Vendored dsh packages (pre-1.0, not on npm)
├── web/                  ← Frontend (the UI you see in your browser)
├── docs/                 ← Extended documentation (this folder)
└── projects/             ← All user work, one subdirectory per named project
    ├── index.json        ← Project registry (names, tags, archived flag)
    └── default/          ← The "Default" project
        ├── project.json      ← Project metadata
        └── sandbox/          ← Workspace (every dsh runtime's cwd)
            ├── .pi/skills/        ← Per-project scientific skills
            ├── .pi/agents/        ← Sub-agent definitions (one .md per specialist)
            ├── .pi/mcp.json       ← MCP server connections for this project
            ├── .dsh/sessions/     ← dsh's own JSONL session transcripts (one dir per generation)
            └── .kady/
                ├── dsh-sessions/<id>.json          ← per-tab generation manifest
                └── runs/<sessionId>/costs.jsonl    ← Per-session cost ledger
```

## Model selection and routing

Each chat tab uses ResearchCraft's one configured OpenAI-compatible endpoint —
`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` (`server/src/agent/models.ts`),
set under Settings → API keys. The backend wraps that endpoint as a single
`dsh-llm-pi-ai` route (itself built on
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai),
kept as a direct dependency for one-shot completions like the LaTeX assistant).
There is no proxy — dsh calls the endpoint directly. Because the wire protocol
fixes a runtime subprocess's model for its whole lifetime, changing the model
mid-conversation respawns a fresh subprocess (a new "generation" — see "Chat
tabs and sessions" above) rather than switching live. See
[Local models with Ollama](./local-models-ollama.md) and
[Model selection](./model-selection.md).

# ResearchCraft

**Bring-your-own-key AI research assistant** — local, private, and branded for ResearchCraft.

[![Site](https://img.shields.io/badge/Site-researchcraft.dev-29d4a0)](https://researchcraft.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

ResearchCraft is a free, open-source desktop app that runs an AI research assistant on **your machine**, with **your API keys**. Describe a task in plain language — *analyze this dataset*, *review my manuscript*, *search the literature*, *build this figure* — and ResearchCraft does the work: it reads and writes your files, writes and runs real analysis code, searches the web, and hands you the results.

> This build is a **white-label fork** of [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) (MIT). See [NOTICE](./NOTICE) for upstream attribution.

## Why ResearchCraft

- **No coding experience required.** You describe what you want; ResearchCraft writes and runs the code and shows you its progress as it works.
- **Your keys, your machine.** Any OpenAI-compatible endpoint — OpenRouter, OpenAI, Anthropic-compatible proxies, or local Ollama. Nothing is sent to ResearchCraft servers for inference.
- **Ask before it assumes.** When your request is ambiguous, ResearchCraft shows a short question form in the chat instead of guessing.
- **149 pre-installed scientific skills** covering genomics, proteomics, drug discovery, materials science, and more.
- **Living Lab Notebook** that writes itself as the agent works — exportable and printable.
- **Sub-agents** — a roster of scientific specialists for literature, stats, code review, and more.
- **Optional Modal / Runpod cloud compute** for heavy jobs (CPU → H100 / RTX 4090 / …), metered alongside model spend.

## Quick start

**Requirements:** Node.js 22+ (22.19+ recommended). On Windows, also install [Git for Windows](https://git-scm.com/download/win) (the agent shell uses Git Bash).

```bash
# macOS / Linux
./start.sh

# Windows
start.cmd
```

Or:

```bash
node start.mjs
```

On first run the launcher installs dependencies, seeds scientific skills, and starts:

| Service | Port |
|---|---|
| Frontend (Next.js) | http://localhost:3000 |
| Backend (agent) | http://localhost:8000 |

Create a project, drop in your data, and ask ResearchCraft for what you want — for example: *"Run a differential expression analysis on counts.csv comparing treated vs control, and plot a volcano plot."*

### API keys

Set keys in a repo-root `.env` (or via **Settings → API keys** in the app):

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1  # any OpenAI-compatible endpoint
LLM_API_KEY=sk-or-...                      # Bearer key for that endpoint
LLM_MODEL=anthropic/claude-sonnet-4        # model id the endpoint expects
# optional
LLM_CONTEXT_WINDOW=200000                  # tokens; defaults to 1M if unset
LLM_MULTIMODAL=true                        # set for vision models (image attachments)
LLM_PRICE_INPUT=0.28                       # USD per 1M tokens → accurate cost meter + spend cap
LLM_PRICE_OUTPUT=0.42
```

## Documentation

| Doc | What it covers |
|---|---|
| [Installation](./docs/installation.md) | Full setup, troubleshooting |
| [Basic usage](./docs/basic-usage.md) | Projects, chat, files |
| [File previews](./docs/file-previews.md) | Scientific formats ResearchCraft can render |
| [Living Lab Notebook](./docs/lab-notebook.md) | Real-time work log |
| [Sub-agents](./docs/sub-agents.md) | Specialist agents |
| [MCP servers](./docs/mcp-servers.md) | External tools + Parallel/Firecrawl search connectors |
| [Local models (Ollama)](./docs/local-models-ollama.md) | Running fully offline |
| [Architecture](./docs/architecture.md) | How the stack fits together |

## Branding

Product name, logos, and UI strings live under:

- `web/src/lib/brand.ts` — product strings
- `web/public/brand/` — jade mark + wordmark (aligned with [researchcraft.dev](https://researchcraft.dev) / EduVerse)

Internal data paths (e.g. `sandbox/.kady/`) are left unchanged so existing project data keeps working; they are not shown in the UI.

## License

MIT — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

**ResearchCraft** · [researchcraft.dev](https://researchcraft.dev)

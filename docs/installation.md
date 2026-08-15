# Installation guide

This guide walks you through installing ResearchCraft from scratch. No coding experience is needed — if you can copy and paste commands into a terminal, you can do this.

## 1. Check your computer

| Requirement | Details |
|-------------|---------|
| **Operating system** | macOS, Linux, or Windows 10/11. (On Windows, [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) also works if you prefer a Linux environment — but it's no longer required.) |
| **Node.js ≥ 22.19** | The startup script installs it for you via Homebrew on a Mac if it's missing. On Linux, install it from [nodejs.org](https://nodejs.org/). On Windows, install it from [nodejs.org](https://nodejs.org/) or run `winget install OpenJS.NodeJS.LTS`. |
| **git** | Pre-installed on most macOS/Linux systems (on a Mac, run `xcode-select --install` if it's missing). **Windows: required** — install [Git for Windows](https://git-scm.com/download/win) with its default components; it provides the Git Bash shell ResearchCraft's agent uses to run commands. |

Everything else (Python tooling, packages, scientific skills) is installed automatically the first time you start the app.

> **Optional — LaTeX PDF reports:** if you want ResearchCraft's LaTeX editor to compile PDFs, install a TeX distribution: [MacTeX](https://www.tug.org/mactex/) (macOS), TeX Live (Linux), or [MiKTeX](https://miktex.org/) / [TeX Live](https://www.tug.org/texlive/) (Windows). Not needed for normal use.

## 2. Get a model API key

ResearchCraft is "Bring Your Own Keys": the app is free, and you pay only for the AI model usage on your own account. It works with any **OpenAI-compatible endpoint** — the easiest is OpenRouter:

1. Go to [openrouter.ai](https://openrouter.ai/) and sign up.
2. Add a small amount of credit (a few dollars is plenty to start).
3. Create an API key and copy it — it looks like `sk-or-...`.

OpenRouter is a single account that gives you access to models from OpenAI, Anthropic, Google, xAI, Qwen, and more, so you don't need separate accounts with each provider. (You can also use OpenAI directly, an Anthropic-compatible proxy, or any other OpenAI-compatible API.)

> **Prefer not to pay anything?** You can run the app entirely on free local models instead — see [Local models with Ollama](./local-models-ollama.md). In that case you can skip the API key.

## 3. Download the project

Open a terminal (on a Mac: press `Cmd+Space`, type "Terminal", press Enter; on Windows: press `Win`, type "PowerShell" or "Terminal", press Enter) and run:

```bash
# If you received a zip of this app:
#   unzip researchcraft.zip && cd researchcraft
# Or clone your private ResearchCraft repo:
#   git clone <your-repo-url> researchcraft && cd researchcraft
cd researchcraft
```

Move into the project folder (named `researchcraft` if you used the commands above).

## 4. Add your model endpoint

In the project folder there is a template file called `.env.example`. Copy it to a file called `.env` (note the dot at the start):

```bash
cp .env.example .env      # macOS / Linux
copy .env.example .env    # Windows
```

Open `.env` in any text editor and fill in your endpoint:

```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-your-key-here
LLM_MODEL=anthropic/claude-sonnet-4
```

`LLM_BASE_URL` is any OpenAI-compatible endpoint, `LLM_API_KEY` is its key (optional for some local servers), and `LLM_MODEL` is the model id the endpoint expects. That's all you need. If you skip this step, the startup script creates the `.env` file for you and reminds you — and you can also fill these in later inside the app under **Settings → API keys**.

## 5. Start the app

```bash
./start.sh     # macOS / Linux
.\start.cmd    # Windows
```

(Both are thin wrappers around the same cross-platform launcher — `node start.mjs` works anywhere too.)

The first run takes a few minutes. The script automatically:

- checks for and installs anything missing (Node.js on a Mac, the [uv](https://docs.astral.sh/uv/) Python manager that ResearchCraft uses to run analyses — on every platform),
- installs the backend and frontend packages,
- downloads the catalogue of 140+ scientific skills,
- creates your `.env` file if you haven't, and warns you clearly if no API key (or local Ollama) is set up.

When it finishes, your browser opens to **[http://localhost:3000](http://localhost:3000)** — that's the app. Future starts take only a few seconds.

To stop the app, go back to the terminal and press **Ctrl+C**.

## 6. Optional API keys

These unlock extra capabilities. All of them can be added later in **Settings → API keys** — none are required to get started.

| Key | What it adds | Where to get it |
|-----|--------------|-----------------|
| **Parallel** | Higher rate limits for the built-in Parallel Search MCP connector (web search). Works free without a key. | [platform.parallel.ai](https://platform.parallel.ai) |
| **Firecrawl** | Full Firecrawl MCP tools (scrape, crawl, extract, agent). Keyless free tier covers scrape/search/interact. | [firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys) |
| **Scite / Consensus** | Scientific literature search (Smart Citations / peer-reviewed evidence). No API key — use **Settings → Connectors → Sign in** (OAuth). | [scite.ai/mcp](https://scite.ai/mcp) · [docs.consensus.app](https://docs.consensus.app/docs/mcp) |
| **Exa** | Direct web + code search with neural retrieval (pi-web-access). Web search works without it via a free fallback. | [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) |
| **Perplexity** | Alternative web search with synthesized, cited answers. | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| **Gemini** | Search fallback plus YouTube / video understanding. | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

The `.env` file also lists keys for specific scientific databases (NCBI, Materials Project, openFDA, FRED, NASA, and many more). You only need those if a task touches the corresponding database and it asks for one.

## Updating to a new version

From the project folder:

```bash
git pull
./start.sh     # macOS / Linux
.\start.cmd    # Windows
```

The startup script picks up any new packages and skills automatically.

## Troubleshooting

- **`./start.sh: Permission denied`** (macOS/Linux) — run `chmod +x start.sh` once, then try again.
- **Windows says "Windows protected your PC"** when double-clicking `start.cmd` — click *More info → Run anyway*, or run it from a terminal instead (`.\start.cmd`).
- **Browser doesn't open** — go to [http://localhost:3000](http://localhost:3000) manually.
- **"No API key" warning** — make sure your key is in `.env` (the file is `.env`, not `.env.example`), or paste it in **Settings → API keys** inside the app.
- **Port already in use** — the startup script clears leftover ResearchCraft processes automatically and names any other program holding port 3000 or 8000. Quit the program it names (or set `KADY_PORT` in `.env` to move the backend) and start the app again.
- **Something else?** — [Open a GitHub issue](https://researchcraft.dev); we read every one.

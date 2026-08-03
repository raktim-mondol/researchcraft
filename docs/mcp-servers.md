# Connecting external tools (MCP servers)

Out of the box, ResearchCraft can read and write files, run code, and delegate to [sub-agents](./sub-agents.md). **MCP servers** let you give it more abilities - searching the web, querying a database, reading your reference manager, controlling lab software, and so on.

MCP ([Model Context Protocol](https://modelcontextprotocol.io)) is an open standard for connecting AI assistants to external tools. Many services publish an MCP server, and there are hundreds of community-built ones. When you connect one, every tool it provides shows up in ResearchCraft's toolbox automatically.

## Built-in search & literature connectors

Every project is seeded with four MCP servers (Settings → Connectors). You can disable any without losing the config; ResearchCraft will not re-seed a connector you turned off.

### Web search & scrape (optional API keys)

Both work without an API key on free tiers; optional keys in **Settings → API keys** raise rate limits and unlock more Firecrawl tools. Keys stay in your local `.env` — they are never written into `mcp.json`.

| Connector | Server name | What it does | Key (optional) |
|---|---|---|---|
| **Parallel Search** | `parallel` | Low-latency web search for agent loops ([Search MCP](https://docs.parallel.ai/integrations/mcp)) | `PARALLEL_API_KEY` — [platform.parallel.ai](https://platform.parallel.ai) |
| **Firecrawl** | `firecrawl` | Scrape, crawl, map, extract, and research the live web ([Firecrawl MCP](https://docs.firecrawl.dev/mcp-server)) | `FIRECRAWL_API_KEY` — [firecrawl.dev](https://www.firecrawl.dev/app/api-keys) |

### Scientific literature (OAuth)

| Connector | Server name | What it does | Auth |
|---|---|---|---|
| **Scite** | `scite` | Search 250M+ papers with Smart Citations ([Scite MCP](https://scite.ai/mcp)) | **Sign in** (OAuth) in Settings → Connectors |
| **Consensus** | `consensus` | Search 200M+ peer-reviewed papers for evidence synthesis ([Consensus MCP](https://docs.consensus.app/docs/mcp)) | **Sign in** (OAuth) in Settings → Connectors |

Click **Sign in** next to Scite or Consensus — a browser window opens to the provider. After you authorize, ResearchCraft stores tokens under `.mcp-oauth/` on your machine (not in the project sandbox). Open a **new chat tab** so the agent loads the literature tools. Use **Sign out** to revoke local tokens.

Built-in [pi-web-access](https://github.com/nicobailon/pi-web-access) tools (`web_search`, `fetch_content`, …) remain available as a general-web fallback.

## Adding a server

Open **Settings (gear icon) → MCP servers** and click *Add server*. There are two kinds:

### Remote (HTTP)

A server hosted somewhere on the internet. You need its URL and, usually, an access token from your account on that service.

- **Name**: anything you like, e.g. `linear`
- **Server URL**: e.g. `https://mcp.example.com/mcp`
- **Bearer token**: the access token, if the service requires one

### Local (command)

A small program that runs on your own computer when needed. These are typically published as npm packages and need no hosting.

- **Command**: usually `npx`
- **Arguments**: e.g. `-y @modelcontextprotocol/server-github`
- **Environment variables**: any keys the server needs, one per line, e.g. `GITHUB_TOKEN=ghp_…`

Click **Test connection** before saving - it dials the server and lists the tools it offers, so you catch a typo'd URL or token immediately.

## Using the tools

Nothing special required. Once a server is saved, its tools are available to ResearchCraft in **new chat tabs** in that project. Ask naturally - "search our GitHub issues for failed CI runs" - and ResearchCraft picks the right tool.

## Good to know

- **Per project.** Each project has its own server list, stored in the project at `sandbox/.pi/mcp.json`. Tokens stay on your machine.
- **A broken server never blocks you.** If a server is down or misconfigured, ResearchCraft starts without it (you'll see a warning in the backend logs) and everything else works normally.
- **Changes apply to new chat tabs.** Already-open tabs keep the toolset they started with.
- **Sub-agents don't see MCP tools yet.** Tools from MCP servers are currently available to ResearchCraft itself but not to the sub-agents it spawns. This is on the roadmap.
- **Trust matters.** A local (command) server is a program running on your computer with your permissions, and a remote server receives whatever ResearchCraft sends it. Only connect servers you trust.

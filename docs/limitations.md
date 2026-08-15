# Known Limitations

ResearchCraft is in beta. The agent now runs on the [Pi coding-agent SDK](https://pi.dev) - a single flat agent with file/shell tools and a `subagent` delegation tool (pi-subagents) - which removed the old orchestrator/expert/Gemini-CLI stack and its biggest rough edges. The remaining limitations worth knowing are below.

## Skills depend on model quality

Scientific skills are markdown procedures (`SKILL.md`) the agent discovers in its sandbox and follows with its tools. How faithfully that happens depends on the selected model:

- **Skill activation is not always reliable.** Models sometimes skip a relevant skill, use it partially, or misinterpret the skill's instructions - especially complex multi-step skills that require strict adherence to a procedure.
- **Tool-calling consistency varies across models.** Some models occasionally drop tool calls or call tools with incorrect arguments, which can stall a task or produce incomplete results.
- **Long-context degradation.** When a skill injects a large amount of context (detailed protocols, multiple reference databases), models may lose track of earlier instructions.
- **Structured output can drift.** For skills that require specific output formats (tables, JSON, citations), models sometimes deviate from the requested structure.

These are limitations of the selected model, not of ResearchCraft itself; as model tool calling improves, skill execution improves automatically.

**Workarounds:**

- If a skill isn't behaving as expected, try **re-running the task** - results can vary between runs.
- Try a different model in Settings → API keys — tool-calling quality still varies across providers and model sizes.

## Ollama / small local models

Local models served through Ollama are supported end-to-end, but they amplify the caveats above:

- Tool-calling fidelity is noticeably weaker on sub-frontier models.
- Skills that rely on multi-tool choreography (running scripts, chaining edits, structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch to a frontier hosted model) before assuming the workflow is broken. See [Local models with Ollama](./local-models-ollama.md).

## Tabbed chats

- **Hard cap of 10 tabs per project.** This keeps the browser snappy and
  bounds the number of parallel SSE streams to the backend. Close an
  existing tab before opening a new one once you hit the limit.
- **Tab list isn't persisted across reloads.** Refreshing the page resets
  you to a single new chat tab. Your conversations aren't lost: the clock
  ("Chat history") button in the tab strip lists every stored session in
  the project — pick one to reopen its full transcript in a tab and keep
  chatting. Restoring the whole tab *layout* automatically is still on
  the roadmap.
- **Workflows launch into the active tab.** If you have a long-running
  turn streaming in tab A and click Launch on a workflow while tab B is
  active, the workflow runs in tab B. Switch to the tab you want to
  receive the workflow before launching.

## Web access

Native web access ([pi-web-access](https://github.com/nicobailon/pi-web-access)) plus seeded **Parallel**, **Firecrawl**, **Scite**, and **Consensus** MCP connectors give ResearchCraft web search, scraping, and scientific literature search. A few edges:

- **Parallel + Firecrawl ship by default.** Keyless free tiers work; optional API keys in Settings raise limits. Firecrawl's full tool surface (crawl, extract, agent, …) needs a key.
- **Scite + Consensus need OAuth.** They are seeded into Connectors but tools only appear after **Sign in** (browser OAuth). Tokens live in local `.mcp-oauth/`; open a new chat tab after signing in. Sub-agents still do not see MCP tools.
- **No Exa/Perplexity/Gemini key = shared pi-web-access fallback.** Prefer Parallel for open-web search and Scite/Consensus for literature when signed in.
- **Video understanding needs a Gemini key.** YouTube and local-video analysis are only available once `GEMINI_API_KEY` is set.
- **PDF extraction is text-only** via pi-web-access (Firecrawl parse can help when a key is set).
- **Web access for sub-agents applies to new chat tabs**, same as agent and MCP edits below.

## Sub-agents

Sub-agent delegation ([docs](./sub-agents.md)) works end-to-end, with a couple of edges:

- **Sub-agents can't use MCP tools yet.** Tools from connected [MCP servers](./mcp-servers.md) are available to ResearchCraft itself but not to the sub-agents it spawns. Making them available to sub-agents is on the roadmap.
- **Per-agent model overrides must name an available model.** If you set a model on an agent in Settings → Sub-agents, use an id from the model dropdown; an unrecognized id falls back to the default model rather than failing.
- **Changes apply to new chat tabs.** Agents edited in Settings (and MCP server changes) take effect in tabs opened afterwards; already-running tabs keep the setup they started with.

## Native Windows support is new

The app now runs natively on Windows 10/11 (no WSL needed) as of this release. It goes through the same test suite as macOS/Linux, but has had less real-world mileage — if you hit something Windows-specific, please [open a GitHub issue](https://researchcraft.dev). WSL remains a supported alternative.

## Features deferred during the Pi migration

Literature search (Paperclip), document conversion, and citation verification / "Copy as Methods" provenance export are not available yet as first-party tools in the Pi-based backend. Remote compute (Modal) and web search/scrape (Parallel + Firecrawl MCP, pi-web-access) are available. Other deferred keys in `.env.example` remain unused until those integrations return. In the meantime, many capabilities (GitHub, reference managers, ...) can be added today by connecting an [MCP server](./mcp-servers.md).

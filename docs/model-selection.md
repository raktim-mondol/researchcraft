# Model Selection

There is a single flat agent — no separate "expert" or orchestrator model.
ResearchCraft runs **one model** for everything: the endpoint you configure
under **Settings → API keys** (stored in the repo-root `.env`). Subagents
spawned with the `subagent` tool use the model named in their agent file
(`sandbox/.pi/agents/*.md`) or passed per call; otherwise they fall back to
Pi's default model resolution.

## The configured endpoint

ResearchCraft talks to any **OpenAI-compatible** endpoint:

- `LLM_BASE_URL` — base URL (include the `/v1` path if the provider uses it),
  e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or
  `http://localhost:11434/v1` for Ollama.
- `LLM_API_KEY` — Bearer key for that endpoint (optional for some local servers).
- `LLM_MODEL` — the model id the endpoint expects (e.g. `gpt-4o`,
  `anthropic/claude-sonnet-4`, `llama3.2`).
- `LLM_CONTEXT_WINDOW` — optional token budget for the context meter and
  auto-compaction (defaults to 1,000,000 when unset).
- `LLM_MULTIMODAL` — set `true` only when the model accepts image blocks
  (vision). Text-only by default; while off, runs with image attachments are
  rejected with a clear error instead of the images being silently dropped.
- `LLM_PRICE_INPUT` / `LLM_PRICE_OUTPUT` / `LLM_PRICE_CACHE_READ` — optional
  USD per 1M tokens for the cost meters and the project spend cap.

Set these in Settings → API keys (saved live to `.env`) or edit `.env`
directly. There is no model catalogue and no dropdown — to change the model,
edit the model name in Settings.

## Switching models

The configured model applies to every chat tab. Change `LLM_MODEL` in
Settings → API keys and the next run uses it — no restart needed.

## Cost tracking

Your endpoint is billed directly by your provider, and ResearchCraft has no
catalogue pricing for it — but you can tell it your rates under **Settings →
API keys → Pricing (USD per 1M tokens)**. With prices set, the session/project
cost meters and the project spend cap are computed from token usage on every
run, even when the provider reports no usage cost itself. Leave the prices
blank to track only what the provider reports (which can be $0 for some
endpoints).

## Local Ollama models

Point `LLM_BASE_URL` at Ollama's OpenAI-compatible API
(`http://localhost:11434/v1`) and set `LLM_MODEL` to a pulled model name. See
[Local models with Ollama](./local-models-ollama.md).

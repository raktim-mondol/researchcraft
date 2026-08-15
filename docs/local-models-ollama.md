# Local Models with Ollama

You can run ResearchCraft entirely against local models served by
[Ollama](https://ollama.com) - no paid API key required. This is useful if you
want to keep everything on your machine or experiment without spending on API
calls.

## Setup

1. **Install Ollama and start the daemon:**

   ```bash
   # macOS / Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

   On Windows, download and run the installer from [ollama.com/download](https://ollama.com/download) — it starts the daemon for you.

2. **Pull one or more models:**

   ```bash
   ollama pull qwen2.5-coder:7b
   ollama pull llama3.2
   ```

3. **Point ResearchCraft at Ollama's OpenAI-compatible API.** In
   **Settings → API keys** (or the repo-root `.env`):

   ```bash
   LLM_BASE_URL=http://localhost:11434/v1
   LLM_MODEL=qwen2.5-coder:7b   # any model you've pulled
   ```

   `LLM_API_KEY` can stay empty — Ollama ignores it. If your Ollama server
   lives on another machine, use that host instead (e.g.
   `http://192.168.1.50:11434/v1`).

4. That's it — the next message runs against your local daemon. To switch
   models, change `LLM_MODEL` in Settings; no restart needed.

## Caveats

Local models are fully supported, but skill-heavy work leans on model quality
(see [Known limitations](./limitations.md)):

- **Tool-calling fidelity is noticeably weaker** on sub-frontier models.
- **Skills that rely on multi-tool choreography** (running scripts, chaining file edits, producing structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or
temporarily switch to a frontier hosted model) before assuming the workflow is
broken.

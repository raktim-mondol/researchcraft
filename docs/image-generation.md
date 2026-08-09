# Image generation

ResearchCraft can generate **conceptual images** (schematics, proposal diagrams,
illustrations) with the agent tool `image_generate`. Images are written into
your project sandbox (usually under `figures/`) so you can preview them and
include them in LaTeX.

This is **not** a substitute for quantitative plots from data. For volcano
plots, heatmaps, ROC curves, etc., have the agent write Python
(`matplotlib` / `seaborn`) instead.

## Setup

Image generation is **independent of the chat LLM**. Your chat model may be
Qwen, Ollama, Claude, etc.; image APIs need their own credentials.

1. Open **Settings → API keys**.
2. Under **Image generation**, set **Image model**, for example:
   - OpenAI Image API (single-shot generate — not the Responses API tool):
     - `gpt-image-2` (latest), `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`, or `dall-e-3`
     - Your OpenAI org may need [API Organization Verification](https://help.openai.com/en/articles/10910291-api-organization-verification) for GPT Image models
   - Gemini Nano Banana (recommended defaults first):
     - `gemini-3.1-flash-image` — Nano Banana 2 (best general default)
     - `gemini-3.1-flash-lite-image` — Nano Banana 2 Lite (fast/cheap)
     - `gemini-3-pro-image` — Nano Banana Pro (highest quality / 4K)
     - `gemini-2.5-flash-image` — legacy Nano Banana
3. Credentials (dedicated — **not** the chat endpoint):
   - **OpenAI path:** `IMAGE_BASE_URL` (e.g. `https://api.openai.com/v1`) +
     `IMAGE_API_KEY` (OpenAI `sk-…`). Required even if chat uses another provider.
   - **Gemini path:** `GEMINI_API_KEY` (same optional key as Gemini search), or
     `IMAGE_API_KEY` as an override. Base URL is fixed to Google’s API.
4. Save, then open a **new chat tab** so the tool registers.

You can also set env vars in `.env` (see `.env.example`).

## How the agent uses it

Ask in chat, for example:

> Generate a clean schematic of our multi-omics integration pipeline and save it
> to `figures/pipeline.png`.

The agent calls `image_generate` with a `prompt` and `path`. The file appears
in the left file browser.

Optional parameters: `provider`, `model`, `size` / `aspect_ratio`, `quality`,
`reference_paths` (Gemini compose/edit), `n` (OpenAI candidates).

## Availability

- **Lead agent** — in-process tool when image gen is configured.
- **Subagents** — same tool via the vendored `kady-image-generate` Pi package.

## Cost and caveats

- Providers bill your API account. ResearchCraft records an **approximate**
  cost toward the project spend limit on lead-agent calls.
- Generative images may invent labels or structure — treat them as drafts.
- Gemini images may include a SynthID watermark (provider policy).
- Chat-only proxies (including many Qwen / OpenRouter chat endpoints) do
  **not** implement OpenAI’s `/images/generations`. Point `IMAGE_BASE_URL` at
  a real Images API (usually `https://api.openai.com/v1`).

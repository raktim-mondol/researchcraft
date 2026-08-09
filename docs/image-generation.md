# Image generation

ResearchCraft can generate **conceptual images** (schematics, proposal diagrams,
illustrations) with the agent tool `image_generate`. Images are written into
your project sandbox (usually under `figures/`) so you can preview them and
include them in LaTeX.

This is **not** a substitute for quantitative plots from data. For volcano
plots, heatmaps, ROC curves, etc., have the agent write Python
(`matplotlib` / `seaborn`) instead.

## Setup

1. Open **Settings → API keys**.
2. Under **Image generation**, set **Image model**, for example:
   - OpenAI: `gpt-image-2` (or `gpt-image-1`, `dall-e-3`)
   - Gemini (Nano Banana): `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image`
3. Credentials:
   - **OpenAI path** reuses your model endpoint base URL + API key by default
     (`LLM_BASE_URL` / `LLM_API_KEY`). Override with `IMAGE_BASE_URL` /
     `IMAGE_API_KEY` if needed.
   - **Gemini path** uses `GEMINI_API_KEY` (same key as optional Gemini search).
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
- Chat-only proxies often do **not** implement OpenAI’s `/images/generations`;
  point `IMAGE_BASE_URL` at a real Images API if needed.

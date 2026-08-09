---
name: image-generate
description: >-
  When and how to generate conceptual scientific figures with the image_generate
  tool (OpenAI GPT Image / Gemini Nano Banana). Prefer Python plots for
  quantitative data figures. Covers providers, paths, reference images, and limits.
---

# Image generation (`image_generate`)

Generate **conceptual** images (schematics, proposal diagrams, cover art, style
mocks) via the `image_generate` tool. The result is a file in the project
sandbox — open it in the file panel or embed it in LaTeX.

## When to use

**Do use image_generate when:**
- The user wants a schematic workflow figure, conceptual diagram, or illustration
  for a proposal/paper that is **not** computed from tabular data.
- They ask for “generate a figure of …”, “illustrate …”, or similar and no
  dataset needs to be plotted accurately.
- Optional `reference_paths` can guide style/layout (Gemini models).

**Do NOT use image_generate when:**
- The figure must plot **real data** (volcano, ROC, heatmap, PCA, …) — write
  Python with matplotlib/seaborn instead.
- Axis values, sample sizes, or statistics must be exact and reproducible.
- The tool is missing (not configured) — tell the user to set **Image model** in
  Settings → API keys and open a **new chat tab**.

## Providers

| Provider | Example models | Credentials (separate from chat LLM) |
| --- | --- | --- |
| OpenAI Images | `gpt-image-2`, `gpt-image-1`, `dall-e-3` | `IMAGE_BASE_URL` + `IMAGE_API_KEY` (required; never reuse chat Qwen/etc.) |
| Gemini Nano Banana | `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image` | `GEMINI_API_KEY` (or `IMAGE_API_KEY`) |

Gemini supports multi-image compose/edit via `reference_paths`. OpenAI path is
text-to-image only in this version.

Gemini outputs may include a SynthID watermark (provider policy).

## Calling pattern

```text
image_generate(
  prompt="Publication-style schematic of CRISPR knockout workflow, labeled panels, white background, vector-like",
  path="figures/crispr_schematic.png",
  aspect_ratio="16:9"   # Gemini
)
```

1. Prefer `figures/` for outputs.
2. Write a detailed prompt (layout, labels, style, “no invented numbers”).
3. Tell the user the saved path and that generative art is conceptual.
4. For data figures, switch to code — do not “draw” a fake volcano plot.

## Cost

Approximate cost is ledgered on the lead agent; the provider bills the real
amount on the user’s API account. Keep prompts scoped; avoid bulk generation
unless requested.

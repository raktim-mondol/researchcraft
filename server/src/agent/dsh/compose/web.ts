/**
 * Native dsh web-access rows: the `ctx.web` seam (`dsh-web`), the model-facing
 * `web_search`/`web_fetch` tools (`dsh-tool-web`), a fetch provider
 * (`dsh-web-fetch-http`, keyless), and whichever search providers have a
 * credential available (`dsh-web-search-exa`/`dsh-web-search-perplexity`).
 * Each search provider package reads its own API key straight from the
 * runtime subprocess's inherited environment (`EXA_API_KEY`/
 * `PERPLEXITY_API_KEY` via `dsh-launch-environment` — the same env
 * `HarnessRuntime` already forwards) when not passed in config, so nothing
 * here needs to plumb key material through explicitly — mirrors this SDK's
 * `apiKeyEnv` pattern in `compose/llm.ts` rather than duplicating it.
 *
 * Replaces the old Pi-era `web-access-bridge.ts`, which had to seed a
 * `pi-web-access` package reference into project settings and pre-trust the
 * sandbox because Pi had no built-in web tools — none of that plumbing
 * exists here since these are ordinary composed plugin rows.
 */
import { row, type PluginRow } from './rows.ts'

export interface WebAccessOptions {
  /** Register the Exa search provider (requires EXA_API_KEY in the runtime's env). */
  exa?: boolean
  /** Register the Perplexity search provider (requires PERPLEXITY_API_KEY in the runtime's env). */
  perplexity?: boolean
}

export function buildWebRows(options: WebAccessOptions = {}): PluginRow[] {
  const rows: PluginRow[] = [
    row('web', '@deepseek-ai/dsh-web'),
    row('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    row('tool-web', '@deepseek-ai/dsh-tool-web'),
  ]
  if (options.exa) rows.push(row('web-search-exa', '@deepseek-ai/dsh-web-search-exa'))
  if (options.perplexity) rows.push(row('web-search-perplexity', '@deepseek-ai/dsh-web-search-perplexity'))
  return rows
}

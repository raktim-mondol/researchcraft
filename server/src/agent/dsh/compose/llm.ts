/** Build the `dsh-llm-pi-ai` row from the configured OpenAI-compatible routes. */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import type { LlmRouteConfig } from '../types.ts'
import { row, type PluginRow } from './rows.ts'

function buildProviderProfile(route: LlmRouteConfig): Record<string, unknown> {
  return {
    ...route.displayName !== undefined ? { displayName: route.displayName } : {},
    ...route.apiKeyEnv !== undefined ? { apiKeyEnv: route.apiKeyEnv } : {},
    api: route.api ?? 'openai-completions',
    baseURL: route.baseURL,
    ...route.headers !== undefined ? { headers: route.headers } : {},
    ...route.defaultContextWindow !== undefined ? { defaultContextWindow: route.defaultContextWindow } : {},
    ...route.defaultMaxTokens !== undefined ? { defaultMaxTokens: route.defaultMaxTokens } : {},
    ...route.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: route.streamIdleTimeoutMs } : {},
    ...route.retryPolicy !== undefined ? { retryPolicy: route.retryPolicy } : {},
    models: route.models.map(model => ({
      id: model.id,
      ...model.name !== undefined ? { name: model.name } : {},
      ...model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {},
      ...model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {},
      ...model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {},
    })),
  }
}

export function buildLlmRow(config: ResolvedHarnessSdkConfig): PluginRow {
  const providers: Record<string, unknown> = {}
  for (const route of config.llm) providers[route.name] = buildProviderProfile(route)
  return row('llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai', { providers })
}

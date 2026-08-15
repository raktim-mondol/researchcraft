import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { buildLlmRow } from './llm.ts'
import { buildMcpRows } from './mcp.ts'
import { buildMiscRows } from './misc.ts'
import { buildSandboxRows } from './sandbox.ts'
import { buildSessionRows } from './session.ts'
import { buildSpineRow } from './spine.ts'
import { buildSubagentRows } from './subagents.ts'
import type { PluginRow } from './rows.ts'

export { serializeCordisTree } from './yaml.ts'
export type { PluginRow } from './rows.ts'

/** Assemble the complete Cordis plugin-row tree for one resolved config. */
export function composeCordisTree(config: ResolvedHarnessSdkConfig): PluginRow[] {
  return [
    buildSpineRow(config),
    buildLlmRow(config),
    ...buildSessionRows(config),
    ...buildSandboxRows(config),
    ...buildMiscRows(config),
    ...buildSubagentRows(config),
    ...buildMcpRows(config),
  ]
}

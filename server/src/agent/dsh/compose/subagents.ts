/**
 * Subagent delegation rows, mirroring `dsh-base`'s composition: the core
 * `ctx.subagents` registry, the `spawn` and `fork` in-process providers, the
 * model-facing `subagent`/`subagent_fork` tools (spawn runs continuable —
 * resident, accepts `send_message` follow-ups — while fork stays one-shot,
 * matching upstream's own "fork children stay one-shot" design note), the
 * optional global control tools (`send_message`/`interrupt_agent`/
 * `list_agents`), and the optional child-scoped `report` tool.
 */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { row, type PluginRow } from './rows.ts'

export function buildSubagentRows(config: ResolvedHarnessSdkConfig): PluginRow[] {
  const { subagents } = config
  if (!subagents.spawn && !subagents.fork) return []

  const rows: PluginRow[] = [row('subagent', '@deepseek-ai/dsh-subagent')]

  if (subagents.spawn) {
    rows.push(row('subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-spawn-in-process', { providerName: 'spawn' }))
  }
  if (subagents.fork) {
    rows.push(row('subagent-fork-in-process', '@deepseek-ai/dsh-subagent-fork-in-process', { providerName: 'fork' }))
  }

  if (subagents.control) {
    rows.push(row('tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control'))
    rows.push(row('tool-subagent-list-agents', '@deepseek-ai/dsh-tool-subagent-control/list-agents'))
  }

  if (subagents.spawn) {
    rows.push(row('tool-subagent', '@deepseek-ai/dsh-tool-subagent', {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: subagents.continuable ? 'continuable' : 'one-shot',
    }))
  }
  if (subagents.fork) {
    // Fork children see the parent's inherited history already; a resident,
    // messageable fork child would let the "report" and continuation prompt
    // sections precede that inherited prefix, which upstream deliberately
    // avoids — so fork always runs one-shot regardless of `continuable`.
    rows.push(row('tool-subagent-fork', '@deepseek-ai/dsh-tool-subagent', {
      provider: 'fork',
      toolName: 'subagent_fork',
      backgroundMode: 'one-shot',
    }))
  }

  if (subagents.report && subagents.continuable && subagents.spawn) {
    rows.push(row('tool-subagent-report', '@deepseek-ai/dsh-tool-subagent-report'))
  }

  return rows
}

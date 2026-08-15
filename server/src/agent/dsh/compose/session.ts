import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { row, type PluginRow } from './rows.ts'

export function buildSessionRows(config: ResolvedHarnessSdkConfig): PluginRow[] {
  return [
    row('sessions', '@deepseek-ai/dsh-session-persistence-jsonl', {
      root: config.sessionsRoot,
      compression: 'none',
    }),
    row('session-checkpoints', '@deepseek-ai/dsh-session-checkpoint-policy'),
    // Needed for durable subagent catalog identity (mode/label) — the
    // `list_agents` control tool and continuable-child listing fail loud
    // without it.
    row('session-projection', '@deepseek-ai/dsh-session-projection'),
  ]
}

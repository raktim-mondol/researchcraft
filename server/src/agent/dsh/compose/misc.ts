/**
 * Remaining production-composition rows that don't warrant their own file:
 * token accounting, context compaction (+ oversized tool-result pruning),
 * large-output spill, per-tool-call timeout enforcement, the `todo_write`
 * tool, a repeat-tool-call nudge, and finally the JSON-RPC serving plugin
 * that turns this whole tree into something `dsh-sdk-client` can drive.
 */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { row, type PluginRow } from './rows.ts'

const SPILL_MAX_INLINE_BYTES = 50_000
const COMPACTION_THRESHOLD_RATIO = 0.8
const COMPACTION_RETAIN_RATIO = 0.16
const COMPACTION_MAX_TOKENS = 8192
const COMPACTION_RETRIES = 1
const PRUNER_THRESHOLD_CHARS = 8192
const PRUNER_HEAD_CHARS = 4096
const PRUNER_TAIL_CHARS = 1024
const REMINDER_THRESHOLDS = [3, 5, 8]
const REMINDER_PREVIEW_CHARS = 500

export function buildMiscRows(config: ResolvedHarnessSdkConfig): PluginRow[] {
  return [
    row('token-meter', '@deepseek-ai/dsh-token-meter'),
    row('compaction-basic', '@deepseek-ai/dsh-compaction-basic', {
      thresholdRatio: COMPACTION_THRESHOLD_RATIO,
      retainRatio: COMPACTION_RETAIN_RATIO,
      maxTokens: COMPACTION_MAX_TOKENS,
      compactionRetries: COMPACTION_RETRIES,
    }),
    row('tool-result-pruner', '@deepseek-ai/dsh-compaction-tool-result-pruner', {
      thresholdChars: PRUNER_THRESHOLD_CHARS,
      headChars: PRUNER_HEAD_CHARS,
      tailChars: PRUNER_TAIL_CHARS,
    }),
    row('spill-local', '@deepseek-ai/dsh-spill-local'),
    row('spill-policy', '@deepseek-ai/dsh-spill-policy', { maxInlineBytes: SPILL_MAX_INLINE_BYTES }),
    row('timeout-policy', '@deepseek-ai/dsh-tool-call-timeout-policy'),
    row('tool-todo', '@deepseek-ai/dsh-tool-todo', { allowParallelInProgress: true }),
    row('repeat-tool-reminder', '@deepseek-ai/dsh-repeat-tool-reminder', {
      thresholds: REMINDER_THRESHOLDS,
      argumentsPreviewChars: REMINDER_PREVIEW_CHARS,
    }),
    row('sdk-jsonrpc-server', '@deepseek-ai/dsh-sdk-jsonrpc-server', {
      maxTokensAsSuccess: config.maxTokensAsSuccess,
    }),
  ]
}

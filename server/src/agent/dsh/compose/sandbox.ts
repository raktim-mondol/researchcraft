/**
 * Sandboxed bash + filesystem tool chain — the same primitives the real
 * `dsh-base` bundle uses (`subprocess-local` -> `sandbox-local` ->
 * `sandbox-policy` -> the platform bash executor -> `tool-bash`, and
 * `fs-sandbox` -> `fs-observation-policy` -> `tool-fs`/`tool-fs-search`/
 * `tool-str-replace-editor`), rather than the unsandboxed `bash-local`/
 * `fs-local` the official jsonrpc-agent SDK example uses. A headless
 * embedding SDK still wants a real file-effect policy by default; see
 * `SandboxConfig` for how a caller widens or narrows it.
 */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { row, type PluginRow } from './rows.ts'

const BASH_TIMEOUT_MS = 60_000

export function buildSandboxRows(config: ResolvedHarnessSdkConfig): PluginRow[] {
  const isWindows = process.platform === 'win32'
  const rows: PluginRow[] = [
    row('subprocess', '@deepseek-ai/dsh-subprocess-local'),
    row('sandbox', '@deepseek-ai/dsh-sandbox-local'),
    row('sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', {
      mode: config.sandbox.mode,
      workspaceRoot: config.workspaceRoot,
    }),
    row('shell-env', '@deepseek-ai/dsh-shell-env'),
    row('approval', '@deepseek-ai/dsh-user-approval', { policy: config.sandbox.approvalPolicy }),
    row('permission', '@deepseek-ai/dsh-permission-presets', {
      presets: {
        'read-only': { sandbox: 'read-only', approval: config.sandbox.approvalPolicy },
        'workspace-write': { sandbox: 'workspace-write', approval: config.sandbox.approvalPolicy },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    }),
  ]

  if (isWindows) {
    rows.push(row('pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'))
    rows.push(row('tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'))
  } else {
    rows.push(row('bash-sandbox', '@deepseek-ai/dsh-bash-sandbox', { timeoutMs: BASH_TIMEOUT_MS }))
    rows.push(row('tool-bash', '@deepseek-ai/dsh-tool-bash'))
  }

  rows.push(
    row('fs-sandbox', '@deepseek-ai/dsh-fs-sandbox'),
    row('fs-observation-policy', '@deepseek-ai/dsh-fs-observation-policy'),
    row('tool-fs', '@deepseek-ai/dsh-tool-fs'),
    row('tool-fs-search', '@deepseek-ai/dsh-tool-fs-search', { sampleOverCapGlobResults: false }),
    row('tool-str-replace-editor', '@deepseek-ai/dsh-tool-str-replace-editor', { maxOutputChars: 16000 }),
  )

  return rows
}

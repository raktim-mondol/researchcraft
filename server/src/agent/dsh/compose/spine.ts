/**
 * The "spine" row: `@deepseek-ai/dsh-agent-spine-demo` bundles the LLM
 * runtime plumbing, session store, session-title service, system prompt,
 * tool registry, agent registry + loop, skills, workspace-context loader,
 * and background jobs into one schema-validated, config-forwarding plugin.
 *
 * Despite the "-demo" package name this is real composition code (not a
 * toy) — it is DeepSeek's own reference wiring for that dozen-plugin core,
 * and the project's official jsonrpc-agent SDK example is itself built on
 * it. Hand-mounting each of those ~12 lower-level plugins ourselves would
 * duplicate exactly this wiring (including subtle load-order and
 * schema-default behavior) for no benefit, so we reuse it and layer the
 * SDK's own additions (sandboxed bash/fs, extra subagent providers, MCP,
 * spill, compaction refinement, …) around it — see `compose/index.ts`.
 *
 * `toolBash` is forced off here: the spine's own bash tool runs unsandboxed
 * against the host process directly, and this SDK always wants the sandbox
 * chain in `compose/sandbox.ts` (subprocess -> sandbox-policy -> bash-sandbox)
 * providing the model-facing `bash` tool instead, so exactly one bash
 * implementation is ever mounted.
 */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import { row, type PluginRow } from './rows.ts'

const WORKSPACE_CONTEXT_MAX_BYTES = 65536

export function buildSpineRow(config: ResolvedHarnessSdkConfig): PluginRow {
  return row('agent-spine', '@deepseek-ai/dsh-agent-spine-demo', {
    includeHarnessIdentity: config.includeHarnessIdentity,
    includeRuntimeContext: config.includeRuntimeContext,
    persona: config.persona,
    dshHome: config.dshHome,
    workspaceContext: { maxBytes: WORKSPACE_CONTEXT_MAX_BYTES },
    skills: {
      enabled: config.skills.enabled,
      filesystem: {
        customSkillDirs: config.skills.customDirs,
      },
    },
    toolBash: false,
    toolJobs: {},
  })
}

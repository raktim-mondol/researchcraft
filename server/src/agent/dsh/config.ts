/** Defaulting and validation for {@link HarnessSdkConfig}, run before composition. */
import { isAbsolute, join } from 'node:path'
import { HarnessConfigError } from './errors.ts'
import { noopLogger, type Logger } from './logger.ts'
import type { HarnessSdkConfig, LlmRouteConfig, SandboxConfig, SkillsConfig, SubagentsConfig } from './types.ts'

/** {@link HarnessSdkConfig} with every optional field defaulted — what the rest of the SDK consumes. */
export interface ResolvedHarnessSdkConfig {
  workspaceRoot: string
  sessionsRoot: string
  /** Isolated DeepSeek Harness "home" directory (shell-env context + global skill root) — never the real user `~/.dsh`. */
  dshHome: string
  llm: LlmRouteConfig[]
  defaultRoute: { provider: string; model: string; maxTokens: number | undefined }
  persona: string
  includeHarnessIdentity: boolean
  includeRuntimeContext: boolean
  sandbox: Required<SandboxConfig>
  skills: Required<SkillsConfig>
  subagents: Required<SubagentsConfig>
  mcpServers: NonNullable<HarnessSdkConfig['mcpServers']>
  maxTokensAsSuccess: boolean
  logger: Logger
}

const DEFAULT_PERSONA = 'You are a helpful, careful coding and research agent.'

function fail(message: string): never {
  throw new HarnessConfigError(message)
}

/** Validate and default a user-supplied config. Throws {@link HarnessConfigError} synchronously on any problem. */
export function resolveConfig(config: HarnessSdkConfig): ResolvedHarnessSdkConfig {
  if (!config.workspaceRoot || !isAbsolute(config.workspaceRoot)) {
    fail(`workspaceRoot must be an absolute path, got ${JSON.stringify(config.workspaceRoot)}`)
  }
  if (!Array.isArray(config.llm) || config.llm.length === 0) {
    fail('llm must be a non-empty array of provider routes')
  }
  const routeNames = new Set<string>()
  for (const route of config.llm) {
    if (!route.name) fail('every llm route needs a non-empty name')
    if (routeNames.has(route.name)) fail(`duplicate llm route name: ${route.name}`)
    routeNames.add(route.name)
    if (!route.baseURL) fail(`llm route ${JSON.stringify(route.name)} needs a baseURL`)
    if (!Array.isArray(route.models) || route.models.length === 0) {
      fail(`llm route ${JSON.stringify(route.name)} needs at least one model`)
    }
    const modelIds = new Set<string>()
    for (const model of route.models) {
      if (!model.id) fail(`llm route ${JSON.stringify(route.name)} has a model with no id`)
      if (modelIds.has(model.id)) fail(`llm route ${JSON.stringify(route.name)} has duplicate model id ${model.id}`)
      modelIds.add(model.id)
    }
  }
  if (!config.defaultRoute?.provider || !config.defaultRoute.model) {
    fail('defaultRoute.provider and defaultRoute.model are required')
  }
  const route = config.llm.find(candidate => candidate.name === config.defaultRoute.provider)
  if (route === undefined) {
    fail(`defaultRoute.provider ${JSON.stringify(config.defaultRoute.provider)} does not match any llm route name`)
  }
  if (!route.models.some(model => model.id === config.defaultRoute.model)) {
    fail(`defaultRoute.model ${JSON.stringify(config.defaultRoute.model)} is not one of route ${JSON.stringify(route.name)}'s models`)
  }

  const seenMcpNames = new Set<string>()
  for (const server of config.mcpServers ?? []) {
    if (!server.serverName) fail('every mcpServers entry needs a non-empty serverName')
    if (seenMcpNames.has(server.serverName)) fail(`duplicate mcpServers serverName: ${server.serverName}`)
    seenMcpNames.add(server.serverName)
    if (server.transport === 'stdio' && !server.command) {
      fail(`mcp server ${JSON.stringify(server.serverName)} (stdio) needs a command`)
    }
    if (server.transport === 'streamable-http' && !server.url) {
      fail(`mcp server ${JSON.stringify(server.serverName)} (streamable-http) needs a url`)
    }
  }

  return {
    workspaceRoot: config.workspaceRoot,
    sessionsRoot: config.sessionsRoot ?? join(config.workspaceRoot, '.dsh-harness-sdk', 'sessions'),
    dshHome: join(config.workspaceRoot, '.dsh-harness-sdk', 'home'),
    llm: config.llm,
    defaultRoute: {
      provider: config.defaultRoute.provider,
      model: config.defaultRoute.model,
      maxTokens: config.defaultRoute.maxTokens,
    },
    persona: config.persona ?? DEFAULT_PERSONA,
    includeHarnessIdentity: config.includeHarnessIdentity ?? true,
    includeRuntimeContext: config.includeRuntimeContext ?? true,
    sandbox: {
      mode: config.sandbox?.mode ?? 'workspace-write',
      approvalPolicy: config.sandbox?.approvalPolicy ?? 'never',
    },
    skills: {
      enabled: config.skills?.enabled ?? true,
      customDirs: config.skills?.customDirs ?? [],
    },
    subagents: {
      spawn: config.subagents?.spawn ?? true,
      fork: config.subagents?.fork ?? true,
      continuable: config.subagents?.continuable ?? true,
      report: config.subagents?.report ?? true,
      control: config.subagents?.control ?? true,
    },
    mcpServers: config.mcpServers ?? [],
    maxTokensAsSuccess: config.maxTokensAsSuccess ?? true,
    logger: config.logger ?? noopLogger,
  }
}

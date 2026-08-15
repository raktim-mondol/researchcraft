/**
 * Public configuration types for composing a DeepSeek Harness runtime.
 * These are pure data — building the actual Cordis plugin tree from them
 * happens in `src/compose/`.
 */
import type { Logger } from './logger.ts'

/** Per-model reasoning-effort selector -> wire spelling; `undefined` sends the wire field empty. */
export type ReasoningEffortMap = Record<string, string | undefined>

/** One model entry on an LLM route (see `dsh-llm-pi-ai`'s `models`/`modelOverrides`). */
export interface LlmModelConfig {
  /** The model id sent on the wire and used to select this entry. */
  id: string
  /** Display name; defaults to `id`. */
  name?: string
  /** Total input+output token capacity. */
  contextWindow?: number
  /** Maximum output tokens; becomes the request default when unset per-call. */
  maxTokens?: number
  /** Selectable thinking levels and their wire spelling; omit for a non-reasoning model. */
  reasoningEfforts?: ReasoningEffortMap
}

/** Retry policy for one LLM route, executed by `dsh-llm-retry` at the agent step level. */
export interface LlmRetryPolicyConfig {
  mode?: 'normal' | 'aggressive'
  maxRetries?: number
  backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
}

/**
 * One OpenAI-compatible provider route, resolved through `dsh-llm-pi-ai`
 * (which wraps `@earendil-works/pi-ai` — the same library ResearchCraft's
 * own backend already uses for custom-endpoint model construction). Use this
 * for OpenRouter, Ollama's OpenAI-compatible endpoint, or any other
 * OpenAI-completions-shaped gateway.
 */
export interface LlmRouteConfig {
  /** Route name; referenced by `defaultRoute.provider` and per-run `provider` overrides. */
  name: string
  /** Human-readable label shown by configuration surfaces. */
  displayName?: string
  /** Env var holding the bearer credential; omit for a keyless local endpoint (still needs SOME `Authorization`, see `headers`). */
  apiKeyEnv?: string
  /** The endpoint base URL (include `/v1` if the provider expects it). */
  baseURL: string
  /** Wire protocol; `openai-completions` covers OpenRouter, Ollama's OpenAI-compat surface, and most gateways. */
  api?: 'openai-completions' | 'openai-responses'
  /** Extra headers merged into every request on this route (e.g. a placeholder `Authorization` for a keyless local server). */
  headers?: Record<string, string>
  /** This route's models. Required for a hand-declared (non-catalog) route. */
  models: LlmModelConfig[]
  /** Fallback context window for a model that declares none (default 262144). */
  defaultContextWindow?: number
  /** Fallback max output tokens for a model that declares none (default 32768). */
  defaultMaxTokens?: number
  /** Idle-stream watchdog in ms (default 5 minutes). */
  streamIdleTimeoutMs?: number
  retryPolicy?: LlmRetryPolicyConfig
}

/** Which provider/model a session uses by default; overridable per `run()`/`session()` call. */
export interface DefaultRouteConfig {
  /** Must match one `LlmRouteConfig.name`. */
  provider: string
  /** Must match one of that route's `models[].id`. */
  model: string
  maxTokens?: number
}

/** File-effect sandbox mode shared by the bash and filesystem tools (`dsh-sandbox-policy`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface SandboxConfig {
  /** Default file-effect policy for bash and filesystem tools (default `workspace-write`). */
  mode?: SandboxMode
  /**
   * Tool-call approval policy (`dsh-user-approval`). `'ask'` requires an
   * approval answerer this SDK does not yet bridge over JSON-RPC (see
   * README "Known limitations"), so a headless run with `'ask'` would hang
   * on the first gated call; default is `'never'` (auto-approve), matching
   * how DeepSeek's own official SDK/headless compositions run with no
   * interactive approval surface.
   */
  approvalPolicy?: 'ask' | 'never'
}

export interface SkillsConfig {
  /** Mount the local skill provider + model-facing `skill` tool (default true). */
  enabled?: boolean
  /** Additional local skill directories, scanned after project roots. */
  customDirs?: string[]
}

export interface SubagentsConfig {
  /** Fresh in-process child with no inherited history (default true). */
  spawn?: boolean
  /** In-process child seeded with the parent's completed-turn history (default true). */
  fork?: boolean
  /** Let a spawn-provider delegation stay resident and accept follow-ups (`send_message`) instead of being one-shot (default true). */
  continuable?: boolean
  /** Mount the child-scoped `report` tool so a continuable child can message its parent mid-run (default true). */
  report?: boolean
  /** Mount the global `send_message`/`interrupt_agent`/`list_agents` control tools (default true). */
  control?: boolean
}

/** One external MCP server connection (`dsh-mcp-client`). */
export type McpServerConfig =
  | {
    serverName: string
    transport: 'stdio'
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    toolCallTimeoutMs?: number
    failOnStartupError?: boolean
    reconnect?: McpReconnectConfig
  }
  | {
    serverName: string
    transport: 'streamable-http'
    url: string
    headers?: Record<string, string>
    toolCallTimeoutMs?: number
    failOnStartupError?: boolean
    reconnect?: McpReconnectConfig
  }

export interface McpReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

/**
 * Complete, user-facing configuration for one {@link HarnessRuntime}. See
 * `src/config.ts` for the defaulting/validation this goes through before
 * composition (`resolveConfig`) and `src/compose/index.ts` for how it
 * becomes a Cordis plugin tree.
 */
export interface HarnessSdkConfig {
  /** Absolute directory the agent's shell/filesystem tools operate in. */
  workspaceRoot: string
  /** Absolute directory for session JSONL + checkpoints; default `<workspaceRoot>/.dsh-harness-sdk/sessions`. */
  sessionsRoot?: string
  /** One or more OpenAI-compatible provider routes. At least one is required. */
  llm: LlmRouteConfig[]
  /** Which route/model a session uses when not overridden per call. */
  defaultRoute: DefaultRouteConfig
  /** Deployment persona / system-prompt prose (default: a generic coding-agent persona). */
  persona?: string
  /** Include the fixed DeepSeek Harness identity section in the system prompt (default true). */
  includeHarnessIdentity?: boolean
  /** Include dynamic runtime-context snapshots (cwd, file-change notices, …) in model history (default true). */
  includeRuntimeContext?: boolean
  sandbox?: SandboxConfig
  skills?: SkillsConfig
  subagents?: SubagentsConfig
  mcpServers?: McpServerConfig[]
  /**
   * Whether a turn that stops for hitting the model's max-tokens ceiling
   * still counts as a successful `RunResult` (`dsh-sdk-jsonrpc-server`'s
   * `maxTokensAsSuccess`). Default true; set false to have `HarnessRuntime`
   * reject those turns as {@link HarnessTurnError}.
   */
  maxTokensAsSuccess?: boolean
  /** Structured logger; default is silent (`noopLogger`). */
  logger?: Logger
}

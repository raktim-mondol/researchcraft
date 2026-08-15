/**
 * The SDK's main entry point: validates + composes a config into a Cordis
 * plugin tree, provisions an ephemeral run directory, spawns the built
 * `dsh-jsonrpc-agent` runtime as a subprocess (retrying the initial
 * spawn+handshake with backoff), and exposes a typed, logged wrapper over
 * `@deepseek-ai/dsh-sdk-client`'s `DeepSeekHarness`.
 */
import {
  DeepSeekHarness,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
  type ContentBlock,
  type HarnessNotification,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client'
import { resolveConfig, type ResolvedHarnessSdkConfig } from '../config.ts'
import { composeCordisTree, serializeCordisTree, type PluginRow } from '../compose/index.ts'
import {
  HarnessProvisioningError,
  HarnessSdkError,
  HarnessSpawnError,
  HarnessTimeoutError,
  HarnessTransportError,
  HarnessTurnError,
} from '../errors.ts'
import { noopLogger, type Logger } from '../logger.ts'
import type { HarnessSdkConfig } from '../types.ts'
import { locateRuntimeBin } from './locateRuntimeBin.ts'
import { provisionRuntimeWorkspace, type RuntimeWorkspace } from './resolvePlugins.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_SPAWN_MAX_ATTEMPTS = 3
const DEFAULT_SPAWN_INITIAL_DELAY_MS = 500
const DEFAULT_SPAWN_MAX_DELAY_MS = 5_000
const DEFAULT_MCP_READY_DELAY_PER_SERVER_MS = 400

export interface SpawnRetryOptions {
  /** Total spawn+handshake attempts before giving up (default 3). */
  maxAttempts?: number
  /** Delay before the second attempt; doubles each subsequent attempt (default 500ms). */
  initialDelayMs?: number
  /** Backoff ceiling (default 5000ms). */
  maxDelayMs?: number
}

export interface HarnessRuntimeOptions {
  config: HarnessSdkConfig
  /** Extra environment variables merged over the inherited process environment for the runtime subprocess. */
  env?: NodeJS.ProcessEnv
  /**
   * Timeout in ms for individual JSON-RPC round-trips (`initialize`,
   * `session/prompt`'s enqueue acknowledgement, `shutdown`) — default 120000.
   * This does NOT bound how long a whole turn takes: prompting only waits
   * for the durable enqueue ack, then the SDK client watches the
   * notification stream until `session.status: idle` with no timeout of its
   * own (a turn can legitimately run long). To bound total turn duration,
   * pass an `AbortSignal` to `run()` — see the class doc's Cancellation note.
   */
  requestTimeoutMs?: number
  spawnRetry?: SpawnRetryOptions
  /**
   * Additional plugin rows appended after {@link composeCordisTree}'s output
   * — e.g. a host application's own local-file tool plugins (see
   * `resolvePlugins.ts`'s `isLocalFileRow`) that this generic SDK has no
   * typed config surface for. Composed in the given order, after every row
   * `composeCordisTree` derives from `config`.
   */
  extraRows?: PluginRow[]
  /**
   * Extra wait after a successful handshake before `start()` returns, only
   * when `mcpServers` is non-empty (default 400ms per configured server).
   * `dsh-sdk-jsonrpc-server` answers the `initialize` handshake as soon as
   * its own row activates; `dsh-mcp-client`'s tool registration is a
   * separate async connection (spawn/dial + `listTools()`) that can still be
   * in flight at that moment — the very first `run()` can otherwise race it
   * and see a tool-free registry. There is no wire-level "MCP ready" signal
   * to await instead, so this is a bounded, documented mitigation, not a
   * guarantee: a slow-connecting server can still lose the race. Set to `0`
   * to disable, or raise it for a server known to take longer to connect.
   */
  mcpReadyDelayMs?: number
}

export interface HarnessUsage {
  inputTokens: number
  outputTokens: number
}

export interface HarnessRunOptions {
  /** Reuse an existing session id (continues that conversation); omitted mints a fresh session. */
  sessionId?: string
  /** Observe every raw notification for this session tree as it streams in. */
  onNotification?: (notification: HarnessNotification) => void
  /** Aborting cancels the run. Because the wire protocol has no per-request cancel, this closes the whole runtime — see `HarnessRuntime`'s class doc. */
  signal?: AbortSignal
}

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
  /** The terminal `turn/end` reason kind (`completed`, `max-tokens`, `aborted`, `error`, …), or `undefined` if no turn ended. */
  stopReason: string | undefined
  usage: HarnessUsage
  /** The complete underlying SDK result (raw session events + notifications), for callers that need more than the summary above. */
  raw: RunResult
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sum `assistant/message` usage across a result's events. */
function extractUsage(result: RunResult): HarnessUsage {
  let inputTokens = 0
  let outputTokens = 0
  for (const event of result.events) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (usage === undefined) continue
    inputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
  }
  return { inputTokens, outputTokens }
}

/** The `kind` of the last `turn/end` event, if any. */
function extractStopReason(result: RunResult): string | undefined {
  for (let index = result.events.length - 1; index >= 0; index--) {
    const event = result.events[index]
    if (event?.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: string } }).reason
    return reason?.kind
  }
  return undefined
}

/**
 * One embedded DeepSeek Harness runtime. Owns exactly one subprocess across
 * however many sessions are run on it; call {@link close} (or `await using`)
 * to reap it.
 *
 * **Cancellation.** The underlying JSON-RPC protocol has no per-request
 * cancel: a timed-out or aborted call leaves the runtime's turn running
 * server-side until the runtime itself is closed
 * (`@deepseek-ai/dsh-sdk-client`'s own documented limitation). Passing
 * `signal` to {@link run} therefore cancels by closing this whole runtime —
 * fine for "abandon this run entirely," not a way to cancel one call while
 * keeping other sessions on the same runtime alive. Run unrelated
 * conversations that need independent cancellation on separate
 * `HarnessRuntime` instances.
 */
export class HarnessRuntime implements AsyncDisposable {
  private readonly resolvedConfig: ResolvedHarnessSdkConfig
  private readonly rows: PluginRow[]
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly requestTimeoutMs: number
  private readonly spawnRetry: Required<SpawnRetryOptions>
  private readonly mcpReadyDelayMs: number
  private readonly logger: Logger
  private harness: DeepSeekHarness | undefined
  private workspace: RuntimeWorkspace | undefined
  private startTask: Promise<void> | undefined
  private closed = false

  constructor(options: HarnessRuntimeOptions) {
    this.resolvedConfig = resolveConfig(options.config)
    this.rows = [...composeCordisTree(this.resolvedConfig), ...(options.extraRows ?? [])]
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.spawnRetry = {
      maxAttempts: options.spawnRetry?.maxAttempts ?? DEFAULT_SPAWN_MAX_ATTEMPTS,
      initialDelayMs: options.spawnRetry?.initialDelayMs ?? DEFAULT_SPAWN_INITIAL_DELAY_MS,
      maxDelayMs: options.spawnRetry?.maxDelayMs ?? DEFAULT_SPAWN_MAX_DELAY_MS,
    }
    this.mcpReadyDelayMs = options.mcpReadyDelayMs
      ?? this.resolvedConfig.mcpServers.length * DEFAULT_MCP_READY_DELAY_PER_SERVER_MS
    this.logger = this.resolvedConfig.logger ?? noopLogger
  }

  /** The composed plugin-row tree (read-only; useful for diagnostics or dumping the generated config). */
  get composedRows(): readonly PluginRow[] {
    return this.rows
  }

  /**
   * Provision the run directory and spawn+handshake the runtime, retrying
   * with backoff. Idempotent while starting/started; safe to call before
   * every {@link run} — memoized after the first success.
   */
  async start(): Promise<void> {
    if (this.closed) throw new HarnessProvisioningError('HarnessRuntime is closed')
    this.startTask ??= this.doStart()
    return this.startTask
  }

  private async doStart(): Promise<void> {
    const configText = serializeCordisTree(this.rows)
    this.workspace = await provisionRuntimeWorkspace(this.rows, configText, this.logger)
    const runtimeBin = await locateRuntimeBin()
    this.logger.info('provisioned runtime workspace', { dir: this.workspace.dir, rows: this.rows.length })

    let lastError: unknown
    for (let attempt = 1; attempt <= this.spawnRetry.maxAttempts; attempt++) {
      const harness = new DeepSeekHarness({
        launch: {
          command: process.execPath,
          args: [runtimeBin, this.workspace.configPath],
          cwd: this.workspace.dir,
          env: { ...process.env, ...this.env },
          requestTimeoutMs: this.requestTimeoutMs,
        },
        cwd: this.resolvedConfig.workspaceRoot,
        provider: this.resolvedConfig.defaultRoute.provider,
        model: this.resolvedConfig.defaultRoute.model,
        ...this.resolvedConfig.defaultRoute.maxTokens !== undefined
          ? { maxTokens: this.resolvedConfig.defaultRoute.maxTokens }
          : {},
      })
      try {
        await harness.start()
        this.harness = harness
        this.logger.info('runtime handshake complete', { attempt })
        if (this.mcpReadyDelayMs > 0) {
          this.logger.debug('waiting for MCP server connections to settle', { mcpReadyDelayMs: this.mcpReadyDelayMs })
          await sleep(this.mcpReadyDelayMs)
        }
        return
      } catch (error) {
        lastError = error
        await harness.close()
        this.logger.warn('runtime spawn/handshake attempt failed', {
          attempt,
          maxAttempts: this.spawnRetry.maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        })
        if (attempt < this.spawnRetry.maxAttempts) {
          const delay = Math.min(this.spawnRetry.initialDelayMs * 2 ** (attempt - 1), this.spawnRetry.maxDelayMs)
          await sleep(delay)
        }
      }
    }
    this.startTask = undefined
    throw new HarnessSpawnError(
      `Failed to start the DeepSeek Harness runtime after ${this.spawnRetry.maxAttempts} attempts`,
      this.spawnRetry.maxAttempts,
      { cause: lastError },
    )
  }

  /** Run one prompt on a fresh (or named) session and wait for it to go idle. */
  async run(input: string | ContentBlock[], options?: HarnessRunOptions): Promise<HarnessRunResult> {
    await this.start()
    const harness = this.harness
    if (harness === undefined) throw new HarnessProvisioningError('HarnessRuntime.start() did not produce a client')

    let abortListener: (() => void) | undefined
    if (options?.signal !== undefined) {
      if (options.signal.aborted) await this.close()
      else {
        abortListener = () => { void this.close() }
        options.signal.addEventListener('abort', abortListener, { once: true })
      }
    }

    try {
      const raw = await harness.run(input, {
        ...options?.sessionId !== undefined ? { sessionId: options.sessionId } : {},
        ...options?.onNotification !== undefined ? { onNotification: options.onNotification } : {},
      })
      return this.toRunResult(raw)
    } catch (error) {
      throw translateClientError(error)
    } finally {
      if (abortListener !== undefined) options?.signal?.removeEventListener('abort', abortListener)
    }
  }

  private toRunResult(raw: RunResult): HarnessRunResult {
    const stopReason = extractStopReason(raw)
    const isMaxTokens = stopReason === 'max-tokens'
    if (stopReason !== undefined && stopReason !== 'completed' && !(isMaxTokens && this.resolvedConfig.maxTokensAsSuccess)) {
      throw new HarnessTurnError(`turn ended with reason "${stopReason}" instead of "completed"`, stopReason)
    }
    return {
      sessionId: raw.sessionId,
      finalResponse: raw.finalResponse,
      stopReason,
      usage: extractUsage(raw),
      raw,
    }
  }

  /** Shut the runtime subprocess down and remove its ephemeral run directory. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.harness?.close()
    } finally {
      await this.workspace?.dispose()
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

function translateClientError(error: unknown): Error {
  // Already one of ours (e.g. toRunResult's HarnessTurnError) — pass through
  // unchanged rather than re-wrapping and losing fields like `stopReason`.
  if (error instanceof HarnessSdkError) return error
  if (error instanceof RequestTimeoutError) return new HarnessTimeoutError(error.message, { cause: error })
  if (error instanceof TransportClosedError) return new HarnessTransportError(error.message, { cause: error })
  if (error instanceof SdkProtocolError) return new HarnessTurnError(error.message, undefined, { cause: error })
  if (isRecord(error) && typeof error.message === 'string') return new HarnessTurnError(error.message, undefined, { cause: error })
  return error instanceof Error ? error : new Error(String(error))
}

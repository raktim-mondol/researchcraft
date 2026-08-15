/**
 * Typed error hierarchy for the SDK. Every error the public API can reject
 * with is one of these (or a subclass), so callers can `instanceof`-branch
 * instead of parsing message strings.
 */

/** Base class for every error this SDK throws. */
export class HarnessSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * The supplied {@link HarnessSdkConfig} is invalid — thrown synchronously by
 * `resolveConfig`/`composeCordisTree` before any subprocess is spawned, so a
 * bad config never costs a process launch.
 */
export class HarnessConfigError extends HarnessSdkError {}

/**
 * The runtime subprocess could not be prepared: the built `dsh` packages are
 * missing/unresolvable, the ephemeral run directory could not be assembled,
 * or the generated `cordis.yml` could not be written.
 */
export class HarnessProvisioningError extends HarnessSdkError {}

/**
 * The runtime subprocess failed to start or complete its `initialize`
 * handshake after exhausting the configured retry budget. `attempts` is how
 * many spawn attempts were made; `cause` is the last underlying error
 * (typically a `TransportClosedError` from `@deepseek-ai/dsh-sdk-client`).
 */
export class HarnessSpawnError extends HarnessSdkError {
  readonly attempts: number

  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options)
    this.attempts = attempts
  }
}

/**
 * A request to the runtime exceeded its timeout. Wraps the SDK client's
 * `RequestTimeoutError`. Per the underlying protocol there is no wire-level
 * cancel — the server-side turn keeps running until the runtime is closed —
 * so recovering from this means `HarnessRuntime.close()`, not retrying the
 * same session.
 */
export class HarnessTimeoutError extends HarnessSdkError {}

/**
 * The runtime answered outside its documented protocol, or a turn ended in a
 * non-`completed` way the caller must treat as a failure (`error`,
 * `max-tokens` when not configured as success, `aborted`, `refusal`).
 */
export class HarnessTurnError extends HarnessSdkError {
  readonly stopReason: string | undefined

  constructor(message: string, stopReason: string | undefined, options?: { cause?: unknown }) {
    super(message, options)
    this.stopReason = stopReason
  }
}

/** The runtime subprocess died or its transport closed while a call was outstanding. */
export class HarnessTransportError extends HarnessSdkError {}

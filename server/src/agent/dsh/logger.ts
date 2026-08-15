/** Minimal structured-logging seam so the SDK never hardcodes `console.*`. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Drops every message; the default for library code that stays silent unless the caller opts in. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Writes structured lines to `console.*`, tagged `[dsh-harness-sdk]`. Convenient for local dev/CLI use. */
export const consoleLogger: Logger = {
  debug: (message, fields) => { console.debug('[dsh-harness-sdk]', message, fields ?? '') },
  info: (message, fields) => { console.info('[dsh-harness-sdk]', message, fields ?? '') },
  warn: (message, fields) => { console.warn('[dsh-harness-sdk]', message, fields ?? '') },
  error: (message, fields) => { console.error('[dsh-harness-sdk]', message, fields ?? '') },
}

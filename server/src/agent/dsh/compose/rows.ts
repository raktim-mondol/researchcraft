/** One row of a Cordis `cordis.yml` include tree: a plugin mount by package name plus its config. */
export interface PluginRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

/** Build a row, omitting `config` entirely when it has no keys (matches how the real dsh bundles write rows with no config). */
export function row(id: string, name: string, config?: Record<string, unknown>): PluginRow {
  return config !== undefined && Object.keys(config).length > 0 ? { id, name, config } : { id, name }
}

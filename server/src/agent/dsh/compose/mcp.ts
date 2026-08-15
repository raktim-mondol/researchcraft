/** One `dsh-mcp-client` row per configured external MCP server. */
import type { ResolvedHarnessSdkConfig } from '../config.ts'
import type { McpServerConfig } from '../types.ts'
import { row, type PluginRow } from './rows.ts'

function buildMcpConfig(server: McpServerConfig): Record<string, unknown> {
  const shared = {
    serverName: server.serverName,
    transport: server.transport,
    ...server.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: server.toolCallTimeoutMs } : {},
    ...server.failOnStartupError !== undefined ? { failOnStartupError: server.failOnStartupError } : {},
    ...server.reconnect !== undefined ? { reconnect: server.reconnect } : {},
  }
  if (server.transport === 'stdio') {
    return {
      ...shared,
      command: server.command,
      ...server.args !== undefined ? { args: server.args } : {},
      ...server.env !== undefined ? { env: server.env } : {},
      ...server.cwd !== undefined ? { cwd: server.cwd } : {},
    }
  }
  return {
    ...shared,
    url: server.url,
    ...server.headers !== undefined ? { headers: server.headers } : {},
  }
}

export function buildMcpRows(config: ResolvedHarnessSdkConfig): PluginRow[] {
  return config.mcpServers.map(server => row(`mcp-${server.serverName}`, '@deepseek-ai/dsh-mcp-client', buildMcpConfig(server)))
}

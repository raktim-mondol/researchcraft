/** Resolve the built `dsh-jsonrpc-agent` runtime bin this SDK spawns as a subprocess. */
import { fileURLToPath } from 'node:url'
import { HarnessProvisioningError } from '../errors.ts'

export async function locateRuntimeBin(): Promise<string> {
  try {
    const resolved = await import.meta.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
    return fileURLToPath(resolved)
  } catch (error) {
    throw new HarnessProvisioningError(
      'Could not resolve @deepseek-ai/dsh-sdk-jsonrpc-demo/bin — is it installed as a dependency of @researchcraft/dsh-harness-sdk?',
      { cause: error },
    )
  }
}

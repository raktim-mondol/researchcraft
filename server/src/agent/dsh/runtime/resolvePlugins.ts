/**
 * Resolve every `@deepseek-ai/dsh-*` plugin package a composed row tree
 * references to its real on-disk install location (wherever this SDK's own
 * `node_modules` put it — `file:`-linked to a local build today, a normal
 * registry install once DeepSeek publishes these packages), then materialize
 * a `node_modules/@scope/<pkg>` entry for each inside an ephemeral run
 * directory beside the generated `cordis.yml`.
 *
 * This mirrors the mechanism the real `dsh` CLI itself uses for its
 * `$DSH_HOME/profiles/<name>/node_modules` bare-plugin resolution
 * (`healProfilesModuleFallback` in `@deepseek-ai/dsh-app-boot`) rather than
 * inventing a bespoke loader hook: the Cordis Loader resolves bare plugin
 * specifiers "from the config directory" by walking Node's ordinary
 * `node_modules` chain, so giving the run directory its own such chain is
 * the documented, supported way to point it at packages that live outside
 * that directory's own ancestry.
 */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessProvisioningError } from '../errors.ts'
import type { Logger } from '../logger.ts'
import type { PluginRow } from '../compose/rows.ts'

/**
 * True when a row's `name` is a local file reference (absolute path, `./`/`../`
 * relative path, `file://` URL, or a Windows drive path) rather than a bare
 * npm-style module specifier. The Cordis Loader's `EntryTree.import()`
 * resolves these directly (relative to `ctx.baseUrl` for `.`-prefixed names,
 * or straight through dynamic `import()` for absolute/`file://` ones) instead
 * of walking `node_modules` — see `@deepseek-ai/cordis-plugin-loader`'s
 * `config/tree.ts`. Such rows carry no package to link into the ephemeral
 * run directory's `node_modules`.
 */
function isLocalFileRow(rowName: string): boolean {
  return rowName.startsWith('.') || rowName.startsWith('/') || rowName.startsWith('file://')
    || /^[A-Za-z]:[\\/]/.test(rowName)
}

/** The package name portion of a row's `name` field, stripping any subpath export (e.g. `/list-agents`). */
function packageNameOf(rowName: string): string {
  // Scoped package: `@scope/name[/subpath]`. Unscoped: `name[/subpath]`.
  const parts = rowName.split('/')
  return rowName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Every distinct plugin package name referenced by a composed row tree (local file rows excluded — see {@link isLocalFileRow}). */
export function pluginPackageNames(rows: readonly PluginRow[]): string[] {
  return [...new Set(rows.filter(r => !isLocalFileRow(r.name)).map(r => packageNameOf(r.name)))]
}

/** Resolve one bare package name to its installed root directory via its own `package.json` export. */
async function resolvePackageRoot(packageName: string): Promise<string> {
  let resolved: string
  try {
    resolved = await import.meta.resolve(`${packageName}/package.json`)
  } catch (error) {
    throw new HarnessProvisioningError(
      `Could not resolve ${packageName} from @researchcraft/dsh-harness-sdk's own dependencies. `
      + 'Add it as a dependency (see package.json) before composing a row that references it.',
      { cause: error },
    )
  }
  return dirname(fileURLToPath(resolved))
}

/** One ephemeral, self-contained directory a runtime subprocess can boot from: `cordis.yml` plus a resolvable `node_modules`. */
export interface RuntimeWorkspace {
  readonly dir: string
  readonly configPath: string
  dispose(): Promise<void>
}

/**
 * Create the ephemeral run directory, link every referenced plugin package
 * into its `node_modules`, and write the generated config there.
 */
export async function provisionRuntimeWorkspace(
  rows: readonly PluginRow[],
  configText: string,
  logger: Logger,
): Promise<RuntimeWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-harness-sdk-run-'))
  const scopeDir = join(dir, 'node_modules', '@deepseek-ai')
  await mkdir(scopeDir, { recursive: true })

  for (const packageName of pluginPackageNames(rows)) {
    const root = await resolvePackageRoot(packageName)
    const shortName = packageName.split('/')[1]!
    const linkPath = join(scopeDir, shortName)
    await linkOrCopy(root, linkPath, logger)
  }

  const configPath = join(dir, 'cordis.yml')
  await writeFile(configPath, configText, 'utf8')

  return {
    dir,
    configPath,
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Symlink (junction on Windows) `target` at `linkPath`; fall back to a recursive copy if symlinking is not permitted. */
async function linkOrCopy(target: string, linkPath: string, logger: Logger): Promise<void> {
  if (existsSync(linkPath)) return
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    logger.warn('symlink failed, falling back to a recursive copy (slower; check filesystem permissions)', {
      target,
      linkPath,
      error: error instanceof Error ? error.message : String(error),
    })
    await cp(target, linkPath, { recursive: true, dereference: true })
  }
}

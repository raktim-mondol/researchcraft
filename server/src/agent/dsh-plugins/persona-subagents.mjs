/**
 * Registers one model-facing delegation tool per named specialist persona
 * (`server/src/agent/subagents.ts`'s `SUBAGENT_TYPES`), each calling
 * `ctx.subagents.start()` directly with that persona's system prompt as the
 * child's `persona` override.
 *
 * This is a raw Cordis plugin (not an npm package) loaded by absolute file
 * path from a composed row (see `../dsh/compose/personas.ts`) — Cordis's
 * loader resolves such paths straight through dynamic `import()`, no
 * `node_modules` entry required (see `resolvePlugins.ts`'s `isLocalFileRow`).
 * Written as plain ESM JS, not TypeScript: the `dsh-jsonrpc-agent` runtime
 * subprocess this file runs inside is spawned via plain `node`, with no
 * TypeScript loader.
 *
 * `dsh-tool-subagent` (the stock delegation tool) was not reusable here: its
 * per-instance `persona` config field is exactly the mechanism this plugin
 * uses, but its tool `description` is fixed generic delegation wording — it
 * has no way to surface a per-specialist summary, which is the whole point
 * of a named-persona roster (the caller model picks by what a tool says it
 * checks). This plugin is a trimmed, foreground-only rewrite of
 * `dsh-tool-subagent`'s `execute()` (see the vendored package's `src/index.ts`
 * for the reference this follows) with one tool registered per persona
 * instead of one generic `subagent` tool.
 *
 * @module researchcraft/persona-subagents
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'researchcraft-persona-subagents'
export const inject = ['tools', 'subagents']

/** @typedef {{ name: string, summary: string, systemPrompt: string }} PersonaConfig */
/**
 * @typedef {{
 *   provider?: string,
 *   maxDepth?: number,
 *   personas: PersonaConfig[],
 * }} Config
 */

/** `code-reviewer` -> `subagent_code_reviewer` (OpenAI-style tool names reject bare hyphens in some clients). */
function toolNameFor(personaName) {
  return `subagent_${personaName.replace(/-/g, '_')}`
}

/** Flatten a child's returned content blocks to plain text for the parent model. */
function outputText(blocks) {
  return blocks
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** Why a subagent run did not end cleanly, or `undefined` when it did. */
function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  const provider = config.provider ?? 'spawn'
  const maxDepth = config.maxDepth ?? 3
  const disposers = []

  const mountAll = () => {
    for (const persona of config.personas) {
      const toolName = toolNameFor(persona.name)
      const dispose = ctx.tools.register(defineTool({
        name: toolName,
        description:
          `Delegate a self-contained task to the "${persona.name}" specialist subagent `
          + `(a separate agent working in its own context, not sharing this conversation). `
          + `${persona.summary} `
          + 'Give it a complete, standalone prompt with everything it needs (file paths, data, '
          + 'constraints) — it does not see this conversation. Returns its final report, not its '
          + 'intermediate steps.',
        parameters: {
          prompt: {
            type: 'string',
            required: true,
            description:
              'The complete, self-contained task for this specialist. It does not see this '
              + 'conversation, so include all necessary context.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              report: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.report }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
          }
          const run = await ctx.subagents.start(provider, {
            label: persona.name,
            prompt: [{ type: 'text', text: args.prompt }],
            parent,
            persona: persona.systemPrompt,
            maxDepth,
            signal: exec.signal,
          })
          const [settled] = await Promise.allSettled([
            run.result.then((result) => {
              const error = stopReasonError(result)
              const text = outputText(result.output)
              if (error !== undefined) {
                throw new Error(text.length > 0 ? `${error}\nPartial output:\n${text}` : error)
              }
              return { report: text.length > 0 ? text : '(subagent returned no text output)' }
            }),
          ])
          const [disposed] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
          if (settled.status === 'rejected') {
            if (disposed.status === 'rejected') {
              throw new AggregateError(
                [settled.reason, disposed.reason],
                `${toolName} failed: ${String(settled.reason)}; dispose failed: ${String(disposed.reason)}`,
              )
            }
            throw settled.reason
          }
          if (disposed.status === 'rejected') throw disposed.reason
          return settled.value
        },
        presentCall: (args) => ({ card: 'generic', kind: 'other', title: `Delegate to ${persona.name}`, rawInput: args.prompt }),
      }))
      disposers.push(dispose)
    }
  }

  mountAll()
  ctx.on('dispose', () => {
    while (disposers.length > 0) disposers.pop()?.()
  })
}

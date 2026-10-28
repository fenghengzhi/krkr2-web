import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = process.env.KRKR_MENU_LIFETIME_JOURNAL
export const menuLifetimeJournalEnabled = !!directory
let sequence = 0, written = 0, failed = false

/** Bounded error metadata; the original test exception is always rethrown. */
export function menuLifetimeError(error: unknown, depth = 0, budget = { remaining: 64 }): unknown {
  try {
    if (--budget.remaining < 0) return { truncated: 'error node budget' }
    if (depth === 4) return { truncated: 'cause depth', text: String(error).slice(0, 4096) }
    if (!(error instanceof Error)) return { type: typeof error, text: String(error).slice(0, 16384) }
    return {
      name: error.name, message: error.message.slice(0, 16384), stack: error.stack?.slice(0, 65536),
      ...(error.cause === undefined ? {} : { cause: menuLifetimeError(error.cause, depth + 1, budget) }),
      ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 16).map((entry: unknown) => menuLifetimeError(entry, depth + 1, budget)) } : {}),
    }
  } catch { return { type: typeof error, serializationIncomplete: true } }
}

/** Opt-in evidence only: ordinary menu tests install no handlers or file writes. */
export function menuLifetimeJournal(event: string, data: Record<string, unknown> = {}): void {
  if (!directory || failed) return
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
      throw new Error('Menu lifetime journals require a GitHub-hosted runner')
    if (++sequence > 10000) throw new Error('Menu lifetime journal event budget exceeded')
    mkdirSync(directory, { recursive: true })
    const line = JSON.stringify({
      sequence, at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, event, ...data,
    }) + '\n'
    written += Buffer.byteLength(line)
    if (written > 16 * 1024 * 1024) throw new Error('Menu lifetime journal byte budget exceeded')
    appendFileSync(resolve(directory, `${process.pid}.jsonl`), line)
  } catch (error) {
    failed = true
    console.error('MENU_LIFETIME_JOURNAL_INCOMPLETE', String(error))
  }
}

if (menuLifetimeJournalEnabled) {
  menuLifetimeJournal('process:start', {
    node: process.version, execPath: process.execPath, execArgv: process.execArgv,
    argv: process.argv, nodeOptions: process.env.NODE_OPTIONS ?? '',
  })
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    menuLifetimeJournal('process:uncaught-exception', { origin, error: menuLifetimeError(error) })
  })
  process.on('exit', (code) => menuLifetimeJournal('process:exit', { code }))
}

import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const directory = process.env.KRKR_LAYER_LIFETIME_JOURNAL
export const lifetimeJournalEnabled = !!directory
let sequence = 0, failed = false
/** Opt-in hosted crash evidence; no hooks or journal writes in ordinary tests. */
export function lifetimeJournal(event: string, data: Record<string, unknown> = {}): void {
  if (!directory || failed) return
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
      throw new Error('Lifetime crash journals require a GitHub-hosted runner')
    if (++sequence > 10000) throw new Error('Lifetime journal event budget exceeded')
    mkdirSync(directory, { recursive: true })
    appendFileSync(resolve(directory, `${process.pid}.jsonl`), JSON.stringify({
      sequence, at: new Date().toISOString(), pid: process.pid, event, ...data,
    }) + '\n')
  } catch (error) {
    failed = true
    // Preserve the original test error; the diagnostic inventory separately
    // rejects this marker as incomplete evidence.
    console.error('LIFETIME_JOURNAL_INCOMPLETE', String(error))
  }
}
export async function lifetimeOperation<T>(name: string, run: () => Promise<T>, data: Record<string, unknown> = {}): Promise<T> {
  lifetimeJournal('operation:start', { name, ...data })
  try {
    const result = await run()
    lifetimeJournal('operation:return', { name })
    return result
  } catch (error) {
    lifetimeJournal('operation:throw', { name, error: String(error) })
    throw error
  }
}

lifetimeJournal('process:start', { node: process.version, execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS ?? '' })

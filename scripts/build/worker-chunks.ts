import { posix } from 'node:path'
import type { Plugin } from 'vite'

interface BundleFile {
  readonly type: string
  readonly fileName: string
  readonly isEntry?: boolean
  readonly imports?: readonly string[]
  readonly dynamicImports?: readonly string[]
}

/** Worker entries install RPC listeners and own mutable Session state. Shared
 * code must live in ordinary modules, never in an entry that a lazy codec can
 * import again. Inspect bundler metadata rather than guessing from JS text. */
export function assertWorkerEntryIsolation(files: readonly BundleFile[]): {
  entries: number; chunks: number
} {
  const chunks = files.filter((file) => file.type === 'chunk'),
    entries = new Set(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName))
  if (!entries.size) throw new Error('Worker output has no entry to validate')
  for (const chunk of chunks) for (const target of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
    const fileName = target.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(chunk.fileName), target)) : target
    if (entries.has(fileName))
      throw new Error(`Worker chunk ${chunk.fileName} imports executable entry ${fileName}`)
  }
  return { entries: entries.size, chunks: chunks.length }
}

export function workerEntryIsolation(): Plugin {
  return {
    name: 'krkr-worker-entry-isolation',
    generateBundle(_options, bundle) {
      const result = assertWorkerEntryIsolation(Object.values(bundle))
      this.info(`Verified ${result.entries} Worker entry and ${result.chunks} chunks without entry back-imports`)
    },
  }
}

import { captureDrop, enumerateDrop } from '../player/drop-files.ts'
import type { BrowserDropTree } from '../protocol/storage-drop.ts'
import type { LocalGameFile } from '../protocol/session.ts'
import { normalizePath } from '../engine/storage/resolver.ts'
import { dropLimits } from '../engine/ports/storage-drop.ts'

/** Match the folder chooser's import root. A single directory contributes
 * its contents; multiple roots keep their names to retain sibling paths. */
export function gameDropFiles(tree: BrowserDropTree): { files: LocalGameFile[]; directory: boolean } {
  const directory = tree.roots.some((root) => root.kind === 'directory'),
    unwrap = tree.roots.length === 1 && directory,
    files: LocalGameFile[] = [], names = new Set<string>()
  for (const entry of tree.entries) {
    if (entry.kind !== 'file') continue
    const root = tree.roots[entry.root]
    if (!root) throw new Error('拖入文件的根目录不可用')
    const path = normalizePath(unwrap ? entry.path : root.name + (entry.path ? '/' + entry.path : ''))
    if (!path || path.includes('>') || names.has(path)) throw new Error('拖入的文件存在重复或无效路径：' + path)
    names.add(path)
    files.push({ path, blob: entry.source })
  }
  if (!files.length) throw new Error('拖入的目录中没有可读取的游戏文件')
  return { files, directory }
}

/** The import card owns this drop only. Game Window.onFileDrop, clipboard
 * fields and other page controls keep their separate input routes. */
export function attachGameFileDrop(element: HTMLElement, options: {
  available(): boolean
  unavailable?(): void
  select?(tree: BrowserDropTree): { files: LocalGameFile[]; directory: boolean }
  progress?: string
  load(files: LocalGameFile[], directory: boolean): Promise<void>
  status(message: string): void
  error(error: unknown): void
}): { cancel(): void; dispose(): void } {
  const lifetime = new AbortController()
  let pending: AbortController | undefined
  const cancel = () => { pending?.abort(); pending = undefined; options.status('') }
  const files = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')
  element.addEventListener('dragover', (event) => {
    if (!files(event)) return
    event.preventDefault()
    event.dataTransfer!.dropEffect = options.available() ? 'copy' : 'none'
  }, { signal: lifetime.signal })
  element.addEventListener('drop', (event) => {
    if (!files(event)) return
    event.preventDefault(); event.stopPropagation()
    if (!options.available()) { options.unavailable?.(); return }
    cancel()
    try {
      // All capability acquisition must occur synchronously in this event.
      // Whole-game imports may contain thousands of loose root files. The
      // running game's Window.onFileDrop keeps its existing 256-root budget.
      const captured = captureDrop(event.dataTransfer!, dropLimits.entries), operation = new AbortController()
      pending = operation; options.status(options.progress ?? '正在读取拖入的游戏文件…')
      void (async () => {
        try {
          const selected = (options.select ?? gameDropFiles)(await enumerateDrop(captured, { signal: operation.signal, rootLimit: dropLimits.entries }))
          operation.signal.throwIfAborted()
          if (pending !== operation) return
          if (!options.available()) { pending = undefined; options.status(''); return }
          // The ordinary launch stops the old game. It must no longer cancel
          // the already completed directory enumeration on this operation.
          pending = undefined; options.status('')
          await options.load(selected.files, selected.directory)
        } catch (error) {
          if (!operation.signal.aborted) {
            options.status(error instanceof Error ? error.message : String(error))
            options.error(error)
          }
        } finally {
          if (pending === operation) pending = undefined
        }
      })()
    } catch (error) {
      options.status(error instanceof Error ? error.message : String(error)); options.error(error)
    }
  }, { signal: lifetime.signal })
  return { cancel, dispose() { cancel(); lifetime.abort() } }
}

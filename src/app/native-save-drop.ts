import type { SessionClient } from '../player/session-client.ts'
import { readNativeSaveBlobs } from '../player/native-saves.ts'
import type { BrowserDropTree } from '../protocol/storage-drop.ts'
import { attachGameFileDrop, gameDropFiles } from './game-file-drop.ts'

export function nativeSaveDropFiles(tree: BrowserDropTree) {
  if (!tree.entries.some((entry) => entry.kind === 'file')) throw new Error('拖入的目录中没有存档文件')
  if (tree.roots.some((root) => root.kind === 'directory') && tree.roots.length !== 1)
    throw new Error('请拖入一个完整存档目录，或单独选择同一目录中的存档文件')
  return gameDropFiles(tree)
}

/** The card never starts a game. All writes use the paused current Session's
 * existing data-directory import transaction; ZIPs require directory choice. */
export function createNativeSaveDrop(root: HTMLElement, options: {
  run(action: (session: SessionClient, check: () => void) => Promise<void>): void
  openZip(file: File): void
  resetZip?(): void
  imported(): void
  status(message: string): void
  error(error: unknown): void
}) {
  let session: SessionClient | undefined, blocked = true, revision = 0
  const drop = attachGameFileDrop(root, {
    available: () => !!session && !blocked,
    unavailable: () => options.status('请先选择“原版游戏存档”并暂停当前游戏，等待已有存档操作完成后再拖入。'),
    select: nativeSaveDropFiles,
    progress: '正在读取拖入的存档…',
    status: options.status,
    error: options.error,
    async load(files, directory) {
      const owner = session, selectedAt = revision
      if (!owner || blocked) return
      if (!directory && files.length === 1 && /\.zip$/i.test(files[0]!.path)) {
        const file = files[0]!
        options.openZip(file.blob instanceof File ? file.blob : new File([file.blob], file.path))
        return
      }
      options.resetZip?.()
      options.run(async (current, check) => {
        const active = () => {
          check()
          if (owner !== current || session !== owner || revision !== selectedAt)
            throw new Error('存档导入已取消，请暂停当前游戏后重新拖入')
        }
        const entries = await readNativeSaveBlobs(files, active)
        active()
        await current.importSaves(entries, 'data-directory')
        active()
        options.imported()
      })
    },
  })
  return {
    cancel() { revision++; drop.cancel() },
    dispose() { revision++; session = undefined; drop.dispose() },
    update(current: SessionClient | undefined, busy: boolean) {
      if (session !== current) { revision++; session = current; drop.cancel() }
      else if (busy && !blocked) drop.cancel()
      blocked = busy
      root.dataset.saveDropAvailable = String(!!session && !blocked)
    },
  }
}

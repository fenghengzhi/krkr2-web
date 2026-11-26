import type { Page } from '@playwright/test'

export type GameDropFile = { path: string; bytes: Uint8Array }

/** Real File/DataTransfer payloads enter the production card listener. The
 * DragEvent is authored by Playwright, not an OS file-manager gesture. */
export async function dropImportFiles(page: Page, files: readonly GameDropFile[], selector = '#game-file-import') {
  return page.locator(selector).evaluate((element, inputs) => {
    const transfer = new DataTransfer()
    for (const input of inputs) transfer.items.add(new File([Uint8Array.from(atob(input.base64), (ch) => ch.charCodeAt(0))], input.path))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
    element.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    element.dispatchEvent(drop)
    const result = { prevented: drop.defaultPrevented, overPrevented: over.defaultPrevented,
      trusted: drop.isTrusted, names: [...transfer.files].map((file) => file.name) }
    transfer.items.clear()
    return result
  }, files.map(({ path, bytes }) => ({ path, base64: Buffer.from(bytes).toString('base64') })))
}

/** Acquire a real browser directory handle through DataTransfer's event-time
 * capability slot. Traversal/getFile are native OPFS operations; only the
 * drag gesture and capability accessor are supplied by the test harness. */
export async function dropImportDirectory(page: Page, files: readonly GameDropFile[]) {
  return page.locator('#game-file-import').evaluate(async (element, inputs) => {
    const storage = await navigator.storage.getDirectory(), name = 'game-import-' + crypto.randomUUID(),
      directory = await storage.getDirectoryHandle(name, { create: true })
    try {
      for (const input of inputs) {
        const parts = input.path.split('/'), leaf = parts.pop()!
        let parent = directory
        for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true })
        const handle = await parent.getFileHandle(leaf, { create: true }), writer = await handle.createWritable()
        try { await writer.write(Uint8Array.from(atob(input.base64), (ch) => ch.charCodeAt(0))); await writer.close() }
        catch (error) {
          try { await writer.abort() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Directory fixture write and cleanup failed') }
          throw error
        }
      }
      await directory.getDirectoryHandle('Empty directory', { create: true })
      const transfer = new DataTransfer(), prototype = DataTransferItem.prototype,
        keys = ['webkitGetAsEntry', 'getAsFileSystemHandle'], saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]))
      transfer.items.add(new File([], name))
      let calls = 0, inEvent = false, synchronous = true
      try {
        Object.defineProperty(prototype, 'webkitGetAsEntry', { configurable: true, value: () => null })
        Object.defineProperty(prototype, 'getAsFileSystemHandle', { configurable: true,
          value: () => { calls++; synchronous &&= inEvent; return Promise.resolve(directory) } })
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
        element.dispatchEvent(over)
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
        inEvent = true; element.dispatchEvent(drop); inEvent = false
        transfer.items.clear()
        return { name, calls, synchronous, prevented: drop.defaultPrevented, overPrevented: over.defaultPrevented,
          trusted: drop.isTrusted, files: inputs.map((input) => ({ path: input.path, bytes: atob(input.base64).length })) }
      } finally {
        for (const key of keys) {
          const descriptor = saved.get(key)
          if (descriptor) Object.defineProperty(prototype, key, descriptor)
          else Reflect.deleteProperty(prototype, key)
        }
      }
    } catch (error) {
      try { await storage.removeEntry(name, { recursive: true }) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Directory drop and cleanup failed') }
      throw error
    }
  }, files.map(({ path, bytes }) => ({ path, base64: Buffer.from(bytes).toString('base64') })))
}

export async function removeImportDirectory(page: Page, name: string) {
  await page.evaluate(async (name) => { await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }) }, name)
}

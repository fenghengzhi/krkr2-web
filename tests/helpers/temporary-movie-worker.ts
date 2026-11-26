import { TemporaryMovieFiles, temporaryMovieDirectory } from '../../src/backends/files/temporary-movies.ts'

self.onmessage = async () => {
  const first = new TemporaryMovieFiles(), second = new TemporaryMovieFiles()
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(temporaryMovieDirectory, { create: true }) as
      FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }
    const names = async () => {
      const names = []
      for await (const name of directory.keys()) names.push(name)
      return names.sort()
    }
    const input = Uint8Array.of(7, 23, 199)
    const source = { size: 3, read: async (at: number, length: number) => input.slice(at, at + length) }
    const control = { check() {}, async checkpoint() {}, onCancel: () => () => {} }
    const signal = new AbortController().signal
    const a = await first.stage(source, control, signal)
    const abandoned = crypto.randomUUID()
    await directory.getFileHandle(abandoned, { create: true })
    await directory.getFileHandle('unrelated', { create: true })
    const b = await second.stage(source, control, signal)
    const recovery = await names()
    const preserved = [...new Uint8Array(await a.blob.arrayBuffer())]
    await b.release()
    await a.release()
    let shortRead = ''
    try { await second.stage({ size: 4, read: async () => input }, control, signal) }
    catch (error) { shortRead = String(error) }
    let started!: () => void, finish!: (value: Uint8Array) => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const blocked = new Promise<Uint8Array>((resolve) => { finish = resolve })
    const cancel = new AbortController()
    const pending = second.stage({ size: 3, read: () => { started(); return blocked } }, control, cancel.signal)
    await reading
    cancel.abort()
    let cancellation = ''
    try { await pending } catch (error) { cancellation = (error as Error).name }
    const afterCancellation = await names()
    finish(input)
    await Promise.all([first.close(), second.close()])
    self.postMessage({ live: recovery.includes(a.blob.name) && recovery.includes(b.blob.name),
      orphan: recovery.includes(abandoned), count: recovery.length, preserved, shortRead, cancellation, afterCancellation })
  } catch (error) {
    self.postMessage({ error: String(error) })
  } finally { await Promise.all([first.close(), second.close()]) }
}

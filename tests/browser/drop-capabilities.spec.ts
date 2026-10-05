import { test, expect, type Page } from '@playwright/test'
import { build } from 'vite'
import { resolve } from 'node:path'

const base = '/drop-capabilities-assets/', bundles = new Map<string, string>()
let entry = ''
test.beforeAll(async () => {
  const result = await build({ configFile: false, envFile: false, logLevel: 'error',
    build: { write: false, target: 'es2022', minify: false,
      lib: { entry: resolve('src/player/drop-files.ts'), formats: ['es'], fileName: 'drop-capabilities' } } }),
    outputs = (Array.isArray(result) ? result : [result]).flatMap((value) => 'output' in value ? value.output : [])
  for (const output of outputs) {
    if (output.type !== 'chunk') continue
    bundles.set(output.fileName, output.code)
    if (output.isEntry) entry = base + output.fileName
  }
  if (!entry) throw new Error('Missing drop capability browser entry')
})
async function mount(page: Page) {
  await page.route('**/drop-capabilities-assets/**', (route) => {
    const source = bundles.get(new URL(route.request().url()).pathname.slice(base.length))
    return route.fulfill({ status: source === undefined ? 404 : 200, contentType: 'text/javascript', body: source ?? 'Missing asset' })
  })
  await page.route('**/drop-capabilities.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Drop capability contracts</title>' }))
  await page.goto('/drop-capabilities.html')
}

test('native DataTransfer Files are captured synchronously, survive its clearing and retain original top-level order', async ({ page }, info) => {
  await mount(page)
  const result = await page.evaluate(async (entry) => {
    const { captureDrop, enumerateDrop } = await import(entry) as typeof import('../../src/player/drop-files.ts'),
      transfer = new DataTransfer()
    transfer.items.add(new File(['first'], 'same.txt'))
    transfer.items.add(new File(['second'], 'same.txt'))
    transfer.items.add(new File([], 'empty.bin'))
    const captured = captureDrop(transfer)
    transfer.items.clear()
    const tree = await enumerateDrop(captured, { signal: new AbortController().signal })
    return { roots: tree.roots, entries: await Promise.all(tree.entries.map(async (item) => ({
      root: item.root, path: item.path, kind: item.kind,
      ...(item.kind === 'file' ? { size: item.source.size, text: await item.source.text() } : {}),
    }))), remainingTransferItems: transfer.items.length }
  }, entry)
  expect(result.roots).toEqual([{ name: 'same.txt', kind: 'file' }, { name: 'same.txt', kind: 'file' }, { name: 'empty.bin', kind: 'file' }])
  expect(result.entries).toEqual([{ root: 0, path: '', kind: 'file', size: 5, text: 'first' },
    { root: 1, path: '', kind: 'file', size: 6, text: 'second' }, { root: 2, path: '', kind: 'file', size: 0, text: '' }])
  expect(result.remainingTransferItems).toBe(0)
  await info.attach('actual-datatransfer-files', { body: JSON.stringify(result), contentType: 'application/json' })
})

test('actual OPFS directory handles enumerate nested files and empty directories after event-time handle acquisition', async ({ page }, info) => {
  await mount(page)
  test.skip(!(await page.evaluate(() => typeof navigator.storage?.getDirectory === 'function')), 'OPFS directory handles unavailable')
  const result = await page.evaluate(async (entry) => {
    const { captureDrop, enumerateDrop } = await import(entry) as typeof import('../../src/player/drop-files.ts'),
      root = await navigator.storage.getDirectory(), name = 'drop-' + crypto.randomUUID(),
      folder = await root.getDirectoryHandle(name, { create: true })
    try {
      const nested = await folder.getDirectoryHandle('Nested', { create: true })
      await nested.getDirectoryHandle('Empty', { create: true })
      const text = await folder.getFileHandle('hello.txt', { create: true }), writer = await text.createWritable()
      await writer.write(new Blob(['Hello λ\n'])); await writer.close()
      const binary = await nested.getFileHandle('bytes.bin', { create: true }), binaryWriter = await binary.createWritable()
      await binaryWriter.write(new Uint8Array([0,1,127,255])); await binaryWriter.close()
      const transfer = new DataTransfer(); transfer.items.add(new File([], 'placeholder'))
      const item = transfer.items[0]!, calls: boolean[] = []; let inDrop = true
      Object.defineProperty(item, 'webkitGetAsEntry', { configurable: true, value: () => null })
      Object.defineProperty(item, 'getAsFileSystemHandle', { configurable: true, value: () => { calls.push(inDrop); return Promise.resolve(folder) } })
      const captured = captureDrop(transfer)
      inDrop = false; transfer.items.clear()
      Object.defineProperty(item, 'getAsFileSystemHandle', { value: () => { throw new Error('late capability acquisition') } })
      const tree = await enumerateDrop(captured, { signal: new AbortController().signal }),
        entries = await Promise.all(tree.entries.map(async (item) => ({ path: item.path, kind: item.kind,
          ...(item.kind === 'file' ? { bytes: [...new Uint8Array(await item.source.arrayBuffer())] } : {}),
        })))
      entries.sort((a, b) => a.path.localeCompare(b.path))
      return { calls, roots: tree.roots, name, entries,
        evidence: 'Native OPFS FileSystemDirectoryHandle/getFile/values; DataTransfer accessor injected. Not external OS dragging.' }
    } finally { await root.removeEntry(name, { recursive: true }) }
  }, entry)
  expect(result.calls).toEqual([true])
  expect(result.roots).toEqual([{ name: result.name, kind: 'directory' }])
  expect(result.entries).toHaveLength(5)
  expect(result.entries).toContainEqual({ path: '', kind: 'directory' })
  expect(result.entries).toContainEqual({ path: 'Nested', kind: 'directory' })
  expect(result.entries).toContainEqual({ path: 'Nested/Empty', kind: 'directory' })
  expect(result.entries).toContainEqual({ path: 'Nested/bytes.bin', kind: 'file', bytes: [0,1,127,255] })
  expect(result.entries).toContainEqual({ path: 'hello.txt', kind: 'file', bytes: [72,101,108,108,111,32,206,187,10] })
  await info.attach('actual-opfs-directory-capability', { body: JSON.stringify(result), contentType: 'application/json' })
})

test('actual legacy filesystem entries retain empty-directory metadata and read native file bytes', async ({ page }, info) => {
  await mount(page)
  test.skip(!(await page.evaluate(() => typeof (window as unknown as { webkitRequestFileSystem?: unknown }).webkitRequestFileSystem === 'function')), 'Legacy FileSystemEntry creation API unavailable')
  const result = await page.evaluate(async (entry) => {
    interface Directory {
      name: string
      getDirectory(name: string, options: { create: boolean }, success: (value: Directory) => void, fail: (error: unknown) => void): void
      getFile(name: string, options: { create: boolean }, success: (value: LegacyFile) => void, fail: (error: unknown) => void): void
      removeRecursively(success: () => void, fail: (error: unknown) => void): void
    }
    interface Writer { onwriteend: (() => void) | null; onerror: (() => void) | null; error?: unknown; write(blob: Blob): void }
    interface LegacyFile { createWriter(success: (writer: Writer) => void, fail: (error: unknown) => void): void }
    const { captureDrop, enumerateDrop } = await import(entry) as typeof import('../../src/player/drop-files.ts'),
      system = await new Promise<{ root: Directory }>((resolve, reject) => {
        (window as unknown as { webkitRequestFileSystem(type: number, size: number, success: (value: { root: Directory }) => void, fail: (error: unknown) => void): void })
          .webkitRequestFileSystem(0, 1024 * 1024, resolve, reject)
      }), name = 'drop-' + crypto.randomUUID(),
      folder = await new Promise<Directory>((resolve, reject) => system.root.getDirectory(name, { create: true }, resolve, reject))
    try {
      await new Promise<Directory>((resolve, reject) => folder.getDirectory('Empty', { create: true }, resolve, reject))
      const file = await new Promise<LegacyFile>((resolve, reject) => folder.getFile('hello.txt', { create: true }, resolve, reject)),
        writer = await new Promise<Writer>((resolve, reject) => file.createWriter(resolve, reject))
      try { await new Promise<void>((resolve, reject) => {
        writer.onwriteend = resolve; writer.onerror = () => reject(writer.error ?? new Error('Legacy writer failed'))
        writer.write(new Blob(['entry-bytes']))
      }) } finally { writer.onwriteend = null; writer.onerror = null }
      const transfer = new DataTransfer(); transfer.items.add(new File([], 'placeholder'))
      let inDrop = true; const calls: boolean[] = [], item = transfer.items[0]!
      Object.defineProperty(item, 'webkitGetAsEntry', { value: () => { calls.push(inDrop); return folder } })
      Object.defineProperty(item, 'getAsFileSystemHandle', { value: undefined })
      const captured = captureDrop(transfer); inDrop = false; transfer.items.clear()
      const tree = await enumerateDrop(captured, { signal: new AbortController().signal })
      return { calls, roots: tree.roots, name, entries: await Promise.all(tree.entries.map(async (item) => ({
        path: item.path, kind: item.kind, ...(item.kind === 'file' ? { text: await item.source.text() } : {}),
      }))), evidence: 'Native sandbox FileSystemDirectoryEntry/readEntries/file; DataTransfer accessor injected. Not external OS dragging.' }
    } finally { await new Promise<void>((resolve, reject) => folder.removeRecursively(resolve, reject)) }
  }, entry)
  expect(result.calls).toEqual([true])
  expect(result.roots).toEqual([{ name: result.name, kind: 'directory' }])
  expect(result.entries).toHaveLength(3)
  expect(result.entries).toContainEqual({ path: '', kind: 'directory' })
  expect(result.entries).toContainEqual({ path: 'Empty', kind: 'directory' })
  expect(result.entries).toContainEqual({ path: 'hello.txt', kind: 'file', text: 'entry-bytes' })
  await info.attach('actual-filesystem-entry-capability', { body: JSON.stringify(result), contentType: 'application/json' })
})

test('capability gaps, bounded root counts and cancellation fail explicitly without late unhandled rejection', async ({ page }, info) => {
  await mount(page)
  const pageErrors: string[] = []; page.on('pageerror', (error) => pageErrors.push(error.message))
  const result = await page.evaluate(async (entry) => {
    const { captureDrop, enumerateDrop } = await import(entry) as typeof import('../../src/player/drop-files.ts'), errors: string[] = [], unhandled: string[] = [],
      listener = (event: PromiseRejectionEvent) => unhandled.push(String(event.reason))
    window.addEventListener('unhandledrejection', listener)
    try {
      const unavailable = new DataTransfer(); unavailable.items.add(new File([], 'directory'))
      const missing = unavailable.items[0]!
      for (const [name, value] of [['getAsFile', () => null], ['webkitGetAsEntry', () => null], ['getAsFileSystemHandle', undefined]])
        Object.defineProperty(missing, name as string, { value })
      try { captureDrop(unavailable) } catch (error) { errors.push(String(error)) }
      const oversized = new DataTransfer()
      for (let i = 0; i < 257; i++) oversized.items.add(new File([], String(i)))
      try { captureDrop(oversized) } catch (error) { errors.push(String(error)) }
      const transfer = new DataTransfer(); transfer.items.add(new File([], 'pending'))
      let reject!: (error: unknown) => void, called = 0
      const item = transfer.items[0]!
      Object.defineProperty(item, 'webkitGetAsEntry', { value: () => null })
      Object.defineProperty(item, 'getAsFileSystemHandle', { value: () => { called++; return new Promise((_yes, no) => { reject = no }) } })
      const captured = captureDrop(transfer), abort = new AbortController(), pending = enumerateDrop(captured, { signal: abort.signal })
      abort.abort(new Error('enumeration cancelled'))
      try { await pending } catch (error) { errors.push(String(error)) }
      reject(new Error('late browser handle rejection'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return { errors, called, unhandled, evidence: 'Injected unavailable/rejecting capability boundary; native DataTransfer File items.' }
    } finally { window.removeEventListener('unhandledrejection', listener) }
  }, entry)
  expect(result.errors).toHaveLength(3)
  expect(result.errors[0]).toContain('did not provide')
  expect(result.errors[1]).toContain('top-level item budget')
  expect(result.errors[2]).toContain('enumeration cancelled')
  expect(result.called).toBe(1)
  expect(result.unhandled).toEqual([])
  expect(pageErrors).toEqual([])
  await info.attach('drop-capability-boundaries', { body: JSON.stringify(result), contentType: 'application/json' })
})

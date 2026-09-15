import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserClipboard } from '../../src/backends/clipboard/browser.ts'
import { clipboardBlobLimit, clipboardTextLimit } from '../../src/engine/ports/clipboard.ts'

// Adapter contracts only: every Window/Clipboard API is an injected fake in
// this Node test process. No test reads or writes a system clipboard.
interface FakeClipboard {
  read?: () => Promise<ClipboardItems>
  readText?: () => Promise<string>
  writeText?: (text: string) => Promise<void>
}

function host(t: TestContext, clipboard: FakeClipboard = {}, secure = true) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>(
    ['window', 'navigator'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  )
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isSecureContext: secure },
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } })
  const adapter = new BrowserClipboard()
  t.after(() => {
    adapter.close()
    for (const [name, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
  })
  return adapter
}

function item(types: string[], getType: () => Promise<Blob>): ClipboardItem {
  return { types, getType } as unknown as ClipboardItem
}

const quota = (error: unknown) => {
  assert.equal((error as Error).name, 'QuotaExceededError')
  return true
}

test('browser clipboard writes the complete boundary text synchronously and rejects larger text before its API', async (t) => {
  const calls: string[] = [],
    adapter = host(t, {
      writeText(text) {
        calls.push(text)
        return Promise.resolve()
      },
    }),
    text = '🙂'.repeat(clipboardTextLimit / 2 - 1) + '\r\n'
  assert.equal(text.length, clipboardTextLimit)
  const work = adapter.writeText(text)
  assert.equal(calls.length, 1)
  assert.ok(calls[0] === text, 'The complete text must reach the API before yielding')
  await work
  await assert.rejects(adapter.writeText(text + 'x'), quota)
  assert.equal(calls.length, 1)
  assert.ok(
    calls[0] === text,
    'Rejecting an oversized write must preserve the earlier complete call',
  )
})

test('browser clipboard uses format metadata and distinguishes absent text from an empty representation', async (t) => {
  let reads = 0,
    decodes = 0,
    snapshot: ClipboardItems = [item(['image/png'], async () => new Blob())]
  const adapter = host(t, {
    read() {
      reads++
      return Promise.resolve(snapshot)
    },
  })
  assert.equal(await adapter.hasText(), false)
  assert.deepEqual(await adapter.readText(), { hasText: false })
  snapshot = [
    item(['text/plain'], async () => {
      decodes++
      return new Blob([''])
    }),
  ]
  assert.equal(await adapter.hasText(), true)
  assert.equal(decodes, 0)
  assert.deepEqual(await adapter.readText(), { hasText: true, text: '' })
  assert.equal(reads, 4)
  assert.equal(decodes, 1)
})

test('browser clipboard checks Blob byte size before decoding and admits the exact metadata limit', async (t) => {
  let size = clipboardBlobLimit + 1,
    decodes = 0
  const adapter = host(t, {
    read: async () => [
      item(['text/plain'], async () => {
        // Deliberate Blob metadata fake: this checks the adapter's admission
        // boundary independently of UTF-8 byte-to-UTF-16 expansion.
        return {
          size,
          async text() {
            decodes++
            return 'within decoded limit'
          },
        } as Blob
      }),
    ],
  })
  await assert.rejects(adapter.readText(), quota)
  assert.equal(decodes, 0)
  size = clipboardBlobLimit
  assert.deepEqual(await adapter.readText(), { hasText: true, text: 'within decoded limit' })
  assert.equal(decodes, 1)
})

test('browser clipboard rejects decoded text above the UTF-16 limit without returning a prefix', async (t) => {
  const text = 'x'.repeat(clipboardTextLimit + 1),
    blob = new Blob([text]),
    adapter = host(t, { read: async () => [item(['text/plain'], async () => blob)] })
  assert.ok(blob.size < clipboardBlobLimit)
  await assert.rejects(adapter.readText(), quota)
})

test('browser clipboard preserves Unicode and newlines at the exact decoded UTF-16 limit', async (t) => {
  const text = '🙂'.repeat(clipboardTextLimit / 2 - 1) + '\r\n',
    blob = new Blob([text]),
    adapter = host(t, { read: async () => [item(['text/plain'], async () => blob)] })
  assert.equal(text.length, clipboardTextLimit)
  assert.ok(blob.size < clipboardBlobLimit)
  const content = await adapter.readText()
  assert.equal(content.hasText, true)
  assert.ok(content.hasText && content.text === text, 'The complete decoded text must be preserved')
})

test('browser clipboard preserves actual API and representation errors', async (t) => {
  const reason = new DOMException('Original browser permission failure', 'NotAllowedError'),
    clipboard: FakeClipboard = {
      read: () => Promise.reject(reason),
      writeText() {
        throw reason
      },
    },
    adapter = host(t, clipboard),
    same = (error: unknown) => {
      assert.equal(error, reason)
      return true
    }
  await assert.rejects(adapter.readText(), same)
  await assert.rejects(adapter.writeText('allowed size'), same)
  clipboard.read = async () => [item(['text/plain'], () => Promise.reject(reason))]
  await assert.rejects(adapter.readText(), same)
})

test('browser clipboard close rejects its wait and consumes a later platform rejection', async (t) => {
  let reject!: (reason: unknown) => void
  const adapter = host(t, {
      read: () => new Promise<ClipboardItems>((_, fail) => (reject = fail)),
    }),
    work = adapter.readText(),
    cancelled = assert.rejects(work, (error: unknown) => {
      assert.equal((error as Error).name, 'AbortError')
      return true
    })
  adapter.close()
  await cancelled
  reject(new DOMException('Late permission response', 'NotAllowedError'))
  // Give the actual Promise rejection checkpoint a turn; Node's test runner
  // reports any unhandled rejection instead of treating it as a successful close.
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(adapter.hasText(), { name: 'AbortError' })
})

test('browser clipboard never substitutes readText for missing format access or bypasses secure context checks', async (t) => {
  let fallback = 0,
    reads = 0
  const clipboard: FakeClipboard = {
      readText: async () => {
        fallback++
        return ''
      },
    },
    adapter = host(t, clipboard)
  await assert.rejects(adapter.readText(), { name: 'NotSupportedError' })
  await assert.rejects(adapter.hasText(), { name: 'NotSupportedError' })
  assert.equal(fallback, 0)
  clipboard.read = async () => {
    reads++
    return []
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isSecureContext: false },
  })
  await assert.rejects(adapter.readText(), { name: 'NotSupportedError' })
  assert.equal(reads, 0)
})

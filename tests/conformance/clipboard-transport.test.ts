import nodeTest, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PortClipboardBackend } from '../../src/backends/clipboard/port-backend.ts'
import { ClipboardChannel } from '../../src/player/clipboard-channel.ts'
import { clipboardTextLimit } from '../../src/engine/ports/clipboard.ts'
import {
  isClipboardRequest,
  isClipboardResponse,
  type ClipboardMessage,
  type ClipboardRequest,
  type ClipboardResponse,
  type ClipboardResult,
} from '../../src/protocol/clipboard.ts'

const generation = 17
const test = (name: string, run: (t: TestContext) => void | Promise<void>) =>
  nodeTest(name, { timeout: 30000 }, run)

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function mailbox<T>() {
  const waiting: ((value: T) => void)[] = [],
    queued: T[] = [],
    seen: T[] = []
  return {
    seen,
    push(value: T) {
      seen.push(value)
      const resolve = waiting.shift()
      if (resolve) resolve(value)
      else queued.push(value)
    },
    next(description = 'clipboard message'): Promise<T> {
      if (queued.length) return Promise.resolve(queued.shift()!)
      return bounded(new Promise<T>((resolve) => waiting.push(resolve)), description)
    },
  }
}

function incoming(port: MessagePort) {
  const messages = mailbox<ClipboardMessage>()
  port.addEventListener('message', ({ data }: MessageEvent<ClipboardMessage>) =>
    messages.push(data),
  )
  port.start()
  return messages
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Observe rejection immediately, including when a test assertion fails before
// close() retires a still-waiting request. Late replies must never create a new
// unhandled rejection outside the operation whose lifetime owns them.
function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

async function value<T>(promise: Promise<Outcome<T>>): Promise<T> {
  const result = await bounded(promise, 'clipboard operation result')
  if (!result.ok) throw result.error
  return result.value
}

async function failure<T>(promise: Promise<Outcome<T>>, name: string, message?: string) {
  const result = await bounded(promise, `clipboard ${name}`)
  if (result.ok) assert.fail(`Expected ${name}, received success`)
  assert.ok(result.error instanceof Error)
  assert.equal(result.error.name, name)
  if (message !== undefined) assert.equal(result.error.message, message)
  return result.error
}

function response(request: ClipboardRequest, result: ClipboardResult): ClipboardResponse {
  return { generation: request.generation, id: request.id, ok: true, result }
}

async function request(messages: ReturnType<typeof incoming>) {
  const message = await messages.next('clipboard request')
  assert.equal(message.type, 'request')
  if (message.type !== 'request') assert.fail('Expected a clipboard request')
  return message.request
}

function backendFixture(t: TestContext) {
  const ports = new MessageChannel(),
    messages = incoming(ports.port2),
    backend = new PortClipboardBackend(ports.port1, generation)
  t.after(() => {
    backend.close()
    ports.port2.close()
  })
  return {
    backend,
    messages,
    post: (data: unknown) => ports.port2.postMessage(data),
    reply: (data: ClipboardResponse) => ports.port2.postMessage({ type: 'reply', response: data }),
  }
}

function channelFixture(t: TestContext) {
  const ports = new MessageChannel(),
    messages = incoming(ports.port1),
    published = mailbox<ClipboardRequest | null>(),
    channel = new ClipboardChannel(ports.port2, generation, (current) => published.push(current)),
    barriers = new Map<number, () => void>()
  let nextBarrier = 1
  ports.port2.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== 'object') return
    const marker = data as { type?: unknown; id?: number }
    if (marker.type === 'clipboard-test-barrier' && marker.id !== undefined)
      barriers.get(marker.id)?.()
  })
  t.after(() => {
    channel.close()
    ports.port1.close()
  })
  return {
    channel,
    messages,
    published,
    post: (data: unknown) => ports.port1.postMessage(data),
    send: (current: ClipboardRequest) =>
      ports.port1.postMessage({ type: 'request', request: current }),
    async delivered() {
      const id = nextBarrier++
      try {
        await bounded(
          new Promise<void>((resolve) => {
            barriers.set(id, resolve)
            ports.port1.postMessage({ type: 'clipboard-test-barrier', id })
          }),
          'earlier clipboard channel messages delivered',
        )
      } finally {
        barriers.delete(id)
      }
    },
  }
}

function pairedFixture(t: TestContext) {
  const ports = new MessageChannel(),
    published = mailbox<ClipboardRequest | null>(),
    backend = new PortClipboardBackend(ports.port1, generation),
    channel = new ClipboardChannel(ports.port2, generation, (current) => published.push(current))
  t.after(() => {
    backend.close()
    channel.close()
  })
  return { backend, channel, published }
}

test('clipboard MessageChannel carries fresh presence, absent text, empty text and Unicode writes', async (t) => {
  const f = pairedFixture(t)
  const has = observe(f.backend.hasText()),
    first = await f.published.next()
  assert.deepEqual(first, { generation, id: 1, op: 'has-text' })
  assert.equal(f.channel.respond(response(first!, { op: 'has-text', hasText: false })), true)
  assert.equal(await f.published.next(), null)
  assert.equal(await value(has), false)

  for (const content of [{ hasText: false }, { hasText: true, text: '' }] as const) {
    const reading = observe(f.backend.readText()),
      current = await f.published.next()
    assert.equal(current?.op, 'read-text')
    assert.equal(f.channel.respond(response(current!, { op: 'read-text', content })), true)
    assert.equal(await f.published.next(), null)
    assert.deepEqual(await value(reading), content)
  }

  const text = '漢字 🌸\r\nsecond line',
    writing = observe(f.backend.writeText(text)),
    current = await f.published.next()
  assert.deepEqual(current, { generation, id: 4, op: 'write-text', text })
  assert.equal(f.channel.respond(response(current!, { op: 'write-text' })), true)
  assert.equal(await f.published.next(), null)
  assert.equal(await value(writing), undefined)
})

test('clipboard protocol accepts the shared UTF-16 boundary and rejects oversized text and error fields', () => {
  assert.equal(clipboardTextLimit, 1_048_576)
  const text = '🌸'.repeat(clipboardTextLimit / 2),
    oversized = `${text}x`,
    identity = { generation, id: 1 }
  assert.equal(text.length, clipboardTextLimit)
  assert.equal(isClipboardRequest({ ...identity, op: 'write-text', text }), true)
  assert.equal(isClipboardRequest({ ...identity, op: 'write-text', text: oversized }), false)
  assert.equal(
    isClipboardResponse({
      ...identity,
      ok: true,
      result: { op: 'read-text', content: { hasText: true, text } },
    }),
    true,
  )
  assert.equal(
    isClipboardResponse({
      ...identity,
      ok: true,
      result: { op: 'read-text', content: { hasText: true, text: oversized } },
    }),
    false,
  )
  for (const field of ['name', 'message'] as const) {
    const error = { name: 'NotAllowedError', message: 'permission denied', [field]: text }
    assert.equal(isClipboardResponse({ ...identity, ok: false, error }), true)
    assert.equal(
      isClipboardResponse({ ...identity, ok: false, error: { ...error, [field]: oversized } }),
      false,
    )
  }
})

test('clipboard transports exact-limit Unicode text in both directions without truncation or byte-based rejection', async (t) => {
  const f = pairedFixture(t),
    text = `${'漢'.repeat(clipboardTextLimit - 2)}🌸`,
    writing = observe(f.backend.writeText(text)),
    write = await f.published.next()
  assert.ok(write?.op === 'write-text')
  assert.equal(write.text.length, clipboardTextLimit)
  assert.ok(write.text === text, 'The entire boundary write must arrive unchanged')
  assert.equal(f.channel.respond(response(write, { op: 'write-text' })), true)
  assert.equal(await f.published.next(), null)
  assert.equal(await value(writing), undefined)

  const reading = observe(f.backend.readText()),
    read = await f.published.next()
  assert.ok(read?.op === 'read-text')
  assert.equal(
    f.channel.respond(response(read, { op: 'read-text', content: { hasText: true, text } })),
    true,
  )
  assert.equal(await f.published.next(), null)
  const content = await value(reading)
  assert.ok(content.hasText)
  assert.equal(content.text.length, clipboardTextLimit)
  assert.ok(content.text === text, 'The entire boundary read must return unchanged')
})

test('clipboard backend rejects oversized writes before sending or consuming a request identity', async (t) => {
  const f = backendFixture(t),
    oversized = `${'🌸'.repeat(clipboardTextLimit / 2)}x`
  await failure(observe(f.backend.writeText(oversized)), 'QuotaExceededError')
  const next = observe(f.backend.hasText()),
    current = await request(f.messages)
  assert.deepEqual(current, { generation, id: 1, op: 'has-text' })
  f.reply(response(current, { op: 'has-text', hasText: false }))
  assert.equal(await value(next), false)
  assert.equal(f.messages.seen.length, 1, 'Only the later valid operation may cross the port')
})

test('clipboard channel explicitly rejects oversized or malformed identified requests without showing UI or consuming accepted ids', async (t) => {
  const f = channelFixture(t),
    oversized = 'x'.repeat(clipboardTextLimit + 1),
    invalid = [
      { op: 'write-text', text: oversized },
      { op: 'write-text' },
      { op: 'write-text', text: 7 },
      { op: 'unknown' },
    ]
  for (const [offset, payload] of invalid.entries()) {
    const id = 100 + offset
    f.post({ type: 'request', request: { generation, id, ...payload } })
    const message = await f.messages.next('identified invalid request failure')
    assert.equal(message.type, 'reply')
    if (message.type !== 'reply' || message.response.ok)
      assert.fail('An identified invalid request must receive an explicit failure')
    assert.equal(message.response.generation, generation)
    assert.equal(message.response.id, id)
    assert.equal(message.response.error.name, offset === 0 ? 'QuotaExceededError' : 'DataError')
    assert.ok(message.response.error.message.length < clipboardTextLimit)
    assert.deepEqual(f.published.seen, [])
  }

  const current: ClipboardRequest = { generation, id: 1, op: 'has-text' }
  f.send(current)
  assert.deepEqual(await f.published.next(), current)
  f.post({
    type: 'request',
    request: { generation, id: 999, op: 'write-text', text: oversized },
  })
  const busyInvalid = await f.messages.next('oversized request while another UI is pending')
  assert.equal(busyInvalid.type, 'reply')
  if (busyInvalid.type !== 'reply' || busyInvalid.response.ok)
    assert.fail('An oversized concurrent request must receive a failure')
  assert.equal(busyInvalid.response.id, 999)
  assert.equal(busyInvalid.response.error.name, 'QuotaExceededError')
  assert.deepEqual(f.published.seen, [current], 'The pending UI must retain its original owner')
  assert.equal(f.channel.respond(response(current, { op: 'has-text', hasText: true })), true)
  assert.equal(await f.published.next(), null)
  await f.messages.next()
  const next: ClipboardRequest = { generation, id: 2, op: 'read-text' }
  f.send(next)
  assert.deepEqual(await f.published.next(), next)
})

test('clipboard backend settles oversized read and error replies with a bounded quota error and remains reusable', async (t) => {
  const f = backendFixture(t),
    oversized = 'x'.repeat(clipboardTextLimit + 1)
  for (const payload of [
    { ok: true, result: { op: 'read-text', content: { hasText: true, text: oversized } } },
    { ok: false, error: { name: oversized, message: 'denied' } },
    { ok: false, error: { name: 'NotAllowedError', message: oversized } },
  ]) {
    const reading = observe(f.backend.readText()),
      current = await request(f.messages)
    f.post({ type: 'reply', response: { generation, id: current.id, ...payload } })
    const error = await failure(reading, 'QuotaExceededError')
    assert.ok(
      error.message.length < clipboardTextLimit,
      'The error must not echo the rejected body',
    )
    const next = observe(f.backend.readText()),
      replacement = await request(f.messages)
    f.post({ type: 'reply', response: { generation, id: current.id, ...payload } })
    f.reply(response(replacement, { op: 'read-text', content: { hasText: false } }))
    assert.deepEqual(await value(next), { hasText: false })
  }
})

test('clipboard channel turns matching malformed or oversized UI responses into explicit failures and retires them once', async (t) => {
  const f = pairedFixture(t),
    oversized = 'x'.repeat(clipboardTextLimit + 1),
    malformed = [
      { ok: true, result: { op: 'read-text', content: { hasText: true } } },
      { ok: true, result: { op: 'read-text', content: { hasText: false, text: '' } } },
      { ok: true, result: { op: 'read-text', content: { hasText: false, text: undefined } } },
      { ok: false, error: { name: 'Error' } },
      { ok: true, result: { op: 'unknown' } },
    ],
    overBudget = [
      { ok: true, result: { op: 'read-text', content: { hasText: true, text: oversized } } },
      { ok: false, error: { name: oversized, message: 'denied' } },
      { ok: false, error: { name: 'NotAllowedError', message: oversized } },
    ]
  for (const [offset, payload] of [...malformed, ...overBudget].entries()) {
    const reading = observe(f.backend.readText()),
      current = await f.published.next()
    assert.ok(current)
    const reply = { generation, id: current.id, ...payload } as ClipboardResponse
    assert.equal(f.channel.respond(reply), true)
    assert.equal(f.channel.respond(reply), false)
    assert.equal(await f.published.next(), null)
    const error = await failure(
      reading,
      offset < malformed.length ? 'DataError' : 'QuotaExceededError',
    )
    assert.ok(error.message.length < clipboardTextLimit)
  }
  assert.equal(f.published.seen.length, 2 * (malformed.length + overBudget.length))
})

test('oversized clipboard responses with a wrong id, generation or known operation cannot retire the current request', async (t) => {
  const f = pairedFixture(t),
    operation = observe(f.backend.hasText()),
    current = await f.published.next(),
    oversized = 'x'.repeat(clipboardTextLimit + 1)
  assert.ok(current)
  const wrongOperation: ClipboardResponse = response(current, {
    op: 'read-text',
    content: { hasText: true, text: oversized },
  })
  for (const reply of [
    { ...wrongOperation, id: current.id + 1 },
    { ...wrongOperation, generation: generation + 1 },
    wrongOperation,
  ])
    assert.equal(f.channel.respond(reply), false)
  assert.deepEqual(f.published.seen, [current])
  assert.equal(f.channel.respond(response(current, { op: 'has-text', hasText: false })), true)
  assert.equal(await f.published.next(), null)
  assert.equal(await value(operation), false)
})

test('clipboard errors at the shared text limit cross the real channel unchanged', async (t) => {
  const f = pairedFixture(t),
    operation = observe(f.backend.hasText()),
    current = await f.published.next(),
    message = '🌸'.repeat(clipboardTextLimit / 2)
  assert.ok(current)
  assert.equal(
    f.channel.respond({
      generation,
      id: current.id,
      ok: false,
      error: { name: 'NotAllowedError', message },
    }),
    true,
  )
  assert.equal(await f.published.next(), null)
  const error = await failure(operation, 'NotAllowedError')
  assert.equal(error.message.length, clipboardTextLimit)
  assert.ok(error.message === message, 'The boundary error must not be truncated or replaced')
})

test('clipboard backend rejects overlapping operations without replacing the pending request', async (t) => {
  const f = backendFixture(t),
    first = observe(f.backend.readText()),
    pending = await request(f.messages)
  await failure(observe(f.backend.hasText()), 'InvalidStateError')
  await failure(observe(f.backend.writeText('overlap')), 'InvalidStateError')
  f.reply(response(pending, { op: 'read-text', content: { hasText: true, text: 'first' } }))
  assert.deepEqual(await value(first), { hasText: true, text: 'first' })

  const next = observe(f.backend.hasText()),
    replacement = await request(f.messages)
  assert.equal(replacement.id, pending.id + 1, 'Rejected calls must not consume transport identity')
  f.reply(response(replacement, { op: 'has-text', hasText: true }))
  assert.equal(await value(next), true)
  assert.equal(f.messages.seen.filter((entry) => entry.type === 'request').length, 2)
})

test('clipboard backend ignores unrelated identities, unknown messages and wrong-generation close', async (t) => {
  const f = backendFixture(t),
    operation = observe(f.backend.hasText()),
    pending = await request(f.messages),
    success = response(pending, { op: 'has-text', hasText: true })
  for (const id of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, pending.id + 1])
    f.post({ type: 'reply', response: { ...success, id } })
  for (const otherGeneration of [0, -1, 0.5, Number.NaN, Infinity, generation + 1])
    f.post({ type: 'reply', response: { ...success, generation: otherGeneration } })
  for (const data of [null, false, [], {}, { type: 'unknown' }, { type: 'reply' }]) f.post(data)
  f.post({ type: 'close', generation: generation + 1 })
  f.reply(response(pending, { op: 'has-text', hasText: false }))
  assert.equal(await value(operation), false)
})

for (const malformed of [
  { label: 'wrong operation', result: { op: 'read-text', content: { hasText: false } } },
  { label: 'non-boolean presence', result: { op: 'has-text', hasText: 1 } },
  { label: 'unknown operation', result: { op: 'unsupported' } },
  { label: 'null result', result: null },
]) {
  test(`clipboard backend rejects a matching ${malformed.label} reply without poisoning the next operation`, async (t) => {
    const f = backendFixture(t),
      first = observe(f.backend.hasText()),
      current = await request(f.messages)
    f.post({
      type: 'reply',
      response: { generation, id: current.id, ok: true, result: malformed.result },
    })
    await failure(first, 'DataError')
    const second = observe(f.backend.hasText()),
      next = await request(f.messages)
    assert.ok(next.id > current.id)
    f.reply(response(current, { op: 'has-text', hasText: true }))
    f.reply(response(next, { op: 'has-text', hasText: false }))
    assert.equal(await value(second), false)
  })
}

test('clipboard backend rejects malformed read content and error objects with the matching identity', async (t) => {
  const f = backendFixture(t)
  for (const payload of [
    { ok: true, result: { op: 'read-text', content: null } },
    { ok: true, result: { op: 'read-text', content: { hasText: true } } },
    { ok: true, result: { op: 'read-text', content: { hasText: 'false' } } },
    { ok: true, result: { op: 'read-text', content: { hasText: true, text: 1 } } },
    { ok: true, result: { op: 'read-text', content: { hasText: false, text: '' } } },
    { ok: true, result: { op: 'read-text', content: { hasText: false, text: undefined } } },
    { ok: false, error: null },
    { ok: false, error: { name: 'NotAllowedError', message: 7 } },
    { ok: false, error: { message: 'missing name' } },
    { result: { op: 'read-text', content: { hasText: false } } },
  ]) {
    const operation = observe(f.backend.readText()),
      current = await request(f.messages)
    f.post({ type: 'reply', response: { generation, id: current.id, ...payload } })
    await failure(operation, 'DataError')
  }
})

test('clipboard errors retain the original name and message across MessageChannel', async (t) => {
  const f = pairedFixture(t)
  for (const error of [
    { name: 'NotSupportedError', message: 'ClipboardItem reads are unavailable' },
    { name: 'NotAllowedError', message: '用户拒绝 🌸' },
    { name: 'AbortError', message: '' },
  ]) {
    const operation = observe(f.backend.readText()),
      current = await f.published.next()
    assert.ok(current)
    assert.equal(f.channel.respond({ generation, id: current.id, ok: false, error }), true)
    assert.equal(await f.published.next(), null)
    await failure(operation, error.name, error.message)
  }
})

test('clipboard backend close revokes immediately, sends one close and rejects all future operations', async (t) => {
  const f = backendFixture(t),
    operation = observe(f.backend.readText()),
    current = await request(f.messages)
  f.backend.close()
  f.backend.close()
  await failure(operation, 'AbortError')
  assert.deepEqual(await f.messages.next('worker close'), { type: 'close', generation })
  await failure(observe(f.backend.hasText()), 'AbortError')
  await failure(observe(f.backend.readText()), 'AbortError')
  await failure(observe(f.backend.writeText('after Stop')), 'AbortError')
  f.reply({
    generation,
    id: current.id,
    ok: false,
    error: { name: 'NotAllowedError', message: 'late platform rejection' },
  })
  assert.deepEqual(
    f.messages.seen.map((entry) => entry.type),
    ['request', 'close'],
  )
})

test('clipboard channel close clears UI ownership and cancels a worker waiting for a real clipboard result', async (t) => {
  const f = pairedFixture(t),
    operation = observe(f.backend.writeText('already requested')),
    current = await f.published.next()
  assert.ok(current)
  f.channel.close()
  f.channel.close()
  assert.equal(await f.published.next(), null)
  await failure(operation, 'AbortError')
  assert.equal(f.channel.respond(response(current, { op: 'write-text' })), false)
  assert.equal(
    f.channel.respond({
      generation,
      id: current.id,
      ok: false,
      error: { name: 'NotAllowedError', message: 'late real API failure' },
    }),
    false,
  )
  await failure(observe(f.backend.readText()), 'AbortError')
  assert.deepEqual(f.published.seen, [current, null])
})

test('worker Stop closes the main clipboard UI and prevents old responses from being sent', async (t) => {
  const f = pairedFixture(t),
    operation = observe(f.backend.hasText()),
    current = await f.published.next()
  assert.ok(current)
  f.backend.close()
  await failure(operation, 'AbortError')
  assert.equal(await f.published.next(), null)
  assert.equal(f.channel.respond(response(current, { op: 'has-text', hasText: true })), false)
  assert.deepEqual(f.published.seen, [current, null])
})

test('clipboard channel ignores unknown request identities and never replaces an already presented request', async (t) => {
  const f = channelFixture(t),
    first: ClipboardRequest = { generation, id: 1, op: 'read-text' }
  for (const id of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    f.post({ type: 'request', request: { ...first, id } })
  for (const data of [
    null,
    {},
    { type: 'request' },
    { type: 'request', request: { ...first, generation: generation + 1 } },
    { type: 'request', request: { ...first, generation: generation + 1, op: 'unknown' } },
  ])
    f.post(data)
  f.send(first)
  assert.deepEqual(await f.published.next(), first)
  f.send(first)
  f.send({ generation, id: 100, op: 'write-text', text: 'must not replace first' })
  f.post({ type: 'close', generation: generation + 1 })
  // Observe a later message on the same receiving port so all earlier busy
  // requests were actually delivered before retiring the first identity.
  await f.delivered()
  const busy = await f.messages.next('busy request rejection')
  assert.equal(busy.type, 'reply')
  if (busy.type !== 'reply' || busy.response.ok) assert.fail('Expected the new request to fail')
  assert.equal(busy.response.generation, generation)
  assert.equal(busy.response.id, 100)
  assert.equal(busy.response.error.name, 'InvalidStateError')
  assert.equal(
    f.channel.respond(response(first, { op: 'read-text', content: { hasText: false } })),
    true,
  )
  assert.equal(await f.published.next(), null)
  assert.deepEqual(await f.messages.next(), {
    type: 'reply',
    response: response(first, { op: 'read-text', content: { hasText: false } }),
  })
  const second: ClipboardRequest = { generation, id: 2, op: 'has-text' }
  f.send(second)
  assert.deepEqual(await f.published.next(), second)
  assert.deepEqual(f.published.seen, [first, null, second])
})

test('clipboard channel rejects old ids, wrong generations and operation mismatches without retiring current UI', async (t) => {
  const f = channelFixture(t),
    first: ClipboardRequest = { generation, id: 1, op: 'has-text' }
  f.send(first)
  assert.deepEqual(await f.published.next(), first)
  const accepted = response(first, { op: 'has-text', hasText: true })
  assert.equal(f.channel.respond(accepted), true)
  assert.equal(await f.published.next(), null)
  await f.messages.next()
  const current: ClipboardRequest = { generation, id: 2, op: 'read-text' }
  f.send(first)
  f.send(current)
  assert.deepEqual(await f.published.next(), current)
  for (const invalid of [
    accepted,
    {
      generation: generation + 1,
      id: current.id,
      ok: false,
      error: { name: 'Error', message: 'old' },
    },
    {
      generation,
      id: current.id + 1,
      ok: true,
      result: { op: 'read-text', content: { hasText: false } },
    },
    { generation, id: current.id, ok: true, result: { op: 'has-text', hasText: true } },
    null,
  ])
    assert.equal(f.channel.respond(invalid as ClipboardResponse), false)
  assert.deepEqual(f.published.seen, [first, null, current])
  const selected = response(current, { op: 'read-text', content: { hasText: true, text: '' } })
  assert.equal(f.channel.respond(selected), true)
  assert.equal(f.channel.respond(selected), false)
  assert.equal(await f.published.next(), null)
  assert.deepEqual(await f.messages.next(), { type: 'reply', response: selected })
  assert.deepEqual(f.published.seen, [first, null, current, null])
})

test('duplicate and late backend replies cannot settle a subsequent request or replace the first result', async (t) => {
  const f = backendFixture(t),
    first = observe(f.backend.readText()),
    current = await request(f.messages)
  f.reply(response(current, { op: 'read-text', content: { hasText: true, text: 'accepted' } }))
  assert.deepEqual(await value(first), { hasText: true, text: 'accepted' })
  const second = observe(f.backend.readText()),
    next = await request(f.messages)
  f.reply(response(current, { op: 'read-text', content: { hasText: true, text: 'duplicate' } }))
  f.reply({
    generation,
    id: current.id,
    ok: false,
    error: { name: 'NotAllowedError', message: 'late rejection' },
  })
  f.reply(response(next, { op: 'read-text', content: { hasText: false } }))
  assert.deepEqual(await value(second), { hasText: false })
  assert.deepEqual(await value(first), { hasText: true, text: 'accepted' })
})

// Only these fault cases use a synchronous port. Normal transport tests above
// use real MessageChannel delivery and structured cloning on the CI runner.
class FaultPort {
  readonly sent: ClipboardMessage[] = []
  private readonly listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>()
  starts = 0
  closes = 0
  posting?: (message: ClipboardMessage) => void
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(message: ClipboardMessage) {
    this.sent.push(message)
    this.posting?.(message)
  }
  start() {
    this.starts++
  }
  close() {
    this.closes++
  }
  receive(data: unknown) {
    this.emit(new MessageEvent('message', { data }))
  }
  messageError() {
    this.emit(new MessageEvent('messageerror'))
  }
  private emit(event: MessageEvent<unknown>) {
    // Deliberately synchronous delivery exposes publication/cleanup exceptions
    // to these fault tests. Real message delivery is covered above.
    const listeners = this.listeners.get(event.type)
    for (const listener of [...(listeners ?? [])]) if (listeners?.has(listener)) listener(event)
  }
  get port() {
    return this as unknown as MessagePort
  }
}

test('clipboard backend registers pending ownership before a synchronous post can deliver its reply', async (t) => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation)
  t.after(() => backend.close())
  port.posting = (message) => {
    if (message.type === 'request')
      port.receive({
        type: 'reply',
        response: response(message.request, { op: 'has-text', hasText: true }),
      })
  }
  assert.equal(await value(observe(backend.hasText())), true)
  assert.equal(port.starts, 1)
})

test('clipboard backend post failures reject their own request and release it for a later send', async (t) => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation),
    thrown = new DOMException('structured clone failed', 'DataCloneError')
  t.after(() => backend.close())
  port.posting = () => {
    throw thrown
  }
  const first = await bounded(observe(backend.readText()), 'throwing clipboard post')
  assert.deepEqual(first, { ok: false, error: thrown })
  port.posting = (message) => {
    if (message.type === 'request')
      port.receive({
        type: 'reply',
        response: response(message.request, { op: 'read-text', content: { hasText: false } }),
      })
  }
  assert.deepEqual(await value(observe(backend.readText())), { hasText: false })
})

test('synchronous post reply followed by a throw cannot replace an already accepted clipboard result', async (t) => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation)
  t.after(() => backend.close())
  port.posting = (message) => {
    if (message.type !== 'request') return
    port.receive({
      type: 'reply',
      response: response(message.request, { op: 'has-text', hasText: false }),
    })
    throw new Error('post threw after synchronous delivery')
  }
  assert.equal(await value(observe(backend.hasText())), false)
  assert.equal(await value(observe(backend.hasText())), false)
})

test('an old clipboard post failure cannot retire a synchronously opened replacement request', async (t) => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation)
  let next: Promise<Outcome<boolean>> | undefined, replacement: ClipboardRequest | undefined
  t.after(() => backend.close())
  port.posting = (message) => {
    if (message.type !== 'request') return
    if (message.request.id !== 1) {
      replacement = message.request
      return
    }
    port.receive({
      type: 'reply',
      response: response(message.request, { op: 'has-text', hasText: false }),
    })
    next = observe(backend.hasText())
    throw new Error('old send failed after its replacement entered')
  }
  assert.equal(await value(observe(backend.hasText())), false)
  assert.ok(next)
  assert.ok(replacement)
  await failure(observe(backend.readText()), 'InvalidStateError')
  port.receive({
    type: 'reply',
    response: response(replacement, { op: 'has-text', hasText: true }),
  })
  assert.equal(await value(next), true)
})

test('synchronous close during clipboard post revokes the request before a late reply or send failure', async (t) => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation)
  t.after(() => backend.close())
  port.posting = (message) => {
    if (message.type !== 'request') return
    backend.close()
    port.receive({
      type: 'reply',
      response: response(message.request, { op: 'has-text', hasText: true }),
    })
    throw new Error('late post failure after Stop')
  }
  await failure(observe(backend.hasText()), 'AbortError')
  assert.deepEqual(
    port.sent.map((message) => message.type),
    ['request', 'close'],
  )
  assert.equal(port.closes, 1)
})

test('clipboard close cleans up the worker even if posting its close message throws', async () => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation),
    operation = observe(backend.readText()),
    thrown = new Error('peer already unavailable')
  port.posting = (message) => {
    if (message.type === 'close') throw thrown
  }
  assert.throws(
    () => backend.close(),
    (error) => error === thrown,
  )
  backend.close()
  await failure(operation, 'AbortError')
  await failure(observe(backend.hasText()), 'AbortError')
  assert.equal(port.closes, 1)
})

test('clipboard channel registers the request before its presentation can synchronously answer', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'has-text' },
    reply = response(current, { op: 'has-text', hasText: false }),
    published: (ClipboardRequest | null)[] = []
  let channel!: ClipboardChannel, accepted: boolean | undefined
  channel = new ClipboardChannel(port.port, generation, (shown) => {
    published.push(shown)
    if (shown) accepted = channel.respond(reply)
  })
  try {
    port.receive({ type: 'request', request: current })
    assert.equal(accepted, true)
    assert.deepEqual(published, [current, null])
    assert.deepEqual(port.sent, [{ type: 'reply', response: reply }])
    assert.equal(channel.respond(reply), false)
  } finally {
    channel.close()
  }
})

test('clipboard channel retires UI identity before callbacks can resubmit the same result', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'write-text', text: 'copied' },
    reply = response(current, { op: 'write-text' }),
    published: (ClipboardRequest | null)[] = []
  let channel!: ClipboardChannel, duplicate: boolean | undefined
  channel = new ClipboardChannel(port.port, generation, (shown) => {
    published.push(shown)
    if (!shown) duplicate = channel.respond(reply)
  })
  try {
    port.receive({ type: 'request', request: current })
    assert.equal(channel.respond(reply), true)
    assert.equal(duplicate, false)
    assert.deepEqual(published, [current, null])
    assert.deepEqual(port.sent, [{ type: 'reply', response: reply }])
  } finally {
    channel.close()
  }
})

test('clipboard channel publication can synchronously close without reviving a request or sending its result', () => {
  for (const closeWhen of ['request', 'retirement'] as const) {
    const port = new FaultPort(),
      current: ClipboardRequest = { generation, id: 1, op: 'read-text' },
      reply = response(current, { op: 'read-text', content: { hasText: true, text: 'late' } }),
      published: (ClipboardRequest | null)[] = []
    let channel!: ClipboardChannel
    channel = new ClipboardChannel(port.port, generation, (shown) => {
      published.push(shown)
      if (closeWhen === 'request' ? !!shown : shown === null) channel.close()
    })
    try {
      port.receive({ type: 'request', request: current })
      channel.respond(reply)
      assert.equal(channel.respond(reply), false)
      assert.deepEqual(published, [current, null])
      assert.deepEqual(port.sent, [{ type: 'close', generation }])
      assert.equal(port.closes, 1)
    } finally {
      channel.close()
    }
  }
})

test('clipboard request publication failure sends a named failure after retiring its UI identity', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'has-text' },
    thrown = new Error('clipboard UI failed to mount'),
    published: (ClipboardRequest | null)[] = [],
    channel = new ClipboardChannel(port.port, generation, (shown) => {
      published.push(shown)
      if (shown) throw thrown
    })
  try {
    port.receive({ type: 'request', request: current })
    assert.deepEqual(published, [current, null])
    assert.deepEqual(port.sent, [
      {
        type: 'reply',
        response: {
          generation,
          id: current.id,
          ok: false,
          error: { name: 'Error', message: thrown.message },
        },
      },
    ])
    assert.equal(channel.respond(response(current, { op: 'has-text', hasText: true })), false)
  } finally {
    channel.close()
  }
})

test('clipboard publication errors cannot bypass the reply budget through oversized error fields', () => {
  const oversized = 'x'.repeat(clipboardTextLimit + 1)
  for (const field of ['name', 'message'] as const) {
    const port = new FaultPort(),
      current: ClipboardRequest = { generation, id: 1, op: 'read-text' },
      opening = new Error('clipboard presentation failed'),
      published: (ClipboardRequest | null)[] = []
    opening[field] = oversized
    const channel = new ClipboardChannel(port.port, generation, (shown) => {
      published.push(shown)
      if (shown) throw opening
    })
    try {
      port.receive({ type: 'request', request: current })
      assert.deepEqual(published, [current, null])
      assert.equal(port.sent.length, 1)
      const sent = port.sent[0]!
      assert.equal(sent.type, 'reply')
      if (sent.type !== 'reply' || sent.response.ok)
        assert.fail('The presentation failure must produce a bounded error reply')
      assert.equal(sent.response.generation, generation)
      assert.equal(sent.response.id, current.id)
      assert.ok(
        sent.response.error.name === 'QuotaExceededError',
        'The outgoing error must replace the oversized name or message with a quota failure',
      )
      assert.ok(sent.response.error.message.length < clipboardTextLimit)
      assert.equal(isClipboardResponse(sent.response), true)
      assert.equal(
        channel.respond(response(current, { op: 'read-text', content: { hasText: false } })),
        false,
      )
    } finally {
      channel.close()
    }
  }
})

test('clipboard response publication failure still forwards the real result once and reports the UI error', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'write-text', text: '' },
    reply = response(current, { op: 'write-text' }),
    thrown = new Error('clipboard UI failed to retire')
  let failRetirement = true
  const channel = new ClipboardChannel(port.port, generation, (shown) => {
    if (!shown && failRetirement) throw thrown
  })
  try {
    port.receive({ type: 'request', request: current })
    assert.throws(
      () => channel.respond(reply),
      (error) => error === thrown,
    )
    assert.equal(channel.respond(reply), false)
    assert.deepEqual(port.sent, [{ type: 'reply', response: reply }])
  } finally {
    failRetirement = false
    channel.close()
  }
})

test('clipboard reply post failure closes the channel and reports the original send error', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'write-text', text: 'already copied' },
    reply = response(current, { op: 'write-text' }),
    thrown = new DOMException('reply transfer failed', 'DataCloneError'),
    published: (ClipboardRequest | null)[] = [],
    channel = new ClipboardChannel(port.port, generation, (shown) => published.push(shown))
  port.receive({ type: 'request', request: current })
  port.posting = (message) => {
    if (message.type === 'reply') throw thrown
  }
  assert.throws(
    () => channel.respond(reply),
    (error) => error === thrown,
  )
  assert.equal(channel.respond(reply), false)
  port.receive({ type: 'request', request: { generation, id: 2, op: 'read-text' } })
  channel.close()
  assert.deepEqual(published, [current, null])
  assert.deepEqual(port.sent, [
    { type: 'reply', response: reply },
    { type: 'close', generation },
  ])
  assert.equal(port.closes, 1)
})

test('clipboard preserves reply and close send failures together while releasing the port exactly once', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'has-text' },
    reply = response(current, { op: 'has-text', hasText: true }),
    sending = new Error('reply send failed'),
    closing = new Error('close send failed'),
    channel = new ClipboardChannel(port.port, generation, () => {})
  port.receive({ type: 'request', request: current })
  port.posting = (message) => {
    if (message.type === 'reply') throw sending
    if (message.type === 'close') throw closing
  }
  assert.throws(
    () => channel.respond(reply),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [sending, closing])
      return true
    },
  )
  channel.close()
  assert.equal(channel.respond(reply), false)
  assert.equal(port.closes, 1)
})

test('clipboard preserves a request publication error in its reply when clearing the failed UI also throws', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'read-text' },
    opening = new Error('request UI could not mount'),
    clearing = new Error('request UI could not clear'),
    published: (ClipboardRequest | null)[] = []
  let failPresentation = true
  const channel = new ClipboardChannel(port.port, generation, (shown) => {
    published.push(shown)
    if (failPresentation) throw shown ? opening : clearing
  })
  try {
    assert.throws(
      () => port.receive({ type: 'request', request: current }),
      (error) => error === clearing,
    )
    assert.deepEqual(published, [current, null])
    assert.deepEqual(port.sent, [
      {
        type: 'reply',
        response: {
          generation,
          id: current.id,
          ok: false,
          error: { name: opening.name, message: opening.message },
        },
      },
    ])
    assert.equal(
      channel.respond(response(current, { op: 'read-text', content: { hasText: false } })),
      false,
    )
    failPresentation = false
    const next: ClipboardRequest = { generation, id: 2, op: 'has-text' }
    port.receive({ type: 'request', request: next })
    assert.deepEqual(published, [current, null, next])
    assert.equal(channel.respond(response(next, { op: 'has-text', hasText: true })), true)
  } finally {
    failPresentation = false
    channel.close()
  }
})

test('clipboard close still notifies the worker and releases its port when clearing the UI throws', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'has-text' },
    thrown = new Error('closing UI failed'),
    channel = new ClipboardChannel(port.port, generation, (shown) => {
      if (!shown) throw thrown
    })
  port.receive({ type: 'request', request: current })
  assert.throws(
    () => channel.close(),
    (error) => error === thrown,
  )
  assert.equal(channel.respond(response(current, { op: 'has-text', hasText: true })), false)
  channel.close()
  assert.deepEqual(port.sent, [{ type: 'close', generation }])
  assert.equal(port.closes, 1)
})

test('clipboard deserialization failure closes the worker and rejects pending work with DataError', async () => {
  const port = new FaultPort(),
    backend = new PortClipboardBackend(port.port, generation),
    operation = observe(backend.readText())
  port.messageError()
  await failure(operation, 'DataError')
  await failure(observe(backend.hasText()), 'AbortError')
  port.messageError()
  backend.close()
  assert.equal(port.closes, 1)
  assert.equal(port.sent.filter((message) => message.type === 'close').length, 1)
})

test('clipboard deserialization failure retires the main UI and sends a single close', () => {
  const port = new FaultPort(),
    current: ClipboardRequest = { generation, id: 1, op: 'has-text' },
    published: (ClipboardRequest | null)[] = [],
    channel = new ClipboardChannel(port.port, generation, (shown) => published.push(shown))
  port.receive({ type: 'request', request: current })
  port.messageError()
  port.messageError()
  channel.close()
  assert.deepEqual(published, [current, null])
  assert.deepEqual(port.sent, [{ type: 'close', generation }])
  assert.equal(port.closes, 1)
  assert.equal(channel.respond(response(current, { op: 'has-text', hasText: true })), false)
})

test('clipboard request serials stop at MAX_SAFE_INTEGER instead of rounding into reused identities', async (t) => {
  const f = backendFixture(t)
  // Boundary injection avoids trillions of sends and does not add a public
  // production option for reusing transport identities.
  assert.equal(Reflect.set(f.backend, 'next', Number.MAX_SAFE_INTEGER), true)
  const operation = observe(f.backend.hasText()),
    current = await request(f.messages)
  assert.equal(current.id, Number.MAX_SAFE_INTEGER)
  f.reply(response(current, { op: 'has-text', hasText: false }))
  assert.equal(await value(operation), false)
  await failure(observe(f.backend.hasText()), 'RangeError')
  await failure(observe(f.backend.readText()), 'RangeError')
  assert.equal(f.messages.seen.length, 1)
})

test('clipboard constructors reject unsafe generation identities before installing port listeners', () => {
  for (const invalid of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const worker = new FaultPort(),
      main = new FaultPort()
    assert.throws(() => new PortClipboardBackend(worker.port, invalid), RangeError)
    assert.throws(() => new ClipboardChannel(main.port, invalid, () => {}), RangeError)
    assert.equal(worker.starts, 0)
    assert.equal(main.starts, 0)
    assert.deepEqual(worker.sent, [])
    assert.deepEqual(main.sent, [])
  }
})

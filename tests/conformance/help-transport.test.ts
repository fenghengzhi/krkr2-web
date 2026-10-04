import nodeTest, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { PortHelpBackend } from '../../src/backends/help/port-backend.ts'
import { HelpChannel } from '../../src/player/help-channel.ts'
import { helpTextLimit, type HelpDocument } from '../../src/engine/ports/help.ts'
import { type HelpMessage, type HelpRequest, type HelpResponse } from '../../src/protocol/help.ts'

const generation = 29
const document: HelpDocument = {
  path: 'game://./Help/雪.txt',
  title: '雪.txt',
  text: 'First\r\n雪 🌸 <script>not markup</script>\nLast',
}
const test = (name: string, run: (context: TestContext) => void | Promise<void>) =>
  nodeTest(name, { timeout: 30000 }, run)

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Help transport did not settle')), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function mailbox<T>() {
  const queued: T[] = [],
    waiting: ((value: T) => void)[] = [],
    seen: T[] = []
  return {
    seen,
    push(value: T) {
      seen.push(value)
      const resolve = waiting.shift()
      if (resolve) resolve(value)
      else queued.push(value)
    },
    next(): Promise<T> {
      return queued.length
        ? Promise.resolve(queued.shift()!)
        : bounded(new Promise((resolve) => waiting.push(resolve)))
    },
  }
}
function incoming(port: MessagePort) {
  const messages = mailbox<HelpMessage>()
  port.addEventListener('message', ({ data }: MessageEvent<HelpMessage>) => messages.push(data))
  port.start()
  return messages
}
type Outcome = { ok: true; value: boolean } | { ok: false; error: unknown }
function observe(operation: Promise<boolean>): Promise<Outcome> {
  return operation.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )
}
async function rejected(operation: Promise<Outcome>, name: string): Promise<Error> {
  const result = await bounded(operation)
  if (result.ok) assert.fail('Expected the help operation to fail')
  assert.ok(result.error instanceof Error)
  assert.equal(result.error.name, name)
  return result.error
}
async function nextRequest(messages: ReturnType<typeof incoming>): Promise<HelpRequest> {
  const message = await messages.next()
  if (message.type !== 'request') assert.fail('Expected a help request')
  return message.request
}
async function nextReply(messages: ReturnType<typeof incoming>): Promise<HelpResponse> {
  const message = await messages.next()
  if (message.type !== 'reply') assert.fail('Expected a help reply')
  return message.response
}
function backendFixture(context: TestContext) {
  const ports = new MessageChannel(),
    backend = new PortHelpBackend(ports.port1, generation),
    messages = incoming(ports.port2)
  context.after(() => {
    backend.close()
    ports.port2.close()
  })
  return {
    backend,
    messages,
    post: (message: unknown) => ports.port2.postMessage(message),
    reply: (response: unknown) => ports.port2.postMessage({ type: 'reply', response }),
  }
}

test('real help ports acknowledge installed text while the document remains open, then replace and clear it', async (context) => {
  const ports = new MessageChannel(),
    history: (HelpDocument | null)[] = [],
    channel = new HelpChannel(ports.port2, generation, (value) => history.push(value)),
    backend = new PortHelpBackend(ports.port1, generation)
  context.after(() => {
    backend.close()
    channel.close()
  })
  assert.equal(await bounded(backend.show(document)), true)
  assert.deepEqual(history, [document])
  assert.notEqual(history[0], document, 'The host receives copied bounded fields')
  const next = { ...document, text: 'replacement' }
  assert.equal(await bounded(backend.show(next)), true)
  assert.deepEqual(history, [document, next])
  channel.close()
  assert.deepEqual(history, [document, next, null])
  await rejected(observe(backend.show(document)), 'AbortError')
})

test('a help channel without a presentation reports false through real MessagePorts', async (context) => {
  const ports = new MessageChannel(),
    channel = new HelpChannel(ports.port2, generation),
    backend = new PortHelpBackend(ports.port1, generation)
  context.after(() => {
    backend.close()
    channel.close()
  })
  assert.equal(await bounded(backend.show(document)), false)
})

test('failed help installation is rejected and cleared before a later request can succeed', async (context) => {
  const ports = new MessageChannel(),
    history: (HelpDocument | null)[] = []
  let fail = true
  const channel = new HelpChannel(ports.port2, generation, (value) => {
      history.push(value)
      if (value && fail) throw new DOMException('view did not mount', 'InvalidStateError')
    }),
    backend = new PortHelpBackend(ports.port1, generation)
  context.after(() => {
    backend.close()
    channel.close()
  })
  const error = await rejected(observe(backend.show(document)), 'InvalidStateError')
  assert.equal(error.message, 'view did not mount')
  assert.deepEqual(history, [document, null])
  fail = false
  assert.equal(await bounded(backend.show(document)), true)
  assert.deepEqual(history, [document, null, document])
})

test('recognizable malformed help documents settle with errors and cannot replay a corrected old identity', async (context) => {
  const ports = new MessageChannel(),
    messages = incoming(ports.port1),
    shown: (HelpDocument | null)[] = [],
    channel = new HelpChannel(ports.port2, generation, (value) => shown.push(value))
  context.after(() => {
    channel.close()
    ports.port1.close()
  })
  for (const [index, bad] of [
    null,
    { ...document, text: 4 },
    { ...document, text: 'x'.repeat(helpTextLimit + 1) },
    { ...document, path: '' },
    { ...document, title: 'x'.repeat(4097) },
  ].entries()) {
    const id = index + 1
    ports.port1.postMessage({ type: 'request', request: { generation, id, document: bad } })
    assert.deepEqual(await nextReply(messages), {
      generation, id, ok: false, error: { name: 'DataError', message: 'Invalid help document' },
    })
  }
  ports.port1.postMessage({ type: 'request', request: { generation, id: 1, document } })
  ports.port1.postMessage({ type: 'request', request: { generation, id: 6, document } })
  assert.deepEqual(await nextReply(messages), { generation, id: 6, ok: true, presented: true })
  assert.deepEqual(shown, [document])
})

test('foreign generations, repeated requests and stale close messages cannot alter the current help view', async (context) => {
  const ports = new MessageChannel(),
    messages = incoming(ports.port1),
    shown: (HelpDocument | null)[] = [],
    channel = new HelpChannel(ports.port2, generation, (value) => shown.push(value))
  context.after(() => {
    channel.close()
    ports.port1.close()
  })
  ports.port1.postMessage({ type: 'request', request: { generation: generation - 1, id: 10, document } })
  ports.port1.postMessage({ type: 'close', generation: generation - 1 })
  ports.port1.postMessage({ type: 'request', request: { generation, id: 1, document } })
  assert.equal((await nextReply(messages)).ok, true)
  ports.port1.postMessage({ type: 'request', request: { generation, id: 1, document: { ...document, text: 'stale' } } })
  ports.port1.postMessage({ type: 'request', request: { generation, id: 2, document: { ...document, text: 'current' } } })
  assert.deepEqual(await nextReply(messages), { generation, id: 2, ok: true, presented: true })
  assert.deepEqual(shown, [document, { ...document, text: 'current' }])
})

test('backend ignores foreign and stale responses, rejects malformed matching replies and remains usable', async (context) => {
  const f = backendFixture(context),
    first = observe(f.backend.show(document)),
    request = await nextRequest(f.messages)
  f.reply({ generation: generation + 1, id: request.id, ok: true, presented: true })
  f.reply({ generation, id: request.id + 1, ok: true, presented: true })
  f.reply({ generation, id: request.id, ok: true, presented: 'yes' })
  await rejected(first, 'DataError')
  const second = observe(f.backend.show(document)),
    replacement = await nextRequest(f.messages)
  f.reply({ generation, id: request.id, ok: true, presented: true })
  f.reply({ generation, id: replacement.id, ok: true, presented: false })
  assert.deepEqual(await bounded(second), { ok: true, value: false })
})

test('help backend permits only one unacknowledged presentation and rejects oversized input before posting', async (context) => {
  const f = backendFixture(context)
  await rejected(observe(f.backend.show({ ...document, text: 'x'.repeat(helpTextLimit + 1) })), 'DataError')
  const first = observe(f.backend.show(document)),
    request = await nextRequest(f.messages)
  await rejected(observe(f.backend.show(document)), 'InvalidStateError')
  assert.equal(f.messages.seen.length, 1)
  f.reply({ generation, id: request.id, ok: true, presented: true })
  assert.deepEqual(await bounded(first), { ok: true, value: true })
})

test('synchronous host closure during presentation rejects the real Worker-side waiter without success', async (context) => {
  const ports = new MessageChannel(),
    shown: (HelpDocument | null)[] = []
  let channel!: HelpChannel
  channel = new HelpChannel(ports.port2, generation, (value) => {
    shown.push(value)
    if (value) channel.close()
  })
  const backend = new PortHelpBackend(ports.port1, generation)
  context.after(() => {
    backend.close()
    channel.close()
  })
  await rejected(observe(backend.show(document)), 'AbortError')
  assert.deepEqual(shown, [document, null])
})

test('Stop suspension clears the visible help and rejects late installation only when cancellation closes the transport', async (context) => {
  const ports = new MessageChannel(),
    shown: (HelpDocument | null)[] = [],
    channel = new HelpChannel(ports.port2, generation, (value) => shown.push(value)),
    backend = new PortHelpBackend(ports.port1, generation)
  context.after(() => {
    backend.close()
    channel.close()
  })
  assert.equal(await bounded(backend.show(document)), true)
  channel.suspend()
  let settled = false
  const pending = observe(backend.show({ ...document, text: 'late' })).then((result) => {
    settled = true
    return result
  })
  const delivered = new Promise<void>((resolve) => {
    ports.port2.addEventListener('message', function barrier(event: MessageEvent<unknown>) {
      if (event.data !== 'help-stop-test-barrier') return
      ports.port2.removeEventListener('message', barrier)
      resolve()
    })
  })
  ports.port1.postMessage('help-stop-test-barrier')
  await bounded(delivered)
  assert.equal(settled, false, 'Delivery during Stop must not resume TJS before cancellation')
  assert.deepEqual(shown, [document, null])
  backend.close()
  await rejected(pending, 'AbortError')
  channel.close()
  assert.deepEqual(shown, [document, null])
})

// These fault cases model synchronous transport failures only. Normal delivery
// and structured cloning above use actual MessageChannel endpoints on CI.
class FaultPort {
  readonly sent: HelpMessage[] = []
  private readonly listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>()
  starts = 0
  closes = 0
  posting?: (message: HelpMessage) => void
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(message: HelpMessage) {
    this.sent.push(message)
    this.posting?.(message)
  }
  start() { this.starts++ }
  close() { this.closes++ }
  receive(data: unknown) { this.emit(new MessageEvent('message', { data })) }
  messageError() { this.emit(new MessageEvent('messageerror')) }
  private emit(event: MessageEvent<unknown>) {
    const listeners = this.listeners.get(event.type)
    for (const listener of [...(listeners ?? [])]) if (listeners?.has(listener)) listener(event)
  }
  get port() { return this as unknown as MessagePort }
}

test('an asynchronous help callback is rejected without falsely acknowledging queued presentation', async () => {
  const port = new FaultPort(),
    shown: (HelpDocument | null)[] = [],
    channel = new HelpChannel(port.port, generation, (value) => {
      shown.push(value)
      if (value) return Promise.reject(new Error('late callback failure'))
    })
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  assert.deepEqual(shown, [document, null])
  assert.deepEqual(port.sent, [{
    type: 'reply',
    response: {
      generation,
      id: 1,
      ok: false,
      error: { name: 'TypeError', message: 'Help presentation callback must complete synchronously' },
    },
  }])
  channel.close()
  await Promise.resolve()
})

test('a help callback that suspends then throws cannot settle script work ahead of Stop cancellation', () => {
  const port = new FaultPort(),
    shown: (HelpDocument | null)[] = []
  let channel!: HelpChannel
  channel = new HelpChannel(port.port, generation, (value) => {
    shown.push(value)
    if (value) {
      channel.suspend()
      throw new Error('presentation was interrupted by Stop')
    }
  })
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  assert.deepEqual(shown, [document, null])
  assert.deepEqual(port.sent, [])
  channel.close()
  assert.deepEqual(port.sent, [{ type: 'close', generation }])
  assert.equal(port.closes, 1)
})

test('help backend owns its waiter before a synchronous reply can arrive', async () => {
  const port = new FaultPort(), backend = new PortHelpBackend(port.port, generation)
  port.posting = (message) => {
    if (message.type === 'request')
      port.receive({ type: 'reply', response: { generation, id: message.request.id, ok: true, presented: true } })
  }
  try {
    assert.equal(await bounded(backend.show(document)), true)
  } finally {
    backend.close()
  }
})

test('failed help sends retire transport and preserve send and close failures together', async () => {
  const port = new FaultPort(),
    backend = new PortHelpBackend(port.port, generation),
    sending = new Error('send failed'),
    closing = new Error('close failed')
  port.posting = (message) => { throw message.type === 'request' ? sending : closing }
  const error = await rejected(observe(backend.show(document)), 'AggregateError')
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors, [sending, closing])
  assert.equal(port.closes, 1)
  backend.close()
  await rejected(observe(backend.show(document)), 'AbortError')
})

test('help reply failure clears the installed document and closes the host channel', () => {
  const port = new FaultPort(),
    shown: (HelpDocument | null)[] = [],
    errors: unknown[] = [],
    sending = new Error('reply failed'),
    channel = new HelpChannel(port.port, generation, (value) => shown.push(value), (error) => errors.push(error))
  port.posting = (message) => { if (message.type === 'reply') throw sending }
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  assert.deepEqual(shown, [document, null])
  assert.deepEqual(errors, [sending])
  assert.equal(port.closes, 1)
  port.receive({ type: 'request', request: { generation, id: 2, document } })
  channel.close()
  assert.deepEqual(shown, [document, null])
})

test('help deserialization failure rejects backend work and clears a previously presented host view', async () => {
  const worker = new FaultPort(),
    backend = new PortHelpBackend(worker.port, generation),
    pending = observe(backend.show(document))
  worker.messageError()
  await rejected(pending, 'DataError')
  backend.close()
  assert.equal(worker.closes, 1)
  const host = new FaultPort(),
    shown: (HelpDocument | null)[] = [],
    channel = new HelpChannel(host.port, generation, (value) => shown.push(value))
  host.receive({ type: 'request', request: { generation, id: 1, document } })
  host.messageError()
  channel.close()
  assert.deepEqual(shown, [document, null])
  assert.equal(host.closes, 1)
})

test('presentation and clearing errors both reach the help waiter in a bounded failure response', () => {
  const port = new FaultPort(),
    channel = new HelpChannel(port.port, generation, (value) => {
      throw new Error(value ? 'installation failed' : 'clear failed')
    })
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  assert.deepEqual(port.sent, [{
    type: 'reply',
    response: {
      generation, id: 1, ok: false,
      error: { name: 'Error', message: 'installation failed; clear failed' },
    },
  }])
  channel.close()
  assert.equal(port.closes, 1)
})

test('help publication errors are bounded and oversized matching error replies reject their own waiter', async (context) => {
  const port = new FaultPort(),
    oversized = new Error('x'.repeat(4097)),
    channel = new HelpChannel(port.port, generation, (value) => {
      if (value) throw oversized
    })
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  assert.deepEqual(port.sent, [{
    type: 'reply',
    response: {
      generation,
      id: 1,
      ok: false,
      error: { name: 'QuotaExceededError', message: 'Help error description exceeds its budget' },
    },
  }])
  channel.close()
  const f = backendFixture(context),
    pending = observe(f.backend.show(document)),
    request = await nextRequest(f.messages)
  f.reply({ generation, id: request.id, ok: false, error: { name: 'Error', message: oversized.message } })
  await rejected(pending, 'DataError')
})

test('help close clears presentation and releases the port while preserving independent cleanup failures', () => {
  const port = new FaultPort(),
    clearing = new Error('view could not clear'),
    sending = new Error('close could not send'),
    channel = new HelpChannel(port.port, generation, (value) => {
      if (!value) throw clearing
    })
  port.receive({ type: 'request', request: { generation, id: 1, document } })
  port.posting = (message) => {
    if (message.type === 'close') throw sending
  }
  assert.throws(() => channel.close(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [clearing, sending])
    return true
  })
  channel.close()
  assert.equal(port.closes, 1)
})

test('backend close rejects pending help and retains both close notification and local port errors', async () => {
  const port = new FaultPort(),
    backend = new PortHelpBackend(port.port, generation),
    pending = observe(backend.show(document)),
    sending = new Error('close notification failed'),
    closing = new Error('local port close failed')
  port.posting = (message) => {
    if (message.type === 'close') throw sending
  }
  port.close = () => {
    port.closes++
    throw closing
  }
  assert.throws(() => backend.close(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [sending, closing])
    return true
  })
  await rejected(pending, 'AbortError')
  backend.close()
  assert.equal(port.closes, 1)
  await rejected(observe(backend.show(document)), 'AbortError')
})

test('help identities reject unsafe generations before starting and stop before rounded serial reuse', async () => {
  for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const port = new FaultPort()
    assert.throws(() => new HelpChannel(port.port, bad), RangeError)
    assert.throws(() => new PortHelpBackend(port.port, bad), RangeError)
    assert.equal(port.starts, 0)
  }
  const port = new FaultPort(), backend = new PortHelpBackend(port.port, generation)
  assert.equal(Reflect.set(backend, 'next', Number.MAX_SAFE_INTEGER), true)
  port.posting = (message) => {
    if (message.type !== 'request') return
    assert.equal(message.request.id, Number.MAX_SAFE_INTEGER)
    port.receive({ type: 'reply', response: { generation, id: message.request.id, ok: true, presented: false } })
  }
  try {
    assert.equal(await bounded(backend.show(document)), false)
    await rejected(observe(backend.show(document)), 'RangeError')
    assert.equal(port.sent.length, 1)
  } finally {
    backend.close()
  }
})

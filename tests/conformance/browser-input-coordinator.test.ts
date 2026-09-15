import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserInputCoordinator } from '../../src/backends/input/coordinator.ts'
import type { InputPacket } from '../../src/engine/ports/input.ts'
import { WindowState } from '../../src/engine/scene/window.ts'

// This fixture exercises event observation and asynchronous scheduling, not browser
// layout or trusted pointer capture. Those remain covered by browser acceptance.
function dom() {
  const previous = ['window', 'document'].map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  )
  const page = new EventTarget(),
    textareas: Element[] = [],
    document = {
      activeElement: undefined as Element | undefined,
      createElement: () => {
        const element = new Element()
        textareas.push(element)
        return element
      },
    }
  class Element extends EventTarget {
    style: Record<string, string> = {}
    value = ''
    offsetLeft = 0
    offsetTop = 0
    clientWidth = 800
    clientHeight = 600
    removed = false
    captures = new Set<number>()
    parentElement = { append: (_element: Element) => {} }
    setAttribute(_name: string, _value: string): void {}
    focus(): void {
      if (document.activeElement === this) return
      const previous = document.activeElement
      document.activeElement = this
      previous?.dispatchEvent(new Event('blur'))
      this.dispatchEvent(new Event('focus'))
    }
    remove(): void {
      this.removed = true
      if (document.activeElement === this) document.activeElement = undefined
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }
    }
    hasPointerCapture(id: number): boolean {
      return this.captures.has(id)
    }
    setPointerCapture(id: number): void {
      this.captures.add(id)
    }
    releasePointerCapture(id: number): void {
      this.captures.delete(id)
    }
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: page },
    document: { configurable: true, value: document },
  })
  const dispatch = (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown> = {},
  ) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, properties)
    target.dispatchEvent(event)
    return event
  }
  return {
    canvas: () => new Element(),
    textareas,
    page,
    dispatch,
    key: (target: EventTarget, key: string, down = true) =>
      dispatch(target, down ? 'keydown' : 'keyup', {
        key,
        code: `Key${key.toUpperCase()}`,
        keyCode: key.toUpperCase().charCodeAt(0),
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        repeat: false,
        isComposing: false,
      }),
    mouse: (target: Element, type: string, buttons: number, x: number) => {
      const event = new Event(type, { cancelable: true })
      Object.assign(event, {
        buttons,
        button: 0,
        clientX: x,
        clientY: 10,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        detail: 1,
      })
      Object.defineProperty(event, 'target', { value: target })
      target.dispatchEvent(event)
      page.dispatchEvent(event)
    },
    restore: () => {
      for (const [index, name] of ['window', 'document'].entries()) {
        if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(send?: (packet: InputPacket) => Promise<void>) {
  const env = dom(),
    packets: InputPacket[] = [],
    keys: number[][] = [],
    pointers: [number, number, number][] = [],
    errors: unknown[] = [],
    coordinator = new BrowserInputCoordinator(
      async (packet) => {
        packets.push(packet)
        await send?.(packet)
      },
      async (state) => {
        keys.push(state)
      },
      (x, y, id) => {
        pointers.push([x, y, id])
      },
      (error) => errors.push(error),
    ),
    a = env.canvas(),
    b = env.canvas()
  coordinator.attach(101, 1, a as unknown as HTMLCanvasElement)
  coordinator.attach(202, 1, b as unknown as HTMLCanvasElement)
  return {
    ...env,
    coordinator,
    packets,
    keys,
    pointers,
    errors,
    a,
    b,
    close: () => {
      coordinator.close()
      env.restore()
    },
  }
}

test('all surfaces enqueue in DOM order while physical observations bypass a waiting callback', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'keyDown' && packet.windowId === 101) await waiting.promise
    })
  try {
    f.a.focus()
    await settle()
    f.key(f.textareas[0]!, 'a')
    f.b.focus()
    f.key(f.textareas[1]!, 'b')
    f.mouse(f.b, 'mousemove', 0, 11)
    f.mouse(f.b, 'mousemove', 0, 19)
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'activate'],
        [101, 'keyDown'],
      ],
    )
    assert.deepEqual(f.keys.at(-1), [65, 66])
    assert.deepEqual(f.pointers, [
      [11, 10, 202],
      [19, 10, 202],
    ])
    waiting.resolve()
    await settle()
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'activate'],
        [101, 'keyDown'],
        [101, 'deactivate'],
        [202, 'activate'],
        [202, 'keyDown'],
        [202, 'move'],
      ],
    )
    assert.equal((f.packets.at(-1) as { x: number }).x, 19)
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('detaching A preserves B physical keys and ignores A late failure and stale detach', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'keyDown' && packet.windowId === 101) await waiting.promise
    })
  try {
    f.a.focus()
    await settle()
    f.key(f.textareas[0]!, 'a')
    f.b.focus()
    f.key(f.textareas[1]!, 'b')
    const before = f.keys.length
    f.coordinator.detach(101, 1)
    assert.equal(f.textareas[0]!.removed, true)
    assert.equal(f.keys.length, before)
    assert.deepEqual(f.keys.at(-1), [65, 66])
    const replacement = f.canvas()
    f.coordinator.attach(101, 2, replacement as unknown as HTMLCanvasElement)
    f.coordinator.detach(101, 1)
    assert.equal(f.textareas[2]!.removed, false)
    waiting.reject(new Error('Old surface failed after removal'))
    await settle()
    assert.deepEqual(f.errors, [])
    assert.deepEqual(
      f.packets.slice(-2).map((packet) => [packet.windowId, packet.type]),
      [
        [202, 'activate'],
        [202, 'keyDown'],
      ],
    )
    f.key(f.page, 'a', false)
    assert.deepEqual(f.keys.at(-1), [66])
    f.key(f.page, 'b', false)
    assert.deepEqual(f.keys.at(-1), [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('mouse capture crosses another canvas without duplicate routing and IME follows active window', async () => {
  const f = fixture()
  try {
    f.mouse(f.a, 'mousedown', 1, 5)
    f.mouse(f.b, 'mousemove', 1, 15)
    f.mouse(f.b, 'mouseup', 0, 25)
    await settle()
    assert.deepEqual(
      f.packets
        .filter((packet) => ['down', 'move', 'up'].includes(packet.type))
        .map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'down'],
        [101, 'move'],
        [101, 'up'],
      ],
    )
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.b.focus()
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'old' })
    f.dispatch(f.textareas[1]!, 'compositionstart')
    f.dispatch(f.textareas[1]!, 'compositionend', { data: 'new' })
    f.key(f.textareas[0]!, 'x')
    f.key(f.textareas[1]!, 'y')
    await settle()
    assert.deepEqual(
      f.packets
        .filter((packet) => packet.type === 'text')
        .map((packet) => [packet.windowId, packet.text]),
      [[202, 'new']],
    )
    assert.deepEqual(
      f.packets
        .filter((packet) => packet.type === 'keyDown')
        .map((packet) => [packet.windowId, packet.key]),
      [[202, 89]],
    )
  } finally {
    f.close()
  }
})

test('pause discards old queued input without losing resumed surface activation', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'keyDown' && packet.windowId === 101) await waiting.promise
    })
  try {
    f.a.focus()
    await settle()
    f.key(f.textareas[0]!, 'a')
    f.b.focus()
    f.key(f.textareas[1]!, 'b')
    f.coordinator.setSuspended(true)
    assert.deepEqual(f.keys.at(-1), [])
    f.key(f.textareas[1]!, 'c')
    f.coordinator.setSuspended(false)
    f.key(f.textareas[1]!, 'd')
    waiting.reject(new Error('Paused operation failed'))
    await settle()
    assert.deepEqual(f.errors, [])
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type, 'key' in packet ? packet.key : 0]),
      [
        [101, 'activate', 0],
        [101, 'keyDown', 65],
        [202, 'activate', 0],
        [202, 'keyDown', 68],
      ],
    )
    assert.deepEqual(f.keys.at(-1), [68])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('hidden surfaces stop input and use the latest per-window layout on reattachment', async () => {
  const f = fixture()
  try {
    const a = new WindowState(),
      b = new WindowState()
    a.resize(400, 300)
    b.resize(1600, 1200)
    a.visible = b.visible = true
    f.coordinator.setWindow(101, a.view())
    f.coordinator.setWindow(202, b.view())
    f.mouse(f.a, 'mousemove', 0, 100)
    f.mouse(f.b, 'mousemove', 0, 100)
    assert.deepEqual(f.pointers, [
      [50, 5, 101],
      [200, 20, 202],
    ])
    a.visible = false
    f.coordinator.setWindow(101, a.view())
    f.mouse(f.a, 'mousedown', 1, 100)
    f.mouse(f.a, 'mousemove', 1, 100)
    assert.equal(f.pointers.length, 2)
    const replacement = f.canvas()
    f.coordinator.attach(202, 2, replacement as unknown as HTMLCanvasElement)
    f.coordinator.attach(202, 1, f.b as unknown as HTMLCanvasElement)
    f.mouse(replacement, 'mousemove', 0, 100)
    assert.deepEqual(f.pointers.at(-1), [200, 20, 202])
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('physical releases outside surviving canvases still clear keys after their owner closes', async () => {
  const f = fixture()
  try {
    f.mouse(f.a, 'mousedown', 1, 10)
    f.key(f.textareas[0]!, 'a')
    assert.deepEqual(f.keys.at(-1), [1, 65])
    f.coordinator.detach(101, 1)
    f.dispatch(f.page, 'mouseup', { buttons: 0 })
    assert.deepEqual(f.keys.at(-1), [65])
    f.key(f.page, 'a', false)
    assert.deepEqual(f.keys.at(-1), [])
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('host focus is idempotent during capture and composition and switches windows exactly once', async () => {
  const f = fixture()
  try {
    f.dispatch(f.a, 'pointerdown', { pointerType: 'mouse', pointerId: 7 })
    f.mouse(f.a, 'mousedown', 1, 10)
    f.key(f.textareas[0]!, 'a')
    f.dispatch(f.textareas[0]!, 'compositionstart')
    assert.equal(f.coordinator.focus(101, 1), true)
    assert.equal(f.coordinator.focus(101), true)
    assert.equal(f.a.captures.has(7), true)
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'same-window' })
    f.mouse(f.b, 'mousemove', 1, 20)
    assert.equal(f.coordinator.focus(202, 1), true)
    assert.equal(f.coordinator.focus(202), true)
    assert.equal(f.a.captures.has(7), false)
    assert.deepEqual(f.keys.at(-1), [1, 65])
    await settle()
    assert.deepEqual(
      f.packets
        .filter((packet) => packet.type === 'activate' || packet.type === 'deactivate')
        .map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'activate'],
        [101, 'deactivate'],
        [202, 'activate'],
      ],
    )
    assert.deepEqual(
      f.packets.filter((packet) => packet.type === 'text').map((packet) => packet.text),
      ['same-window'],
    )
    assert.equal(f.packets.find((packet) => packet.type === 'move')?.windowId, 101)
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('host focus rejects hidden, nonfocusable, paused, stale and removed surfaces', async () => {
  const f = fixture()
  try {
    assert.equal(f.coordinator.focus(101, 1), true)
    const b = new WindowState()
    f.coordinator.setWindow(202, b.view())
    assert.equal(f.coordinator.focus(202, 1), false)
    b.visible = true
    b.focusable = false
    f.coordinator.setWindow(202, b.view())
    assert.equal(f.coordinator.focus(202), false)
    b.focusable = true
    f.coordinator.setWindow(202, b.view())
    assert.equal(f.coordinator.focus(202, 2), false)
    assert.equal(document.activeElement, f.textareas[0])
    f.coordinator.setSuspended(true)
    assert.equal(f.coordinator.focus(202, 1), false)
    f.coordinator.setSuspended(false)
    assert.equal(f.coordinator.focus(202, 1), true)
    f.coordinator.detach(202, 1)
    assert.equal(f.coordinator.focus(202, 1), false)
    assert.equal(f.coordinator.focus(999), false)
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

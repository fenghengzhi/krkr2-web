import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserInputCoordinator } from '../../src/backends/input/coordinator.ts'
import type { InputPacket, InputView } from '../../src/engine/ports/input.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { BrowserGamepadSource } from '../../src/backends/input/gamepad-browser.ts'
import { gamepadSource } from '../helpers/gamepad-source.ts'
import type { MouseKeyClock } from '../../src/engine/input/mouse-key.ts'

// This fixture exercises event observation and asynchronous scheduling, not browser
// layout or trusted pointer capture. Those remain covered by browser acceptance.
function dom() {
  const previous = ['window', 'document'].map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  )
  const page = new EventTarget(),
    textareas: Element[] = [],
    document = Object.assign(new EventTarget(), {
      activeElement: undefined as Element | undefined,
      createElement: () => {
        const element = new Element()
        textareas.push(element)
        return element
      },
    })
  class Element extends EventTarget {
    style: Record<string, string> = {}
    value = ''
    inputMode = ''
    offsetLeft = 0
    offsetTop = 0
    clientWidth = 800
    clientHeight = 600
    removed = false
    captures = new Set<number>()
    children: Element[] = []
    parentElement?: Element
    append(...elements: Element[]): void {
      for (const element of elements) {
        this.children.push(element)
        element.parentElement = this
      }
    }
    contains(target: unknown): boolean {
      return this === target || this.children.some((child) => child.contains(target))
    }
    setAttribute(_name: string, _value: string): void {}
    focus(): void {
      if (document.activeElement === this) return
      const previous = document.activeElement
      document.activeElement = this
      const blur = new Event('blur')
      Object.assign(blur, { relatedTarget: this })
      previous?.dispatchEvent(blur)
      this.dispatchEvent(new Event('focus'))
      if (document.activeElement === this) {
        const focus = new Event('focusin')
        Object.defineProperty(focus, 'target', { value: this })
        document.dispatchEvent(focus)
      }
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
    document,
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

function inputView(overrides: Partial<InputView> = {}): InputView {
  return {
    cursor: 0,
    hint: '',
    focused: 11,
    attentionX: 0,
    attentionY: 0,
    attention: null,
    imeMode: 1,
    keyboardRoute: { windowId: 101, revision: 10, focused: 11, imeMode: 1 },
    ...overrides,
  }
}

function fixture(
  send?: (packet: InputPacket) => Promise<void>,
  scope = false,
  transient?: (target: EventTarget | null) => boolean,
  gamepad: BrowserGamepadSource | false = false,
  mouseKeyClock?: MouseKeyClock,
) {
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
      { isTransientFocus: transient, gamepad, mouseKeyClock },
    ),
    a = env.canvas(),
    b = env.canvas(),
    rootA = env.canvas(),
    rootB = env.canvas()
  rootA.append(a)
  rootB.append(b)
  coordinator.attach(
    101,
    1,
    a as unknown as HTMLCanvasElement,
    scope ? (rootA as unknown as HTMLElement) : undefined,
  )
  coordinator.attach(
    202,
    1,
    b as unknown as HTMLCanvasElement,
    scope ? (rootB as unknown as HTMLElement) : undefined,
  )
  return {
    ...env,
    coordinator,
    packets,
    keys,
    pointers,
    errors,
    a,
    b,
    rootA,
    rootB,
    close: () => {
      coordinator.close()
      env.restore()
    },
  }
}

test('mouse-key observations follow the actual trap-key receiver while real key packets retain their original route', async () => {
  const f = fixture()
  try {
    const a = new WindowState(), b = new WindowState()
    a.visible = b.visible = true
    b.useMouseKey = true
    b.width = 400
    b.height = 300
    f.coordinator.setWindow(101, a.view())
    f.coordinator.setWindow(202, b.view())
    f.coordinator.setInput(101, inputView({ keyboardRoute: {
      windowId: 202, revision: 10, inputRevision: 20, focused: 11, imeMode: 1,
    } }))
    f.a.focus()
    f.mouse(f.a, 'mousedown', 1, 80)
    await settle()
    f.key(f.textareas[0]!, 'a')
    await settle()
    const packet = f.packets.at(-1)!
    assert.equal(packet.type, 'keyDown')
    assert.equal(packet.windowId, 101)
    assert.equal(packet.keyboardInputRevision, 20)
    assert(packet.mouseKeyObservation)
    assert.deepEqual({ ...packet.mouseKeyObservation, pointerSequence: 0 }, {
      windowId: 202, x: 40, y: 5, scaleX: 0.5, scaleY: 0.5, pointerSequence: 0,
    })
    assert(packet.mouseKeyObservation.pointerSequence > 0)
    assert(f.keys.at(-1)!.includes(65), 'The browser observes the real key; only engine admission may consume it')
    assert(f.pointers.some(([x, y, id]) => id === 202 && x === 40 && y === 5))
  } finally { f.close() }
})

test('mouse-key ticks stop for menus, hidden windows, replacement and late suspended RAF callbacks', async () => {
  let transient: EventTarget | null = null
  const clock = gamepadSource(), f = fixture(undefined, false, (target) => target === transient, false, clock.source),
    menu = f.canvas(), view = new WindowState()
  transient = menu
  try {
    view.visible = true
    view.useMouseKey = true
    f.coordinator.setWindow(101, view.view())
    f.coordinator.setInput(101, inputView())
    f.a.focus()
    await settle()
    clock.tick(50)
    await settle()
    assert.equal(f.packets.at(-1)!.type, 'mouseKeyTick')
    const stale = clock.captured(), count = f.packets.length
    menu.focus()
    assert.equal(clock.pending, 0)
    for (const callback of stale) callback()
    await settle()
    assert.equal(f.packets.length, count)
    f.a.focus()
    clock.tick(100)
    await settle()
    assert.equal(f.packets.at(-1)!.type, 'mouseKeyTick')
    f.coordinator.setSuspended(true)
    assert.equal(clock.pending, 0)
    for (const callback of stale) callback()
    assert.equal(clock.pending, 0)
    f.coordinator.setSuspended(false)
    f.a.focus()
    view.visible = false
    f.coordinator.setWindow(101, view.view())
    assert.equal(clock.pending, 0)
    view.visible = true
    f.coordinator.setWindow(101, view.view())
    f.a.focus()
    f.coordinator.detach(101, 1)
    assert.equal(clock.pending, 0)
    for (const callback of stale) callback()
    assert.equal(clock.pending, 0)
    assert.deepEqual([...f.errors], [])
  } finally { f.close() }
})

test('mouse-key ticks freeze the previous Pad state before polling even behind an in-flight admission ACK', async () => {
  const clock = gamepadSource(), gate = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'keyDown' && packet.key === 65) await gate.promise
    }, false, undefined, clock.source)
  try {
    const view = new WindowState()
    view.visible = true
    view.useMouseKey = true
    clock.pad()
    f.coordinator.setWindow(101, view.view())
    f.coordinator.setInput(101, inputView())
    f.a.focus()
    await settle()
    f.key(f.textareas[0]!, 'a')
    await settle()
    clock.pad([15])
    clock.tick(50)
    clock.pad()
    clock.tick(100)
    assert.deepEqual(f.keys.at(-1), [65], 'The independent physical state has already observed Pad release')
    gate.resolve()
    await settle()
    const ordered = f.packets.filter((packet) => packet.type === 'mouseKeyTick' ||
      ((packet.type === 'keyDown' || packet.type === 'keyUp') && packet.key === 0x1b7))
    assert.deepEqual(ordered.slice(-4).map((packet) => packet.type), ['mouseKeyTick', 'keyDown', 'mouseKeyTick', 'keyUp'])
    assert.deepEqual(ordered.at(-4)!.mouseKeyKeys, [65])
    assert.deepEqual(ordered.at(-2)!.mouseKeyKeys, [65, 0x1b7],
      'The queued mouse tick retains the pre-poll held Pad, without rewriting physical key state')
    assert.deepEqual([...f.errors], [])
  } finally { gate.resolve(); f.close() }
})

test('gamepad shares the ordered Window queue while released physical keys bypass a blocked callback', async () => {
  const clock = gamepadSource(), waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'keyDown' && packet.key === 0x1c0) await waiting.promise
    }, false, undefined, clock.source)
  try {
    clock.pad()
    f.coordinator.setInput(101, inputView({ keyboardRoute: { windowId: 101, revision: 10, inputRevision: 20, focused: 11, imeMode: 1 } }))
    f.a.focus()
    await settle()
    f.key(f.textareas[0]!, 'a')
    await settle()
    clock.pad([0])
    clock.tick(50)
    assert.deepEqual(f.keys.at(-1), [65, 0x1c0])
    assert.deepEqual(f.packets.at(-1), { type: 'keyDown', key: 0x1c0, shift: 0,
      windowId: 101, keyboardRouteRevision: 10, keyboardInputRevision: 20 })
    clock.pad()
    clock.tick(100)
    assert.deepEqual(f.keys.at(-1), [65])
    assert.equal(f.packets.filter((packet) => packet.type === 'keyUp' && packet.key === 0x1c0).length, 0)
    waiting.resolve()
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'keyUp' && packet.key === 0x1c0).length, 1)
    assert(!f.packets.some((packet) => (packet.type === 'keyDown' || packet.type === 'keyUp') && packet.key === 0x1df))
    assert.deepEqual(f.errors, [])
  } finally { waiting.resolve(); await settle(); f.close() }
})

test('gamepad focus handoff releases the old Window and requires a fresh press on the new Window', async () => {
  const clock = gamepadSource(), f = fixture(undefined, false, undefined, clock.source)
  try {
    clock.pad()
    f.a.focus()
    await settle()
    clock.pad([1])
    clock.tick(50)
    await settle()
    f.b.focus()
    await settle()
    clock.tick(100)
    await settle()
    const events = () => f.packets.flatMap((packet) => packet.type === 'keyDown' || packet.type === 'keyUp'
      ? [[packet.type, packet.windowId, packet.key]] : [])
    assert.deepEqual(events(), [['keyDown', 101, 0x1c1], ['keyUp', 101, 0x1c1]])
    assert.deepEqual(f.keys.at(-1), [])
    clock.pad()
    clock.tick(150)
    clock.pad([1])
    clock.tick(200)
    await settle()
    assert.deepEqual(events().at(-1), ['keyDown', 202, 0x1c1])
    clock.disconnect()
    clock.tick(250)
    await settle()
    assert.deepEqual(events().at(-1), ['keyUp', 202, 0x1c1])
    assert.deepEqual(f.keys.at(-1), [])
    assert.deepEqual(f.errors, [])
  } finally { f.close() }
})

test('transient menu focus suspends gamepad admission without deactivating the game Window', async () => {
  const clock = gamepadSource()
  let menu: EventTarget | undefined
  const f = fixture(undefined, true, (target) => target === menu, clock.source)
  try {
    clock.pad()
    f.a.focus()
    await settle()
    clock.pad([0])
    clock.tick(50)
    await settle()
    const control = f.canvas()
    menu = control
    control.focus()
    await settle()
    assert.equal(f.coordinator.isActive(101), true)
    assert.deepEqual(f.keys.at(-1), [])
    assert(!f.packets.some((packet) => packet.type === 'deactivate'))
    f.a.focus()
    clock.tick(100)
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'keyDown').length, 1)
    clock.pad()
    clock.tick(150)
    clock.pad([0])
    clock.tick(200)
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'keyDown').length, 2)
    assert.deepEqual(f.errors, [])
  } finally { f.close() }
})

test('gamepad settings, modal exclusion and close clear physical state without reviving a retired surface', async () => {
  const clock = gamepadSource(), f = fixture(undefined, false, undefined, clock.source)
  try {
    clock.pad()
    f.coordinator.setInput(101, inputView({ gamepad: { enabled: true, delay: 0, interval: 50 } }))
    f.a.focus()
    await settle()
    clock.pad([0])
    clock.tick(50)
    clock.tick(100)
    await settle()
    assert(f.packets.some((packet) => packet.type === 'keyDown' && packet.key === 0x1c0 && (packet.shift & 128)))
    f.coordinator.setInput(101, inputView({ gamepad: { enabled: false, delay: 0, interval: 50 } }))
    await settle()
    assert.deepEqual(f.keys.at(-1), [])
    const count = f.packets.length
    clock.tick(150)
    await settle()
    assert.equal(f.packets.length, count)
    f.coordinator.setInput(101, inputView({ gamepad: { enabled: true, delay: 0, interval: 50 } }))
    clock.pad()
    clock.tick(200)
    clock.pad([0])
    clock.tick(250)
    await settle()
    f.coordinator.setWindow(101, { ...new WindowState(), visible: true, blocked: true })
    assert.deepEqual(f.keys.at(-1), [])
    assert.equal(f.coordinator.focus(101), false)
    const stale = clock.captured()
    f.coordinator.close()
    const afterClose = f.packets.length
    for (const callback of stale) callback()
    clock.tick(300)
    await settle()
    assert.equal(f.packets.length, afterClose)
    assert.equal(clock.pending, 0)
    assert.deepEqual(f.errors, [])
  } finally { f.close() }
})

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
      f.packets.flatMap((packet) =>
        packet.type === 'keyDown' ? [[packet.windowId, packet.key]] : [],
      ),
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

test('shortcut activity follows DOM focus immediately while the first Worker activation is pending', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.type === 'activate' && packet.windowId === 101) await waiting.promise
    })
  try {
    assert.equal(f.coordinator.isActive(101), false)
    f.coordinator.focus(101, 1)
    assert.equal(f.coordinator.isActive(101, 1), true)
    assert.equal(f.coordinator.isActive(101, 2), false)
    f.coordinator.focus(202, 1)
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.isActive(202, 1), true)
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type]),
      [[101, 'activate']],
    )
    f.coordinator.setSuspended(true)
    assert.equal(f.coordinator.isActive(202), false)
    f.coordinator.setSuspended(false)
    assert.equal(f.coordinator.isActive(202), true)
    const b = new WindowState()
    f.coordinator.setWindow(202, b.view())
    assert.equal(f.coordinator.isActive(202), false)
    b.visible = true
    f.coordinator.setWindow(202, b.view())
    assert.equal(f.coordinator.isActive(202), true)
    f.coordinator.detach(202, 1)
    assert.equal(f.coordinator.isActive(202), false)
    waiting.resolve()
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('menus share their Window focus while transient popup focus preserves the prior Window', async () => {
  const transient = new Set<EventTarget>(),
    f = fixture(undefined, true, (target) => !!target && transient.has(target)),
    menuA = f.canvas(),
    menuB = f.canvas(),
    popup = f.canvas(),
    consoleInput = f.canvas()
  f.rootA.append(menuA)
  f.rootB.append(menuB)
  transient.add(popup)
  try {
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'a')
    menuA.focus()
    assert.equal(f.coordinator.isActive(101), true)
    assert.equal(f.coordinator.focus(101), true)
    assert.equal(f.document.activeElement, menuA, 'host activation must not steal menu focus')
    menuB.focus()
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.isActive(202), true)
    assert.equal(f.coordinator.focus(202), true)
    assert.equal(f.document.activeElement, menuB)
    popup.focus()
    assert.equal(
      f.coordinator.isActive(202),
      true,
      'popup ownership does not activate another Window',
    )
    assert.equal(f.coordinator.isActive(101), false)
    consoleInput.focus()
    assert.equal(f.coordinator.isActive(202), false)
    popup.focus()
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.isActive(202), false, 'a popup cannot invent previous Window focus')
    // A's textarea lost focus before B activated through its menu. Returning to
    // A must not be swallowed by BrowserInput's private active guard.
    assert.equal(f.coordinator.focus(101), true)
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.deepEqual(f.keys.at(-1), [65])
    await settle()
    assert.deepEqual(
      f.packets
        .filter((packet) => packet.type === 'activate' || packet.type === 'deactivate')
        .map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'activate'],
        [101, 'deactivate'],
        [202, 'activate'],
        [202, 'deactivate'],
        [101, 'activate'],
      ],
    )
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('same-window menu focus releases pointer capture without Window deactivation', async () => {
  const f = fixture(undefined, true),
    menu = f.canvas()
  f.rootA.append(menu)
  try {
    f.dispatch(f.a, 'pointerdown', { pointerType: 'mouse', pointerId: 7 })
    f.mouse(f.a, 'mousedown', 1, 10)
    menu.focus()
    assert.equal(f.a.captures.has(7), false)
    assert.equal(f.coordinator.isActive(101), true)
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'deactivate').length, 0)
    assert.equal(
      f.packets.filter((packet) => packet.type === 'cancel' && packet.windowId === 101).length,
      1,
    )
    assert.deepEqual(f.keys.at(-1), [1])
    f.dispatch(f.page, 'mouseup', { buttons: 0 })
    assert.deepEqual(f.keys.at(-1), [])
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('focus revision observes external controls during pending input and suspension', async () => {
  const waiting = deferred(),
    f = fixture(async () => waiting.promise),
    consoleInput = f.canvas()
  try {
    const initial = f.coordinator.focusRevision
    f.coordinator.focus(101)
    const game = f.coordinator.focusRevision
    assert.ok(game > initial)
    f.coordinator.focus(101)
    assert.equal(f.coordinator.focusRevision, game)
    consoleInput.focus()
    const external = f.coordinator.focusRevision
    assert.ok(external > game)
    assert.equal(f.coordinator.isActive(101), false)
    f.coordinator.setSuspended(true)
    f.a.focus()
    assert.ok(f.coordinator.focusRevision > external)
    const suspended = f.coordinator.focusRevision
    f.dispatch(f.page, 'blur')
    assert.ok(f.coordinator.focusRevision > suspended)
    f.coordinator.close()
    const closed = f.coordinator.focusRevision
    consoleInput.focus()
    assert.equal(f.coordinator.focusRevision, closed)
    waiting.resolve()
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('modal blocking is host presentation state and does not become a script Window property', () => {
  const state = new WindowState(),
    view = { ...state.view(), blocked: true }
  assert.equal(view.blocked, true)
  assert.equal(state.view().visible, false)
  assert.equal(state.view().focusable, true)
  assert.equal('blocked' in state.view(), false)
  assert.throws(() => state.set('blocked', 1), /Unsupported Window property: blocked/)
})

test('blocked surfaces reject focus, pointer, touch, keyboard and text while retaining script visibility', async () => {
  const f = fixture(),
    view = { ...new WindowState().view(), visible: true, blocked: true }
  try {
    f.coordinator.setWindow(101, view)
    assert.equal(view.visible, true)
    assert.equal(view.focusable, true)
    assert.equal(f.coordinator.focus(101), false)
    f.a.focus()
    f.dispatch(f.a, 'pointerdown', { pointerType: 'mouse', pointerId: 7 })
    f.dispatch(f.a, 'pointerdown', {
      pointerType: 'touch',
      pointerId: 8,
      clientX: 10,
      clientY: 10,
      width: 1,
      height: 1,
    })
    f.mouse(f.a, 'mousedown', 1, 10)
    f.mouse(f.a, 'mousemove', 1, 20)
    f.key(f.a, 'a')
    f.textareas[0]!.value = 'blocked text'
    f.dispatch(f.textareas[0]!, 'input')
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.a.captures.size, 0)
    assert.equal(f.textareas[0]!.value, '')
    assert.deepEqual(f.keys, [])
    assert.deepEqual(f.pointers, [])
    await settle()
    assert.equal(f.packets.length, 0)
    assert.equal(f.coordinator.focus(202), true)
    await settle()
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type]),
      [[202, 'activate']],
    )
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('blocking cancels captured input and composition and removes queued packets behind an admitted callback', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.windowId === 101 && packet.type === 'activate') await waiting.promise
    }),
    view = { ...new WindowState().view(), visible: true, blocked: true }
  try {
    f.dispatch(f.a, 'pointerdown', { pointerType: 'mouse', pointerId: 7 })
    f.mouse(f.a, 'mousedown', 1, 10)
    f.key(f.textareas[0]!, 'a')
    f.dispatch(f.textareas[0]!, 'compositionstart')
    assert.equal(f.a.captures.has(7), true)
    assert.deepEqual(f.keys.at(-1), [1, 65])
    f.coordinator.setWindow(101, view)
    assert.equal(f.a.captures.size, 0)
    assert.equal(f.coordinator.isActive(101), false)
    assert.deepEqual(f.keys.at(-1), [])
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'discarded' })
    f.coordinator.focus(202)
    waiting.resolve()
    await settle()
    assert.deepEqual(
      f.packets.map((packet) => [packet.windowId, packet.type]),
      [
        [101, 'activate'],
        [202, 'activate'],
      ],
    )
    f.coordinator.setWindow(101, { ...view, blocked: false })
    f.coordinator.focus(101)
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'stale composition' })
    await settle()
    assert.equal(
      f.packets.some((packet) => packet.type === 'text'),
      false,
    )
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('blocking releases physical keys after DOM blur without clearing another Window keys', async () => {
  const f = fixture()
  try {
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'a')
    f.coordinator.focus(202)
    f.key(f.textareas[1]!, 'b')
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.isActive(202), true)
    assert.deepEqual(f.keys.at(-1), [65, 66])
    f.coordinator.setWindow(101, {
      ...new WindowState().view(),
      visible: true,
      blocked: true,
    })
    assert.deepEqual(f.keys.at(-1), [66])
    assert.equal(f.coordinator.isActive(202), true)
    f.key(f.page, 'b', false)
    assert.deepEqual(f.keys.at(-1), [])
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('modal transitions invalidate pending focus even before canvas attachment and after view reuse', async () => {
  const f = fixture(),
    view = { ...new WindowState().view(), visible: true, blocked: true },
    canvas = f.canvas()
  try {
    const before = f.coordinator.focusRevision
    f.coordinator.setWindow(303, view)
    assert.ok(f.coordinator.focusRevision > before)
    const blocked = f.coordinator.focusRevision
    f.coordinator.setWindow(303, view)
    assert.equal(f.coordinator.focusRevision, blocked)
    f.coordinator.attach(303, 1, canvas as unknown as HTMLCanvasElement)
    assert.equal(f.coordinator.focus(303), false)
    view.blocked = false
    f.coordinator.setWindow(303, view)
    assert.ok(f.coordinator.focusRevision > blocked)
    assert.equal(f.coordinator.isActive(303), false)
    assert.equal(f.coordinator.focus(303), true)
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('unblocking does not reactivate a stale focused textarea or an older activation completion', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.windowId === 101 && packet.type === 'activate') await waiting.promise
    }),
    view = { ...new WindowState().view(), visible: true, blocked: true }
  try {
    f.coordinator.focus(101)
    const requestedRevision = f.coordinator.focusRevision
    f.coordinator.setWindow(101, view)
    f.coordinator.setWindow(101, { ...view, blocked: false })
    assert.ok(f.coordinator.focusRevision > requestedRevision)
    // This event-only fixture deliberately retains activeElement through inert;
    // the coordinator must not rely on the browser delivering an extra blur.
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.equal(f.coordinator.isActive(101), false)
    waiting.resolve()
    await settle()
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.packets.filter((packet) => packet.type === 'activate').length, 1)
    assert.equal(f.coordinator.focus(101), true)
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'activate').length, 2)
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('a rejected input from before blocking cannot discard input queued after unblocking', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.windowId === 101 && packet.type === 'keyDown' && packet.key === 65)
        await waiting.promise
    }),
    view = { ...new WindowState().view(), visible: true, blocked: true }
  try {
    f.coordinator.focus(101)
    await settle()
    f.key(f.textareas[0]!, 'a')
    f.coordinator.setWindow(101, view)
    f.coordinator.setWindow(101, { ...view, blocked: false })
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'b')
    waiting.reject(new Error('stale admitted input failure'))
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) => (packet.type === 'keyDown' ? [packet.key] : [])),
      [65, 66],
    )
    assert.equal(f.packets.filter((packet) => packet.type === 'activate').length, 2)
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('page resume leaves blocked canvases suspended until an explicit unblocked focus', async () => {
  const f = fixture(),
    view = { ...new WindowState().view(), visible: true, blocked: true }
  try {
    f.coordinator.focus(101)
    f.coordinator.setWindow(101, view)
    f.coordinator.setSuspended(true)
    f.coordinator.setSuspended(false)
    assert.equal(f.coordinator.focus(101), false)
    f.mouse(f.a, 'mousedown', 1, 10)
    assert.equal(f.coordinator.isActive(101), false)
    assert.deepEqual(f.pointers, [])
    f.coordinator.setWindow(101, { ...view, blocked: false })
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.focus(101), true)
    await settle()
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('queued game keyboard packets retain the route revision observed before a waiting callback', async () => {
  const waiting = deferred(),
    f = fixture(async (packet) => {
      if (packet.windowId === 101 && packet.type === 'activate') await waiting.promise
    }),
    view = inputView()
  try {
    f.coordinator.setInput(101, view)
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'a')
    f.textareas[0]!.value = 'observed before route change'
    f.dispatch(f.textareas[0]!, 'input')
    f.coordinator.setInput(
      101,
      inputView({ keyboardRoute: { windowId: 202, revision: 11, focused: 22, imeMode: 1 } }),
    )
    f.key(f.textareas[0]!, 'a', false)
    f.textareas[0]!.value = 'observed after route change'
    f.dispatch(f.textareas[0]!, 'input')
    f.mouse(f.a, 'mousemove', 0, 20)
    assert.deepEqual(
      f.packets.map((packet) => packet.type),
      ['activate'],
    )
    assert.deepEqual(f.keys.at(-1), [])
    waiting.resolve()
    await settle()
    assert.deepEqual(
      f.packets.map((packet) => [
        packet.windowId,
        packet.type,
        packet.keyboardRouteRevision,
        packet.type === 'text' ? packet.text : undefined,
      ]),
      [
        [101, 'activate', undefined, undefined],
        [101, 'keyDown', 10, undefined],
        [101, 'text', 10, 'observed before route change'],
        [101, 'keyUp', 11, undefined],
        [101, 'text', 11, 'observed after route change'],
        [101, 'move', undefined, undefined],
      ],
    )
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.equal(f.coordinator.isActive(202), false)
    assert.deepEqual(f.errors, [])
  } finally {
    waiting.resolve()
    f.close()
  }
})

test('keyboard receiver changes preserve source focus, capture and physical key ownership', async () => {
  const f = fixture()
  try {
    f.coordinator.setInput(101, inputView())
    f.dispatch(f.a, 'pointerdown', { pointerType: 'mouse', pointerId: 7 })
    f.mouse(f.a, 'mousedown', 1, 10)
    f.key(f.textareas[0]!, 'a')
    const focusRevision = f.coordinator.focusRevision,
      keyPublications = f.keys.length
    f.coordinator.setInput(
      101,
      inputView({ keyboardRoute: { windowId: 202, revision: 11, focused: 22, imeMode: 0 } }),
    )
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.equal(f.coordinator.isActive(101), true)
    assert.equal(f.coordinator.isActive(202), false)
    assert.equal(f.coordinator.focusRevision, focusRevision)
    assert.equal(f.a.captures.has(7), true)
    assert.equal(f.keys.length, keyPublications)
    assert.deepEqual(f.keys.at(-1), [1, 65])

    // Blocking the logical receiver must not clear keys physically held on A.
    // Blocking the actual source must clear them even though its route points to B.
    const blocked = { ...new WindowState().view(), visible: true, blocked: true }
    f.coordinator.setWindow(202, blocked)
    assert.deepEqual(f.keys.at(-1), [1, 65])
    assert.equal(f.keys.length, keyPublications)
    f.coordinator.setWindow(101, blocked)
    assert.deepEqual(f.keys.at(-1), [])
    assert.equal(f.a.captures.size, 0)
    await settle()
    assert.deepEqual(
      f.packets.filter((packet) => packet.type === 'activate').map((packet) => packet.windowId),
      [101],
    )
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('ordinary input uses the Window route while composition retains exact Layer ownership', async () => {
  const f = fixture(),
    route = (revision: number, focused: number) =>
      inputView({
        keyboardRoute: { windowId: 101, revision, inputRevision: 50, focused, imeMode: 1 },
      })
  try {
    f.coordinator.setInput(101, route(10, 11))
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'a')
    f.textareas[0]!.value = 'Hi'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertText' })
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'committed before Tab' })
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.coordinator.setInput(101, route(11, 12))
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'retired composition' })
    f.textareas[0]!.value = 'retired composition'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
    f.key(f.textareas[0]!, 'b')
    f.textareas[0]!.value = 'after Tab'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertText' })
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'new composition' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'keyDown' || packet.type === 'text'
          ? [
              [
                packet.type,
                packet.type === 'text' ? packet.text : packet.key,
                packet.keyboardRouteRevision,
                packet.keyboardInputRevision,
              ],
            ]
          : [],
      ),
      [
        ['keyDown', 65, 10, 50],
        ['text', 'Hi', 10, 50],
        ['text', 'committed before Tab', 10, undefined],
        ['keyDown', 66, 11, 50],
        ['text', 'after Tab', 11, 50],
        ['text', 'new composition', 11, undefined],
      ],
    )
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('host action keyup tails cannot enter a restored game but isolated keyups still can', async () => {
  const f = fixture(),
    editor = f.canvas(),
    capturedKey = (
      target: EventTarget,
      key: string,
      keyCode: number,
      down: boolean,
      repeat = false,
    ) => {
      const event = new Event(down ? 'keydown' : 'keyup', { cancelable: true })
      Object.assign(event, {
        key,
        keyCode,
        code: key,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        repeat,
        isComposing: false,
      })
      Object.defineProperty(event, 'target', { value: target })
      // This minimal DOM fixture has no propagation tree. Deliver the actual
      // capture-before-target order with the same event identity.
      f.page.dispatchEvent(event)
      target.dispatchEvent(event)
      return event
    }
  try {
    f.coordinator.focus(101)
    editor.focus()
    assert.equal(capturedKey(editor, 'Enter', 13, true).defaultPrevented, false)
    f.coordinator.focus(101)
    assert.equal(capturedKey(f.textareas[0]!, 'Enter', 13, true, true).defaultPrevented, true)
    assert.equal(capturedKey(f.textareas[0]!, 'Enter', 13, false).defaultPrevented, false)
    // The observed host pair suppresses exactly one tail, not all unpaired ups.
    capturedKey(f.textareas[0]!, 'Enter', 13, false)
    capturedKey(f.textareas[0]!, 'Enter', 13, true)
    capturedKey(f.textareas[0]!, 'Enter', 13, false)
    editor.focus()
    capturedKey(editor, 'Escape', 27, true)
    f.coordinator.focus(101)
    capturedKey(f.textareas[0]!, 'Escape', 27, true)
    capturedKey(f.textareas[0]!, 'Escape', 27, false)
    await settle()
    // Font selection suspends game input while its controls own the keydown.
    f.coordinator.setSuspended(true)
    editor.focus()
    capturedKey(editor, 'Enter', 13, true)
    f.coordinator.setSuspended(false)
    f.coordinator.focus(101)
    capturedKey(f.textareas[0]!, 'Enter', 13, false)
    editor.focus()
    capturedKey(editor, ' ', 32, true)
    f.dispatch(f.page, 'blur')
    f.coordinator.focus(101)
    capturedKey(f.textareas[0]!, ' ', 32, false)
    capturedKey(f.textareas[0]!, 'a', 65, false)
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'keyDown' || packet.type === 'keyUp' ? [[packet.type, packet.key]] : [],
      ),
      [
        ['keyUp', 13],
        ['keyDown', 13],
        ['keyUp', 13],
        ['keyDown', 27],
        ['keyUp', 27],
        ['keyUp', 32],
        ['keyUp', 65],
      ],
    )
    assert.deepEqual(f.keys.at(-1), [])
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

for (const [changed, route] of [
  ['revision', { windowId: 202, revision: 11, focused: 22, imeMode: 1 }],
  ['receiver', { windowId: 303, revision: 10, focused: 22, imeMode: 1 }],
  ['focused Layer', { windowId: 202, revision: 10, focused: 23, imeMode: 1 }],
] as const)
  test(`a changed keyboard ${changed} rejects late composition and its duplicate input without losing the next composition`, async () => {
    const f = fixture()
    try {
      f.coordinator.setInput(
        101,
        inputView({ keyboardRoute: { windowId: 202, revision: 10, focused: 22, imeMode: 1 } }),
      )
      f.coordinator.focus(101)
      f.dispatch(f.textareas[0]!, 'compositionstart')
      f.textareas[0]!.value = 'unfinished old text'
      f.coordinator.setInput(101, inputView({ keyboardRoute: route }))
      assert.equal(f.textareas[0]!.value, '')
      f.dispatch(f.textareas[0]!, 'compositionend', { data: 'late old text' })
      f.textareas[0]!.value = 'late old text'
      f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
      f.dispatch(f.textareas[0]!, 'compositionstart')
      f.dispatch(f.textareas[0]!, 'compositionend', { data: 'new receiver text' })
      f.textareas[0]!.value = 'new receiver text'
      f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
      await settle()
      assert.deepEqual(
        f.packets.flatMap((packet) =>
          packet.type === 'text'
            ? [[packet.windowId, packet.keyboardRouteRevision, packet.text]]
            : [],
        ),
        [[101, route.revision, 'new receiver text']],
      )
      assert.equal(f.textareas[0]!.value, '')
      assert.equal(f.document.activeElement, f.textareas[0])
      assert.deepEqual(f.errors, [])
    } finally {
      f.close()
    }
  })

test('equal route snapshots and appearance updates preserve an in-progress composition', async () => {
  const f = fixture(),
    view = inputView({
      attentionX: 40,
      attentionY: 60,
      attention: { x: 40, y: 60, focusLayerId: 11, pointLayerId: 12, font: null },
    })
  try {
    f.coordinator.setInput(101, view)
    f.coordinator.focus(101)
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.textareas[0]!.value = 'still composing'
    f.coordinator.setInput(
      101,
      inputView({
        ...view,
        keyboardRoute: { ...view.keyboardRoute! },
        attention: { ...view.attention! },
      }),
    )
    f.coordinator.setInput(
      101,
      inputView({
        ...view,
        cursor: -4,
        hint: 'updated presentation',
        attentionX: 90,
        attentionY: 110,
        attention: { ...view.attention!, x: 90, y: 110 },
      }),
    )
    f.a.clientWidth = 400
    f.a.clientHeight = 300
    f.coordinator.setWindow(101, { ...new WindowState().view(), visible: true })
    f.dispatch(f.page, 'resize')
    f.dispatch(f.page, 'scroll')
    assert.equal(f.textareas[0]!.value, 'still composing')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'composition survives layout' })
    f.textareas[0]!.value = 'composition survives layout'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text' ? [[packet.text, packet.keyboardRouteRevision]] : [],
      ),
      [['composition survives layout', 10]],
    )
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.equal(f.packets.filter((packet) => packet.type === 'activate').length, 1)
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('a game keyboard route cannot intercept external or transient host editing', async () => {
  const transient = new Set<EventTarget>(),
    f = fixture(undefined, false, (target) => !!target && transient.has(target)),
    editor = f.canvas(),
    popup = f.canvas()
  transient.add(popup)
  try {
    f.coordinator.setInput(101, inputView())
    f.coordinator.focus(101)
    f.key(f.textareas[0]!, 'a')
    f.dispatch(f.textareas[0]!, 'compositionstart')
    editor.focus()
    f.coordinator.setInput(
      101,
      inputView({ keyboardRoute: { windowId: 202, revision: 11, focused: 22, imeMode: 1 } }),
    )
    const hostKey = f.key(editor, 'b')
    editor.value = 'host editor text'
    f.dispatch(editor, 'input')
    f.dispatch(editor, 'compositionstart')
    f.dispatch(editor, 'compositionend', { data: 'host composition' })
    f.key(f.textareas[0]!, 'c')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'old game composition' })
    f.textareas[0]!.value = 'old game composition'
    f.dispatch(f.textareas[0]!, 'input')
    f.key(f.page, 'a', false)
    await settle()
    assert.equal(hostKey.defaultPrevented, false)
    assert.equal(editor.value, 'host editor text')
    assert.equal(f.document.activeElement, editor)
    assert.equal(f.coordinator.isActive(101), false)
    assert.equal(f.coordinator.isActive(202), false)
    assert.deepEqual(f.keys.at(-1), [])
    assert.deepEqual(
      f.packets.flatMap((packet) => (packet.type === 'keyDown' ? [packet.key] : [])),
      [65],
    )
    assert.equal(
      f.packets.some((packet) => packet.type === 'text'),
      false,
    )
    assert.equal(f.coordinator.focus(101), true)
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'new game composition' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text' ? [[packet.text, packet.keyboardRouteRevision]] : [],
      ),
      [['new game composition', 11]],
    )

    // A transient popup preserves Window ownership, but its DOM editing still
    // belongs to the host. A late event on the old textarea is not game input.
    popup.focus()
    assert.equal(f.coordinator.isActive(101), true)
    assert.equal(f.document.activeElement, popup)
    f.coordinator.setInput(
      101,
      inputView({ keyboardRoute: { windowId: 202, revision: 12, focused: 23, imeMode: 1 } }),
    )
    const popupKey = f.key(popup, 'd'),
      before = f.packets.length
    f.key(f.textareas[0]!, 'e')
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'late transient game text' })
    f.textareas[0]!.value = 'late transient game text'
    f.dispatch(f.textareas[0]!, 'input')
    await settle()
    assert.equal(popupKey.defaultPrevented, false)
    assert.equal(f.packets.length, before)
    assert.equal(f.coordinator.isActive(101), true)
    assert.equal(f.coordinator.isActive(202), false)
    assert.equal(f.document.activeElement, popup)
    assert.deepEqual(f.keys.at(-1), [])
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('a completed composition keeps duplicate suppression when its route changes before the input event', async () => {
  const f = fixture()
  try {
    f.coordinator.setInput(101, inputView())
    f.coordinator.focus(101)
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'repeated text' })
    f.coordinator.setInput(
      101,
      inputView({ keyboardRoute: { windowId: 202, revision: 11, focused: 22, imeMode: 1 } }),
    )
    f.textareas[0]!.value = 'repeated text'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text' ? [[packet.text, packet.keyboardRouteRevision]] : [],
      ),
      [['repeated text', 10]],
    )
    f.key(f.textareas[0]!, 'b')
    f.textareas[0]!.value = 'repeated text'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertText' })
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.dispatch(f.textareas[0]!, 'compositionend', { data: 'repeated text' })
    f.textareas[0]!.value = 'repeated text'
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertFromComposition' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text' ? [[packet.text, packet.keyboardRouteRevision]] : [],
      ),
      [
        ['repeated text', 10],
        ['repeated text', 11],
        ['repeated text', 11],
      ],
    )
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('retired composition text does not swallow later ordinary insertion, paste or drop without a keydown', async () => {
  const f = fixture(),
    text = 'same text in a new edit',
    route = (revision: number) =>
      inputView({ keyboardRoute: { windowId: 202, revision, focused: 22, imeMode: 1 } })
  try {
    f.coordinator.setInput(101, inputView())
    f.coordinator.focus(101)
    f.dispatch(f.textareas[0]!, 'compositionstart')
    f.coordinator.setInput(101, route(11))
    f.dispatch(f.textareas[0]!, 'compositionend', { data: text })
    // No duplicate input follows this retired composition. Register after its
    // cleanup timer so the next edit runs after that event-loop task.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(
      f.packets.some((packet) => packet.type === 'text'),
      false,
    )
    f.textareas[0]!.value = text
    f.dispatch(f.textareas[0]!, 'input', { inputType: 'insertText' })
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text' ? [[packet.text, packet.keyboardRouteRevision]] : [],
      ),
      [[text, 11]],
    )

    for (const [inputType, revision] of [
      ['insertFromPaste', 12],
      ['insertFromDrop', 13],
    ] as const) {
      f.dispatch(f.textareas[0]!, 'compositionstart')
      f.dispatch(f.textareas[0]!, 'compositionend', { data: text })
      f.coordinator.setInput(101, route(revision))
      // These explicitly new edits must be accepted even before the old
      // compositionend cleanup task, with exactly the same string payload.
      f.textareas[0]!.value = text
      f.dispatch(f.textareas[0]!, 'input', { inputType })
      await settle()
    }
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'text'
          ? [[packet.windowId, packet.text, packet.keyboardRouteRevision]]
          : [],
      ),
      [
        [101, text, 11],
        [101, text, 11],
        [101, text, 12],
        [101, text, 12],
        [101, text, 13],
      ],
    )
    assert.deepEqual(f.keys, [])
    assert.equal(f.document.activeElement, f.textareas[0])
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('attention uses source canvas coordinates and resets its font and anchor for null or cross-window routing', async () => {
  const f = fixture(),
    view = inputView({
      attentionX: 800,
      attentionY: 600,
      attention: {
        x: 80,
        y: 120,
        focusLayerId: 11,
        pointLayerId: 12,
        font: {
          face: 'serif',
          height: -30,
          bold: true,
          italic: true,
          underline: true,
          strikeout: true,
        },
      },
    })
  try {
    f.a.offsetLeft = 13
    f.a.offsetTop = 17
    f.a.clientWidth = 400
    f.a.clientHeight = 300
    f.coordinator.setInput(101, view)
    f.coordinator.focus(101)
    const text = f.textareas[0]!,
      appearance = () => [
        text.style.left,
        text.style.top,
        text.style.fontFamily,
        text.style.fontSize,
        text.style.fontWeight,
        text.style.fontStyle,
        text.style.textDecorationLine,
        text.inputMode,
      ]
    assert.deepEqual(appearance(), [
      '53px',
      '77px',
      'serif',
      '30px',
      'bold',
      'italic',
      'underline line-through',
      'text',
    ])
    f.coordinator.setInput(101, { ...view, attention: { ...view.attention!, font: null } })
    assert.deepEqual(appearance(), ['53px', '77px', '', '16px', '', '', '', 'text'])
    f.coordinator.setInput(101, view)
    f.coordinator.setInput(101, { ...view, attention: null })
    assert.deepEqual(appearance(), ['13px', '17px', '', '16px', '', '', '', 'text'])
    f.coordinator.setInput(101, view)
    f.coordinator.setInput(101, {
      ...view,
      keyboardRoute: { windowId: 202, revision: 11, focused: 22, imeMode: 0 },
    })
    assert.deepEqual(appearance(), ['13px', '17px', '', '16px', '', '', '', 'none'])
    assert.equal(f.document.activeElement, text)
    assert.equal(f.coordinator.isActive(101), true)
    assert.equal(f.coordinator.isActive(202), false)
    f.a.offsetLeft = 29
    f.a.offsetTop = 31
    f.a.clientWidth = 1600
    f.a.clientHeight = 1200
    f.dispatch(f.page, 'resize')
    assert.deepEqual(appearance(), ['29px', '31px', '', '16px', '', '', '', 'none'])
    f.coordinator.setInput(101, view)
    assert.deepEqual(appearance(), [
      '189px',
      '271px',
      'serif',
      '30px',
      'bold',
      'italic',
      'underline line-through',
      'text',
    ])
    for (const height of [0, Infinity, 257]) {
      f.coordinator.setInput(101, {
        ...view,
        attention: {
          ...view.attention!,
          font: { ...view.attention!.font!, height },
        },
      })
      assert.equal(text.style.fontSize, '16px', `unsupported font height ${height}`)
    }
    await settle()
    assert.equal(f.packets.filter((packet) => packet.type === 'activate').length, 1)
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('input cached before attachment preserves source identity across replacement canvases', async () => {
  const f = fixture(),
    original = f.canvas(),
    replacement = f.canvas(),
    view = inputView({
      focused: 33,
      attentionX: 80,
      attentionY: 120,
      attention: { x: 80, y: 120, focusLayerId: 33, pointLayerId: 34, font: null },
      keyboardRoute: { windowId: 303, revision: 12, focused: 33, imeMode: 0 },
    })
  try {
    original.offsetLeft = 5
    original.offsetTop = 7
    f.coordinator.setInput(303, view)
    f.coordinator.attach(303, 1, original as unknown as HTMLCanvasElement)
    assert.equal(f.textareas[2]!.style.left, '85px')
    assert.equal(f.textareas[2]!.style.top, '127px')
    assert.equal(f.textareas[2]!.inputMode, 'none')
    assert.equal(f.coordinator.focus(303), true)
    f.dispatch(f.textareas[2]!, 'compositionstart')
    f.coordinator.setInput(303, {
      ...view,
      keyboardRoute: { windowId: 202, revision: 13, focused: 22, imeMode: 1 },
    })
    replacement.offsetLeft = 19
    replacement.offsetTop = 23
    f.coordinator.attach(303, 2, replacement as unknown as HTMLCanvasElement)
    assert.equal(f.textareas[2]!.removed, true)
    assert.equal(f.textareas[3]!.style.left, '19px')
    assert.equal(f.textareas[3]!.style.top, '23px')
    assert.equal(f.textareas[3]!.inputMode, 'text')
    f.dispatch(f.textareas[2]!, 'compositionend', { data: 'old canvas text' })
    assert.equal(f.coordinator.focus(303, 2), true)
    f.key(f.textareas[3]!, 'a')
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'keyDown' ? [[packet.windowId, packet.keyboardRouteRevision]] : [],
      ),
      [[303, 13]],
    )
    assert.equal(
      f.packets.some((packet) => packet.type === 'text'),
      false,
    )
    assert.equal(f.document.activeElement, f.textareas[3])
    assert.equal(f.coordinator.isActive(202), false)
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

test('Alt combinations and F10 carry system-key intent without changing physical observation', async () => {
  const f = fixture(),
    emit = (type: 'keydown' | 'keyup', key: string, keyCode: number, altKey: boolean) =>
      f.dispatch(f.textareas[0]!, type, {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        keyCode,
        altKey,
        shiftKey: false,
        ctrlKey: false,
        repeat: false,
        isComposing: false,
      })
  try {
    f.coordinator.setInput(101, inputView())
    f.coordinator.focus(101)
    emit('keydown', 'Alt', 18, true)
    emit('keydown', 'a', 65, true)
    emit('keyup', 'a', 65, true)
    emit('keyup', 'Alt', 18, false)
    emit('keydown', 'F10', 121, false)
    emit('keyup', 'F10', 121, false)
    emit('keydown', 'b', 66, false)
    emit('keyup', 'b', 66, false)
    assert.deepEqual(f.keys, [[18], [18, 65], [18], [], [121], [], [66], []])
    await settle()
    assert.deepEqual(
      f.packets.flatMap((packet) =>
        packet.type === 'keyDown' || packet.type === 'keyUp'
          ? [[packet.type, packet.key, packet.systemKey, packet.keyboardRouteRevision]]
          : [],
      ),
      [
        ['keyDown', 18, true, 10],
        ['keyDown', 65, true, 10],
        ['keyUp', 65, true, 10],
        ['keyUp', 18, true, 10],
        ['keyDown', 121, true, 10],
        ['keyUp', 121, true, 10],
        ['keyDown', 66, undefined, 10],
        ['keyUp', 66, undefined, 10],
      ],
    )
    for (const packet of f.packets)
      if ((packet.type === 'keyDown' || packet.type === 'keyUp') && packet.key === 66)
        assert.equal(Object.hasOwn(packet, 'systemKey'), false)
    assert.deepEqual(f.errors, [])
  } finally {
    f.close()
  }
})

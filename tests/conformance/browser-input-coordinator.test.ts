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

function fixture(
  send?: (packet: InputPacket) => Promise<void>,
  scope = false,
  transient?: (target: EventTarget | null) => boolean,
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
      { isTransientFocus: transient },
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

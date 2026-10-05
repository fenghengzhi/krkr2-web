import test from 'node:test'
import assert from 'node:assert/strict'
import { PageApplicationMonitor } from '../../src/player/page-application.ts'
import type { ApplicationActivation } from '../../src/engine/ports/application.ts'

function fixture(focused = true) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window = new EventTarget(), document = Object.assign(new EventTarget(), {
      visibilityState: 'visible', hasFocus: () => focused,
    }), values: ApplicationActivation[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const monitor = new PageApplicationMonitor((value) => values.push(value))
  return { window, document, values, monitor, focused(value: boolean) { focused = value }, close() {
    monitor.close()
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document')
  } }
}
test('application observation filters descendant blur and deduplicates visibility/focus transitions independently of controls', () => {
  const f = fixture()
  try {
    const descendant = new Event('blur'); Object.defineProperty(descendant, 'target', { value: {} })
    f.window.dispatchEvent(descendant)
    f.document.dispatchEvent(new Event('focusin'))
    assert.deepEqual(f.values, [{ sequence: 1, active: true }])
    f.focused(false); f.window.dispatchEvent(new Event('blur'))
    f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'))
    f.document.dispatchEvent(new Event('freeze'))
    f.document.dispatchEvent(new Event('resume'))
    f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'))
    assert.deepEqual(f.values, [{ sequence: 1, active: true }, { sequence: 2, active: false }])
    f.focused(true); f.window.dispatchEvent(new Event('focus'))
    assert.deepEqual(f.values, [{ sequence: 1, active: true }, { sequence: 2, active: false }, { sequence: 3, active: true }])
  } finally { f.close() }
})
test('application observation starts from actual focus and revokes late lifecycle events at close', () => {
  const f = fixture(false)
  try {
    assert.deepEqual(f.values, [{ sequence: 1, active: false }])
    f.focused(true); f.window.dispatchEvent(new Event('pageshow'))
    f.window.dispatchEvent(new Event('pagehide'))
    f.window.dispatchEvent(new Event('focus'))
    assert.deepEqual(f.values, [{ sequence: 1, active: false }, { sequence: 2, active: true }, { sequence: 3, active: false }])
    f.monitor.close()
    f.window.dispatchEvent(new Event('pageshow')); f.window.dispatchEvent(new Event('focus'))
    assert.equal(f.values.length, 3)
  } finally { f.close() }
})

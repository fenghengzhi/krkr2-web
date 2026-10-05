import type { BrowserGamepadSource } from '../../src/backends/input/gamepad-browser.ts'
import type { GamepadSnapshot } from '../../src/backends/input/gamepad.ts'

/** Controlled device/RAF boundary. Sampling and routing are production code. */
export function gamepadSource() {
  let time = 0, next = 1, reads = 0
  const callbacks = new Map<number, () => void>()
  let pads: readonly (GamepadSnapshot | null)[] = [], failure: unknown
  const source: BrowserGamepadSource = {
    read() { reads++; if (failure) throw failure; return pads },
    now: () => time,
    request(callback) { const id = next++; callbacks.set(id, callback); return id },
    cancel(handle) { callbacks.delete(handle) },
  }
  return {
    source,
    pad(buttons: number[] = [], axes = [0, 0], index = 0) {
      pads = [{ index, id: 'controlled-pad', mapping: 'standard', connected: true, axes,
        buttons: Array.from({ length: 17 }, (_, at) => ({ pressed: buttons.includes(at), value: buttons.includes(at) ? 1 : 0 })) }]
    },
    disconnect() { pads = [] },
    fail(error: unknown) { failure = error },
    tick(now: number) {
      time = now
      const pending = [...callbacks]
      for (const [id, callback] of pending) {
        callbacks.delete(id)
        callback()
      }
    },
    get reads() { return reads },
    get pending() { return callbacks.size },
    captured: () => [...callbacks.values()],
  }
}

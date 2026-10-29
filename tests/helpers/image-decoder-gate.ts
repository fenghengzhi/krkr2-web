import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import type { ImageInflater, ImageInflaterProvider } from '../../src/engine/ports/image-inflater.ts'
import { ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import { createHeadlessImageInflaterProvider } from './image-zlib.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Holds admission of an already opened real PNG inflater. The returned stream
 * uses the production WASM step; this gate never manufactures expanded bytes. */
export function pngInflateGate(expectedLength?: number) {
  const entered = deferred<void>(), result = deferred<void>(),
    operations: Array<Promise<PromiseSettledResult<ImageInflater>>> = [],
    actual = createHeadlessImageInflaterProvider(), active = new Set<ImageInflater>(), cleanupErrors: unknown[] = []
  let calls = 0, closed = 0, disposed = false
  const provider: ImageInflaterProvider = {
    open(bytes, length) {
      const operation = (async () => {
        if (disposed) throw new ExecutionCancelled()
        assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        if (expectedLength !== undefined) assert.equal(length, expectedLength)
        const stream = await actual.open(bytes, length)
        if (disposed) {
          try { stream.close() } catch (cleanup) { cleanupErrors.push(cleanup) }
          throw new ExecutionCancelled()
        }
        let finished = false
        const owned: ImageInflater = {
          step(input, output) { return stream.step(input, output) },
          close() {
            if (finished) return
            finished = true; active.delete(owned); closed++
            stream.close()
          },
        }
        active.add(owned); calls++; entered.resolve()
        try {
          // Keep an already owned operation pending across Stop. A real late
          // rejection retains its exact identity; late success cannot revive it.
          await result.promise
          if (disposed) throw new ExecutionCancelled()
          return owned
        } catch (error) {
          try { owned.close() } catch (cleanup) { cleanupErrors.push(cleanup) }
          throw error
        }
      })()
      operations.push(operation.then(
        (value): PromiseFulfilledResult<ImageInflater> => ({ status: 'fulfilled', value }),
        (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
      ))
      return operation
    },
    dispose() {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      for (const stream of [...active]) try { stream.close() } catch (error) { errors.push(error) }
      try { actual.dispose() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Image inflater gate cleanup failed')
    },
  }
  return { entered: entered.promise, result, provider, calls: () => calls,
    active: () => active.size, closed: () => closed,
    release: () => result.resolve(), drain: async () => {
      const settled = await Promise.all(operations)
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Late image inflater gate cleanup failed')
      return settled
    } }
}

/** Original province scenario: two real palette indices 7 and 19. The source
 * colors/alpha are also preserved, although palettized mode reads the indices. */
export function provinceGatePng(): Buffer {
  const header = Buffer.alloc(13), palette = Buffer.alloc(20 * 3), alpha = Buffer.alloc(20, 255)
  header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 3
  palette.set([200, 100, 50], 7 * 3); palette.set([10, 20, 30], 19 * 3); alpha[19] = 0
  const chunk = (name: string, data: Uint8Array): Buffer => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length); bytes.write(name, 4, 'ascii'); bytes.set(data, 8)
    let crc = 0xffffffff
    for (const value of bytes.subarray(4, bytes.length - 4)) {
      crc ^= value
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
    return bytes
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('PLTE', palette), chunk('tRNS', alpha),
    chunk('IDAT', deflateSync(Uint8Array.of(0, 7, 19))), chunk('IEND', Buffer.alloc(0))])
}

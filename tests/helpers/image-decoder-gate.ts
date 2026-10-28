import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Holds the real selected PNG's zlib dependency, then delegates to production
 * inflation. It never manufactures decoded pixels or bypasses format selection. */
export function pngInflateGate(expectedLength?: number) {
  const entered = deferred<void>(), result = deferred<void>(),
    operations: Array<Promise<PromiseSettledResult<Uint8Array>>> = []
  let calls = 0
  const inflate: SessionDependencies['inflateImage'] = (bytes, length) => {
    const operation = (async () => {
      assert.ok(bytes.length > 0)
      if (expectedLength !== undefined) assert.equal(length, expectedLength)
      calls++
      entered.resolve()
      await result.promise
      return inflateImage(bytes, length)
    })()
    operations.push(operation.then(
      (value): PromiseFulfilledResult<Uint8Array> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
    ))
    return operation
  }
  return { entered: entered.promise, result, inflate, calls: () => calls,
    release: () => result.resolve(), drain: () => Promise.all(operations) }
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

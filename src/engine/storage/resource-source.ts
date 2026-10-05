import { MAX_RESOURCE_BYTES, type ByteSource, type Resource } from '../ports/storage.ts'

export interface ResourceSourceOptions {
  /** Complete-file fallback limit; callers may reduce the existing 64 MiB cap. */
  fallbackLimit?: number
  checkpoint?: () => void | Promise<void>
}
export interface OpenedResourceSource {
  readonly source: ByteSource
  /** Capability/source ownership, not a claim that unrequested bytes were verified. */
  readonly mode: 'range' | 'buffered'
  /** Only a fallback snapshot retained by this opened reader; pool caches are separate. */
  readonly bufferedBytes: number
}

export function resourceReadBounds(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(size) || size < 0 ||
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > size || length > size - offset)
    throw new Error('Resource read outside valid range')
  if (length > MAX_RESOURCE_BYTES) throw new Error('Resource read exceeds 64 MiB budget')
}

/** Borrow true source reads, or explicitly own one bounded complete fallback.
 * No close operation is forwarded to a shared HTTP/OPFS Session pool. Every
 * returned range is compact caller-owned bytes, safe to transfer or mutate. */
export async function openResourceSource(
  resource: Resource,
  options: ResourceSourceOptions = {},
): Promise<OpenedResourceSource> {
  const size = resource.size, limit = options.fallbackLimit ?? MAX_RESOURCE_BYTES,
    checkpoint = options.checkpoint
  resourceReadBounds(size, 0, 0)
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_RESOURCE_BYTES)
    throw new Error('Invalid resource fallback budget')
  await checkpoint?.()
  const original = resource.source
  if (original) {
    if (original.size !== size || typeof original.read !== 'function')
      throw new Error('Resource source size or reader mismatch')
    return { mode: 'range', bufferedBytes: 0, source: {
      size,
      async read(offset, length) {
        resourceReadBounds(size, offset, length)
        await checkpoint?.()
        const bytes = await original.read(offset, length)
        await checkpoint?.()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
          throw new Error('Resource source returned an invalid range')
        return new Uint8Array(bytes)
      },
    } }
  }
  if (size > limit) throw new Error('Resource has no range source and exceeds fallback budget')
  const bytes = await resource.read()
  await checkpoint?.()
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size)
    throw new Error('Resource fallback size mismatch')
  const snapshot = new Uint8Array(bytes)
  return { mode: 'buffered', bufferedBytes: snapshot.byteLength, source: {
    size,
    async read(offset, length) {
      resourceReadBounds(size, offset, length)
      await checkpoint?.()
      return snapshot.slice(offset, offset + length)
    },
  } }
}

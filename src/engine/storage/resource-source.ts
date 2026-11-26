import { MAX_RESOURCE_BYTES, type ArchiveReader, type ByteSource, type ImmutableBlob, type Resource } from '../ports/storage.ts'

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

export function resourceViewBounds(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(size) || size < 0 ||
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > size || length > size - offset)
    throw new Error('Resource read outside valid range')
}
export function resourceReadBounds(size: number, offset: number, length: number): void {
  resourceViewBounds(size, offset, length)
  if (length > MAX_RESOURCE_BYTES) throw new Error('Resource read exceeds 64 MiB budget')
}
export async function borrowResourceBlob(source: ByteSource, offset: number, length: number,
  checkpoint?: () => void | Promise<void>,
): Promise<ImmutableBlob> {
  resourceViewBounds(source.size, offset, length)
  if (!source.borrowBlob) throw new Error('Resource has no immutable Blob capability')
  await checkpoint?.()
  const blob = await source.borrowBlob(offset, length, checkpoint)
  await checkpoint?.()
  if (blob.size !== length || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function')
    throw new Error('Resource returned an invalid immutable Blob view')
  return blob
}

/** Expose logical file ranges as ordered slices of their immutable backing.
 * Adjacent physical extents need one slice. Disjoint extents require the
 * platform's Blob join operation and can appear in any physical order. */
export function extentBorrower(extents: readonly { start: number; size: number }[],
  borrow: NonNullable<ByteSource['borrowBlob']>, join?: ArchiveReader['joinBlobs']): ByteSource['borrowBlob'] {
  if (!extents.length) return
  const spans: { start: number; size: number; offset: number }[] = []
  let size = 0
  for (const extent of extents) {
    const last = spans.at(-1)
    if (last && extent.start === last.start + last.size) last.size += extent.size
    else if (extent.size) spans.push({ ...extent, offset: size })
    size += extent.size
  }
  const first = spans[0] ?? { start: extents[0]!.start, size: 0 }
  if (spans.length <= 1) return (offset, length, checkpoint) => {
    resourceViewBounds(size, offset, length)
    return borrow(first.start + offset, length, checkpoint)
  }
  if (!join) return
  return async (offset, length, checkpoint) => {
    resourceViewBounds(size, offset, length)
    await checkpoint?.()
    const parts: ImmutableBlob[] = [], end = offset + length
    let low = 0, high = spans.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2), span = spans[middle]!
      if (span.offset + span.size <= offset) low = middle + 1
      else high = middle
    }
    for (let i = low; i < spans.length; i++) {
      const span = spans[i]!
      if (span.offset >= end) break
      const from = Math.max(span.offset, offset), to = Math.min(span.offset + span.size, end)
      if (from < to) parts.push(await borrow(span.start + from - span.offset, to - from, checkpoint))
    }
    await checkpoint?.()
    const blob = parts.length === 1 ? parts[0]! : join(parts)
    if (blob.size !== length) throw new Error('Joined file has an inconsistent size')
    return blob
  }
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
      ...(original.borrowBlob ? { async borrowBlob(offset: number, length: number, check?: () => void | Promise<void>) {
        return borrowResourceBlob(original, offset, length, async () => { await checkpoint?.(); await check?.() })
      } } : {}),
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

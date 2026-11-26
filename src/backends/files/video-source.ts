import { MAX_RESOURCE_BYTES, type Resource } from '../../engine/ports/storage.ts'
import { videoSourceLimits, type VideoBlobPayload, type VideoSourceControl } from '../../engine/ports/video.ts'
import { borrowResourceBlob, resourceViewBounds } from '../../engine/storage/resource-source.ts'

/** This adapter is the only materialization boundary: a constructed Blob is
 * always charged as buffered, even though Blob itself is immutable. */
export async function prepareVideoBlob(resource: Resource, control: VideoSourceControl): Promise<VideoBlobPayload> {
  const size = resource.size, source = resource.source
  resourceViewBounds(size, 0, size)
  control.check()
  if (source && source.size !== size) throw new Error('Video resource source size mismatch')
  if (source?.borrowBlob) {
    if (size > videoSourceLimits.borrowedBytes) throw new Error('Borrowed video source exceeds 2 GiB budget')
    const blob = await borrowResourceBlob(source, 0, size, () => control.checkpoint())
    control.check()
    // Structural capabilities belong to core; only this platform adapter can
    // establish that postMessage receives a real structured-cloneable Blob.
    if (!(blob instanceof Blob)) throw new Error('Video source did not return a platform Blob')
    return { blob, buffered: false }
  }
  if (size > videoSourceLimits.bufferedBytes) throw new Error('Buffered video source exceeds 128 MiB budget')
  const parts: Blob[] = []
  if (!source) {
    if (size > MAX_RESOURCE_BYTES) throw new Error('Video resource has no range source and exceeds fallback budget')
    await control.checkpoint()
    const bytes = await resource.read()
    control.check()
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) throw new Error('Video resource fallback size mismatch')
    // Preserve old byte-only embeddings without granting a larger read().
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      await control.checkpoint()
      parts.push(new Blob([Uint8Array.from(bytes.subarray(offset, offset + 1024 * 1024)).buffer]))
    }
  } else {
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      await control.checkpoint()
      const length = Math.min(1024 * 1024, size - offset), bytes = await source.read(offset, length)
      control.check()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('Video resource returned an invalid range')
      parts.push(new Blob([Uint8Array.from(bytes).buffer]))
    }
  }
  await control.checkpoint()
  return { blob: new Blob(parts), buffered: true }
}

import type { LegacyVideoFormat } from './format.ts'
import { legacyMediaLimits, type LegacyMediaModule } from './module.ts'

/** Paged output avoids MEMFS's geometric growth plus old-buffer copy. MP4's
 * normal seeks and faststart reads use the same bounded random-access file. */
function outputFile(module: LegacyMediaModule) {
  const fs = module.FS, stream = fs.open('/output.mp4', 'w+'), node = stream.node,
    pageBytes = 64 * 1024, pages: Uint8Array<ArrayBuffer>[] = []
  fs.close(stream)
  let exceeded = false
  node.stream_ops = { ...node.stream_ops,
    read(_stream, buffer, offset, length, position) {
      const count = Math.max(0, Math.min(length, node.usedBytes - position))
      for (let at = 0; at < count;) {
        const absolute = position + at, index = Math.floor(absolute / pageBytes), within = absolute % pageBytes,
          size = Math.min(count - at, pageBytes - within)
        buffer.set(pages[index]!.subarray(within, within + size), offset + at); at += size
      }
      return count
    },
    write(_stream, buffer, offset, length, position) {
      const end = position + length
      if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(end) || end > legacyMediaLimits.outputBytes) {
        exceeded = true
        throw new fs.ErrnoError(28)
      }
      while (pages.length * pageBytes < end) pages.push(new Uint8Array(pageBytes))
      for (let at = 0; at < length;) {
        const absolute = position + at, index = Math.floor(absolute / pageBytes), within = absolute % pageBytes,
          size = Math.min(length - at, pageBytes - within)
        pages[index]!.set(buffer.subarray(offset + at, offset + at + size), within); at += size
      }
      node.usedBytes = Math.max(node.usedBytes, end)
      return length
    },
  }
  return {
    result() {
      if (exceeded) throw new Error('Legacy movie exceeds 128 MiB output budget')
      if (node.usedBytes < 8) throw new Error('Legacy movie decoder produced no MP4 output')
      return new Blob(pages.slice(0, Math.ceil(node.usedBytes / pageBytes))
        .map((page, index) => page.subarray(0, Math.min(pageBytes, node.usedBytes - index * pageBytes))), { type: 'video/mp4' })
    },
  }
}

/** Synchronous native work: product callers MUST run this in their dedicated
 * disposable Worker. Uint8Array input is for hosted Node decoder checks; the
 * application's immutable Blob uses read-only WORKERFS without a full copy. */
export function convertLegacyMovie(module: LegacyMediaModule, input: Blob | Uint8Array, format: LegacyVideoFormat, log: readonly string[]): Blob {
  const blob = input instanceof Blob, size = blob ? input.size : input.byteLength
  if (size < 1 || size > legacyMediaLimits.inputBytes || !['mpeg', 'mpegvideo', 'avi'].includes(format))
    throw new Error('Invalid legacy movie conversion request')
  module.FS.mkdir('/input')
  try {
    if (blob) module.FS.mount(module.WORKERFS, { blobs: [{ name: 'source', data: input }] }, '/input')
    else module.FS.writeFile('/input/source', input)
    const output = outputFile(module)
    const status = module.runLegacy([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror', '-max_alloc', '67108864',
      '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
      '-err_detect', 'explode', '-max_pixels', '16777216', '-max_streams', '16', '-f', format, '-i', '/input/source',
      // CLI applies one input-wide origin, not a separate zero for each track.
      '-map', '0:v', '-map', '0:a?', '-sn', '-dn', '-copyts', '-start_at_zero', '-map_metadata', '-1',
      '-c:v', 'libopenh264', '-threads:v', '1', '-profile:v', 'constrained_baseline', '-rc_mode', 'quality',
      '-b:v', '2000000', '-allow_skip_frames', '0', '-pix_fmt', 'yuv420p', '-vsync', '0', '-enc_time_base:v', '-1',
      '-avoid_negative_ts', 'disabled',
      '-c:a', 'aac', '-threads:a', '1', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4', '-y', '/output.mp4',
    ])
    if (status !== 0) throw new Error(`Legacy movie conversion failed (${status}): ${log.join('\n')}`)
    return output.result()
  } finally {
    // This independent native instance is retired after one call. Preserve
    // the primary codec result if best-effort filesystem cleanup fails.
    try { if (blob) module.FS.unmount('/input'); else module.FS.unlink('/input/source') } catch {}
    try { module.FS.unlink('/output.mp4') } catch {}
  }
}

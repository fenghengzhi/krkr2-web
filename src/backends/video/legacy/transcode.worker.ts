import { loadLegacyMedia } from './module.ts'
import { convertLegacyMovie } from './convert.ts'
import type { LegacyMediaReply, LegacyMediaRequest } from './transcode.ts'

let accepted = false
self.onmessage = async (event: MessageEvent<LegacyMediaRequest>) => {
  if (accepted) return
  accepted = true
  const log: string[] = []
  let logBytes = 0
  const record = (line: string) => {
    const text = String(line).slice(0, 2048)
    log.push(text); logBytes += text.length
    while (logBytes > 16384) logBytes -= log.shift()!.length
  }
  try {
    const { input, format, manifestUrl } = event.data
    if (event.data.type !== 'transcode' || !(input instanceof Blob)) throw new Error('Invalid legacy movie conversion request')
    const module = await loadLegacyMedia(manifestUrl, record), blob = convertLegacyMovie(module, input, format, log),
      header = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    if (String.fromCharCode(...header.subarray(4, 8)) !== 'ftyp') throw new Error('Legacy movie output is not MP4')
    self.postMessage({ type: 'done', format, inputBytes: input.size, outputBytes: blob.size, blob, log } satisfies LegacyMediaReply)
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error), log } satisfies LegacyMediaReply)
  } finally {
    // The caller also terminates on success/error/timeout/Stop. Closing here
    // prevents reuse of FFmpeg's process-global native state.
    self.close()
  }
}

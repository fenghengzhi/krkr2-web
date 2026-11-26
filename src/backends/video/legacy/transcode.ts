import { isLegacyVideoFormat, type LegacyVideoFormat } from './format.ts'
import { legacyMediaLimits } from './module.ts'

declare const __KRKR_LEGACY_MEDIA_MANIFEST_FILE__: string
export const legacyMediaManifestFile = typeof __KRKR_LEGACY_MEDIA_MANIFEST_FILE__ === 'string'
  ? __KRKR_LEGACY_MEDIA_MANIFEST_FILE__ : 'legacy-media/manifest.json'
let manifestUrl: string | undefined
export function configureLegacyMedia(url: string): void { manifestUrl = new URL(url).href }
export interface LegacyMediaRequest { type: 'transcode'; format: LegacyVideoFormat; input: Blob; manifestUrl: string }
export type LegacyMediaReply =
  | { type: 'done'; format: LegacyVideoFormat; inputBytes: number; outputBytes: number; blob: Blob; log: string[] }
  | { type: 'error'; message: string; log: string[] }
let active = false

/** One isolated synchronous native process runs in its own Worker. Stop can
 * terminate it even while the codec is inside C, without sharing an instance
 * or mutable filesystem with another movie. Callers serialize preparations. */
export async function transcodeLegacyMovie(input: Uint8Array | Blob, format: LegacyVideoFormat, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Legacy movie cancelled', 'AbortError')
  const size = input instanceof Blob ? input.size : input.byteLength, url = manifestUrl
  if (!url) throw new Error('Legacy movie kernel URL has not been configured')
  if (!isLegacyVideoFormat(format)) throw new Error('Unsupported legacy movie container')
  if (!Number.isSafeInteger(size) || size < 1 || size > legacyMediaLimits.inputBytes)
    throw new Error('Legacy movie exceeds 128 MiB input budget')
  if (active) throw new Error('Legacy movie conversion is already active in this session')
  active = true
  try {
    const blob = input instanceof Blob ? input : new Blob([Uint8Array.from(input)])
    return await new Promise<Blob>((resolve, reject) => {
      let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false
      const finish = (error?: unknown, output?: Blob) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate() }
        if (error !== undefined) reject(error)
        else resolve(output!)
      }, cancel = () => finish(signal.reason ?? new DOMException('Legacy movie cancelled', 'AbortError'))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      try {
        worker = new Worker(new URL('./transcode.worker.ts', import.meta.url), { type: 'module', name: 'krkr-legacy-movie' })
        worker.onmessage = (event: MessageEvent<LegacyMediaReply>) => {
          const reply = event.data
          if (reply.type === 'error') { finish(new Error(reply.message)); return }
          if (reply.type !== 'done' || reply.format !== format || reply.inputBytes !== size || !(reply.blob instanceof Blob) ||
              reply.outputBytes !== reply.blob.size || reply.blob.size < 8 || reply.blob.size > legacyMediaLimits.outputBytes) {
            finish(new Error('Invalid legacy movie conversion reply')); return
          }
          finish(undefined, reply.blob)
        }
        worker.onerror = (event) => { event.preventDefault(); finish(new Error(event.message || 'Legacy movie Worker failed')) }
        worker.onmessageerror = () => finish(new Error('Legacy movie Worker reply could not be read'))
        timer = setTimeout(() => finish(new Error('Legacy movie conversion exceeded its five-minute budget')), legacyMediaLimits.milliseconds)
        worker.postMessage({ type: 'transcode', format, input: blob, manifestUrl: url } satisfies LegacyMediaRequest)
      } catch (error) { finish(error) }
    })
  } finally { active = false }
}

import type { ByteSource } from '../../engine/ports/storage.ts'
import { audioTag, PcmSourceContext, type PcmSource, type PcmSourceOptions } from '../../formats/audio/pcm-source.ts'
import { openWavePcmSource } from '../../formats/audio/wav-source.ts'
import { openVorbisPcmSource } from '../../formats/audio/vorbis-source.ts'

export type { PcmSource, PcmSourceOptions, PcmCancellationSignal } from '../../formats/audio/pcm-source.ts'
export { pcmSourceLimits } from '../../formats/audio/pcm-source.ts'

/** Unsupported encodings return undefined for the existing bounded fallback.
 * Recognized malformed PCM/Vorbis rejects rather than silently changing codecs. */
export async function openPortablePcmSource(source: ByteSource, options: PcmSourceOptions = {}): Promise<PcmSource | undefined> {
  const context = new PcmSourceContext(source, { ...options,
    yieldControl: options.yieldControl ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 0) })),
  })
  try {
    const prefix = await context.read(0, Math.min(12, source.size))
    const result = audioTag(prefix, 0) === 'OggS' ? await openVorbisPcmSource(context)
      : await openWavePcmSource(context, prefix)
    if (!result) context.close()
    else context.assertOpen()
    return result
  } catch (error) { context.close(); throw error }
}

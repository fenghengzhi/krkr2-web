import type { FontDescriptor } from '../../../engine/ports/fonts.ts'
import { readFontMetadata, validFontName } from '../../../formats/font/metadata.ts'
import { BlobSource } from '../../files/blob-source.ts'

interface LocalFont {
  family: string
  style: string
  postscriptName: string
  blob(): Promise<Blob>
}
type FontWindow = typeof globalThis & { queryLocalFonts?: () => Promise<LocalFont[]> }
export const canReadLocalFonts = () =>
  typeof (globalThis as FontWindow).queryLocalFonts === 'function'
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending = true
    const take = () => {
      if (!pending) return false
      pending = false
      signal.removeEventListener('abort', abort)
      return true
    }
    const abort = () => {
      if (take()) reject(new DOMException('Font enumeration cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(
      (value) => {
        if (take()) resolve(value)
      },
      (error) => {
        if (take()) reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
/** Call directly from a user gesture. No font bytes leave the browser. */
export async function readLocalFonts(
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<FontDescriptor[]> {
  const query = (globalThis as FontWindow).queryLocalFonts
  if (!query) throw new Error('此浏览器不能直接枚举本机字体')
  signal.throwIfAborted()
  const fonts = await abortable(query.call(globalThis), signal)
  if (fonts.length > 16384) throw new Error('本机字体数量超过读取范围')
  const families = new Map<string, LocalFont>(),
    rank = (style: string) => (/^(regular|normal|roman|book)$/i.test(style) ? 0 : 1)
  for (const font of fonts) {
    if (!validFontName(font.family)) continue
    const old = families.get(font.family)
    if (!old || rank(font.style) < rank(old.style)) families.set(font.family, font)
  }
  if (families.size > 2048) throw new Error('本机字体家族数量超过读取范围')
  const result: FontDescriptor[] = []
  for (const font of families.values()) {
    signal.throwIfAborted()
    let descriptor: FontDescriptor = { name: font.family, source: 'system' }
    try {
      const blob = await abortable(font.blob(), signal),
        metadata = await abortable(
          readFontMetadata(new BlobSource(blob), () => signal.throwIfAborted()),
          signal,
        )
      descriptor = {
        ...descriptor,
        fixedPitch: metadata.fixedPitch,
        outline: metadata.outline,
        charsets: metadata.charsets,
        vertical: font.family.startsWith('@'),
      }
    } catch (error) {
      signal.throwIfAborted() /* Keep unknown metadata unknown; filters exclude it. */
    }
    result.push(descriptor)
    progress(result.length, families.size)
    await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal)
  }
  return result
}

import { TextStreamError } from './errors.ts'

export interface StreamMode {
  mode: string
  hasOffset: boolean
  offset: number
  append: boolean
}

export interface TextWriterMode extends StreamMode {
  encoding: 'utf8' | 'utf16' | 'simple' | 'compressed'
  compressionLevel?: number
}

const MAX_STREAM_OFFSET = 64 * 1024 * 1024

function terminatedMode(mode: string): string {
  const end = mode.indexOf('\0')
  return end < 0 ? mode : mode.slice(0, end)
}

function digitAt(mode: string, index: number): number | undefined {
  const code = mode.charCodeAt(index)
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : undefined
}

export function parseStreamMode(input: string): StreamMode {
  const mode = terminatedMode(input)
  const marker = mode.indexOf('o')
  let offset = 0
  if (marker >= 0) {
    const start = marker + 1
    let end = start
    while (digitAt(mode, end) !== undefined) {
      end++
      // Native collection is bounded to 255 digits. Reject longer input
      // rather than reproducing truncation or integer overflow.
      if (end - start > 255) throw new Error('Invalid text stream offset')
    }
    // The collected string is converted by TJS, whose leading zero selects
    // octal and whose first non-octal digit terminates that conversion.
    const radix = mode[start] === '0' ? 8 : 10
    for (let index = start; index < end; index++) {
      const digit = digitAt(mode, index)!
      if (digit >= radix) break
      offset = offset * radix + digit
      if (!Number.isSafeInteger(offset) || offset > MAX_STREAM_OFFSET)
        throw new Error('Invalid text stream offset')
    }
  }
  return { mode, hasOffset: marker >= 0, offset, append: mode.includes('a') }
}

export function parseTextWriterMode(input: string): TextWriterMode {
  const mode = terminatedMode(input)
  let encoding: TextWriterMode['encoding'] = 'utf16'
  let compressionLevel: number | undefined
  // UTF-8 is a Web extension with its existing precedence over c/z modes.
  // Classify before parsing the offset, matching native writer error order.
  if (/utf-?8/i.test(mode)) encoding = 'utf8'
  else {
    const cipher = mode.indexOf('c')
    const compressed = mode.indexOf('z')
    const kind = compressed >= 0 ? 2 : cipher >= 0 ? (digitAt(mode, cipher + 1) ?? 1) : -1
    if (kind === 1) encoding = 'simple'
    else if (kind === 2) {
      encoding = 'compressed'
      if (compressed >= 0) compressionLevel = digitAt(mode, compressed + 1)
    } else if (kind !== -1)
      throw new TextStreamError('unsupported-mode', `Unsupported text writer encoding ${kind}`)
  }
  return {
    ...parseStreamMode(mode),
    encoding,
    ...(compressionLevel === undefined ? {} : { compressionLevel }),
  }
}

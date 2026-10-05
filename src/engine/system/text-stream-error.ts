import { TextStreamError } from '../../formats/text/errors.ts'
import { TvpError } from './tvp-error.ts'

/** Preserve the name supplied to the native-style stream constructor. Array
 * loads supply the original request; ScriptMgn first locates the script. The
 * caller selects that boundary here; the mapper never resolves an alias. */
export function mapTextStreamError(error: unknown, name: string): unknown {
  if (!(error instanceof TextStreamError)) return error
  switch (error.kind) {
    case 'unsupported-cipher':
      return new TvpError('TVPUnsupportedCipherMode', [name], error.message, { cause: error })
    case 'unsupported-mode':
      return new TvpError('TVPUnsupportedModeString', ['unsupported cipher mode'], error.message, { cause: error })
    case 'compression-failed':
      return new TvpError('TVPCompressionFailed', [], error.message, { cause: error })
  }
  return error
}

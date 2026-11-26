import { legacyNameEncoding, type LegacyNameEncoding } from '../text/legacy-names.ts'

export { cp437, legacyNameEncodings as zipNameEncodings, type LegacyNameEncoding as ZipNameEncoding } from '../text/legacy-names.ts'

/** ZIP's UTF-8 flag and valid Unicode Path extra take precedence over this choice. */
export const zipNameEncoding = (value: unknown): LegacyNameEncoding => legacyNameEncoding(value, ' ZIP 文件名')

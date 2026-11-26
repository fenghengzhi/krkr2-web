export const zipNameEncodings = ['cp437', 'shift_jis', 'gbk', 'big5', 'euc-kr', 'windows-1251', 'utf-8'] as const
export type ZipNameEncoding = typeof zipNameEncodings[number]

/** ZIP's UTF-8 flag and valid Unicode Path extra take precedence over this
 * choice. Older library records omit the setting and retain their CP437 names. */
export function zipNameEncoding(value: unknown): ZipNameEncoding {
  if (value === undefined) return 'cp437'
  for (const name of zipNameEncodings) if (value === name) return name
  throw new Error('未知的 ZIP 文件名编码')
}

// IBM CP437 high half; low bytes retain their character-code values in filenames.
const high =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
export function cp437(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += byte < 128 ? String.fromCharCode(byte) : high[byte - 128]
  return value
}

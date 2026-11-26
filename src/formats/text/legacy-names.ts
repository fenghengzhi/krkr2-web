export const legacyNameEncodings = ['cp437', 'cp850', 'cp866', 'shift_jis', 'gbk', 'big5', 'euc-kr', 'windows-1251', 'windows-1252', 'utf-8'] as const
export type LegacyNameEncoding = typeof legacyNameEncodings[number]

export function legacyNameEncoding(value: unknown, field: string): LegacyNameEncoding {
  if (value === undefined) return 'cp437'
  for (const name of legacyNameEncodings) if (value === name) return name
  throw new Error('未知的' + field + '编码')
}

// IBM CP437 high half; low bytes retain their character-code values in filenames.
const cp437High =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
// The Microsoft DOS Latin-1 and Cyrillic code pages use the same ASCII half.
// High halves follow Unicode's VENDORS/MICSFT/PC/CP850.TXT and CP866.TXT.
// The Unicode data license ships in public/licenses/unicode/LICENSE.txt.
const dosTables = {
  cp437: cp437High,
  cp850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  cp866: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ',
}
export function decodeDosName(bytes: Uint8Array, encoding: keyof typeof dosTables): string {
  const high = dosTables[encoding]
  let value = ''
  for (const byte of bytes) value += byte < 128 ? String.fromCharCode(byte) : high[byte - 128]
  return value
}

export const cp437 = (bytes: Uint8Array): string => decodeDosName(bytes, 'cp437')

export function dosNameDecoder(encoding: LegacyNameEncoding) {
  if (encoding === 'cp437' || encoding === 'cp850' || encoding === 'cp866')
    return (bytes: Uint8Array) => decodeDosName(bytes, encoding)
}

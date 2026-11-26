import { fontCandidateSource, fontCandidateFrameMismatch } from './font-candidate-game.ts'

export const localizedMinchoCases = [
  { face: 'ＭＳ Ｐ明朝,Krkr Synthetic wide', width: 20, wide: false },
  { face: 'MS PMincho,Krkr Synthetic wide', width: 20, wide: false },
  { face: 'Krkr Synthetic wide,ＭＳ Ｐ明朝', width: 36, wide: true },
  { face: 'ＭＳ 明朝,Krkr Synthetic narrow', width: 36, wide: true },
  { face: 'MS Mincho,Krkr Synthetic narrow', width: 36, wide: true },
  { face: 'Krkr Synthetic narrow,ＭＳ 明朝', width: 20, wide: false },
] as const

export const localizedMinchoGameSource = fontCandidateSource(localizedMinchoCases)
export const localizedMinchoFrameMismatch = (data: Uint8Array, width: number, height: number, phase: number) =>
  fontCandidateFrameMismatch(data, width, height, phase, localizedMinchoCases)

/** Rename only the family records of the project-owned 500/900-unit fixture.
 * The outlines and all glyph metrics remain authored independent references;
 * these files are not Microsoft fonts. Generated only by hosted tests. */
export function authoredMinchoFont(original: Uint8Array, family: 'MS PMincho' | 'MS Mincho'): Uint8Array {
  const bytes = Uint8Array.from(original), view = new DataView(bytes.buffer), tables: {
    record: number; tag: string; offset: number; length: number
  }[] = []
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16, tag = String.fromCharCode(...bytes.subarray(record, record + 4)),
      offset = view.getUint32(record + 8), length = view.getUint32(record + 12)
    if (offset + length > bytes.length) throw new Error('Authored font table exceeds input')
    tables.push({ record, tag, offset, length })
  }
  const names = tables.find((entry) => entry.tag === 'name'), head = tables.find((entry) => entry.tag === 'head')
  if (!names || !head) throw new Error('Missing authored font name/head table')
  const strings = names.offset + view.getUint16(names.offset + 4)
  let renamed = 0
  for (let i = 0; i < view.getUint16(names.offset + 2); i++) {
    const at = names.offset + 6 + i * 12, platform = view.getUint16(at)
    if (view.getUint16(at + 6) !== 1 || ![0, 1, 3].includes(platform)) continue
    const length = view.getUint16(at + 8), offset = strings + view.getUint16(at + 10),
      encoded = new Uint8Array(family.length * (platform === 1 ? 1 : 2))
    for (let c = 0; c < family.length; c++) encoded[c * (platform === 1 ? 1 : 2) + (platform === 1 ? 0 : 1)] = family.charCodeAt(c)
    if (encoded.length > length || offset + length > names.offset + names.length) throw new Error('Authored family record is too short')
    bytes.set(encoded, offset); view.setUint16(at + 8, encoded.length); renamed++
  }
  if (!renamed) throw new Error('No authored family record was renamed')
  const checksum = (offset: number, length: number) => {
    let sum = 0
    for (let at = 0; at < length; at += 4) {
      let word = 0
      for (let i = 0; i < 4; i++) word = word * 256 + (at + i < length ? bytes[offset + at + i]! : 0)
      sum = (sum + word) >>> 0
    }
    return sum
  }
  view.setUint32(head.offset + 8, 0)
  for (const table of tables) view.setUint32(table.record + 4, checksum(table.offset, table.length))
  view.setUint32(head.offset + 8, (0xb1b0afba - checksum(0, bytes.length)) >>> 0)
  return bytes
}

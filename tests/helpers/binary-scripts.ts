import { BinaryWriter } from '../../src/formats/binary/writer.ts'

export const binaryHeader = new Uint8Array([75, 66, 65, 68, 49, 48, 48, 0])
export type BinaryFixture =
  | undefined
  | null
  | bigint
  | number
  | string
  | Uint8Array
  | BinaryFixture[]
  | Map<string, BinaryFixture>

/** Independent format fixture encoder, including forms the native writer rarely emits. */
export function binaryValue(value: BinaryFixture): Uint8Array {
  const writer = new BinaryWriter()
  writer.append(binaryHeader)
  const write = (value: BinaryFixture) => {
    if (value === undefined) writer.u8(0xc1)
    else if (value === null) writer.u8(0xc0)
    else if (typeof value === 'bigint') {
      if (value >= -32n && value <= 127n) writer.u8(Number(value))
      else {
        writer.u8(0xd3)
        const bytes = new Uint8Array(8)
        new DataView(bytes.buffer).setBigInt64(0, value, true)
        writer.append(bytes)
      }
    } else if (typeof value === 'number') {
      writer.u8(0xcb)
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setFloat64(0, value, true)
      writer.append(bytes)
    } else if (typeof value === 'string') {
      if (value.length < 32) writer.u8(0xa0 + value.length)
      else if (value.length <= 255) {
        writer.u8(0xc4)
        writer.u8(value.length)
      } else if (value.length <= 65535) {
        writer.u8(0xc5)
        writer.u16(value.length)
      } else {
        writer.u8(0xc6)
        writer.u32(value.length)
      }
      for (let i = 0; i < value.length; i++) writer.u16(value.charCodeAt(i))
    } else if (value instanceof Uint8Array) {
      if (value.length < 6) writer.u8(0xd4 + value.length)
      else if (value.length <= 65535) {
        writer.u8(0xda)
        writer.u16(value.length)
      } else {
        writer.u8(0xdb)
        writer.u32(value.length)
      }
      writer.append(value)
    } else {
      const dictionary = value instanceof Map,
        size = dictionary ? value.size : value.length
      if (size < 16) writer.u8((dictionary ? 0x80 : 0x90) + size)
      else if (size <= 65535) {
        writer.u8(dictionary ? 0xde : 0xdc)
        writer.u16(size)
      } else {
        writer.u8(dictionary ? 0xdf : 0xdd)
        writer.u32(size)
      }
      if (value instanceof Map)
        for (const [key, item] of value) {
          write(key)
          write(item)
        }
      else for (const item of value) write(item)
    }
  }
  write(value)
  return writer.finish()
}

export const binaryScriptsFixture = () => ({
  'startup.tjs': `
var binary=Scripts.evalStorage("independent.bin");
if(!(binary instanceof Dictionary) || !(binary.items instanceof Array))throw "binary-native-types";
if(binary.large!=9007199254740993 || binary.negative!=-32 || binary[""]!="empty")throw "binary-values";
if(binary.items[0]!==void || binary.items[1]!==null || binary.items[2]!=1.25)throw "binary-elements";
if(binary.text!="日😀" || binary.bytes[2]!=255)throw "binary-text-or-octet";
(Dictionary.saveStruct incontextof binary)("savedata/roundtrip.bin","b");
var roundtrip=Scripts.execStorage("savedata/roundtrip.bin");
if(roundtrip.large!=binary.large || roundtrip[""]!="empty")throw "native-writer-roundtrip";
var offset=Scripts.evalStorage("prefixed.bin","o13");
if(offset.negative!=-32)throw "prefixed-binary";
var loaded=Dictionary.loadStruct("prefixed.bin","o13");
if(loaded.large!=binary.large)throw "structured-offset";
Scripts.compileStorage("prefix-source.tjs","savedata/prefix-code.cjs");
Debug.message("binary-scripts-ready");`,
  'prefix-source.tjs': 'global.prefixedResult=42;',
  'independent.bin': binaryValue(
    new Map([
      ['large', 9007199254740993n],
      ['negative', -32n],
      ['', 'empty'],
      ['text', '日😀'],
      ['items', [undefined, null, 1.25]],
      ['bytes', new Uint8Array([0, 127, 255])],
    ] as [string, BinaryFixture][]),
  ),
  'prefixed.bin': new Uint8Array([
    ...new Uint8Array(13).fill(0xee),
    ...binaryValue(
      new Map([
        ['large', 9007199254740993n],
        ['negative', -32n],
      ]),
    ),
  ]),
})

export interface BytecodeObjectOffsets {
  start: number
  length: number
  debugCount: number
  debug: number
  codeCount: number
  code: number
  codeWords: number[]
  dataCount: number
  data: number
  superCount: number
  superPointers: number
  propertiesCount: number
  properties: number
}
/** Locate documented container fields, independently of native validation. */
export function bytecodeOffsets(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 20
  const pools: { count: number; length?: number }[] = []
  for (const width of [1, 2, 4, 8, 8]) {
    const count = offset,
      size = data.getUint32(offset, true)
    pools.push({ count })
    offset += 4 + Math.ceil((size * width) / 4) * 4
  }
  for (const width of [2, 1]) {
    const count = offset,
      size = data.getUint32(offset, true)
    pools.push({ count, ...(size ? { length: offset + 4 } : {}) })
    offset += 4
    for (let i = 0; i < size; i++)
      offset += 4 + Math.ceil((data.getUint32(offset, true) * width) / 4) * 4
  }
  const objectsStart = 12 + data.getUint32(16, true),
    objects: BytecodeObjectOffsets[] = []
  offset = objectsStart + 16
  for (let i = 0; i < data.getUint32(objectsStart + 12, true); i++) {
    const length = offset + 4,
      start = offset + 8,
      debugCount = start + 48
    const debug = debugCount + 4,
      codeCount = debug + data.getUint32(debugCount, true) * 8
    const code = codeCount + 4,
      size = data.getUint32(codeCount, true)
    const dataCount = code + Math.ceil(size / 2) * 4,
      values = dataCount + 4
    const superCount = values + data.getUint32(dataCount, true) * 4,
      superPointers = superCount + 4
    const propertiesCount = superPointers + data.getUint32(superCount, true) * 4
    objects.push({
      start,
      length,
      debugCount,
      debug,
      codeCount,
      code,
      codeWords: Array.from({ length: size }, (_, word) => data.getInt16(code + word * 2, true)),
      dataCount,
      data: values,
      superCount,
      superPointers,
      propertiesCount,
      properties: propertiesCount + 4,
    })
    offset += 8 + data.getUint32(length, true)
  }
  return { pools, objectsStart, objects }
}

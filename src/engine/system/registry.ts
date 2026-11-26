import { foldWindowsName } from '../../formats/text/windows-name.ts'
import { decodeUtf16 } from '../../formats/text/stream.ts'
import { MAX_RESOURCE_BYTES, type Resource } from '../ports/storage.ts'

const roots = ['HKEY_CLASSES_ROOT', 'HKEY_CURRENT_CONFIG', 'HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE',
  'HKEY_USERS', 'HKEY_PERFORMANCE_DATA', 'HKEY_DYN_DATA']
type Value = string | bigint
type Decode = (bytes: Uint8Array) => Promise<string>

class Key {
  readonly children = new Map<string, Key>()
  readonly values = new Map<string, Value>()
}

export class GameRegistry {
  private readonly root = new Key()

  section(path: string, remove: boolean): Key | undefined {
    if (path.length > 32768) throw new Error('Registry section name is too long')
    const parts = foldWindowsName(path).split('\\')
    if (!roots.includes(parts[0]!) || parts.some((part) => part === '')) throw new Error('Invalid registry section')
    let key = this.root
    for (const [index, part] of parts.entries()) {
      if (remove && index === parts.length - 1) { key.children.delete(part); return }
      let child = key.children.get(part)
      if (!child) {
        if (remove) return
        child = new Key()
        key.children.set(part, child)
      }
      key = child
    }
    return key
  }

  read(path: string): Value | undefined {
    // TVP recognizes full root names case-sensitively before it asks Windows
    // for case-insensitive subkeys and the final (possibly unnamed) value.
    path = path.split('\0', 1)[0]!
    if (!path || path.length > 32768) return
    const root = roots.find((name) => path.startsWith(name))
    const tail = path.slice(root?.length ?? 0).replace(/^\\/, '')
    const parts = foldWindowsName(tail).split('\\'), value = parts.pop()!
    let key = this.root.children.get(root ?? 'HKEY_CURRENT_USER')
    for (const part of parts) key = key?.children.get(part)
    return key?.values.get(value)
  }
}

function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(["\\rn])/g, (_, ch: string) =>
    ch === 'r' ? '\r' : ch === 'n' ? '\n' : ch)
}

async function registryValue(text: string, legacy: boolean, decode: Decode, check: () => Promise<void>): Promise<Value | undefined> {
  if (text === '-') return
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return unquote(text)
  const dword = /^dword:([0-9a-f]{1,8})$/i.exec(text)
  if (dword) return BigInt('0x' + dword[1])
  const hex = /^hex(?:\(([0-9a-f]+)\))?:/i.exec(text)
  if (!hex) throw new Error('Invalid registry value')
  const type = hex[1] ? parseInt(hex[1], 16) : 3
  // Returning void also replaces any preceding supported value of this name.
  if (![1, 2, 4, 5].includes(type)) return
  const payload = text.slice(hex[0].length).trim()
  const size = payload ? (payload.length + 1) / 3 : 0
  if (!Number.isInteger(size)) throw new Error('Invalid registry hex data')
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    if (i && i % 65536 === 0) await check()
    const at = i * 3, byte = payload.slice(at, at + 2)
    if (!/^[\da-f]{2}$/i.test(byte) || i && payload[at - 1] !== ',') throw new Error('Invalid registry hex data')
    bytes[i] = parseInt(byte, 16)
  }
  if (type === 4 || type === 5) {
    if (size !== 4) throw new Error('Invalid registry DWORD size')
    return BigInt(new DataView(bytes.buffer).getUint32(0, type === 4))
  }
  if (legacy) {
    const nul = bytes.indexOf(0)
    return decode(nul < 0 ? bytes : bytes.subarray(0, nul))
  }
  if (size % 2) throw new Error('Invalid UTF-16 registry value')
  let end = 0
  while (end < size && (bytes[end] || bytes[end + 1])) end += 2
  // Data is an array of registry code units, so an initial U+FEFF is payload.
  return decodeUtf16(bytes.subarray(0, end))
}

/** Read the selected import as data. Names and deletions affect only this
 * in-memory snapshot. A parse failure cannot publish a partial registry. */
export async function readRegistryExport(file: Resource, decode: Decode, check: () => Promise<void>): Promise<GameRegistry> {
  if (file.size > MAX_RESOURCE_BYTES) throw new Error('Registry export exceeds 64 MiB')
  await check()
  const bytes = await file.read()
  if (bytes.length !== file.size) throw new Error('Incomplete registry export')
  const text = await decode(bytes), lines = /([^\r\n]*)(?:\r\n|\n|\r|$)/g
  const header = lines.exec(text)?.[1]?.replace(/^\ufeff/, '')
  const legacy = header === 'REGEDIT4'
  if (!legacy && header !== 'Windows Registry Editor Version 5.00') throw new Error('Unrecognized registry export header')
  const registry = new GameRegistry()
  let key: Key | undefined, count = 0
  const nextLine = () => lines.lastIndex >= text.length ? undefined : lines.exec(text)![1]!.trim()
  for (let line = nextLine(); line !== undefined; line = nextLine()) {
    if (++count % 256 === 0) await check()
    if (line === '' || /^[;#]/.test(line)) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      const remove = line.startsWith('[-')
      key = registry.section(line.slice(remove ? 2 : 1, -1), remove)
      continue
    }
    const entry = /^(@|"(?:[^"\\]|\\.)*")\s*=\s*/.exec(line)
    if (!entry || !key) throw new Error('Expected a value inside a registry section')
    const name = entry[1] === '@' ? '' : foldWindowsName(unquote(entry[1]!))
    let data = line.slice(entry[0].length)
    if (/^hex[(:]/i.test(data) && data.endsWith('\\')) {
      const pieces: string[] = []
      while (data.endsWith('\\')) {
        pieces.push(data.slice(0, -1))
        const part = nextLine()
        if (part === undefined) throw new Error('Incomplete registry hex continuation')
        data = part
        if (++count % 256 === 0) await check()
      }
      pieces.push(data)
      data = pieces.join('')
    }
    const value = await registryValue(data, legacy, decode, check)
    if (value === undefined) key.values.delete(name)
    else key.values.set(name, value)
  }
  await check()
  return registry
}

import { scriptList, scriptRecord, type ScriptValue } from '../script/runtime.ts'

/** One operation's TJS-owned value. It is never retained in parser state or
 * written into a bookmark; only the matching trampoline can resolve it. */
export class KagReference {
  constructor(readonly index: number) {}
}
export type Data =
  undefined | null | string | number | bigint | boolean | KagReference | Data[] | { [key: string]: Data }
export type RecordData = { [key: string]: Data }
/** Bindings live outside the public tag dictionary. User fields can have any
 * name, including values/references/__kagReference, without impersonating one. */
export function tagReferences(value: RecordData): { value: RecordData; references?: Data[] } {
  let result = value, references: Data[] | undefined
  for (const [name, entry] of Object.entries(value)) if (entry instanceof KagReference) {
    if (!references) { references = []; result = { ...value } }
    references.push([name, entry.index])
    result[name] = undefined
  }
  return references ? { value: result, references } : { value }
}
export function toScript(data: Data): ScriptValue {
  if (data instanceof KagReference) throw new Error('KAG reference escaped its tag transport')
  if (typeof data === 'boolean') return BigInt(data)
  if (typeof data === 'number') return Number.isInteger(data) ? BigInt(data) : data
  if (Array.isArray(data)) return scriptList(data.map(toScript))
  if (data !== null && typeof data === 'object')
    return scriptRecord(
      Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toScript(value)])),
    )
  return data
}
export function fromScript(value: ScriptValue): Data {
  if (value === null || typeof value !== 'object') return value
  if (!(value instanceof Uint8Array)) {
    if (value.type === 'array') return value.items.map(fromScript)
    if (value.type === 'dictionary')
      return Object.fromEntries(
        Object.entries(value.entries).map(([key, item]) => [key, fromScript(item)]),
      )
  }
  throw new Error('KAG state must contain plain Array/Dictionary data')
}
export function record(value: Data): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof KagReference)
    throw new Error('Malformed KAG dictionary')
  return value
}
export function list(value: Data): Data[] {
  if (!Array.isArray(value)) throw new Error('Malformed KAG array')
  return value
}
export const string = (value: Data): string => {
  if (value instanceof KagReference) throw new Error('KAG reference requires native string conversion')
  return value == null ? '' : String(value)
}
export function integer(value: Data, fallback = 0): number {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('Malformed KAG integer')
  return result
}

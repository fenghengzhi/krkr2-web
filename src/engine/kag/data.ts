import { scriptList, scriptRecord, type ScriptValue } from '../script/runtime.ts'

export type Data =
  undefined | null | string | number | bigint | boolean | Data[] | { [key: string]: Data }
export type RecordData = { [key: string]: Data }
export function toScript(data: Data): ScriptValue {
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed KAG dictionary')
  return value
}
export function list(value: Data): Data[] {
  if (!Array.isArray(value)) throw new Error('Malformed KAG array')
  return value
}
export const string = (value: Data): string => (value == null ? '' : String(value))
export function integer(value: Data, fallback = 0): number {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('Malformed KAG integer')
  return result
}

import { decodeUtf8 } from '../text/utf8.ts'
import type { LoopInfo, LoopLink } from '../../engine/ports/audio.ts'
import { emptyLoops } from '../../engine/ports/audio.ts'

/** Syntax rejection is native ReadInformation(false). Budgets and unsafe
 * native indices remain separate Web errors. */
export class SliSyntaxError extends Error {
  constructor(message: string) { super(message); this.name = 'SliSyntaxError' }
}
const conditions: readonly LoopLink['condition'][] = ['no', 'eq', 'ne', 'gt', 'ge', 'lt', 'le']
const space = (value: string | undefined) => value !== undefined && /^[\t\n\v\f\r ]$/.test(value)
const numericSpace = (value: string | undefined) => value !== undefined && value.charCodeAt(0) > 0 && value.charCodeAt(0) <= 32
const syntax = (message: string): never => { throw new SliSyntaxError(message) }
export const checkSliSize = (length: number) => {
  if (length > 16 * 1024 * 1024) throw new Error('SLI text exceeds the 16 MiB Web budget')
}
/** GetInt/GetInt64 accept a decimal prefix, no leading plus, and return zero
 * for a nonempty nonnumeric value. Do not emulate native signed overflow. */
function integer(value: string, name: string, small = false): number {
  let at = 0
  while (numericSpace(value[at])) at++
  if (at === value.length) return syntax(`Invalid SLI ${name}`)
  const negative = value[at] === '-'
  if (negative) {
    at++
    while (numericSpace(value[at])) at++
    if (at === value.length) return syntax(`Invalid SLI ${name}`)
  }
  const start = at
  while (value[at] !== undefined && value[at]! >= '0' && value[at]! <= '9') at++
  const number = Number(value.slice(start, at) || '0') * (negative ? -1 : 1)
  if (!Number.isSafeInteger(number) || (small && (number < -0x80000000 || number > 0x7fffffff)))
    throw new Error(`SLI ${name} exceeds the safe Web integer range`)
  return number === 0 ? 0 : number
}
function parse(text: string, label: (value: string) => string): LoopInfo {
  checkSliSize(text.length)
  const nul = text.indexOf('\0')
  if (nul >= 0) text = text.slice(0, nul)
  const result = emptyLoops()
  if (!text.startsWith('#')) {
    const startAt = text.indexOf('LoopStart='), lengthAt = text.indexOf('LoopLength=')
    if (startAt < 0 || lengthAt < 0) return syntax('Invalid SLI legacy loop information')
    const to = integer(text.slice(startAt + 10), 'LoopStart'), length = integer(text.slice(lengthAt + 11), 'LoopLength'), from = to + length
    if (!Number.isSafeInteger(from)) throw new Error('SLI loop end exceeds safe sample range')
    if (to < 0 || from < 0) throw new Error('SLI link is outside the safe Web sample range')
    result.links.push({ from, to, smooth: false, condition: 'no', variable: 0, reference: 0 })
    return result
  }
  // Original strncmp(...,5)>0 accepts earlier version comment lines too.
  if (text.slice(0, 5) > '#2.00') return syntax('Unsupported SLI version')
  let pos = 0
  const whitespace = () => { while (space(text[pos])) pos++ }
  function entity(): [string, string] {
    whitespace()
    const start = pos
    while (pos < text.length && !space(text[pos]) && text[pos] !== '=') pos++
    const name = text.slice(start, pos).toLowerCase()
    whitespace()
    if (!name || text[pos++] !== '=') return syntax('Malformed SLI field')
    whitespace()
    if (pos === text.length) return syntax('Missing SLI value')
    let value: string
    if (text[pos] === "'") {
      const from = ++pos
      while (pos < text.length && text[pos] !== "'") pos++
      if (pos === text.length) return syntax('Unterminated SLI text')
      value = text.slice(from, pos++)
      whitespace()
      if (text[pos++] !== ';') return syntax('SLI quoted field requires a semicolon')
    } else {
      const from = pos
      while (pos < text.length && !space(text[pos]) && text[pos] !== ';') pos++
      value = text.slice(from, pos)
      if (pos === text.length) return syntax('Unterminated SLI field')
      // GetEntityToken overwrites the first space/semicolon with NUL;
      // Read*Information advances past it. Both delimiters are accepted.
      pos++
    }
    return [name, value]
  }
  while (pos < text.length) {
    if ((pos === 0 || text[pos - 1] === '\n') && text[pos] === '#') {
      while (pos < text.length && text[pos] !== '\n') pos++
      if (pos < text.length) pos++
      continue
    }
    whitespace()
    if (pos === text.length) break
    const start = pos
    while (pos < text.length && /[a-z]/i.test(text[pos]!)) pos++
    const kind = text.slice(start, pos).toLowerCase()
    if (kind !== 'link' && kind !== 'label') return syntax('Unknown SLI record')
    whitespace()
    if (text[pos++] !== '{') return syntax('Malformed SLI record')
    const link: LoopLink = { from: 0, to: 0, smooth: false, condition: 'no', variable: 0, reference: 0 },
      entry = { position: 0, name: '' }
    do {
      const [name, value] = entity()
      if (kind === 'link') {
        if (name === 'from' || name === 'to') link[name] = integer(value, name)
        else if (name === 'condvar') link.variable = integer(value, name, true)
        else if (name === 'refvalue') link.reference = integer(value, name, true)
        else if (name === 'condition') {
          const condition = value.toLowerCase()
          if (!conditions.includes(condition as LoopLink['condition'])) return syntax('Unknown SLI condition')
          link.condition = condition as LoopLink['condition']
        } else if (name === 'smooth') {
          const bool = value.toLowerCase()
          if (!['true', 'false', 'yes', 'no'].includes(bool)) return syntax('Invalid SLI Smooth')
          link.smooth = bool === 'true' || bool === 'yes'
        } else return syntax('Unknown SLI link field')
      } else if (name === 'position') entry.position = integer(value, name)
      else if (name === 'name') entry.name = label(value)
      else return syntax('Unknown SLI label field')
      whitespace()
      if (pos === text.length) return syntax('Unterminated SLI record')
    } while (text[pos] !== '}')
    pos++
    if (kind === 'link') {
      if (link.from < 0 || link.to < 0 || link.variable < -1 || link.variable >= 16)
        throw new Error('SLI link is outside the safe Web range')
      result.links.push(link)
    } else {
      if (entry.position < 0) throw new Error('SLI label is outside the safe Web sample range')
      result.labels.push(entry)
    }
    if (result.links.length + result.labels.length > 100000) throw new Error('SLI event budget exceeded')
    whitespace()
  }
  // Native operator< prioritizes condition, then flag index. Preserve the
  // existing stable order only when all native comparator keys are equal.
  result.links.sort((a, b) => a.from - b.from || conditions.indexOf(b.condition) - conditions.indexOf(a.condition) || b.variable - a.variable)
  result.labels.sort((a, b) => a.position - b.position)
  return result
}
export function parseSli(text: string): LoopInfo { return parse(text, (value) => value) }
/** WaveImpl reads raw bytes, not a TJS text stream. Only Name is UTF-8
 * converted by GetString; arbitrary comment bytes do not trigger decoding. */
export function parseSliBytes(bytes: Uint8Array): LoopInfo {
  checkSliSize(bytes.length)
  let text = ''
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return parse(text, (value) => {
    const label = Uint8Array.from(value, (character) => character.charCodeAt(0)),
      decoded = decodeUtf8(label, () => new SliSyntaxError('Invalid UTF-8 SLI label'))
    let step = decoded.next()
    while (!step.done) step = decoded.next()
    return step.value
  })
}
/** ++/-- may parse an operand but always change by one. Invalid expressions
 * still remain ordinary label notifications. Only unsigned decimal tokens
 * exist in the original label expression grammar. */
function readSliExpression(name: string) {
  const nul = name.indexOf('\0')
  if (nul >= 0) name = name.slice(0, nul)
  const match = /^:[\x01-\x20]*\[[\x01-\x20]*(\d+)[\x01-\x20]*\][\x01-\x20]*(\+\+|--|\+=|-=|=)[\x01-\x20]*(?:(\d+)|\[[\x01-\x20]*(\d+)[\x01-\x20]*\])?[\x01-\x20]*$/.exec(name)
  if (!match) return undefined
  const index = Number(match[1]), operator = match[2]!, indirect = match[4] === undefined ? undefined : Number(match[4]),
    literal = Number(match[3] ?? 0)
  if (index >= 16 || (indirect !== undefined && indirect >= 16) ||
      (!['++', '--'].includes(operator) && match[3] === undefined && indirect === undefined) ||
      !Number.isInteger(literal) || literal < 0 || literal > 0x7fffffff) return undefined
  return { index, operator, indirect, literal }
}
/** Identify real flag-writing labels without evaluating or changing flags. */
export const sliExpressionTarget = (name: string): number | undefined => readSliExpression(name)?.index

export function applySliExpression(flags: number[], name: string): boolean {
  const expression = readSliExpression(name)
  if (!expression) return false
  const { index, operator, indirect, literal } = expression,
    operand = indirect === undefined ? literal : flags[indirect]!
  if (!Number.isInteger(operand) || operand < 0 || operand > 0x7fffffff) return false
  const previous = flags[index]!, value = operator === '=' ? operand : operator === '++' ? previous + 1
    : operator === '--' ? previous - 1 : operator === '+=' ? previous + operand : previous - operand
  flags[index] = Math.max(0, Math.min(9999, value))
  return true
}

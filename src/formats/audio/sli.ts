import type { LoopInfo, LoopLink } from '../../engine/ports/audio.ts'
import { emptyLoops } from '../../engine/ports/audio.ts'

export function parseSli(text: string): LoopInfo {
  const result = emptyLoops()
  const integer = (value: string | undefined, name: string): number => {
    if (value === undefined || !/^[-+]?\d+$/.test(value)) throw new Error(`Invalid SLI ${name}`)
    const number = Number(value)
    if (!Number.isSafeInteger(number)) throw new Error(`SLI ${name} exceeds safe sample range`)
    return number
  }
  if (!text.startsWith('#')) {
    const start = integer(/LoopStart\s*=\s*(\d+)/.exec(text)?.[1], 'LoopStart'),
      length = integer(/LoopLength\s*=\s*(\d+)/.exec(text)?.[1], 'LoopLength')
    if (length <= 0) throw new Error('SLI loop length must be positive')
    result.links.push({
      from: start + length,
      to: start,
      smooth: false,
      condition: 'no',
      variable: 0,
      reference: 0,
    })
    return result
  }
  if (!/^#2\.00/.test(text)) throw new Error('Unsupported SLI version')
  const input = text.replace(/^#.*$/gm, '')
  let pos = 0
  const whitespace = () => {
    while (/\s/.test(input[pos] ?? '') && pos < input.length) pos++
  }
  const word = () => {
    const start = pos
    while (/[\w+-]/.test(input[pos] ?? '') && pos < input.length) pos++
    return input.slice(start, pos)
  }
  while (true) {
    whitespace()
    if (pos >= input.length) break
    const kind = word().toLowerCase()
    whitespace()
    if (input[pos++] !== '{') throw new Error('Malformed SLI record')
    const fields: Record<string, string> = Object.create(null)
    while (true) {
      whitespace()
      if (input[pos] === '}') {
        pos++
        break
      }
      const key = word().toLowerCase()
      whitespace()
      if (!key || input[pos++] !== '=') throw new Error('Malformed SLI field')
      whitespace()
      let value = ''
      if (input[pos] === '"' || input[pos] === "'") {
        const quote = input[pos++]!
        while (pos < input.length && input[pos] !== quote) {
          if (input[pos] === '\\') {
            pos++
            if (pos >= input.length) throw new Error('Truncated SLI escape')
          }
          value += input[pos++]
        }
        if (input[pos++] !== quote) throw new Error('Unterminated SLI text')
      } else value = word()
      whitespace()
      if (input[pos++] !== ';') throw new Error('SLI field requires a semicolon')
      fields[key] = value
    }
    if (kind === 'link') {
      const condition = (fields.condition ?? 'no').toLowerCase() as LoopLink['condition']
      if (!['no', 'eq', 'ne', 'gt', 'ge', 'lt', 'le'].includes(condition))
        throw new Error('Unknown SLI condition')
      const from = integer(fields.from, 'From'),
        to = integer(fields.to, 'To'),
        variable = integer(fields.condvar ?? '0', 'CondVar'),
        reference = integer(fields.refvalue ?? '0', 'RefValue')
      if (from < 0 || to < 0 || variable < -1 || variable >= 16)
        throw new Error('SLI link is outside range')
      result.links.push({
        from,
        to,
        condition,
        variable,
        reference,
        smooth: (fields.smooth ?? 'false').toLowerCase() === 'true',
      })
    } else if (kind === 'label') {
      const position = integer(fields.position, 'Position')
      if (position < 0 || fields.name === undefined) throw new Error('Invalid SLI label')
      result.labels.push({ position, name: fields.name })
    } else throw new Error(`Unknown SLI record: ${kind}`)
    if (result.links.length + result.labels.length > 100000)
      throw new Error('SLI event budget exceeded')
  }
  result.links.sort((a, b) => a.from - b.from)
  result.labels.sort((a, b) => a.position - b.position)
  return result
}

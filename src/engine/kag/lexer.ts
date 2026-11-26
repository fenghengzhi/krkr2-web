import { TvpError } from '../system/tvp-error.ts'

export interface Attribute {
  name: string
  value: string
  entity: boolean
  parameter: boolean
  forward?: boolean
  end: number
}
export interface LexedTag {
  name: string
  end: number
  raw: string
  lineCommand: boolean
}
export interface TagCursor { source: string; position: number }
const space = (ch: string | undefined) => ch === ' ' || ch === '\t'
/** KAG's ttstr::ToLowerCase folds ASCII letters only. Unicode names remain
 * distinct dictionary keys, including fullwidth and non-Latin capitals. */
export const lowerKagName = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))
export class KagTagSyntaxError extends TvpError {
  constructor(readonly position: number) { super('TVPKAGSyntaxError') }
}
export function lexTag(line: string, start: number, lineCommand: boolean) {
  let pos = start + 1
  const ended = () => (lineCommand ? pos === line.length : line[pos] === ']')
  const fail = (): never => {
    throw new KagTagSyntaxError(pos)
  }
  const skip = () => {
    while (space(line[pos])) pos++
  }
  skip()
  const nameStart = pos
  while (pos < line.length && !space(line[pos]) && !ended()) pos++
  if (nameStart === pos) fail()
  const name = lowerKagName(line.slice(nameStart, pos))
  const resume = (cursor: TagCursor | undefined) => {
    if (!cursor) return
    line = cursor.source
    pos = cursor.position
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > line.length) fail()
  }
  function* fields(): Generator<Attribute, LexedTag, TagCursor | undefined> {
    while (true) {
      skip()
      if (ended()) {
        const end = lineCommand ? pos : pos + 1
        return {
          name,
          end,
          raw: lineCommand ? `[${line.slice(start + 1, end)}]` : line.slice(start, end),
          lineCommand,
        }
      }
      if (pos >= line.length) fail()
      if (line[pos] === '*') {
        pos++
        resume(yield { name: '', value: '', entity: false, parameter: false, forward: true, end: pos })
        continue
      }
      const attributeStart = pos
      while (pos < line.length && !space(line[pos]) && line[pos] !== '=' && !ended()) pos++
      if (pos === attributeStart) fail()
      const attribute = lowerKagName(line.slice(attributeStart, pos))
      skip()
      let value = 'true',
        entity = false,
        parameter = false
      if (line[pos] === '=') {
        pos++
        skip()
        if (pos === line.length) fail()
        if (line[pos] === '&') {
          entity = true
          pos++
        } else if (line[pos] === '%') {
          parameter = true
          pos++
        }
        const delimiter = line[pos] === '"' || line[pos] === "'" ? line[pos++] : undefined
        const valueStart = pos
        while (
          pos < line.length &&
          (delimiter ? line[pos] !== delimiter : !space(line[pos]) && !ended())
        ) {
          if (line[pos] === '`' && ++pos === line.length) fail()
          pos++
        }
        if ((delimiter && line[pos] !== delimiter) || (!lineCommand && pos === line.length)) fail()
        value = line.slice(valueStart, pos)
        if (delimiter) pos++
        // A quoted leading &/% is also active; a backtick protects the marker.
        if (!entity && value[0] === '&') {
          entity = true
          value = value.slice(1)
        }
        if (!parameter && value[0] === '%') {
          parameter = true
          value = value.slice(1)
        }
        value = value.replace(/`([\s\S])/g, '$1')
      }
      // An entity can synchronously read this parser again. Native resumes
      // from its live CurLineStr/CurPos, not the line that started the tag.
      resume(yield { name: attribute, value, entity, parameter, end: pos })
    }
  }
  return { name, fields: fields() }
}

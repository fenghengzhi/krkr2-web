export interface Attribute {
  name: string
  value: string
  entity: boolean
  parameter: boolean
  forward?: boolean
}
export interface LexedTag {
  name: string
  attributes: Attribute[]
  end: number
  raw: string
  lineCommand: boolean
}
const space = (ch: string | undefined) => ch === ' ' || ch === '\t'
export function lexTag(line: string, start: number, lineCommand: boolean): LexedTag {
  let pos = start + 1
  const ended = () => (lineCommand ? pos === line.length : line[pos] === ']')
  const fail = (): never => {
    throw new Error(`Malformed KAG tag at column ${pos + 1}: ${line}`)
  }
  const skip = () => {
    while (space(line[pos])) pos++
  }
  skip()
  const nameStart = pos
  while (pos < line.length && !space(line[pos]) && !ended()) pos++
  if (nameStart === pos) fail()
  const name = line.slice(nameStart, pos).toLowerCase()
  const attributes: Attribute[] = []
  while (true) {
    skip()
    if (ended()) {
      const end = lineCommand ? pos : pos + 1
      return {
        name,
        attributes,
        end,
        raw: lineCommand ? `[${line.slice(start + 1, end)}]` : line.slice(start, end),
        lineCommand,
      }
    }
    if (pos >= line.length) fail()
    if (line[pos] === '*') {
      pos++
      attributes.push({ name: '', value: '', entity: false, parameter: false, forward: true })
      continue
    }
    const attributeStart = pos
    while (pos < line.length && !space(line[pos]) && line[pos] !== '=' && !ended()) pos++
    if (pos === attributeStart) fail()
    const attribute = line.slice(attributeStart, pos).toLowerCase()
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
    attributes.push({ name: attribute, value, entity, parameter })
  }
}

const skipCode = '\uffff'
const escaped: Readonly<Record<string, string>> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
}
const space = (character: string | undefined) => character !== undefined &&
  (character === ' ' || character >= '\t' && character <= '\r')

function hex(character: string | undefined): number {
  if (character === undefined) return -1
  const code = character.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

/** TJSParseString, not JSON or evaluation. Windows tjs_char is UTF-16. */
function quoted(input: string, line: number): string {
  const delimiter = input[0]!
  let at = 0, result = ''
  const next = () => {
    do at++
    while (input[at] === skipCode)
    return at < input.length && input[at] !== '\0'
  }
  const appendCode = (code: number) => {
    // Original ttstr += tjs_char appends a two-character C string. A zero
    // code unit therefore appends nothing; it does not truncate prior text.
    if (code) result += String.fromCharCode(code)
  }
  next()
  while (at < input.length && input[at] !== '\0') {
    const character = input[at]!
    if (character === '\\') {
      if (!next()) break
      const escape = input[at]!
      if (escape === 'x' || escape === 'X') {
        if (!next()) break
        let code = 0, count = 0, digit: number
        while ((digit = hex(input[at])) >= 0 && count < 4) {
          code = code * 16 + digit
          count++
          if (!next()) break
        }
        if (at >= input.length || input[at] === '\0') break
        appendCode(code)
      } else if (escape === '0') {
        if (!next()) break
        let code = 0
        while (input[at] !== undefined && input[at]! >= '0' && input[at]! <= '7') {
          // Only the final Windows UTF-16 code unit is retained. Keep that
          // bounded value while accepting native's variable-length octal run.
          code = (code * 8 + input[at]!.charCodeAt(0) - 48) & 0xffff
          if (!next()) break
        }
        if (at >= input.length || input[at] === '\0') break
        appendCode(code)
      } else {
        result += escaped[escape] ?? escape
        next()
      }
    } else if (character === delimiter) {
      if (!next()) return result
      let following = at
      while (space(input[following]) || input[following] === skipCode) following++
      if (input[following] !== delimiter) return result
      // Same-delimiter adjacent literals concatenate; unlike a script lexer,
      // this entry point does not scan comments or mixed-delimiter literals.
      at = following
      next()
    } else {
      result += character
      next()
    }
  }
  throw new Error(`Unterminated quoted engine option on line ${line}`)
}

/** Parse decoded .cf/.cfu text using SysInitImpl's PushConfigFileOptions and
 * TVPParseCommandLineOne. Keys include the prepended '-', preserve spelling
 * and whitespace, and keep the first occurrence as TVPGetCommandLine does.
 * Decoding, file discovery, layer priority and option validation belong to
 * the caller. A terminal line separator adds no phantom empty option. */
export function parseEngineConfig(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (let at = 0, lineNumber = 1; at < text.length; lineNumber++) {
    let end = at, nul = -1
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') {
      if (text[end] === '\0' && nul < 0) nul = end
      end++
    }
    // ttstr(AnsiString) reads its C string; source NUL ends this option line.
    const line = text.slice(at, nul < 0 ? end : nul)
    at = end + (end === text.length ? 0 : text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1)
    if (line.startsWith(';')) continue
    const equal = line.indexOf('='), name = '-' + (equal < 0 ? line : line.slice(0, equal)),
      raw = equal < 0 ? 'yes' : line.slice(equal + 1),
      value = raw[0] === '"' || raw[0] === "'" ? quoted(raw, lineNumber) : raw
    // Parse every line even if its key already exists: a malformed duplicate
    // also reaches TJSParseString before native performs any option lookup.
    if (!result.has(name)) result.set(name, value)
  }
  return result
}

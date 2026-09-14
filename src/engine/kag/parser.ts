import { Scenario } from './scenario.ts'
import { lexTag, type LexedTag } from './lexer.ts'
import { integer, list, record, string, type Data, type RecordData } from './data.ts'

export interface Effect {
  kind: string
  args: Data[]
}
export type Task = Generator<Effect, Data, Data>
const special = new Set([
  'if',
  'ignore',
  'endif',
  'endignore',
  'else',
  'elsif',
  'emb',
  'macro',
  'endmacro',
  'macropop',
  'erasemacro',
  'jump',
  'call',
  'return',
])
const tag = (tagname: string, attributes: RecordData = {}): RecordData => ({
  tagname,
  ...attributes,
  taglist: ['tagname', ...Object.keys(attributes)],
})
const hexStack = (values: number[]) =>
  values.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('')
function parseHex(value: Data): number[] {
  const encoded = string(value)
  if (!/^(?:[0-9a-fA-F]{8})*$/.test(encoded)) throw new Error('Malformed KAG condition stack')
  return encoded.match(/.{8}/g)?.map((word) => parseInt(word, 16) | 0) ?? []
}

/** State machine for the native KAGParser contract. Effects are resumed by a
 * TJS trampoline: expression evaluation never re-enters a suspended JS frame. */
export class KagParser {
  private scenario?: Scenario
  curLine = 0
  curPos = 0
  curLabel = ''
  private buffer?: string
  private tagLine = 0
  private interrupted = false
  private recording?: { name: string; source: string }
  private excludeLevel = -1
  private excludes: number[] = []
  private executed: boolean[] = []
  private macroBase = 0
  private macroDepth = 0
  private calls: RecordData[] = []
  processSpecialTags = true
  ignoreCR = false
  debugLevel = 1
  get curStorage(): string {
    return this.scenario?.name ?? ''
  }
  get curLineStr(): string {
    return this.buffer ?? this.scenario?.lines[this.curLine] ?? ''
  }
  get callStackDepth(): number {
    return this.calls.length
  }

  private *effect(kind: string, ...args: Data[]): Task {
    return yield { kind, args }
  }
  private *callback(name: string, ...args: Data[]): Task {
    return yield* this.effect('callback', name, args)
  }
  private *evaluate(expression: Data, boolean = false): Task {
    if (!string(expression)) throw new Error('KAG expression is empty')
    return yield* this.effect('eval', string(expression), boolean, this.curStorage, this.tagLine)
  }
  private *popTo(depth: number): Task {
    if (depth < 0 || depth > this.macroDepth) throw new Error('KAG macro argument stack underflow')
    this.macroDepth = depth
    yield* this.effect('popParams', depth)
    return
  }
  private *breakCondition(): Task {
    this.recording = undefined
    this.excludeLevel = -1
    this.excludes = []
    this.executed = []
    yield* this.popTo(this.macroBase)
    return
  }
  *loadScenario(name: string, force = false): Task {
    yield* this.breakCondition()
    if (!this.scenario || this.curStorage !== name || force) {
      this.scenario = undefined
      const provided = yield* this.callback('onScenarioLoad', name)
      const source = typeof provided === 'string' ? provided : yield* this.effect('read', name)
      this.scenario = new Scenario(name, string(source))
      if (this.debugLevel >= 1) yield* this.effect('log', `Scenario loaded : ${name}`)
    }
    this.curLine = this.curPos = 0
    this.buffer = undefined
    yield* this.callback('onScenarioLoaded', name)
    return
  }
  *goToLabel(name: string): Task {
    if (!name) return
    if (!this.scenario) throw new Error('No scenario is loaded')
    this.curLine = this.scenario.find(name)
    this.curPos = 0
    this.buffer = undefined
    this.curLabel = this.scenario.label(this.curLine)
    yield* this.breakCondition()
  }
  private *goTo(storage: Data, target: Data): Task {
    if (string(storage)) yield* this.loadScenario(string(storage))
    if (string(target)) yield* this.goToLabel(string(target))
    return
  }
  *callLabel(name: string): Task {
    this.pushCall()
    yield* this.goToLabel(name)
    return
  }
  private pushCall(): void {
    if (this.calls.length >= 4096) throw new Error('KAG call stack budget exceeded')
    let line = this.curLine - 1,
      label = ''
    while (line >= 0) {
      label = this.scenario?.label(line) ?? ''
      if (label) break
      line--
    }
    this.calls.push({
      storage: this.curStorage,
      label,
      offset: this.curLine - Math.max(0, line),
      orgLineStr: this.scenario?.lines[this.curLine] ?? '',
      lineBuffer: this.buffer ?? '',
      pos: this.curPos,
      lineBufferUsing: this.buffer !== undefined,
      macroArgStackBase: this.macroBase,
      macroArgStackDepth: this.macroDepth,
      ...this.conditions(),
    })
    this.macroBase = this.macroDepth
  }
  private *popCall(storage: Data, target: Data): Task {
    const frame = this.calls.at(-1)
    if (!frame) throw new Error('KAG return without matching call')
    this.macroBase = integer(frame.macroArgStackDepth)
    yield* this.popTo(this.macroBase)
    if (string(storage) || string(target)) yield* this.goTo(storage, target)
    else {
      yield* this.loadScenario(string(frame.storage))
      yield* this.goToLabel(string(frame.label))
      this.curLine += integer(frame.offset)
      if (
        this.curLine > this.scenario!.lines.length ||
        (this.curLine < this.scenario!.lines.length &&
          this.scenario!.lines[this.curLine] !== frame.orgLineStr)
      )
        throw new Error('KAG return position was lost because the scenario changed')
      this.curPos = integer(frame.pos)
      this.buffer = frame.lineBufferUsing ? string(frame.lineBuffer) : undefined
      this.restoreConditions(frame)
    }
    this.macroBase = integer(frame.macroArgStackBase)
    this.calls.pop()
    yield* this.callback('onAfterReturn')
    return
  }
  *clearCallStack(): Task {
    this.calls = []
    this.macroBase = 0
    yield* this.popTo(0)
    return
  }
  *clear(): Task {
    this.scenario = undefined
    this.curLine = this.curPos = 0
    this.buffer = undefined
    yield* this.clearCallStack()
    yield* this.breakCondition()
    return
  }
  interrupt(): void {
    this.interrupted = true
  }
  resetInterrupt(): void {
    this.interrupted = false
  }
  *popMacroArgs(): Task {
    yield* this.popTo(this.macroDepth - 1)
    return
  }
  private nextLine(): void {
    this.curLine++
    this.curPos = 0
    this.buffer = undefined
  }

  private *skipLines(): Task {
    let work = 0
    while (this.scenario && this.curLine < this.scenario.lines.length) {
      if (++work % 1024 === 0) yield* this.effect('yield')
      const source = this.curLineStr
      if (source.startsWith(';')) {
        this.nextLine()
        continue
      }
      if (source.startsWith('*')) {
        if (this.recording) throw new Error('A label is not allowed inside a KAG macro')
        this.curLabel = this.scenario.label(this.curLine)
        const separator = source.indexOf('|')
        yield* this.callback(
          'onLabel',
          this.curLabel,
          separator < 0 ? undefined : source.slice(separator + 1),
        )
        this.nextLine()
        continue
      }
      if (/^(?:\[iscript\]\\?|@iscript)$/.test(source)) {
        if (this.recording) throw new Error('An iscript block is not allowed inside a KAG macro')
        this.nextLine()
        const start = this.curLine
        let script = ''
        while (
          this.curLine < this.scenario.lines.length &&
          !/^(?:\[endscript\]\\?|@endscript)$/.test(this.curLineStr)
        ) {
          if (++work % 1024 === 0) yield* this.effect('yield')
          script += this.curLineStr + '\r\n'
          this.nextLine()
        }
        if (this.curLine === this.scenario.lines.length)
          throw new Error('KAG iscript has no matching endscript')
        if (this.excludeLevel === -1)
          yield* this.callback('onScript', script, this.curStorage.replace(/^.*[\\/>]/, ''), start)
        this.nextLine()
        continue
      }
      return true
    }
    return false
  }
  private advance(token: LexedTag): void {
    if (token.lineCommand) this.nextLine()
    else this.curPos = token.end
  }
  private recordText(text: string): void {
    if (!this.recording) return
    if (this.recording.source.length + text.length > 8 * 1024 * 1024)
      throw new Error('KAG macro definition exceeds text budget')
    this.recording.source += text
  }
  private insert(token: LexedTag, source: string, start: number): void {
    const old = this.curLineStr
    const buffer =
      old.slice(0, start) +
      source +
      old.slice(token.end) +
      (token.lineCommand && !this.ignoreCR ? '\\' : '')
    if (buffer.length > 8 * 1024 * 1024) throw new Error('KAG macro expansion exceeds text budget')
    this.buffer = buffer
    this.curPos = start
  }
  private *attributes(token: LexedTag): Task {
    const values: RecordData = { tagname: token.name }
    const names: Data[] = ['tagname']
    let condition = true
    for (const attribute of token.attributes) {
      if (attribute.forward) {
        if (!this.recording) {
          const current = yield* this.effect('params')
          if (current !== null) {
            const params = record(record(current).values)
            for (const name of list(record(current).names)) {
              if (name === 'tagname') continue
              values[string(name)] = params[string(name)]
              names.push(name)
            }
          }
        }
        continue
      }
      let value: Data = attribute.value
      if (
        (!this.recording && this.excludeLevel === -1) ||
        (token.name === 'elsif' && this.processSpecialTags)
      ) {
        if (attribute.entity) value = yield* this.evaluate(value)
        else if (attribute.parameter) {
          const current = yield* this.effect('params')
          if (current !== null) {
            const params = record(record(current).values),
              separator = attribute.value.indexOf('|')
            value = params[separator < 0 ? attribute.value : attribute.value.slice(0, separator)]
            if (value === undefined && separator >= 0) value = attribute.value.slice(separator + 1)
          }
        }
        if (attribute.name === 'cond') {
          condition = !!(yield* this.evaluate(value, true))
          continue
        }
      }
      values[attribute.name] = value
      names.push(attribute.name)
    }
    values.taglist = names
    return { values, condition }
  }
  *getNextTag(): Task {
    // EOF takes precedence over interrupt in the native class.
    if (!this.scenario || this.curLine >= this.scenario.lines.length) return
    for (let work = 0; ; work++) {
      // Long skipped text and macro definitions remain cancellable in a Worker.
      if (work % 1024 === 1023) yield* this.effect('yield')
      if (this.interrupted) {
        this.interrupted = false
        return tag('interrupt')
      }
      if (!this.scenario || this.curLine >= this.scenario.lines.length) return
      if (this.buffer === undefined && this.curPos === 0 && !(yield* this.skipLines())) return
      const source = this.curLineStr
      const start = this.curPos
      this.tagLine = this.curLine
      if (
        !this.ignoreCR &&
        (source.slice(start) === '\\' || (start === source.length && source.endsWith('[p]')))
      ) {
        this.nextLine()
        continue
      }
      if (start >= source.length) {
        this.nextLine()
        if (this.ignoreCR) continue
        if (this.recording) this.recordText('[r eol=true]')
        else if (this.excludeLevel === -1) return tag('r', { eol: 'true' })
        continue
      }
      const lineCommand = this.buffer === undefined && start === 0 && source[0] === '@'
      if (!lineCommand && (source[start] !== '[' || source[start + 1] === '[')) {
        const character = source[start]!
        this.curPos += character === '[' ? 2 : 1
        if (character === '\t') continue
        if (this.recording)
          this.recordText(character === '[' ? '[[' : character === '\n' ? '[r]' : character)
        else if (this.excludeLevel === -1)
          return character === '\n' ? tag('r') : tag('ch', { text: character })
        continue
      }
      const token = lexTag(source, start, lineCommand)
      const kind = this.processSpecialTags && special.has(token.name) ? token.name : ''
      const parsed = record(yield* this.attributes(token)),
        values = record(parsed.values)
      const condition = !!parsed.condition
      if (condition && this.excludeLevel === -1) {
        if (kind === 'endmacro') {
          if (!this.recording) throw new Error('KAG endmacro without matching macro')
          yield* this.effect('setMacro', this.recording.name, this.recording.source + '[macropop]')
          this.recording = undefined
        }
        if (this.recording) {
          this.recordText(token.raw)
          this.advance(token)
          continue
        }
      }
      // Control tags always adjust nesting, including within an excluded branch.
      if (kind === 'if' || kind === 'ignore') {
        this.excludes.push(this.excludeLevel)
        this.executed.push(false)
        if (this.excludeLevel === -1) {
          let included = !!(yield* this.evaluate(values.exp, true))
          if (kind === 'ignore') included = !included
          this.executed[this.executed.length - 1] = included
          if (!included) this.excludeLevel = this.executed.length
        }
      } else if (kind === 'elsif' || kind === 'else') {
        const depth = this.executed.length
        if (depth) {
          if (this.executed[depth - 1]) this.excludeLevel = depth
          else if (
            depth === this.excludeLevel &&
            (kind === 'else' || !!(yield* this.evaluate(values.exp, true)))
          ) {
            this.executed[depth - 1] = true
            this.excludeLevel = -1
          }
        }
      } else if (kind === 'endif' || kind === 'endignore') {
        this.excludeLevel = this.excludes.pop() ?? this.excludeLevel
        this.executed.pop()
        this.advance(token)
        continue
      }
      if (!condition || this.excludeLevel !== -1) {
        this.advance(token)
        continue
      }
      const macro = !kind ? yield* this.effect('getMacro', token.name) : undefined
      if (kind === 'emb' || macro !== undefined) {
        let content = macro === undefined ? string(yield* this.evaluate(values.exp)) : string(macro)
        if (
          macro === undefined &&
          (values.escape === undefined || !!(yield* this.effect('boolean', values.escape)))
        )
          content = content.replace(/\[/g, '[[')
        this.insert(token, content, start)
        if (macro !== undefined) {
          if (this.macroDepth >= 4096) throw new Error('KAG macro argument stack budget exceeded')
          this.macroDepth++
          yield* this.effect('pushParams', values)
        }
        continue
      }
      if (kind === 'jump' || kind === 'call' || kind === 'return') {
        if (
          yield* this.callback(
            kind === 'jump' ? 'onJump' : kind === 'call' ? 'onCall' : 'onReturn',
            values,
          )
        ) {
          if (kind === 'return') yield* this.popCall(values.storage, values.target)
          else {
            this.advance(token)
            if (kind === 'call') this.pushCall()
            yield* this.goTo(values.storage, values.target)
          }
          continue
        }
      } else if (kind === 'macro') {
        const name = string(values.name).toLowerCase()
        if (!name) throw new Error('KAG macro requires a name')
        this.recording = { name, source: '' }
      } else if (kind === 'macropop') yield* this.popMacroArgs()
      else if (kind === 'erasemacro') yield* this.effect('eraseMacro', string(values.name))
      this.advance(token)
      if (!kind) return values
    }
  }

  private conditions(): RecordData {
    return {
      ExcludeLevel: this.excludeLevel,
      IfLevel: this.executed.length,
      ExcludeLevelStack: hexStack(this.excludes),
      IfLevelExecutedStack: this.executed.map((value) => (value ? '1' : '0')).join(''),
    }
  }
  private restoreConditions(data: RecordData): void {
    const excludes = parseHex(data.ExcludeLevelStack),
      executed = string(data.IfLevelExecutedStack)
    if (
      !/^[01]*$/.test(executed) ||
      excludes.length !== executed.length ||
      integer(data.IfLevel) !== executed.length
    )
      throw new Error('Malformed KAG condition nesting')
    this.excludes = excludes
    this.executed = [...executed].map((value) => value === '1')
    this.excludeLevel = integer(data.ExcludeLevel, -1)
  }
  store(macros: Data, params: Data, names: Data): RecordData {
    return {
      macros: record(macros),
      macroArgs: list(params).map((value, index) => {
        const param = record(value)
        return list(list(names)[index]).flatMap((key) => [key, param[string(key)]])
      }),
      callStack: this.calls.map((frame) => ({ ...frame })),
      storageName: this.curStorage,
      storageShortName: this.curStorage.replace(/^.*[\\/>]/, ''),
      curLine: this.curLine,
      curPos: this.curPos,
      curLabel: this.curLabel,
      lineBuffer: this.buffer ?? '',
      lineBufferUsing: this.buffer !== undefined,
      macroArgStackBase: this.macroBase,
      macroArgStackDepth: this.macroDepth,
      ...this.conditions(),
    }
  }
  *restore(data: RecordData): Task {
    const macros = record(data.macros),
      frames = list(data.callStack).map(record)
    if (frames.length > 4096) throw new Error('Malformed KAG call stack')
    const params = list(data.macroArgs).map((value) => {
      const pairs = list(value)
      if (pairs.length % 2) throw new Error('Malformed KAG macro arguments')
      const values: RecordData = {},
        names: Data[] = []
      for (let i = 0; i < pairs.length; i += 2) {
        values[string(pairs[i])] = pairs[i + 1]
        names.push(pairs[i])
      }
      values.taglist = names
      return values
    })
    const depth = integer(data.macroArgStackDepth),
      base = integer(data.macroArgStackBase)
    if (depth < 0 || depth !== params.length || base < 0 || base > depth || depth > 4096)
      throw new Error('Malformed KAG macro depth')
    // Validate condition data before mutating the running parser.
    const validator = new KagParser()
    validator.restoreConditions(data)
    for (const frame of frames) {
      validator.restoreConditions(frame)
      const frameDepth = integer(frame.macroArgStackDepth),
        frameBase = integer(frame.macroArgStackBase)
      if (
        integer(frame.offset) < 0 ||
        integer(frame.pos) < 0 ||
        frameBase < 0 ||
        frameDepth < frameBase ||
        frameDepth > depth
      )
        throw new Error('Malformed KAG call frame')
    }
    yield* this.clearCallStack()
    yield* this.effect('restoreMacros', macros)
    // Native restore resumes from the saved label, not the middle of a text run.
    if (string(data.storageName)) {
      yield* this.loadScenario(string(data.storageName), true)
      yield* this.goToLabel(string(data.curLabel))
    } else yield* this.clear()
    this.calls = frames.map((frame) => ({ ...frame }))
    yield* this.effect('restoreParams', params)
    this.macroDepth = depth
    this.macroBase = base
    this.restoreConditions(data)
    return
  }
  assign(other: KagParser): void {
    this.scenario = other.scenario
    this.curLine = other.curLine
    this.curPos = other.curPos
    this.curLabel = other.curLabel
    this.buffer = other.buffer
    this.tagLine = other.tagLine
    this.interrupted = other.interrupted
    this.recording = other.recording && { ...other.recording }
    this.macroBase = other.macroBase
    this.macroDepth = other.macroDepth
    this.calls = other.calls.map((frame) => ({ ...frame }))
    this.restoreConditions(other.conditions())
    this.debugLevel = other.debugLevel
    this.ignoreCR = other.ignoreCR
    this.processSpecialTags = other.processSpecialTags
  }
}

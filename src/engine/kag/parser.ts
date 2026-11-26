import { Scenario } from './scenario.ts'
import { KagTagSyntaxError, lexTag, lowerKagName, type LexedTag } from './lexer.ts'
import { KagReference, integer, list, record, string, tagReferences, type Data, type RecordData } from './data.ts'
import { TvpError } from '../system/tvp-error.ts'

export interface Effect {
  kind: string
  args: Data[]
}
export type Task<Result = Data> = Generator<Effect, Result, Data | Scenario>
interface ParsedTag { token: LexedTag; values: RecordData; condition: boolean; kind: string }
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
  private storageName = ''
  private storageShortName = ''
  curLine = 0
  curPos = 0
  curLabel = ''
  private buffer?: string
  private tagLine = 0
  private interrupted = false
  private recording?: { name: string; source: string }
  private excludeLevel = -1
  private ifLevel = 0
  private excludes: number[] = []
  private executed: boolean[] = []
  private macroBase = 0
  private macroDepth = 0
  private calls: RecordData[] = []
  processSpecialTags = true
  ignoreCR = false
  debugLevel = 1
  get curStorage(): string {
    return this.storageName
  }
  get curLineStr(): string {
    return this.buffer ?? this.scenario?.lines[this.curLine] ?? ''
  }
  get callStackDepth(): number {
    return this.calls.length
  }

  private *effect(kind: string, ...args: Data[]): Task {
    const value = yield { kind, args }
    if (value instanceof Scenario) throw new Error('Unexpected KAG scenario reply')
    return value
  }
  private *callback(name: string, ...args: Data[]): Task {
    return yield* this.effect('callback', name, args)
  }
  private *text(value: Data): Task<string> {
    return value instanceof KagReference
      ? string(yield* this.effect('string', value.index)) : string(value)
  }
  private *evaluate(expression: Data, boolean = false): Task {
    return yield* this.effect('eval', yield* this.text(expression), boolean, this.curStorage, this.tagLine)
  }
  private *controlExpression(expression: Data, boolean = false): Task {
    const source = yield* this.text(expression)
    if (!source) throw new TvpError('TVPKAGSyntaxError')
    return yield* this.evaluate(source, boolean)
  }
  private *parameters(): Task<{ values: RecordData; names: Data[] } | null> {
    const input = yield* this.effect('params')
    if (input === null) return null
    const encoded = record(input), values = record(encoded.values)
    for (const item of list(encoded.references)) {
      const pair = list(item), name = string(pair[0]), index = integer(pair[1])
      if (pair.length !== 2 || !Object.hasOwn(values, name) || index < 0 || index >= 100000)
        throw new Error('Malformed KAG parameter reference')
      values[name] = new KagReference(index)
    }
    return { values, names: list(encoded.names) }
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
    this.ifLevel = 0
    this.excludes = []
    this.executed = []
    yield* this.popTo(this.macroBase)
    return
  }
  *loadScenario(name: string, force = false): Task {
    yield* this.breakCondition()
    const loaded = !this.scenario || this.curStorage !== name || force
    if (loaded) {
      this.scenario = undefined
      this.storageName = this.storageShortName = ''
      const provided = yield* this.callback('onScenarioLoad', name)
      const scenario = typeof provided === 'string' ? new Scenario(name, provided, true)
        : yield { kind: 'read', args: [name] }
      if (!(scenario instanceof Scenario)) throw new Error('Missing KAG scenario reply')
      this.scenario = scenario
    }
    this.curLine = this.curPos = 0
    this.buffer = undefined
    // Native Rewind runs after onScenarioLoad and installation of its result.
    // That callback may reenter this parser while preparing a virtual story;
    // its temporary conditions/macros must not become the new story's state.
    yield* this.breakCondition()
    if (loaded) {
      this.storageName = name
      this.storageShortName = name.replace(/^.*[\\/>]/, '')
    }
    if (loaded && this.debugLevel >= 1) yield* this.effect('log', `Scenario loaded : ${name}`)
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
    if (!frame) throw new TvpError('TVPKAGCallStackUnderflow')
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
        throw new TvpError('TVPKAGReturnLostSync')
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
    this.storageName = this.storageShortName = ''
    this.curLine = this.curPos = 0
    this.buffer = undefined
    yield* this.clearCallStack()
    yield* this.breakCondition()
    // Pop only retires the active depth. Native Clear also releases every
    // cached parameter dictionary, including slots above the active depth.
    yield* this.effect('clearParams')
    return
  }
  interrupt(): void {
    this.interrupted = true
  }
  resetInterrupt(): void {
    this.interrupted = false
  }
  restoreMissingArgs(): never {
    // Restore sets the active depth to zero before discovering that omitted
    // macroArgs cannot replace an existing cached parameter pool.
    this.macroDepth = 0
    throw new TvpError('TVPKAGMalformedSaveData')
  }
  *popMacroArgs(): Task {
    if (this.macroDepth === 0) throw new TvpError('TVPKAGSyntaxError')
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
        if (this.recording) throw new TvpError('TVPLabelOrScriptInMacro')
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
        if (this.recording) throw new TvpError('TVPLabelOrScriptInMacro')
        this.nextLine()
        const start = this.curLine
        let script = ''
        while (
          this.curLine < this.scenario.lines.length &&
          !/^(?:\[endscript\]\\?|@endscript)$/.test(this.curLineStr)
        ) {
          if (++work % 1024 === 0) yield* this.effect('yield')
          if (this.excludeLevel === -1) script += this.curLineStr + '\r\n'
          this.nextLine()
        }
        if (this.curLine === this.scenario.lines.length)
          throw new TvpError('TVPKAGInlineScriptNotEnd')
        if (this.excludeLevel === -1)
          yield* this.callback('onScript', script, this.storageShortName, start)
        this.nextLine()
        continue
      }
      return true
    }
    return false
  }
  private advance(token: LexedTag): void {
    if (token.lineCommand) this.nextLine()
    // Native TVP_KAG_STEP_NEXT advances the live cursor. A callback can have
    // loaded another scenario or moved to another label before it returns.
    else this.curPos++
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
      // Expression evaluation can consume text or load another scenario.
      // Native inserts before the suffix at its live post-evaluation cursor.
      old.slice(this.curPos) +
      (token.lineCommand && !this.ignoreCR ? '\\' : '')
    if (buffer.length > 8 * 1024 * 1024) throw new Error('KAG macro expansion exceeds text budget')
    this.buffer = buffer
    this.curPos = start
  }
  private *readTag(source: string, start: number, lineCommand: boolean): Task<ParsedTag> {
    const { name, fields } = lexTag(source, start, lineCommand)
    const kind = this.processSpecialTags && special.has(name) ? name : ''
    let values: RecordData = Object.assign(Object.create(null), { tagname: name })
    let names: Data[] = ['tagname']
    let condition = true
    // Native evaluates each attribute before examining the next delimiter.
    // An expression can observe curPos or take effect before a later error.
    for (;;) {
      const next = fields.next()
      if (next.done) {
        const token = next.value
        this.curPos = token.lineCommand ? token.end : token.end - 1
        values.taglist = names
        return { token, values, condition, kind }
      }
      const attribute = next.value
      this.curPos = attribute.end
      if (attribute.forward) {
        if (!this.recording) {
          const current = yield* this.parameters()
          if (current !== null) {
            const params = current.values
            values = Object.assign(Object.create(null), params, { tagname: name })
            const ordered = current.names.map(string).filter((name) => name !== 'tagname' && Object.hasOwn(params, name))
            const known = new Set(ordered)
            names = ['tagname', ...ordered, ...Object.keys(params).filter((name) => name !== 'tagname' && !known.has(name))]
          }
        }
        continue
      }
      let value: Data = attribute.value
      if (
        (!this.recording && this.excludeLevel === -1) ||
        kind === 'elsif'
      ) {
        if (attribute.entity) value = yield* this.evaluate(value)
        else if (attribute.parameter) {
          const current = yield* this.parameters()
          if (current !== null) {
            const params = current.values,
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
  }
  *getNextTag(): Task {
    // EOF takes precedence over interrupt in the native class.
    if (!this.scenario || this.curLine >= this.scenario.lines.length) return
    // Release the old VM-owned fields before advancing any parser cursor.
    // A field's finalizer can read/reenter this parser or request interrupt.
    // Entry EOF above deliberately does not clear the previous result.
    yield* this.effect('clearTag')
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
      let parsed: ParsedTag
      try { parsed = yield* this.readTag(source, start, lineCommand) }
      catch (error) {
        if (error instanceof KagTagSyntaxError) this.curPos = error.position
        throw error
      }
      const { token, values, condition, kind } = parsed
      if (condition && this.excludeLevel === -1) {
        if (kind === 'endmacro') {
          if (!this.recording) throw new TvpError('TVPKAGSyntaxError')
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
        this.ifLevel++
        this.excludes.push(this.excludeLevel)
        this.executed.push(false)
        if (this.excludeLevel === -1) {
          let included = !!(yield* this.controlExpression(values.exp, true))
          if (kind === 'ignore') included = !included
          this.executed[this.executed.length - 1] = included
          if (!included) this.excludeLevel = this.ifLevel
        }
      } else if (kind === 'elsif' || kind === 'else') {
        if (this.executed.length) {
          if (this.executed.at(-1)) this.excludeLevel = this.ifLevel
          else if (
            this.ifLevel === this.excludeLevel &&
            (kind === 'else' || !!(yield* this.controlExpression(values.exp, true)))
          ) {
            this.executed[this.executed.length - 1] = true
            this.excludeLevel = -1
          }
        }
      } else if (kind === 'endif' || kind === 'endignore') {
        this.excludeLevel = this.excludes.pop() ?? this.excludeLevel
        this.executed.pop()
        this.ifLevel = Math.max(0, this.ifLevel - 1)
        this.advance(token)
        continue
      }
      if (!condition || this.excludeLevel !== -1) {
        this.advance(token)
        continue
      }
      const macro = !kind || kind === 'emb' ? yield* this.effect('getMacro', token.name) : undefined
      if (kind === 'emb' || macro !== undefined) {
        // The closing delimiter is consumed before evaluating emb. A
        // callback observing/reentering this parser must see the suffix.
        if (!token.lineCommand) this.curPos++
        let content = macro === undefined ? string(yield* this.controlExpression(values.exp)) : string(macro)
        // Original emb always produces text, regardless of an escape field.
        // A real macro (including a macro named emb) still inserts tag source.
        if (macro === undefined) content = content.replace(/\[/g, '[[')
        this.insert(token, content, start)
        if (macro !== undefined) {
          if (this.macroDepth >= 4096) throw new Error('KAG macro argument stack budget exceeded')
          this.macroDepth++
          yield* this.effect('pushParams', tagReferences(values))
        }
        continue
      }
      if (kind === 'jump' || kind === 'call' || kind === 'return') {
        // Native copies/converts these before the callback. Parameter values
        // can be live objects even though ordinary expression entities are strings.
        const storage = yield* this.text(values.storage), target = yield* this.text(values.target)
        if (
          yield* this.callback(
            kind === 'jump' ? 'onJump' : kind === 'call' ? 'onCall' : 'onReturn',
            tagReferences(values),
          )
        ) {
          if (kind === 'return') yield* this.popCall(storage, target)
          else {
            // Jump restarts parsing without consuming the old tag; call
            // first advances the live cursor and captures that return point.
            if (kind === 'call') { this.advance(token); this.pushCall() }
            yield* this.goTo(storage, target)
          }
          // Native goto parse_start checks EOF/no scenario before interrupt.
          // In particular, onJump may clear the scenario and request a later
          // interrupt; that pending interrupt belongs to a future load.
          if (!this.scenario || this.curLine >= this.scenario.lines.length) return
          continue
        }
      } else if (kind === 'macro') {
        const name = lowerKagName(yield* this.text(values.name))
        if (!name) throw new TvpError('TVPKAGSyntaxError')
        this.recording = { name, source: '' }
      } else if (kind === 'macropop') yield* this.popMacroArgs()
      else if (kind === 'erasemacro') {
        const name = yield* this.text(values.name)
        if (!(yield* this.effect('eraseMacro', name))) throw new TvpError('TVPUnknownMacroName', [name])
      }
      this.advance(token)
      if (!kind) return values
    }
  }

  private conditions(): RecordData {
    return {
      ExcludeLevel: this.excludeLevel,
      IfLevel: this.ifLevel,
      ExcludeLevelStack: hexStack(this.excludes),
      IfLevelExecutedStack: this.executed.map((value) => (value ? '1' : '0')).join(''),
    }
  }
  private checkConditionNesting(): void {
    if (this.excludes.length !== this.executed.length || this.ifLevel !== this.executed.length)
      throw new Error('Malformed KAG condition nesting')
  }
  private setExecutedStack(value: Data): void {
    const bits = string(value)
    if (!/^[01]*$/.test(bits)) throw new Error('Malformed KAG condition nesting')
    this.executed = [...bits].map((bit) => bit === '1')
  }
  private restoreConditions(data: RecordData): void {
    this.excludes = parseHex(data.ExcludeLevelStack)
    this.setExecutedStack(data.IfLevelExecutedStack)
    this.excludeLevel = integer(data.ExcludeLevel, -1)
    this.ifLevel = integer(data.IfLevel)
    this.checkConditionNesting()
  }
  store(macros: Data, params: Data, names: Data): RecordData {
    return {
      macros: record(macros),
      macroArgs: list(params).map(record),
      // Native macroArgs are dictionaries. Keep the Web taglist ordering
      // separately so duplicate attribute positions survive a Web round trip.
      ...(list(params).length ? { macroArgNames: list(names) } : {}),
      callStack: this.calls.map((frame) => ({ ...frame })),
      storageName: this.curStorage,
      storageShortName: this.storageShortName,
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
  *restore(): Task {
    // The TJS binding restores the optional macro dictionary before it reads
    // the parameter stack, so callbacks can retain their original identity.
    this.macroDepth = 0
    const data = record(yield* this.effect('readRestoreParams'))
    const nameLists = data.macroArgNames === undefined ? undefined : list(data.macroArgNames)
    const params = list(data.macroArgs).map((entry, index) => {
      if (!Array.isArray(entry)) {
        const values = record(entry), saved = nameLists?.[index]
        return { values, names: saved === undefined ? Object.keys(values) : list(saved).map(string) }
      }
      // Earlier Web bookmarks used alternating attribute names and values.
      if (entry.length % 2) throw new Error('Malformed KAG macro arguments')
      const values: RecordData = Object.create(null), names: string[] = []
      for (let i = 0; i < entry.length; i += 2) {
        const name = string(entry[i])
        values[name] = entry[i + 1]
        names.push(name)
      }
      return { values, names }
    })
    const depth = integer(data.macroArgStackDepth)
    if (depth !== params.length) throw new TvpError('TVPKAGMalformedSaveData')
    if (depth > 4096) throw new Error('Malformed KAG macro depth')
    this.macroDepth = depth
    const installedCount = yield* this.effect('restoreParams', params)
    if (integer(installedCount) !== this.macroDepth) throw new TvpError('TVPKAGMalformedSaveData')
    this.macroBase = this.macroDepth
    const suppliedCount = yield* this.effect('restoreCallCount')
    if (suppliedCount !== undefined) {
      const count = integer(suppliedCount)
      if (count < 0 || count > 4096) throw new Error('Malformed KAG call stack')
      this.calls = []
      const validator = new KagParser()
      for (let index = 0; index < count; index++) {
        const frame = record(yield* this.effect('restoreCallFrame', index))
        validator.restoreConditions(frame)
        const frameDepth = integer(frame.macroArgStackDepth), frameBase = integer(frame.macroArgStackBase)
        if (integer(frame.offset) < 0 || integer(frame.pos) < 0 || frameBase < 0 ||
          frameDepth < frameBase || frameDepth > this.macroDepth || this.calls.length >= 4096)
          throw new Error('Malformed KAG call frame')
        this.calls.push(frame)
      }
    }
    // A bookmark can implement each field as a getter on the running game.
    // Install each result before invoking the getter for the following field.
    let value = yield* this.effect('restoreField', 'storageName')
    if (value !== undefined) this.storageName = string(value)
    value = yield* this.effect('restoreField', 'storageShortName')
    if (value !== undefined) this.storageShortName = string(value)
    value = yield* this.effect('restoreField', 'curLabel')
    if (value !== undefined) this.curLabel = string(value)
    const storage = this.curStorage, label = this.curLabel
    // Native restore resumes from the saved label, not the middle of a text run.
    if (storage) {
      yield* this.loadScenario(storage, true)
      yield* this.goToLabel(label)
    } else {
      this.scenario = undefined
      this.storageShortName = ''
      this.buffer = undefined
      this.curLine = this.curPos = 0
      yield* this.breakCondition()
    }
    // The original reads these fields after the chapter callbacks. Those
    // callbacks can advance the parser or update the bookmark being loaded.
    const priorConditions = this.conditions()
    value = yield* this.effect('restoreField', 'ExcludeLevel')
    if (value !== undefined) this.excludeLevel = integer(value)
    value = yield* this.effect('restoreField', 'IfLevel')
    if (value !== undefined) this.ifLevel = integer(value)
    value = yield* this.effect('restoreField', 'ExcludeLevelStack')
    if (value !== undefined) this.excludes = parseHex(value)
    value = yield* this.effect('restoreField', 'IfLevelExecutedStack')
    if (value !== undefined) this.setExecutedStack(value)
    value = yield* this.effect('restoreField', 'macroArgStackBase')
    const restoredBase = integer(value, this.macroBase)
    if (restoredBase < 0 || restoredBase > this.macroDepth) throw new Error('Malformed KAG macro depth')
    try {
      this.checkConditionNesting()
    } catch (error) {
      // A finished, structurally invalid bookmark is rejected. Restore the
      // coherent branch that was active after loading the chapter. A script
      // getter that throws earlier retains the fields already applied.
      this.restoreConditions(priorConditions)
      throw error
    }
    this.macroBase = restoredBase
    return
  }
  assign(other: KagParser): void {
    this.scenario = other.scenario
    this.storageName = other.storageName
    this.storageShortName = other.storageShortName
    this.curLine = other.curLine
    this.curPos = other.curPos
    this.curLabel = other.curLabel
    this.buffer = other.buffer
    this.tagLine = other.tagLine
    this.recording = other.recording && { ...other.recording }
    this.macroBase = other.macroBase
    // Native assignment clears the destination pool before reading the
    // source depth; self-assignment therefore has no active macro arguments.
    this.macroDepth = other === this ? 0 : other.macroDepth
    this.calls = other.calls.map((frame) => ({ ...frame }))
    this.excludeLevel = other.excludeLevel
    this.ifLevel = other.ifLevel
    this.excludes = [...other.excludes]
    this.executed = [...other.executed]
    this.debugLevel = other.debugLevel
    this.ignoreCR = other.ignoreCR
  }
}

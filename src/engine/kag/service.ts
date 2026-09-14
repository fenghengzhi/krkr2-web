import { KagParser, type Task } from './parser.ts'
import { fromScript, integer, record, string, toScript, type Data } from './data.ts'
import { isScriptObject, type HostContext, type ScriptValue } from '../script/runtime.ts'

export class KagService {
  private nextId = 1
  private nextToken = 1
  private parsers = new Map<number, KagParser>()
  private tasks = new Map<number, { parser: number; task: Task }>()
  constructor(
    private readonly read: (name: string) => Promise<string>,
    private readonly log: (text: string) => void,
  ) {}
  private parser(id: number): KagParser {
    const parser = this.parsers.get(id)
    if (!parser) throw new Error('KAGParser has been invalidated')
    return parser
  }
  private async advance(id: number, token: number, input?: Data): Promise<ScriptValue> {
    const task = this.tasks.get(token)
    if (!task || task.parser !== id) throw new Error('Stale KAG parser continuation')
    try {
      while (true) {
        const step = task.task.next(input)
        if (step.done) {
          this.tasks.delete(token)
          return toScript({ done: true, value: step.value })
        }
        const { kind, args } = step.value
        if (kind === 'read') {
          input = await this.read(string(args[0]))
          continue
        }
        if (kind === 'log') {
          this.log(string(args[0]))
          input = undefined
          continue
        }
        return toScript({ done: false, token, kind, args })
      }
    } catch (error) {
      this.tasks.delete(token)
      const parser = this.parser(id)
      throw new Error(
        `${parser.curStorage || 'KAGParser'}:${parser.curLine + 1}:${parser.curPos + 1}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  async host(operation: string, args: ScriptValue[], context: HostContext): Promise<ScriptValue> {
    const data = (index: number): Data => {
      const value = args[index]
      return fromScript(isScriptObject(value) ? context.snapshot(value) : value)
    }
    if (operation === 'KAG.create') {
      if (this.parsers.size >= 256) throw new Error('KAG parser instance budget exceeded')
      const id = this.nextId++
      this.parsers.set(id, new KagParser())
      return BigInt(id)
    }
    const id = integer(data(0)),
      parser = this.parser(id)
    if (operation === 'KAG.destroy') {
      this.parsers.delete(id)
      for (const [token, entry] of this.tasks) if (entry.parser === id) this.tasks.delete(token)
    } else if (operation === 'KAG.cancel') this.tasks.delete(integer(data(1)))
    else if (operation === 'KAG.resume') return this.advance(id, integer(data(1)), data(2))
    else if (operation === 'KAG.get') {
      const property = string(data(1))
      if (
        ![
          'curLine',
          'curPos',
          'curLineStr',
          'curStorage',
          'curLabel',
          'callStackDepth',
          'ignoreCR',
          'processSpecialTags',
          'debugLevel',
        ].includes(property)
      )
        throw new Error('Unknown KAG property')
      return toScript(parser[property as 'curLine'])
    } else if (operation === 'KAG.set') {
      const property = string(data(1))
      if (property === 'debugLevel') parser.debugLevel = integer(data(2))
      else if (property === 'ignoreCR' || property === 'processSpecialTags')
        parser[property] = !!data(2)
      else throw new Error('KAG property is read-only')
    } else if (operation === 'KAG.store') return toScript(parser.store(data(1), data(2), data(3)))
    else if (operation === 'KAG.assign') parser.assign(this.parser(integer(data(1))))
    else if (operation === 'KAG.interrupt') parser.interrupt()
    else if (operation === 'KAG.resetInterrupt') parser.resetInterrupt()
    else if (operation === 'KAG.begin') {
      const method = string(data(1))
      let task: Task
      switch (method) {
        case 'loadScenario':
          task = parser.loadScenario(string(data(2)))
          break
        case 'goToLabel':
          task = parser.goToLabel(string(data(2)))
          break
        case 'callLabel':
          task = parser.callLabel(string(data(2)))
          break
        case 'getNextTag':
          task = parser.getNextTag()
          break
        case 'clear':
          task = parser.clear()
          break
        case 'clearCallStack':
          task = parser.clearCallStack()
          break
        case 'popMacroArgs':
          task = parser.popMacroArgs()
          break
        case 'restore':
          task = parser.restore(record(data(2)))
          break
        default:
          throw new Error(`Unknown KAG method ${method}`)
      }
      const token = this.nextToken++
      this.tasks.set(token, { parser: id, task })
      return this.advance(id, token)
    } else throw new Error(`Unknown KAG operation ${operation}`)
  }
  clear(): void {
    this.tasks.clear()
    this.parsers.clear()
  }
}

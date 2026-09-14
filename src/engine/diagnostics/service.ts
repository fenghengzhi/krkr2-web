import {
  isScriptObject,
  type ScriptObject,
  type ScriptRuntime,
  type HostReply,
  type ScriptValue,
} from '../script/runtime.ts'
import { DebugLog, type LogEntry } from './log.ts'

interface Handler {
  key: string
  callback?: ScriptObject
}
interface Delivery {
  token: number
  entry: LogEntry
  index: number
  current?: Handler
  finish: boolean
}
const empty = (): HostReply => ({ kind: 'value', value: undefined })

/** Callback registry owns native closures; the bound TJS pump owns the call stack. */
export class DebugService {
  private handlers: Handler[] = []
  private registered = new Map<string, Handler>()
  private pump?: ScriptObject
  private delivery?: Delivery
  private serial = 0
  private disposed = false
  constructor(
    readonly log: DebugLog,
    private readonly objects: ScriptRuntime,
    private readonly options: ReadonlyMap<string, string>,
  ) {}

  dispatch(entry: LogEntry, finish = true): HostReply {
    if (this.disposed || this.delivery || !this.registered.size || !this.pump) {
      if (finish) this.log.finish(entry)
      return empty()
    }
    const token = ++this.serial
    this.delivery = { token, entry, index: 0, finish }
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token)] }
  }
  private remove(entry: Handler): void {
    if (!entry.callback) return
    this.registered.delete(entry.key)
    this.objects.release(entry.callback)
    entry.callback = undefined
  }
  get delivering(): boolean {
    return !!this.delivery
  }
  get listening(): boolean {
    return !this.disposed && !!this.registered.size
  }

  host(operation: string, args: ScriptValue[]): HostReply {
    const value = (value: ScriptValue): HostReply => ({ kind: 'value', value }),
      text = (i: number) => {
        if (typeof args[i] !== 'string') throw new Error(operation + ': expected text')
        return args[i] as string
      },
      number = (i: number) => {
        if (
          (typeof args[i] !== 'bigint' && typeof args[i] !== 'number') ||
          !Number.isSafeInteger(Number(args[i]))
        )
          throw new Error(operation + ': expected integer')
        return Number(args[i])
      }
    if (operation === 'Debug.bind') {
      if (!isScriptObject(args[0])) throw new Error('Debug pump must be an object')
      if (this.pump) this.objects.release(this.pump)
      this.pump = this.objects.retain(args[0])
      return empty()
    }
    if (this.disposed) return empty()
    if (operation === 'Debug.message' || operation === 'Debug.notice')
      return this.dispatch(this.log.begin(text(0), operation === 'Debug.notice'))
    if (operation === 'Debug.start') {
      this.log.start(!!number(0))
      return empty()
    }
    if (operation === 'Debug.error') {
      this.log.error()
      return empty()
    }
    if (operation === 'Debug.last') return value(this.log.last(number(0)))
    if (operation === 'Debug.location') {
      if (args.length) this.log.setLocation(text(0), this.options)
      return value(this.log.location)
    }
    if (operation === 'Debug.auto' || operation === 'Debug.clear') {
      const property = operation === 'Debug.auto' ? 'logToFileOnError' : 'clearLogFileOnError'
      if (args.length) this.log[property] = !!number(0)
      return value(this.log[property] ? 1n : 0n)
    }
    if (operation === 'Debug.add' || operation === 'Debug.remove') {
      const callback = args[0]
      if (callback === null) return empty()
      if (!isScriptObject(callback)) throw new Error('Logging handler must be an object')
      const key = this.objects.objectIdentity(callback),
        entry = this.registered.get(key)
      if (operation === 'Debug.remove') {
        if (entry) this.remove(entry)
      } else if (!entry) {
        if (this.registered.size >= 4096 || this.handlers.length >= 8192)
          throw new Error('Logging handler registry budget exceeded')
        const handler = { key, callback: this.objects.retain(callback) }
        this.registered.set(key, handler)
        this.handlers.push(handler)
      }
      if (!this.delivery) this.handlers = this.handlers.filter((entry) => entry.callback)
      return empty()
    }
    const delivery = this.delivery
    if (!delivery || number(0) !== delivery.token) throw new Error('Debug delivery has ended')
    switch (operation) {
      case 'Debug.next':
        delivery.current = undefined
        while (delivery.index < this.handlers.length) {
          const next = this.handlers[delivery.index++]!
          if (next.callback) {
            delivery.current = next
            break
          }
        }
        return value(delivery.current ? 1n : 0n)
      case 'Debug.call':
        return delivery.current?.callback
          ? {
              kind: 'invoke',
              callback: delivery.current.callback,
              args: [delivery.entry.line],
              statusOnly: true,
            }
          : value(0n)
      case 'Debug.failed':
        if (delivery.current) this.remove(delivery.current)
        return empty()
      case 'Debug.end':
        this.delivery = undefined
        this.handlers = this.handlers.filter((entry) => entry.callback)
        if (number(1) && delivery.finish) this.log.finish(delivery.entry)
        return empty()
    }
    throw new Error('Unsupported Debug operation: ' + operation)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.handlers) this.remove(entry)
    this.handlers = []
    this.delivery = undefined
    if (this.pump) this.objects.release(this.pump)
    this.pump = undefined
  }
}

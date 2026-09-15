import { InputController, type InputOperation, type InputValue } from './controller.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type HostReply,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptValue,
} from '../script/runtime.ts'
import type { InputPacket } from '../ports/input.ts'
export class InputService {
  private next = 1
  private operations = new Map<number, InputOperation>()
  private pump?: ScriptObject
  constructor(
    readonly controller: InputController,
    private readonly objects: HostContext,
    private readonly layer: (id: number) => ScriptObject | undefined,
    private readonly window: () => ScriptObject | ScriptWeakObject | undefined,
  ) {}
  private value(value: InputValue): ScriptValue {
    if (typeof value === 'object' && value !== null) return this.layer(value.layer) ?? null
    if (typeof value === 'boolean') return value ? 1n : 0n
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    return value
  }
  start(operation: InputOperation): HostReply {
    if (!this.pump) throw new Error('Input dispatcher is unavailable')
    if (this.operations.size >= 64) throw new Error('Input callback nesting limit exceeded')
    const token = this.next++
    this.operations.set(token, operation)
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token)] }
  }
  packet(packet: InputPacket): HostReply {
    return this.start(this.controller.packet(packet))
  }
  change(action: () => void): HostReply {
    return this.start(this.controller.change(action))
  }
  private abort(token: number): void {
    const operation = this.operations.get(token)
    this.operations.delete(token)
    if (operation) {
      let result = operation.return(undefined)
      for (let guard = 0; !result.done && guard < 4096; guard++) result = operation.next()
    }
  }
  host(name: string, args: ScriptValue[], context: HostContext): HostReply {
    const reply = (value: ScriptValue): HostReply => ({ kind: 'value', value })
    const number = (i: number) => {
      const n = Number(args[i])
      if (!Number.isSafeInteger(n)) throw new Error('Invalid input argument')
      return n
    }
    if (name === 'Input.bind') {
      if (!isScriptObject(args[0])) throw new Error('Input pump must be callable')
      if (this.pump) context.release(this.pump)
      this.pump = context.retain(args[0])
      return reply(undefined)
    }
    if (name === 'Input.abort') {
      this.abort(number(0))
      return reply(undefined)
    }
    if (name === 'Input.resume') {
      const token = number(0),
        operation = this.operations.get(token)
      if (!operation) throw new Error('Input operation has ended')
      try {
        for (let guard = 0; guard < 100000; guard++) {
          const next = operation.next()
          if (next.done) {
            this.operations.delete(token)
            return reply(scriptRecord({ done: 1n, value: this.value(next.value) }))
          }
          const event = next.value,
            target = event.target ? this.layer(event.target) : this.window()
          if (!target || (event.target && !this.controller.layers.has(event.target))) continue
          return reply(
            scriptRecord({
              done: 0n,
              window: event.target ? 0n : 1n,
              target,
              method: event.method,
              args: scriptList(event.args.map((value) => this.value(value))),
            }),
          )
        }
        throw new Error('Input event budget exceeded')
      } catch (error) {
        this.abort(token)
        throw error
      }
    }
    const id = number(0)
    if (name === 'Input.focus')
      return this.start(this.controller.focus(id, args[1] === undefined || !!number(1)))
    if (name === 'Input.choice') {
      this.controller.choose(id, args[1] === null ? 0 : number(1))
      return reply(undefined)
    }
    if (name === 'Input.hitChoice') {
      this.controller.chooseHit(id, !!number(1))
      return reply(undefined)
    }
    if (name === 'Input.hit')
      return this.start(
        this.controller.getLayerAt(id, number(1), number(2), !!number(3), !!number(4)),
      )
    if (name === 'Input.mode')
      return this.start(number(1) ? this.controller.setMode(id) : this.controller.removeMode(id))
    if (name === 'Input.search') return this.start(this.controller.search(id, !!number(1)))
    if (name === 'Input.moveFocus') return this.start(this.controller.moveFocus(!!id))
    if (name === 'Input.release') {
      this.controller.release(args[1] === undefined ? undefined : number(1))
      return reply(undefined)
    }
    if (name === 'Input.get') {
      if (args[1] === 'focused') return reply(this.controller.focused === id ? 1n : 0n)
      if (args[1] === 'nodeFocusable') return reply(this.controller.focusable(id) ? 1n : 0n)
      if (args[1] === 'nodeEnabled') return reply(this.controller.enabled(id) ? 1n : 0n)
      if (args[1] === 'focusedLayer') return reply(this.layer(this.controller.focused) ?? null)
      if (args[1] === 'currentModalLayer')
        return reply(this.layer(this.controller.modal.at(-1) ?? 0) ?? null)
      if (args[1] === 'keyState') return reply(this.controller.keys.has(id) ? 1n : 0n)
    }
    if (name === 'Input.defaultKey')
      return this.start(
        this.controller.defaultKey(
          id,
          String(args[1]),
          typeof args[2] === 'string' ? args[2] : number(2),
          args[3] === undefined ? 0 : number(3),
        ),
      )
    throw new Error(`Unsupported input operation: ${name}`)
  }
  dispose(): void {
    for (const token of [...this.operations.keys()]) this.abort(token)
    if (this.pump) this.objects.release(this.pump)
    this.pump = undefined
    this.controller.clear()
  }
}

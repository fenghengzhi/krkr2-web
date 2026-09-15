import {
  InputController,
  type InputOperation,
  type InputStep,
  type InputValue,
} from './controller.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type HostReply,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptValue,
  type ScriptRuntime,
} from '../script/runtime.ts'
import type { InputPacket } from '../ports/input.ts'
export class InputService {
  private next = 1
  private operations = new Map<
    number,
    {
      operation: InputOperation
      pending?: IteratorResult<InputStep, InputValue>
      unwinding: boolean
    }
  >()
  private pump?: ScriptObject
  private ownership?: ScriptObject
  constructor(
    readonly controller: InputController,
    private readonly objects: HostContext,
    private readonly layer: (id: number) => ScriptObject | ScriptWeakObject | undefined,
    private readonly window: () => ScriptObject | ScriptWeakObject | undefined,
    // Shutdown suppresses event delivery, not the native identities passed as
    // arguments or held by manager slots while invalidation is in progress.
    private readonly eventLayer: (
      id: number,
    ) => ScriptObject | ScriptWeakObject | undefined = layer,
  ) {}
  private value(value: InputValue): ScriptValue {
    if (typeof value === 'object' && value !== null) return this.layer(value.layer) ?? null
    if (typeof value === 'boolean') return value ? 1n : 0n
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    return value
  }
  start(operation: InputOperation): HostReply {
    if (!this.pump || !this.ownership) throw new Error('Input dispatcher is unavailable')
    if (this.operations.size >= 64) throw new Error('Input callback nesting limit exceeded')
    const token = this.next++
    this.operations.set(token, { operation, unwinding: false })
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token), this.ownership] }
  }
  packet(packet: InputPacket): HostReply {
    return this.start(this.controller.packet(packet))
  }
  change(action: () => void): HostReply {
    return this.start(this.controller.change(action))
  }
  detach(id: number, action: () => void, nativeInvalidation = false): HostReply {
    return this.start(this.controller.detach(id, action, nativeInvalidation))
  }
  /** For serialized, external reset/clear paths; host calls already drain these
   * commands through their current cooperative Input pump. */
  async synchronize(): Promise<void> {
    if (!this.controller.ownershipPending || !this.pump || !this.ownership) return
    const runtime = this.objects as HostContext & Pick<ScriptRuntime, 'invoke'>
    if (typeof runtime.invoke !== 'function') throw new Error('Input runtime cannot invoke cleanup')
    const reply = this.start(this.controller.synchronize())
    if (reply.kind === 'invoke') {
      const result = await runtime.invoke(reply.callback, reply.args)
      if (isScriptObject(result)) runtime.release(result)
    }
  }
  private step(token: number, unwind: boolean): ScriptValue {
    const record = this.operations.get(token)
    if (!record) {
      if (unwind) return scriptRecord({ done: 1n })
      throw new Error('Input operation has ended')
    }
    if (unwind && !record.unwinding) {
      record.unwinding = true
      record.pending = record.operation.return(undefined)
    }
    for (let guard = 0; guard < 100000; guard++) {
      const ownership = this.controller.takeOwnership()
      if (ownership)
        return scriptRecord({
          done: 0n,
          ownership: 1n,
          key: ownership.key,
          target: ownership.layer ? (this.layer(ownership.layer) ?? null) : null,
        })
      const next = record.pending ?? record.operation.next()
      record.pending = undefined
      // An imperative reset/release can enqueue ownership before yielding a
      // callback or returning. Deliver those releases before resolving targets.
      if (this.controller.ownershipPending) {
        record.pending = next
        continue
      }
      if (next.done) {
        this.operations.delete(token)
        return scriptRecord({ done: 1n, value: this.value(next.value) })
      }
      const event = next.value
      if (event.kind === 'ownership')
        return scriptRecord({
          done: 0n,
          ownership: 1n,
          key: event.key,
          target: event.layer ? (this.layer(event.layer) ?? null) : null,
        })
      if (record.unwinding && !(event.kind === 'invoke' && event.unwind)) continue
      if (event.kind === 'invoke')
        return scriptRecord({
          done: 0n,
          ownership: 0n,
          direct: 1n,
          target: event.callback,
          method: '',
          args: scriptList(event.args),
        })
      const target = event.target ? this.eventLayer(event.target) : this.window()
      if (!target || (event.target && !this.controller.layers.has(event.target))) continue
      return scriptRecord({
        done: 0n,
        ownership: 0n,
        direct: 0n,
        window: event.target ? 0n : 1n,
        target,
        method: event.method,
        args: scriptList(event.args.map((value) => this.value(value))),
      })
    }
    throw new Error('Input event budget exceeded')
  }
  host(name: string, args: ScriptValue[], context: HostContext): HostReply {
    const reply = (value: ScriptValue): HostReply => ({ kind: 'value', value })
    const number = (i: number) => {
      const n = Number(args[i])
      if (!Number.isSafeInteger(n)) throw new Error('Invalid input argument')
      return n
    }
    if (name === 'Input.bind') {
      if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
        throw new Error('Input pump and ownership state must be objects')
      if (this.pump) context.release(this.pump)
      if (this.ownership) context.release(this.ownership)
      this.pump = context.retain(args[0])
      this.ownership = context.retain(args[1])
      return reply(undefined)
    }
    if (name === 'Input.unwind' || name === 'Input.abort') return reply(this.step(number(0), true))
    if (name === 'Input.resume') return reply(this.step(number(0), false))
    if (name === 'Input.synchronize') return this.start(this.controller.synchronize())
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
      return this.start(this.controller.synchronize())
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
    // Session shutdown no longer runs script. Finish JS generator bookkeeping
    // and release the one Dictionary; VM destruction owns terminal reclamation.
    for (const { operation } of this.operations.values()) {
      let next = operation.return(undefined)
      for (let guard = 0; !next.done && guard < 4096; guard++) next = operation.next()
    }
    this.operations.clear()
    if (this.ownership) this.objects.release(this.ownership)
    this.ownership = undefined
    if (this.pump) this.objects.release(this.pump)
    this.pump = undefined
    this.controller.dispose()
  }
}

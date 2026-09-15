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
import { InputControllers } from './controllers.ts'
import type { InputPacket } from '../ports/input.ts'
export class InputService {
  private next = 1
  private operations = new Map<
    number,
    {
      operation: InputOperation
      controller: InputController
      epoch: number
      ownershipEpoch: number
      guard: 'none' | 'lifetime' | 'packet'
      sourceValid?: () => boolean
      sourceWindow?: ScriptObject | ScriptWeakObject
      pending?: IteratorResult<InputStep, InputValue>
      unwinding: boolean
    }
  >()
  private pump?: ScriptObject
  private ownership?: ScriptObject
  readonly controllers: InputControllers
  constructor(
    controller: InputController | InputControllers,
    private readonly objects: HostContext,
    private readonly layer: (id: number) => ScriptObject | ScriptWeakObject | undefined,
    private readonly window: (windowId?: number) => ScriptObject | ScriptWeakObject | undefined,
    // Shutdown suppresses event delivery, not the native identities passed as
    // arguments or held by manager slots while invalidation is in progress.
    private readonly eventLayer: (
      id: number,
    ) => ScriptObject | ScriptWeakObject | undefined = layer,
  ) {
    this.controllers =
      controller instanceof InputControllers ? controller : InputControllers.single(controller)
  }
  get controller(): InputController {
    return this.controllers.active
  }
  private value(value: InputValue): ScriptValue {
    if (typeof value === 'object' && value !== null) return this.layer(value.layer) ?? null
    if (typeof value === 'boolean') return value ? 1n : 0n
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    return value
  }
  start(
    operation: InputOperation,
    controller = this.controllers.active,
    guard: 'none' | 'lifetime' | 'packet' = 'none',
    sourceValid?: () => boolean,
  ): HostReply {
    if (!this.pump || !this.ownership) throw new Error('Input dispatcher is unavailable')
    if (this.operations.size >= 64) throw new Error('Input callback nesting limit exceeded')
    const token = this.next++
    this.operations.set(token, {
      operation,
      controller,
      epoch: controller.epoch,
      ownershipEpoch: controller.ownershipEpoch,
      guard,
      sourceValid,
      sourceWindow: this.window(controller.sourceWindowId),
      unwinding: false,
    })
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token), this.ownership] }
  }
  private startInput(operation: InputOperation, controller: InputController): HostReply {
    return this.start(operation, controller, 'lifetime')
  }
  packet(packet: InputPacket, sourceValid?: () => boolean): HostReply {
    const controller =
      packet.windowId === undefined
        ? this.controllers.active
        : this.controllers.get(packet.windowId)
    if (!controller) return { kind: 'value', value: undefined }
    return this.start(controller.packet(packet), controller, 'packet', sourceValid)
  }
  change(action: () => void, controller = this.controllers.active): HostReply {
    return this.start(controller.change(action), controller)
  }
  detach(
    id: number,
    action: () => void,
    nativeInvalidation = false,
    controller = this.controllers.forLayer(id),
  ): HostReply {
    return this.start(controller.detach(id, action, nativeInvalidation), controller)
  }
  /** For serialized, external reset/clear paths; host calls already drain these
   * commands through their current cooperative Input pump. */
  async synchronize(): Promise<void> {
    if (!this.controllers.ownershipPending || !this.pump || !this.ownership) return
    const runtime = this.objects as HostContext & Pick<ScriptRuntime, 'invoke'>
    if (typeof runtime.invoke !== 'function') throw new Error('Input runtime cannot invoke cleanup')
    const reply = this.start(this.controllers.synchronize())
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
    if (
      (unwind ||
        (record.guard !== 'none' && record.ownershipEpoch !== record.controller.ownershipEpoch) ||
        (record.guard === 'packet' && record.epoch !== record.controller.epoch) ||
        (record.sourceValid && !record.sourceValid())) &&
      !record.unwinding
    ) {
      record.unwinding = true
      record.pending = record.operation.return(undefined)
    }
    for (let guard = 0; guard < 100000; guard++) {
      const ownership = this.controllers.takeOwnership()
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
      if (this.controllers.ownershipPending) {
        record.pending = next
        continue
      }
      if (next.done) {
        this.operations.delete(token)
        return scriptRecord({ done: 1n, value: this.value(next.value) })
      }
      const event = next.value
      if (event.kind === 'ownership') {
        // A queued release can itself finalize the source Window before a
        // pending acquisition is delivered. Never restore that retired lease.
        if (
          event.layer &&
          record.guard !== 'none' &&
          record.ownershipEpoch !== record.controller.ownershipEpoch
        )
          continue
        return scriptRecord({
          done: 0n,
          ownership: 1n,
          key: event.key,
          target: event.layer ? (this.layer(event.layer) ?? null) : null,
        })
      }
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
      // Resume against the captured source; global active never rebinds target=0.
      // Generic rendering/cleanup generators retain their own lifecycle guards.
      const target = event.target ? this.eventLayer(event.target) : record.sourceWindow
      if (!target || (event.target && !record.controller.layers.has(event.target))) continue
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
    if (name === 'Input.synchronize') return this.start(this.controllers.synchronize())
    const id = number(0)
    const controller =
      name === 'Input.get' && args[1] === 'keyState'
        ? this.controllers.active
        : (name === 'Input.get' || name === 'Input.focus') && args[2] !== undefined
          ? this.controllers.get(number(2))
          : name === 'Input.moveFocus'
            ? args[1] === undefined
              ? this.controllers.active
              : this.controllers.forLayer(number(1))
            : id
              ? this.controllers.forLayer(id)
              : this.controllers.active
    if (!controller) throw new Error('Input Window is not registered')
    if (name === 'Input.focus')
      return this.startInput(controller.focus(id, args[1] === undefined || !!number(1)), controller)
    if (name === 'Input.choice') {
      controller.choose(id, args[1] === null ? 0 : number(1))
      return reply(undefined)
    }
    if (name === 'Input.hitChoice') {
      controller.chooseHit(id, !!number(1))
      return reply(undefined)
    }
    if (name === 'Input.hit')
      return this.startInput(
        controller.getLayerAt(id, number(1), number(2), !!number(3), !!number(4)),
        controller,
      )
    if (name === 'Input.mode')
      return this.startInput(
        number(1) ? controller.setMode(id) : controller.removeMode(id),
        controller,
      )
    if (name === 'Input.search')
      return this.startInput(controller.search(id, !!number(1)), controller)
    if (name === 'Input.moveFocus') return this.startInput(controller.moveFocus(!!id), controller)
    if (name === 'Input.release') {
      controller.release(args[1] === undefined ? undefined : number(1))
      return this.startInput(controller.synchronize(), controller)
    }
    if (name === 'Input.get') {
      if (args[1] === 'focused') return reply(controller.focused === id ? 1n : 0n)
      if (args[1] === 'nodeFocusable') return reply(controller.focusable(id) ? 1n : 0n)
      if (args[1] === 'nodeEnabled') return reply(controller.enabled(id) ? 1n : 0n)
      if (args[1] === 'focusedLayer') return reply(this.layer(controller.focused) ?? null)
      if (args[1] === 'currentModalLayer')
        return reply(this.layer(controller.modal.at(-1) ?? 0) ?? null)
      if (args[1] === 'keyState') return reply(controller.keys.has(id) ? 1n : 0n)
    }
    if (name === 'Input.defaultKey')
      return this.startInput(
        controller.defaultKey(
          id,
          String(args[1]),
          typeof args[2] === 'string' ? args[2] : number(2),
          args[3] === undefined ? 0 : number(3),
        ),
        controller,
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
    this.controllers.dispose()
  }
}

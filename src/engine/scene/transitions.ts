import {
  isScriptObject,
  scriptList,
  type HostContext,
  type HostReply,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptValue,
} from '../script/runtime.ts'
import type { InputController, InputOperation } from '../input/controller.ts'
import type { TransitionFrame } from '../graphics/transition.ts'
import type { Pixels } from '../ports/graphics.ts'
import type { LayerTree } from './layers.ts'
import { TvpError } from '../system/tvp-error.ts'
import { TjsError } from '../system/tjs-error.ts'
interface Transition extends TransitionFrame {
  duration: number
  phaseMax: number
  started?: number
  callback?: ScriptObject
  /** The actual engine stores all three owning references in one VM Dictionary.
   * Individual host handles would defer releases and change finalizer order. */
  owned?: ScriptObject
  hasCallback: boolean
  tick: number
  selfupdate: boolean
}
export class SceneTransitions {
  private states = new Map<number, Transition>()
  private next = 1
  private cancelWake?: () => void
  private waiting = false
  private disposed = false
  private pausedAt?: number
  private advancing = false
  private bridge?: ScriptObject
  private held = new Set<Transition>()
  private closing = new Set<number>()
  constructor(
    private readonly layers: LayerTree,
    private readonly input: InputController | ((id: number) => InputController),
    private readonly objects: HostContext,
    private readonly start: (operation: InputOperation) => HostReply,
    private readonly now: () => number,
    private readonly schedule: (callback: () => void, delay: number) => () => void,
    private readonly requestFrame: () => Promise<void>,
    private readonly changed: (layerId: number, invalidation?: boolean) => void,
    private readonly readRule: (name: string, width: number, height: number) => Promise<Pixels>,
    private readonly fail: (error: unknown) => void,
    private readonly owner?: (id: number) => ScriptWeakObject | undefined,
    private readonly isClosing: (id: number) => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.states.size > 0
  }
  get continuousActive(): boolean {
    return [...this.states.values()].some((state) => !state.selfupdate)
  }
  windowIds(): number[] {
    return [...new Set([...this.states.values()].flatMap((state) =>
      this.layers.has(state.destination) ? [this.layers.get(state.destination).windowId] : []))]
  }
  frame(id: number): TransitionFrame | undefined {
    return this.states.get(id)
  }
  private token(token: number): Transition | undefined {
    return [...this.states.values()].find((state) => state.token === token)
  }
  private checkStart(destination: number, source: number, kind: string): void {
    if (this.disposed) throw new Error('Transition service is disposed')
    if (this.shuttingDown(destination) || this.shuttingDown(source)) throw new Error('Transition layer is shutting down')
    if (this.states.has(destination)) throw new TvpError('TVPCurrentTransitionMustBeStopping')
    if (this.states.get(source)?.source === destination) throw new TvpError('TVPTransitionMutualSource')
    if (!['crossfade', 'universal', 'scroll'].includes(kind)) throw new TvpError('TVPCannotFindTransHander', [kind])
    // The renderer follows chains of source layers. Keep its existing guard
    // for self-references and longer cycles as well as the native mutual case.
    const seen = new Set([destination])
    for (let current: number | undefined = source; current !== undefined; current = this.states.get(current)?.source) {
      if (seen.has(current)) throw new Error('Cyclic transition sources')
      seen.add(current)
    }
  }
  private geometry(destination: number, source: number, children: boolean): { width: number; height: number } {
    const dest = this.layers.get(destination), src = this.layers.get(source),
      a = children ? dest : dest.bitmap, b = children ? src : src.bitmap
    if (!a || !b) throw new TvpError('TVPTransitionSourceAndDestinationMustHaveImage')
    if (a.width !== b.width || a.height !== b.height)
      throw new TvpError('TVPTransitionLayerSizeMismatch', [`${b.width}x${b.height}`, `${a.width}x${a.height}`])
    if (!a.width || !a.height) throw new Error('Empty transition image')
    return { width: a.width, height: a.height }
  }
  async host(name: string, args: ScriptValue[]): Promise<HostReply> {
    const value = (value: ScriptValue): HostReply => ({ kind: 'value', value })
    const numeric = (index: number, fallback?: number) => {
      const n = args[index] === undefined ? fallback : Number(args[index])
      if (n === undefined || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
        throw new Error('Invalid transition option')
      return n
    }
    if (name === 'Transition.bind') {
      if (!isScriptObject(args[0])) throw new Error('Transition bridge must be callable')
      if (this.bridge) throw new Error('Transition bridge is already bound')
      this.bridge = this.objects.retain(args[0])
      return value(undefined)
    }
    if (name === 'Transition.callback') {
      const state = this.token(numeric(0))
      if (state?.owned && this.bridge)
        return { kind: 'invoke', callback: this.bridge, args: [state.owned, 1n] }
      return value(state?.callback)
    }
    if (name === 'Transition.tick') {
      const state = this.token(numeric(0)),
        tick = numeric(1)
      if (tick < 0) throw new Error('Transition callback must return a nonnegative tick')
      if (state) state.tick = Math.trunc(tick)
      return value(undefined)
    }
    if (name === 'Transition.missingArguments') throw new TjsError('TJSBadParamCount')
    const destination = numeric(0)
    if (name === 'Transition.stop') return this.start(this.finish(destination))
    const source = numeric(3), kind = String(args[1]), children = !!numeric(2)
    this.checkStart(destination, source, kind)
    if (name === 'Transition.check') return value(undefined)
    const current = this.geometry(destination, source, children)
    if (name === 'Transition.geometry') {
      const type = this.layers.get(destination).type
      return value(scriptList([BigInt(current.width), BigInt(current.height), BigInt(type === 6 || type === 7 ? 0 : type)]))
    }
    if (name !== 'Transition.begin') throw new Error(`Unsupported transition operation: ${name}`)
    // The original passes these values to the provider before reading time,
    // rule or direction. Those script getters may change layer properties.
    const width = numeric(12), height = numeric(13), destinationType = numeric(14),
      duration = Math.max(2, Math.trunc(numeric(4))),
      vague = Math.trunc(numeric(5, 64)),
      from = Math.trunc(numeric(7, 0)),
      stay = Math.trunc(numeric(8, 0)),
      selfupdate = !!numeric(9, 0)
    if (vague < 0 || vague > 65535 || ![0, 1, 2, 3].includes(from) || ![0, 1, 2].includes(stay))
      throw new Error('Transition options are outside their supported range')
    if (args[10] !== undefined && args[10] !== null && !isScriptObject(args[10]))
      throw new Error('Transition clock must be callable')
    let rule: Pixels | undefined
    if (kind === 'universal') {
      if (typeof args[6] !== 'string') throw new TvpError('TVPSpecifyOption', ['rule'])
      rule = await this.readRule(args[6], width, height)
      if (!rule.width || !rule.height) throw new Error('Empty transition rule image')
      // A rule load can suspend. A getter or a newly started transition must
      // not let a stale request replace a live owner or publish a wrong-sized rule.
      this.checkStart(destination, source, kind)
      const latest = this.geometry(destination, source, children)
      if (latest.width !== current.width || latest.height !== current.height) throw new Error('Layer resized while loading a transition rule')
    }
    const destinationOwner = this.owner?.(destination),
      sourceOwner = this.owner?.(source)
    if (
      this.owner &&
      (!destinationOwner || !sourceOwner || !this.bridge || !isScriptObject(args[11]))
    )
      throw new Error('Transition ownership state is unavailable')
    const owned = this.owner ? this.objects.retain(args[11] as ScriptObject) : undefined,
      callback = !owned && isScriptObject(args[10]) ? this.objects.retain(args[10]) : undefined,
      hasCallback = args[10] !== undefined,
      state: Transition = {
        token: this.next++,
        destination,
        source,
        destinationType,
        children,
        kind: kind as Transition['kind'],
        phase: 0,
        pixelPhase: 0,
        phaseMax: kind === 'scroll' ? (from === 0 || from === 2 ? width : height)
          : 255 + (kind === 'universal' ? vague : 0),
        vague,
        rule,
        from,
        stay,
        duration,
        callback,
        owned,
        hasCallback,
        tick: 0,
        started: hasCallback ? 0 : undefined,
        selfupdate,
      }
    this.states.set(destination, state)
    this.held.add(state)
    this.changed(destination)
    this.arm()
    if (owned)
      return {
        kind: 'invoke',
        callback: this.bridge!,
        args: [owned, 0n, destinationOwner!, sourceOwner!],
      }
    return value(undefined)
  }
  private shuttingDown(id: number): boolean {
    return this.closing.has(id) || this.isClosing(id)
  }
  private remove(state: Transition): void {
    if (this.states.get(state.destination) === state) this.states.delete(state.destination)
    this.changed(state.destination)
    this.arm()
  }
  private release(state: Transition): void {
    this.held.delete(state)
    if (state.owned) this.objects.release(state.owned)
    if (state.callback) this.objects.release(state.callback)
    state.owned = undefined
    state.callback = undefined
  }
  *finish(id: number): InputOperation {
    const state = this.states.get(id)
    if (!state) return
    this.remove(state)
    try {
      if (!this.layers.has(id) || !this.layers.has(state.source)) return
      const layers = this.layers
      const input = typeof this.input === 'function' ? this.input(id) : this.input
      yield* input.change(() => {
        layers.exchange(id, state.source, state.children)
        this.changed(id)
        this.changed(state.source)
      })
      const complete = !this.shuttingDown(id) && !this.shuttingDown(state.source)
      if (state.owned && this.bridge)
        yield {
          kind: 'invoke',
          callback: this.bridge,
          args: [state.owned, 2n, complete ? 1n : 0n],
        }
      else if (complete)
        yield {
          target: id,
          method: 'onTransitionCompleted',
          args: [{ layer: id }, { layer: state.source }],
        }
    } finally {
      // Also runs through Input.unwind if graph callbacks or completion throw.
      // State members release on the cooperative VM stack before its host handle.
      try {
        if (state.owned && this.bridge && !this.disposed)
          yield { kind: 'invoke', callback: this.bridge, args: [state.owned, 3n], unwind: true }
      } finally {
        this.release(state)
      }
    }
  }
  *invalidate(id: number): InputOperation {
    this.closing.add(id)
    try {
      yield* this.finish(id)
      for (const state of [...this.states.values()])
        if (state.source === id && this.states.get(state.destination) === state)
          yield* this.finish(state.destination)
    } finally {
      this.closing.delete(id)
    }
    return undefined
  }
  *advance(windowId?: number, subtree?: number, draw?: () => void): InputOperation {
    if (this.advancing || this.pausedAt !== undefined || this.disposed) { draw?.(); return }
    this.advancing = true
    const ending = draw ? [] as Transition[] : undefined
    try {
      for (const state of [...this.states.values()]) {
        if (this.states.get(state.destination) !== state) continue
        if (!this.layers.has(state.destination) || !this.layers.has(state.source)) {
          this.remove(state)
          this.release(state)
          continue
        }
        if (windowId !== undefined && this.layers.get(state.destination).windowId !== windowId) continue
        // A synchronous Layer.Complete visits its own tree, not unrelated
        // sibling/window transitions. Window completion retains its full pass.
        if (subtree !== undefined && !this.layers.contains(subtree, state.destination)) continue
        if (!state.selfupdate && !this.layers.property(state.destination, 'nodeVisible')) {
          yield* this.finish(state.destination)
          continue
        }
        if (state.hasCallback)
          yield { target: state.destination, method: '__transitionTick', args: [state.token] }
        if (this.states.get(state.destination) !== state) continue
        const tick = state.hasCallback ? state.tick : this.now()
        state.started ??= tick
        const elapsed = Math.max(0, Math.min(state.duration, tick - state.started))
        state.phase = elapsed / state.duration
        // Calculate in native order. Scaling an already-normalized float can
        // move the boundary one column/row early or late at an exact tick.
        const scaled = elapsed * state.phaseMax
        state.pixelPhase = Number.isSafeInteger(elapsed) && !Number.isSafeInteger(scaled)
          ? Number(BigInt(elapsed) * BigInt(state.phaseMax) / BigInt(state.duration))
          : Math.floor(scaled / state.duration)
        // This phase is already part of the active completion. Rendering its
        // new pixels does not itself post another native Window update event.
        this.changed(state.destination, false)
        if (state.phase === 1) {
          if (ending) ending.push(state)
          else yield* this.finish(state.destination)
        }
      }
      draw?.()
      if (ending) for (const state of ending)
        if (this.states.get(state.destination) === state) yield* this.finish(state.destination)
    } finally {
      this.advancing = false
    }
  }
  private arm(): void {
    this.cancelWake?.()
    this.cancelWake = undefined
    if (
      this.disposed ||
      this.waiting ||
      this.pausedAt !== undefined ||
      ![...this.states.values()].some((state) => !state.selfupdate)
    )
      return
    this.cancelWake = this.schedule(() => {
      this.cancelWake = undefined
      this.waiting = true
      void this.requestFrame()
        .catch((error) => {
          if (!this.disposed) this.fail(error)
        })
        .finally(() => {
          this.waiting = false
          this.arm()
        })
    }, 16)
  }
  drop(id: number): void {
    // Actual owner-death fallback only. Native invalidation must use invalidate
    // while both layer nodes still exist, so exchange can preserve descendants.
    for (const state of [...this.states.values()])
      if (state.destination === id || state.source === id) {
        this.remove(state)
        this.release(state)
      }
  }
  pause(): void {
    if (this.pausedAt === undefined) this.pausedAt = this.now()
    this.arm()
  }
  resume(): void {
    if (this.pausedAt === undefined) return
    const elapsed = this.now() - this.pausedAt
    for (const state of this.states.values())
      if (!state.hasCallback && state.started !== undefined) state.started += elapsed
    this.pausedAt = undefined
    this.arm()
  }
  dispose(): void {
    this.disposed = true
    this.cancelWake?.()
    for (const state of this.held) this.release(state)
    this.states.clear()
    this.closing.clear()
    if (this.bridge) this.objects.release(this.bridge)
    this.bridge = undefined
  }
}

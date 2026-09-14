import type { HostContext, ScriptObject } from '../script/runtime.ts'

export interface EventClock {
  now(): number
  schedule(callback: () => void, delay: number): () => void
}
interface EventSource {
  id: number
  type: 'timer' | 'trigger'
  callback: ScriptObject
  version: number
  pending: number
  enabled: boolean
  interval: number
  capacity: number
  mode: 0 | 1 | 2
  cached: boolean
  next: number
}
export interface ScriptEventPost {
  callback: ScriptObject
  priority: 0 | 1 | 2
  valid(): boolean
  discardable: boolean
  source: object
  replace: boolean
  onTaken(): void
}
export class ScriptEvents {
  private sources = new Map<number, EventSource>()
  private nextId = 1
  private cancelWake?: () => void
  private pausedAt?: number
  private disposed = false
  constructor(
    private readonly clock: EventClock,
    private readonly objects: HostContext,
    private readonly dispatch: (event: ScriptEventPost) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly cancelQueued: (source: object) => void = () => {},
  ) {}

  create(type: 'timer' | 'trigger', callback: ScriptObject): number {
    if (this.disposed) throw new Error('Event scheduler is disposed')
    const id = this.nextId++
    this.sources.set(id, {
      id,
      type,
      callback: this.objects.retain(callback),
      version: 0,
      pending: 0,
      enabled: false,
      interval: 1000 / 65536,
      capacity: 6,
      mode: 0,
      cached: true,
      next: 0,
    })
    return id
  }
  get(id: number): EventSource {
    const source = this.sources.get(id)
    if (!source) throw new Error('Event source has been invalidated')
    return source
  }
  set(id: number, property: string, value: number): void {
    const source = this.get(id)
    if (!Number.isFinite(value)) throw new Error(`Invalid event ${property}`)
    switch (property) {
      case 'interval':
        if (value < 0 || value > 2147483647)
          throw new Error('Timer interval is outside the supported range')
        value = Math.round(value * 65536) / 65536
        if (source.interval === value) return
        source.interval = value
        break
      case 'enabled':
        if (source.enabled === !!value) return
        source.enabled = !!value
        break
      case 'capacity':
        if (!Number.isInteger(value) || value < 0 || value > 65535)
          throw new Error('Timer capacity must be between 0 and 65535')
        source.capacity = value
        return
      case 'mode':
        if (![0, 1, 2].includes(value)) throw new Error('Invalid event mode')
        if (source.mode === value) return
        source.mode = value as 0 | 1 | 2
        break
      case 'cached':
        if (source.cached === !!value) return
        source.cached = !!value
        break
      default:
        throw new Error(`Unknown event property: ${property}`)
    }
    source.version++
    source.pending = 0
    this.cancelQueued(source)
    source.next = this.clock.now() + source.interval
    this.arm()
  }
  trigger(id: number): void {
    const source = this.get(id)
    if (source.type !== 'trigger') throw new Error('Only AsyncTrigger can be triggered directly')
    if (source.cached) {
      source.version++
      source.pending = 0
    }
    this.post(source)
  }
  cancel(id: number): void {
    const source = this.get(id)
    source.version++
    source.pending = 0
    this.cancelQueued(source)
  }
  destroy(id: number): void {
    const source = this.sources.get(id)
    if (!source) return
    source.version++
    this.sources.delete(id)
    this.cancelQueued(source)
    this.objects.release(source.callback)
    this.arm()
  }
  private post(source: EventSource): void {
    const version = source.version
    if (source.pending >= (source.type === 'trigger' ? 65535 : source.capacity || 65535)) return
    source.pending++
    const valid = () =>
      !this.disposed && this.sources.get(source.id) === source && source.version === version
    let queued = true
    const onTaken = () => {
      if (!queued) return
      queued = false
      if (valid()) source.pending--
    }
    void this.dispatch({
      callback: source.callback,
      priority: source.mode === 1 ? 0 : source.mode === 2 ? 2 : 1,
      valid,
      source,
      onTaken,
      discardable: source.type === 'timer',
      replace: source.type === 'trigger' && source.cached,
    })
      .catch(this.onError)
      .finally(onTaken)
  }
  private arm(): void {
    this.cancelWake?.()
    this.cancelWake = undefined
    if (this.disposed || this.pausedAt !== undefined) return
    let next = Infinity
    for (const source of this.sources.values())
      if (source.type === 'timer' && source.enabled && source.interval > 0)
        next = Math.min(next, source.next)
    if (!Number.isFinite(next)) return
    this.cancelWake = this.clock.schedule(
      () => {
        this.cancelWake = undefined
        const now = this.clock.now()
        for (const source of this.sources.values()) {
          if (
            source.type !== 'timer' ||
            !source.enabled ||
            source.interval <= 0 ||
            source.next > now
          )
            continue
          const due = Math.floor((now - source.next) / source.interval) + 1
          source.next += due * source.interval
          const count = Math.max(0, Math.min(due, (source.capacity || 65535) - source.pending))
          for (let i = 0; i < count; i++) this.post(source)
        }
        this.arm()
      },
      Math.max(0, next - this.clock.now()),
    )
  }
  pause(discardTimers = false): void {
    if (discardTimers)
      for (const source of this.sources.values())
        if (source.type === 'timer') {
          source.version++
          source.pending = 0
          this.cancelQueued(source)
        }
    if (this.pausedAt === undefined) this.pausedAt = this.clock.now()
    this.arm()
  }
  resume(): void {
    if (this.pausedAt === undefined) return
    const elapsed = this.clock.now() - this.pausedAt
    for (const source of this.sources.values()) source.next += elapsed
    this.pausedAt = undefined
    this.arm()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelWake?.()
    for (const source of this.sources.values()) this.objects.release(source.callback)
    this.sources.clear()
  }
}

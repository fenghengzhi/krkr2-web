import {
  isScriptObject,
  type HostReply,
  type ScriptObject,
  type ScriptRuntime,
  type ScriptValue,
} from '../script/runtime.ts'
import { ExecutionCancelled } from './control.ts'
import type { EventClock } from './events.ts'

/** Exclusive, input, normal and idle; continuous callbacks follow all four. */
export type EventPriority = 0 | 1 | 2 | 3
export interface EventOptions {
  valid?: () => boolean
  priority?: EventPriority
  discardable?: boolean
  source?: object
  replace?: boolean
  onTaken?: () => void
}
interface EventJob {
  source?: object
  sequence: number
  priority: EventPriority
  valid(): boolean
  prepare(): HostReply
  resolve(): void
  reject(error: unknown): void
  onError?(): void
  continuous?: boolean
  onTaken?(): void
}
interface ContinuousEntry {
  key: string
  callback?: ScriptObject
}
interface Round {
  ownsContinuous: boolean
  emptyContinuous: boolean
  checkExclusive: boolean
  group: number
  continuous: number
  tick: number
  current?: EventJob
}
const empty = (): HostReply => ({ kind: 'value', value: undefined })

/** TJS owns each callback stack; TypeScript owns posting, ordering and lifetimes. */
export class SystemEvents {
  disabled = false
  private paused = false
  private pausedAt = 0
  private disposed = false
  private sequence = 0
  private cutoff = 0
  private exclusivePosted = false
  private token = 0
  private queued = false
  private jobs: EventJob[] = []
  private rounds = new Map<number, Round>()
  private pump?: ScriptObject
  private entries: ContinuousEntry[] = []
  private registered = new Map<string, ContinuousEntry>()
  private continuousPending = false
  private continuousProcessing = false
  private nextContinuous = 0
  private cancelWake?: () => void
  private frequency = 0
  private readonly pendingListeners = new Set<() => void>()

  constructor(
    private readonly objects: ScriptRuntime,
    private readonly clock: EventClock,
    private readonly execute: (operation: () => HostReply) => Promise<void>,
    private readonly changed: () => void,
    private readonly error: (message: string, handled: boolean) => void,
  ) {}

  /** Readiness for a fresh nested round, without taking jobs or invoking user predicates. */
  hasDispatchableWork(): boolean {
    if (this.disposed || this.disabled || this.paused || !this.pump) return false
    // Invalid jobs still need a round to settle them. A pending continuous tick
    // cannot reenter the continuous delivery that owns an outer callback.
    return this.jobs.length > 0 || (this.continuousPending && !this.continuousProcessing)
  }

  /** Return a continuation for the existing TJS pump; never enter the VM from JavaScript. */
  beginNested(): HostReply {
    return this.hasDispatchableWork() ? this.begin() : empty()
  }

  /** Synchronous host-only wakeups. Callers recheck readiness after subscribing. */
  subscribePending(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.pendingListeners.add(listener)
    return () => {
      this.pendingListeners.delete(listener)
    }
  }

  private notifyPending(): void {
    for (const listener of [...this.pendingListeners]) {
      if (!this.pendingListeners.has(listener)) continue
      try {
        listener()
      } catch (error) {
        // Notification must not orphan a just-posted promise or stop another
        // modal waiter from waking. A failed observer is detached permanently.
        this.pendingListeners.delete(listener)
        try {
          this.error(String(error), false)
        } catch {
          /* Preserve queue ownership. */
        }
      }
    }
  }

  post(prepare: () => HostReply, options: EventOptions = {}): Promise<void> {
    const {
      valid = () => true,
      priority = 2,
      discardable = false,
      source,
      replace,
      onTaken,
    } = options
    if (this.disposed) return Promise.reject(new ExecutionCancelled())
    if (discardable && this.disabled) {
      onTaken?.()
      return Promise.resolve()
    }
    if (source && replace) this.cancelSource(source)
    if (this.jobs.length >= 65536) return Promise.reject(new Error('Event queue budget exceeded'))
    const promise = new Promise<void>((resolve, reject) => {
      this.jobs.push({
        source,
        sequence: this.sequence,
        priority,
        prepare,
        valid,
        resolve,
        reject,
        onTaken,
      })
    })
    if (priority === 0) this.exclusivePosted = true
    this.notifyPending()
    this.kick()
    return promise
  }
  cancelSource(source: object): void {
    this.jobs = this.jobs.filter((job) => {
      if (job.source !== source) return true
      job.onTaken?.()
      job.resolve()
      return false
    })
    this.notifyPending()
  }
  private kick(): void {
    if (
      this.disposed ||
      this.disabled ||
      this.paused ||
      this.queued ||
      this.rounds.size ||
      !this.pump
    )
      return
    if (!this.hasDispatchableWork()) return
    this.queued = true
    void this.execute(() => this.begin())
      .catch((error) => {
        if (!this.disposed) this.error(String(error), false)
      })
      .finally(() => {
        this.queued = false
        this.kick()
      })
  }
  private begin(): HostReply {
    if (this.disposed || this.disabled || this.paused || !this.pump) return empty()
    if (this.rounds.size >= 64) throw new Error('System event nesting limit exceeded')
    const token = ++this.token
    // Native TVP keeps a global cutoff: a nested delivery advances the cutoff
    // subsequently seen by its suspended parent. Do not restore an older one.
    this.cutoff = this.sequence++
    this.exclusivePosted = false
    this.rounds.set(token, {
      checkExclusive: false,
      ownsContinuous: false,
      emptyContinuous: false,
      group: 0,
      continuous: -1,
      tick: 0,
    })
    this.notifyPending()
    return { kind: 'invoke', callback: this.pump, args: [BigInt(token)] }
  }
  setDisabled(disabled: boolean): HostReply {
    this.disabled = disabled
    // The native clock keeps one coalesced pending notification while delivery
    // is disabled. Merely assigning false must not invent a reentrant tick.
    this.armContinuous()
    this.changed()
    this.notifyPending()
    // Setting false drains eligible queued events synchronously in the caller's
    // native stack, including when the previous value was already false.
    return disabled ? empty() : this.begin()
  }
  private take(round: Round): EventJob | undefined {
    if (round.checkExclusive) {
      round.checkExclusive = false
      if (this.exclusivePosted) return
    }
    while (round.group <= 3) {
      const index = this.jobs.findIndex(
        (job) =>
          job.priority === round.group && (job.priority === 1 || job.sequence <= this.cutoff),
      )
      if (index < 0) {
        // Exclusive and normal queues finish their eligible group before the
        // native dispatcher checks a newly posted exclusive event.
        if ((round.group === 0 || round.group === 2) && this.exclusivePosted) return
        round.group++
        continue
      }
      const job = this.jobs.splice(index, 1)[0]!
      job.onTaken?.()
      if (!job.valid()) {
        job.resolve()
        if (round.group === 1 && this.exclusivePosted) return
        continue
      }
      return job
    }
    if (round.continuous < 0) {
      if (!this.continuousPending) return
      this.continuousPending = false
      // Native TVP consumes the notification before its nonreentrant continuous
      // dispatcher rejects a nested call. Preserve that legacy round behavior.
      if (this.continuousProcessing) return
      this.continuousProcessing = true
      round.ownsContinuous = true
      round.continuous = 0
      round.tick = Math.trunc(this.clock.now())
      this.armContinuous()
    }
    while (round.continuous < this.entries.length) {
      const entry = this.entries[round.continuous++]!
      if (!entry.callback) {
        round.emptyContinuous = true
        if (this.exclusivePosted) return
        continue
      }
      return {
        sequence: 0,
        priority: 3,
        valid: () => !!entry.callback,
        prepare: () =>
          entry.callback
            ? { kind: 'invoke', callback: entry.callback, args: [BigInt(round.tick)] }
            : empty(),
        resolve() {},
        reject() {},
        onError: () => this.removeEntry(entry),
        continuous: true,
      }
    }
    // Compact only after walking the live list, so self-removal and appends do
    // not shift the index or suppress a newly registered callback in this pass.
    if (round.emptyContinuous) this.entries = this.entries.filter((entry) => entry.callback)
    if (!this.entries.length) {
      this.cancelWake?.()
      this.cancelWake = undefined
      this.continuousPending = false
    }
    return
  }
  host(operation: string, args: ScriptValue[]): HostReply {
    if (operation === 'System.bindEvents') {
      if (!isScriptObject(args[0])) throw new Error('System event pump must be callable')
      if (this.pump) this.objects.release(this.pump)
      this.pump = this.objects.retain(args[0])
      this.notifyPending()
      this.kick()
      return empty()
    }
    const token = Number(args[0]),
      round = this.rounds.get(token)
    if (!Number.isSafeInteger(token) || !round) throw new Error('System event round has ended')
    if (operation === 'System.eventNext') {
      if (round.current) throw new Error('Previous event has not completed')
      round.current = this.take(round)
      this.notifyPending()
      return { kind: 'value', value: round.current ? 1n : 0n }
    }
    if (operation === 'System.eventCall') {
      const reply = round.current?.valid() ? round.current.prepare() : empty()
      return reply.kind === 'invoke' ? { ...reply, statusOnly: true } : reply
    }
    if (operation === 'System.eventDone') {
      round.checkExclusive = round.current?.priority === 1 || !!round.current?.continuous
      round.current?.resolve()
      round.current = undefined
      this.notifyPending()
      return empty()
    }
    if (operation === 'System.eventFailed') {
      round.current?.onError?.()
      round.current?.resolve()
      if (round.ownsContinuous) {
        round.ownsContinuous = false
        this.continuousProcessing = false
      }
      round.current = undefined
      this.notifyPending()
      return empty()
    }
    if (operation === 'System.eventInvalid') {
      round.checkExclusive = round.current?.priority === 1 || !!round.current?.continuous
      if (round.current?.continuous) round.emptyContinuous = true
      round.current?.onError?.()
      round.current?.resolve()
      round.current = undefined
      this.notifyPending()
      return empty()
    }
    if (operation === 'System.eventEnd') {
      round.current?.reject(new Error('System event round aborted'))
      this.rounds.delete(token)
      if (round.ownsContinuous) this.continuousProcessing = false
      if (!this.jobs.some((job) => job.priority !== 1)) this.sequence = 0
      this.notifyPending()
      if (!this.rounds.size) {
        this.armContinuous()
        this.kick()
      }
      return empty()
    }
    throw new Error(`Unsupported system event operation: ${operation}`)
  }
  report(message: string, handled: boolean): void {
    if (!handled) this.setDisabled(true)
    this.error(message, handled)
  }
  has(callback: ScriptObject | null): boolean {
    if (callback === null) return this.entries.some((entry) => !entry.callback)
    return this.registered.has(this.objects.objectIdentity(callback))
  }
  add(callback: ScriptObject | null, frequency = this.frequency): void {
    if (this.has(callback)) return
    const key = callback === null ? '' : this.objects.objectIdentity(callback)
    if (this.registered.size >= 65536) throw new Error('Continuous handler budget exceeded')
    if (this.entries.length >= 262144)
      throw new Error('Continuous registry storage budget exceeded')
    if (!Number.isSafeInteger(frequency) || frequency < 0 || frequency > 65536000)
      throw new Error('Continuous frequency must be an integer from 0 to 65536000 Hz')
    this.frequency = frequency
    const entry = { key, callback: callback === null ? undefined : this.objects.retain(callback) }
    if (callback !== null) this.registered.set(key, entry)
    this.entries.push(entry)
    this.restartClock()
    this.notifyPending()
  }
  remove(callback: ScriptObject | null): void {
    if (callback === null) return
    const entry = this.registered.get(this.objects.objectIdentity(callback))
    if (entry) this.removeEntry(entry)
  }
  private removeEntry(entry: ContinuousEntry): void {
    if (!entry.callback) return
    this.registered.delete(entry.key)
    this.objects.release(entry.callback)
    entry.callback = undefined
    this.notifyPending()
  }
  private interval(): number {
    return this.frequency ? Math.floor(65536000 / this.frequency) / 65536 : 0
  }
  private restartClock(): void {
    const interval = this.interval(),
      now = this.clock.now()
    // Begin uses the native 16-bit submillisecond grid, including its immediate
    // first wake at the floor grid point instead of waiting a whole period.
    this.nextContinuous = interval
      ? Math.floor((Math.trunc(now) + 1 / 65536) / interval) * interval
      : now
    this.cancelWake?.()
    this.cancelWake = undefined
    this.armContinuous()
  }
  private armContinuous(): void {
    if (
      this.disposed ||
      this.paused ||
      !this.entries.length ||
      this.cancelWake ||
      this.continuousPending
    )
      return
    this.cancelWake = this.clock.schedule(
      () => {
        this.cancelWake = undefined
        if (this.clock.now() < this.nextContinuous) {
          this.armContinuous()
          return
        }
        this.continuousPending = true
        const interval = this.interval(),
          now = this.clock.now()
        this.nextContinuous = interval
          ? now + interval - ((((now - this.nextContinuous) % interval) + interval) % interval)
          : now
        this.notifyPending()
        this.kick()
      },
      Math.max(0, this.nextContinuous - this.clock.now()),
    )
  }
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.pausedAt = this.clock.now()
    this.cancelWake?.()
    this.cancelWake = undefined
    this.notifyPending()
  }
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.nextContinuous += this.clock.now() - this.pausedAt
    this.armContinuous()
    this.notifyPending()
    this.kick()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelWake?.()
    this.cancelWake = undefined
    for (const job of this.jobs) job.reject(new ExecutionCancelled())
    this.jobs = []
    for (const round of this.rounds.values()) round.current?.reject(new ExecutionCancelled())
    this.rounds.clear()
    for (const entry of this.entries) if (entry.callback) this.objects.release(entry.callback)
    this.entries = []
    this.registered.clear()
    if (this.pump) this.objects.release(this.pump)
    this.pump = undefined
    this.continuousPending = false
    this.continuousProcessing = false
    this.notifyPending()
    this.pendingListeners.clear()
  }
}

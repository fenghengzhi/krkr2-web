import type { MidiOutputMessage } from '../ports/audio.ts'
import type { EventClock } from '../scheduler/events.ts'
import { TvpError } from '../system/tvp-error.ts'

export type MidiOutputStep = MidiOutputMessage | { kind: 'delay' }
const malformed = (): never => { throw new TvpError('TVPMalformedMIDIMessage', [], 'Malformed MIDI output') }

/** Fixed MIDIImpl::TVPMIDIOutData. Parse one complete output at a time so a
 * later malformed message cannot roll back an already emitted prefix. */
export function* midiOutputSteps(bytes: Uint8Array): Generator<MidiOutputStep> {
  let previous = 0
  for (let at = 0; at < bytes.length;) {
    const start = at, byte = bytes[at]!, status = byte & 128 ? bytes[at++]! : previous
    if (!status) malformed()
    let step: MidiOutputStep | undefined
    const take = (count: number): number[] => {
      if (bytes.length - at < count) malformed()
      const values = Array.from(bytes.subarray(at, at + count))
      at += count
      return values
    }
    if (status < 0xf0) {
      // Native treats high-bit operands as bytes, not fresh statuses.
      step = { kind: 'short', status, data: take((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2) }
    } else if (status === 0xf1 || status === 0xf3) {
      step = { kind: 'short', status, data: take(1) }
    } else if (status === 0xf2) {
      step = { kind: 'short', status, data: take(2) }
    } else if (status === 0xff) {
      if (take(1)[0] === 0) step = { kind: 'delay' }
    } else if (status === 0xf0) {
      let end = at
      while (end < bytes.length && bytes[end] !== 0xf7) end++
      if (end === bytes.length) malformed()
      // Preserve the original memcpy(data+i-1,count), including its unusual
      // running-F0 case, instead of fabricating a new start byte.
      step = { kind: 'long', data: bytes.slice(at - 1, end + 1) }
      at = end + 1
    } else if (status !== 0xf7) step = { kind: 'short', status, data: [] }
    if (at === start)
      throw new Error('MIDI running status makes no forward progress')
    previous = status
    if (step) yield step
  }
}

/** Owns raw-call order and the native global pending delay. Delay time uses
 * the host clock, independently of AudioContext suspension or user mute. */
export class MidiOutputExecutor {
  private deadline: number | undefined
  private tail: Promise<void> = Promise.resolve()
  private readonly waiters = new Set<(error?: unknown) => void>()
  private failure: unknown
  private closed = false
  private retained = 0
  private pending = 0
  constructor(private readonly clock: EventClock,
    private readonly output: (message: MidiOutputMessage) => Promise<unknown>) {}
  inspect(): { pending: number; bytes: number; waiting: number } {
    return { pending: this.pending, bytes: this.retained, waiting: this.waiters.size }
  }
  send(bytes: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(this.failure)
    if (this.pending >= 64 || bytes.length > 16 * 1024 * 1024 - this.retained)
      return Promise.reject(new Error('MIDI output exceeds its pending octet budget'))
    const owned = bytes.slice()
    this.retained += owned.length
    this.pending++
    const operation = this.tail.then(async () => {
      if (this.closed) throw this.failure
      for (const step of midiOutputSteps(owned)) {
        if (this.closed) throw this.failure
        if (step.kind === 'delay') this.deadline = this.clock.now() + 50
        else {
          await this.waitDelay()
          if (this.closed) throw this.failure
          await this.output(step)
        }
      }
    }).finally(() => { this.retained -= owned.length; this.pending-- })
    this.tail = operation.catch(() => {})
    return operation
  }
  private async waitDelay(): Promise<void> {
    while (this.deadline !== undefined && this.deadline > this.clock.now()) {
      const delay = this.deadline - this.clock.now()
      await new Promise<void>((resolve, reject) => {
        let done = false, ready = false, queued = false, queuedError: unknown, cancel = () => {}
        const finish = (error?: unknown) => {
          if (done) return
          // A custom clock may fire or retire synchronously from schedule.
          // Acquire its cancellation function before settling either outcome.
          if (!ready) { queued = true; queuedError = error; return }
          done = true
          this.waiters.delete(finish)
          try { cancel() }
          catch (cleanup) {
            reject(error === undefined || cleanup === error ? cleanup
              : new AggregateError([error, cleanup], 'MIDI delay cancellation failed', { cause: error }))
            return
          }
          if (error !== undefined) reject(error); else resolve()
        }
        this.waiters.add(finish)
        try {
          cancel = this.clock.schedule(() => finish(), delay)
          ready = true
          if (this.closed) finish(this.failure)
          else if (queued) finish(queuedError)
        } catch (error) { ready = true; finish(error) }
      })
    }
    this.deadline = undefined
  }
  cancel(error: unknown = new Error('MIDI output is closed')): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    this.deadline = undefined
    for (const finish of [...this.waiters]) finish(error)
  }
}

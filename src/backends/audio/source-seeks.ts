import type { AudioCommand, AudioResult, MixerCommand, PcmReadRequest } from '../../engine/ports/audio.ts'
import { streamPageFrames } from '../../engine/media/stream-pcm.ts'

type Seek = Extract<MixerCommand, { op: 'seekSource' }>
/** A source seek waits for its actual target-page delivery, not a device tick
 * or all background reads. The decoder's existing permits remain its own. */
export class SourceSeeks {
  private readonly active = new Map<number, (error: Error) => void>()
  private readonly reads = new Set<{ request: PcmReadRequest; done: Promise<unknown> }>()
  constructor(private readonly timeout: (expire: () => void) => () => void = (expire) => {
    const timer = setTimeout(expire, 20000); return () => clearTimeout(timer)
  }) {}
  track<T>(request: PcmReadRequest, work: Promise<T>): Promise<T> {
    const read = { request, done: work as Promise<unknown> }
    this.reads.add(read)
    return work.finally(() => { this.reads.delete(read) })
  }
  cancel(command?: AudioCommand): void {
    if (!command || command.op === 'shutdown') {
      for (const reject of this.active.values()) reject(new Error('Audio seek was closed or cancelled'))
      this.active.clear()
    } else if ('id' in command && (['open', 'openSource', 'load', 'create', 'close', 'unload', 'play', 'stop', 'releaseWaveBuffer'].includes(command.op) ||
        (command.op === 'set' && command.property === 'position'))) {
      this.active.get(command.id)?.(new Error('Audio seek was superseded'))
      this.active.delete(command.id)
    }
  }
  async run(command: Seek, send: (command: Seek) => Promise<AudioResult>): Promise<AudioResult> {
    let failure: Error | undefined, reject!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, fail) => { reject = fail }),
      cancel = (error: Error) => { failure ??= error; reject(failure) },
      check = () => { if (failure) throw failure },
      target = Math.floor(command.position / streamPageFrames) * streamPageFrames
    void cancelled.catch(() => {})
    this.active.set(command.id, cancel)
    const clearTimeout = this.timeout(() => cancel(new Error('Audio seek target page timed out')))
    let empty = 0
    const events: AudioResult['events'] = []
    try {
      for (;;) {
        check()
        const result = await Promise.race([send(command), cancelled])
        check()
        events.push(...result.events)
        if (result.sourceReady === true) return { ...result, events }
        if (result.sourceReady !== false) throw new Error('Audio source seek reply omitted readiness')
        const all = [...this.reads].filter(({ request }) => request.id === command.id && request.streamId === command.streamId),
          targetReads = all.filter(({ request }) => request.position === target),
          waiting = targetReads.length ? targetReads : all
        if (!waiting.length) {
          // A target reply can settle between the command reply and this
          // continuation. Retry once to observe that already delivered page.
          if (++empty > 1) throw new Error('Audio source seek has no target-page request')
          continue
        }
        empty = 0
        // If all four slots were occupied, one completion permits the target
        // request. Once it exists, unrelated prefetch cannot delay the seek.
        await Promise.race([Promise.race(waiting.map((read) => read.done)), cancelled])
      }
    } finally {
      clearTimeout()
      if (this.active.get(command.id) === cancel) this.active.delete(command.id)
    }
  }
}

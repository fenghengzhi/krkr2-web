type Clock = {
  now(): number
  schedule(callback: () => void, delay: number): () => void
}
type Timeout = {
  remaining: number
  started: number
  generation: number
  cancel?: () => void
  expire(): void
}

/** Preserve transport budgets while the platform cannot deliver replies. */
export class PausableTimeouts {
  private paused = false
  private pending = new Set<Timeout>()
  constructor(
    private readonly clock: Clock = {
      now: () => performance.now(),
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      },
    },
  ) {}

  start(delay: number, expire: () => void): () => void {
    const job: Timeout = { remaining: delay, started: 0, generation: 0, expire }
    this.pending.add(job)
    if (!this.paused) this.arm(job)
    return () => {
      this.pending.delete(job)
      job.generation++
      job.cancel?.()
      job.cancel = undefined
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    for (const job of this.pending) {
      if (paused) {
        if (job.cancel) {
          job.remaining = Math.max(0, job.remaining - (this.clock.now() - job.started))
          job.generation++
          job.cancel()
          job.cancel = undefined
        }
      } else this.arm(job)
    }
  }

  private arm(job: Timeout): void {
    const generation = ++job.generation
    job.started = this.clock.now()
    job.cancel = this.clock.schedule(() => {
      if (this.paused || !this.pending.has(job) || job.generation !== generation) return
      this.pending.delete(job)
      job.cancel = undefined
      job.expire()
    }, job.remaining)
  }
}

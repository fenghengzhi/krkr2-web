export class ExecutionCancelled extends Error {
  override readonly name = 'AbortError'
  constructor() {
    super('Execution cancelled')
  }
}

export class ExecutionControl {
  cancelled = false
  paused = false
  private resumeWaiters = new Set<() => void>()
  private cancelListeners = new Set<() => void>()

  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
    for (const resolve of this.resumeWaiters) resolve()
    this.resumeWaiters.clear()
  }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.resume()
    for (const listener of this.cancelListeners) listener()
    this.cancelListeners.clear()
  }
  onCancel(listener: () => void): () => void {
    if (this.cancelled) listener()
    else this.cancelListeners.add(listener)
    return () => {
      this.cancelListeners.delete(listener)
    }
  }
  check(): void {
    if (this.cancelled) throw new ExecutionCancelled()
  }
  async wait(): Promise<void> {
    while (this.paused && !this.cancelled)
      await new Promise<void>((resolve) => this.resumeWaiters.add(resolve))
  }
}

export class SerialQueue {
  private queues: (() => Promise<void>)[][] = [[], [], []]
  private running = false
  private waiters: (() => void)[] = []
  enqueue<T>(operation: () => Promise<T>, priority: 0 | 1 | 2 = 1): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.queues[priority]!.push(async () => {
        try {
          resolve(await operation())
        } catch (error) {
          reject(error)
        }
      })
    })
    if (!this.running) {
      this.running = true
      void Promise.resolve().then(() => this.pump())
    }
    return result
  }
  private async pump(): Promise<void> {
    while (true) {
      const next = this.queues.find((queue) => queue.length)?.shift()
      if (!next) break
      await next()
    }
    this.running = false
    for (const resolve of this.waiters.splice(0)) resolve()
  }
  async drain(): Promise<void> {
    if (this.running) await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}

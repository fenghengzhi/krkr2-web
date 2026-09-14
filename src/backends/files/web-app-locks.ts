import type { AppLocks } from '../../engine/ports/system.ts'

export class WebAppLocks implements AppLocks {
  private entries = new Map<
    string,
    { acquired: Promise<boolean>; release(): void; done: Promise<void> }
  >()
  private closed = false
  constructor(
    private readonly gameId: string,
    private readonly locks = navigator.locks,
  ) {}

  acquire(key: string): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error('Application locks are closed'))
    if (!this.locks)
      return Promise.reject(new Error('Web Locks requires a supported secure browser context'))
    const previous = this.entries.get(key)
    if (previous) return previous.acquired
    let release!: () => void
    const lifetime = new Promise<void>((resolve) => {
      release = resolve
    })
    let resolve!: (locked: boolean) => void
    let reject!: (reason: unknown) => void
    const acquired = new Promise<boolean>((yes, no) => {
      resolve = yes
      reject = no
    })
    const name = `krkr2-web:app:${JSON.stringify([this.gameId, key])}`
    const done = this.locks
      .request(name, { ifAvailable: true }, async (lock) => {
        resolve(!!lock && !this.closed)
        if (lock && !this.closed) await lifetime
      })
      .catch(reject)
      .then(() => {
        this.entries.delete(key)
      })
    this.entries.set(key, { acquired, release, done })
    return acquired
  }
  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.entries.values()]
    for (const entry of entries) entry.release()
    await Promise.all(entries.map((entry) => entry.done))
  }
}

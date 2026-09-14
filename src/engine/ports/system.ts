export interface AppLocks {
  acquire(key: string): Promise<boolean>
  close(): Promise<void>
}

// The headless backend shares locks across sessions in this process.
const held = new Set<string>()
export class MemoryAppLocks implements AppLocks {
  private keys = new Set<string>()
  private closed = false
  constructor(private readonly scope = 'default') {}
  async acquire(key: string): Promise<boolean> {
    if (this.closed) throw new Error('Application locks are closed')
    const name = JSON.stringify([this.scope, key])
    if (this.keys.has(name)) return true
    if (held.has(name)) return false
    held.add(name)
    this.keys.add(name)
    return true
  }
  async close(): Promise<void> {
    this.closed = true
    for (const key of this.keys) held.delete(key)
    this.keys.clear()
  }
}

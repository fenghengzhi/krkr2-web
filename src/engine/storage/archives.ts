import type { ArchiveReader, Resource } from '../ports/storage.ts'
import { normalizeResourcePath } from './public-path.ts'

export interface OpenArchive {
  readonly name: string
  readonly entries: ReadonlyMap<string, Resource>
  readonly folded: ReadonlyMap<string, readonly string[]>
  readonly units: number
}
interface Cached { source: object; value: OpenArchive }
interface Job {
  key: string
  kind: 'index' | 'probe'
  epoch: number
  resource: Resource
  promise: Promise<OpenArchive | boolean | undefined>
  resolve(value: OpenArchive | boolean | undefined): void
  reject(error: unknown): void
}

/** Success-only, 64-container LRU, matching the fixed native cache limit.
 * Members live only in these records, never in the resolver's permanent mount.
 * A single active parser bounds temporary index expansion; cancellation wakes
 * callers immediately while the actual provider work drains privately. */
export class StorageArchives {
  private readonly cache = new Map<string, Cached>()
  private readonly flights = new Map<string, Job>()
  private readonly queue: Job[] = []
  private readonly waiters = new Set<(error: unknown) => void>()
  private active?: Job
  private disposed = false
  private epoch = 0
  private unrecognized = new WeakSet<object>()
  constructor(private readonly reader: ArchiveReader | undefined,
    private readonly checkpoint: () => Promise<void>,
    private readonly budget: () => { entries: number; units: number }) {}

  private check = async () => {
    if (this.disposed) throw new Error('Archive storage is disposed')
    await this.checkpoint()
    if (this.disposed) throw new Error('Archive storage is disposed')
  }
  private wait<T>(pending: Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Archive storage is disposed'))
    return new Promise((resolve, reject) => {
      const cancel = (error: unknown) => { this.waiters.delete(cancel); reject(error) }
      this.waiters.add(cancel)
      void pending.then((value) => { this.waiters.delete(cancel); resolve(value) },
        (error) => { this.waiters.delete(cancel); reject(error) })
    })
  }
  async open(resource: Resource): Promise<OpenArchive | undefined> {
    if (this.disposed) throw new Error('Archive storage is disposed')
    const key = resource.name, token = resource.cacheToken ?? resource, cached = this.cache.get(key)
    if (this.unrecognized.has(token)) return undefined
    if (cached?.source === token) {
      this.cache.delete(key); this.cache.set(key, cached)
      return cached.value
    }
    if (cached) this.cache.delete(key)
    const existing = this.flights.get(key)
    if (existing && (existing.resource.cacheToken ?? existing.resource) === token)
      return this.wait(existing.promise).then((value) => typeof value === 'boolean' ? undefined : value)
    await this.check()
    const raced = this.flights.get(key), completed = this.cache.get(key)
    if (raced && (raced.resource.cacheToken ?? raced.resource) === token)
      return this.wait(raced.promise).then((value) => typeof value === 'boolean' ? undefined : value)
    if (completed?.source === token) {
      this.cache.delete(key); this.cache.set(key, completed)
      return completed.value
    }
    if (this.unrecognized.has(token)) return undefined
    if (this.queue.length >= 1024) throw new Error('Archive open queue exceeds 1024 requests')
    let resolve!: Job['resolve'], reject!: Job['reject']
    const promise = new Promise<OpenArchive | boolean | undefined>((yes, no) => { resolve = yes; reject = no }),
      job: Job = { key, kind: 'index', epoch: this.epoch, resource, promise, resolve, reject }
    this.flights.set(key, job)
    this.queue.push(job)
    const waiting = this.wait(promise)
    this.drain()
    return waiting.then((value) => typeof value === 'boolean' ? undefined : value)
  }
  private drain(): void {
    if (this.active || this.disposed) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    void this.run(job)
  }
  private async run(job: Job): Promise<void> {
    const key = job.key
    try {
      if (!this.reader) throw new Error('Archive indexing is unavailable')
      if (job.kind === 'probe') {
        const candidate = await this.reader.probeArchive?.(job.resource, this.check) ?? false
        await this.check()
        if (job.epoch !== this.epoch) throw new Error('Archive request was retired')
        if (this.flights.get(key) === job) this.flights.delete(key)
        job.resolve(candidate)
        return
      }
      const decoded = await this.reader.open(job.resource, this.check)
      await this.check()
      if (job.epoch !== this.epoch) throw new Error('Archive request was retired')
      let value: OpenArchive | undefined
      if (decoded) {
        const entries = new Map<string, Resource>(), folded = new Map<string, string[]>()
        let units = key.length
        for (const entry of decoded.entries) {
          const member = normalizeResourcePath(entry.name)
          if (member.includes('>') || entry.aliasOf !== undefined) throw new Error('Invalid archive member name')
          const name = key + '>' + member
          if (entries.has(member)) throw new Error(`Duplicate archive member: ${name}`)
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid archive member size')
          entries.set(member, { ...entry, name, cacheToken: {} })
          const lower = member.toLowerCase(), names = folded.get(lower) ?? []
          names.push(member); folded.set(lower, names)
          units += name.length + member.length
          if (entries.size > 250000 || units > 16 * 1024 * 1024)
            throw new Error('Archive index exceeds namespace metadata budget')
          if (!(entries.size % 256)) await this.check()
        }
        value = { name: key, entries, folded, units }
        const budget = this.budget()
        if (entries.size > budget.entries || units > budget.units)
          throw new Error('Archive index exceeds available namespace metadata budget')
        if (this.flights.get(key) === job) {
          this.cache.set(key, { source: job.resource.cacheToken ?? job.resource, value })
          this.trim()
        }
      } else {
        this.unrecognized.add(job.resource.cacheToken ?? job.resource)
      }
      if (this.flights.get(key) === job) this.flights.delete(key)
      job.resolve(value)
    } catch (error) {
      // Retire before rejecting: a reentrant retry must never join a failed
      // promise, and failure never publishes a partial directory.
      if (this.flights.get(key) === job) this.flights.delete(key)
      job.reject(error)
    } finally {
      if (this.active === job) this.active = undefined
      this.drain()
    }
  }
  trim(): void {
    const budget = this.budget()
    let entries = 0, units = 0
    for (const cached of this.cache.values()) { entries += cached.value.entries.size; units += cached.value.units }
    while (this.cache.size > 64 || entries > budget.entries || units > budget.units) {
      const key = this.cache.keys().next().value
      if (key === undefined) break
      const removed = this.cache.get(key)!
      entries -= removed.value.entries.size; units -= removed.value.units
      this.cache.delete(key)
    }
  }
  known(): readonly OpenArchive[] { return [...this.cache.values()].map((entry) => entry.value) }
  async candidate(resource: Resource): Promise<boolean> {
    if (this.disposed) throw new Error('Archive storage is disposed')
    if (resource.archiveKind || /\.(xp3|zip|exe)$/i.test(resource.name)) return true
    if (!this.reader?.probeArchive) return false
    const key = 'probe\0' + resource.name, existing = this.flights.get(key),
      token = resource.cacheToken ?? resource
    if (existing && (existing.resource.cacheToken ?? existing.resource) === token)
      return this.wait(existing.promise).then((value) => value === true)
    await this.check()
    const raced = this.flights.get(key)
    if (raced && (raced.resource.cacheToken ?? raced.resource) === token)
      return this.wait(raced.promise).then((value) => value === true)
    if (this.queue.length >= 1024) throw new Error('Archive open queue exceeds 1024 requests')
    let resolve!: Job['resolve'], reject!: Job['reject']
    const promise = new Promise<OpenArchive | boolean | undefined>((yes, no) => { resolve = yes; reject = no }),
      job: Job = { key, kind: 'probe', epoch: this.epoch, resource, promise, resolve, reject }
    this.flights.set(key, job); this.queue.push(job)
    const waiting = this.wait(promise)
    this.drain()
    return waiting.then((value) => value === true)
  }
  inspect() { return { archives: this.cache.size, pending: this.flights.size, active: !!this.active } }
  clear(): void {
    this.epoch++
    const error = new Error('Archive request was retired')
    for (const cancel of this.waiters) cancel(error)
    for (const job of this.queue.splice(0)) job.reject(error)
    this.flights.clear(); this.cache.clear()
    this.unrecognized = new WeakSet()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new Error('Archive storage is disposed')
    for (const cancel of this.waiters) cancel(error)
    for (const job of this.queue.splice(0)) job.reject(error)
    this.flights.clear(); this.cache.clear()
    this.unrecognized = new WeakSet()
  }
}

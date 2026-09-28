import type { PhaseVocoderFilter } from '../ports/audio.ts'
import {
  isScriptObject,
  type ScriptObject,
  type ScriptRuntime,
  type ScriptValue,
  type ScriptWeakObject,
} from '../script/runtime.ts'

interface FilterRecord {
  settings: PhaseVocoderFilter
  owner: ScriptWeakObject
  live: boolean
  connection?: PhaseVocoderConnection
}

/** The script Array is configuration for the next open. This independent set of
 * owning leases keeps the connected native instances alive until stream unload. */
export interface PhaseVocoderConnection {
  readonly sound: number
  readonly released: boolean
  settings(): PhaseVocoderFilter[]
  release(): void
}

export class PhaseVocoderService {
  private records = new Map<number, FilterRecord>()
  private nextId = 1
  private disposed = false
  constructor(
    private readonly runtime: ScriptRuntime,
    private readonly update: (sound: number, filters: PhaseVocoderFilter[]) => Promise<void>,
  ) {}
  get count(): number {
    return this.records.size
  }
  private retire(id: number): void {
    const record = this.records.get(id)
    if (!record) return
    record.live = false
    this.runtime.unobserve(record.owner)
    if (!record.connection) this.records.delete(id)
  }
  async host(operation: string, args: ScriptValue[]): Promise<ScriptValue> {
    if (this.disposed) throw new Error('PhaseVocoder service is disposed')
    if (operation === 'PhaseVocoder.class')
      return {
        type: 'class',
        namespace: 'PhaseVocoder',
        id: 0,
        className: 'PhaseVocoder',
        properties: [],
      }
    if (operation === 'PhaseVocoder.bindClass') {
      if (!isScriptObject(args[0]) || !this.runtime.bindPhaseVocoderClass)
        throw new Error('Missing native PhaseVocoder class binding')
      this.runtime.bindPhaseVocoderClass(args[0])
      return
    }
    if (operation === 'PhaseVocoder.construct') {
      const owner = args[0]
      if (!isScriptObject(owner) || this.runtime.nativePhaseVocoderIdentifier?.(owner) !== 0)
        throw new Error('PhaseVocoder requires its native constructor receiver')
      if (this.records.size >= 256 || this.nextId > 0x7fffffff)
        throw new Error('PhaseVocoder instance budget exceeded')
      const id = this.nextId++
      const weak = this.runtime.observe(owner, () => this.retire(id))
      try {
        this.records.set(id, {
          owner: weak,
          live: true,
          settings: { type: 'phase-vocoder', id, window: 4096, overlap: 0, pitch: 1, time: 1 },
        })
      } catch (error) {
        this.runtime.unobserve(weak)
        throw error
      }
      return BigInt(id)
    }
    const id = Number(args[0]),
      record = this.records.get(id)
    if (!record?.live) throw new Error('PhaseVocoder has been invalidated')
    const property = String(args[1])
    if (!['window', 'overlap', 'pitch', 'time'].includes(property))
      throw new Error('Unknown PhaseVocoder property')
    const key = property as 'window' | 'overlap' | 'pitch' | 'time'
    if (operation === 'PhaseVocoder.get') {
      const value = record.settings[key]
      return key === 'window' || key === 'overlap' ? BigInt(value) : value
    }
    if (operation !== 'PhaseVocoder.set' || !['number', 'bigint'].includes(typeof args[2]))
      throw new Error('Invalid PhaseVocoder operation')
    const value = Number(args[2])
    if (
      key === 'window' &&
      ![64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].includes(value)
    )
      throw new Error('PhaseVocoder window must be a power of two from 64 to 32768')
    if (key === 'overlap' && ![0, 2, 4, 8, 16, 32].includes(value))
      throw new Error('PhaseVocoder overlap must be 0, 2, 4, 8, 16 or 32')
    const next = { ...record.settings, [key]: value }
    const connection = record.connection
    if (connection) {
      const settings = connection.settings().map((setting) => (setting.id === id ? next : setting))
      // The backend validates the whole change before publishing it. Failed
      // allocations/unsupported execution domains leave script getters intact.
      await this.update(connection.sound, settings)
      if (connection.released || record.connection !== connection)
        throw new Error('PhaseVocoder sound connection was released')
    }
    record.settings = next
    return
  }
  connect(sound: number, array: ScriptObject): PhaseVocoderConnection {
    if (this.disposed || !this.runtime.snapshotPhaseVocoderFilters)
      throw new Error('Missing native PhaseVocoder filter snapshot support')
    const leases = this.runtime.snapshotPhaseVocoderFilters(array)
    const records: FilterRecord[] = []
    let released = false
    const connection: PhaseVocoderConnection = {
      sound,
      get released() {
        return released
      },
      settings: () => records.map((record) => ({ ...record.settings })),
      release: () => {
        if (released) return
        released = true
        // Revoke every Source first. Releasing the owning handles can later run
        // user finalizers; none may observe a half-detached filter chain.
        for (const record of records) {
          if (record.connection === connection) record.connection = undefined
          if (!record.live) this.records.delete(record.settings.id)
        }
        const errors: unknown[] = []
        for (const lease of leases) {
          try {
            this.runtime.release(lease)
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'PhaseVocoder chain release failed')
      },
    }
    try {
      for (const lease of leases) {
        const id = this.runtime.nativePhaseVocoderIdentifier?.(lease)
        const record = id === undefined ? undefined : this.records.get(id)
        if (!record?.live)
          throw new Error('WaveSoundBuffer filter is not a live native PhaseVocoder')
        if (record.connection)
          throw new Error('Cannot connect multiple WaveSoundBuffers to one PhaseVocoder')
        records.push(record)
        record.connection = connection
      }
      return connection
    } catch (error) {
      connection.release()
      throw error
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = [],
      connections = new Set<PhaseVocoderConnection>()
    for (const record of [...this.records.values()]) {
      record.live = false
      if (record.connection) connections.add(record.connection)
      try {
        this.runtime.unobserve(record.owner)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const connection of connections) {
      try {
        connection.release()
      } catch (error) {
        errors.push(error)
      }
    }
    this.records.clear()
    if (errors.length) throw new AggregateError(errors, 'PhaseVocoder service cleanup failed')
  }
}

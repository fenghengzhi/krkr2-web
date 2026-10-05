import type { ByteSource, Resource } from '../ports/storage.ts'
import { MAX_RESOURCE_BYTES } from '../ports/storage.ts'
import { openResourceSource } from './resource-source.ts'

export interface AudioSourceLease {
  source: ByteSource
  bufferedBytes: number
  release(): void
}

/** Reserve encoded fallback bytes before reading, across pending and playing
 * voices. Range sources keep their shared storage provider's separate budget. */
export class AudioResourceSources {
  private bytes = 0
  private disposed = false
  private readonly leases = new Set<() => void>()
  private readonly waiters = new Set<() => void>()
  constructor(private readonly checkpoint: () => void | Promise<void>) {}
  private wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error('Audio resource owner has expired'))
      if (this.disposed) cancel()
      else this.waiters.add(cancel)
      // The real operation owns accounting until it settles, even after its
      // caller has stopped waiting. Always attach both completion handlers.
      work.then((value) => {
        this.waiters.delete(cancel)
        if (this.disposed) cancel()
        else resolve(value)
      }, (error) => { this.waiters.delete(cancel); reject(error) })
    })
  }
  async open(resource: Resource, valid: () => boolean): Promise<AudioSourceLease> {
    const check = async () => {
      if (this.disposed || !valid()) throw new Error('Audio resource owner has expired')
      await this.checkpoint()
      if (this.disposed || !valid()) throw new Error('Audio resource owner has expired')
    }
    await this.wait(check())
    const charge = resource.source ? 0 : resource.size
    if (!Number.isSafeInteger(charge) || charge < 0 || charge > MAX_RESOURCE_BYTES - this.bytes)
      throw new Error('Buffered audio sources exceed the 64 MiB Session budget')
    this.bytes += charge
    let released = false, retired = false, pending = 1, borrowed: ByteSource | undefined
    const finish = () => {
      // A cancelled decoder may stop awaiting a provider that is still reading.
      // Keep its fallback reservation until the original open/read has settled.
      if (!released || pending || retired) return
      retired = true
      this.bytes -= charge
      this.leases.delete(release)
    }
    const release = () => {
      if (released) return
      released = true
      borrowed = undefined
      finish()
    }
    this.leases.add(release)
    const opening = (async (): Promise<AudioSourceLease> => {
      try {
        const opened = await openResourceSource(resource, { checkpoint: check })
        await check()
        if (released || opened.bufferedBytes !== charge) throw new Error('Audio source reservation changed during open')
        borrowed = opened.source
        const size = borrowed.size
        return {
          source: { size, read: async (offset, length) => {
            if (released || !borrowed) throw new Error('Audio source is closed')
            pending++
            const reading = (async () => {
              try {
                await check()
                if (released || !borrowed) throw new Error('Audio source is closed')
                const bytes = await borrowed.read(offset, length)
                await check()
                if (released) throw new Error('Audio source closed during reading')
                return bytes
              } finally { pending--; finish() }
            })()
            // Decoder scopes may cancel their wait, while this promise still
            // represents the actual provider work for fallback accounting.
            return reading
          } },
          bufferedBytes: charge,
          release,
        }
      } catch (error) { release(); throw error }
      finally { pending--; finish() }
    })()
    return this.wait(opening)
  }
  inspect(): { bufferedBytes: number; leases: number } {
    return { bufferedBytes: this.bytes, leases: this.leases.size }
  }
  dispose(): void {
    this.disposed = true
    for (const release of this.leases) release()
    for (const cancel of this.waiters) cancel()
    this.waiters.clear()
  }
}

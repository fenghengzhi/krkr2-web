export const MAX_RESOURCE_BYTES = 64 * 1024 * 1024

/** DOM-independent immutable Blob view. This does not grant whole-buffer reads
 * to ordinary storage consumers; those retain their existing read budgets. */
export interface ImmutableBlob {
  readonly size: number
  slice(start?: number, end?: number, contentType?: string): ImmutableBlob
  arrayBuffer(): Promise<ArrayBuffer>
}
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  /** Borrow existing immutable backing, after the resource's required integrity
   * checks. Implementations must not materialize new byte buffers as a borrowed
   * source. The view is independent of the lifetime of a particular reader. */
  borrowBlob?(offset: number, length: number, checkpoint?: () => void | Promise<void>): Promise<ImmutableBlob>
}
export interface Resource {
  readonly name: string
  readonly size: number
  /** Import-only compatibility alias for an archive member. This is not a
   * loose file: normal paths and registered auto paths take precedence, and
   * successful lookup returns the canonical archive resource/identity. */
  readonly aliasOf?: string
  /** False hides this container's bare member aliases. True also admits a
   * byte-only container without a standard suffix when looking for optional
   * image companions and audio loop information. Explicit container addresses remain available. */
  readonly archiveAliases?: boolean
  /** Successfully indexed container; present even when the archive is empty. */
  readonly archiveKind?: 'xp3' | 'zip'
  /** Logical start of each physical PKZIP disk, in disk-number order. */
  readonly zipDiskOffsets?: readonly number[]
  /** Identity of these immutable bytes, without retaining the resource's input buffer. */
  readonly cacheToken?: object
  /** Optional immutable byte source. Opening this capability does not imply
   * payload verification; an archive source may verify before its first read.
   * Its underlying storage lifetime belongs to the Session, not one reader. */
  readonly source?: ByteSource
  read(): Promise<Uint8Array>
}
export interface ArchiveIndex {
  readonly kind: 'xp3' | 'zip'
  readonly entries: readonly Resource[]
}
/** Opening is explicit and asynchronous. A raw file can exist without being
 * a valid archive; undefined means unrecognized format, never corrupt index. */
export interface ArchiveReader {
  joinVolumes?(files: readonly Resource[], checkpoint: () => Promise<void>): Promise<Resource[]>
  /** Host text codec for imported metadata (for example CUE sheets), including
   * UTF-16 BOM and UTF-8/Shift-JIS fallback. The engine has no DOM decoder. */
  decodeText?(bytes: Uint8Array): string | Promise<string>
  /** Release shared decoded segment caches. Open resource handles stay usable. */
  compact?(): void
  open(resource: Resource, checkpoint: () => Promise<void>): Promise<ArchiveIndex | undefined>
  /** Inspect a prospective ZIP installer without indexing a native combined EXE. */
  openDistribution?(resource: Resource, checkpoint: () => Promise<void>): Promise<ArchiveIndex | undefined>
  probeXp3(resource: Resource, checkpoint: () => Promise<void>): Promise<boolean>
  probeArchive?(resource: Resource, checkpoint: () => Promise<void>): Promise<boolean>
}
export type Inflater = (bytes: Uint8Array, expectedLength: number) => Promise<Uint8Array>

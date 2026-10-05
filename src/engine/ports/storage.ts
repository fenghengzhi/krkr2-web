export const MAX_RESOURCE_BYTES = 64 * 1024 * 1024

export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}
export interface Resource {
  readonly name: string
  readonly size: number
  /** Import-only compatibility alias for an archive member. This is not a
   * loose file: normal paths and registered auto paths take precedence, and
   * successful lookup returns the canonical archive resource/identity. */
  readonly aliasOf?: string
  /** Successfully indexed container; present even when the archive is empty. */
  readonly archiveKind?: 'xp3' | 'zip'
  /** Identity of these immutable bytes, without retaining the resource's input buffer. */
  readonly cacheToken?: object
  /** Optional immutable byte source. Opening this capability does not imply
   * payload verification; an archive source may verify before its first read.
   * Its underlying storage lifetime belongs to the Session, not one reader. */
  readonly source?: ByteSource
  read(): Promise<Uint8Array>
}
export type Inflater = (bytes: Uint8Array, expectedLength: number) => Promise<Uint8Array>

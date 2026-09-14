export const MAX_RESOURCE_BYTES = 64 * 1024 * 1024

export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}
export interface Resource {
  readonly name: string
  readonly size: number
  /** Identity of these immutable bytes, without retaining the resource's input buffer. */
  readonly cacheToken?: object
  read(): Promise<Uint8Array>
}
export type Inflater = (bytes: Uint8Array, expectedLength: number) => Promise<Uint8Array>
